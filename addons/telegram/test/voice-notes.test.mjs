/* ------------------------------------------------------------------ *
 * addons/telegram — voice notes (`message.voice`) and attached audio files
 * (`message.audio`) end to end.
 *
 * Telegram's getFile/download endpoints, the box's /api/voice/transcribe route
 * and core's agent routes are ONE stubbed `fetch`: nothing leaves the process,
 * no credential is real, and no audio touches disk. What this pins:
 *   · the flow: getFile → byte download → raw POST to the transcription route →
 *     the marked transcript reaches the standing session;
 *   · a voice note (`voice`) and an attached audio file (`audio`) go the same way;
 *     photo/document/sticker stay UNSUPPORTED;
 *   · every failure is a short, specific reply to the sender and never a forward:
 *     STT off (503/404), empty transcript, too large (by file_size, BEFORE any
 *     download, or Telegram's own "file is too big"), a getFile error, a failed
 *     download, a timeout;
 *   · the allowlist still applies; the counters; status().
 * Run: node --test addons/telegram/test/voice-notes.test.mjs
 * ------------------------------------------------------------------ */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { default as registerAddon } from '../api/register.mjs'
import { createInbound, VOICE_MARK } from '../api/inbound.mjs'
import { createSttProbe, fetchAudio, transcribe } from '../api/audio.mjs'

const express = createRequire(new URL('../../../api/src/', import.meta.url))('express')
const ctx = { name: 'telegram', express, Router: (o) => express.Router(o) }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-voice-test-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const BEARER = 'dash-bearer'
const TOKEN = 'bot-token'
const CHAT = '111'
const ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_HOME_CHAT_ID: CHAT, DASHBOARD_BEARER_TOKEN: BEARER, API_PORT: '3001' }
const OGG = Buffer.from('OggS-not-really-audio')

const voiceMsg = (fields = {}) => ({ message_id: 1, chat: { id: Number(CHAT) }, voice: { file_id: 'M1', mime_type: 'audio/ogg', file_size: OGG.length, duration: 3 }, ...fields })
const audioMsg = (fields = {}) => ({ message_id: 1, chat: { id: Number(CHAT) }, audio: { file_id: 'M1', mime_type: 'audio/mpeg', file_size: OGG.length, duration: 3 }, ...fields })

/** One stub for Telegram (getFile + download), the transcription route and core's agent routes. */
function makeWorld({ lookup = { status: 200 }, download = { status: 200 }, stt = { status: 200, body: { ok: true, text: 'Was steht heute an?' } } } = {}) {
  const w = { calls: [], sent: [], core: [], stt: [], spawned: 0 }
  const reply = (status, j, { bytes } = {}) => ({
    ok: status < 400,
    status,
    headers: { get: () => null },
    json: async () => j,
    text: async () => JSON.stringify(j),
    arrayBuffer: async () => (bytes ?? OGG).buffer.slice((bytes ?? OGG).byteOffset, (bytes ?? OGG).byteOffset + (bytes ?? OGG).length),
  })
  w.fetch = async (url, opts = {}) => {
    w.calls.push(url)
    if (url === `https://api.telegram.org/bot${TOKEN}/getFile?file_id=M1`) {
      if (lookup.status !== 200) return reply(lookup.status, { ok: false, description: lookup.error || 'Bad Request' })
      return reply(200, { ok: true, result: { file_id: 'M1', file_path: 'voice/file_1.oga', file_size: lookup.fileSize ?? OGG.length } })
    }
    if (url === `https://api.telegram.org/file/bot${TOKEN}/voice/file_1.oga`) {
      if (download.throws) throw new Error(download.throws)
      if (download.status !== 200) return reply(download.status, {})
      return reply(200, {}, { bytes: OGG })
    }
    if (url === 'http://127.0.0.1:3001/api/voice/transcribe') {
      w.stt.push({ auth: opts.headers?.Authorization, type: opts.headers?.['content-type'], body: opts.body })
      if (stt.throws) throw new Error(stt.throws)
      return reply(stt.status, stt.body)
    }
    if (url.endsWith('/sendMessage')) {
      w.sent.push(JSON.parse(opts.body))
      return reply(200, { ok: true, result: { message_id: 2 } })
    }
    if (url.endsWith('/sendChatAction')) return reply(200, { ok: true, result: true })
    const route = url.replace('http://127.0.0.1:3001', '')
    w.core.push({ route, body: opts.body ? JSON.parse(opts.body) : undefined })
    if (route === '/api/agents') return reply(200, { sessions: [] })
    if (route === '/api/agents/spawn') return reply(200, { ok: true, id: `kb-atlas-${++w.spawned}` })
    return reply(404, {})
  }
  return w
}

function setup(opts = {}) {
  const world = makeWorld(opts)
  const log = []
  const file = path.join(TMP, `state-${crypto.randomUUID()}.json`)
  const inbound = createInbound({ env: { ...ENV, ...(opts.env || {}) }, fetch: world.fetch, log: (m) => log.push(m), file })
  return { world, log, inbound }
}
const forwarded = (w) => w.core.filter((c) => c.route === '/api/agents/spawn')
const replies = (w) => w.sent.map((s) => s.text)

/* --- the happy path ------------------------------------------------------ */

for (const [label, m] of [['voice note', voiceMsg()], ['attached audio file', audioMsg()]]) {
  test(`${label}: getFile → download → raw POST to the transcription route → marked text to the agent`, async () => {
    const { world: w, inbound } = setup()
    await inbound.handleOne({ update_id: 1, message: m })
    assert.equal(w.stt.length, 1)
    assert.equal(w.stt[0].auth, `Bearer ${BEARER}`)
    assert.deepEqual(Buffer.from(w.stt[0].body), OGG, 'the RAW bytes, not JSON or base64')
    assert.equal(forwarded(w).length, 1)
    assert.match(forwarded(w)[0].body.task, new RegExp(`\\[Telegram from 111\\] ${VOICE_MARK.replace(/[[\]]/g, '\\$&')} Was steht heute an\\?`))
    assert.equal(w.sent.length, 0, 'the agent answers, not the bridge')
    assert.deepEqual([inbound.counters.audioReceived, inbound.counters.transcribed, inbound.counters.transcribeErrors, inbound.counters.forwarded], [1, 1, 0, 1])
    assert.equal(inbound.counters.unsupported, 0)
  })
}

test("the STT call carries the message's own declared mime type (voice: audio/ogg, audio: audio/mpeg) — Telegram's getFile answers carry none", async () => {
  let s = setup()
  await s.inbound.handleOne({ update_id: 1, message: voiceMsg() })
  assert.equal(s.world.stt[0].type, 'audio/ogg')
  s = setup()
  await s.inbound.handleOne({ update_id: 1, message: audioMsg() })
  assert.equal(s.world.stt[0].type, 'audio/mpeg')
})

test('the session brief tells a new session what a transcribed voice note looks like', async () => {
  const { sessionBrief } = await import('../api/agent.mjs')
  assert.ok(sessionBrief().includes(VOICE_MARK))
})

/* --- failure modes: specific reply, no forward ------------------------------ */

test('transcription 503 (voice addon / STT off) → the specific hint, transcribeErrors, NO forward', async () => {
  const { world: w, inbound, log } = setup({ stt: { status: 503, body: { ok: false, error: 'no ATLAS_VOICE_STT_CMD — dictation uses the browser…' } } })
  await inbound.handleOne({ update_id: 1, message: voiceMsg() })
  assert.equal(w.sent.length, 1)
  assert.match(replies(w)[0], /Spracherkennung ist auf der Box gerade nicht aktiv/)
  assert.equal(replies(w)[0].includes('ATLAS_VOICE_STT_CMD'), false, "the route's error text is not passed through")
  assert.equal(forwarded(w).length, 0)
  assert.equal(inbound.counters.transcribeErrors, 1)
  assert.equal(inbound.counters.forwarded, 0)
  assert.ok(log.some((l) => /503/.test(l) && /ATLAS_VOICE_STT_CMD/.test(l)))
})

test('an empty transcript (voice answers 503 "produced no transcript", or 200 with no text) → its own hint, no forward', async () => {
  for (const stt of [
    { status: 503, body: { ok: false, error: 'the STT command produced no transcript' } },
    { status: 200, body: { ok: true, text: '  ' } },
  ]) {
    const { world: w, inbound } = setup({ stt })
    await inbound.handleOne({ update_id: 1, message: voiceMsg() })
    assert.match(replies(w)[0], /nichts zu hören/)
    assert.equal(forwarded(w).length, 0)
    assert.equal(inbound.counters.transcribeEmpty, 1)
    assert.equal(inbound.counters.transcribeErrors, 0)
  }
})

test('file_size over the limit → no download, no transcription, a hint', async () => {
  const { world: w, inbound } = setup({ lookup: { status: 200, fileSize: 20 * 1024 * 1024 + 1 } })
  await inbound.handleOne({ update_id: 1, message: voiceMsg() })
  assert.equal(w.calls.some((u) => u.includes('/file/bot')), false, 'nothing was downloaded')
  assert.equal(w.stt.length, 0)
  assert.match(replies(w)[0], /zu lang/)
  assert.equal(inbound.counters.audioTooLarge, 1)
  assert.equal(forwarded(w).length, 0)
})

test("Telegram's own \"file is too big\" is treated as the size limit, not a generic media error", async () => {
  const { world: w, inbound } = setup({ lookup: { status: 400, error: 'Bad Request: file is too big' } })
  await inbound.handleOne({ update_id: 1, message: voiceMsg() })
  assert.match(replies(w)[0], /zu lang/)
  assert.equal(inbound.counters.audioTooLarge, 1)
  assert.equal(inbound.counters.mediaErrors, 0)
})

test("the limit is configurable, and Telegram's file_size is only a claim — the bytes are checked too", async () => {
  const s = setup({ env: { TELEGRAM_MAX_AUDIO_BYTES: '10' }, lookup: { status: 200, fileSize: 5 } })
  await s.inbound.handleOne({ update_id: 1, message: voiceMsg() })
  assert.equal(s.world.calls.some((u) => u.includes('/file/bot')), true, 'file_size said 5: the download starts')
  assert.equal(s.world.stt.length, 0, '…but the real 22 bytes are over 10')
  assert.equal(s.inbound.counters.audioTooLarge, 1)
})

test('getFile error → hint, mediaErrors, no forward', async () => {
  const { world: w, inbound } = setup({ lookup: { status: 400, error: 'Bad Request' } })
  await inbound.handleOne({ update_id: 1, message: voiceMsg() })
  assert.match(replies(w)[0], /nicht laden/)
  assert.equal(inbound.counters.mediaErrors, 1)
  assert.equal(w.stt.length, 0)
  assert.equal(forwarded(w).length, 0)
})

test('a failed byte download (404, or a network error) → hint, mediaErrors, no transcription', async () => {
  for (const download of [{ status: 404 }, { throws: 'socket hang up' }]) {
    const { world: w, inbound } = setup({ download })
    await inbound.handleOne({ update_id: 1, message: voiceMsg() })
    assert.match(replies(w)[0], /nicht laden/)
    assert.equal(inbound.counters.mediaErrors, 1)
    assert.equal(w.stt.length, 0)
  }
})

test('an unexpected transcription failure (500, a timeout, a dead route) → the generic hint, transcribeErrors', async () => {
  for (const stt of [{ status: 500, body: { error: 'x' } }, { throws: 'The operation was aborted due to timeout' }, { throws: 'fetch failed' }]) {
    const { world: w, inbound } = setup({ stt })
    await inbound.handleOne({ update_id: 1, message: voiceMsg() })
    assert.match(replies(w)[0], /nicht auswerten/)
    assert.equal(inbound.counters.transcribeErrors, 1)
    assert.equal(forwarded(w).length, 0)
  }
})

test('413 from the voice route (its own, smaller cap) → the "too long" hint', async () => {
  const { world: w, inbound } = setup({ stt: { status: 413, body: {} } })
  await inbound.handleOne({ update_id: 1, message: voiceMsg() })
  assert.match(replies(w)[0], /zu lang/)
  assert.equal(inbound.counters.transcribeErrors, 1)
})

test('a voice message with no file id → hint, no lookup', async () => {
  const { world: w, inbound } = setup()
  await inbound.handleOne({ update_id: 1, message: { message_id: 1, chat: { id: Number(CHAT) }, voice: {} } })
  assert.equal(w.calls.some((u) => u.includes('/getFile') || u.includes('/file/bot')), false, 'no lookup at all')
  assert.equal(w.calls.length, 2, 'the "typing" hint plus the reply — never a media call')
  assert.equal(inbound.counters.mediaErrors, 1)
})

/* --- what did NOT change ------------------------------------------------------ */

test('sticker / location are still UNSUPPORTED — no media call at all', async () => {
  const { world: w, inbound } = setup()
  await inbound.handleOne({ update_id: 1, message: { message_id: 1, chat: { id: Number(CHAT) }, sticker: { file_id: 'M1' } } })
  await inbound.handleOne({ update_id: 2, message: { message_id: 2, chat: { id: Number(CHAT) }, location: { latitude: 1, longitude: 2 } } })
  assert.equal(w.sent.length, 2)
  for (const r of replies(w)) assert.match(r, /noch nicht lesen/)
  assert.equal(w.calls.some((u) => u.includes('/getFile') || u.includes('/file/bot')), false)
  assert.equal(inbound.counters.unsupported, 2)
  assert.equal(inbound.counters.audioReceived, 0)
})

test('allowlist: a voice note from a stranger is dropped before any media call, and gets no reply', async () => {
  const { world: w, inbound } = setup()
  await inbound.handleOne({ update_id: 1, message: { ...voiceMsg(), chat: { id: 999 } } })
  assert.equal(w.calls.length, 0)
  assert.equal(inbound.counters.dropped, 1)
  assert.equal(inbound.counters.audioReceived, 0)
})

test('messages stay serialised: a voice note and the text behind it reach the agent in order', async () => {
  const { world: w, inbound } = setup()
  await inbound.handleOne({ update_id: 1, message: voiceMsg() })
  await inbound.handleOne({ update_id: 2, message: { message_id: 2, chat: { id: Number(CHAT) }, text: 'und noch was' } })
  const tasks = forwarded(w).map((c) => c.body.task)
  assert.equal(tasks.length, 2)
  assert.match(tasks[0], /Sprachnachricht, transkribiert/)
  assert.match(tasks[1], /und noch was/)
  assert.equal(inbound.counters.forwarded, 2)
})

/* --- the pieces, directly ----------------------------------------------------- */

test('fetchAudio / transcribe are total: a throwing fetch is a result, not an exception', async () => {
  const boom = async () => { throw new Error('nope') }
  const opts = { env: ENV, fetch: boom, log: () => {} }
  assert.deepEqual(await fetchAudio('M1', opts), { ok: false, kind: 'lookup', error: 'nope' })
  assert.equal((await transcribe(OGG, 'audio/ogg', opts)).kind, 'error')
  assert.equal((await transcribe(OGG, 'audio/ogg', { ...opts, env: { ...ENV, DASHBOARD_BEARER_TOKEN: '' } })).kind, 'error')
})

test('the timeouts are configurable and the transcription default outlasts the voice route\'s own 60 s', async () => {
  const seen = []
  const f = async (_u, o) => { seen.push(o.signal); return { ok: true, status: 200, json: async () => ({ ok: true, text: 'x' }) } }
  await transcribe(OGG, 'audio/ogg', { env: ENV, fetch: f })
  await transcribe(OGG, 'audio/ogg', { env: { ...ENV, TELEGRAM_TRANSCRIBE_TIMEOUT_MS: '5' }, fetch: f })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(seen[0].aborted, false)
  assert.equal(seen[1].aborted, true)
})

test('the STT probe: caches, answers from the voice addon\'s status, and never asks twice while in flight', async () => {
  let asked = 0
  const addons = (voice) => async () => { asked++; return { json: async () => ({ addons: voice }) } }
  const wait = () => new Promise((r) => setTimeout(r, 10))
  const probe = (voice, ttlMs = 30000) => createSttProbe({ env: ENV, fetch: addons(voice), ttlMs })

  let p = probe([{ name: 'voice', status: { stt: { configured: true, available: true } } }])
  assert.equal(p.get().available, null, 'first answer is honest about not knowing yet')
  await wait()
  assert.equal(p.get().available, true)
  p.get(); p.get()
  assert.equal(asked, 1, 'cached within the ttl')

  p = probe([{ name: 'voice', status: { stt: { available: false, reason: 'no ATLAS_VOICE_STT_CMD' } } }])
  p.get(); await wait()
  assert.deepEqual(p.get(), { available: false, reason: 'no ATLAS_VOICE_STT_CMD' })

  p = probe([{ name: 'news-ingest' }])
  p.get(); await wait()
  assert.match(p.get().reason, /voice addon is not enabled/)

  p = createSttProbe({ env: ENV, fetch: async () => { throw new Error('ECONNREFUSED') } })
  p.get(); await wait()
  assert.equal(p.get().available, null)
  assert.match(p.get().reason, /ECONNREFUSED/)
})

test('status() carries voiceNotes: unknown at first, then what the voice addon says — and a disabled voice addon breaks nothing', async () => {
  const real = globalThis.fetch
  const answers = { addons: [{ name: 'telegram' }] } // no voice addon in the list
  globalThis.fetch = async () => ({ json: async () => answers })
  const keep = { ...process.env }
  const dir = path.join(TMP, `status-${crypto.randomUUID()}`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'telegram-poller.lock'), JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }))
  Object.assign(process.env, ENV, { TELEGRAM_STATE_FILE: path.join(dir, 'status.json') })
  try {
    const m = registerAddon(ctx)
    assert.match(m.status().voiceNotes.transcription, /^unknown/)
    await new Promise((r) => setTimeout(r, 20))
    assert.match(m.status().voiceNotes.transcription, /NOT AVAILABLE — the voice addon is not enabled/)
    assert.equal(m.status().voiceNotes.maxAudioBytes, 20 * 1024 * 1024)
    assert.equal(m.status().counters.audioReceived, 0)
  } finally {
    globalThis.fetch = real
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]
    Object.assign(process.env, keep)
  }
})

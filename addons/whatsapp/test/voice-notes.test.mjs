/* ------------------------------------------------------------------ *
 * addons/whatsapp — voice notes (type "audio") end to end.
 *
 * Meta's media endpoints, the box's /api/voice/transcribe route and core's agent
 * routes are ONE stubbed `fetch`: nothing leaves the process, no credential is
 * real, and no audio touches the disk. What this pins:
 *   · the flow: media lookup → byte download (BOTH with the bearer) → raw POST to
 *     the transcription route → the marked transcript reaches the agent;
 *   · a voice note (voice: true) and an attached audio file (voice: false) go the
 *     same way; image/document/sticker stay UNSUPPORTED;
 *   · every failure is a short, specific reply to the sender and never a forward:
 *     STT off (503/404), empty transcript, too large (by file_size, BEFORE any
 *     download), a Graph error, a failed download, a timeout;
 *   · dedupe and the allowlist still apply; the counters; status().
 * Run: node --test addons/whatsapp/test/voice-notes.test.mjs
 * ------------------------------------------------------------------ */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { buildRoutes, default as registerAddon } from '../api/register.mjs'
import { createInbound, VOICE_MARK } from '../api/inbound.mjs'
import { createSttProbe, fetchAudio, transcribe } from '../api/audio.mjs'

const express = createRequire(new URL('../../../api/src/', import.meta.url))('express')
const ctx = { name: 'whatsapp', express, Router: (o) => express.Router(o) }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-voice-test-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const BEARER = 'dash-bearer'
const TOKEN = 'a-token'
const ENV = {
  WHATSAPP_VERIFY_TOKEN: 'v-token',
  WHATSAPP_APP_SECRET: 'app-secret',
  WHATSAPP_ACCESS_TOKEN: TOKEN,
  WHATSAPP_PHONE_NUMBER_ID: '555',
  WHATSAPP_ALLOWED_FROM: '4915112345678',
  DASHBOARD_BEARER_TOKEN: BEARER,
  API_PORT: '3001',
}
const OGG = Buffer.from('OggS-not-really-audio')
const LOOKASIDE = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=M1'

const audio = (id, voice = true, mediaId = 'M1') => ({ id, from: '4915112345678', type: 'audio', audio: { id: mediaId, mime_type: 'audio/ogg; codecs=opus', voice, sha256: 'x' } })
const payload = (messages) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages } }] }] })

/** One stub for Meta (Graph + lookaside), the transcription route and core's agent routes. */
function makeWorld({ lookup = { status: 200, body: { url: LOOKASIDE, mime_type: 'audio/ogg', file_size: OGG.length } }, download = { status: 200 }, stt = { status: 200, body: { ok: true, text: 'Was steht heute an?' } } } = {}) {
  const w = { calls: [], sent: [], core: [], stt: [], lookup, download, sttAnswer: stt, spawned: 0 }
  const reply = (status, j, headers = {}) => ({
    ok: status < 400,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => j,
    text: async () => JSON.stringify(j),
    arrayBuffer: async () => OGG.buffer.slice(OGG.byteOffset, OGG.byteOffset + OGG.length),
  })
  w.fetch = async (url, opts = {}) => {
    w.calls.push(url)
    if (url === `https://graph.facebook.com/v21.0/M1`) {
      w.lookupAuth = opts.headers?.Authorization
      return reply(w.lookup.status, w.lookup.body)
    }
    if (url === LOOKASIDE) {
      w.downloadAuth = opts.headers?.Authorization
      if (w.download.throws) throw new Error(w.download.throws)
      return reply(w.download.status, w.download.body ?? {}, { 'content-type': w.download.type ?? 'audio/ogg; codecs=opus', ...(w.download.length ? { 'content-length': String(w.download.length) } : {}) })
    }
    if (url === 'http://127.0.0.1:3001/api/voice/transcribe') {
      w.stt.push({ auth: opts.headers?.Authorization, type: opts.headers?.['content-type'], body: opts.body })
      if (w.sttAnswer.throws) throw new Error(w.sttAnswer.throws)
      return reply(w.sttAnswer.status, w.sttAnswer.body)
    }
    if (url.startsWith('https://graph.facebook.com/v21.0/555/messages')) {
      w.sent.push(JSON.parse(opts.body))
      return reply(200, { messages: [{ id: 'wamid.x' }] })
    }
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
const replies = (w) => w.sent.map((s) => s.text.body)

/* --- the happy path ------------------------------------------------------ */

for (const voice of [true, false]) {
  test(`audio (voice: ${voice}): lookup → download with the bearer → raw POST to the transcription route → marked text to the agent`, async () => {
    const { world: w, inbound } = setup()
    await inbound.process(payload([audio('a1', voice)]))
    assert.equal(w.lookupAuth, `Bearer ${TOKEN}`)
    assert.equal(w.downloadAuth, `Bearer ${TOKEN}`, 'the lookaside URL 401s without the token')
    assert.equal(w.stt.length, 1)
    assert.equal(w.stt[0].auth, `Bearer ${BEARER}`)
    assert.equal(w.stt[0].type, 'audio/ogg; codecs=opus')
    assert.deepEqual(Buffer.from(w.stt[0].body), OGG, 'the RAW bytes, not JSON or base64')
    assert.equal(forwarded(w).length, 1)
    assert.match(forwarded(w)[0].body.task, new RegExp(`\\[WhatsApp from 4915112345678\\] ${VOICE_MARK.replace(/[[\]]/g, '\\$&')} Was steht heute an\\?`))
    assert.equal(w.sent.length, 0, 'the agent answers, not the bridge')
    assert.deepEqual([inbound.counters.audioReceived, inbound.counters.transcribed, inbound.counters.transcribeErrors, inbound.counters.forwarded], [1, 1, 0, 1])
    assert.equal(inbound.counters.unsupported, 0)
  })
}

test('a non-audio content-type on the download falls back to the lookup\'s mime_type', async () => {
  const { world: w, inbound } = setup({ download: { status: 200, type: 'application/octet-stream' } })
  await inbound.process(payload([audio('a1')]))
  assert.equal(w.stt[0].type, 'audio/ogg')
})

test('the session brief tells a new session what a transcribed voice note looks like', async () => {
  const { sessionBrief } = await import('../api/agent.mjs')
  assert.ok(sessionBrief().includes(VOICE_MARK))
})

/* --- failure modes: specific reply, no forward ------------------------------ */

test('transcription 503 (voice addon / STT off) → the specific hint, transcribeErrors, NO forward', async () => {
  const { world: w, inbound, log } = setup({ stt: { status: 503, body: { ok: false, error: 'no ATLAS_VOICE_STT_CMD — dictation uses the browser…' } } })
  await inbound.process(payload([audio('a1')]))
  assert.equal(w.sent.length, 1)
  assert.match(replies(w)[0], /Spracherkennung ist auf der Box gerade nicht aktiv/)
  assert.equal(replies(w)[0].includes('ATLAS_VOICE_STT_CMD'), false, 'the route\'s error text is not passed through')
  assert.equal(w.sent[0].to, '4915112345678')
  assert.equal(forwarded(w).length, 0)
  assert.equal(inbound.counters.transcribeErrors, 1)
  assert.equal(inbound.counters.transcribed, 0)
  assert.equal(inbound.counters.forwarded, 0)
  assert.ok(log.some((l) => /503/.test(l) && /ATLAS_VOICE_STT_CMD/.test(l)), 'status code and error text go to the log')
})

test('the voice addon disabled (route not mounted → 404) is the same hint', async () => {
  const { world: w, inbound } = setup({ stt: { status: 404, body: {} } })
  await inbound.process(payload([audio('a1')]))
  assert.match(replies(w)[0], /Spracherkennung ist auf der Box gerade nicht aktiv/)
  assert.equal(inbound.counters.transcribeErrors, 1)
})

test('an empty transcript (voice answers 503 "produced no transcript", or 200 with no text) → its own hint, no forward', async () => {
  for (const stt of [
    { status: 503, body: { ok: false, error: 'the STT command produced no transcript' } },
    { status: 200, body: { ok: true, text: '  ' } },
  ]) {
    const { world: w, inbound } = setup({ stt })
    await inbound.process(payload([audio('a1')]))
    assert.match(replies(w)[0], /nichts zu hören/)
    assert.equal(forwarded(w).length, 0)
    assert.equal(inbound.counters.transcribeEmpty, 1)
    assert.equal(inbound.counters.transcribeErrors, 0, 'silence is not an engine error')
  }
})

test('file_size over the limit → no download, no transcription, a hint', async () => {
  const { world: w, inbound } = setup({ lookup: { status: 200, body: { url: LOOKASIDE, mime_type: 'audio/ogg', file_size: 16 * 1024 * 1024 + 1 } } })
  await inbound.process(payload([audio('a1')]))
  assert.equal(w.calls.includes(LOOKASIDE), false, 'nothing was downloaded')
  assert.equal(w.stt.length, 0)
  assert.match(replies(w)[0], /zu lang/)
  assert.equal(inbound.counters.audioTooLarge, 1)
  assert.equal(forwarded(w).length, 0)
})

test('the limit is configurable, and Meta\'s file_size is only a claim — the bytes are checked too', async () => {
  let s = setup({ env: { WHATSAPP_MAX_AUDIO_BYTES: '10' }, lookup: { status: 200, body: { url: LOOKASIDE, file_size: 11 } } })
  await s.inbound.process(payload([audio('a1')]))
  assert.equal(s.world.calls.includes(LOOKASIDE), false)
  // no file_size at all, but the content-length gives it away
  s = setup({ env: { WHATSAPP_MAX_AUDIO_BYTES: '10' }, lookup: { status: 200, body: { url: LOOKASIDE } }, download: { status: 200, length: 5000 } })
  await s.inbound.process(payload([audio('a2')]))
  assert.equal(s.world.stt.length, 0)
  // no file_size, no content-length: the downloaded buffer (21 bytes) is over 10
  s = setup({ env: { WHATSAPP_MAX_AUDIO_BYTES: '10' }, lookup: { status: 200, body: { url: LOOKASIDE } } })
  await s.inbound.process(payload([audio('a3')]))
  assert.equal(s.world.stt.length, 0)
  assert.equal(s.inbound.counters.audioTooLarge, 1)
})

test('Graph error on the media lookup → hint, mediaErrors, status + text in the log, no forward', async () => {
  const { world: w, inbound, log } = setup({ lookup: { status: 400, body: { error: { message: 'Unsupported get request', code: 100 } } } })
  await inbound.process(payload([audio('a1')]))
  assert.match(replies(w)[0], /nicht laden/)
  assert.equal(inbound.counters.mediaErrors, 1)
  assert.equal(w.stt.length, 0)
  assert.equal(forwarded(w).length, 0)
  assert.ok(log.some((l) => /400/.test(l) && /Unsupported get request/.test(l)))
})

test('a failed byte download (401, or a network error) → hint, mediaErrors, no transcription', async () => {
  for (const download of [{ status: 401, body: { error: { message: 'Invalid OAuth access token' } } }, { throws: 'socket hang up' }]) {
    const { world: w, inbound, log } = setup({ download })
    await inbound.process(payload([audio('a1')]))
    assert.match(replies(w)[0], /nicht laden/)
    assert.equal(inbound.counters.mediaErrors, 1)
    assert.equal(w.stt.length, 0)
    assert.ok(log.some((l) => /download failed/.test(l) && /(401.*Invalid OAuth|socket hang up)/.test(l)))
  }
})

test('a lookup answering a non-https download url is refused — the token is not sent over plaintext', async () => {
  const { world: w, inbound } = setup({ lookup: { status: 200, body: { url: 'http://evil.example/a', file_size: 3 } } })
  await inbound.process(payload([audio('a1')]))
  assert.equal(w.calls.some((u) => u.includes('evil.example')), false)
  assert.equal(inbound.counters.mediaErrors, 1)
})

test('an unexpected transcription failure (500, a timeout, a dead route) → the generic hint, transcribeErrors', async () => {
  for (const stt of [{ status: 500, body: { error: 'x' } }, { throws: 'The operation was aborted due to timeout' }, { throws: 'fetch failed' }]) {
    const { world: w, inbound } = setup({ stt })
    await inbound.process(payload([audio('a1')]))
    assert.match(replies(w)[0], /nicht auswerten/)
    assert.equal(inbound.counters.transcribeErrors, 1)
    assert.equal(forwarded(w).length, 0)
  }
})

test('413 from the voice route (its own, smaller cap) → the "too long" hint', async () => {
  const { world: w, inbound } = setup({ stt: { status: 413, body: {} } })
  await inbound.process(payload([audio('a1')]))
  assert.match(replies(w)[0], /zu lang/)
  assert.equal(inbound.counters.transcribeErrors, 1)
})

test('an audio message with no media id → hint, no lookup', async () => {
  const { world: w, inbound } = setup()
  await inbound.process(payload([{ id: 'a1', from: '4915112345678', type: 'audio', audio: {} }]))
  assert.equal(w.calls.length, 1, 'only the reply')
  assert.equal(inbound.counters.mediaErrors, 1)
})

/* --- what did NOT change ------------------------------------------------------ */

test('sticker / location are still UNSUPPORTED — no media call at all (image / document / video: media.test.mjs)', async () => {
  const { world: w, inbound } = setup()
  const from = '4915112345678'
  await inbound.process(payload([
    { id: 's1', from, type: 'sticker', sticker: { id: 'M1' } },
    { id: 'l1', from, type: 'location', location: { latitude: 1, longitude: 2 } },
  ]))
  assert.equal(w.sent.length, 2)
  for (const r of replies(w)) assert.match(r, /noch nicht lesen/)
  assert.equal(w.calls.some((u) => u.includes('M1') || u.includes('lookaside')), false)
  assert.equal(inbound.counters.unsupported, 2)
  assert.equal(inbound.counters.audioReceived, 0)
})

test('dedupe: a redelivered audio message is transcribed and forwarded once', async () => {
  const { world: w, inbound } = setup()
  await inbound.process(payload([audio('dup')]))
  await inbound.process(payload([audio('dup')]))
  assert.equal(w.stt.length, 1)
  assert.equal(forwarded(w).length, 1)
  assert.equal(inbound.counters.duplicates, 1)
  assert.equal(inbound.counters.audioReceived, 1)
})

test('allowlist: audio from a stranger is dropped before any media call, and gets no reply', async () => {
  const { world: w, inbound } = setup()
  await inbound.process(payload([{ ...audio('x1'), from: '4999000111' }]))
  assert.equal(w.calls.length, 0)
  assert.equal(inbound.counters.dropped, 1)
  assert.equal(inbound.counters.audioReceived, 0)
})

test('messages stay serialised: a voice note and the text behind it reach the agent in order', async () => {
  const { world: w, inbound } = setup()
  await inbound.process(payload([audio('a1'), { id: 't1', from: '4915112345678', type: 'text', text: { body: 'und noch was' } }]))
  const tasks = forwarded(w).map((c) => c.body.task) // the stub reports no live session, so each turn spawns
  assert.equal(tasks.length, 2)
  assert.match(tasks[0], /Sprachnachricht, transkribiert/)
  assert.match(tasks[1], /und noch was/)
  assert.equal(inbound.counters.forwarded, 2)
})

/* --- through the real webhook route ------------------------------------------- */

test('the webhook still answers 200 at once; the audio work happens after', async () => {
  const world = makeWorld()
  let release
  const gate = new Promise((r) => (release = r))
  const slow = async (url, opts) => (url === LOOKASIDE ? (await gate, world.fetch(url, opts)) : world.fetch(url, opts))
  const file = path.join(TMP, `state-${crypto.randomUUID()}.json`)
  const { routes } = buildRoutes(ctx, { env: ENV, fetch: slow, log: () => {}, file })
  const app = express()
  app.use(routes)
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  after(() => server.close())
  const raw = JSON.stringify(payload([audio('w1')]))
  const sig = `sha256=${crypto.createHmac('sha256', ENV.WHATSAPP_APP_SECRET).update(raw).digest('hex')}`
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/whatsapp/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-hub-signature-256': sig },
    body: raw,
  })
  assert.equal(r.status, 200, 'answered while the download is still blocked')
  assert.equal(world.stt.length, 0)
  release()
  const t = Date.now()
  while (!forwarded(world).length) {
    if (Date.now() - t > 2000) assert.fail('the audio never reached the agent')
    await new Promise((res) => setTimeout(res, 5))
  }
  assert.match(forwarded(world)[0].body.task, /Sprachnachricht, transkribiert/)
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
  await transcribe(OGG, 'audio/ogg', { env: { ...ENV, WHATSAPP_TRANSCRIBE_TIMEOUT_MS: '5' }, fetch: f })
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
  const answers = { addons: [{ name: 'whatsapp' }] } // no voice addon in the list
  globalThis.fetch = async () => ({ json: async () => answers })
  const keep = { ...process.env }
  Object.assign(process.env, ENV, { WHATSAPP_STATE_FILE: path.join(TMP, 'status.json') })
  try {
    const m = registerAddon(ctx)
    assert.match(m.status().voiceNotes.transcription, /^unknown/)
    await new Promise((r) => setTimeout(r, 20))
    assert.match(m.status().voiceNotes.transcription, /NOT AVAILABLE — the voice addon is not enabled/)
    assert.equal(m.status().voiceNotes.maxAudioBytes, 16 * 1024 * 1024)
    assert.equal(m.status().counters.audioReceived, 0)
  } finally {
    globalThis.fetch = real
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]
    Object.assign(process.env, keep)
  }
})

/* ------------------------------------------------------------------ *
 * addons/telegram — voice REPLIES (POST /send with voice: true) end to end.
 *
 * The box's /api/voice/speak route, Telegram's sendVoice and ffmpeg are
 * stubbed: ONE fake `fetch` and one fake `exec`. Nothing leaves the process, no
 * credential is real, no ffmpeg runs. What this pins:
 *   · voice: true → speak (bearer, {text}) → ffmpeg → ONE sendVoice multipart
 *     call (chat_id + the file) — unlike WhatsApp, no separate upload step;
 *   · without voice the route is EXACTLY what it was (text, same answer shape);
 *   · a text over the chunk cap is read in several speak calls and sent as ONE
 *     voice note, nothing cut; over the hard cap nothing is read at all;
 *   · every failure — TTS 503/timeout, ffmpeg failing or missing, Telegram
 *     refusing the send — ends in the TEXT message, once, with the reason in the
 *     answer and the counters;
 *   · temp files are gone afterwards; status() and install.sh --check are honest,
 *     also when the voice addon is off.
 * Run: node --test addons/telegram/test/voice-replies.test.mjs
 * ------------------------------------------------------------------ */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { buildRoutes, default as registerAddon } from '../api/register.mjs'
import { sessionBrief } from '../api/agent.mjs'
import { chunkForSpeech } from '../api/voice-reply.mjs'

const express = createRequire(new URL('../../../api/src/', import.meta.url))('express')
const ctx = { name: 'telegram', express, Router: (o) => express.Router(o) }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-voice-reply-test-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const BEARER = 'dash-bearer'
const TOKEN = 'bot-token'
const ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_HOME_CHAT_ID: '111', DASHBOARD_BEARER_TOKEN: BEARER, API_PORT: '3001' }
const OGG = Buffer.from('OggS-fake-opus-bytes')
const SPEAK = 'http://127.0.0.1:3001/api/voice/speak'

const reply = (status, j, { headers = {}, bytes } = {}) => ({
  ok: status < 400,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => j,
  text: async () => JSON.stringify(j),
  arrayBuffer: async () => (bytes ?? Buffer.alloc(0)).buffer.slice((bytes ?? Buffer.alloc(0)).byteOffset, (bytes ?? Buffer.alloc(0)).byteOffset + (bytes ?? Buffer.alloc(0)).length),
})

/**
 * One stub for the voice route and the Telegram Bot API. Scripts (all optional):
 *   speak(n, text) → { status, type, bytes } | { throws }   n = 0-based call number
 *   voiceSend / textSend → { status, body } | { throws }
 */
function makeWorld(script = {}) {
  const w = { speakCalls: [], voiceSends: [], messages: [], order: [], script }
  w.fetch = async (url, opts = {}) => {
    if (url === SPEAK) {
      const text = JSON.parse(opts.body).text
      const n = w.speakCalls.length
      w.speakCalls.push({ auth: opts.headers?.Authorization, text })
      w.order.push('speak')
      const a = (script.speak ?? ((i) => ({ status: 200, type: 'audio/wav', bytes: Buffer.from(`WAV-${i}`) })))(n, text)
      if (a.throws) throw new Error(a.throws)
      return a.status === 200 ? reply(200, {}, { headers: { 'content-type': a.type }, bytes: a.bytes }) : reply(a.status, { ok: false, error: a.error ?? 'no ATLAS_VOICE_TTS_CMD' })
    }
    if (url === `https://api.telegram.org/bot${TOKEN}/sendVoice`) {
      w.voiceSends.push({ form: opts.body })
      w.order.push('voice')
      const a = script.voiceSend ?? { status: 200, body: { ok: true, result: { message_id: 1 } } }
      if (a.throws) throw new Error(a.throws)
      return reply(a.status, a.body)
    }
    if (url === `https://api.telegram.org/bot${TOKEN}/sendMessage`) {
      const body = JSON.parse(opts.body)
      w.messages.push(body)
      w.order.push('text')
      const a = script.textSend ?? { status: 200, body: { ok: true, result: { message_id: 1 } } }
      if (a.throws) throw new Error(a.throws)
      return reply(a.status, a.body)
    }
    return reply(404, {})
  }
  return w
}

/** A fake ffmpeg: records argv, the input files it could read, and writes OGG to the output. */
function makeExec({ code = 0, stderr = '', missing = false } = {}) {
  const e = { calls: [], dirs: [] }
  e.exec = async (bin, args) => {
    const inputs = args.flatMap((a, i) => (args[i - 1] === '-i' ? [a] : []))
    const out = args.at(-1)
    e.calls.push({ bin, args, inputs: inputs.map((f) => ({ name: path.basename(f), bytes: fs.readFileSync(f) })) })
    e.dirs.push(path.dirname(out))
    if (code === 0 && !missing) fs.writeFileSync(out, OGG)
    return { code: missing ? null : code, stderr, missing }
  }
  return e
}

async function serve({ world = makeWorld(), ff = makeExec(), env = ENV } = {}) {
  const log = []
  const file = path.join(TMP, `state-${crypto.randomUUID()}.json`)
  const { routes, voice } = buildRoutes(ctx, { env, fetch: world.fetch, log: (m) => log.push(m), file, exec: ff.exec, startPoller: false })
  const app = express()
  app.use(routes)
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  after(() => server.close())
  const send = async (body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/telegram/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${BEARER}` },
      body: JSON.stringify(body),
    })
    return { status: r.status, json: await r.json() }
  }
  return { world, ff, log, send, counters: voice.counters }
}

const dirsGone = (ff) => ff.dirs.every((d) => !fs.existsSync(d))

/* --- the happy path ------------------------------------------------------ */

test('voice: true → speak → ffmpeg → ONE sendVoice multipart call, no separate upload', async () => {
  const s = await serve()
  const r = await s.send({ text: 'Hallo Welt', voice: true })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { ok: true, mode: 'voice', sent: 1, parts: 1, chunks: 1 })

  const w = s.world
  assert.deepEqual(w.speakCalls, [{ auth: `Bearer ${BEARER}`, text: 'Hallo Welt' }])
  assert.deepEqual(w.order, ['speak', 'voice'], 'in this order, and no text message, no separate upload call')

  assert.equal(s.ff.calls.length, 1)
  const { bin, args, inputs } = s.ff.calls[0]
  assert.equal(bin, 'ffmpeg')
  assert.deepEqual(inputs.map((i) => i.bytes.toString()), ['WAV-0'])
  const opt = (k) => args[args.indexOf(k) + 1]
  assert.equal(opt('-c:a'), 'libopus')
  assert.equal(opt('-ac'), '1', 'a mono voice note')
  assert.equal(opt('-f'), 'ogg')
  assert.match(opt('-filter_complex'), /concat=n=1:v=0:a=1/)

  assert.equal(w.voiceSends.length, 1)
  const form = w.voiceSends[0].form
  assert.ok(form instanceof FormData)
  assert.equal(form.get('chat_id'), '111')
  const file = form.get('voice')
  assert.equal(file.type, 'audio/ogg')
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), OGG)

  assert.deepEqual(s.counters, { voiceSent: 1, voiceFallbacks: 0, ttsErrors: 0, ffmpegErrors: 0, sendErrors: 0 })
  assert.ok(dirsGone(s.ff), 'nothing left in the temp dir')
})

test('the declared content-type only picks the temp file extension — ffmpeg decides by the bytes, WAV is not assumed', async () => {
  const cases = [['audio/mpeg', '.mp3'], ['audio/wav', '.wav'], ['audio/ogg; codecs=opus', '.ogg'], ['application/x-something', '.bin'], ['', '.bin']]
  for (const [type, ext] of cases) {
    const s = await serve({ world: makeWorld({ speak: () => ({ status: 200, type, bytes: Buffer.from('AUDIO') }) }) })
    const r = await s.send({ text: 'x', voice: true })
    assert.equal(r.json.mode, 'voice', type)
    assert.equal(s.ff.calls[0].inputs[0].name, `in0${ext}`, type)
  }
})

/* --- without voice: exactly today ------------------------------------------ */

test('without voice (absent, false, null) the route is the plain text send — same answer, no TTS, no ffmpeg', async () => {
  for (const body of [{ text: 'Hallo' }, { text: 'Hallo', voice: false }, { text: 'Hallo', voice: null }]) {
    const s = await serve()
    const r = await s.send(body)
    assert.deepEqual(r.json, { ok: true, sent: 1, parts: 1 }, 'no mode key: byte-identical to before')
    assert.deepEqual(s.world.messages, [{ chat_id: '111', text: 'Hallo' }])
    assert.equal(s.world.speakCalls.length + s.world.voiceSends.length + s.ff.calls.length, 0)
  }
})

test('a "voice" that is not a boolean is refused loudly', async () => {
  const s = await serve()
  for (const voice of ['true', 1, {}]) {
    const r = await s.send({ text: 'x', voice })
    assert.equal(r.status, 400)
    assert.match(r.json.error, /"voice" must be true or false/)
  }
  assert.equal(s.world.messages.length, 0)
})

/* --- length: chunking and the hard cap ------------------------------------- */

test('a text over the spoken-char cap is read in several speak calls, in order, and sent as ONE voice note — nothing cut', async () => {
  const para = (i) => `Absatz ${i}: ${'wort '.repeat(55)}`.trim() + '.'
  const text = [1, 2, 3, 4, 5, 6].map(para).join('\n\n')
  assert.ok(text.length > 1500)
  const s = await serve()
  const r = await s.send({ text, voice: true })
  assert.equal(r.json.mode, 'voice')
  const said = s.world.speakCalls.map((c) => c.text)
  assert.ok(said.length >= 3, `several calls, got ${said.length}`)
  assert.ok(said.every((t) => t.length <= 700))
  assert.equal(said.join(' ').replace(/\s+/g, ' '), text.replace(/\s+/g, ' '), 'every word is spoken, none dropped')
  assert.equal(r.json.chunks, said.length)
  assert.equal(s.ff.calls.length, 1)
  assert.deepEqual(s.ff.calls[0].inputs.map((i) => i.bytes.toString()), said.map((_, i) => `WAV-${i}`))
  assert.equal(s.world.voiceSends.length, 1)
  assert.deepEqual(s.world.order.filter((o) => o !== 'speak'), ['voice'])
  assert.equal(s.counters.voiceSent, 1)
})

test('the spoken-char cap is configurable (it belongs with ATLAS_VOICE_MAX_SPOKEN_CHARS)', async () => {
  const s = await serve({ env: { ...ENV, TELEGRAM_MAX_SPOKEN_CHARS: '100' } })
  const r = await s.send({ text: 'Ein Satz steht hier. '.repeat(20), voice: true })
  assert.equal(r.json.mode, 'voice')
  assert.ok(s.world.speakCalls.length >= 4)
  assert.ok(s.world.speakCalls.every((c) => c.text.length <= 100))
})

test('over the hard cap nothing is read aloud: a text message, mode "text" with the reason, no TTS call', async () => {
  const text = 'Satz. '.repeat(600)
  const s = await serve()
  const r = await s.send({ text, voice: true })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.mode, 'text')
  assert.match(r.json.voiceError, /3599 characters.*TELEGRAM_MAX_VOICE_CHARS \(3000\).*too long to read aloud/)
  assert.equal(s.world.speakCalls.length, 0)
  assert.equal(s.ff.calls.length, 0)
  assert.equal(s.world.messages.length, 1)
  assert.equal(s.world.messages[0].text, text.trim())
  assert.deepEqual([s.counters.voiceFallbacks, s.counters.ttsErrors, s.counters.voiceSent], [1, 0, 0])
})

test('the hard cap is configurable; a text exactly at it is still read', async () => {
  const s = await serve({ env: { ...ENV, TELEGRAM_MAX_VOICE_CHARS: '50' } })
  assert.equal((await s.send({ text: 'x'.repeat(50), voice: true })).json.mode, 'voice')
  assert.equal((await s.send({ text: 'x'.repeat(51), voice: true })).json.mode, 'text')
})

/* --- every failure ends in the text, once ------------------------------------ */

test('TTS answers 503 → text fallback, voiceFallbacks + ttsErrors, the operator gets the text, Telegram is never asked for a voice note', async () => {
  const s = await serve({ world: makeWorld({ speak: () => ({ status: 503, error: 'no ATLAS_VOICE_TTS_CMD — recaps are spoken by the browser' }) }) })
  const r = await s.send({ text: 'Das ist die Antwort.', voice: true })
  assert.equal(r.status, 200)
  assert.deepEqual([r.json.ok, r.json.mode, r.json.sent], [true, 'text', 1])
  assert.match(r.json.voiceError, /speech synthesis: HTTP 503: no ATLAS_VOICE_TTS_CMD/)
  assert.deepEqual(s.world.messages.map((m) => m.text), ['Das ist die Antwort.'])
  assert.equal(s.world.voiceSends.length + s.ff.calls.length, 0)
  assert.deepEqual(s.counters, { voiceSent: 0, voiceFallbacks: 1, ttsErrors: 1, ffmpegErrors: 0, sendErrors: 0 })
  assert.ok(s.log.some((l) => /503/.test(l) && /ATLAS_VOICE_TTS_CMD/.test(l)))
})

test('a later chunk failing (or the route timing out / dying) still sends the WHOLE text, and nothing half-spoken', async () => {
  const text = ['a'.repeat(400), 'b'.repeat(400), 'c'.repeat(400)].join('\n\n')
  for (const bad of [{ status: 503, error: 'engine crashed' }, { throws: 'The operation was aborted due to timeout' }, { throws: 'fetch failed' }]) {
    const s = await serve({ world: makeWorld({ speak: (n) => (n === 1 ? bad : { status: 200, type: 'audio/wav', bytes: Buffer.from('WAV') }) }) })
    const r = await s.send({ text, voice: true })
    assert.equal(r.json.mode, 'text')
    assert.deepEqual(s.world.messages.map((m) => m.text), [text])
    assert.equal(s.world.speakCalls.length, 2, 'stops at the failing chunk')
    assert.equal(s.world.voiceSends.length, 0)
    assert.equal(s.counters.ttsErrors, 1)
  }
})

test('the voice route answering 200 with no audio is a TTS failure, not an empty voice note', async () => {
  const s = await serve({ world: makeWorld({ speak: () => ({ status: 200, type: 'audio/wav', bytes: Buffer.alloc(0) }) }) })
  const r = await s.send({ text: 'x', voice: true })
  assert.equal(r.json.mode, 'text')
  assert.equal(s.counters.ttsErrors, 1)
})

test('ffmpeg failing (non-zero, timeout) or missing → text fallback, ffmpegErrors, no voice send, temp dir gone', async () => {
  for (const ff of [
    makeExec({ code: 1, stderr: "Unknown encoder 'libopus'" }),
    makeExec({ code: null, stderr: 'timed out after 60000ms' }),
    makeExec({ missing: true, stderr: 'spawn ffmpeg ENOENT' }),
  ]) {
    const s = await serve({ ff })
    const r = await s.send({ text: 'Antwort', voice: true })
    assert.deepEqual([r.status, r.json.ok, r.json.mode], [200, true, 'text'])
    assert.match(r.json.voiceError, /ffmpeg/)
    assert.deepEqual(s.world.messages.map((m) => m.text), ['Antwort'])
    assert.equal(s.world.voiceSends.length, 0)
    assert.equal(s.counters.ffmpegErrors, 1)
    assert.equal(s.counters.voiceFallbacks, 1)
    assert.ok(dirsGone(ff))
  }
})

test('ffmpeg exiting 0 but writing nothing is a failure, not an empty send', async () => {
  const empty = { calls: [], dirs: [], exec: async (_b, args) => { fs.writeFileSync(args.at(-1), ''); return { code: 0, stderr: '' } } }
  const s = await serve({ ff: empty })
  assert.equal((await s.send({ text: 'x', voice: true })).json.mode, 'text')
  assert.equal(s.world.voiceSends.length, 0)
})

test('Telegram refusing the voice send → text fallback, sendErrors, Telegram\'s status and text in the log', async () => {
  const s = await serve({ world: makeWorld({ voiceSend: { status: 400, body: { ok: false, description: 'VOICE_MESSAGES_FORBIDDEN' } } }) })
  const r = await s.send({ text: 'Antwort', voice: true })
  assert.deepEqual([r.status, r.json.ok, r.json.mode], [200, true, 'text'])
  assert.match(r.json.voiceError, /voice send: VOICE_MESSAGES_FORBIDDEN/)
  assert.deepEqual(s.world.messages.map((m) => m.text), ['Antwort'])
  assert.deepEqual([s.counters.sendErrors, s.counters.voiceFallbacks, s.counters.voiceSent], [1, 1, 0])
  assert.ok(s.log.some((l) => /voice send/.test(l) && /400/.test(l) && /VOICE_MESSAGES_FORBIDDEN/.test(l)))
})

test('ONE fallback only: when the text send fails too the route says 502 — no loop, no second voice attempt', async () => {
  const s = await serve({ world: makeWorld({ voiceSend: { status: 400, body: { ok: false, description: 'nope' } }, textSend: { status: 400, body: { ok: false, description: 'chat not found' } } }) })
  const r = await s.send({ text: 'Antwort', voice: true })
  assert.equal(r.status, 502)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.mode, 'text')
  assert.match(r.json.voiceError, /voice send/)
  assert.match(r.json.error, /chat not found/)
  assert.equal(s.world.messages.length, 1, 'one text attempt')
  assert.equal(s.world.voiceSends.length, 1)
  assert.equal(s.world.speakCalls.length, 1)
})

test('a "chat_id" outside the allowlist is refused before any TTS runs', async () => {
  const s = await serve()
  const r = await s.send({ text: 'x', voice: true, chat_id: '999' })
  assert.equal(r.status, 400)
  assert.equal(s.world.speakCalls.length, 0)
})

test('without DASHBOARD_BEARER_TOKEN the speak route cannot be called — the text still goes out', async () => {
  const { createVoiceReplies } = await import('../api/voice-reply.mjs')
  const { DASHBOARD_BEARER_TOKEN, ...env } = ENV
  const w = makeWorld()
  const v = createVoiceReplies({ env, fetch: w.fetch, log: () => {}, exec: makeExec().exec })
  const r = await v.send({ chatId: '111', text: 'Antwort' })
  assert.equal(r.mode, 'text')
  assert.match(r.voiceError, /DASHBOARD_BEARER_TOKEN/)
  assert.equal(w.speakCalls.length, 0)
})

/* --- the chunker itself --------------------------------------------------------- */

const norm = (s) => s.replace(/\s+/g, ' ').trim()

test('chunkForSpeech: short text is one piece, empty is none, exactly the cap still fits', () => {
  assert.deepEqual(chunkForSpeech('Hallo.'), ['Hallo.'])
  assert.deepEqual(chunkForSpeech('  \n '), [])
  assert.deepEqual(chunkForSpeech(undefined), [])
  assert.equal(chunkForSpeech('x'.repeat(700), 700).length, 1)
  assert.equal(chunkForSpeech('x'.repeat(701), 700).length, 2)
})

test('chunkForSpeech: paragraphs are packed greedily and never split when they fit', () => {
  const p = (c) => `${c.repeat(299)}.`
  assert.deepEqual(chunkForSpeech([p('a'), p('b'), p('c'), p('d')].join('\n\n'), 700), [`${p('a')}\n\n${p('b')}`, `${p('c')}\n\n${p('d')}`])
})

test('chunkForSpeech: a long paragraph breaks at SENTENCES, every piece ends whole, nothing is lost', () => {
  const text = Array.from({ length: 80 }, (_, i) => `Das ist der Satz Nummer ${i}.`).join(' ')
  const parts = chunkForSpeech(text, 700)
  assert.ok(parts.length >= 3)
  for (const p of parts) {
    assert.ok(p.length <= 700)
    assert.match(p, /\.$/)
    assert.match(p, /^Das ist/)
  }
  assert.equal(norm(parts.join(' ')), norm(text))
})

test('chunkForSpeech: one endless sentence is cut on a word; a hard cut never splits a surrogate pair', () => {
  const words = Array.from({ length: 400 }, (_, i) => `wort${i}`).join(' ')
  const parts = chunkForSpeech(words, 700)
  assert.ok(parts.length >= 2 && parts.every((p) => p.length <= 700))
  assert.equal(parts.join(' '), words)
  for (const p of chunkForSpeech('😀'.repeat(900), 700)) {
    assert.ok(p.length <= 700)
    assert.equal(p, [...p].join(''))
  }
})

/* --- status() ------------------------------------------------------------------ */

async function withEnv(env, addons, fn) {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ json: async () => ({ addons }) })
  const keep = { ...process.env }
  for (const k of Object.keys(process.env)) if (k.startsWith('TELEGRAM_') || k === 'DASHBOARD_BEARER_TOKEN') delete process.env[k]
  const dir = path.join(TMP, `status-${crypto.randomUUID()}`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'telegram-poller.lock'), JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() })) // never let a real poller start under a stubbed fetch
  Object.assign(process.env, ENV, { TELEGRAM_STATE_FILE: path.join(dir, 'status.json') }, env)
  try {
    return await fn()
  } finally {
    globalThis.fetch = realFetch
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]
    Object.assign(process.env, keep)
  }
}
const wait = () => new Promise((r) => setTimeout(r, 20))

function binDir(name, ...tools) {
  const dir = path.join(TMP, `bin-${crypto.randomUUID()}`)
  fs.mkdirSync(dir)
  for (const t of tools) fs.writeFileSync(path.join(dir, t), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return dir
}

test('status().voiceReplies: unknown at first, then what the voice addon says; ffmpeg follows PATH; the caps are shown', async () => {
  const withTts = [{ name: 'voice', status: { tts: { configured: true, available: true } } }]
  await withEnv({ PATH: binDir('a', 'ffmpeg'), TELEGRAM_MAX_SPOKEN_CHARS: '500', TELEGRAM_MAX_VOICE_CHARS: '2000' }, withTts, async () => {
    const m = registerAddon(ctx)
    assert.match(m.status().voiceReplies.synthesis, /^unknown/)
    await wait()
    assert.deepEqual(m.status().voiceReplies, { synthesis: 'ready', ffmpeg: true, maxSpokenChars: 500, maxVoiceChars: 2000 })
    assert.deepEqual(Object.keys(m.status().counters).filter((k) => /voice|tts|ffmpeg|send/i.test(k)).sort(), ['ffmpegErrors', 'sendErrors', 'ttsErrors', 'voiceFallbacks', 'voiceSent'])
  })
  await withEnv({ PATH: binDir('b') }, withTts, async () => {
    const m = registerAddon(ctx)
    m.status()
    await wait()
    assert.equal(m.status().voiceReplies.ffmpeg, false)
    assert.deepEqual([m.status().voiceReplies.maxSpokenChars, m.status().voiceReplies.maxVoiceChars], [700, 3000])
  })
})

test('status().voiceReplies with the voice addon OFF, or its TTS unconfigured: says NOT AVAILABLE and breaks nothing', async () => {
  await withEnv({ PATH: binDir('c', 'ffmpeg') }, [{ name: 'telegram' }], async () => {
    const m = registerAddon(ctx)
    m.status()
    await wait()
    assert.match(m.status().voiceReplies.synthesis, /^NOT AVAILABLE — the voice addon is not enabled/)
    assert.equal(m.status().outbound, 'ready')
    assert.equal(m.status().voiceNotes.transcription.startsWith('NOT AVAILABLE'), true)
  })
  const noTts = [{ name: 'voice', status: { tts: { configured: false, available: false, reason: 'no ATLAS_VOICE_TTS_CMD — recaps are spoken by the browser' } } }]
  await withEnv({ PATH: binDir('d', 'ffmpeg') }, noTts, async () => {
    const m = registerAddon(ctx)
    m.status()
    await wait()
    assert.match(m.status().voiceReplies.synthesis, /^NOT AVAILABLE — no ATLAS_VOICE_TTS_CMD/)
  })
  const real = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
  try {
    const m = registerAddon(ctx)
    m.status()
    await wait()
    assert.match(m.status().voiceReplies.synthesis, /^unknown — could not ask the API: ECONNREFUSED/)
  } finally {
    globalThis.fetch = real
  }
})

/* --- the session brief ---------------------------------------------------------- */

test('the brief for NEW sessions explains voice: true, mirroring, what not to speak, and the length cap', () => {
  const b = sessionBrief({ port: '3001' })
  assert.match(b, /"voice":true/)
  assert.match(b, /MIRROR THE MEDIUM/)
  assert.match(b, /Sprachnachricht, transkribiert\].*voice reply/s)
  assert.match(b, /typed message gets a text reply/)
  assert.match(b, /links, long numbers, IDs, code/i)
  assert.match(b, /No bullet points/)
  assert.match(b, /"mode":"text" with "voiceError"/)
  assert.match(b, /Above 3000 characters/)
  assert.match(sessionBrief({ maxVoiceChars: 1500 }), /Above 1500 characters/)
})

/* --- install.sh --check ---------------------------------------------------------- */

function check({ env = {}, tools = {} }) {
  const root = path.join(TMP, `root-${crypto.randomUUID()}`)
  const bin = path.join(root, 'bin')
  fs.mkdirSync(path.join(root, 'addons', 'telegram'), { recursive: true })
  fs.mkdirSync(bin)
  fs.copyFileSync(new URL('../install.sh', import.meta.url), path.join(root, 'addons', 'telegram', 'install.sh'))
  for (const t of ['bash', 'grep', 'dirname']) {
    const p = spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf-8' }).stdout.trim()
    fs.symlinkSync(p, path.join(bin, t))
  }
  fs.symlinkSync(process.execPath, path.join(bin, 'node'))
  for (const [name, body] of Object.entries({ ffprobe: 'exit 0', ...tools })) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  const r = spawnSync(path.join(bin, 'bash'), [path.join(root, 'addons', 'telegram', 'install.sh'), '--check'], {
    encoding: 'utf-8',
    env: { PATH: bin, HOME: root, API_PORT: '1', ...env },
    timeout: 30000,
  })
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr }
}
const OPUS_FFMPEG = 'echo " A....D libopus              libopus Opus (codec opus)"'
const NO_OPUS_FFMPEG = 'echo " V....D libx264               libx264 H.264"'

test('install.sh --check with the voice addon OFF and no ffmpeg: says so for the voice replies, exit 2', () => {
  const r = check({ env: { ATLAS_ADDONS: '' } })
  assert.equal(r.code, 2)
  assert.match(r.err, /voice replies need the voice addon/)
  assert.match(r.err, /voice replies need ffmpeg \(with libopus\)/)
})

test('install.sh --check: TTS command set but its binary missing, ffmpeg without libopus → both named', () => {
  const r = check({ env: { ATLAS_ADDONS: 'voice', ATLAS_VOICE_TTS_CMD: 'no-such-tts --x', ATLAS_VOICE_STT_CMD: 'stt-bin' }, tools: { 'stt-bin': 'exit 0', ffmpeg: NO_OPUS_FFMPEG } })
  assert.equal(r.code, 2)
  assert.match(r.err, /ATLAS_VOICE_TTS_CMD names 'no-such-tts', which is not an executable/)
  assert.match(r.err, /ffmpeg has no libopus encoder/)
  assert.doesNotMatch(r.err, /voice notes need/)
})

test('install.sh --check: TTS command unset → its own gap, distinct from the voice-notes one', () => {
  const r = check({ env: { ATLAS_ADDONS: 'voice', ATLAS_VOICE_STT_CMD: 'stt-bin' }, tools: { 'stt-bin': 'exit 0', ffmpeg: OPUS_FFMPEG } })
  assert.match(r.err, /voice replies need on-box speech synthesis — set ATLAS_VOICE_TTS_CMD/)
  assert.doesNotMatch(r.err, /voice notes need/)
  assert.doesNotMatch(r.err, /ffmpeg/)
  assert.match(r.out, /voice replies: ffmpeg with libopus found/)
})

test('install.sh --check: TTS + ffmpeg/libopus in place → no voice-reply gap (a dead API is only a note)', () => {
  const r = check({ env: { ATLAS_ADDONS: 'voice', ATLAS_VOICE_TTS_CMD: 'tts-bin', ATLAS_VOICE_STT_CMD: 'stt-bin' }, tools: { 'tts-bin': 'exit 0', 'stt-bin': 'exit 0', ffmpeg: OPUS_FFMPEG } })
  assert.doesNotMatch(r.err, /TODO: .*voice/)
  assert.doesNotMatch(r.err, /TODO: .*ffmpeg/)
  assert.match(r.err, /voice replies: ATLAS_VOICE_TTS_CMD resolves, but the API is not answering/)
  assert.match(r.out, /voice replies: ffmpeg with libopus found/)
})

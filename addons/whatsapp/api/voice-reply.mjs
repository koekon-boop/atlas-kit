/* ------------------------------------------------------------------ *
 * Voice replies — the way back of what audio.mjs does for the way in: the
 * agent's text is read aloud on the box, re-encoded to the one format WhatsApp
 * shows as a real voice note, uploaded to Meta and sent.
 *
 *   chunkForSpeech()    text → pieces under the voice route's spoken-char cap
 *   synthesize()        POST the box's own /api/voice/speak over loopback with the
 *                       dashboard bearer (the ROUTE is the contract — nothing is
 *                       imported from addons/voice, TTS is never run from here)
 *   encodeOpus()        ffmpeg: every clip → ONE mono OGG/Opus file, no gap between
 *   createVoiceReplies  the whole flow + counters; ANY failure falls back to the
 *                       plain text message, exactly once
 *
 * 🔴 NEVER SILENT, NEVER LOST. The operator must get the answer. Whatever breaks
 * (TTS off, ffmpeg missing, Meta refusing the upload or the send, a timeout, a
 * text too long to read) ends in the ordinary text message, and the route's answer
 * says so (`mode: 'text'`, `voiceError`). One fallback, no retry loop.
 *
 * 🔴 THE VOICE ROUTE TRUNCATES SILENTLY at ATLAS_VOICE_MAX_SPOKEN_CHARS (700). A
 * longer answer would simply stop mid-sentence with no error, so the text is cut
 * into pieces below that cap here and every piece is synthesized separately.
 *
 * Audio lives in memory and in one mkdtemp dir per reply (ffmpeg needs files),
 * removed in a `finally` — never the vault, never the repo.
 * Everything takes its `fetch` / `exec` as arguments, so the tests never leave the
 * process and never run ffmpeg.
 * ------------------------------------------------------------------ */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clip, reasonOf } from './audio.mjs'
import { config } from './config.mjs'
import { sendAudio, sendText, splitMessage, uploadMedia } from './meta.mjs'

/* WhatsApp renders a file as a voice note (waveform, mic icon) only when it is
 * OGG with the OPUS codec, mono; mp3/m4a/aac arrive as an audio file. And Meta
 * documents that the play button appears only up to 512 KB — beyond that the
 * message shows a download icon. 20 kbps Opus (voip tuning) is plenty for speech
 * and is ~2.5 KB/s, so 512 KB ≈ 200 s: the 3000-character default cap (≈ 3 min)
 * stays inside it, which 32 kbps (≈ 128 s) would not. */
const OPUS_BITRATE = '20k'
const UPLOAD_MIME = 'audio/ogg'

/* Sentence boundary: after . ! ? … and whitespace. "3.5" has no whitespace after
 * the dot; "z. B." splits, which only costs a slightly earlier chunk seam. */
const SENTENCE = /(?<=[.!?…])\s+/

/**
 * Cut `text` into pieces of at most `max` chars, at paragraph boundaries where it
 * can, else sentence boundaries, else (one endless sentence) a word. Pieces are
 * packed greedily so there are as few TTS calls as possible. Nothing is dropped.
 */
export function chunkForSpeech(text, max = 700) {
  const t = String(text ?? '').trim()
  if (!t) return []
  if (t.length <= max) return [t]
  const units = [] // { text, sep } — sep is what joins it to the piece before
  for (const para of t.split(/\n{2,}/)) {
    if (para.length <= max) units.push({ text: para, sep: '\n\n' })
    else
      para
        .split(SENTENCE)
        .flatMap((s) => splitMessage(s, max))
        .forEach((s, i) => units.push({ text: s, sep: i === 0 ? '\n\n' : ' ' }))
  }
  const out = []
  let cur = ''
  for (const u of units) {
    if (cur && cur.length + u.sep.length + u.text.length > max) {
      out.push(cur)
      cur = u.text
    } else cur = cur ? cur + u.sep + u.text : u.text
  }
  if (cur) out.push(cur)
  return out
}

/** A temp-file extension from the declared type — a hint for humans and ffmpeg's
 *  probe. ffmpeg still decides by the bytes: the voice addon labels its output
 *  audio/wav by default even when the engine emits something else. */
const extFor = (mime) => {
  const m = String(mime || '').toLowerCase()
  if (m.includes('wav')) return '.wav'
  if (m.includes('ogg') || m.includes('opus')) return '.ogg'
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return '.m4a'
  if (m.includes('mpeg') || m.includes('mp3')) return '.mp3'
  if (m.includes('webm')) return '.webm'
  if (m.includes('flac')) return '.flac'
  return '.bin'
}

/**
 * One piece of text → audio, via the box's /api/voice/speak.
 * → `{ ok: true, audio: Buffer, mime }` | `{ ok: false, error }`. Total.
 */
export async function synthesize(text, { env = process.env, fetch: f = globalThis.fetch, log = console.error } = {}) {
  const c = config(env)
  if (!c.bearer) return { ok: false, error: 'DASHBOARD_BEARER_TOKEN is not set — cannot call /api/voice/speak' }
  try {
    const r = await f(`${c.apiBase}/api/voice/speak`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(c.ttsTimeoutMs),
    })
    if (!r.ok) {
      const error = `HTTP ${r.status}: ${await reasonOf(r)}`
      log(`[whatsapp] speech synthesis failed: ${error}`)
      return { ok: false, error }
    }
    const audio = Buffer.from(await r.arrayBuffer())
    if (!audio.length) {
      log('[whatsapp] speech synthesis answered with no audio')
      return { ok: false, error: 'the voice route answered with no audio' }
    }
    return { ok: true, audio, mime: r.headers?.get?.('content-type') || '' }
  } catch (e) {
    log(`[whatsapp] speech synthesis failed: ${e?.message || e}`)
    return { ok: false, error: String(e?.message || e) }
  }
}

/** Run a binary without a shell → `{ code, stderr, stdout?, missing? }`. Never rejects.
 *  `stdout` is only captured (and returned) with `captureStdout` — ffprobe's answer. */
export function run(bin, args, { timeoutMs, captureStdout = false }) {
  return new Promise((resolve) => {
    let stderr = ''
    let stdout = ''
    let done = false
    const finish = (r) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(r)
    }
    let child
    try {
      child = spawn(bin, args, { stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', 'pipe'] })
    } catch (e) {
      return resolve({ code: null, stderr: String(e?.message || e), missing: true })
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ code: null, stderr: `timed out after ${timeoutMs}ms` })
    }, timeoutMs)
    child.stderr.on('data', (d) => {
      if (stderr.length < 4000) stderr += d
    })
    child.stdout?.on('data', (d) => {
      if (stdout.length < 64000) stdout += d
    })
    child.on('error', (e) => finish({ code: null, stderr: String(e?.message || e), missing: e?.code === 'ENOENT' }))
    child.on('close', (code) => finish({ code, stderr, ...(captureStdout ? { stdout } : {}) }))
  })
}

/**
 * Join the clips (in order, no pause, no tone) into ONE mono OGG/Opus file.
 * The concat FILTER decodes every input first, so clips of different formats or
 * sample rates still join; `aformat` pins each to 48 kHz mono (libopus's native
 * rate) before it.
 * → `{ ok: true, audio: Buffer }` | `{ ok: false, error }`. Total; the temp dir is
 * removed whatever happens.
 */
export async function encodeOpus(clips, { env = process.env, exec = run } = {}) {
  const c = config(env)
  let dir = ''
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-wa-voice-'))
    const inputs = clips.map((k, i) => {
      const file = path.join(dir, `in${i}${extFor(k.mime)}`)
      fs.writeFileSync(file, k.audio)
      return file
    })
    const out = path.join(dir, 'reply.ogg')
    const graph = `${inputs.map((_, i) => `[${i}:a]aformat=sample_rates=48000:channel_layouts=mono[a${i}]`).join(';')};${inputs.map((_, i) => `[a${i}]`).join('')}concat=n=${inputs.length}:v=0:a=1[out]`
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...inputs.flatMap((f) => ['-i', f]), '-filter_complex', graph, '-map', '[out]', '-c:a', 'libopus', '-ac', '1', '-b:a', OPUS_BITRATE, '-application', 'voip', '-f', 'ogg', out]
    const r = await exec('ffmpeg', args, { timeoutMs: c.ffmpegTimeoutMs })
    if (r.missing) return { ok: false, error: 'ffmpeg is not installed (not on PATH)' }
    if (r.code !== 0) return { ok: false, error: `ffmpeg failed${r.code === null ? '' : ` (exit ${r.code})`}: ${clip(r.stderr) || 'no output'}` }
    const audio = fs.readFileSync(out)
    if (!audio.length) return { ok: false, error: 'ffmpeg produced an empty file' }
    return { ok: true, audio }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** Is `name` an executable on PATH? (What status() can say synchronously.) */
export function onPath(name, pathEnv = process.env.PATH || '') {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue
    try {
      const p = path.join(dir, name)
      if (fs.statSync(p).isFile()) return (fs.accessSync(p, fs.constants.X_OK), true)
    } catch {}
  }
  return false
}

export function createVoiceReplies({ env = process.env, fetch: f = globalThis.fetch, log = console.error, exec = run } = {}) {
  const counters = { voiceSent: 0, voiceFallbacks: 0, ttsErrors: 0, ffmpegErrors: 0, uploadErrors: 0 } // uploadErrors: Meta refusing the upload OR the voice-note send
  const deps = { env, fetch: f, log }

  /**
   * Speak `text` to `to`. → `{ ok: true, mode: 'voice', sent: 1, parts: 1, chunks, mediaId }`
   * or, when anything on the voice path fails, the result of the plain text send
   * plus `mode: 'text'` and `voiceError`. Never throws.
   */
  async function send({ to, text }) {
    const c = config(env)
    const body = String(text ?? '').trim()
    const fallback = async (why) => {
      counters.voiceFallbacks++
      log(`[whatsapp] voice reply not sent, falling back to text: ${why}`)
      return { ...(await sendText({ to, text: body }, deps)), mode: 'text', voiceError: why }
    }
    if (body.length > c.maxVoiceChars)
      return fallback(`text is ${body.length} characters, over WHATSAPP_MAX_VOICE_CHARS (${c.maxVoiceChars}) — too long to read aloud, sent as text`)

    const pieces = chunkForSpeech(body, c.maxSpokenChars)
    const clips = []
    for (const piece of pieces) {
      const s = await synthesize(piece, deps)
      if (!s.ok) {
        counters.ttsErrors++
        return fallback(`speech synthesis: ${s.error}`)
      }
      clips.push(s)
    }
    const enc = await encodeOpus(clips, { env, exec })
    if (!enc.ok) {
      counters.ffmpegErrors++
      return fallback(enc.error)
    }
    const up = await uploadMedia({ bytes: enc.audio, mime: UPLOAD_MIME, filename: 'reply.ogg' }, deps)
    if (!up.ok) {
      counters.uploadErrors++
      return fallback(`media upload: ${up.error}`)
    }
    const sent = await sendAudio({ to, mediaId: up.id }, deps)
    if (!sent.ok) {
      counters.uploadErrors++
      return fallback(`voice-note send: ${sent.error}`)
    }
    counters.voiceSent++
    return { ok: true, mode: 'voice', sent: 1, parts: 1, chunks: pieces.length, mediaId: up.id }
  }

  return { counters, send }
}

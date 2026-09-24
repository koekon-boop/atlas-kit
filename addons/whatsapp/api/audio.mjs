/* ------------------------------------------------------------------ *
 * Voice notes: fetch the audio from Meta, hand it to the box's own
 * transcription route, report whether that route can work at all.
 *
 *   fetchAudio()        GET graph/{media-id} → {url,file_size,…} → GET url (BOTH
 *                       with the access token — the lookaside URL 401s without it)
 *   transcribe()        POST the raw bytes to core's /api/voice/transcribe over
 *                       loopback with the dashboard bearer, the same way agent.mjs
 *                       calls /api/agents/*. Nothing is imported from addons/voice:
 *                       the ROUTE is the contract, so a disabled voice addon is a
 *                       404/503 answer here, never a broken import.
 *   createSttProbe()    what status() knows about that route (via GET /api/addons)
 *
 * Every function is total: failures come back as `{ ok: false, kind, error }` and
 * the audio lives in memory only — nothing is written to disk.
 * Everything takes its `fetch` as an argument, so the tests never leave the process.
 * ------------------------------------------------------------------ */
import { config, GRAPH_BASE } from './config.mjs'

export const clip = (s, n = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

/** Best-effort: Graph's `error.message`, else the first bytes of whatever came back. */
export async function reasonOf(r) {
  const text = await r.text().catch(() => '')
  try {
    const e = JSON.parse(text)?.error
    const m = e?.message ?? e
    if (m) return clip(typeof m === 'string' ? m : JSON.stringify(m))
  } catch {}
  return clip(text) || `HTTP ${r.status}`
}

/**
 * → `{ ok: true, audio: Buffer, mime }`
 *   | `{ ok: false, kind: 'lookup'|'download'|'too-large', error }`
 * `kind: 'too-large'` is decided from `file_size` BEFORE the download starts (and
 * re-checked on the bytes, since Meta's number is only a claim).
 */
export async function fetchAudio(mediaId, { env = process.env, fetch: f = globalThis.fetch, log = console.error } = {}) {
  const c = config(env)
  const auth = { Authorization: `Bearer ${c.accessToken}` }
  const tooLarge = (n) => ({ ok: false, kind: 'too-large', error: `audio is ${n} bytes, limit ${c.maxAudioBytes}` })
  let lookup
  try {
    const r = await f(`${GRAPH_BASE}/${encodeURIComponent(mediaId)}`, { headers: auth, signal: AbortSignal.timeout(c.mediaTimeoutMs) })
    if (!r.ok) {
      const error = await reasonOf(r)
      log(`[whatsapp] media lookup failed: HTTP ${r.status}: ${error}`)
      return { ok: false, kind: 'lookup', error: `HTTP ${r.status}: ${error}` }
    }
    lookup = await r.json()
  } catch (e) {
    log(`[whatsapp] media lookup failed: ${e?.message || e}`)
    return { ok: false, kind: 'lookup', error: String(e?.message || e) }
  }
  if (Number(lookup?.file_size) > c.maxAudioBytes) return tooLarge(lookup.file_size)
  // The token is about to be sent to this URL — only over TLS.
  if (typeof lookup?.url !== 'string' || !lookup.url.startsWith('https://')) {
    log('[whatsapp] media lookup answered without an https url')
    return { ok: false, kind: 'lookup', error: 'no https download url in the media lookup' }
  }
  try {
    const r = await f(lookup.url, { headers: auth, signal: AbortSignal.timeout(c.mediaTimeoutMs) })
    if (!r.ok) {
      const error = await reasonOf(r)
      log(`[whatsapp] media download failed: HTTP ${r.status}: ${error}`)
      return { ok: false, kind: 'download', error: `HTTP ${r.status}: ${error}` }
    }
    const declared = Number(r.headers?.get?.('content-length'))
    if (declared > c.maxAudioBytes) return tooLarge(declared)
    const audio = Buffer.from(await r.arrayBuffer())
    if (audio.length > c.maxAudioBytes) return tooLarge(audio.length)
    if (!audio.length) return { ok: false, kind: 'download', error: 'empty download' }
    const type = r.headers?.get?.('content-type') || ''
    return { ok: true, audio, mime: /^audio\//i.test(type) ? type : lookup.mime_type || 'audio/ogg' }
  } catch (e) {
    log(`[whatsapp] media download failed: ${e?.message || e}`)
    return { ok: false, kind: 'download', error: String(e?.message || e) }
  }
}

/* addons/voice answers "the STT command produced no transcript" with a 503, the
 * same status as "no engine configured" — the message is the only difference. */
const EMPTY = /produced no transcript/i

/**
 * → `{ ok: true, text }`
 *   | `{ ok: false, kind: 'empty'|'unavailable'|'too-large'|'error', error }`
 * `unavailable` = the route said 503 or is not there (voice addon off, no
 * ATLAS_VOICE_STT_CMD, whisper missing) — the caller tells the sender so.
 */
export async function transcribe(audio, mime, { env = process.env, fetch: f = globalThis.fetch, log = console.error } = {}) {
  const c = config(env)
  if (!c.bearer) return { ok: false, kind: 'error', error: 'DASHBOARD_BEARER_TOKEN is not set — cannot call /api/voice/transcribe' }
  try {
    const r = await f(`${c.apiBase}/api/voice/transcribe`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.bearer}`, 'content-type': mime || 'application/octet-stream' },
      body: audio,
      signal: AbortSignal.timeout(c.transcribeTimeoutMs),
    })
    const j = await r.json().catch(() => ({}))
    if (r.ok && j?.ok !== false) {
      const text = typeof j?.text === 'string' ? j.text.trim() : ''
      return text ? { ok: true, text } : { ok: false, kind: 'empty', error: 'empty transcript' }
    }
    const error = clip(j?.error) || `HTTP ${r.status}`
    if (r.status === 503 && EMPTY.test(error)) return { ok: false, kind: 'empty', error }
    log(`[whatsapp] transcription failed: HTTP ${r.status}: ${error}`)
    const kind = r.status === 503 || r.status === 404 ? 'unavailable' : r.status === 413 ? 'too-large' : 'error'
    return { ok: false, kind, error: `HTTP ${r.status}: ${error}` }
  } catch (e) {
    log(`[whatsapp] transcription failed: ${e?.message || e}`)
    return { ok: false, kind: 'error', error: String(e?.message || e) }
  }
}

/**
 * What `status()` (which is synchronous) can say about an on-box engine of the
 * voice addon — `section` is its status key, 'stt' (voice notes in) or 'tts'
 * (voice replies out): `get()` returns the last answer and, when it is older than
 * `ttlMs`, starts a refresh in the background. The answer comes from the voice
 * addon's own status block in `GET /api/addons` — a disabled voice addon is just
 * "not enabled". That request reaches this addon's status() too; the in-flight
 * flag stops the echo from probing again.
 */
export function createVoiceProbe(section, { env = process.env, fetch: f = globalThis.fetch, ttlMs = 30000 } = {}) {
  const what = section === 'tts' ? 'speech synthesis' : 'speech recognition'
  let cached = { available: null, reason: 'not checked yet — ask again in a moment' }
  let inflight = false
  let at = 0
  async function refresh() {
    inflight = true
    try {
      const r = await f(`${config(env).apiBase}/api/addons`, { signal: AbortSignal.timeout(3000) })
      const voice = (await r.json())?.addons?.find((a) => a?.name === 'voice')
      const st = voice?.status?.[section]
      if (!voice) cached = { available: false, reason: 'the voice addon is not enabled' }
      else if (!st) cached = { available: null, reason: `the voice addon reported no ${section.toUpperCase()} status` }
      else cached = { available: st.available === true, reason: st.available ? `on-box ${what} is ready` : clip(st.reason) }
    } catch (e) {
      cached = { available: null, reason: `could not ask the API: ${clip(e?.message || e)}` }
    } finally {
      inflight = false
    }
  }
  return {
    get() {
      if (!inflight && Date.now() - at > ttlMs) {
        at = Date.now()
        refresh()
      }
      return cached
    },
  }
}

export const createSttProbe = (opts) => createVoiceProbe('stt', opts)
export const createTtsProbe = (opts) => createVoiceProbe('tts', opts)

/* ------------------------------------------------------------------ *
 * The Meta side of the bridge: webhook verification and sending.
 *
 * Everything here is pure or takes its `fetch` as an argument, so the tests
 * never leave the process and never need a real credential.
 * ------------------------------------------------------------------ */
import crypto from 'node:crypto'
import { config, GRAPH_BASE, normalizeNumber } from './config.mjs'

/** Constant-time string equality. Both sides are hashed first, so a length
 *  difference does not short-circuit and leak the secret's length. */
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest()
  const hb = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(ha, hb)
}

/** Meta's GET handshake. Returns the challenge to echo, or null to refuse.
 *  An UNSET verify token never matches — an empty string must not verify. */
export function verifyHandshake(query, env = process.env) {
  const { verifyToken } = config(env)
  const q = query || {}
  if (!verifyToken || q['hub.mode'] !== 'subscribe' || typeof q['hub.verify_token'] !== 'string') return null
  if (!safeEqual(q['hub.verify_token'], verifyToken)) return null
  return String(q['hub.challenge'] ?? '')
}

/** `X-Hub-Signature-256: sha256=<hex HMAC of the RAW body>`. No secret → false:
 *  an unverifiable webhook is refused, never waved through. */
export function verifySignature(rawBody, header, secret) {
  if (!secret || !Buffer.isBuffer(rawBody)) return false
  const m = /^sha256=([0-9a-f]{64})$/i.exec(String(header || ''))
  if (!m) return false
  const want = crypto.createHmac('sha256', secret).update(rawBody).digest()
  return crypto.timingSafeEqual(want, Buffer.from(m[1], 'hex'))
}

/** Cut one over-long block: at a line, else a word, else hard (never mid-emoji). */
function cut(block, max) {
  const out = []
  let rest = block
  while (rest.length > max) {
    let at = rest.lastIndexOf('\n', max)
    if (at < max / 2) at = rest.lastIndexOf(' ', max)
    if (at < max / 2) {
      at = max
      const c = rest.charCodeAt(at - 1)
      if (c >= 0xd800 && c <= 0xdbff) at-- // do not split a surrogate pair
    }
    out.push(rest.slice(0, at).trimEnd())
    rest = rest.slice(at).trimStart()
  }
  if (rest) out.push(rest)
  return out
}

/** WhatsApp caps a text message at 4096 chars. Split at paragraph boundaries,
 *  packing paragraphs greedily; only a single paragraph longer than the cap is
 *  cut inside (line → word → hard). */
export function splitMessage(text, max = 4096) {
  const t = String(text ?? '').trim()
  if (!t) return []
  if (t.length <= max) return [t]
  const out = []
  let cur = ''
  for (const para of t.split(/\n{2,}/).flatMap((p) => cut(p, max))) {
    if (cur && cur.length + 2 + para.length > max) {
      out.push(cur)
      cur = para
    } else cur = cur ? `${cur}\n\n${para}` : para
  }
  if (cur) out.push(cur)
  return out
}

/** Meta error 131047 = "re-engagement message": the 24-hour window is closed. */
const WINDOW_CLOSED = 131047

/** A non-2xx answer from Meta: log status + text, → `{ status, error }`. */
async function metaFailure(r, what, log) {
  const j = await r.json().catch(() => null)
  const code = j?.error?.code
  let error = j?.error?.message || `HTTP ${r.status}`
  if (code === WINDOW_CLOSED) error += ' — the 24-hour window is closed: the user has to message first'
  log(`[whatsapp] Meta rejected ${what}: HTTP ${r.status}${code ? ` (code ${code})` : ''}: ${error}`)
  return { status: r.status, error }
}

/**
 * Send `text` to `to`, split into as many messages as the cap needs.
 * Never throws: → `{ ok, sent, parts, error?, status? }`. It stops at the first
 * failure (a half-delivered answer in the right order beats a shuffled one) and
 * reports how far it got. Meta's status code and error text go to the log AND
 * into the result.
 */
export async function sendText({ to, text }, { env = process.env, fetch: f = globalThis.fetch, log = console.error } = {}) {
  const c = config(env)
  const parts = splitMessage(text)
  if (!parts.length) return { ok: false, sent: 0, parts: 0, error: 'empty text' }
  const url = `${GRAPH_BASE}/${encodeURIComponent(c.phoneNumberId)}/messages`
  let sent = 0
  for (const body of parts) {
    try {
      const r = await f(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: normalizeNumber(to), type: 'text', text: { body } }),
        signal: AbortSignal.timeout(15000),
      })
      if (!r.ok) return { ok: false, sent, parts: parts.length, ...(await metaFailure(r, 'a send', log)) }
      sent++
    } catch (e) {
      log(`[whatsapp] send failed: ${e?.message || e}`)
      return { ok: false, sent, parts: parts.length, error: String(e?.message || e) }
    }
  }
  return { ok: true, sent, parts: parts.length }
}

/**
 * Upload audio bytes to Meta's media store (multipart/form-data) → `{ ok: true, id }`
 * | `{ ok: false, status?, error }`. Never throws. The `type` field is the MIME type;
 * WhatsApp shows a file as a real voice note (waveform) only for `audio/ogg` + Opus.
 */
export async function uploadMedia({ bytes, mime, filename }, { env = process.env, fetch: f = globalThis.fetch, log = console.error } = {}) {
  const c = config(env)
  const form = new FormData()
  form.append('messaging_product', 'whatsapp')
  form.append('type', mime)
  form.append('file', new Blob([bytes], { type: mime }), filename)
  try {
    // No Content-Type header: fetch adds the multipart one, boundary included.
    const r = await f(`${GRAPH_BASE}/${encodeURIComponent(c.phoneNumberId)}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.accessToken}` },
      body: form,
      signal: AbortSignal.timeout(c.mediaTimeoutMs),
    })
    if (!r.ok) return { ok: false, ...(await metaFailure(r, 'a media upload', log)) }
    const id = (await r.json().catch(() => null))?.id
    if (typeof id !== 'string' || !id) {
      log('[whatsapp] media upload answered without an id')
      return { ok: false, error: 'Meta answered the upload without a media id' }
    }
    return { ok: true, id }
  } catch (e) {
    log(`[whatsapp] media upload failed: ${e?.message || e}`)
    return { ok: false, error: String(e?.message || e) }
  }
}

/** Send one already-uploaded audio message. Never throws → `{ ok, status?, error? }`. */
export async function sendAudio({ to, mediaId }, { env = process.env, fetch: f = globalThis.fetch, log = console.error } = {}) {
  const c = config(env)
  try {
    const r = await f(`${GRAPH_BASE}/${encodeURIComponent(c.phoneNumberId)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: normalizeNumber(to), type: 'audio', audio: { id: mediaId } }),
      signal: AbortSignal.timeout(15000),
    })
    if (!r.ok) return { ok: false, ...(await metaFailure(r, 'a voice-note send', log)) }
    return { ok: true }
  } catch (e) {
    log(`[whatsapp] voice-note send failed: ${e?.message || e}`)
    return { ok: false, error: String(e?.message || e) }
  }
}

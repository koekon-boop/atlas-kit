/* ------------------------------------------------------------------ *
 * The Telegram side of the bridge: outbound Bot API calls, plus the pure
 * text-splitting helper. (Inbound media fetch — getFile + download — lives in
 * audio.mjs, next to the loopback transcription call it feeds.)
 *
 * 🔴 THE BOT TOKEN IS IN THE URL, not a header (unlike Meta's bearer). Every
 * function here builds the URL and passes it straight to `fetch` — it is NEVER
 * put in a log line, an error message, or anything that reaches the sender.
 *
 * Everything is total (never throws) and takes its `fetch` as an argument, so
 * the tests never leave the process and never need a real bot token.
 * ------------------------------------------------------------------ */
import { apiUrl, config } from './config.mjs'

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

/** Telegram caps a text message at 4096 chars. Split at paragraph boundaries,
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

/** One Bot API call, JSON in, JSON out. Never throws.
 *  → `{ ok: true, result }` | `{ ok: false, status?, error, errorCode? }`. */
async function api(method, token, body, { fetch: f = globalThis.fetch, timeoutMs = 15000 } = {}) {
  try {
    const r = await f(apiUrl(token, method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const j = await r.json().catch(() => null)
    if (!r.ok || !j?.ok) return { ok: false, status: r.status, error: j?.description || `HTTP ${r.status}`, errorCode: j?.error_code }
    return { ok: true, status: r.status, result: j.result }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

/** A failed Bot API call: log status + description, → `{ status, error }`. */
function failure(res, what, log) {
  log(`[telegram] Telegram rejected ${what}: HTTP ${res.status ?? '?'}${res.errorCode ? ` (code ${res.errorCode})` : ''}: ${res.error}`)
  return { status: res.status, error: res.error }
}

/**
 * Send `text` to `chatId`, split into as many messages as the cap needs.
 * Never throws: → `{ ok, sent, parts, error?, status? }`. Stops at the first
 * failure (a half-delivered answer in the right order beats a shuffled one).
 */
export async function sendMessage({ chatId, text }, { env = process.env, fetch: f = globalThis.fetch, log = console.error } = {}) {
  const c = config(env)
  const parts = splitMessage(text)
  if (!parts.length) return { ok: false, sent: 0, parts: 0, error: 'empty text' }
  let sent = 0
  for (const body of parts) {
    const r = await api('sendMessage', c.botToken, { chat_id: chatId, text: body }, { fetch: f })
    if (!r.ok) return { ok: false, sent, parts: parts.length, ...failure(r, 'a send', log) }
    sent++
  }
  return { ok: true, sent, parts: parts.length }
}

/** A "typing…" hint while a slow inbound message (media, transcription) is
 *  being handled. Best-effort and silent on failure — cosmetic, never blocking. */
export async function sendChatAction({ chatId, action = 'typing' }, { env = process.env, fetch: f = globalThis.fetch, log = console.error } = {}) {
  const c = config(env)
  const r = await api('sendChatAction', c.botToken, { chat_id: chatId, action }, { fetch: f, timeoutMs: 5000 })
  if (!r.ok) log(`[telegram] sendChatAction failed: ${r.error}`)
  return r.ok
}

/**
 * Send `bytes` as a voice note — Telegram wants OGG/Opus, mono, to render the
 * round waveform bubble instead of a plain audio file, same as WhatsApp.
 * ONE call does what WhatsApp needs two for: Telegram's sendVoice takes the
 * file directly, no separate media-upload step.
 * → `{ ok: true }` | `{ ok: false, status?, error }`. Never throws.
 */
export async function sendVoice({ chatId, bytes, filename = 'reply.ogg' }, { env = process.env, fetch: f = globalThis.fetch, log = console.error } = {}) {
  const c = config(env)
  const form = new FormData()
  form.append('chat_id', String(chatId))
  form.append('voice', new Blob([bytes], { type: 'audio/ogg' }), filename)
  try {
    const r = await f(apiUrl(c.botToken, 'sendVoice'), { method: 'POST', body: form, signal: AbortSignal.timeout(c.mediaTimeoutMs) })
    const j = await r.json().catch(() => null)
    if (!r.ok || !j?.ok) return { ok: false, ...failure({ status: r.status, error: j?.description || `HTTP ${r.status}`, errorCode: j?.error_code }, 'a voice send', log) }
    return { ok: true }
  } catch (e) {
    log(`[telegram] voice send failed: ${e?.message || e}`)
    return { ok: false, error: String(e?.message || e) }
  }
}

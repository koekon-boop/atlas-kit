/* ------------------------------------------------------------------ *
 * Tell the operator what happened — point 3 of the task: Telegram when it is
 * enabled and configured, the dashboard banner otherwise. Never both for the
 * same event (Telegram already reaches the operator's phone; a banner too
 * would just be noise), and never more than once per `alarmIntervalMs` for a
 * repeating "still broken" situation (the caller passes `repeat: true` for
 * those; a one-off "renewed" / "awaiting your tap" is never throttled).
 *
 * This addon never imports addons/telegram — it calls the SAME loopback route
 * telegram's own send path uses (`POST /api/telegram/send`), exactly the
 * pattern addons/telegram itself uses for addons/voice (docs/ADDONS.md:
 * addons talk to each other over their own HTTP routes, never direct
 * imports). A telegram addon that is disabled, unconfigured, or just 404s is
 * not an error here — it is "use the banner instead".
 * ------------------------------------------------------------------ */
import { readState, saveState } from './state.mjs'
import { redact } from './security.mjs'

async function sendTelegram(text, { env, fetch: f }) {
  const bearer = env.DASHBOARD_BEARER_TOKEN
  if (!bearer) return { ok: false, reason: 'DASHBOARD_BEARER_TOKEN not set' }
  try {
    const r = await f(`http://127.0.0.1:${env.API_PORT || '3001'}/api/telegram/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10000),
    })
    if (!r.ok) return { ok: false, reason: `telegram send → HTTP ${r.status}` }
    const j = await r.json().catch(() => ({}))
    return j?.ok === false ? { ok: false, reason: j.error || 'telegram send refused' } : { ok: true }
  } catch (e) {
    return { ok: false, reason: redact(String(e?.message || e)) }
  }
}

/**
 * Send `text` to the operator. `repeat: true` marks this as a "still broken"
 * repeat announcement — throttled to at most once per `alarmIntervalMs`,
 * tracked in the state file so the throttle survives a process restart.
 * → { ok, via: 'telegram'|'banner'|'throttled' }. Never throws.
 */
export async function notifyOperator(text, { env = process.env, fetch: f = globalThis.fetch, file, repeat = false, alarmIntervalMs = 2 * 60 * 60 * 1000 } = {}) {
  const state = readState(file)
  if (repeat) {
    const last = state.lastAlarmAt ? Date.parse(state.lastAlarmAt) : 0
    if (Date.now() - last < alarmIntervalMs) return { ok: true, via: 'throttled' }
  }
  const sent = await sendTelegram(text, { env, fetch: f })
  const patch = repeat ? { lastAlarmAt: new Date().toISOString() } : {}
  if (sent.ok) {
    saveState({ ...state, ...patch }, file)
    return { ok: true, via: 'telegram' }
  }
  saveState({ ...state, ...patch, banner: { text, at: new Date().toISOString() } }, file)
  return { ok: true, via: 'banner' }
}

/**
 * Write ONLY the dashboard banner — never telegram. For when the 'dashboard'
 * channel was specifically chosen (CLAUDE_LOGIN_METHODS order): `notifyOperator`
 * always PREFERS telegram when it works, which would silently defeat an
 * operator's choice to use the dashboard channel instead. Never throws.
 */
export function writeBanner(text, { file } = {}) {
  saveState({ ...readState(file), banner: { text, at: new Date().toISOString() } }, file)
  return { ok: true, via: 'banner' }
}

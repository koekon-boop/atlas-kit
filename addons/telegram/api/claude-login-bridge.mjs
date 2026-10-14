/* ------------------------------------------------------------------ *
 * Intercepting an OAuth code meant for `addons/claude-login` — SOLANGE a
 * renewal there is actually open — instead of forwarding it to the agent like
 * an ordinary message.
 *
 * This addon never imports addons/claude-login: it calls that addon's OWN
 * HTTP routes over loopback, exactly the pattern this file's sibling
 * (audio.mjs, calling addons/voice's `/api/voice/transcribe`) already uses —
 * docs/ADDONS.md: addons talk to each other over their own routes, never a
 * direct import. `CODE_RE` below is therefore its OWN copy of the exact shape
 * `claude auth login` prints (addons/claude-login/api/security.mjs has the
 * same pattern) — an addon is self-contained, so this is parity, not a
 * shared module.
 *
 * `GET /api/claude-login/awaiting` is checked FIRST and is cheap (no bearer,
 * no side effect) — most text messages never look code-shaped at all, so the
 * common case costs one regex test and nothing else. Only when BOTH the text
 * looks code-shaped AND a renewal is actually open does this call
 * `POST /api/claude-login/code` — with the bearer this server already holds,
 * same as every other loopback call this addon makes.
 * ------------------------------------------------------------------ */
const CODE_RE = /[A-Za-z0-9_-]{20,}#[A-Za-z0-9_-]{10,}/

const REPLY_OK = (expiresAt) => `Danke! Die Claude-Anmeldung ist erneuert${expiresAt ? ` — gültig bis ${new Date(expiresAt).toLocaleString('de-DE')}` : ''}.`
const REPLY_RETRY = (left) => `Das hat nicht geklappt — versuch's noch mal (noch ${left} Versuch${left === 1 ? '' : 'e'}).`
const REPLY_FAIL = "Das hat nicht geklappt, und diese Erneuerung hat aufgegeben. Der nächste Versuch startet automatisch."
const REPLY_NOT_OPEN = 'Gerade ist keine Claude-Anmeldung-Erneuerung offen, die einen Code erwartet — ich habe das nicht weitergeleitet.'

/**
 * `{ handled: false }` when either the text is not code-shaped, or
 * addons/claude-login is disabled/unreachable, or no renewal is open — in
 * every one of those cases the caller forwards the message exactly as it
 * would have otherwise. `{ handled: true, reply }` once this function has
 * taken over: the caller must NOT also forward the message to the agent.
 * Never throws.
 */
export async function tryInterceptClaudeLoginCode(text, { env = process.env, fetch: f = globalThis.fetch, log = console.error } = {}) {
  const m = CODE_RE.exec(String(text ?? ''))
  if (!m) return { handled: false }
  const port = env.API_PORT || '3001'
  let awaiting
  try {
    const r = await f(`http://127.0.0.1:${port}/api/claude-login/awaiting`, { signal: AbortSignal.timeout(5000) })
    awaiting = r.ok ? await r.json().catch(() => null) : null
  } catch (e) {
    log(`[telegram] could not reach addons/claude-login's /awaiting route: ${e?.message || e}`)
    return { handled: false } // not enabled, or not reachable — never block the ordinary forward path
  }
  if (!awaiting?.awaiting) return { handled: false }

  const bearer = env.DASHBOARD_BEARER_TOKEN
  if (!bearer) {
    log('[telegram] a claude-login code arrived but DASHBOARD_BEARER_TOKEN is not set — cannot submit it')
    return { handled: true, reply: REPLY_NOT_OPEN }
  }
  try {
    const r = await f(`http://127.0.0.1:${port}/api/claude-login/code`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ code: m[0], source: 'telegram' }),
      signal: AbortSignal.timeout(35000), // confirmLogin's own poll can run up to ~30s
    })
    const j = await r.json().catch(() => ({}))
    if (j?.ok) return { handled: true, reply: REPLY_OK(j.expiresAt) }
    if (Number.isInteger(j?.attemptsLeft)) return { handled: true, reply: REPLY_RETRY(j.attemptsLeft) }
    return { handled: true, reply: REPLY_FAIL }
  } catch (e) {
    log(`[telegram] submitting a claude-login code failed: ${e?.message || e}`)
    return { handled: true, reply: REPLY_FAIL }
  }
}

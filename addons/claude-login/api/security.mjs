/* ------------------------------------------------------------------ *
 * The one rule this whole addon is built around: a code or a token NEVER
 * reaches a log line, a stored state file, or an HTTP response.
 *
 * `CODE_RE` is the exact shape `claude auth login` prints at
 * platform.claude.com/oauth/code/callback — the same pattern the box's
 * reference scripts (claude-login-erneuern.sh, claude-login-waechter.py)
 * already match on. `redact()` is the belt: every free-text string that MIGHT
 * contain one (a tmux pane capture, an exec stderr, a thrown error message)
 * is run through this before it is logged or persisted, so a code or a bearer
 * token that leaked into stdout/stderr never leaks a second time into this
 * addon's own bookkeeping.
 * ------------------------------------------------------------------ */

/** An OAuth code as `claude auth login` shows it: "<state>#<code>", each half
 *  long enough that a false positive on ordinary text is vanishingly rare. */
export const CODE_RE = /[A-Za-z0-9_-]{20,}#[A-Za-z0-9_-]{10,}/g

/** Strip anything shaped like a code (or a bearer token) out of free text
 *  before it is ever logged or stored. Idempotent, never throws. */
export function redact(text) {
  const s = String(text ?? '')
  return s.replace(CODE_RE, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
}

/** Does this text contain something shaped like a code? (Without capturing
 *  it — callers that need the code itself use `extractCode`.) Resets
 *  `lastIndex` first: CODE_RE is shared and `.test()` is stateful across calls. */
export function looksLikeCode(text) {
  CODE_RE.lastIndex = 0
  return CODE_RE.test(String(text ?? ''))
}

/** The first code-shaped substring, or null. Reset `lastIndex` first: CODE_RE
 *  is a shared global-flagged regex and a stateful `.test()`/`.exec()` call
 *  elsewhere would otherwise make this skip or miss matches. */
export function extractCode(text) {
  CODE_RE.lastIndex = 0
  const m = CODE_RE.exec(String(text ?? ''))
  return m ? m[0] : null
}

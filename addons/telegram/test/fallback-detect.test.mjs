/* ------------------------------------------------------------------ *
 * addons/telegram/api/fallback-detect.mjs — pure detection off a FAKE
 * transcript tail (no real filesystem: `tail` is injected as a plain
 * function returning an array of raw lines, exactly like tailLines() would).
 *
 * What this pins:
 *   · no error at all → not blocked
 *   · each of the three KNOWN blocking codes (rate_limit, authentication_failed,
 *     billing_error) blocks immediately, regardless of age
 *   · any OTHER isApiErrorMessage line is NOT yet blocked while fresh, but IS
 *     once it has been the last line for ≥ staleMs
 *   · an error followed by a later, normal reply is no longer blocked — the
 *     error is simply no longer the LAST entry
 *   · the reset-time text is extracted and parsed best-effort (UTC and a
 *     named zone), and stays null for wording this cannot parse
 *
 * Run: node --test addons/telegram/test/fallback-detect.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectBlocked, extractResetText, parseResetAt } from '../api/fallback-detect.mjs'

const STALE_MS = 3 * 60 * 1000

const errLine = ({ error = 'rate_limit', apiErrorStatus, timestamp, text = "You've hit your weekly limit · resets 8pm (UTC)" } = {}) =>
  JSON.stringify({ isApiErrorMessage: true, error, ...(apiErrorStatus ? { apiErrorStatus } : {}), timestamp, message: { content: text } })

const normalLine = (text, timestamp) => JSON.stringify({ type: 'assistant', timestamp, message: { content: [{ type: 'text', text }] } })

const fixed = (lines) => () => lines

const base = { worktree: '/workspace/vault', claudeSessionId: 's-1', staleMs: STALE_MS }

test('no api-error line at all → not blocked', () => {
  const now = Date.now()
  const r = detectBlocked({ ...base, now, tail: fixed([normalLine('alles gut', new Date(now).toISOString())]) })
  assert.deepEqual(r, { blocked: false })
})

test('no readable transcript (tail returns null) → not blocked, never throws', () => {
  const r = detectBlocked({ ...base, now: Date.now(), tail: () => null })
  assert.deepEqual(r, { blocked: false })
})

test('missing worktree/claudeSessionId → not blocked, never throws', () => {
  assert.deepEqual(detectBlocked({ staleMs: STALE_MS }), { blocked: false })
})

for (const error of ['rate_limit', 'authentication_failed', 'billing_error']) {
  test(`${error}: blocks IMMEDIATELY, even one second old`, () => {
    const now = Date.now()
    const line = errLine({ error, timestamp: new Date(now - 1000).toISOString() })
    const r = detectBlocked({ ...base, now, tail: fixed([line]) })
    assert.equal(r.blocked, true)
    assert.equal(r.reason, error)
  })
}

test('rate_limit carries apiErrorStatus and the reset text through', () => {
  const now = Date.now()
  const line = errLine({ error: 'rate_limit', apiErrorStatus: 429, timestamp: new Date(now).toISOString() })
  const r = detectBlocked({ ...base, now, tail: fixed([line]) })
  assert.equal(r.apiErrorStatus, 429)
  assert.equal(r.resetText, 'resets 8pm (UTC)')
})

test('an OTHER api-error code is not yet blocked while fresh', () => {
  const now = Date.now()
  const line = errLine({ error: 'overloaded_error', timestamp: new Date(now).toISOString(), text: 'Overloaded, try again' })
  const r = detectBlocked({ ...base, now, tail: fixed([line]) })
  assert.equal(r.blocked, false)
  assert.equal(r.reason, 'overloaded_error', 'the reason is reported even though it is not (yet) blocking')
})

test('an OTHER api-error code DOES block once it has been the last line for ≥ staleMs', () => {
  const now = Date.now()
  const line = errLine({ error: 'overloaded_error', timestamp: new Date(now - STALE_MS - 1000).toISOString(), text: 'Overloaded, try again' })
  const r = detectBlocked({ ...base, now, tail: fixed([line]) })
  assert.equal(r.blocked, true)
  assert.equal(r.reason, 'overloaded_error')
})

test('an error, then a later normal reply → not blocked (the error is no longer the LAST line)', () => {
  const now = Date.now()
  const line1 = errLine({ error: 'rate_limit', timestamp: new Date(now - 10 * 60000).toISOString() })
  const line2 = normalLine('wieder da', new Date(now).toISOString())
  const r = detectBlocked({ ...base, now, tail: fixed([line1, line2]) })
  assert.equal(r.blocked, false)
})

test('blank lines and a partial (unparseable) tail-cut line are skipped — the real last line still wins', () => {
  const now = Date.now()
  const line = errLine({ error: 'authentication_failed', timestamp: new Date(now).toISOString(), text: 'Login expired · Please run /login' })
  const r = detectBlocked({ ...base, now, tail: fixed(['{"timestamp":"cut off mid-rec', '', line, '']) })
  assert.equal(r.blocked, true)
  assert.equal(r.reason, 'authentication_failed')
})

/* --- reset-time extraction + best-effort parsing ----------------------- */

test('extractResetText pulls the "resets … (…)" clause out of the raw line', () => {
  assert.equal(extractResetText(errLine({ error: 'rate_limit' })), 'resets 8pm (UTC)')
  assert.equal(extractResetText(errLine({ error: 'rate_limit', text: 'weekly limit · resets 3am (Europe/Berlin)' })), 'resets 3am (Europe/Berlin)')
  assert.equal(extractResetText('no reset info here'), null)
})

test('parseResetAt: UTC, same day still ahead', () => {
  const now = Date.parse('2026-11-02T10:00:00Z')
  assert.equal(parseResetAt('resets 8pm (UTC)', now), Date.parse('2026-11-02T20:00:00Z'))
})

test('parseResetAt: UTC, already past today → rolls to tomorrow', () => {
  const now = Date.parse('2026-11-02T21:00:00Z')
  assert.equal(parseResetAt('resets 8pm (UTC)', now), Date.parse('2026-11-03T20:00:00Z'))
})

test('parseResetAt: a named zone (Europe/Berlin, UTC+1 in November)', () => {
  const now = Date.parse('2026-11-02T10:00:00Z')
  assert.equal(parseResetAt('resets 3am (Europe/Berlin)', now), Date.parse('2026-11-03T02:00:00Z'))
})

test('parseResetAt: wording it cannot parse (an explicit date, an unknown zone) → null, never throws', () => {
  assert.equal(parseResetAt('resets Nov 5, 8am (UTC)', Date.now()), null)
  assert.equal(parseResetAt('resets 8pm (Nonexistent/Zone)', Date.now()), null)
  assert.equal(parseResetAt(null, Date.now()), null)
})

/* --- cutoffAt: the lost-message guard's replay boundary ----------------- */

test('cutoffAt is the timestamp of the last successful assistant turn BEFORE the error', () => {
  const now = Date.now()
  const goodAt = now - 5 * 60000
  const lines = [normalLine('alles ok bisher', new Date(goodAt).toISOString()), errLine({ error: 'rate_limit', timestamp: new Date(now).toISOString() })]
  const r = detectBlocked({ ...base, now, tail: fixed(lines) })
  assert.equal(r.cutoffAt, goodAt)
})

test('cutoffAt falls back to (error time - 2 min) when no successful turn is found in the tail', () => {
  const now = Date.now()
  const r = detectBlocked({ ...base, now, tail: fixed([errLine({ error: 'authentication_failed', timestamp: new Date(now).toISOString() })]) })
  assert.equal(r.cutoffAt, now - 2 * 60000)
})

test('cutoffAt ignores an unparseable timestamp on an otherwise-good earlier turn (falls back to the 2-min default)', () => {
  const now = Date.now()
  const lines = [
    JSON.stringify({ type: 'assistant', timestamp: 'not-a-date', message: { content: [{ type: 'text', text: 'x' }] } }),
    errLine({ error: 'rate_limit', timestamp: new Date(now).toISOString() }),
  ]
  const r = detectBlocked({ ...base, now, tail: fixed(lines) })
  assert.equal(r.cutoffAt, now - 2 * 60000)
})

/* --- the shapes seen on this box on 24./25.11.2026 (fields as in the real lines) */

test('REGRESSION (25.11.): an OpenRouter 402 out-of-credits line (error "unknown") blocks IMMEDIATELY as billing_error', () => {
  const now = Date.now()
  const line = JSON.stringify({
    type: 'assistant', isApiErrorMessage: true, error: 'unknown', apiErrorStatus: 402, apiErrorType: 'billing_error', resendCannotCure: true,
    timestamp: new Date(now - 1000).toISOString(),
    message: { content: 'API Error: 402 This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle' },
  })
  const r = detectBlocked({ ...base, now, tail: fixed([line]) })
  assert.equal(r.blocked, true)
  assert.equal(r.reason, 'billing_error')
  assert.equal(r.transient, false)
})

test('the older "Insufficient credits" wording (no apiErrorType) is billing_error too', () => {
  const now = Date.now()
  const line = errLine({ error: 'unknown', apiErrorStatus: 402, timestamp: new Date(now).toISOString(), text: 'API Error: 402 Insufficient credits. Add more using https://openrouter.ai/settings/credits' })
  assert.equal(detectBlocked({ ...base, now, tail: fixed([line]) }).reason, 'billing_error')
})

test('REGRESSION (24.11.): a safety refusal ("Start a new session", general_harms) blocks IMMEDIATELY as "refused"', () => {
  const now = Date.now()
  const line = JSON.stringify({
    type: 'assistant', isApiErrorMessage: true, error: 'invalid_request', refusingModel: 'claude-opus-4-8',
    timestamp: new Date(now - 1000).toISOString(),
    message: { content: "API Error: Opus 4.8 can't help with this. Start a new session to continue.\n\nDetails: `[general_harms]`" },
  })
  const r = detectBlocked({ ...base, now, tail: fixed([line]) })
  assert.equal(r.blocked, true)
  assert.equal(r.reason, 'refused')
  assert.equal(r.transient, false)
})

test('"Connection lost mid-response" (server_error) is TRANSIENT: not blocked while fresh, blocked — still transient — once stale', () => {
  const now = Date.now()
  const line = (age) => errLine({ error: 'server_error', timestamp: new Date(now - age).toISOString(), text: 'API Error: Connection lost mid-response. The response above may be incomplete.' })
  const fresh = detectBlocked({ ...base, now, tail: fixed([line(60000)]) })
  assert.equal(fresh.blocked, false)
  assert.equal(fresh.transient, true)
  const stale = detectBlocked({ ...base, now, tail: fixed([line(STALE_MS + 1000)]) })
  assert.equal(stale.blocked, true)
  assert.equal(stale.transient, true)
  assert.equal(stale.reason, 'server_error')
})

/* ------------------------------------------------------------------ *
 * Is the standing Telegram session BLOCKED — unable to reach the Anthropic
 * API at all (an expired login, a rate limit, a billing error) — right now?
 *
 * Replies are pushed, never scraped (the whole addon's rule — see agent.mjs):
 * this reads ONLY the newest transcript entry, and only to check one flag,
 * `isApiErrorMessage`. It never looks at what the session or the operator
 * actually said. core's chat-history reconstruction (agent-history.mjs) is
 * not usable here — it treats every line as ordinary user/assistant text and
 * drops exactly the fields this needs — so this reads the raw `.jsonl` tail
 * directly, with the SAME core primitives subagent-scan.mjs already exports
 * for that (`transcriptPath`, `tailLines`): projectKey(worktree)/<claudeSessionId>.jsonl,
 * last `TAIL_BYTES` bytes only. Never the whole file, never more than one
 * tail-read per check.
 *
 * Detection rule (see the task's own note on what a live transcript showed):
 * the LAST entry is an `isApiErrorMessage: true` line, and EITHER its `error`
 * is one of the three known-blocking codes (rate_limit, authentication_failed,
 * billing_error — blocks immediately, any age) OR it is some OTHER
 * isApiErrorMessage line that has been the last entry for at least `staleMs`
 * (a transient blip must not flip the whole channel over). A normal reply
 * landing after an error — the common, non-blocked case — simply makes the
 * error no longer the LAST entry, so this reads `blocked: false` again with
 * no extra bookkeeping needed.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import { tailLines, transcriptPath } from '../../../api/src/subagent-scan.mjs'

export const KNOWN_BLOCKING_ERRORS = new Set(['rate_limit', 'authentication_failed', 'billing_error'])

// The newest entry only is ever inspected — this is plenty of room even for a
// long error line plus whatever partial line precedes it in the tail cut.
const TAIL_BYTES = 20_000

/** The last PARSEABLE JSON line of a tail-read chunk — append-only file, so
 *  "last line" is the newest entry. Skips blank lines and the tail's own
 *  partial first line (cut mid-record). → { rec, raw } | null. */
export function lastEntry(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i].trim()
    if (!raw) continue
    try {
      return { rec: JSON.parse(raw), raw }
    } catch {
      continue
    }
  }
  return null
}

// "resets 8pm (UTC)" / "resets 3am (Europe/Berlin)" — the one piece of an error
// text worth carrying forward. Anthropic's occasional explicit-date wording
// ("resets Nov 5, 8am (UTC)") is NOT parsed into a time below (skipped: rare,
// and the unconditional probe-interval retry already covers it safely — add a
// case to parseResetAt if a real example needs the precision).
const RESET_RE = /resets\s+[^"\\(]*\([^)]*\)/i
export function extractResetText(raw) {
  const m = RESET_RE.exec(String(raw || ''))
  return m ? m[0].trim() : null
}

// Anchored to the WHOLE "resets …" clause — not a bare search — so a clause
// carrying an explicit date ("resets Nov 5, 8am (UTC)") never false-matches
// on the time mentioned inside it; it must fall through to null below.
const HOUR_RE = /^resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)$/i

/** Best-effort: the next UTC instant the named wall-clock time occurs in the
 *  named zone, at or after `now` (never more than 24h out). → ms epoch, or
 *  null for anything unparseable (an explicit date, an Intl-unknown zone) —
 *  the caller's probe-interval fallback stays correct either way, just less
 *  prompt. Pure given `now`. */
export function parseResetAt(resetText, now = Date.now()) {
  const m = HOUR_RE.exec(String(resetText || '').trim())
  if (!m) return null
  let hour = Number(m[1]) % 12
  if (/pm/i.test(m[3])) hour += 12
  const minute = Number(m[2] || 0)
  let parts
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: m[4].trim(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(
      new Date(now),
    )
  } catch {
    return null // not a zone name Intl recognizes
  }
  const get = (t) => Number(parts.find((p) => p.type === t)?.value)
  const curH = get('hour')
  const curM = get('minute')
  if (!Number.isFinite(curH) || !Number.isFinite(curM)) return null
  const diffMin = (((hour * 60 + minute - (curH * 60 + curM)) % 1440) + 1440) % 1440
  return now + diffMin * 60000
}

/**
 * → { blocked, reason, resetText, resetAt, since, apiErrorStatus }. `reason` is
 * the error code ('rate_limit'/'authentication_failed'/'billing_error'/'other')
 * whenever the last entry IS an api-error line, even if `blocked` is still
 * false (a fresh "other" error, not yet stale) — so a caller can show it
 * without re-deciding staleness itself. `{ blocked: false }` alone (no other
 * keys) when the last entry is not an api error, or the transcript can't be
 * read at all. Never throws. Deps are injectable for hermetic tests.
 */
export function detectBlocked({
  worktree,
  claudeSessionId,
  now = Date.now(),
  staleMs,
  statFile = (p) => fs.statSync(p),
  tail = tailLines,
  buildPath = transcriptPath,
} = {}) {
  if (!worktree || !claudeSessionId) return { blocked: false }
  const file = buildPath(worktree, claudeSessionId)
  const lines = tail(file, TAIL_BYTES)
  if (!lines) return { blocked: false }
  const entry = lastEntry(lines)
  if (!entry || entry.rec?.isApiErrorMessage !== true) return { blocked: false }

  const error = typeof entry.rec.error === 'string' ? entry.rec.error : null
  let ts = Date.parse(entry.rec.timestamp)
  if (!Number.isFinite(ts)) {
    try {
      ts = statFile(file).mtimeMs
    } catch {
      ts = now
    }
  }
  const known = !!(error && KNOWN_BLOCKING_ERRORS.has(error))
  const resetText = extractResetText(entry.raw)
  return {
    blocked: known || now - ts >= staleMs,
    reason: error || 'other',
    resetText,
    resetAt: resetText ? parseResetAt(resetText, now) : null,
    since: Number.isFinite(ts) ? ts : null,
    apiErrorStatus: typeof entry.rec.apiErrorStatus === 'number' ? entry.rec.apiErrorStatus : null,
  }
}

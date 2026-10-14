/* ------------------------------------------------------------------ *
 * The addon's bookkeeping file — never the vault, never the repo, never a
 * credential. What is EVER stored here: timestamps, which channel, ok/error
 * TEXT (always run through `redact()` first), and the OAuth authorize URL
 * (not a secret — the same URL a notification already sends in plain text).
 * The code and the token itself never touch this file.
 *
 * tmp + rename, like every other addon's state file.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import path from 'node:path'
import { redact } from './security.mjs'

const DEFAULT = () => ({
  lastCheckAt: null,
  lastExpiryMs: null,
  lastAttempt: null, // { at, trigger: 'preventive'|'broken', via, ok, result?, error? }
  awaiting: null, // { via: 'telegram'|'dashboard', url, startedAt, expiresAt, attemptId }
  lastAlarmAt: null,
  counters: { checks: 0, attempts: 0, renewed: 0, failed: 0, codesSubmitted: 0, codesRejected: 0 },
})

/** Never throws: an absent or unreadable file is just the first-run state. */
export function readState(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return j && typeof j === 'object' && !Array.isArray(j) ? { ...DEFAULT(), ...j, counters: { ...DEFAULT().counters, ...j.counters } } : DEFAULT()
  } catch {
    return DEFAULT()
  }
}

/** Returns false (loudly, never throws) rather than losing the process over a
 *  write failure — a lost bookmark costs one re-check, not a crash. */
export function saveState(state, file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 })
    fs.renameSync(tmp, file)
    return true
  } catch (e) {
    console.error(`[claude-login] could not write the state file (${file}): ${e?.message || e}`)
    return false
  }
}

/** Sanitize an attempt record before it is ever persisted — belt alongside
 *  every call site already being careful what it hands in. */
export function recordAttempt(state, { trigger, via, ok, result, error }) {
  return {
    ...state,
    lastAttempt: { at: new Date().toISOString(), trigger, via, ok, result: result ? redact(result) : undefined, error: error ? redact(error) : undefined },
    counters: { ...state.counters, attempts: state.counters.attempts + 1, ...(ok ? { renewed: state.counters.renewed + 1 } : { failed: state.counters.failed + 1 }) },
  }
}

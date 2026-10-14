/* ------------------------------------------------------------------ *
 * Reads `~/.claude/.credentials.json` — never its token values, only the ONE
 * field this addon acts on: `claudeAiOauth.refreshTokenExpiresAt` (ms epoch).
 *
 * Everything here is pure + injectable (`readFile`/`statFile`) so the tests
 * never touch the real file. Never throws.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'

/** → { ok, expiresAt?, mtimeMs?, error? }. `expiresAt` is `refreshTokenExpiresAt`
 *  (ms epoch) when present; the token value itself is never read into memory
 *  here beyond the one JSON.parse (and never returned, never logged). */
export function readCredentials(file, { readFile = (p) => fs.readFileSync(p, 'utf-8'), statFile = (p) => fs.statSync(p) } = {}) {
  let mtimeMs
  try {
    mtimeMs = statFile(file).mtimeMs
  } catch (e) {
    return { ok: false, error: `no credentials file: ${e?.code || e?.message || e}` }
  }
  try {
    const j = JSON.parse(readFile(file))
    const expiresAt = j?.claudeAiOauth?.refreshTokenExpiresAt
    if (!Number.isFinite(expiresAt)) return { ok: false, mtimeMs, error: 'credentials file has no refreshTokenExpiresAt' }
    return { ok: true, expiresAt, mtimeMs }
  } catch (e) {
    return { ok: false, mtimeMs, error: `could not parse credentials file: ${e?.message || e}` }
  }
}

/** Milliseconds left on the refresh token, or null when unknown. May be negative. */
export const msUntilExpiry = (cred, now = Date.now()) => (cred.ok ? cred.expiresAt - now : null)

/** "11.11.2026 10:21" in a fixed, human timezone — what the operator reads in
 *  a notification. Falls back to UTC if the named zone is unavailable. */
export function formatExpiry(ms, timeZone = 'Europe/Berlin') {
  try {
    const parts = new Intl.DateTimeFormat('de-DE', {
      timeZone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(ms))
    return parts
  } catch {
    return new Date(ms).toISOString()
  }
}

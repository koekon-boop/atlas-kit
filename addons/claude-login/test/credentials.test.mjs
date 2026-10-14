/* ------------------------------------------------------------------ *
 * addons/claude-login — credentials.mjs: reading refreshTokenExpiresAt out of
 * ~/.claude/.credentials.json without ever touching the token value itself.
 * Hermetic: readFile/statFile are injected, no real file is ever read.
 * Run: node --test addons/claude-login/test/credentials.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatExpiry, msUntilExpiry, readCredentials } from '../api/credentials.mjs'

function fakeFs({ content, mtimeMs = 1000, statThrows = false } = {}) {
  return {
    statFile: () => {
      if (statThrows) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return { mtimeMs }
    },
    readFile: () => content,
  }
}

test('reads refreshTokenExpiresAt and the file mtime', () => {
  const expiresAt = Date.now() + 10_000
  const r = readCredentials('/fake', fakeFs({ content: JSON.stringify({ claudeAiOauth: { refreshTokenExpiresAt: expiresAt, accessToken: 'SECRET-NEVER-READ-BACK' } }), mtimeMs: 42 }))
  assert.equal(r.ok, true)
  assert.equal(r.expiresAt, expiresAt)
  assert.equal(r.mtimeMs, 42)
  // The whole point: the function's answer never carries the token value.
  assert.ok(!JSON.stringify(r).includes('SECRET-NEVER-READ-BACK'))
})

test('a missing file is a clean { ok: false }, never a throw', () => {
  const r = readCredentials('/nope', fakeFs({ statThrows: true }))
  assert.equal(r.ok, false)
  assert.match(r.error, /no credentials file/)
})

test('a malformed JSON file is a clean { ok: false }', () => {
  const r = readCredentials('/fake', fakeFs({ content: 'not json' }))
  assert.equal(r.ok, false)
  assert.match(r.error, /could not parse/)
})

test('a file missing refreshTokenExpiresAt is a clean { ok: false }', () => {
  const r = readCredentials('/fake', fakeFs({ content: JSON.stringify({ claudeAiOauth: {} }) }))
  assert.equal(r.ok, false)
  assert.match(r.error, /refreshTokenExpiresAt/)
})

test('msUntilExpiry is the difference, and null when the read failed', () => {
  const now = 1_000_000
  assert.equal(msUntilExpiry({ ok: true, expiresAt: now + 5000 }, now), 5000)
  assert.equal(msUntilExpiry({ ok: false }, now), null)
})

test('formatExpiry renders a human date and never throws on a bad timezone', () => {
  const s = formatExpiry(Date.UTC(2026, 10, 11, 10, 21), 'Europe/Berlin')
  assert.match(s, /11\.11\.2026/)
  assert.doesNotThrow(() => formatExpiry(Date.now(), 'Not/AZone'))
})

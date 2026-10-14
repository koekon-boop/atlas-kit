/* ------------------------------------------------------------------ *
 * addons/claude-login — state.mjs: the bookkeeping file, and that
 * recordAttempt() redacts any code-shaped text BEFORE it is ever persisted.
 * Run: node --test addons/claude-login/test/state.test.mjs
 * ------------------------------------------------------------------ */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { readState, recordAttempt, saveState } from '../api/state.mjs'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-login-state-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))
const freshFile = () => path.join(TMP, `${crypto.randomUUID()}.json`)
const CODE = 'aAbBcCdDeEfFgGhHiIjJ#1234567890ab'

test('readState on a missing file returns the default shape, never throws', () => {
  const s = readState(path.join(TMP, 'nope.json'))
  assert.deepEqual(s.counters, { checks: 0, attempts: 0, renewed: 0, failed: 0, codesSubmitted: 0, codesRejected: 0 })
  assert.equal(s.awaiting, null)
})

test('saveState then readState round-trips, 0600, tmp+rename (no partial file visible)', () => {
  const file = freshFile()
  assert.equal(saveState({ ...readState(file), lastCheckAt: '2026-01-01T00:00:00Z' }, file), true)
  assert.equal(readState(file).lastCheckAt, '2026-01-01T00:00:00Z')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.ok(!fs.existsSync(`${file}.tmp-${process.pid}`))
})

test('recordAttempt redacts a code-shaped `result`/`error` BEFORE it is stored', () => {
  const s0 = readState(freshFile())
  const s1 = recordAttempt(s0, { trigger: 'broken', via: 'telegram', ok: false, error: `tmux said: ${CODE} was rejected` })
  assert.ok(!s1.lastAttempt.error.includes(CODE))
  assert.ok(s1.lastAttempt.error.includes('[redacted]'))
})

test('recordAttempt bumps the right counter', () => {
  let s = readState(freshFile())
  s = recordAttempt(s, { trigger: 'broken', via: 'telegram', ok: true, result: 'fine' })
  assert.equal(s.counters.attempts, 1)
  assert.equal(s.counters.renewed, 1)
  assert.equal(s.counters.failed, 0)
  s = recordAttempt(s, { trigger: 'broken', via: 'telegram', ok: false, error: 'nope' })
  assert.equal(s.counters.attempts, 2)
  assert.equal(s.counters.failed, 1)
})

test('saveState never throws on an unwritable directory — returns false instead', () => {
  // A regular FILE where a directory component is expected: mkdirSync fails
  // fast with ENOTDIR, unlike a path that might hang resolving (e.g. /proc).
  const notADir = path.join(TMP, 'this-is-a-file')
  fs.writeFileSync(notADir, 'x')
  const r = saveState({ a: 1 }, path.join(notADir, 'sub', 'state.json'))
  assert.equal(r, false)
})

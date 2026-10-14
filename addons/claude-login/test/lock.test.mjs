/* ------------------------------------------------------------------ *
 * addons/claude-login — lock.mjs: the pidfile mutex behind both the watcher
 * singleton and "never two renewal attempts at once".
 * Run: node --test addons/claude-login/test/lock.test.mjs
 * ------------------------------------------------------------------ */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { claimLock, lockHeld, releaseLock } from '../api/lock.mjs'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-login-lock-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))
const lockFile = () => path.join(TMP, `lock-${Math.random().toString(36).slice(2)}.json`)

test('claims an unheld lock', () => {
  const f = lockFile()
  assert.equal(claimLock(f, process.pid), true) // a live pid — lockHeld checks liveness, not just presence
  assert.equal(lockHeld(f), true)
})

test('a second pid cannot claim a lock already held by a LIVE pid', () => {
  const f = lockFile()
  assert.equal(claimLock(f, process.pid), true) // this process's own pid — definitely alive
  assert.equal(claimLock(f, process.pid + 1), false)
})

test('a lock held by a DEAD pid is reclaimed (stale lock)', () => {
  const f = lockFile()
  // A pid essentially guaranteed not to be alive on this box.
  fs.writeFileSync(f, JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }))
  assert.equal(claimLock(f, process.pid), true)
  assert.equal(lockHeld(f), true)
})

test('releaseLock only releases the lock if the SAME pid still holds it', () => {
  const f = lockFile()
  claimLock(f, process.pid)
  releaseLock(f, process.pid + 12345) // a different pid — must not steal the release
  assert.equal(lockHeld(f), true)
  releaseLock(f, process.pid)
  assert.equal(lockHeld(f), false)
})

test('lockHeld on a file that does not exist is false, never throws', () => {
  assert.equal(lockHeld(path.join(TMP, 'nope.json')), false)
})

/* ------------------------------------------------------------------ *
 * addons/claude-login — watcher.mjs: the singleton-guarded interval. Drives
 * `createTick()` directly (no real setInterval/timers), exactly the split
 * addons/telegram's poller.mjs uses for pollOnce/createPoller.
 * Run: node --test addons/claude-login/test/watcher.test.mjs
 * ------------------------------------------------------------------ */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createTick, createWatcher } from '../api/watcher.mjs'
import { watchLockFile } from '../api/config.mjs'
import { lockHeld } from '../api/lock.mjs'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-login-watcher-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

function envFor(stateFile, extra = {}) {
  return { CLAUDE_LOGIN_STATE_FILE: stateFile, CLAUDE_LOGIN_CREDENTIALS_FILE: path.join(TMP, 'no-creds.json'), CLAUDE_LOGIN_PROJECTS_DIR: path.join(TMP, 'no-projects'), ...extra }
}
// The watch-lock path is DERIVED from the state file's own directory
// (config.mjs's watchLockFile) — so each test needs its OWN directory, not
// just its own filename, or every test in this file would fight over one
// shared lock left behind by an earlier test that never released it.
const freshState = () => {
  const dir = fs.mkdtempSync(path.join(TMP, `${crypto.randomUUID()}-`))
  return path.join(dir, 'state.json')
}

test('CLAUDE_LOGIN_WATCH=0 disables the watcher outright', () => {
  const w = createWatcher({ env: { CLAUDE_LOGIN_WATCH: '0' } })
  assert.deepEqual(w.status(), { owner: false, enabled: false })
  w.stop() // must not throw
})

test('a lock already held by another LIVE pid is never won by a second tick', async () => {
  const stateFile = freshState()
  const env = envFor(stateFile)
  const exec = async () => ({ code: 0, stdout: '' })
  // Simulate another process already owning the lock: pid 1 (init) is about
  // as reliably "alive" as a pid gets without actually spawning a process,
  // and it is never this test's own pid.
  fs.writeFileSync(watchLockFile(env), JSON.stringify({ pid: 1, startedAt: new Date().toISOString() }))
  const a = createTick({ env, exec, file: stateFile, log: () => {} })
  const r = await a.tick()
  assert.equal(r.owner, false)
  assert.equal(a.isOwner(), false)
})

test('the first tick claims an UNHELD lock', async () => {
  const stateFile = freshState()
  const env = envFor(stateFile)
  const exec = async () => ({ code: 0, stdout: '' })
  const a = createTick({ env, exec, file: stateFile, log: () => {} })
  const r = await a.tick()
  assert.equal(r.owner, true)
  assert.equal(a.isOwner(), true)
  assert.ok(lockHeld(watchLockFile(env)))
})

test('a process that already owns the lock keeps ticking without re-claiming it every time', async () => {
  const stateFile = freshState()
  const env = envFor(stateFile)
  const exec = async () => ({ code: 0, stdout: '' })
  const a = createTick({ env, exec, file: stateFile, log: () => {} })
  const r1 = await a.tick()
  const r2 = await a.tick()
  const r3 = await a.tick()
  assert.ok(r1.owner && r2.owner && r3.owner)
  assert.equal(a.isOwner(), true)
})

test('a tick never throws out, even when checkOnce itself would misbehave', async () => {
  // An invalid FILE NAME (embedded NUL) under a still-valid, still-absolute
  // directory: makes the underlying fs calls fail the way we want to test,
  // without collapsing the derived watch-lock path to a RELATIVE one (bare
  // `path.dirname('\0bad-path')` — no slash at all — resolves to '.', which
  // would claim a lock in whatever the CWD happens to be).
  const badFile = path.join(fs.mkdtempSync(path.join(TMP, 'bad-')), '\u0000bad-path')
  const env = envFor(badFile)
  const exec = async () => ({ code: 0, stdout: '' })
  const a = createTick({ env, exec, file: badFile, log: () => {} })
  const r = await a.tick()
  assert.equal(typeof r, 'object')
  assert.ok('owner' in r)
})

test('createWatcher never touches the filesystem at construction time (no lock claimed before the first tick)', () => {
  const stateFile = freshState()
  const env = envFor(stateFile, { CLAUDE_LOGIN_CHECK_INTERVAL_MS: '3600000' })
  const w = createWatcher({ env, exec: async () => ({ code: 0, stdout: '' }), file: stateFile })
  assert.equal(lockHeld(watchLockFile(env)), false, 'constructing the watcher must not claim the lock')
  assert.equal(w.status().owner, false)
  w.stop()
})

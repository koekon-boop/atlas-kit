/* ------------------------------------------------------------------ *
 * addons/claude-login — renew.mjs: the whole renewal state machine, over a
 * stubbed `exec` (tmux + ssh) and a stubbed `fetch` (the telegram loopback
 * route). Real temp files for the credentials file, the projects dir (auth
 * failures) and the addon's own state file — never the real box.
 *
 * Pins the task's acceptance criteria: method order + fallback, the lock
 * against parallel renewals, and that a code never appears in anything this
 * addon logs or persists.
 * Run: node --test addons/claude-login/test/renew.test.mjs
 * ------------------------------------------------------------------ */
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { resetClaudeBinCache } from '../../../api/src/claude-bin.mjs'
import { checkOnce, expireStaleAwaiting, startAttempt, submitCode } from '../api/renew.mjs'
import { readState } from '../api/state.mjs'
import { claimLock } from '../api/lock.mjs'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-login-renew-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const FAKE_CLAUDE = path.join(TMP, 'fake-claude.sh')
fs.writeFileSync(FAKE_CLAUDE, '#!/bin/sh\nexit 0\n')
fs.chmodSync(FAKE_CLAUDE, 0o755)
before(() => {
  process.env.CLAUDE_BIN = FAKE_CLAUDE
  resetClaudeBinCache()
})
after(() => {
  delete process.env.CLAUDE_BIN
  resetClaudeBinCache()
})

const URL = 'https://claude.ai/oauth/authorize?client_id=abc&state=xyz123'
const RIGHT_CODE = 'aAbBcCdDeEfFgGhHiIjJ#1234567890ab'
const WRONG_CODE = 'zZyYxXwWvVuUtTsSrR#0987654321zz'

function writeCreds(file, expiresAt, { mtimeMs } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { refreshTokenExpiresAt: expiresAt, accessToken: 'NEVER-READ-BACK' } }))
  if (mtimeMs != null) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000)
}

/** A fresh fixture per test: its own credentials file, projects dir, state
 * file, and an exec() stub that fakes tmux + (optionally) ssh. `loggedIn`
 * decides what `claude auth status` reports; `renewsOn`, if set, rewrites the
 * credentials file (bumping its mtime) the moment that EXACT code is typed
 * into the pane — the stand-in for a real successful OAuth exchange. */
function fixture({ expiresAt = Date.now() + 20 * 86400000, loggedIn = true, renewsOn = RIGHT_CODE, macChrome = null } = {}) {
  // Each fixture gets its OWN directory, not just random filenames: the
  // renewal lock file is DERIVED from the state file's dirname (config.mjs),
  // so fixtures sharing a directory would also share — and fight over — one
  // renewal lock across unrelated tests.
  const dir = fs.mkdtempSync(path.join(TMP, `${crypto.randomUUID()}-`))
  const credentialsFile = path.join(dir, 'credentials.json')
  const projectsDir = path.join(dir, 'projects')
  const stateFile = path.join(dir, 'state.json')
  writeCreds(credentialsFile, expiresAt)
  fs.mkdirSync(projectsDir, { recursive: true })

  const execCalls = []
  const exec = async (bin, args = []) => {
    execCalls.push([bin, ...args])
    if (bin === 'tmux') {
      if (args[0] === 'kill-session') return { code: 0, stdout: '' }
      if (args[0] === 'new-session') return { code: 0, stdout: '' }
      if (args[0] === 'capture-pane') return { code: 0, stdout: URL }
      if (args[0] === 'send-keys' && args.includes('-l')) {
        const code = args.at(-1)
        if (code === renewsOn) writeCreds(credentialsFile, Date.now() + 28 * 86400000, { mtimeMs: Date.now() + 1000 })
        return { code: 0, stdout: '' }
      }
      if (args[0] === 'send-keys') return { code: 0, stdout: '' }
      if (args[0] === 'has-session') return { code: 0, stdout: '' }
    }
    if (bin === 'ssh' && macChrome) return macChrome(args)
    if (args[0] === 'auth' && args[1] === 'status') return { code: 0, stdout: loggedIn ? '{"loggedIn": true}' : '{"loggedIn": false}' }
    return { code: 0, stdout: '' }
  }

  return { credentialsFile, projectsDir, stateFile, execCalls, exec }
}

function telegramFetch({ ok = true } = {}) {
  const calls = []
  return { calls, fetch: async (url, opts) => (calls.push({ url, body: JSON.parse(opts.body) }), { ok, status: ok ? 200 : 503, json: async () => ({ ok }) }) }
}

function envFor(fx, extra = {}) {
  return {
    DASHBOARD_BEARER_TOKEN: 'dash-bearer',
    API_PORT: '3001',
    CLAUDE_LOGIN_CREDENTIALS_FILE: fx.credentialsFile,
    CLAUDE_LOGIN_PROJECTS_DIR: fx.projectsDir,
    CLAUDE_LOGIN_STATE_FILE: fx.stateFile,
    CLAUDE_LOGIN_URL_WAIT_MS: '200',
    CLAUDE_LOGIN_CODE_WAIT_MS: '200',
    CLAUDE_LOGIN_RETRY_INTERVAL_MS: '100000',
    CLAUDE_LOGIN_ALARM_INTERVAL_MS: '100000',
    CLAUDE_LOGIN_CONFIRM_TIMEOUT_MS: '30',
    CLAUDE_LOGIN_CONFIRM_POLL_MS: '5',
    ...extra,
  }
}

test('method order: telegram first — a renewal asks telegram, not the dashboard', async () => {
  const fx = fixture()
  const { fetch, calls } = telegramFetch()
  const env = envFor(fx, { CLAUDE_LOGIN_METHODS: 'telegram,dashboard' })
  const r = await startAttempt({ env, fetch, exec: fx.exec, file: fx.stateFile, trigger: 'broken' })
  assert.equal(r.ok, true)
  assert.equal(r.via, 'telegram')
  assert.equal(calls.length, 1)
  const state = readState(fx.stateFile)
  assert.equal(state.awaiting.via, 'telegram')
  assert.equal(state.awaiting.url, URL)
})

test('method order: dashboard first — no telegram call at all', async () => {
  const fx = fixture()
  const { fetch, calls } = telegramFetch()
  const env = envFor(fx, { CLAUDE_LOGIN_METHODS: 'dashboard' })
  const r = await startAttempt({ env, fetch, exec: fx.exec, file: fx.stateFile, trigger: 'broken' })
  assert.equal(r.via, 'dashboard')
  assert.equal(calls.length, 0, 'telegram must never be called when it is not in the configured order')
  assert.equal(readState(fx.stateFile).banner.text.includes(URL), true)
})

test('fallback: telegram configured but unreachable falls through to the dashboard banner', async () => {
  const fx = fixture()
  const { fetch, calls } = telegramFetch({ ok: false })
  const env = envFor(fx, { CLAUDE_LOGIN_METHODS: 'telegram,dashboard' })
  const r = await startAttempt({ env, fetch, exec: fx.exec, file: fx.stateFile, trigger: 'broken' })
  assert.equal(r.via, 'dashboard')
  assert.equal(calls.length, 1, 'telegram was still tried once before falling back')
})

test('mac-chrome is never tried without explicit consent, even when named first in the order', async () => {
  const fx = fixture()
  const { fetch, calls } = telegramFetch()
  const env = envFor(fx, { CLAUDE_LOGIN_METHODS: 'mac-chrome,telegram' /* no consent flag */ })
  const r = await startAttempt({ env, fetch, exec: fx.exec, file: fx.stateFile, trigger: 'broken' })
  assert.equal(r.via, 'telegram')
  assert.ok(!fx.execCalls.some((c) => c[0] === 'ssh'), 'mac-chrome must never shell out over ssh without consent')
  assert.equal(calls.length, 1)
})

test('mac-chrome consented but unreachable falls through to telegram — the SAME tmux session, no second login flow', async () => {
  const macChrome = () => ({ code: 255, stdout: '' }) // ssh unreachable
  const fx = fixture({ macChrome })
  const { fetch, calls } = telegramFetch()
  const env = envFor(fx, { CLAUDE_LOGIN_METHODS: 'mac-chrome,telegram', CLAUDE_LOGIN_MAC_CHROME_CONSENT: '1' })
  const r = await startAttempt({ env, fetch, exec: fx.exec, file: fx.stateFile, trigger: 'broken' })
  assert.equal(r.via, 'telegram')
  assert.equal(calls.length, 1)
  const newSessions = fx.execCalls.filter((c) => c[0] === 'tmux' && c[1] === 'new-session')
  assert.equal(newSessions.length, 1, 'only ONE tmux login session, reused for the fallback')
})

test('mac-chrome consented and successful renews immediately, no human ever asked', async () => {
  const macChrome = (args) => {
    if (args.some((a) => typeof a === 'string' && a.includes('ioreg'))) return { code: 0, stdout: '0 1 1' } // locked → proceed
    if (args.includes('open')) return { code: 0, stdout: '999 1' }
    if (args.includes('close')) return { code: 0, stdout: 'closed' }
    if (args.includes('js')) {
      const script = args.at(-1)
      if (/Autorisieren|Authorize/.test(script)) return { code: 0, stdout: 'clicked' }
      return { code: 0, stdout: RIGHT_CODE } // the code-read script
    }
    return { code: 0, stdout: '' }
  }
  const fx = fixture({ macChrome })
  const { fetch, calls } = telegramFetch()
  const env = envFor(fx, { CLAUDE_LOGIN_METHODS: 'mac-chrome,telegram', CLAUDE_LOGIN_MAC_CHROME_CONSENT: '1', CLAUDE_LOGIN_MAC_CHROME_CLICK_TIMEOUT_MS: '200' })
  const r = await startAttempt({ env, fetch, exec: fx.exec, file: fx.stateFile, trigger: 'broken' })
  assert.equal(r.ok, true)
  assert.equal(r.via, 'mac-chrome')
  // mac-chrome needed no human for the CODE, so at most one notification goes
  // out — the "renewed automatically" announcement — never an "ask for a code".
  assert.ok(calls.length <= 1)
  assert.ok(!calls.some((c) => /Autorisieren|den Code/.test(c.body.text)), 'no human was ever asked for a code')
  const state = readState(fx.stateFile)
  assert.equal(state.awaiting, null)
  assert.equal(state.counters.renewed, 1)
})

test('lock against parallel renewals: a second startAttempt while one is awaiting a code is refused', async () => {
  const fx = fixture()
  const { fetch } = telegramFetch()
  const env = envFor(fx, { CLAUDE_LOGIN_METHODS: 'telegram' })
  const first = await startAttempt({ env, fetch, exec: fx.exec, file: fx.stateFile, trigger: 'broken' })
  assert.equal(first.ok, true)
  const second = await startAttempt({ env, fetch, exec: fx.exec, file: fx.stateFile, trigger: 'broken' })
  assert.equal(second.ok, false)
  assert.match(second.error, /already in progress/)
})

test('submitCode: the right code confirms the renewal, clears the lock, and never appears in the state file', async () => {
  const fx = fixture()
  const { fetch } = telegramFetch()
  const env = envFor(fx, { CLAUDE_LOGIN_METHODS: 'telegram' })
  await startAttempt({ env, fetch, exec: fx.exec, file: fx.stateFile, trigger: 'broken' })
  const r = await submitCode(RIGHT_CODE, { env, fetch, exec: fx.exec, file: fx.stateFile, source: 'telegram' })
  assert.equal(r.ok, true)
  assert.ok(r.expiresAt > Date.now())
  const state = readState(fx.stateFile)
  assert.equal(state.awaiting, null)
  assert.equal(state.counters.renewed, 1)
  assert.equal(state.counters.codesSubmitted, 1)
  const raw = fs.readFileSync(fx.stateFile, 'utf-8')
  assert.ok(!raw.includes(RIGHT_CODE), 'the code must never be written to the state file')
  // A second startAttempt now succeeds again — the lock was released.
  const again = await startAttempt({ env, fetch, exec: fx.exec, file: fx.stateFile, trigger: 'broken' })
  assert.equal(again.ok, true)
})

test('submitCode: a wrong code is rejected, counted, and the SAME window stays open for a retry', async () => {
  const fx = fixture({ loggedIn: false })
  const { fetch } = telegramFetch()
  const env = envFor(fx, { CLAUDE_LOGIN_METHODS: 'telegram' })
  await startAttempt({ env, fetch, exec: fx.exec, file: fx.stateFile, trigger: 'broken' })
  const r = await submitCode(WRONG_CODE, { env, fetch, exec: fx.exec, file: fx.stateFile, source: 'telegram' })
  assert.equal(r.ok, false)
  assert.equal(r.attemptsLeft, 2)
  assert.ok(!r.error.includes(WRONG_CODE))
  assert.equal(readState(fx.stateFile).awaiting?.via, 'telegram', 'the window is still open for another try')
})

test('submitCode: three wrong codes give up and release the lock', async () => {
  const fx = fixture({ loggedIn: false })
  const { fetch } = telegramFetch()
  const env = envFor(fx, { CLAUDE_LOGIN_METHODS: 'telegram' })
  await startAttempt({ env, fetch, exec: fx.exec, file: fx.stateFile, trigger: 'broken' })
  await submitCode(WRONG_CODE, { env, fetch, exec: fx.exec, file: fx.stateFile })
  await submitCode(WRONG_CODE, { env, fetch, exec: fx.exec, file: fx.stateFile })
  const r = await submitCode(WRONG_CODE, { env, fetch, exec: fx.exec, file: fx.stateFile })
  assert.equal(r.ok, false)
  assert.match(r.error, /given up/)
  assert.equal(readState(fx.stateFile).awaiting, null)
  const again = await startAttempt({ env, fetch, exec: fx.exec, file: fx.stateFile, trigger: 'broken' })
  assert.equal(again.ok, true, 'the lock was released after giving up')
})

test('submitCode: no renewal is open → a clean refusal, nothing thrown', async () => {
  const fx = fixture()
  const r = await submitCode(RIGHT_CODE, { env: envFor(fx), fetch: async () => { throw new Error('must not be called') }, exec: fx.exec, file: fx.stateFile })
  assert.equal(r.ok, false)
  assert.match(r.error, /no renewal/)
})

test('expireStaleAwaiting gives up on an awaiting attempt nobody answered, and releases the lock', async () => {
  const fx = fixture()
  const { fetch, calls } = telegramFetch()
  const env = envFor(fx, { CLAUDE_LOGIN_METHODS: 'telegram' })
  await startAttempt({ env, fetch, exec: fx.exec, file: fx.stateFile, trigger: 'broken' })
  calls.length = 0
  await expireStaleAwaiting({ env, fetch, exec: fx.exec, file: fx.stateFile })
  assert.equal(readState(fx.stateFile).awaiting, null)
  assert.equal(calls.length, 1, 'the operator is told the renewal expired')
  const again = await startAttempt({ env, fetch, exec: fx.exec, file: fx.stateFile, trigger: 'broken' })
  assert.equal(again.ok, true)
})

test('checkOnce: a FRESH authentication_failed line (after the credentials mtime) triggers an immediate renewal', async () => {
  const fx = fixture()
  const { fetch, calls } = telegramFetch()
  const env = envFor(fx, { CLAUDE_LOGIN_METHODS: 'telegram' })
  const projDir = path.join(fx.projectsDir, 'proj')
  fs.mkdirSync(projDir, { recursive: true })
  fs.writeFileSync(path.join(projDir, 's.jsonl'), JSON.stringify({ type: 'user', error: 'authentication_failed', timestamp: new Date().toISOString() }) + '\n')
  const r = await checkOnce({ env, fetch, exec: fx.exec, file: fx.stateFile })
  assert.equal(r.action, 'broken')
  assert.equal(calls.length, 1)
  assert.equal(readState(fx.stateFile).awaiting?.via, 'telegram')
})

test('checkOnce: a failure line OLDER than the credentials mtime (already fixed) never re-triggers', async () => {
  const fx = fixture({ expiresAt: Date.now() + 20 * 86400000 })
  const projDir = path.join(fx.projectsDir, 'proj')
  fs.mkdirSync(projDir, { recursive: true })
  const old = Date.now() - 5000
  fs.writeFileSync(path.join(projDir, 's.jsonl'), JSON.stringify({ type: 'user', error: 'authentication_failed', timestamp: new Date(old).toISOString() }) + '\n')
  fs.utimesSync(path.join(projDir, 's.jsonl'), old / 1000, old / 1000)
  // The credentials file's mtime (now, from writeCreds in fixture()) is AFTER
  // the failure line — i.e. it was already renewed since.
  const { fetch, calls } = telegramFetch()
  const r = await checkOnce({ env: envFor(fx, { CLAUDE_LOGIN_METHODS: 'telegram' }), fetch, exec: fx.exec, file: fx.stateFile })
  assert.equal(r.action, 'none')
  assert.equal(calls.length, 0)
})

test('checkOnce: close to expiry with no recent failure renews preventively', async () => {
  const fx = fixture({ expiresAt: Date.now() + 2 * 86400000 }) // 2 days left, warnDays default 3
  const { fetch, calls } = telegramFetch()
  const r = await checkOnce({ env: envFor(fx, { CLAUDE_LOGIN_METHODS: 'telegram' }), fetch, exec: fx.exec, file: fx.stateFile })
  assert.equal(r.action, 'preventive')
  assert.equal(calls.length, 1)
})

test('checkOnce: far from expiry, no failures → just records the check', async () => {
  const fx = fixture({ expiresAt: Date.now() + 20 * 86400000 })
  const { fetch, calls } = telegramFetch()
  const r = await checkOnce({ env: envFor(fx, { CLAUDE_LOGIN_METHODS: 'telegram' }), fetch, exec: fx.exec, file: fx.stateFile })
  assert.equal(r.action, 'none')
  assert.equal(calls.length, 0)
  assert.ok(readState(fx.stateFile).lastCheckAt)
})

test('checkOnce: a FAILED preventive attempt is not retried faster than retryIntervalMs', async () => {
  const fx = fixture({ expiresAt: Date.now() + 2 * 86400000 })
  const env = envFor(fx, { CLAUDE_LOGIN_METHODS: 'dashboard', CLAUDE_LOGIN_RETRY_INTERVAL_MS: '3600000' })
  const { fetch } = telegramFetch()
  const first = await checkOnce({ env, fetch, exec: fx.exec, file: fx.stateFile })
  assert.equal(first.action, 'preventive')
  // Let the awaiting window expire (nobody answers) so the lock is released.
  await expireStaleAwaiting({ env, fetch, exec: fx.exec, file: fx.stateFile })
  const second = await checkOnce({ env, fetch, exec: fx.exec, file: fx.stateFile })
  assert.equal(second.action, 'none', 'must not immediately retry inside retryIntervalMs')
})

test('checkOnce clears a stale awaiting attempt past its own deadline', async () => {
  const fx = fixture()
  const env = envFor(fx, { CLAUDE_LOGIN_METHODS: 'telegram' })
  const { fetch } = telegramFetch()
  await startAttempt({ env, fetch, exec: fx.exec, file: fx.stateFile, trigger: 'broken' })
  assert.ok(readState(fx.stateFile).awaiting)
  await checkOnce({ env, fetch, exec: fx.exec, file: fx.stateFile, now: Date.now() + 10 * 60 * 1000 })
  assert.equal(readState(fx.stateFile).awaiting, null)
})

test('a renewal already in progress elsewhere just gets a throttled "already renewing" notice, not a second tmux session', async () => {
  const fx = fixture()
  const env = envFor(fx, { CLAUDE_LOGIN_METHODS: 'telegram' })
  const { fetch, calls } = telegramFetch()
  await startAttempt({ env, fetch, exec: fx.exec, file: fx.stateFile, trigger: 'broken' }) // claims the lock, leaves it awaiting
  calls.length = 0
  const projDir = path.join(fx.projectsDir, 'proj')
  fs.mkdirSync(projDir, { recursive: true })
  fs.writeFileSync(path.join(projDir, 's.jsonl'), JSON.stringify({ type: 'user', error: 'authentication_failed', timestamp: new Date().toISOString() }) + '\n')
  const sessionsBefore = fx.execCalls.filter((c) => c[0] === 'tmux' && c[1] === 'new-session').length
  await checkOnce({ env, fetch, exec: fx.exec, file: fx.stateFile })
  const sessionsAfter = fx.execCalls.filter((c) => c[0] === 'tmux' && c[1] === 'new-session').length
  assert.equal(sessionsAfter, sessionsBefore, 'no second tmux session while one is already in flight')
  assert.equal(calls.length, 1)
})

test('never logs or persists the raw code anywhere across a full attempt + wrong + right code cycle', async () => {
  const fx = fixture()
  const env = envFor(fx, { CLAUDE_LOGIN_METHODS: 'telegram' })
  const { fetch, calls } = telegramFetch()
  await startAttempt({ env, fetch, exec: fx.exec, file: fx.stateFile, trigger: 'broken' })
  await submitCode(WRONG_CODE, { env, fetch, exec: fx.exec, file: fx.stateFile })
  await submitCode(RIGHT_CODE, { env, fetch, exec: fx.exec, file: fx.stateFile })
  const everything = [fs.readFileSync(fx.stateFile, 'utf-8'), JSON.stringify(calls)].join('\n')
  assert.ok(!everything.includes(WRONG_CODE))
  assert.ok(!everything.includes(RIGHT_CODE))
})

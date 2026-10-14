/* ------------------------------------------------------------------ *
 * addons/claude-login — mac-chrome.mjs: the opt-in, consent-gated approval
 * channel. Pins: preflight idle/lock rules, "never a keystroke — only JS into
 * the tab this module itself opened", and that a failure never leaves a tab
 * open. All over a stubbed `exec` — no real ssh/osascript ever runs.
 * Run: node --test addons/claude-login/test/mac-chrome.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approveViaMacChrome, clickAndReadCode, closeTab, openTab, preflight } from '../api/mac-chrome.mjs'

const URL = 'https://claude.ai/oauth/authorize?client_id=abc&state=xyz'
const CODE = 'aAbBcCdDeEfFgGhHiIjJ#1234567890ab'
const sleepFn = () => Promise.resolve() // never a real wait in tests

function sshOut(stdout) {
  return async () => ({ code: 0, stdout, stderr: '' })
}

test('preflight refuses when the mac is unreachable', async () => {
  const exec = async (bin, args) => (args[0] === '-o' ? { code: 255, stdout: '' } : { code: 0, stdout: '' })
  const r = await preflight({ exec, host: 'mac', idleS: 90 })
  assert.equal(r.ok, false)
  assert.match(r.reason, /not reachable/)
})

test('preflight refuses when the operator is active (not idle long enough, not locked, not sofort)', async () => {
  const exec = async (bin, args) => (args.includes('ioreg') || args.some((a) => typeof a === 'string' && a.includes('ioreg')) ? { code: 0, stdout: '5 0 1' } : { code: 0, stdout: '' })
  const r = await preflight({ exec, host: 'mac', idleS: 90 })
  assert.equal(r.ok, false)
  assert.match(r.reason, /active on the mac/)
})

test('preflight proceeds when the screen is LOCKED regardless of idle time', async () => {
  const exec = async (bin, args) => (args.some((a) => typeof a === 'string' && a.includes('ioreg')) ? { code: 0, stdout: '0 1 1' } : { code: 0, stdout: '' })
  const r = await preflight({ exec, host: 'mac', idleS: 90 })
  assert.equal(r.ok, true)
})

test('preflight proceeds when `sofort` (the login is already broken) regardless of idle time', async () => {
  const exec = async (bin, args) => (args.some((a) => typeof a === 'string' && a.includes('ioreg')) ? { code: 0, stdout: '5 0 1' } : { code: 0, stdout: '' })
  const r = await preflight({ exec, host: 'mac', idleS: 90, sofort: true })
  assert.equal(r.ok, true)
})

test('preflight refuses when Chrome is not running', async () => {
  const exec = async (bin, args) => (args.some((a) => typeof a === 'string' && a.includes('ioreg')) ? { code: 0, stdout: '200 0 0' } : { code: 0, stdout: '' })
  const r = await preflight({ exec, host: 'mac', idleS: 90 })
  assert.equal(r.ok, false)
  assert.match(r.reason, /Chrome is not running/)
})

test('openTab reads back the opened tab id and the previously-active tab index', async () => {
  const exec = sshOut('12345 2')
  const r = await openTab({ exec, host: 'mac', url: URL })
  assert.equal(r.ok, true)
  assert.equal(r.tabId, '12345')
  assert.equal(r.previousTabIndex, '2')
})

test('clickAndReadCode clicks via JS (never a keystroke) and reads the code off the page', async () => {
  const calls = []
  let step = 0
  const exec = async (bin, args) => {
    calls.push([bin, ...args])
    // First poll: the click script fires; second phase: the code-read script.
    step++
    if (step === 1) return { code: 0, stdout: 'clicked' }
    return { code: 0, stdout: CODE }
  }
  const r = await clickAndReadCode({ exec, host: 'mac', tabId: '12345', waitMs: 50, pollMs: 5, sleepFn })
  assert.equal(r.ok, true)
  assert.equal(r.code, CODE)
  // Every call is `ssh … osascript -e <script> js <tabId> <jsSource>` — never
  // `System Events`, never a `keystroke`.
  for (const c of calls) {
    assert.equal(c[0], 'ssh')
    assert.ok(!c.some((a) => typeof a === 'string' && /keystroke|System Events/.test(a)))
  }
})

test('clickAndReadCode gives up cleanly if the button never becomes clickable', async () => {
  const exec = async () => ({ code: 0, stdout: 'disabled' })
  const r = await clickAndReadCode({ exec, host: 'mac', tabId: '1', waitMs: 20, pollMs: 5, sleepFn })
  assert.equal(r.ok, false)
  assert.match(r.error, /could not click/)
})

test('closeTab restores the previously-active tab', async () => {
  const calls = []
  const exec = async (bin, args) => {
    calls.push(args)
    return { code: 0, stdout: 'closed' }
  }
  await closeTab({ exec, host: 'mac', tabId: '12345', previousTabIndex: '2' })
  assert.ok(calls[0].includes('12345'))
  assert.ok(calls[0].includes('2'))
})

test('approveViaMacChrome ALWAYS closes the tab it opened, even when the click step fails', async () => {
  const calls = []
  let closed = false
  const exec = async (bin, args) => {
    calls.push(args)
    if (args.includes('-o')) return { code: 0, stdout: '' } // reachability
    if (args.some((a) => typeof a === 'string' && a.includes('ioreg'))) return { code: 0, stdout: '0 1 1' } // locked → proceed
    if (args.includes('open')) return { code: 0, stdout: '999 1' }
    if (args.includes('close')) {
      closed = true
      return { code: 0, stdout: 'closed' }
    }
    return { code: 0, stdout: 'disabled' } // the click script never becomes clickable
  }
  const r = await approveViaMacChrome({ exec, host: 'mac', idleS: 90, url: URL, clickTimeoutMs: 20, pollMs: 1, sleepFn })
  assert.equal(r.ok, false)
  assert.equal(closed, true, 'the opened tab must be closed even on failure')
})

test('approveViaMacChrome refuses outright (no tab ever opened) when preflight fails', async () => {
  const calls = []
  const exec = async (bin, args) => {
    calls.push(args)
    return { code: 255, stdout: '' } // unreachable mac
  }
  const r = await approveViaMacChrome({ exec, host: 'mac', idleS: 90, url: URL, clickTimeoutMs: 20 })
  assert.equal(r.ok, false)
  assert.ok(!calls.some((a) => a.includes('open')), 'must never open a tab when the mac is unreachable')
})

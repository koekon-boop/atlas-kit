/* ------------------------------------------------------------------ *
 * addons/claude-login — tmux-session.mjs: starting the login flow, reading
 * the OAuth URL off the pane, and typing a code back in — all through a
 * stubbed `exec`, never a real tmux.
 * Run: node --test addons/claude-login/test/tmux-session.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { killSession, sendCode, sessionAlive, startLoginSession, waitForUrl } from '../api/tmux-session.mjs'

const URL = 'https://claude.ai/oauth/authorize?client_id=abc&state=xyz123'
const CODE = 'aAbBcCdDeEfFgGhHiIjJ#1234567890ab'

function makeExec(answers) {
  const calls = []
  const exec = async (bin, args) => {
    calls.push([bin, ...args])
    for (const a of answers) if (a.match(bin, args)) return a.result
    return { code: 0, stdout: '', stderr: '' }
  }
  return { exec, calls }
}

test('startLoginSession kills a stale session first, then starts a fresh one with the resolved claude binary', async () => {
  const { exec, calls } = makeExec([])
  const r = await startLoginSession({ exec, session: 'claude-login-renew', claudeBin: '/root/.local/bin/claude' })
  assert.equal(r.ok, true)
  assert.deepEqual(calls[0], ['tmux', 'kill-session', '-t', 'claude-login-renew'])
  assert.equal(calls[1][0], 'tmux')
  assert.equal(calls[1][1], 'new-session')
  const cmdArg = calls[1].at(-1)
  assert.match(cmdArg, /'\/root\/\.local\/bin\/claude' auth login --claudeai/)
})

test('startLoginSession reports missing tmux cleanly', async () => {
  const exec = async () => ({ code: null, missing: true, stdout: '', stderr: '' })
  const r = await startLoginSession({ exec, session: 's', claudeBin: '/bin/claude' })
  assert.equal(r.ok, false)
  assert.match(r.error, /tmux is not installed/)
})

test('waitForUrl finds the OAuth authorize URL in the captured pane', async () => {
  const { exec } = makeExec([{ match: (bin, args) => bin === 'tmux' && args[0] === 'capture-pane', result: { code: 0, stdout: `some text\n${URL}\nmore text` } }])
  const r = await waitForUrl({ exec, session: 's', waitMs: 100, pollMs: 10 })
  assert.equal(r.ok, true)
  assert.equal(r.url, URL)
})

test('waitForUrl times out cleanly when no URL ever appears', async () => {
  const exec = async () => ({ code: 0, stdout: 'nothing useful here' })
  const r = await waitForUrl({ exec, session: 's', waitMs: 30, pollMs: 10 })
  assert.equal(r.ok, false)
  assert.match(r.error, /no OAuth URL/)
})

test('sendCode passes the code as its OWN argv entry, never interpolated into a shell string', async () => {
  const { exec, calls } = makeExec([])
  const r = await sendCode({ exec, session: 's', code: CODE })
  assert.equal(r.ok, true)
  // The code must appear as a single, standalone argv element — not embedded
  // inside a larger string (which would mean it went through shell quoting).
  const sendCall = calls.find((c) => c[1] === 'send-keys' && c.includes('-l'))
  assert.ok(sendCall)
  assert.ok(sendCall.includes(CODE))
  assert.ok(sendCall.some((a) => a === CODE)) // exact, standalone element
  assert.deepEqual(calls[1], ['tmux', 'send-keys', '-t', 's', 'Enter'])
})

test('sendCode reports failure cleanly when tmux refuses', async () => {
  const exec = async () => ({ code: 1, stdout: '', stderr: 'no such session' })
  const r = await sendCode({ exec, session: 's', code: CODE })
  assert.equal(r.ok, false)
})

test('killSession and sessionAlive just shell out, never throw', async () => {
  const { exec } = makeExec([{ match: (bin, args) => args[0] === 'has-session', result: { code: 0 } }])
  await killSession({ exec, session: 's' })
  assert.equal(await sessionAlive({ exec, session: 's' }), true)
})

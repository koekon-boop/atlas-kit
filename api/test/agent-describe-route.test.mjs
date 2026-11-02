/* ------------------------------------------------------------------ *
 * describeSession() + GET /api/agents/describe (agent-local.mjs,
 * agent-routes.mjs): the non-sensitive fields an addon needs to locate a
 * session's OWN Claude transcript file directly — claudeSessionId + worktree,
 * on top of the id/kind/repo/vault/task/status describeSession already
 * returned. Added for addons/telegram's fallback detection (see its README).
 *
 * Hermetic: a state.json fixture written before import, the same convention
 * agent-downloads.test.mjs uses. No tmux, no claude, no network.
 *
 * Run: node --test api/test/agent-describe-route.test.mjs
 * ------------------------------------------------------------------ */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-describe-local-'))
const fixture = {
  sessions: {
    'kb-atlas-telegram': {
      id: 'kb-atlas-telegram',
      kind: 'knowledge',
      vault: 'atlas',
      task: 'Telegram channel',
      status: 'idle',
      tmux: 'agentbox-kb-atlas-telegram',
      worktree: '/workspace/vault',
      claudeSessionId: '5a306058-da69-4177-8e61-cef1cd9ec0e8',
      startedAt: '2026-07-01T00:00:00.000Z',
    },
  },
}
fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(fixture))

process.env.AGENT_LOCAL_DIR = dir
process.env.WORKSPACE_DIR = dir
process.env.AGENT_LOCAL_RECONCILE = '0'
process.env.AGENT_BRIDGES = '[]'

const local = await import('../src/agent-local.mjs')
const { agentRouter } = await import('../src/agent-routes.mjs')

test('describeSession() carries claudeSessionId + worktree alongside the existing fields', () => {
  assert.deepEqual(local.describeSession('kb-atlas-telegram'), {
    id: 'kb-atlas-telegram',
    kind: 'knowledge',
    repo: undefined,
    vault: 'atlas',
    task: 'Telegram channel',
    status: 'idle',
    claudeSessionId: '5a306058-da69-4177-8e61-cef1cd9ec0e8',
    worktree: '/workspace/vault',
  })
})

test('describeSession() stays null for an unknown id', () => {
  assert.equal(local.describeSession('no-such-session'), null)
})

let server
before(() => {
  const app = express()
  app.use(agentRouter((_req, _res, next) => next()))
  server = app.listen(0)
})
after(() => server.close())

test('GET /api/agents/describe?id=… → { ok, session } with the same fields', async () => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/agents/describe?id=kb-atlas-telegram`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.session.claudeSessionId, '5a306058-da69-4177-8e61-cef1cd9ec0e8')
  assert.equal(body.session.worktree, '/workspace/vault')
})

test('GET /api/agents/describe with no id → 400', async () => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/agents/describe`)
  assert.equal(res.status, 400)
})

test('GET /api/agents/describe for an unknown id → 404', async () => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/agents/describe?id=nope`)
  assert.equal(res.status, 404)
})

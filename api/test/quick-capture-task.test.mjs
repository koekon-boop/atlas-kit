/* ------------------------------------------------------------------ *
 * The write path behind the quick-capture surface (web/src/components/
 * QuickCapture.tsx): POST /api/tasks/new, end to end against a real throwaway
 * Atlas vault (bare origin + clone — the commit-queue pull/mutate/commit/push
 * is real, not mocked). This is the exact route the Kanban composer already
 * uses; what the capture screen adds is `source: capture` provenance and rapid
 * repeat filing, both exercised here.
 *
 * Run: node --test api/test/quick-capture-task.test.mjs
 * ------------------------------------------------------------------ */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { execFileSync } from 'node:child_process'

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: GIT_ENV }).trim()
}

// A throwaway Atlas vault: a bare "origin" + a clone. Carries Wiki/Legend.md so
// isTypedVault('atlas') is true (createTask requires a TYPED vault).
function makeAtlasVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-qcap-vault-'))
  const remote = path.join(root, 'remote.git')
  const vault = path.join(root, 'vault')
  git(root, 'init', '--bare', '-q', remote)
  git(root, 'clone', '-q', remote, vault)
  git(vault, 'config', 'user.email', 'test@example.com')
  git(vault, 'config', 'user.name', 'Test')
  fs.mkdirSync(path.join(vault, 'Tasks'), { recursive: true })
  fs.mkdirSync(path.join(vault, 'Wiki'), { recursive: true })
  fs.writeFileSync(path.join(vault, 'Wiki', 'Legend.md'), '# Legend\n')
  fs.writeFileSync(path.join(vault, 'README.md'), '# vault\n')
  git(vault, 'add', '.')
  git(vault, 'commit', '-q', '-m', 'init')
  const branch = git(vault, 'rev-parse', '--abbrev-ref', 'HEAD')
  git(vault, 'push', '-q', 'origin', branch)
  return { vault, branch }
}

const { vault, branch } = makeAtlasVault()
// vaults.mjs / atlas-commit-queue.mjs freeze env-derived constants at import
// time — set these BEFORE the first (dynamic) import of the modules under test.
const vaultsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-qcap-reg-')), 'vaults.json')
fs.writeFileSync(vaultsFile, JSON.stringify({ atlas: { path: vault, label: 'Test Atlas', default: true } }))
process.env.VAULTS_FILE = vaultsFile
process.env.ATLAS_BRANCH = branch

let atlasRouter
before(async () => {
  ;({ atlasRouter } = await import('../src/atlas-routes.mjs'))
})

let bearerCalls = 0
function makeApp() {
  bearerCalls = 0
  const bearerAuth = (_req, _res, next) => {
    bearerCalls++
    next()
  }
  const app = express()
  app.use(express.json())
  app.use(atlasRouter(bearerAuth))
  return app
}

async function withServer(fn) {
  const server = makeApp().listen(0)
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    return await fn(base)
  } finally {
    server.close()
  }
}

const post = (base, body) =>
  fetch(`${base}/api/tasks/new`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

test('a quick capture lands in Inbox, tagged `source: capture`, bearer-gated', async () => {
  await withServer(async (base) => {
    const res = await post(base, { title: 'Buy cat food', source: 'capture' })
    const posted = await res.json()
    assert.equal(res.status, 200, JSON.stringify(posted))
    assert.equal(posted.ok, true)
    assert.ok(posted.path?.startsWith('Tasks/'), 'returns the new Tasks/<slug>.md path')

    const note = fs.readFileSync(path.join(vault, posted.path), 'utf-8')
    assert.match(note, /type: task/)
    assert.match(note, /status: inbox/)
    assert.match(note, /source: capture/)
    assert.match(note, /Buy cat food/)
    assert.equal(bearerCalls, 1, 'bearerAuth runs on the write route')
  })
})

test('rapid multi-capture: three quick posts become three distinct Inbox tasks', async () => {
  await withServer(async (base) => {
    for (const t of ['first thought', 'second thought', 'third thought']) {
      const r = await (await post(base, { title: t, source: 'capture' })).json()
      assert.equal(r.ok, true, JSON.stringify(r))
    }
    const slugs = fs.readdirSync(path.join(vault, 'Tasks'))
    for (const s of ['first-thought.md', 'second-thought.md', 'third-thought.md']) {
      assert.ok(slugs.includes(s), `${s} was written`)
    }
  })
})

test('the `source` enum is not silently widened — a non-token source is rejected', async () => {
  await withServer(async (base) => {
    const res = await post(base, { title: 'nope', source: 'Quick Capture!' })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.ok, false)
    assert.match(body.error, /source/)
  })
})

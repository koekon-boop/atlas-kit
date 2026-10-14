/* ------------------------------------------------------------------ *
 * addons/claude-login — register.mjs: the two HTTP routes on a REAL Express
 * app (exactly bridge.test.mjs's pattern for addons/telegram). The watcher is
 * disabled for every build here (`startWatcher: false`) — these tests drive
 * the renewal state machine directly through fixture state files, never a
 * real tmux/ssh/claude process.
 * Run: node --test addons/claude-login/test/register.test.mjs
 * ------------------------------------------------------------------ */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { buildRoutes, default as registerAddon } from '../api/register.mjs'
import { saveState, readState } from '../api/state.mjs'

const express = createRequire(new URL('../../../api/src/', import.meta.url))('express')
const ctx = { name: 'claude-login', express, Router: (o) => express.Router(o) }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-login-register-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))
const freshFile = () => path.join(TMP, `${crypto.randomUUID()}.json`)
const BEARER = 'dash-bearer'
const CODE = 'aAbBcCdDeEfFgGhHiIjJ#1234567890ab'

async function withApp(routes) {
  const app = express()
  app.use(routes)
  const server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s))
  })
  const port = server.address().port
  return { server, base: `http://127.0.0.1:${port}` }
}

test('register() never crashes and returns description/status/routes (loadAddons() contract)', () => {
  const manifest = registerAddon(ctx)
  assert.equal(typeof manifest.description, 'string')
  assert.ok(manifest.description.length > 0)
  assert.doesNotThrow(() => manifest.status())
  manifest.status() // must not throw even with no credentials file on this box
})

test('GET /api/claude-login/awaiting is OPEN (no bearer needed) and false when nothing is pending', async () => {
  const file = freshFile()
  const { routes } = buildRoutes(ctx, { env: {}, file, startWatcher: false })
  const { server, base } = await withApp(routes)
  try {
    const r = await fetch(`${base}/api/claude-login/awaiting`)
    assert.equal(r.status, 200)
    assert.deepEqual(await r.json(), { awaiting: false })
  } finally {
    server.close()
  }
})

test('GET /api/claude-login/awaiting reports the URL (not the code) when a renewal is pending', async () => {
  const file = freshFile()
  saveState({ ...readState(file), awaiting: { via: 'telegram', url: 'https://claude.ai/oauth/authorize?x', startedAt: 'now', expiresAt: Date.now() + 10000, trigger: 'broken' } }, file)
  const { routes } = buildRoutes(ctx, { env: {}, file, startWatcher: false })
  const { server, base } = await withApp(routes)
  try {
    const j = await (await fetch(`${base}/api/claude-login/awaiting`)).json()
    assert.equal(j.awaiting, true)
    assert.equal(j.via, 'telegram')
    assert.equal(j.url, 'https://claude.ai/oauth/authorize?x')
    assert.ok(!('code' in j))
  } finally {
    server.close()
  }
})

test('POST /api/claude-login/code refuses without the bearer', async () => {
  const file = freshFile()
  const { routes } = buildRoutes(ctx, { env: { DASHBOARD_BEARER_TOKEN: BEARER }, file, startWatcher: false })
  const { server, base } = await withApp(routes)
  try {
    const r = await fetch(`${base}/api/claude-login/code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: CODE }) })
    assert.equal(r.status, 401)
  } finally {
    server.close()
  }
})

test('POST /api/claude-login/code refuses with a WRONG bearer, constant-time-equal check', async () => {
  const file = freshFile()
  const { routes } = buildRoutes(ctx, { env: { DASHBOARD_BEARER_TOKEN: BEARER }, file, startWatcher: false })
  const { server, base } = await withApp(routes)
  try {
    const r = await fetch(`${base}/api/claude-login/code`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer nope' }, body: JSON.stringify({ code: CODE }) })
    assert.equal(r.status, 401)
  } finally {
    server.close()
  }
})

test('POST /api/claude-login/code with the bearer but no open renewal → a clean 409, not a crash', async () => {
  const file = freshFile()
  const { routes } = buildRoutes(ctx, { env: { DASHBOARD_BEARER_TOKEN: BEARER }, file, startWatcher: false })
  const { server, base } = await withApp(routes)
  try {
    const r = await fetch(`${base}/api/claude-login/code`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${BEARER}` }, body: JSON.stringify({ code: CODE }) })
    assert.equal(r.status, 409)
    const j = await r.json()
    assert.equal(j.ok, false)
    assert.match(j.error, /no renewal/)
  } finally {
    server.close()
  }
})

test('POST /api/claude-login/code with a missing/blank code is a 400', async () => {
  const file = freshFile()
  const { routes } = buildRoutes(ctx, { env: { DASHBOARD_BEARER_TOKEN: BEARER }, file, startWatcher: false })
  const { server, base } = await withApp(routes)
  try {
    const r = await fetch(`${base}/api/claude-login/code`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${BEARER}` }, body: JSON.stringify({ code: '  ' }) })
    assert.equal(r.status, 400)
  } finally {
    server.close()
  }
})

test('with no DASHBOARD_BEARER_TOKEN configured at all, the write route refuses with a 500 (never silently open)', async () => {
  const file = freshFile()
  const { routes } = buildRoutes(ctx, { env: {}, file, startWatcher: false })
  const { server, base } = await withApp(routes)
  try {
    const r = await fetch(`${base}/api/claude-login/code`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer anything' }, body: JSON.stringify({ code: CODE }) })
    assert.equal(r.status, 500)
  } finally {
    server.close()
  }
})

test('status() never exposes the code or any token, even with a pending renewal', () => {
  const file = freshFile()
  saveState({ ...readState(file), awaiting: { via: 'dashboard', url: 'https://claude.ai/oauth/authorize?y', startedAt: 'now', expiresAt: Date.now() + 10000, trigger: 'preventive' } }, file)
  const { status } = buildRoutes(ctx, { env: {}, file, startWatcher: false })
  const s = status()
  assert.equal(s.awaiting.via, 'dashboard')
  assert.ok(!JSON.stringify(s).includes(CODE))
})

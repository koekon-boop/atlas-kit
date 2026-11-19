/* ------------------------------------------------------------------ *
 * addons/telegram — the stdio MCP servers never own the getUpdates poller.
 *
 * `loadAddons()` runs in the main API AND in every agent session's
 * `api/src/mcp/server.mjs`. On 2026-10-27 an Express restart let one of those
 * MCP servers win the singleton lock; voice notes then broke, because STT runs
 * from the poller's process and an MCP server is blind to it. register.mjs
 * therefore decides from `process.argv[1]` — read once, at module load — that a
 * process started from `…/api/src/mcp/…` does not start a poller at all.
 *
 * Because the decision is made at load, each case is its own child process,
 * whose entry script lives under a throwaway `api/src/mcp/` (or `api/src/`)
 * path. A bot token is set, global fetch throws, nothing leaves the process.
 * Run: node --test addons/telegram/test/mcp-no-poller.test.mjs
 * ------------------------------------------------------------------ */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-mcp-test-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const REGISTER = new URL('../api/register.mjs', import.meta.url).href
const API_SRC = new URL('../../../api/src/', import.meta.url).href

/** Run register() in a child whose entry script sits at `<TMP>/<rel>`; → its status().poller. */
function pollerStatusFrom(rel, { lockHeldBy } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, 'case-'))
  const entry = path.join(dir, rel)
  fs.mkdirSync(path.dirname(entry), { recursive: true })
  const state = path.join(dir, 'telegram.json')
  // A foreign live pid in the lock: a poller that IS started loses the race and
  // stays idle, so the control case never runs a real poll loop either.
  if (lockHeldBy) fs.writeFileSync(path.join(dir, 'telegram-poller.lock'), JSON.stringify({ pid: lockHeldBy, startedAt: new Date().toISOString() }))
  fs.writeFileSync(entry, `
    import { createRequire } from 'node:module'
    globalThis.fetch = async () => { throw new Error('offline') }
    const { default: register } = await import(${JSON.stringify(REGISTER)})
    const express = createRequire(${JSON.stringify(API_SRC)})('express')
    const st = register({ name: 'telegram', express, Router: (o) => express.Router(o) }).status()
    process.stdout.write(JSON.stringify(st.poller))
    process.exit(0)
  `)
  const env = { PATH: process.env.PATH, TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_HOME_CHAT_ID: '111', DASHBOARD_BEARER_TOKEN: 'b', TELEGRAM_STATE_FILE: state }
  return JSON.parse(execFileSync(process.execPath, [entry], { env, encoding: 'utf8', timeout: 20000 }))
}

test('a process started from api/src/mcp/ (the per-session stdio MCP server) never starts a poller', () => {
  assert.deepEqual(pollerStatusFrom('api/src/mcp/server.mjs'), { owner: false, reason: 'not started in this process' })
})

test('control: the main API (api/src/server.mjs) does start one — here it only loses the lock to a live foreign pid', () => {
  const st = pollerStatusFrom('api/src/server.mjs', { lockHeldBy: process.pid })
  assert.equal(st.owner, false)
  assert.notEqual(st.reason, 'not started in this process', 'a poller was created and went for the lock')
})

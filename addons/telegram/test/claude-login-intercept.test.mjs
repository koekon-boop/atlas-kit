/* ------------------------------------------------------------------ *
 * addons/telegram — intercepting a `claude auth login` OAuth code meant for
 * addons/claude-login, SOLANGE a renewal there is open (claude-login-bridge.mjs,
 * wired into inbound.mjs's handleOne). Hermetic: one stubbed `fetch` answers
 * BOTH Telegram's API and the claude-login loopback routes; no real addon, no
 * real tmux, no real network.
 * Run: node --test addons/telegram/test/claude-login-intercept.test.mjs
 * ------------------------------------------------------------------ */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createInbound } from '../api/inbound.mjs'
import { tryInterceptClaudeLoginCode } from '../api/claude-login-bridge.mjs'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-claude-login-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))
const freshFile = () => path.join(TMP, `${crypto.randomUUID()}.json`)

const CODE = 'aAbBcCdDeEfFgGhHiIjJ#1234567890ab'
const BEARER = 'dash-bearer'
const ENV = { TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_HOME_CHAT_ID: '111', DASHBOARD_BEARER_TOKEN: BEARER, API_PORT: '3001' }

/** `awaiting`/`claudeLoginOk`/`attemptsLeft` script how the stubbed
 *  addons/claude-login routes answer; everything else is the ordinary
 *  core agent-routes + Telegram stub bridge.test.mjs already uses. */
function makeWorld({ awaiting = false, claudeLoginOk = true, attemptsLeft, sessions = [], claudeLoginUp = true } = {}) {
  const w = { sent: [], core: [], claudeLogin: [], awaitingChecks: [], spawned: 0 }
  w.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined
    const json = (status, j) => ({ ok: status < 400, status, json: async () => j })
    if (url.startsWith('https://api.telegram.org/')) {
      w.sent.push({ url, body })
      return json(200, { ok: true, result: { message_id: 1 } })
    }
    const route = url.replace('http://127.0.0.1:3001', '')
    if (route === '/api/claude-login/awaiting') {
      w.awaitingChecks.push(true)
      if (!claudeLoginUp) return json(404, {})
      return json(200, awaiting ? { awaiting: true, via: 'telegram', url: 'https://claude.ai/x' } : { awaiting: false })
    }
    if (route === '/api/claude-login/code') {
      w.claudeLogin.push(body)
      if (claudeLoginOk) return json(200, { ok: true, expiresAt: Date.now() + 1000 })
      if (Number.isInteger(attemptsLeft)) return json(409, { ok: false, error: 'wrong', attemptsLeft })
      return json(409, { ok: false, error: 'gave up' })
    }
    w.core.push({ method: opts.method, route, body })
    if (route === '/api/agents') return json(200, { sessions })
    if (route === '/api/agents/spawn') return json(200, { ok: true, id: `kb-atlas-${++w.spawned}` })
    if (route === '/api/agents/prompt') return json(200, { ok: true })
    if (route === '/api/agents/queue') return json(200, { ok: true })
    return json(404, {})
  }
  return w
}

function build(world, env = ENV) {
  const file = freshFile()
  const log = []
  const inbound = createInbound({ env, fetch: world.fetch, log: (m) => log.push(m), file })
  return { inbound, log, file }
}

const update = (text, id = 1) => ({ update_id: id, message: { chat: { id: 111 }, text } })

test('tryInterceptClaudeLoginCode: ordinary text never calls any route at all', async () => {
  const w = makeWorld()
  const r = await tryInterceptClaudeLoginCode('hallo, wie geht es dir?', { env: ENV, fetch: w.fetch })
  assert.equal(r.handled, false)
  assert.equal(w.claudeLogin.length, 0)
  assert.equal(w.awaitingChecks.length, 0)
})

test('tryInterceptClaudeLoginCode: code-shaped text, but NO renewal open → falls through, nothing submitted', async () => {
  const w = makeWorld({ awaiting: false })
  const r = await tryInterceptClaudeLoginCode(`here is my code ${CODE}`, { env: ENV, fetch: w.fetch })
  assert.equal(r.handled, false)
  assert.equal(w.claudeLogin.length, 0)
})

test('tryInterceptClaudeLoginCode: addons/claude-login not enabled (404) → falls through cleanly, never throws', async () => {
  const w = makeWorld({ claudeLoginUp: false })
  const r = await tryInterceptClaudeLoginCode(CODE, { env: ENV, fetch: w.fetch, log: () => {} })
  assert.equal(r.handled, false)
})

test('tryInterceptClaudeLoginCode: a renewal IS open → the code is submitted and the sender gets the real outcome', async () => {
  const w = makeWorld({ awaiting: true, claudeLoginOk: true })
  const r = await tryInterceptClaudeLoginCode(`mein code: ${CODE} bitte`, { env: ENV, fetch: w.fetch })
  assert.equal(r.handled, true)
  assert.equal(w.claudeLogin[0].code, CODE)
  assert.equal(w.claudeLogin[0].source, 'telegram')
  assert.match(r.reply, /erneuert/)
})

test('tryInterceptClaudeLoginCode: a wrong code → the reply says how many tries remain', async () => {
  const w = makeWorld({ awaiting: true, claudeLoginOk: false, attemptsLeft: 2 })
  const r = await tryInterceptClaudeLoginCode(CODE, { env: ENV, fetch: w.fetch })
  assert.equal(r.handled, true)
  assert.match(r.reply, /2 Versuche/)
})

test('end to end via handleOne: a code arrives while a renewal is open → intercepted, NOT forwarded to the agent, counted', async () => {
  const w = makeWorld({ awaiting: true, claudeLoginOk: true })
  const { inbound } = build(w)
  await inbound.handleOne(update(`code: ${CODE}`))
  assert.equal(w.core.length, 0, 'the agent routes must never see this message')
  assert.equal(inbound.counters.claudeLoginCodes, 1)
  assert.equal(inbound.counters.forwarded, 0)
  assert.equal(w.sent.length, 1)
  assert.match(w.sent[0].body.text, /erneuert/)
})

test('end to end via handleOne: no renewal open → the SAME code-shaped text goes to the agent like any other message', async () => {
  const w = makeWorld({ awaiting: false })
  const { inbound } = build(w)
  await inbound.handleOne(update(`code: ${CODE}`))
  assert.equal(inbound.counters.claudeLoginCodes, 0)
  assert.equal(inbound.counters.forwarded, 1)
  assert.ok(w.core.some((c) => c.route === '/api/agents/spawn'))
})

test('end to end via handleOne: an ordinary message is completely unaffected', async () => {
  const w = makeWorld({ awaiting: true, claudeLoginOk: true })
  const { inbound } = build(w)
  await inbound.handleOne(update('Was steht heute an?'))
  assert.equal(inbound.counters.claudeLoginCodes, 0)
  assert.equal(inbound.counters.forwarded, 1)
  assert.equal(w.awaitingChecks.length, 0, 'the awaiting check never even fires on text that is not code-shaped')
})

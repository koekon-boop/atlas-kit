/* ------------------------------------------------------------------ *
 * addons/telegram — the automatic emergency fallback (README "Automatic
 * fallback"): a replacement knowledge chat on a different model-BACKEND
 * profile takes over the standing Telegram conversation while the main
 * session cannot reach Anthropic at all, then hands back with one summary.
 *
 * What this pins:
 *   · onFallbackTick(): a detected block flips into fallback mode; while
 *     active it decides whether to probe, and a successful probe hands back
 *   · deliverToFallback(): spawns with the configured provider + model 'opus',
 *     trying the provider CHAIN in order on a spawn failure
 *   · while fallback is active, NOTHING reaches the main session — not even
 *     a spawn/prompt call is attempted against it
 *   · switchToMain(): the handoff text names what came in/out and says,
 *     verbatim, that it is already answered
 *   · a renewed block right after handback switches back again
 *   · the three home-chat commands (/ersatz, /claude, /modell)
 *   · TELEGRAM_FALLBACK_PROVIDERS="" is the kill switch for the whole feature
 *   · a ROUTED chat is never touched by any of this
 *
 * Hermetic: Telegram + core's agent routes are one stubbed `fetch` (the same
 * convention as routing.test.mjs/poller.test.mjs), extended with
 * /api/agents/describe. The probe is injected — no real `claude` process ever
 * runs in this file.
 *
 * Run: node --test addons/telegram/test/fallback.test.mjs
 * ------------------------------------------------------------------ */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { buildRoutes } from '../api/register.mjs'
import { readState } from '../api/agent.mjs'
import { deliverToFallback, fallbackActive, fallbackStatus, onFallbackTick, switchToMain, tryInterceptCommand } from '../api/fallback.mjs'

const express = createRequire(new URL('../../../api/src/', import.meta.url))('express')
const ctx = { name: 'telegram', express, Router: (o) => express.Router(o) }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-fallback-test-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const HOME = '111'
const JESSI = '222'
const BEARER = 'dash-bearer'
const ENV = {
  TELEGRAM_BOT_TOKEN: 'bot-token',
  TELEGRAM_HOME_CHAT_ID: HOME,
  TELEGRAM_CHAT_ROUTES: `${JESSI}=kb-shop-setup`,
  TELEGRAM_FALLBACK_PROVIDERS: 'gpt-openrouter,deepseek-openrouter',
  DASHBOARD_BEARER_TOKEN: BEARER,
  API_PORT: '3001',
}

const newFile = (name) => path.join(TMP, `${name}-${crypto.randomUUID()}.json`)

/** Core's agent routes + Telegram, extended with /api/agents/describe. */
function makeWorld({ sessions = [], describeById = {}, spawnFails = [], telegramOk = true } = {}) {
  const w = { sent: [], core: [], sessions, describeById, spawnFails, telegramOk, spawned: 0 }
  w.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined
    const json = (status, j) => ({ ok: status < 400, status, json: async () => j })
    if (url.startsWith('https://api.telegram.org/')) {
      if (!w.telegramOk) return json(400, { ok: false, description: 'boom' })
      w.sent.push({ url, body })
      return json(200, { ok: true, result: { message_id: 1 } })
    }
    const u = new URL(url)
    const route = u.pathname
    w.core.push({ method: opts.method, route, body, query: u.search })
    if (route === '/api/agents') return json(200, { sessions: w.sessions })
    if (route === '/api/agents/describe') {
      const id = u.searchParams.get('id')
      const s = w.describeById[id]
      return s ? json(200, { ok: true, session: s }) : json(404, { ok: false, error: 'unknown session' })
    }
    if (route === '/api/agents/spawn') {
      if (w.spawnFails.includes(body.provider)) return json(400, { ok: false, error: `unknown "provider" profile` })
      const id = `kb-atlas-fallback-${++w.spawned}`
      w.sessions.push({ id, status: 'idle' })
      return json(200, { ok: true, id })
    }
    if (route === '/api/agents/prompt') return json(200, { ok: true })
    if (route === '/api/agents/queue') return json(200, { ok: true })
    return json(404, {})
  }
  return w
}

function build({ world = makeWorld(), env = ENV, name = 'state', state } = {}) {
  const file = newFile(name)
  if (state) fs.writeFileSync(file, JSON.stringify(state))
  const log = []
  const { routes, inbound } = buildRoutes(ctx, { env, fetch: world.fetch, log: (m) => log.push(m), file, startPoller: false })
  return { routes, inbound, world, file, log, env }
}

const update = (id, m) => ({ update_id: id, message: m })
const text = (id, body, chatId) => ({ message_id: id, chat: { id: Number(chatId) }, text: body })

/* --- deliverToFallback(): spawns with the provider + model 'opus' ------ */

test('deliverToFallback(): spawns the FIRST configured provider at model "opus", kind knowledge, vault atlas', async () => {
  const w = makeWorld()
  const { file } = build({ world: w })
  const r = await deliverToFallback({ chatId: HOME, text: 'hallo?' }, { env: ENV, fetch: w.fetch, file })
  assert.equal(r.ok, true)
  assert.equal(r.via, 'spawn')
  assert.equal(r.provider, 'gpt-openrouter')
  const spawn = w.core.find((c) => c.route === '/api/agents/spawn')
  assert.equal(spawn.body.provider, 'gpt-openrouter')
  assert.equal(spawn.body.model, 'opus')
  assert.equal(spawn.body.kind, 'knowledge')
  assert.equal(spawn.body.vault, 'atlas')
  assert.match(spawn.body.task, /ERSATZ-SITZUNG/, 'the fresh session is briefed that it is the replacement')
  assert.match(spawn.body.task, /\[Telegram from 111\] hallo\?/)
  assert.equal(readState(file).fallback.fallbackSessionId, r.id)
})

test('deliverToFallback(): the SECOND provider is tried when the first fails to spawn', async () => {
  const w = makeWorld({ spawnFails: ['gpt-openrouter'] })
  const { file } = build({ world: w })
  const r = await deliverToFallback({ chatId: HOME, text: 'hallo?' }, { env: ENV, fetch: w.fetch, file })
  assert.equal(r.ok, true)
  assert.equal(r.provider, 'deepseek-openrouter')
  const spawnCalls = w.core.filter((c) => c.route === '/api/agents/spawn')
  assert.deepEqual(spawnCalls.map((c) => c.body.provider), ['gpt-openrouter', 'deepseek-openrouter'])
})

test('deliverToFallback(): every provider failing → a clear error, no session id persisted', async () => {
  const w = makeWorld({ spawnFails: ['gpt-openrouter', 'deepseek-openrouter'] })
  const { file } = build({ world: w })
  const r = await deliverToFallback({ chatId: HOME, text: 'hallo?' }, { env: ENV, fetch: w.fetch, file })
  assert.equal(r.ok, false)
  assert.match(r.error, /no fallback provider could be spawned/)
  assert.equal(readState(file).fallback?.fallbackSessionId, undefined)
})

test('deliverToFallback(): an existing live fallback session is REUSED (no second spawn)', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-atlas-fallback-1', status: 'idle' }] })
  const { file } = build({
    world: w,
    state: { fallback: { active: true, reason: 'rate_limit', fallbackSessionId: 'kb-atlas-fallback-1', providerUsed: 'gpt-openrouter', noted: true, log: [] } },
  })
  const r = await deliverToFallback({ chatId: HOME, text: 'noch da?' }, { env: ENV, fetch: w.fetch, file })
  assert.equal(r.ok, true)
  assert.equal(r.via, 'prompt')
  assert.equal(w.core.filter((c) => c.route === '/api/agents/spawn').length, 0)
})

test('deliverToFallback(): TELEGRAM_FALLBACK_PROVIDERS empty → refuses outright', async () => {
  const w = makeWorld()
  const { file } = build({ world: w, env: { ...ENV, TELEGRAM_FALLBACK_PROVIDERS: '' } })
  const r = await deliverToFallback({ chatId: HOME, text: 'x' }, { env: { ...ENV, TELEGRAM_FALLBACK_PROVIDERS: '' }, fetch: w.fetch, file })
  assert.equal(r.ok, false)
  assert.match(r.error, /empty/)
})

/* --- while fallback is active, nothing reaches the MAIN session ------- */

test('while fallback is active, an unrouted message NEVER touches the main session — only the fallback one', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-main', status: 'idle' }, { id: 'kb-atlas-fallback-1', status: 'idle' }] })
  const b = build({
    world: w,
    state: { sessionId: 'kb-main', fallback: { active: true, reason: 'rate_limit', fallbackSessionId: 'kb-atlas-fallback-1', providerUsed: 'gpt-openrouter', noted: true, log: [] } },
  })
  await b.inbound.handleOne(update(1, text(1, 'bist du da?', HOME)))
  const toMain = w.core.filter((c) => (c.route === '/api/agents/prompt' || c.route === '/api/agents/queue' || c.route === '/api/agents/spawn') && c.body?.id === 'kb-main')
  assert.equal(toMain.length, 0, 'the blocked main session must never be prompted/queued/spawned while fallback is active')
  const toFallback = w.core.filter((c) => c.route === '/api/agents/prompt' && c.body?.id === 'kb-atlas-fallback-1')
  assert.equal(toFallback.length, 1)
  assert.equal(b.inbound.counters.forwarded, 1)
})

/* --- the handoff: text, "already answered", and clearing the episode -- */

test('switchToMain(): the handoff names the reason, lists the log, and says the messages are ALREADY answered', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-main', status: 'idle' }] })
  const { file } = build({
    world: w,
    state: {
      sessionId: 'kb-main',
      fallback: {
        active: true,
        reason: 'rate_limit',
        resetText: 'resets 8pm (UTC)',
        providerUsed: 'gpt-openrouter',
        fallbackSessionId: 'kb-fb',
        noted: true,
        log: [
          { dir: 'in', text: 'Was steht heute an?', at: '2026-11-02T18:55:00.000Z' },
          { dir: 'out', text: 'Heute: Zahnarzt 15 Uhr.', at: '2026-11-02T18:55:30.000Z' },
        ],
      },
    },
  })
  const r = await switchToMain({ env: ENV, fetch: w.fetch, file })
  assert.equal(r.ok, true)
  const prompt = w.core.find((c) => c.route === '/api/agents/prompt')
  assert.ok(prompt, 'the main session gets the handoff via /prompt')
  assert.match(prompt.body.text, /schon beantwortet/i)
  assert.match(prompt.body.text, /Was steht heute an\?/)
  assert.match(prompt.body.text, /Zahnarzt 15 Uhr/)
  assert.match(prompt.body.text, /rate_limit|Ratenlimit/)
  // the episode is cleared — the fallback session ITSELF is left alone (idle, reusable next time)
  assert.equal(fallbackActive(file), false)
  assert.deepEqual(readState(file).fallback.log, [])
  assert.equal(readState(file).fallback.fallbackSessionId, 'kb-fb', 'kept for reuse — only the episode bookkeeping is cleared')
})

test('switchToMain(): with no log at all, the handoff still says so plainly (no crash on an empty episode)', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-main', status: 'idle' }] })
  const { file } = build({
    world: w,
    state: { sessionId: 'kb-main', fallback: { active: true, reason: 'authentication_failed', fallbackSessionId: 'kb-fb', noted: true, log: [] } },
  })
  const r = await switchToMain({ env: ENV, fetch: w.fetch, file })
  assert.equal(r.ok, true)
  const prompt = w.core.find((c) => c.route === '/api/agents/prompt')
  assert.match(prompt.body.text, /keine Nachrichten/)
})

test('switchToMain(): not active at all → a clear error, no calls made', async () => {
  const w = makeWorld()
  const { file } = build({ world: w })
  const r = await switchToMain({ env: ENV, fetch: w.fetch, file })
  assert.equal(r.ok, false)
  assert.equal(w.core.length, 0)
})

/* --- onFallbackTick(): detect → activate; then probe → hand back ------ */

test('onFallbackTick(): a fresh detection flips into fallback mode (no session spawned yet — lazy, on the next real message)', async () => {
  const w = makeWorld({ describeById: { 'kb-main': { claudeSessionId: 'uuid-1', worktree: '/v' } } })
  const { file } = build({ world: w, state: { sessionId: 'kb-main' } })
  const now = Date.now()
  const errLine = JSON.stringify({ isApiErrorMessage: true, error: 'authentication_failed', timestamp: new Date(now).toISOString(), message: { content: 'Login expired · Please run /login' } })
  await onFallbackTick({ env: ENV, fetch: w.fetch, file, tail: () => [errLine] })
  const fb = readState(file).fallback
  assert.equal(fb.active, true)
  assert.equal(fb.reason, 'authentication_failed')
  assert.equal(fb.fallbackSessionId, null, 'nothing is spawned until there is an actual message to answer')
  assert.equal(w.core.filter((c) => c.route === '/api/agents/spawn').length, 0)
})

test('onFallbackTick(): not blocked → stays inactive, no state write', async () => {
  const w = makeWorld({ describeById: { 'kb-main': { claudeSessionId: 'uuid-1', worktree: '/v' } } })
  const { file } = build({ world: w, state: { sessionId: 'kb-main' } })
  await onFallbackTick({ env: ENV, fetch: w.fetch, file, tail: () => [JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: 'ok' }] } })] })
  assert.equal(fallbackActive(file), false)
})

test('onFallbackTick(): while active, a successful probe hands back to main', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-main', status: 'idle' }] })
  const { file } = build({
    world: w,
    state: { sessionId: 'kb-main', fallback: { active: true, reason: 'rate_limit', resetAt: Date.now() - 1000, fallbackSessionId: 'kb-fb', noted: true, log: [] } },
  })
  const probe = async () => true
  await onFallbackTick({ env: ENV, fetch: w.fetch, file, probe })
  assert.equal(fallbackActive(file), false, 'a successful probe clears the episode')
  assert.ok(w.core.some((c) => c.route === '/api/agents/prompt' && /schon beantwortet/i.test(c.body.text)))
})

test('onFallbackTick(): while active, a FAILED probe stays in fallback mode', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-main', status: 'idle' }] })
  const { file } = build({
    world: w,
    state: { sessionId: 'kb-main', fallback: { active: true, reason: 'rate_limit', resetAt: Date.now() - 1000, fallbackSessionId: 'kb-fb', noted: true, log: [] } },
  })
  const probe = async () => false
  await onFallbackTick({ env: ENV, fetch: w.fetch, file, probe })
  assert.equal(fallbackActive(file), true)
  assert.equal(readState(file).fallback.counters.probes, 1)
})

test('onFallbackTick(): before the reset time (or the 15-min interval), no probe runs at all', async () => {
  const w = makeWorld()
  const { file } = build({
    world: w,
    state: { sessionId: 'kb-main', fallback: { active: true, reason: 'rate_limit', resetAt: Date.now() + 3600000, fallbackSessionId: 'kb-fb', noted: true, log: [] } },
  })
  let probed = false
  await onFallbackTick({ env: ENV, fetch: w.fetch, file, probe: async () => ((probed = true), true) })
  assert.equal(probed, false)
  assert.equal(fallbackActive(file), true)
})

test('REGRESSION: a renewed block right after handback switches back into fallback again', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-main', status: 'idle' }], describeById: { 'kb-main': { claudeSessionId: 'uuid-1', worktree: '/v' } } })
  const { file } = build({
    world: w,
    state: {
      sessionId: 'kb-main',
      fallback: { active: true, reason: 'rate_limit', resetAt: Date.now() - 1000, fallbackSessionId: 'kb-fb', noted: true, log: [], counters: { switches: 1, delivered: 0, probes: 0 } },
    },
  })
  await onFallbackTick({ env: ENV, fetch: w.fetch, file, probe: async () => true })
  assert.equal(fallbackActive(file), false, 'handed back')
  const now = Date.now()
  const errLine = JSON.stringify({ isApiErrorMessage: true, error: 'rate_limit', timestamp: new Date(now).toISOString(), message: { content: 'blocked again · resets 8pm (UTC)' } })
  await onFallbackTick({ env: ENV, fetch: w.fetch, file, tail: () => [errLine] })
  assert.equal(fallbackActive(file), true, 'blocked again right away')
  assert.equal(readState(file).fallback.counters.switches, 2, 'two separate episodes, counted separately')
})

/* --- the three home-chat commands -------------------------------------- */

test('/modell: reports normal operation when inactive, and the reason/provider when active', async () => {
  const w = makeWorld()
  const { file } = build({ world: w })
  const r1 = await tryInterceptCommand('/modell', HOME, { env: ENV, fetch: w.fetch, file })
  assert.equal(r1.handled, true)
  assert.match(r1.reply, /normal/i)

  fs.writeFileSync(file, JSON.stringify({ fallback: { active: true, reason: 'rate_limit', providerUsed: 'gpt-openrouter', resetText: 'resets 8pm (UTC)', log: [] } }))
  const r2 = await tryInterceptCommand('/modell', HOME, { env: ENV, fetch: w.fetch, file })
  assert.match(r2.reply, /gpt-openrouter/)
  assert.match(r2.reply, /8pm/)
})

test('/ersatz: forces the switch, optionally pinning a named profile', async () => {
  const w = makeWorld()
  const { file } = build({ world: w })
  const r = await tryInterceptCommand('/ersatz deepseek', HOME, { env: ENV, fetch: w.fetch, file })
  assert.equal(r.handled, true)
  assert.match(r.reply, /deepseek-openrouter/)
  const spawn = w.core.find((c) => c.route === '/api/agents/spawn')
  assert.equal(spawn.body.provider, 'deepseek-openrouter')
  assert.equal(readState(file).fallback.reason, 'manual')
})

test('/ersatz: an unknown profile name is refused, nothing switched', async () => {
  const w = makeWorld()
  const { file } = build({ world: w })
  const r = await tryInterceptCommand('/ersatz bogus', HOME, { env: ENV, fetch: w.fetch, file })
  assert.equal(r.handled, true)
  assert.match(r.reply, /[Uu]nbekannt/)
  assert.equal(fallbackActive(file), false)
})

test('/claude: hands back when active, says so plainly when not', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-main', status: 'idle' }] })
  const { file } = build({ world: w, state: { sessionId: 'kb-main' } })
  const r1 = await tryInterceptCommand('/claude', HOME, { env: ENV, fetch: w.fetch, file })
  assert.match(r1.reply, /schon dran/)

  fs.writeFileSync(file, JSON.stringify({ sessionId: 'kb-main', fallback: { active: true, reason: 'rate_limit', fallbackSessionId: 'kb-fb', noted: true, log: [] } }))
  const r2 = await tryInterceptCommand('/claude', HOME, { env: ENV, fetch: w.fetch, file })
  assert.match(r2.reply, /Zurück auf Claude/)
  assert.equal(fallbackActive(file), false)
})

test('the three commands are home-chat ONLY — from any other allowed chat they are not intercepted at all', async () => {
  const w = makeWorld()
  const { file } = build({ world: w })
  const r = await tryInterceptCommand('/ersatz', JESSI, { env: ENV, fetch: w.fetch, file })
  assert.equal(r.handled, false)
})

/* --- the kill switch: TELEGRAM_FALLBACK_PROVIDERS="" turns it ALL off -- */

test('TELEGRAM_FALLBACK_PROVIDERS="" disables detection/switching entirely', async () => {
  const offEnv = { ...ENV, TELEGRAM_FALLBACK_PROVIDERS: '' }
  const w = makeWorld({ describeById: { 'kb-main': { claudeSessionId: 'uuid-1', worktree: '/v' } } })
  const { file } = build({ world: w, env: offEnv, state: { sessionId: 'kb-main' } })
  const errLine = JSON.stringify({ isApiErrorMessage: true, error: 'authentication_failed', timestamp: new Date().toISOString(), message: { content: 'Login expired' } })
  await onFallbackTick({ env: offEnv, fetch: w.fetch, file, tail: () => [errLine] })
  assert.equal(fallbackActive(file), false)
  assert.equal(w.core.length, 0, 'not even the /api/agents/describe lookup runs')

  const r = await tryInterceptCommand('/ersatz', HOME, { env: offEnv, fetch: w.fetch, file })
  assert.match(r.reply, /nicht konfiguriert/)
  assert.equal(fallbackActive(file), false)
})

test('fallbackStatus() reports enabled:false and an empty provider list under the kill switch', () => {
  const file = newFile('status-off')
  fs.writeFileSync(file, JSON.stringify({}))
  const s = fallbackStatus({ file, env: { ...ENV, TELEGRAM_FALLBACK_PROVIDERS: '' } })
  assert.equal(s.enabled, false)
  assert.deepEqual(s.providers, [])
  assert.equal(s.active, false)
})

/* --- a ROUTED chat is untouched by any of this -------------------------- */

test('a ROUTED chat is delivered to its own target even while fallback is globally active, and never to the fallback session', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-shop-setup', status: 'idle' }, { id: 'kb-fb', status: 'idle' }] })
  const b = build({
    world: w,
    state: { sessionId: 'kb-main', fallback: { active: true, reason: 'rate_limit', fallbackSessionId: 'kb-fb', providerUsed: 'gpt-openrouter', noted: true, log: [] } },
  })
  await b.inbound.handleOne(update(1, text(1, 'Was ist der Stand?', JESSI)))
  const toRoute = w.core.find((c) => c.route === '/api/agents/prompt' && c.body?.id === 'kb-shop-setup')
  assert.ok(toRoute, 'the route delivers to its own pinned target')
  const toFallback = w.core.filter((c) => c.body?.id === 'kb-fb')
  assert.equal(toFallback.length, 0, 'a routed chat never reaches the fallback session')
})

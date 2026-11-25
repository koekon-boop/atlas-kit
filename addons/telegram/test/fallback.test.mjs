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
 *   · the 24./25.11.2026 hardening (README "What keeps it from getting
 *     stuck"): own session ids, the probe always comes due, a fallback out of
 *     credits → Claude at once or ONE note + buffer, a refusal replaces the
 *     session, a transient error retries on Claude first
 *   · keeping it cheap (very bottom, README "Keeping the fallback cheap"): the
 *     context cap, the lean spawn + short brief, short handovers, the brief's
 *     rules, the status numbers
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
import { deliverToFallback, fallbackActive, fallbackStatus, noteOutbound, onFallbackTick, switchToMain, tryInterceptCommand } from '../api/fallback.mjs'

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
/** core's own id rule (spawnKnowledge → slugify in api/src/agent-local.mjs):
 *  the first 40 slug characters of the task, de-duplicated only against what
 *  is still REGISTERED — a purged id is handed out again. Copied (it is not
 *  exported) so the id-collision regression below is tested against the real
 *  rule, not a stub that could never collide. */
const coreSlug = (task) => String(task).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)

function makeWorld({ sessions = [], describeById = {}, spawnFails = [], telegramOk = true, coreIds = false } = {}) {
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
      ++w.spawned
      let id = `kb-atlas-fallback-${w.spawned}`
      if (coreIds) {
        const base = `kb-${coreSlug(body.task)}`
        id = base
        for (let n = 2; w.sessions.some((s) => s.id === id); n++) id = `${base}-${n}`
      }
      w.sessions.push({ id, status: 'idle' })
      return json(200, { ok: true, id })
    }
    if (route === '/api/agents/kill' || route === '/api/agents/cleanup') {
      w.sessions = w.sessions.filter((s) => s.id !== body.id)
      return json(200, { ok: true })
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

test('REGRESSION (the lost-message guard): a message delivered to main right before the error is replayed to the fallback session on the very next tick', async () => {
  // The incident this pins: Ko writes "Hallo", it reaches the (about to be
  // blocked) main session fine, the turn then fails against Anthropic, and
  // — without this — nobody ever answers. deliver() must have remembered it.
  const w = makeWorld({ sessions: [{ id: 'kb-main', status: 'idle' }], describeById: { 'kb-main': { claudeSessionId: 'uuid-1', worktree: '/v' } } })
  const b = build({ world: w, state: { sessionId: 'kb-main' } })

  await b.inbound.handleOne(update(1, text(1, 'Hallo', HOME)))
  assert.ok(w.core.some((c) => c.route === '/api/agents/prompt' && c.body?.id === 'kb-main'), 'the message really did reach main')

  const now = Date.now()
  const errorLine = JSON.stringify({
    isApiErrorMessage: true,
    error: 'authentication_failed',
    timestamp: new Date(now).toISOString(),
    message: { content: 'Login expired · Please run /login' },
  })
  await onFallbackTick({ env: ENV, fetch: w.fetch, file: b.file, tail: () => [errorLine] })

  assert.equal(fallbackActive(b.file), true)
  const spawn = w.core.find((c) => c.route === '/api/agents/spawn')
  assert.ok(spawn, 'the lost message is replayed right away — a fallback session is spawned for it, not left for the next real message')
  assert.match(spawn.body.task, /\[Telegram from 111\] Hallo/)
  // …and it is in the handoff log too, so the eventual handback names it.
  assert.ok(readState(b.file).fallback.log.some((e) => e.dir === 'in' && e.text === 'Hallo'))
})

test('REGRESSION: a replayed message is NEVER replayed a second time in a later episode', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-main', status: 'idle' }], describeById: { 'kb-main': { claudeSessionId: 'uuid-1', worktree: '/v' } } })
  const b = build({ world: w, state: { sessionId: 'kb-main' } })

  await b.inbound.handleOne(update(1, text(1, 'Hallo', HOME)))
  const now = Date.now()
  const err1 = JSON.stringify({ isApiErrorMessage: true, error: 'authentication_failed', timestamp: new Date(now).toISOString(), message: { content: 'Login expired' } })
  await onFallbackTick({ env: ENV, fetch: w.fetch, file: b.file, tail: () => [err1] })
  assert.equal(w.core.filter((c) => c.route === '/api/agents/spawn').length, 1, 'replayed exactly once')
  assert.deepEqual(readState(b.file).mainDeliveries, [], 'consumed — nothing left to replay again')

  // Hand back, then block again shortly after, still well inside the 30-min window.
  await switchToMain({ env: ENV, fetch: w.fetch, file: b.file })
  assert.equal(fallbackActive(b.file), false)
  const err2 = JSON.stringify({ isApiErrorMessage: true, error: 'rate_limit', timestamp: new Date(now + 60000).toISOString(), message: { content: 'x · resets 8pm (UTC)' } })
  await onFallbackTick({ env: ENV, fetch: w.fetch, file: b.file, tail: () => [err2] })
  assert.equal(fallbackActive(b.file), true)
  assert.equal(w.core.filter((c) => c.route === '/api/agents/spawn').length, 1, 'still exactly one spawn — "Hallo" was not replayed a second time')
})

test('the lost-message guard never fires for a block that pre-dates the message (nothing to replay, nothing double-sent)', async () => {
  const w = makeWorld({ describeById: { 'kb-main': { claudeSessionId: 'uuid-1', worktree: '/v' } } })
  const { file } = build({ world: w, state: { sessionId: 'kb-main', mainDeliveries: [{ at: new Date(Date.now() - 20 * 60000).toISOString(), chatId: HOME, text: 'alte Nachricht' }] } })
  const now = Date.now()
  // a GOOD assistant turn sits between the old delivery and the error — so cutoffAt lands after it.
  const good = new Date(now - 60000).toISOString()
  const err = JSON.stringify({ isApiErrorMessage: true, error: 'rate_limit', timestamp: new Date(now).toISOString(), message: { content: 'x · resets 8pm (UTC)' } })
  const goodLine = JSON.stringify({ type: 'assistant', timestamp: good, message: { content: [{ type: 'text', text: 'ok' }] } })
  await onFallbackTick({ env: ENV, fetch: w.fetch, file, tail: () => [goodLine, err] })
  assert.equal(fallbackActive(file), true)
  assert.equal(w.core.filter((c) => c.route === '/api/agents/spawn').length, 0, 'the stale message is correctly left out — it was already answered before the error')
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
    // a fresh episode (switchedAt = now) — an episode WITHOUT a start time
    // probes at once instead, see the 25.11.2026 regression further down
    state: { sessionId: 'kb-main', fallback: { active: true, reason: 'rate_limit', resetAt: Date.now() + 3600000, switchedAt: new Date().toISOString(), fallbackSessionId: 'kb-fb', noted: true, log: [] } },
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

/* ===================================================================== *
 * Hardening after the outages of 24./25.11.2026 — one block per finding.
 * ===================================================================== */

const MAIN_UUID = { claudeSessionId: 'uuid-main', worktree: '/v' }
const FB_UUID = { claudeSessionId: 'uuid-fb', worktree: '/v' }
const at = (msAgo) => new Date(Date.now() - msAgo).toISOString()
const apiErr = (fields, msAgo = 0) => JSON.stringify({ type: 'assistant', isApiErrorMessage: true, timestamp: at(msAgo), ...fields })
const goodTurn = (msAgo) => JSON.stringify({ type: 'assistant', timestamp: at(msAgo), message: { content: [{ type: 'text', text: 'ok' }] } })
/** A tail() that answers per transcript: the fake path is "<worktree>/<uuid>". */
const tails = (byUuid) => ({ buildPath: (_w, uuid) => uuid, tail: (p) => byUuid[p] || null })
const CREDITS_402 = { error: 'unknown', apiErrorStatus: 402, apiErrorType: 'billing_error', message: { content: 'API Error: 402 This request would exceed your available credits given your current in-flight requests.' } }
const REFUSAL = { error: 'invalid_request', refusingModel: 'claude-opus-4-8', message: { content: "API Error: Opus 4.8 can't help with this. Start a new session to continue.\n\nDetails: `[general_harms]`" } }
const CONN_LOST = { error: 'server_error', message: { content: 'API Error: Connection lost mid-response. The response above may be incomplete.' } }
const STANDING = 'kb-telegram-channel-a-standing-chat-session' // the id both sessions had on 25.11.

/* --- 1. the fallback session gets its OWN id, never the main session's -- */

test('REGRESSION 1 (25.11.): with the old main purged, a fallback spawned WITHOUT the header (noted) still gets its own kb-telegram-fallback-… id', async () => {
  // The exact trigger: main's id no longer registered (core hands it out
  // again), and `noted: true` left the task starting with the brief itself —
  // which used to slug to the main session's id.
  const w = makeWorld({ coreIds: true })
  const { file } = build({ world: w, state: { sessionId: STANDING, fallback: { active: true, reason: 'rate_limit', noted: true, log: [] } } })
  const r = await deliverToFallback({ chatId: HOME, text: 'hallo?' }, { env: ENV, fetch: w.fetch, file })
  assert.equal(r.ok, true)
  assert.match(r.id, /^kb-telegram-fallback-\d{8}-\d{6}-ersatz$/, 'own prefix, unique stamp, ends cleanly at core’s 40-char cut')
  assert.notEqual(r.id, STANDING)
  const st = readState(file)
  assert.equal(st.sessionId, STANDING, 'the main session id is never overwritten')
  assert.notEqual(st.fallback.fallbackSessionId, st.sessionId)
})

test('REGRESSION 1: a fresh standing session gets a unique kb-telegram-channel-…-session id, never the fallback’s', async () => {
  const w = makeWorld({ coreIds: true })
  const b = build({ world: w })
  await b.inbound.handleOne(update(1, text(1, 'hi', HOME)))
  const id = readState(b.file).sessionId
  assert.match(id, /^kb-telegram-channel-\d{8}-\d{6}-session$/)
})

test('REGRESSION 1 (self-heal): a state file that still has sessionId == fallbackSessionId spawns a fresh CLAUDE session instead of prompting the GPT one', async () => {
  const w = makeWorld({ coreIds: true, sessions: [{ id: STANDING, status: 'idle' }] })
  const b = build({ world: w, state: { sessionId: STANDING, fallback: { active: false, fallbackSessionId: STANDING, providerUsed: 'gpt-openrouter', log: [] } } })
  await b.inbound.handleOne(update(1, text(1, 'bist du Claude?', HOME)))
  assert.equal(w.core.filter((c) => c.body?.id === STANDING && c.route !== '/api/agents/describe').length, 0, 'nothing goes to the GPT session')
  const spawn = w.core.find((c) => c.route === '/api/agents/spawn')
  assert.ok(spawn, 'a fresh standing session is spawned')
  assert.equal(spawn.body.provider, undefined, 'on the default (Claude) backend — no provider profile')
  assert.notEqual(readState(b.file).sessionId, STANDING, 'telegram.json now points at the new session')
})

/* --- 2. the probe ALWAYS comes due while active, and hands back -------- */

test('REGRESSION 2 (25.11.): the exact stuck state — active, switchedAt null, lastProbeAt null — probes on the next tick and hands back to a CLAUDE session', async () => {
  const w = makeWorld({ coreIds: true, sessions: [{ id: STANDING, status: 'idle' }] })
  const { file } = build({
    world: w,
    state: { sessionId: STANDING, fallback: { active: true, reason: 'rate_limit', switchedAt: null, lastProbeAt: null, fallbackSessionId: STANDING, providerUsed: 'gpt-openrouter', noted: true, log: [] } },
  })
  let probed = 0
  await onFallbackTick({ env: ENV, fetch: w.fetch, file, probe: async () => (++probed, true) })
  assert.equal(probed, 1, 'the probe fires — it used to wait for a switchedAt that never came')
  assert.equal(fallbackActive(file), false)
  const spawn = w.core.find((c) => c.route === '/api/agents/spawn')
  assert.ok(spawn && /SYSTEM-HANDOFF/.test(spawn.body.task), 'the handoff goes to a FRESH Claude session…')
  assert.equal(w.core.filter((c) => ['/api/agents/prompt', '/api/agents/queue'].includes(c.route) && c.body?.id === STANDING).length, 0, '…never back into the GPT session that held both ids')
})

test('2: activation stamps switchedAt even when a LIVE fallback session is reused, so the interval probe comes due', async () => {
  const env = { ...ENV, TELEGRAM_FALLBACK_PROBE_INTERVAL_MS: '1' }
  const w = makeWorld({ sessions: [{ id: 'kb-main', status: 'idle' }, { id: 'kb-fb', status: 'idle' }], describeById: { 'kb-main': MAIN_UUID } })
  const b = build({ world: w, env, state: { sessionId: 'kb-main', fallback: { active: false, fallbackSessionId: 'kb-fb', providerUsed: 'gpt-openrouter', noted: true, log: [] } } })
  await b.inbound.handleOne(update(1, text(1, 'Hallo', HOME)))
  await onFallbackTick({ env, fetch: w.fetch, file: b.file, probe: async () => false, ...tails({ 'uuid-main': [apiErr({ error: 'rate_limit', message: { content: 'x' } })] }) })
  const fb = readState(b.file).fallback
  assert.equal(fb.active, true)
  assert.ok(w.core.some((c) => c.route === '/api/agents/prompt' && c.body?.id === 'kb-fb'), 'the live fallback was reused (no spawn)')
  assert.ok(fb.switchedAt, 'switchedAt is set although nothing was spawned')
  await new Promise((r) => setTimeout(r, 5))
  let probed = false
  await onFallbackTick({ env, fetch: w.fetch, file: b.file, probe: async () => ((probed = true), false) })
  assert.equal(probed, true)
})

test('2: the handback hands over what the fallback left UNANSWERED, verbatim, as still open', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-main', status: 'idle' }, { id: 'kb-fb', status: 'idle' }] })
  const b = build({ world: w, state: { sessionId: 'kb-main', fallback: { active: true, reason: 'rate_limit', switchedAt: at(1000), fallbackSessionId: 'kb-fb', providerUsed: 'gpt-openrouter', noted: true, log: [] } } })
  await b.inbound.handleOne(update(1, text(1, 'Frage eins', HOME)))
  noteOutbound('Antwort auf eins', { file: b.file }) // what POST /api/telegram/send calls while active
  await b.inbound.handleOne(update(2, text(2, 'Frage zwei, ganz lang '.repeat(30), HOME)))
  const r = await switchToMain({ env: ENV, fetch: w.fetch, file: b.file })
  assert.equal(r.ok, true)
  const handoff = w.core.find((c) => c.route === '/api/agents/prompt' && c.body?.id === 'kb-main').body.text
  const [answered, open] = handoff.split('NOCH UNBEANTWORTET')
  assert.match(answered, /Frage eins/)
  assert.match(answered, /Antwort auf eins/)
  assert.doesNotMatch(answered, /Frage zwei/, 'an unanswered message is not listed as answered')
  assert.ok(open.includes(`[Telegram from ${HOME}] ${'Frage zwei, ganz lang '.repeat(30)}`), 'handed over in full, not cut at 300 chars')
})

/* --- 3. a fallback out of credits → Claude at once, else ONE note + buffer */

test('3: a 402 in the FALLBACK session probes Claude at once (no interval wait) and hands back on success — no note to Ko', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-main', status: 'idle' }, { id: 'kb-fb', status: 'idle' }], describeById: { 'kb-fb': FB_UUID } })
  const { file } = build({ world: w, state: { sessionId: 'kb-main', fallback: { active: true, reason: 'rate_limit', switchedAt: at(60000), fallbackSessionId: 'kb-fb', providerUsed: 'gpt-openrouter', noted: true, log: [], pending: [{ chatId: HOME, text: 'noch offen', at: at(20000) }] } } })
  let probed = 0
  await onFallbackTick({ env: ENV, fetch: w.fetch, file, probe: async () => (++probed, true), ...tails({ 'uuid-fb': [apiErr(CREDITS_402, 10000)] }) })
  assert.equal(probed, 1)
  assert.equal(fallbackActive(file), false, 'back on Claude')
  assert.ok(w.core.some((c) => c.route === '/api/agents/prompt' && c.body?.id === 'kb-main' && /noch offen/.test(c.body.text)))
  assert.equal(w.sent.length, 0, 'Claude answers — no outage note needed')
})

test('3: 402 in the fallback AND Claude down → exactly ONE direct note per outage, and every message is buffered, not sent or dropped', async () => {
  const env = { ...ENV, TELEGRAM_FALLBACK_PROBE_INTERVAL_MS: '1' }
  const w = makeWorld({ sessions: [{ id: 'kb-main', status: 'idle' }, { id: 'kb-fb', status: 'idle' }], describeById: { 'kb-fb': FB_UUID } })
  const b = build({ world: w, env, state: { sessionId: 'kb-main', fallback: { active: true, reason: 'rate_limit', switchedAt: at(60000), fallbackSessionId: 'kb-fb', providerUsed: 'gpt-openrouter', noted: true, log: [] } } })
  const t = tails({ 'uuid-fb': [apiErr(CREDITS_402, 10000)] })
  await onFallbackTick({ env, fetch: w.fetch, file: b.file, probe: async () => false, ...t })
  assert.equal(w.sent.length, 1)
  assert.match(w.sent[0].body.text, /KI gerade nicht erreichbar/)
  assert.match(w.sent[0].body.text, /Guthaben leer/)
  assert.equal(String(w.sent[0].body.chat_id), HOME)

  const before = w.core.length
  await b.inbound.handleOne(update(1, text(1, 'Hallo? Jemand da?', HOME)))
  assert.equal(w.core.slice(before).filter((c) => c.route !== '/api/agents' && c.route !== '/api/agents/describe').length, 0, 'nothing is sent into the dead fallback')
  assert.equal(w.sent.length, 1, 'no "can’t reach the agent" reply either — the one note already said it')
  assert.equal(readState(b.file).fallback.pending.at(-1).text, 'Hallo? Jemand da?')

  await new Promise((r) => setTimeout(r, 5))
  await onFallbackTick({ env, fetch: w.fetch, file: b.file, probe: async () => false, ...t })
  assert.equal(w.sent.length, 1, 'still ONE note for the whole outage')

  await new Promise((r) => setTimeout(r, 5))
  await onFallbackTick({ env, fetch: w.fetch, file: b.file, probe: async () => true, ...t })
  assert.equal(fallbackActive(b.file), false, 'Claude is back → handed back')
  const handoff = w.core.find((c) => c.route === '/api/agents/prompt' && c.body?.id === 'kb-main').body.text
  assert.match(handoff, /NOCH UNBEANTWORTET[\s\S]*Hallo\? Jemand da\?/, 'the buffered message reaches Claude')
  assert.equal(readState(b.file).fallback.outage, null)
})

test('3: a 402 left over from an EARLIER episode (older than switchedAt) does not count as the fallback failing', async () => {
  const w = makeWorld({ describeById: { 'kb-fb': FB_UUID } })
  const { file } = build({ world: w, state: { sessionId: 'kb-main', fallback: { active: true, reason: 'rate_limit', switchedAt: at(1000), fallbackSessionId: 'kb-fb', noted: true, log: [] } } })
  let probed = false
  await onFallbackTick({ env: ENV, fetch: w.fetch, file, probe: async () => ((probed = true), false), ...tails({ 'uuid-fb': [apiErr(CREDITS_402, 3600000)] }) })
  assert.equal(probed, false)
  assert.equal(readState(file).fallback.outage ?? null, null)
})

/* --- 4. a safety refusal replaces the standing session ----------------- */

test('4 (24.11.): a refusal ("Start a new session") closes the standing session and a FRESH one answers what was left open', async () => {
  const w = makeWorld({ coreIds: true, sessions: [{ id: 'kb-main', status: 'idle' }], describeById: { 'kb-main': MAIN_UUID } })
  const b = build({ world: w, state: { sessionId: 'kb-main' } })
  await b.inbound.handleOne(update(1, text(1, 'Und was meinst du dazu?', HOME)))
  await onFallbackTick({ env: ENV, fetch: w.fetch, file: b.file, probe: async () => assert.fail('no probe — Claude works, the session is poisoned'), ...tails({ 'uuid-main': [goodTurn(600000), apiErr(REFUSAL)] }) })
  assert.ok(w.core.some((c) => c.route === '/api/agents/kill' && c.body?.id === 'kb-main'), 'the refused session is closed')
  const spawn = w.core.find((c) => c.route === '/api/agents/spawn')
  assert.ok(spawn, 'a fresh session is spawned')
  assert.equal(spawn.body.provider, undefined, 'on Claude, not on a paid fallback')
  assert.match(spawn.body.task, /Sicherheitsfilter/)
  assert.match(spawn.body.task, /Und was meinst du dazu\?/)
  assert.match(spawn.body.task, /NICHT von dir aus erneut/, 'told not to reopen the file that tripped the filter')
  const st = readState(b.file)
  assert.match(st.sessionId, /^kb-telegram-channel-\d{8}-\d{6}-session$/, 'telegram.json now points at the new session')
  assert.equal(fallbackActive(b.file), false)
})

test('4: a SECOND refusal within 30 min replays nothing (it keeps tripping the filter) and tells Ko directly', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-main', status: 'idle' }], describeById: { 'kb-main': MAIN_UUID } })
  const b = build({ world: w, state: { sessionId: 'kb-main', mainRestarts: [Date.now() - 5 * 60000] } })
  await b.inbound.handleOne(update(1, text(1, 'nochmal', HOME)))
  await onFallbackTick({ env: ENV, fetch: w.fetch, file: b.file, ...tails({ 'uuid-main': [goodTurn(600000), apiErr(REFUSAL)] }) })
  assert.equal(w.core.filter((c) => c.route === '/api/agents/spawn').length, 0)
  assert.equal(readState(b.file).sessionId, null, 'unhooked — the next message spawns a clean session')
  assert.match(w.sent.at(-1).body.text, /abgelehnt/)
})

/* --- 5. a transient error does not flip onto the paid fallback --------- */

test('5: "Connection lost mid-response" that persists → Claude is probed; it answers → the SAME main session retries, no fallback', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-main', status: 'idle' }], describeById: { 'kb-main': MAIN_UUID } })
  const b = build({ world: w, state: { sessionId: 'kb-main' } })
  await b.inbound.handleOne(update(1, text(1, 'Wie wird das Wetter?', HOME)))
  const t = tails({ 'uuid-main': [goodTurn(600000), apiErr(CONN_LOST, 4 * 60000)] })
  await onFallbackTick({ env: ENV, fetch: w.fetch, file: b.file, probe: async () => true, ...t })
  assert.equal(fallbackActive(b.file), false, 'not switched to the paid fallback')
  assert.equal(w.core.filter((c) => c.route === '/api/agents/spawn').length, 0)
  const retry = w.core.filter((c) => c.route === '/api/agents/prompt' && c.body?.id === 'kb-main').at(-1)
  assert.match(retry.body.text, /Verbindungsfehler/)
  assert.match(retry.body.text, /Wie wird das Wetter\?/)
  // the same old error line on the next tick changes nothing
  const n = w.core.length
  await onFallbackTick({ env: ENV, fetch: w.fetch, file: b.file, probe: async () => assert.fail('not probed again'), ...t })
  assert.equal(w.core.slice(n).filter((c) => c.route !== '/api/agents/describe').length, 0)
})

test('5: a transient error that is still FRESH changes nothing at all', async () => {
  const w = makeWorld({ describeById: { 'kb-main': MAIN_UUID } })
  const { file } = build({ world: w, state: { sessionId: 'kb-main' } })
  await onFallbackTick({ env: ENV, fetch: w.fetch, file, probe: async () => assert.fail('no probe'), ...tails({ 'uuid-main': [apiErr(CONN_LOST, 1000)] }) })
  assert.equal(fallbackActive(file), false)
})

test('5: a persisting transient error with Claude NOT answering switches — and the episode is probe-able (point 2)', async () => {
  const w = makeWorld({ describeById: { 'kb-main': MAIN_UUID } })
  const { file } = build({ world: w, state: { sessionId: 'kb-main' } })
  await onFallbackTick({ env: ENV, fetch: w.fetch, file, probe: async () => false, ...tails({ 'uuid-main': [apiErr(CONN_LOST, 4 * 60000)] }) })
  const fb = readState(file).fallback
  assert.equal(fb.active, true)
  assert.equal(fb.reason, 'server_error')
  assert.ok(fb.switchedAt, 'start time set → the recovery probe comes due')
})

test('5: after two retries within 30 min the error no longer counts as transient — the fallback takes over', async () => {
  const w = makeWorld({ describeById: { 'kb-main': MAIN_UUID } })
  const { file } = build({ world: w, state: { sessionId: 'kb-main', mainRetries: [Date.now() - 20 * 60000, Date.now() - 10 * 60000] } })
  await onFallbackTick({ env: ENV, fetch: w.fetch, file, probe: async () => assert.fail('no retry probe past the cap'), ...tails({ 'uuid-main': [apiErr(CONN_LOST, 4 * 60000)] }) })
  assert.equal(fallbackActive(file), true)
})

test('after a handback, the main session’s OLD error line does not flip the channel straight back', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-main', status: 'idle' }], describeById: { 'kb-main': MAIN_UUID } })
  const { file } = build({ world: w, state: { sessionId: 'kb-main', fallback: { active: true, reason: 'rate_limit', switchedAt: at(3600000), fallbackSessionId: 'kb-fb', noted: true, log: [] } } })
  const oldErr = apiErr({ error: 'rate_limit', message: { content: 'x · resets 8pm (UTC)' } }, 3600000)
  await onFallbackTick({ env: ENV, fetch: w.fetch, file, probe: async () => true, ...tails({ 'uuid-main': [oldErr] }) })
  assert.equal(fallbackActive(file), false)
  await onFallbackTick({ env: ENV, fetch: w.fetch, file, probe: async () => true, ...tails({ 'uuid-main': [oldErr] }) })
  assert.equal(fallbackActive(file), false, 'the line from before the handback is ignored')
})

test('3: /ersatz during an outage ends the outage and really delivers to the fallback again (e.g. after topping up credits)', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-fb', status: 'idle' }] })
  const { file } = build({ world: w, state: { sessionId: 'kb-main', fallback: { active: true, reason: 'rate_limit', switchedAt: at(60000), fallbackSessionId: 'kb-fb', providerUsed: 'gpt-openrouter', noted: true, log: [], outage: { since: Date.now() - 1000, reason: 'billing_error', notifiedAt: Date.now() } } } })
  const r = await tryInterceptCommand('/ersatz', HOME, { env: ENV, fetch: w.fetch, file })
  assert.match(r.reply, /übernimmt jetzt/)
  assert.equal(readState(file).fallback.outage, null)
  assert.ok(w.core.some((c) => c.route === '/api/agents/prompt' && c.body?.id === 'kb-fb'))
})

/* --- keeping it cheap (README "Keeping the fallback cheap") ---------------
 * Measured 25.11.2026: 86 GPT calls in one morning, the fallback's context
 * from 61k up to 306k tokens per call, 3.93 $ for that session alone. */

const ACTIVE = (extra = {}) => ({ active: true, reason: 'rate_limit', resetText: 'resets 8pm (UTC)', switchedAt: at(3600000), fallbackSessionId: 'kb-fb', providerUsed: 'gpt-openrouter', noted: true, log: [], ...extra })
const exchanges = (n, long = '') =>
  Array.from({ length: n }, (_, i) => [
    { dir: 'in', text: `Frage ${i + 1}${long}`, at: at((n - i) * 60000) },
    { dir: 'out', text: `Antwort ${i + 1}${long}`, at: at((n - i) * 60000 - 30000) },
  ]).flat()

test('1 (context cap): an IDLE fallback at the cap is replaced — fresh lean spawn with a SHORT handover, the old one torn down with cleanup (not kill)', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-fb', status: 'idle', contextTokens: 61000 }] })
  const long = ' — mit sehr viel Text dahinter'.repeat(20)
  const { file, log } = build({ world: w, state: { sessionId: 'kb-main', fallback: ACTIVE({ log: [...exchanges(10, long), { dir: 'in', text: 'offene Frage', at: at(1000) }], pending: [{ chatId: HOME, text: 'offene Frage', at: at(1000) }] }) } })
  const r = await deliverToFallback({ chatId: HOME, text: 'neue Frage' }, { env: ENV, fetch: w.fetch, file, log: (m) => log.push(m) })
  assert.equal(r.ok, true)
  assert.equal(r.via, 'spawn')
  assert.equal(r.replaced, 'kb-fb')
  const spawn = w.core.find((c) => c.route === '/api/agents/spawn')
  assert.equal(spawn.body.lean, true)
  assert.equal(spawn.body.provider, 'gpt-openrouter')
  const task = spawn.body.task
  assert.match(task, /ÜBERGABE/)
  assert.match(task, /nicht noch einmal an/, 'Ko already knows — no second announcement')
  assert.doesNotMatch(task, /Sag Ko EINMAL/)
  // the last 4 exchanges only, each cut short — never the whole log
  assert.ok(task.includes('← Ko: Frage 7') && task.includes('→ Ersatz: Antwort 10'))
  assert.ok(!task.includes('Frage 6 '), 'older exchanges stay out')
  assert.ok(!task.includes(long.repeat(1)), 'each line is cut short')
  assert.match(task, /Noch ohne Antwort[^\n]*\n\[Telegram from 111\] offene Frage/)
  assert.match(task, /Neue Nachricht:\n\[Telegram from 111\] neue Frage/)
  // torn down only AFTER the new one exists, and hard: cleanup, never the wrap-up turn of /kill
  const routes = w.core.map((c) => c.route)
  assert.ok(routes.indexOf('/api/agents/cleanup') > routes.indexOf('/api/agents/spawn'))
  assert.equal(w.core.find((c) => c.route === '/api/agents/cleanup').body.id, 'kb-fb')
  assert.ok(!routes.includes('/api/agents/kill'))
  assert.ok(!w.core.some((c) => (c.route === '/api/agents/prompt' || c.route === '/api/agents/queue') && c.body?.id === 'kb-fb'), 'nothing more goes into the full session')
  const fb = readState(file).fallback
  assert.equal(fb.fallbackSessionId, r.id)
  assert.equal(fb.counters.capRestarts, 1)
  assert.equal(fb.contextTokens, null, 'unknown until the new session has run a turn')
  assert.deepEqual(fb.pending.map((p) => p.text), ['offene Frage', 'neue Frage'], 'still owed an answer — kept for the handback')
  assert.ok(log.some((l) => /reached 61000 context tokens/.test(l)))
})

test('1: a full fallback left over from an EARLIER episode is replaced too — and the new episode is still announced', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-fb', status: 'idle', contextTokens: 70000 }] })
  const { file } = build({ world: w, state: { sessionId: 'kb-main', fallback: ACTIVE({ noted: false }) } })
  const r = await deliverToFallback({ chatId: HOME, text: 'hallo?' }, { env: ENV, fetch: w.fetch, file, log: () => {} })
  assert.equal(r.replaced, 'kb-fb')
  const task = w.core.find((c) => c.route === '/api/agents/spawn').body.task
  assert.match(task, /Sag Ko EINMAL/)
  assert.doesNotMatch(task, /Ko weiß schon/)
  assert.equal(readState(file).fallback.noted, true)
})

test('1: below the cap the live fallback is simply reused, and its context size is recorded', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-fb', status: 'idle', contextTokens: 59999 }] })
  const { file } = build({ world: w, state: { sessionId: 'kb-main', fallback: ACTIVE() } })
  const r = await deliverToFallback({ chatId: HOME, text: 'kurz?' }, { env: ENV, fetch: w.fetch, file })
  assert.equal(r.via, 'prompt')
  assert.equal(w.core.filter((c) => c.route === '/api/agents/spawn').length, 0)
  assert.equal(readState(file).fallback.contextTokens, 59999)
})

test('1: a RUNNING fallback over the cap is never replaced mid-turn — the message is queued, the next one checks again', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-fb', status: 'running', contextTokens: 250000 }] })
  const { file } = build({ world: w, state: { sessionId: 'kb-main', fallback: ACTIVE() } })
  const r = await deliverToFallback({ chatId: HOME, text: 'noch was' }, { env: ENV, fetch: w.fetch, file })
  assert.equal(r.via, 'queue')
  assert.ok(!w.core.some((c) => c.route === '/api/agents/spawn' || c.route === '/api/agents/cleanup'))
})

test('1: if no fresh fallback can be spawned, the full one still answers — expensive beats unanswered', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-fb', status: 'idle', contextTokens: 90000 }], spawnFails: ['gpt-openrouter', 'deepseek-openrouter'] })
  const { file } = build({ world: w, state: { sessionId: 'kb-main', fallback: ACTIVE() } })
  const r = await deliverToFallback({ chatId: HOME, text: 'hallo?' }, { env: ENV, fetch: w.fetch, file, log: () => {} })
  assert.equal(r.ok, true)
  assert.equal(r.via, 'prompt')
  assert.equal(r.id, 'kb-fb')
  assert.ok(!w.core.some((c) => c.route === '/api/agents/cleanup'), 'the only working session is not torn down')
  assert.equal(readState(file).fallback.counters.capRestarts, 0)
})

test('1: TELEGRAM_FALLBACK_MAX_CONTEXT_TOKENS sets the cap', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-fb', status: 'idle', contextTokens: 61000 }] })
  const env = { ...ENV, TELEGRAM_FALLBACK_MAX_CONTEXT_TOKENS: '100000' }
  const { file } = build({ world: w, env, state: { sessionId: 'kb-main', fallback: ACTIVE() } })
  assert.equal((await deliverToFallback({ chatId: HOME, text: 'a' }, { env, fetch: w.fetch, file })).via, 'prompt')
  const low = { ...ENV, TELEGRAM_FALLBACK_MAX_CONTEXT_TOKENS: '20000' }
  assert.equal((await deliverToFallback({ chatId: HOME, text: 'b' }, { env: low, fetch: w.fetch, file, log: () => {} })).via, 'spawn')
  assert.equal(fallbackStatus({ file, env: low }).context.max, 20000)
})

test('2+4 (lean start, brief rules): the fallback is spawned lean, with its own SHORT brief — not the standing session\'s', async () => {
  const w = makeWorld()
  const { file } = build({ world: w, state: { sessionId: 'kb-main', fallback: ACTIVE({ noted: false, fallbackSessionId: null }) } })
  await deliverToFallback({ chatId: HOME, text: 'Was steht heute an?' }, { env: ENV, fetch: w.fetch, file })
  const spawn = w.core.find((c) => c.route === '/api/agents/spawn')
  assert.equal(spawn.body.lean, true, 'core: no standing preamble, no evidence, read-only MCP, short tool list')
  const task = spawn.body.task
  assert.ok(task.length < 3500, `the whole opening turn is ${task.length} characters (the standing brief alone is ~5,200; the 25.11. opening prompt was ~39,000)`)
  assert.doesNotMatch(task, /PICTURES, VIDEOS AND DOCUMENTS|WHAT YOU CAN DO/, 'not the standing session\'s brief')
  // the reply contract survives
  assert.ok(task.includes('http://127.0.0.1:3001/api/telegram/send'))
  assert.match(task, /"voice":true/)
  // the operator's rules (point 4)
  assert.match(task, /Kümmere dich um die konkrete Frage/)
  assert.match(task, /Antworte kurz: 1–3 Sätze/)
  assert.match(task, /Schlag nur nach, wenn die Frage es braucht, und dann gezielt/)
  assert.match(task, /Keine großen Dateien, Logs, Verläufe[^\n]*vorsorglich/)
  assert.match(task, /Größere Aufträge[^\n]*NICHT selbst[^\n]*"fuer_claude"/)
  assert.match(task, /Sag Ko EINMAL/, 'the first fallback turn of an episode still announces itself')
  assert.match(task, /Ratenlimit erreicht \(resets 8pm \(UTC\)\)/)
})

test('3 (switch-over): lost messages are replayed as ONE turn, not one full-context turn each', async () => {
  const w = makeWorld({ describeById: { 'kb-main': MAIN_UUID } })
  const lost = [
    { at: at(50000), chatId: HOME, text: 'Erste' },
    { at: at(40000), chatId: HOME, text: 'Zweite' },
  ]
  const { file } = build({ world: w, state: { sessionId: 'kb-main', mainDeliveries: lost } })
  await onFallbackTick({ env: ENV, fetch: w.fetch, file, ...tails({ 'uuid-main': [goodTurn(120000), apiErr({ error: 'rate_limit', message: { content: 'x · resets 8pm (UTC)' } }, 1000)] }) })
  const deliveries = w.core.filter((c) => ['/api/agents/spawn', '/api/agents/prompt', '/api/agents/queue'].includes(c.route))
  assert.equal(deliveries.length, 1, 'one spawn carries both')
  assert.match(deliveries[0].body.task, /Diese 2 Nachrichten sind noch unbeantwortet[^\n]*\n\[Telegram from 111\] Erste\n\[Telegram from 111\] Zweite/)
  const fb = readState(file).fallback
  assert.deepEqual(fb.pending.map((p) => p.text), ['Erste', 'Zweite'])
  assert.equal(fb.counters.delivered, 2)
})

test('3 (handback): a 2–3-sentence summary + what was parked for Claude + the unanswered — never the whole log', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-main', status: 'idle' }, { id: 'kb-fb', status: 'idle' }] })
  const b = await (async () => {
    const built = build({ world: w, state: { sessionId: 'kb-main', fallback: ACTIVE({ log: exchanges(10) }) } })
    const app = express()
    app.use(built.routes)
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
    after(() => server.close())
    return { ...built, base: `http://127.0.0.1:${server.address().port}` }
  })()
  const send = (body) => fetch(`${b.base}/api/telegram/send`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${BEARER}` }, body: JSON.stringify(body) })
  assert.equal((await send({ text: 'x', fuer_claude: 42 })).status, 400, '"fuer_claude" must be a string')
  await b.inbound.handleOne(update(1, text(1, 'Bau mir bitte das Dashboard um', HOME)))
  assert.equal((await send({ text: 'Das macht Claude, sobald es zurück ist.', fuer_claude: 'Dashboard umbauen (Ko, 25.11.)' })).status, 200)
  await b.inbound.handleOne(update(2, text(2, 'Und wie spät ist es?', HOME)))
  const r = await switchToMain({ env: ENV, fetch: w.fetch, file: b.file })
  assert.equal(r.ok, true)
  const handoff = w.core.find((c) => c.route === '/api/agents/prompt' && c.body?.id === 'kb-main').body.text
  const [head, open] = handoff.split('NOCH UNBEANTWORTET')
  assert.match(head, /11 Nachrichten von Ko beantwortet — die sind SCHON BEANTWORTET/)
  assert.match(head, /Zuletzt: Ko „Bau mir bitte das Dashboard um“ → Ersatz „Das macht Claude, sobald es zurück ist\.“/)
  assert.match(head, /FÜR DICH VORGEMERKT[^\n]*\n- Dashboard umbauen \(Ko, 25\.11\.\)/)
  assert.ok(!head.includes('Frage 1,') && !head.includes('Antwort 9'), 'the log itself is not handed over')
  assert.ok(head.split(/(?<=[.!?“])\s+/).filter((x) => x.includes('SCHON BEANTWORTET') || x.startsWith('Themen') || x.startsWith('Zuletzt')).length <= 3)
  assert.ok(open.includes('[Telegram from 111] Und wie spät ist es?'))
  assert.deepEqual(readState(b.file).fallback.parked, [], 'handed over — cleared with the episode')
})

test('3: a parked job outside fallback mode is ignored (the standing session has no use for it)', () => {
  const file = newFile('parked-inactive')
  fs.writeFileSync(file, JSON.stringify({ fallback: { active: false } }))
  noteOutbound('hi', { file, forClaude: 'egal' })
  assert.deepEqual(readState(file).fallback.parked ?? [], [])
})

test('5 (status): the fallback\'s context size against the cap, the cap restarts, the parked jobs', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-fb', status: 'idle', contextTokens: 42000 }] })
  const { file } = build({ world: w, state: { sessionId: 'kb-main', fallback: ACTIVE({ parked: [{ text: 'x', at: at(0) }], counters: { capRestarts: 3 } }) } })
  await deliverToFallback({ chatId: HOME, text: 'hi' }, { env: ENV, fetch: w.fetch, file })
  const st = fallbackStatus({ file, env: ENV })
  assert.deepEqual(st.context, { tokens: 42000, max: 60000 })
  assert.equal(st.counters.capRestarts, 3)
  assert.equal(st.parked, 1)
  assert.equal(fallbackStatus({ file: newFile('fresh'), env: ENV }).counters.capRestarts, 0)
})

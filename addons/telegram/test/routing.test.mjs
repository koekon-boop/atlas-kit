/* ------------------------------------------------------------------ *
 * addons/telegram — routing per chat (TELEGRAM_CHAT_ROUTES): a chat id pinned to
 * an EXISTING dashboard session instead of the one standing session, e.g. Jessi's
 * Telegram chat always feeding her `kb-shop-setup` knowledge session.
 *
 * What this pins:
 *   · TELEGRAM_CHAT_ROUTES parsing ("<chat id>=<session id>[:<claude uuid>]"),
 *     robust against spaces/empty entries, and every routed chat id folded into
 *     the allowlist automatically (inbound AND /send);
 *   · a routed message to an idle target → /prompt, with the route's own footer
 *     (NOT the standing session's), never touching the standing session's state;
 *   · a routed message to a RUNNING target → /queue;
 *   · a dormant target → POST /api/agents/revive, then delivered;
 *   · a target that is closed/unknown (or whose revive fails) is NEVER recreated
 *     and NEVER redirected elsewhere: the message is stored, the sender is told
 *     plainly, and it is delivered — in order, nothing skipped — once the target
 *     is reachable again, either on the next message from that chat or via
 *     flushAllRoutes (the poller-tick retry);
 *   · /send with chat_id to a routed chat is allowed even though it is not in
 *     TELEGRAM_ALLOWED_CHAT_IDS;
 *   · status() lists every route with its forwarded count, last delivery, and
 *     how many messages are still pending.
 *
 * Hermetic: Telegram and core's agent routes are one stubbed `fetch`, exactly
 * bridge.test.mjs's pattern, extended with a sessions list the test mutates
 * between calls and a stub for POST /api/agents/revive.
 * Run: node --test addons/telegram/test/routing.test.mjs
 * ------------------------------------------------------------------ */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { buildRoutes, default as registerAddon } from '../api/register.mjs'
import { flushAllRoutes, forwardToRoute, readState } from '../api/agent.mjs'
import { allowedChatIds, chatRoutes } from '../api/config.mjs'

const express = createRequire(new URL('../../../api/src/', import.meta.url))('express')
const ctx = { name: 'telegram', express, Router: (o) => express.Router(o) }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-routing-test-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const JESSI = '6076694713'
const BEARER = 'dash-bearer'
const ENV = {
  TELEGRAM_BOT_TOKEN: 'bot-token',
  TELEGRAM_HOME_CHAT_ID: '111',
  TELEGRAM_CHAT_ROUTES: `${JESSI}=kb-shop-setup`,
  DASHBOARD_BEARER_TOKEN: BEARER,
  API_PORT: '3001',
}

/** Core's agent routes + Telegram in one stub, extended with /api/agents/revive. */
function makeWorld({ sessions = [], reviveOk = true, promptOk = true, telegramOk = true } = {}) {
  const w = { sent: [], core: [], sessions, reviveOk, promptOk, telegramOk, spawned: 0 }
  w.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined
    const json = (status, j) => ({ ok: status < 400, status, json: async () => j })
    if (url.startsWith('https://api.telegram.org/')) {
      if (!w.telegramOk) return json(400, { ok: false, description: 'boom' })
      w.sent.push({ url, body })
      return json(200, { ok: true, result: { message_id: 1 } })
    }
    const route = url.replace('http://127.0.0.1:3001', '')
    w.core.push({ method: opts.method, route, body })
    if (route === '/api/agents') return json(200, { sessions: w.sessions })
    if (route === '/api/agents/spawn') return json(200, { ok: true, id: `kb-atlas-${++w.spawned}` })
    if (route === '/api/agents/revive') {
      if (!w.reviveOk) return json(503, { ok: false, error: 'box low on memory' })
      const s = w.sessions.find((x) => x.id === body.id)
      if (s) s.status = 'running' // launchResume() flips it synchronously, same as core
      return json(200, { ok: true })
    }
    if (route === '/api/agents/prompt') return w.promptOk ? json(200, { ok: true }) : json(409, { ok: false, error: 'menu' })
    if (route === '/api/agents/queue') return json(200, { ok: true })
    return json(404, {})
  }
  return w
}

function build({ world = makeWorld(), env = ENV, name = 'state', startPoller = false } = {}) {
  const file = path.join(TMP, `${name}-${crypto.randomUUID()}.json`)
  const log = []
  const { routes, inbound } = buildRoutes(ctx, { env, fetch: world.fetch, log: (m) => log.push(m), file, startPoller })
  return { routes, inbound, world, file, log }
}

const update = (id, m) => ({ update_id: id, message: m })
const text = (id, body, chatId) => ({ message_id: id, chat: { id: Number(chatId) }, text: body })

/* --- TELEGRAM_CHAT_ROUTES parsing -------------------------------------------- */

test('chatRoutes: "<chat id>=<session id>" and the optional ":<claude uuid>"', () => {
  assert.deepEqual(chatRoutes({ TELEGRAM_CHAT_ROUTES: `${JESSI}=kb-shop-setup` }), { [JESSI]: { sessionId: 'kb-shop-setup' } })
  assert.deepEqual(
    chatRoutes({ TELEGRAM_CHAT_ROUTES: `${JESSI}=kb-shop-setup:5a306058-da69-4177-8e61-cef1cd9ec0e8` }),
    { [JESSI]: { sessionId: 'kb-shop-setup', claudeSessionId: '5a306058-da69-4177-8e61-cef1cd9ec0e8' } },
  )
})

test('chatRoutes: several routes, robust against spaces, empty entries, no "="', () => {
  assert.deepEqual(
    chatRoutes({ TELEGRAM_CHAT_ROUTES: ` ${JESSI} = kb-shop-setup , 222=kb-two:uuid-2 ,, nonsense, 333=` }),
    { [JESSI]: { sessionId: 'kb-shop-setup' }, 222: { sessionId: 'kb-two', claudeSessionId: 'uuid-2' } },
  )
  assert.deepEqual(chatRoutes({}), {})
  assert.deepEqual(chatRoutes({ TELEGRAM_CHAT_ROUTES: '' }), {})
})

test('allowedChatIds: every routed chat id is folded in automatically, on top of the home chat or an explicit list', () => {
  assert.deepEqual(allowedChatIds({ TELEGRAM_HOME_CHAT_ID: '111', TELEGRAM_CHAT_ROUTES: `${JESSI}=kb-shop-setup` }).sort(), ['111', JESSI].sort())
  assert.deepEqual(
    allowedChatIds({ TELEGRAM_ALLOWED_CHAT_IDS: '111,222', TELEGRAM_CHAT_ROUTES: `${JESSI}=kb-shop-setup` }).sort(),
    ['111', '222', JESSI].sort(),
  )
  // no duplicate if the operator also lists it explicitly
  assert.deepEqual(allowedChatIds({ TELEGRAM_ALLOWED_CHAT_IDS: `111,${JESSI}`, TELEGRAM_CHAT_ROUTES: `${JESSI}=kb-shop-setup` }).sort(), ['111', JESSI].sort())
})

/* --- a routed message reaches the ROUTE's target, not the standing session ---- */

test('a routed chat, target idle: /prompt carries the route\'s own footer, never the standing-session one', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-shop-setup', status: 'idle' }] })
  const b = build({ world: w })
  await b.inbound.handleOne(update(1, text(1, 'Was ist der Stand?', JESSI)))
  assert.equal(w.spawned, 0, 'never spawns for a route')
  const p = w.core.find((c) => c.route === '/api/agents/prompt')
  assert.ok(p)
  assert.equal(p.body.id, 'kb-shop-setup')
  assert.match(p.body.text, new RegExp(`\\[Telegram from ${JESSI}\\] Was ist der Stand\\?`))
  assert.match(p.body.text, /NUR per POST http:\/\/127\.0\.0\.1:3001\/api\/telegram\/send/)
  assert.match(p.body.text, new RegExp(`"chat_id":"${JESSI}"`))
  assert.match(p.body.text, /voice":true/)
  assert.doesNotMatch(p.body.text, /Reply with a POST to \/api\/telegram\/send — the terminal/, 'not the standing-session footer')
  assert.equal(b.inbound.counters.forwarded, 1)
  assert.equal(w.sent.length, 0, 'the target session answers, not the bridge')
  assert.equal(JSON.parse(fs.readFileSync(b.file, 'utf-8')).sessionId, undefined, 'the standing session is untouched')
})

test('a routed chat, target RUNNING: /queue, not /prompt', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-shop-setup', status: 'running' }] })
  const b = build({ world: w })
  await b.inbound.handleOne(update(1, text(1, 'während du arbeitest', JESSI)))
  assert.ok(w.core.some((c) => c.route === '/api/agents/queue' && c.body.id === 'kb-shop-setup'))
  assert.ok(!w.core.some((c) => c.route === '/api/agents/prompt'))
  assert.equal(b.inbound.counters.forwarded, 1)
})

test('a routed chat, target DORMANT: revive, then the message still gets delivered (as a fresh /prompt)', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-shop-setup', status: 'dormant' }] })
  const b = build({ world: w })
  await b.inbound.handleOne(update(1, text(1, 'bist du da?', JESSI)))
  const revive = w.core.find((c) => c.route === '/api/agents/revive')
  assert.ok(revive)
  assert.equal(revive.body.id, 'kb-shop-setup')
  const p = w.core.find((c) => c.route === '/api/agents/prompt')
  assert.ok(p, 'delivered right after the revive, not left for later')
  assert.equal(b.inbound.counters.forwarded, 1)
  assert.equal(w.sent.length, 0)
})

test('a non-routed chat is unaffected: still the standing session, even with routes configured', async () => {
  const w = makeWorld()
  const b = build({ world: w, env: { ...ENV, TELEGRAM_ALLOWED_CHAT_IDS: `111,${JESSI}` } })
  await b.inbound.handleOne(update(1, text(1, 'vom Operator', '111')))
  assert.equal(w.spawned, 1, 'the home chat still spawns/uses the standing session')
  assert.equal(JSON.parse(fs.readFileSync(b.file, 'utf-8')).sessionId, 'kb-atlas-1')
  assert.ok(!w.core.some((c) => c.route === '/api/agents/revive'))
})

/* --- closed / unknown target and a failed revive: stored, never recreated, never redirected --- */

test('target closed/unknown (not in GET /api/agents): stored, the sender told plainly, no spawn, no redirect', async () => {
  const w = makeWorld({ sessions: [] }) // kb-shop-setup is gone entirely
  const b = build({ world: w })
  await b.inbound.handleOne(update(1, text(1, 'hallo?', JESSI)))
  assert.equal(w.spawned, 0, 'never recreated under a fresh id')
  assert.ok(!w.core.some((c) => c.route === '/api/agents/prompt' || c.route === '/api/agents/queue'))
  assert.equal(w.sent.length, 1)
  assert.match(w.sent[0].body.text, /nicht erreichbar/)
  assert.equal(b.inbound.counters.forwardErrors, 1)
  const st = readState(b.file)
  assert.equal(st.routes[JESSI].pending.length, 1)
  assert.match(st.routes[JESSI].pending[0].text, /hallo\?/)
})

test('revive failing (box low on memory): stored exactly like a closed target, same message to the sender', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-shop-setup', status: 'dormant' }], reviveOk: false })
  const b = build({ world: w })
  await b.inbound.handleOne(update(1, text(1, 'bist du da?', JESSI)))
  assert.equal(w.spawned, 0)
  assert.ok(!w.core.some((c) => c.route === '/api/agents/prompt' || c.route === '/api/agents/queue'))
  assert.match(w.sent[0].body.text, /nicht erreichbar/)
  assert.equal(readState(b.file).routes[JESSI].pending.length, 1)
})

test('a stored message is delivered — IN ORDER, nothing skipped — once the sender writes again and the target is back', async () => {
  const w = makeWorld({ sessions: [] })
  const b = build({ world: w })
  await b.inbound.handleOne(update(1, text(1, 'erste', JESSI))) // stored: target gone
  assert.equal(readState(b.file).routes[JESSI].pending.length, 1)
  w.sessions = [{ id: 'kb-shop-setup', status: 'idle' }] // the base is back
  await b.inbound.handleOne(update(2, text(2, 'zweite', JESSI)))
  const prompts = w.core.filter((c) => c.route === '/api/agents/prompt').map((c) => c.body.text)
  // both delivered, oldest first, nothing skipped — the stub does not simulate the
  // idle→running transition a real /prompt causes, so both happen to go via /prompt here
  assert.equal(w.core.filter((c) => c.route === '/api/agents/prompt' || c.route === '/api/agents/queue').length, 2)
  assert.match(prompts.join('\n'), /erste/)
  assert.equal(readState(b.file).routes[JESSI].pending.length, 0)
  assert.equal(readState(b.file).routes[JESSI].forwarded, 2)
})

test('flushAllRoutes (the poller-tick retry): delivers a stored message without the sender writing again, and costs no call for a route with nothing pending', async () => {
  const w = makeWorld({ sessions: [] })
  const file = path.join(TMP, `flush-${crypto.randomUUID()}.json`)
  await forwardToRoute({ chatId: JESSI, text: 'gespeichert' }, { sessionId: 'kb-shop-setup' }, { env: ENV, fetch: w.fetch, file })
  assert.equal(readState(file).routes[JESSI].pending.length, 1)
  const before = w.core.length
  await flushAllRoutes({}, { env: ENV, fetch: w.fetch, file }) // no routes configured at all → no calls
  assert.equal(w.core.length, before)
  await flushAllRoutes({ [JESSI]: { sessionId: 'kb-shop-setup' } }, { env: ENV, fetch: w.fetch, file })
  assert.equal(readState(file).routes[JESSI].pending.length, 1, 'still gone — unchanged')
  w.sessions = [{ id: 'kb-shop-setup', status: 'idle' }]
  await flushAllRoutes({ [JESSI]: { sessionId: 'kb-shop-setup' } }, { env: ENV, fetch: w.fetch, file })
  assert.equal(readState(file).routes[JESSI].pending.length, 0)
  assert.ok(w.core.some((c) => c.route === '/api/agents/prompt' && c.body.id === 'kb-shop-setup'))
})

/* --- /send to a routed chat --------------------------------------------------- */

async function serve(opts) {
  const b = build(opts)
  const app = express()
  app.use(b.routes)
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  after(() => server.close())
  return { ...b, base: `http://127.0.0.1:${server.address().port}` }
}

const send = (s, body) =>
  fetch(`${s.base}/api/telegram/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${BEARER}` },
    body: JSON.stringify(body),
  })

test('POST /send: chat_id to a routed chat is allowed even though it is not in TELEGRAM_ALLOWED_CHAT_IDS', async () => {
  const s = await serve()
  const r = await send(s, { chat_id: JESSI, text: 'Antwort an Jessi' })
  assert.equal(r.status, 200)
  assert.equal(s.world.sent[0].body.chat_id, JESSI)
})

/* --- status() ------------------------------------------------------------------ */

test('status() lists every route: its target session, forwarded count, last delivery, pending', () => {
  const file = path.join(TMP, `status-${crypto.randomUUID()}.json`)
  fs.writeFileSync(file, JSON.stringify({
    routes: { [JESSI]: { forwarded: 3, lastDeliveredAt: '2026-10-01T00:00:00.000Z', pending: [{ text: 'x', at: '2026-10-02T00:00:00.000Z' }] } },
  }))
  // registerAddon() with a token set always tries to start a REAL poller (buildRoutes'
  // default startPoller: true) — pre-occupy the lock with a foreign, alive pid so
  // createPoller loses the race and returns with an empty loop body (see bridge.test.mjs
  // "status() with everything set"); otherwise a real async backoff loop leaks past this test.
  fs.writeFileSync(path.join(path.dirname(file), 'telegram-poller.lock'), JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }))
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('offline') }
  const keep = { ...process.env }
  Object.assign(process.env, ENV, { TELEGRAM_STATE_FILE: file })
  try {
    const st = registerAddon(ctx).status()
    assert.deepEqual(st.chatRoutes, [{ chat: '…4713', session: 'kb-shop-setup', forwarded: 3, lastDeliveredAt: '2026-10-01T00:00:00.000Z', pending: 1 }])
  } finally {
    globalThis.fetch = realFetch
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]
    Object.assign(process.env, keep)
  }
})

test('status(): with TELEGRAM_CHAT_ROUTES unset, chatRoutes is an empty list', () => {
  const file = path.join(TMP, `status-none-${crypto.randomUUID()}.json`)
  fs.writeFileSync(path.join(path.dirname(file), 'telegram-poller.lock'), JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }))
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('offline') }
  const keep = { ...process.env }
  const { TELEGRAM_CHAT_ROUTES, ...noRoutes } = ENV
  Object.assign(process.env, noRoutes, { TELEGRAM_STATE_FILE: file })
  delete process.env.TELEGRAM_CHAT_ROUTES
  try {
    assert.deepEqual(registerAddon(ctx).status().chatRoutes, [])
  } finally {
    globalThis.fetch = realFetch
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]
    Object.assign(process.env, keep)
  }
})

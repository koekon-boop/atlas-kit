/* ------------------------------------------------------------------ *
 * addons/telegram — the bridge end to end: the standing session lifecycle over
 * core's agent routes, the session brief, inbound handling (text, allowlist,
 * unsupported types), and the bearer-gated /send route on a REAL Express app.
 *
 * What this pins:
 *   · the standing session: spawn once, then prompt/queue, respawn if gone —
 *     ONE session regardless of which allowed chat wrote;
 *   · the allowlist: an unknown chat is dropped silently, no reply, no agent;
 *   · non-text messages get one short "can't read that" and never reach the agent;
 *   · /send is bearer-gated, defaults to the home chat, refuses a foreign chat_id;
 *   · the addon loads with NO env set and status() says so, honestly;
 *   · register() never starts a poller when TELEGRAM_BOT_TOKEN is unset.
 *
 * Hermetic: Telegram and core's agent routes are one stubbed `fetch`. No
 * webhook exists on this addon (see poller.test.mjs for getUpdates), so inbound
 * is exercised by calling inbound.handleOne(update) directly — exactly what
 * poller.mjs does per update in production.
 * Run: node --test addons/telegram/test/bridge.test.mjs
 * ------------------------------------------------------------------ */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { buildRoutes, default as registerAddon } from '../api/register.mjs'
import { sessionBrief } from '../api/agent.mjs'

const express = createRequire(new URL('../../../api/src/', import.meta.url))('express')
const ctx = { name: 'telegram', express, Router: (o) => express.Router(o) }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-test-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const BEARER = 'dash-bearer'
const ENV = {
  TELEGRAM_BOT_TOKEN: 'bot-token',
  TELEGRAM_HOME_CHAT_ID: '111',
  DASHBOARD_BEARER_TOKEN: BEARER,
  API_PORT: '3001',
}

/** One stub for both outbound targets (Telegram + core). `agents` scripts core's answers. */
function makeWorld({ sessions = [], promptOk = true, telegramOk = true } = {}) {
  const w = { sent: [], core: [], sessions, promptOk, telegramOk, spawned: 0 }
  w.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined
    const json = (status, j) => ({ ok: status < 400, status, json: async () => j })
    if (url.startsWith('https://api.telegram.org/')) {
      if (!w.telegramOk) return json(400, { ok: false, description: 'boom' })
      w.sent.push({ url, body })
      return json(200, { ok: true, result: { message_id: 1 } })
    }
    const route = url.replace('http://127.0.0.1:3001', '')
    w.core.push({ method: opts.method, route, body, auth: opts.headers?.Authorization })
    if (route === '/api/agents') return json(200, { sessions: w.sessions })
    if (route === '/api/agents/spawn') return json(200, { ok: true, id: `kb-atlas-${++w.spawned}` })
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

async function serve(opts) {
  const b = build(opts)
  const app = express()
  app.use(b.routes)
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  after(() => server.close())
  return { ...b, base: `http://127.0.0.1:${server.address().port}` }
}

const update = (id, m) => ({ update_id: id, message: m })
const text = (id, body, chatId = '111') => ({ message_id: id, chat: { id: Number(chatId) }, text: body })

/* --- inbound: text, allowlist, unsupported ------------------------------------- */

test('a text message reaches the standing session, marked with the chat id', async () => {
  const b = build()
  await b.inbound.handleOne(update(1, text(1, 'Was steht heute an?')))
  const spawn = b.world.core.find((c) => c.route === '/api/agents/spawn')
  assert.ok(spawn)
  assert.equal(spawn.auth, `Bearer ${BEARER}`)
  assert.equal(spawn.body.kind, 'knowledge')
  assert.equal(spawn.body.vault, 'atlas')
  assert.match(spawn.body.task, /\[Telegram from 111\] Was steht heute an\?/)
  assert.equal(b.inbound.counters.forwarded, 1)
  assert.equal(b.world.sent.length, 0, 'the agent answers, not the bridge')
})

test('allowlist: a chat outside TELEGRAM_ALLOWED_CHAT_IDS (and not the home chat) is dropped silently', async () => {
  const b = build()
  await b.inbound.handleOne(update(1, text(1, 'hello?', '999')))
  assert.equal(b.inbound.counters.dropped, 1)
  assert.equal(b.inbound.counters.forwarded, 0)
  assert.equal(b.world.sent.length, 0, 'a stranger gets no reply at all')
  assert.equal(b.world.core.length, 0)
})

test('allowlist: TELEGRAM_ALLOWED_CHAT_IDS adds a second chat, still into the SAME session', async () => {
  const w = makeWorld()
  const b = build({ world: w, env: { ...ENV, TELEGRAM_ALLOWED_CHAT_IDS: '111,222' } })
  await b.inbound.handleOne(update(1, text(1, 'von Ko', '111')))
  w.sessions = [{ id: 'kb-atlas-1', kind: 'knowledge', vault: 'atlas', status: 'idle' }] // the spawned session is now known to core
  await b.inbound.handleOne(update(2, text(2, 'von Jessi', '222')))
  assert.equal(w.spawned, 1, 'one shared session, not one per chat')
  assert.equal(b.inbound.counters.forwarded, 2)
  const tasks = w.core.filter((c) => c.route === '/api/agents/spawn' || c.route === '/api/agents/prompt').map((c) => c.body.task || c.body.text)
  assert.match(tasks.join('\n'), /from 111\]/)
  assert.match(tasks.join('\n'), /from 222\]/)
})

test('an EMPTY allowlist (no home chat, no explicit list) accepts nobody', async () => {
  const b = build({ env: { ...ENV, TELEGRAM_HOME_CHAT_ID: '' } })
  await b.inbound.handleOne(update(1, text(1, 'hi')))
  assert.equal(b.inbound.counters.dropped, 1)
  assert.equal(b.world.core.length, 0)
})

test('non-text messages get one short "can\'t read that" and never reach the agent', async () => {
  const b = build()
  await b.inbound.handleOne(update(1, { message_id: 1, chat: { id: 111 }, sticker: { file_id: 'x' } }))
  assert.equal(b.world.sent.length, 1)
  assert.match(b.world.sent[0].body.text, /noch nicht lesen/)
  assert.equal(b.world.core.length, 0)
  assert.equal(b.inbound.counters.unsupported, 1)
})

test('an update with no message (edited_message shape) is ignored, not an error', async () => {
  const b = build()
  await assert.doesNotReject(b.inbound.handleOne({ update_id: 1, edited_message: { message_id: 1, chat: { id: 111 }, text: 'edit' } }))
  assert.equal(b.world.core.length + b.world.sent.length, 0)
})

/* --- the session lifecycle --------------------------------------------------- */

test('first message spawns, the id is remembered in the state file, the next reuses it', async () => {
  const w = makeWorld()
  const b = build({ world: w })
  await b.inbound.handleOne(update(1, text(1, 'erste')))
  assert.equal(JSON.parse(fs.readFileSync(b.file, 'utf-8')).sessionId, 'kb-atlas-1')
  w.sessions = [{ id: 'kb-atlas-1', kind: 'knowledge', vault: 'atlas', status: 'idle' }]
  await b.inbound.handleOne(update(2, text(2, 'zweite')))
  assert.equal(w.spawned, 1, 'no second session')
  const p = w.core.find((c) => c.route === '/api/agents/prompt')
  assert.equal(p.body.id, 'kb-atlas-1')
  assert.match(p.body.text, /\[Telegram from 111\] zweite/)
})

test('a RUNNING session gets the message queued, not typed into the turn', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-atlas-7', status: 'running' }] })
  const b = build({ world: w })
  fs.writeFileSync(b.file, JSON.stringify({ sessionId: 'kb-atlas-7' }))
  await b.inbound.handleOne(update(1, text(1, 'während du arbeitest')))
  assert.ok(w.core.some((c) => c.route === '/api/agents/queue' && c.body.id === 'kb-atlas-7'))
  assert.ok(!w.core.some((c) => c.route === '/api/agents/prompt'))
})

test('a refused /prompt (open menu) falls back to /queue', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-atlas-7', status: 'idle' }], promptOk: false })
  const b = build({ world: w })
  fs.writeFileSync(b.file, JSON.stringify({ sessionId: 'kb-atlas-7' }))
  await b.inbound.handleOne(update(1, text(1, 'hi')))
  assert.ok(w.core.some((c) => c.route === '/api/agents/queue'))
})

test('a session that is gone or finished is replaced by a fresh spawn', async () => {
  for (const sessions of [[], [{ id: 'kb-atlas-7', status: 'done' }], [{ id: 'kb-atlas-7', status: 'dormant' }]]) {
    const w = makeWorld({ sessions })
    const b = build({ world: w })
    fs.writeFileSync(b.file, JSON.stringify({ sessionId: 'kb-atlas-7' }))
    await b.inbound.handleOne(update(1, text(1, 'hi')))
    assert.equal(w.spawned, 1)
    assert.equal(JSON.parse(fs.readFileSync(b.file, 'utf-8')).sessionId, 'kb-atlas-1')
  }
})

test('a broken agent route tells the sender instead of going silent', async () => {
  const w = makeWorld()
  const f = w.fetch
  w.fetch = async (url, opts) => (url.endsWith('/api/agents/spawn') ? { ok: false, status: 503, json: async () => ({ ok: false, error: 'no claude' }) } : f(url, opts))
  const b = build({ world: w })
  await b.inbound.handleOne(update(1, text(1, 'hi')))
  assert.equal(w.sent.length, 1)
  assert.match(w.sent[0].body.text, /erreiche den Agenten gerade nicht/)
  assert.equal(b.inbound.counters.forwardErrors, 1)
  assert.match(b.log.join('\n'), /spawn → 503 no claude/)
})

test('the session brief tells it to PUSH its reply through the send route, briefly, without tables', () => {
  const b = sessionBrief({ port: '3001' })
  assert.match(b, /curl -sS -X POST http:\/\/127\.0\.0\.1:3001\/api\/telegram\/send/)
  assert.match(b, /Authorization: Bearer \$DASHBOARD_BEARER_TOKEN/)
  assert.match(b, /NOBODY reads this terminal/)
  assert.match(b, /No tables, no code blocks/)
  assert.match(b, /language of the message/)
  assert.match(sessionBrief({ port: '4444' }), /127\.0\.0\.1:4444\/api\/telegram\/send/)
})

test('the brief mentions a second chat only when there is one — the default single-chat brief stays uncluttered', () => {
  assert.doesNotMatch(sessionBrief({ homeChatId: '111', otherChats: [] }), /MORE THAN ONE CHAT/)
  assert.match(sessionBrief({ homeChatId: '111', otherChats: ['222'] }), /MORE THAN ONE CHAT/)
})

test('the brief explains the media markers and voice replies (the whatsapp-equivalent combined brief)', () => {
  const b = sessionBrief()
  assert.match(b, /\[Bild empfangen: <path>\]/)
  assert.match(b, /\[Dokument empfangen: <path>, 3 Seiten\]/)
  assert.match(b, /\[Video empfangen: <path>, 12 s\]/)
  assert.match(b, /LOOK AT THEM with your normal tools/)
  assert.ok(b.includes('[Sprachnachricht, transkribiert]'))
  assert.match(b, /"voice":true/)
  assert.match(b, /MIRROR THE MEDIUM/)
})

/* --- /send ----------------------------------------------------------------- */

const send = (s, body, token = BEARER) =>
  fetch(`${s.base}/api/telegram/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })

test('POST /send is bearer-gated (constant-time) — and refuses when the server has no token', async () => {
  const s = await serve()
  assert.equal((await send(s, { text: 'x' }, null)).status, 401)
  assert.equal((await send(s, { text: 'x' }, 'wrong')).status, 401)
  assert.equal((await send(s, { text: 'x' }, `${BEARER}!`)).status, 401)
  assert.equal(s.world.sent.length, 0)
  const { DASHBOARD_BEARER_TOKEN, ...noToken } = ENV
  const open = await serve({ env: noToken })
  assert.equal((await send(open, { text: 'x' }, 'anything')).status, 500)
})

test('POST /send: `chat_id` defaults to the home chat; a foreign chat is refused', async () => {
  const s = await serve()
  const ok = await send(s, { text: 'Hallo' })
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { ok: true, sent: 1, parts: 1 })
  assert.equal(s.world.sent[0].body.chat_id, '111')
  const s2 = await serve({ env: { ...ENV, TELEGRAM_ALLOWED_CHAT_IDS: '111,222' } })
  assert.equal((await send(s2, { chat_id: '222', text: 'zweiter chat' })).status, 200)
  assert.equal(s2.world.sent[0].body.chat_id, '222')
  const bad = await send(s, { chat_id: '999', text: 'nope' })
  assert.equal(bad.status, 400)
  assert.equal((await send(s, { text: '  ' })).status, 400)
  assert.equal((await send(s, {})).status, 400)
})

test('POST /send: an over-long text is split into several sends', async () => {
  const s = await serve()
  const r = await send(s, { text: ['a'.repeat(3000), 'b'.repeat(3000), 'c'.repeat(3000)].join('\n\n') })
  assert.deepEqual(await r.json(), { ok: true, sent: 3, parts: 3 })
  assert.equal(s.world.sent.length, 3)
})

test("POST /send: Telegram's failure comes back as 502 with its status and text, and is logged", async () => {
  const s = await serve({ world: makeWorld({ telegramOk: false }) })
  const r = await send(s, { text: 'x' })
  assert.equal(r.status, 502)
  const j = await r.json()
  assert.deepEqual([j.ok, j.status, j.error], [false, 400, 'boom'])
  assert.match(s.log.join('\n'), /boom/)
})

test('POST /send: missing outbound credentials say exactly which', async () => {
  const s = await serve({ env: { ...ENV, TELEGRAM_BOT_TOKEN: '' } })
  const r = await send(s, { text: 'x' })
  assert.equal(r.status, 503)
  assert.match((await r.json()).error, /TELEGRAM_BOT_TOKEN/)
})

test('POST /send: a "voice" that is not a boolean is refused loudly', async () => {
  const s = await serve()
  for (const voice of ['true', 1, {}]) {
    const r = await send(s, { text: 'x', voice })
    assert.equal(r.status, 400)
    assert.match((await r.json()).error, /"voice" must be true or false/)
  }
})

/* --- loading with nothing configured ------------------------------------------ */

test('with NO env set the addon loads cleanly, status() reports it honestly, and no poller starts', () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('offline') } // status() probes the voice addon; never the real API
  const keep = { ...process.env }
  for (const k of Object.keys(process.env)) if (k.startsWith('TELEGRAM_') || k === 'DASHBOARD_BEARER_TOKEN') delete process.env[k]
  process.env.TELEGRAM_STATE_FILE = path.join(TMP, 'none.json')
  try {
    const m = registerAddon(ctx)
    assert.equal(typeof m.description, 'string')
    assert.ok(m.routes)
    assert.deepEqual(Object.keys(m).sort(), ['description', 'routes', 'status'])
    const st = m.status()
    assert.match(st.inbound, /NOT READY — set .*TELEGRAM_BOT_TOKEN.*TELEGRAM_HOME_CHAT_ID/)
    assert.match(st.outbound, /NOT READY — set .*TELEGRAM_BOT_TOKEN.*TELEGRAM_HOME_CHAT_ID/)
    assert.equal(st.allowedChats, 0)
    assert.equal(st.homeChat, null)
    assert.equal(st.session.session, 'none yet (created on the first message)')
    assert.deepEqual(st.poller, { owner: false, reason: 'TELEGRAM_BOT_TOKEN is not set' })
    assert.equal(JSON.stringify(st).includes('secret'), false)
  } finally {
    globalThis.fetch = realFetch
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]
    Object.assign(process.env, keep)
  }
})

test('status() with everything set says ready, and leaks no secret (the bot token especially — it lives in Bot API URLs)', async () => {
  // register()'s default buildRoutes() call always tries to start a REAL poller
  // when a token is set (that is the point of it) — so a token-set call to
  // registerAddon() would otherwise spin up a live async loop against whatever
  // global fetch happens to be, with real setTimeout backoff. Pre-occupying the
  // lock with a foreign, alive pid makes createPoller lose the race and return
  // with an empty loop body (see poller.test.mjs) — status() is exercised
  // truthfully (a live token, poller.owner: false) with nothing left running.
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('should never be called — no poller should run in this test') }
  const keep = { ...process.env }
  Object.assign(process.env, ENV, { TELEGRAM_STATE_FILE: path.join(TMP, 'ready.json') })
  fs.writeFileSync(process.env.TELEGRAM_STATE_FILE, JSON.stringify({ sessionId: 'kb-atlas-3', lastInboundAt: new Date().toISOString() }))
  fs.writeFileSync(path.join(TMP, 'telegram-poller.lock'), JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }))
  try {
    const st = registerAddon(ctx).status()
    assert.equal(st.inbound, 'ready')
    assert.equal(st.outbound, 'ready')
    assert.equal(st.allowedChats, 1)
    assert.equal(st.session.session, 'kb-atlas-3')
    assert.equal(st.poller.owner, false, 'lost the race to the pre-seeded foreign lock — confirms the guard, not a real poll')
    const dump = JSON.stringify(st)
    for (const v of [ENV.TELEGRAM_BOT_TOKEN, ENV.DASHBOARD_BEARER_TOKEN]) assert.equal(dump.includes(v), false)
  } finally {
    globalThis.fetch = realFetch
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]
    Object.assign(process.env, keep)
  }
})

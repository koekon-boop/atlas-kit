/* ------------------------------------------------------------------ *
 * addons/whatsapp — the bridge end to end, on a REAL Express app.
 *
 * What this pins:
 *   · the webhook verifies Meta's signature over the RAW body, refuses with no
 *     secret, answers 200 at once, then works asynchronously;
 *   · core's global JSON parser would eat the raw body — a webhook that arrives
 *     already parsed FAILS CLOSED (the Caddyfile's Content-Type rewrite is what
 *     keeps that from happening in production);
 *   · dedupe, the sender allowlist, statuses, non-text messages;
 *   · the session lifecycle (spawn once, then prompt/queue, respawn if gone)
 *     over core's routes, and the brief that tells the session how to reply;
 *   · /send is bearer-gated and only reaches allowlisted numbers;
 *   · the addon loads with NO env set and status() says so.
 *
 * Hermetic: Meta and core's agent routes are one stubbed `fetch` handed to
 * buildRoutes(); the test's own HTTP client is the real global fetch against an
 * OS-assigned loopback port. No credential is real, nothing leaves the process.
 * Run: node --test addons/whatsapp/test/bridge.test.mjs
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
const ctx = { name: 'whatsapp', express, Router: (o) => express.Router(o) }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-test-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const SECRET = 'app-secret'
const BEARER = 'dash-bearer'
const ENV = {
  WHATSAPP_VERIFY_TOKEN: 'v-token',
  WHATSAPP_APP_SECRET: SECRET,
  WHATSAPP_ACCESS_TOKEN: 'a-token',
  WHATSAPP_PHONE_NUMBER_ID: '555',
  WHATSAPP_ALLOWED_FROM: '4915112345678, +49 160 999',
  DASHBOARD_BEARER_TOKEN: BEARER,
  API_PORT: '3001',
}

/** One stub for both outbound targets. `agents` scripts core's answers. */
function makeWorld({ sessions = [], promptOk = true, metaOk = true } = {}) {
  const w = { sent: [], core: [], sessions, promptOk, metaOk, spawned: 0 }
  w.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined
    const json = (status, j) => ({ ok: status < 400, status, json: async () => j })
    if (url.startsWith('https://graph.facebook.com/')) {
      if (!w.metaOk) return json(400, { error: { message: 'boom', code: 100 } })
      w.sent.push({ url, headers: opts.headers, body })
      return json(200, { messages: [{ id: 'wamid.x' }] })
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

async function serve({ world = makeWorld(), env = ENV, globalJson = false, name = 'state' } = {}) {
  const file = path.join(TMP, `${name}-${crypto.randomUUID()}.json`)
  const log = []
  const { routes, inbound } = buildRoutes(ctx, { env, fetch: world.fetch, log: (m) => log.push(m), file })
  const app = express()
  // What core's server.mjs does before addon routers exist.
  if (globalJson) app.use(express.json({ limit: '64kb' }))
  app.use(routes)
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  after(() => server.close())
  return { base: `http://127.0.0.1:${server.address().port}`, world, inbound, file, log }
}

const sign = (raw, secret = SECRET) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`
const payload = (messages = [], statuses) =>
  JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: { messages, ...(statuses ? { statuses } : {}) } }] }] })
const text = (id, body, from = '4915112345678') => ({ id, from, type: 'text', text: { body }, timestamp: '1' })

/** POST as Meta would, through the Caddy rewrite (a non-JSON content type). */
const post = (s, body, headers = {}) =>
  fetch(`${s.base}/api/whatsapp/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-hub-signature-256': sign(body), ...headers },
    body,
  })

const until = async (fn, ms = 2000) => {
  const t = Date.now()
  while (!fn()) {
    if (Date.now() - t > ms) assert.fail('timed out waiting for the async work')
    await new Promise((r) => setTimeout(r, 5))
  }
}
const settle = () => new Promise((r) => setTimeout(r, 60))

/* --- the handshake ------------------------------------------------------- */

test('GET webhook: the right token → challenge as text/plain 200; wrong → 403', async () => {
  const s = await serve()
  const q = (t) => `${s.base}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${t}&hub.challenge=987`
  const ok = await fetch(q('v-token'))
  assert.equal(ok.status, 200)
  assert.match(ok.headers.get('content-type'), /^text\/plain/)
  assert.equal(await ok.text(), '987')
  assert.equal((await fetch(q('wrong'))).status, 403)
  assert.equal((await fetch(`${s.base}/api/whatsapp/webhook`)).status, 403)
})

/* --- signature ------------------------------------------------------------ */

test('POST webhook: bad or missing signature → 403, nothing forwarded', async () => {
  const s = await serve()
  const body = payload([text('m1', 'hi')])
  assert.equal((await post(s, body, { 'x-hub-signature-256': sign(body, 'other') })).status, 403)
  assert.equal((await post(s, body, { 'x-hub-signature-256': '' })).status, 403)
  await settle()
  assert.equal(s.world.core.length, 0)
  assert.equal(s.inbound.counters.badSignature, 2)
})

test('POST webhook: no WHATSAPP_APP_SECRET → refused, not waved through', async () => {
  const { WHATSAPP_APP_SECRET, ...noSecret } = ENV
  const s = await serve({ env: noSecret })
  const body = payload([text('m1', 'hi')])
  const r = await post(s, body, { 'x-hub-signature-256': sign(body, '') })
  assert.equal(r.status, 503)
  await settle()
  assert.equal(s.world.core.length, 0)
})

test('POST webhook: valid signature → 200 immediately, then the text reaches the agent', async () => {
  const s = await serve()
  const r = await post(s, payload([text('m1', 'Was steht heute an?')]))
  assert.equal(r.status, 200)
  await until(() => s.world.core.some((c) => c.route === '/api/agents/spawn'))
  const spawn = s.world.core.find((c) => c.route === '/api/agents/spawn')
  assert.equal(spawn.auth, `Bearer ${BEARER}`)
  assert.equal(spawn.body.kind, 'knowledge')
  assert.equal(spawn.body.vault, 'atlas')
  assert.match(spawn.body.task, /\[WhatsApp from 4915112345678\] Was steht heute an\?/)
  assert.equal(s.inbound.counters.forwarded, 1)
})

test('the signature is over the exact bytes: non-ASCII and escaped slashes verify', async () => {
  const s = await serve()
  // Meta escapes "/" and non-ASCII in its JSON; a re-serialised body would not match.
  const body = payload([text('m9', 'Grüße')]).replace('Grüße', 'Gr\\u00fc\\u00dfe \\/ ok')
  const r = await post(s, body)
  assert.equal(r.status, 200)
  await until(() => s.world.core.some((c) => c.route === '/api/agents/spawn'))
  assert.match(s.world.core.find((c) => c.route === '/api/agents/spawn').body.task, /Grüße \/ ok/)
})

test('core\'s global JSON parser would eat the body: an already-parsed webhook fails CLOSED', async () => {
  const s = await serve({ globalJson: true })
  const body = payload([text('m1', 'hi')])
  const r = await fetch(`${s.base}/api/whatsapp/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
    body,
  })
  assert.equal(r.status, 500)
  await settle()
  assert.equal(s.world.core.length, 0, 'an unverifiable body is never processed')
  assert.equal(s.inbound.counters.rawBodyMissing, 1)
  assert.match(s.log.join('\n'), /Content-Type/)
  // …and with the Caddy rewrite in place (non-JSON type) the same app works.
  assert.equal((await post(s, body)).status, 200)
})

test('POST webhook: verified but unparseable JSON → 400', async () => {
  const s = await serve()
  assert.equal((await post(s, '{not json')).status, 400)
})

/* --- what happens to a verified payload ------------------------------------ */

test('dedupe: Meta delivering the same message id twice is handled once', async () => {
  const s = await serve()
  const body = payload([text('dup-1', 'once')])
  await post(s, body)
  await post(s, body)
  await post(s, payload([text('dup-1', 'once'), text('dup-2', 'twice')]))
  await until(() => s.inbound.counters.forwarded === 2)
  await settle()
  assert.equal(s.inbound.counters.forwarded, 2)
  assert.equal(s.inbound.counters.duplicates, 2)
  const turns = s.world.core.filter((c) => ['/api/agents/spawn', '/api/agents/prompt', '/api/agents/queue'].includes(c.route))
  assert.equal(turns.length, 2)
})

test('allowlist: another number is dropped silently — no reply, no agent, counted', async () => {
  const s = await serve()
  await post(s, payload([text('x1', 'hello?', '4999000111')]))
  await post(s, payload([text('x2', 'hi', '49160999')])) // the second allowed number, written with "+ " in the env
  await until(() => s.inbound.counters.forwarded === 1)
  assert.equal(s.inbound.counters.dropped, 1)
  assert.equal(s.world.sent.length, 0, 'a stranger gets no reply at all')
  assert.match(s.world.core.find((c) => c.route === '/api/agents/spawn').body.task, /from 49160999\]/)
})

test('allowlist: an EMPTY list accepts nobody', async () => {
  const s = await serve({ env: { ...ENV, WHATSAPP_ALLOWED_FROM: '' } })
  await post(s, payload([text('e1', 'hi')]))
  await settle()
  assert.equal(s.world.core.length, 0)
  assert.equal(s.inbound.counters.dropped, 1)
})

test('statuses (delivered/read) are ignored', async () => {
  const s = await serve()
  const r = await post(s, payload([], [{ id: 'wamid.1', status: 'read', recipient_id: '4915112345678' }]))
  assert.equal(r.status, 200)
  await settle()
  assert.equal(s.world.core.length + s.world.sent.length, 0)
})

test('non-text messages get one short "can\'t read that" and never reach the agent', async () => {
  const s = await serve()
  await post(s, payload([{ id: 'img1', from: '4915112345678', type: 'image', image: { id: 'media1' } }]))
  await until(() => s.world.sent.length === 1)
  assert.equal(s.world.sent[0].body.to, '4915112345678')
  assert.match(s.world.sent[0].body.text.body, /noch nicht lesen/)
  assert.equal(s.world.core.length, 0)
  assert.equal(s.inbound.counters.unsupported, 1)
})

/* --- the session lifecycle --------------------------------------------------- */

test('first message spawns, the id is remembered in the state file, the next reuses it', async () => {
  const w = makeWorld()
  const s = await serve({ world: w })
  await post(s, payload([text('a1', 'erste')]))
  await until(() => s.inbound.counters.forwarded === 1)
  assert.equal(JSON.parse(fs.readFileSync(s.file, 'utf-8')).sessionId, 'kb-atlas-1')
  w.sessions = [{ id: 'kb-atlas-1', kind: 'knowledge', vault: 'atlas', status: 'idle' }]
  await post(s, payload([text('a2', 'zweite')]))
  await until(() => s.inbound.counters.forwarded === 2)
  assert.equal(w.spawned, 1, 'no second session')
  const p = w.core.find((c) => c.route === '/api/agents/prompt')
  assert.equal(p.body.id, 'kb-atlas-1')
  assert.match(p.body.text, /\[WhatsApp from 4915112345678\] zweite/)
})

test('a RUNNING session gets the message queued, not typed into the turn', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-atlas-7', status: 'running' }] })
  const s = await serve({ world: w })
  fs.writeFileSync(s.file, JSON.stringify({ sessionId: 'kb-atlas-7' }))
  await post(s, payload([text('r1', 'während du arbeitest')]))
  await until(() => s.inbound.counters.forwarded === 1)
  assert.ok(w.core.some((c) => c.route === '/api/agents/queue' && c.body.id === 'kb-atlas-7'))
  assert.ok(!w.core.some((c) => c.route === '/api/agents/prompt'))
})

test('a refused /prompt (open menu) falls back to /queue', async () => {
  const w = makeWorld({ sessions: [{ id: 'kb-atlas-7', status: 'idle' }], promptOk: false })
  const s = await serve({ world: w })
  fs.writeFileSync(s.file, JSON.stringify({ sessionId: 'kb-atlas-7' }))
  await post(s, payload([text('r1', 'hi')]))
  await until(() => s.inbound.counters.forwarded === 1)
  assert.ok(w.core.some((c) => c.route === '/api/agents/queue'))
})

test('a session that is gone or finished is replaced by a fresh spawn', async () => {
  for (const sessions of [[], [{ id: 'kb-atlas-7', status: 'done' }], [{ id: 'kb-atlas-7', status: 'dormant' }]]) {
    const w = makeWorld({ sessions })
    const s = await serve({ world: w })
    fs.writeFileSync(s.file, JSON.stringify({ sessionId: 'kb-atlas-7' }))
    await post(s, payload([text('g1', 'hi')]))
    await until(() => s.inbound.counters.forwarded === 1)
    assert.equal(w.spawned, 1)
    assert.equal(JSON.parse(fs.readFileSync(s.file, 'utf-8')).sessionId, 'kb-atlas-1')
  }
})

test('two messages in one payload before any session exists spawn ONE session', async () => {
  const w = makeWorld()
  // Once spawned, the session is idle for the second message.
  const spawnFetch = w.fetch
  w.fetch = async (url, opts) => {
    const r = await spawnFetch(url, opts)
    if (url.endsWith('/api/agents/spawn')) w.sessions = [{ id: 'kb-atlas-1', status: 'idle' }]
    return r
  }
  const s = await serve({ world: w })
  await post(s, payload([text('b1', 'eins'), text('b2', 'zwei')]))
  await until(() => s.inbound.counters.forwarded === 2)
  assert.equal(w.spawned, 1)
})

test('a broken agent route tells the sender instead of going silent', async () => {
  const w = makeWorld()
  const f = w.fetch
  w.fetch = async (url, opts) => (url.endsWith('/api/agents/spawn') ? { ok: false, status: 503, json: async () => ({ ok: false, error: 'no claude' }) } : f(url, opts))
  const s = await serve({ world: w })
  await post(s, payload([text('f1', 'hi')]))
  await until(() => w.sent.length === 1)
  assert.match(w.sent[0].body.text.body, /erreiche den Agenten gerade nicht/)
  assert.equal(s.inbound.counters.forwardErrors, 1)
  assert.match(s.log.join('\n'), /spawn → 503 no claude/)
})

test('the session brief tells it to PUSH its reply through the send route, briefly, without tables', () => {
  const b = sessionBrief({ port: '3001' })
  assert.match(b, /curl -sS -X POST http:\/\/127\.0\.0\.1:3001\/api\/whatsapp\/send/)
  assert.match(b, /Authorization: Bearer \$DASHBOARD_BEARER_TOKEN/)
  assert.match(b, /NOBODY reads this terminal/)
  assert.match(b, /No tables, no code blocks/)
  assert.match(b, /language of the message/)
  assert.match(sessionBrief({ port: '4444' }), /127\.0\.0\.1:4444\/api\/whatsapp\/send/)
})

/* --- /send ----------------------------------------------------------------- */

const send = (s, body, token = BEARER) =>
  fetch(`${s.base}/api/whatsapp/send`, {
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

test('POST /send: `to` defaults to the first allowed number; a foreign number is refused', async () => {
  const s = await serve()
  const ok = await send(s, { text: 'Hallo' })
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { ok: true, sent: 1, parts: 1 })
  assert.equal(s.world.sent[0].body.to, '4915112345678')
  assert.equal(s.world.sent[0].headers.Authorization, 'Bearer a-token')
  assert.equal((await send(s, { to: '+49 160 999', text: 'zweite Nummer' })).status, 200)
  assert.equal(s.world.sent[1].body.to, '49160999')
  const bad = await send(s, { to: '4999000111', text: 'nope' })
  assert.equal(bad.status, 400)
  assert.equal(s.world.sent.length, 2)
  assert.equal((await send(s, { text: '  ' })).status, 400)
  assert.equal((await send(s, {})).status, 400)
})

test('POST /send: an over-long text is split into several sends', async () => {
  const s = await serve()
  const r = await send(s, { text: ['a'.repeat(3000), 'b'.repeat(3000), 'c'.repeat(3000)].join('\n\n') })
  assert.deepEqual(await r.json(), { ok: true, sent: 3, parts: 3 })
  assert.equal(s.world.sent.length, 3)
})

test('POST /send: Meta\'s failure comes back as 502 with its status and text, and is logged', async () => {
  const s = await serve({ world: makeWorld({ metaOk: false }) })
  const r = await send(s, { text: 'x' })
  assert.equal(r.status, 502)
  const j = await r.json()
  assert.deepEqual([j.ok, j.status, j.error], [false, 400, 'boom'])
  assert.match(s.log.join('\n'), /HTTP 400.*boom/)
})

test('POST /send: missing outbound credentials say exactly which', async () => {
  const s = await serve({ env: { ...ENV, WHATSAPP_ACCESS_TOKEN: '' } })
  const r = await send(s, { text: 'x' })
  assert.equal(r.status, 503)
  assert.match((await r.json()).error, /WHATSAPP_ACCESS_TOKEN/)
})

/* --- loading with nothing configured ------------------------------------------ */

test('with NO env set the addon loads cleanly and status() reports it honestly', () => {
  const keep = { ...process.env }
  for (const k of Object.keys(process.env)) if (k.startsWith('WHATSAPP_') || k === 'DASHBOARD_BEARER_TOKEN') delete process.env[k]
  process.env.WHATSAPP_STATE_FILE = path.join(TMP, 'none.json')
  try {
    const m = registerAddon(ctx)
    assert.equal(typeof m.description, 'string')
    assert.ok(m.routes)
    assert.deepEqual(Object.keys(m).sort(), ['description', 'routes', 'status'])
    const st = m.status()
    assert.match(st.inbound, /NOT READY — set .*WHATSAPP_VERIFY_TOKEN.*WHATSAPP_APP_SECRET/)
    assert.match(st.outbound, /NOT READY — set .*WHATSAPP_ACCESS_TOKEN.*WHATSAPP_PHONE_NUMBER_ID/)
    assert.equal(st.allowedSenders, 0)
    assert.equal(st.windowOpen, null)
    assert.match(st.session, /none yet/)
    assert.equal(JSON.stringify(st).includes('secret'), false)
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]
    Object.assign(process.env, keep)
  }
})

test('status() with everything set says ready, tracks the 24 h window, and leaks no secret', async () => {
  const keep = { ...process.env }
  Object.assign(process.env, ENV, { WHATSAPP_STATE_FILE: path.join(TMP, 'ready.json') })
  fs.writeFileSync(process.env.WHATSAPP_STATE_FILE, JSON.stringify({ sessionId: 'kb-atlas-3', lastInboundAt: new Date().toISOString() }))
  try {
    const st = registerAddon(ctx).status()
    assert.equal(st.inbound, 'ready')
    assert.equal(st.outbound, 'ready')
    assert.equal(st.allowedSenders, 2)
    assert.equal(st.session, 'kb-atlas-3')
    assert.equal(st.windowOpen, true)
    const dump = JSON.stringify(st)
    for (const v of [ENV.WHATSAPP_APP_SECRET, ENV.WHATSAPP_ACCESS_TOKEN, ENV.DASHBOARD_BEARER_TOKEN, ENV.WHATSAPP_VERIFY_TOKEN]) assert.equal(dump.includes(v), false)
    fs.writeFileSync(process.env.WHATSAPP_STATE_FILE, JSON.stringify({ lastInboundAt: new Date(Date.now() - 25 * 3600e3).toISOString() }))
    assert.equal(registerAddon(ctx).status().windowOpen, false)
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]
    Object.assign(process.env, keep)
  }
})

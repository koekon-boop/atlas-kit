/* ------------------------------------------------------------------ *
 * addons/whatsapp — several people, one bridge: every allowed number gets its OWN
 * standing session, and a reply reaches the person who wrote.
 *
 * What this pins:
 *   · two senders → two sessions, never mixed; a sender's second message returns to its own;
 *   · the old single-session state file migrates onto the FIRST allowlisted number, losslessly;
 *   · each brief carries that session's own number, the mandatory `"to"`, and the optional name;
 *   · `/send` without `to` while several senders are configured still goes to the default —
 *     and logs the warning;
 *   · status() and install.sh --check report sessions and the 24 h window PER sender, masked.
 *
 * Hermetic: Meta and core's agent routes are one stubbed `fetch`; no credential is real.
 * Run: node --test addons/whatsapp/test/multi-sender.test.mjs
 * ------------------------------------------------------------------ */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { buildRoutes, default as registerAddon } from '../api/register.mjs'
import { forwardToAgent, loadState, readState, sessionBrief } from '../api/agent.mjs'
import { senderNames } from '../api/config.mjs'

const express = createRequire(new URL('../../../api/src/', import.meta.url))('express')
const ctx = { name: 'whatsapp', express, Router: (o) => express.Router(o) }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-multi-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const OP = '4915112345678' // the first number — the operator
const COL = '4917655500011' // a second person
const SECRET = 'app-secret'
const BEARER = 'dash-bearer'
const ENV = {
  WHATSAPP_VERIFY_TOKEN: 'v-token',
  WHATSAPP_APP_SECRET: SECRET,
  WHATSAPP_ACCESS_TOKEN: 'a-token',
  WHATSAPP_PHONE_NUMBER_ID: '555',
  WHATSAPP_ALLOWED_FROM: `${OP}, +49 176 555 00011`,
  DASHBOARD_BEARER_TOKEN: BEARER,
  API_PORT: '3001',
}

/** Core's agent routes + Meta in one stub. Every spawn is a new id and immediately listed idle. */
function makeWorld({ sessions = [] } = {}) {
  const w = { sent: [], core: [], sessions, spawned: 0 }
  w.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined
    const json = (status, j) => ({ ok: status < 400, status, json: async () => j })
    if (url.startsWith('https://graph.facebook.com/')) {
      w.sent.push({ url, body })
      return json(200, { messages: [{ id: 'wamid.x' }] })
    }
    const route = url.replace('http://127.0.0.1:3001', '')
    w.core.push({ method: opts.method, route, body })
    if (route === '/api/agents') return json(200, { sessions: w.sessions })
    if (route === '/api/agents/spawn') {
      const id = `kb-atlas-${++w.spawned}`
      w.sessions = [...w.sessions, { id, status: 'idle' }]
      return json(200, { ok: true, id })
    }
    if (route === '/api/agents/prompt' || route === '/api/agents/queue') return json(200, { ok: true })
    return json(404, {})
  }
  return w
}
const stateFile = () => path.join(TMP, `state-${crypto.randomUUID()}.json`)
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf-8'))
const turns = (w) => w.core.filter((c) => ['/api/agents/spawn', '/api/agents/prompt', '/api/agents/queue'].includes(c.route))

/* --- one session per sender ------------------------------------------------- */

test('two senders get two sessions; a sender\'s next message goes back to ITS session', async () => {
  const w = makeWorld()
  const file = stateFile()
  const deps = { env: ENV, fetch: w.fetch, file }
  assert.deepEqual(await forwardToAgent({ from: OP, text: 'Hallo vom Chef' }, deps), { ok: true, via: 'spawn', id: 'kb-atlas-1' })
  assert.deepEqual(await forwardToAgent({ from: COL, text: 'Hallo von der Kollegin' }, deps), { ok: true, via: 'spawn', id: 'kb-atlas-2' })
  assert.equal(w.spawned, 2, 'the second person does not land in the first one\'s chat')

  assert.deepEqual(await forwardToAgent({ from: COL, text: 'noch was' }, deps), { ok: true, via: 'prompt', id: 'kb-atlas-2' })
  assert.deepEqual(await forwardToAgent({ from: OP, text: 'und ich' }, deps), { ok: true, via: 'prompt', id: 'kb-atlas-1' })
  assert.equal(w.spawned, 2)

  const prompts = turns(w).filter((c) => c.route === '/api/agents/prompt')
  assert.deepEqual(prompts.map((p) => [p.body.id, p.body.text.match(/^\[WhatsApp from (\d+)\]/)[1]]), [['kb-atlas-2', COL], ['kb-atlas-1', OP]])
  const st = readJson(file)
  assert.equal(st.senders[OP].sessionId, 'kb-atlas-1')
  assert.equal(st.senders[COL].sessionId, 'kb-atlas-2')
  assert.equal(st.sessionId, undefined, 'no top-level session id in the new shape')
})

test('a running session of one sender is queued; the other sender is unaffected', async () => {
  const w = makeWorld()
  const file = stateFile()
  const deps = { env: ENV, fetch: w.fetch, file }
  await forwardToAgent({ from: OP, text: 'a' }, deps)
  await forwardToAgent({ from: COL, text: 'b' }, deps)
  w.sessions = [{ id: 'kb-atlas-1', status: 'running' }, { id: 'kb-atlas-2', status: 'idle' }]
  assert.equal((await forwardToAgent({ from: OP, text: 'c' }, deps)).via, 'queue')
  assert.equal((await forwardToAgent({ from: COL, text: 'd' }, deps)).via, 'prompt')
})

test('a dead session is replaced for that sender only', async () => {
  const w = makeWorld()
  const file = stateFile()
  const deps = { env: ENV, fetch: w.fetch, file }
  await forwardToAgent({ from: OP, text: 'a' }, deps)
  await forwardToAgent({ from: COL, text: 'b' }, deps)
  w.sessions = [{ id: 'kb-atlas-1', status: 'idle' }, { id: 'kb-atlas-2', status: 'done' }]
  assert.deepEqual(await forwardToAgent({ from: COL, text: 'c' }, deps), { ok: true, via: 'spawn', id: 'kb-atlas-3' })
  const st = readJson(file)
  assert.equal(st.senders[COL].sessionId, 'kb-atlas-3')
  assert.equal(st.senders[OP].sessionId, 'kb-atlas-1')
})

test('end to end through the webhook: two numbers → two spawns, each brief names its own number', async () => {
  const w = makeWorld()
  const file = stateFile()
  const { routes } = buildRoutes(ctx, { env: ENV, fetch: w.fetch, log: () => {}, file })
  const app = express()
  app.use(routes)
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  after(() => server.close())
  const raw = JSON.stringify({ entry: [{ changes: [{ value: { messages: [
    { id: 'm1', from: OP, type: 'text', text: { body: 'eins' } },
    { id: 'm2', from: COL, type: 'text', text: { body: 'zwei' } },
    { id: 'm3', from: '4999000111', type: 'text', text: { body: 'fremd' } },
  ] } }] }] })
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/whatsapp/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-hub-signature-256': `sha256=${crypto.createHmac('sha256', SECRET).update(raw).digest('hex')}` },
    body: raw,
  })
  assert.equal(r.status, 200)
  for (let i = 0; i < 200 && w.spawned < 2; i++) await new Promise((x) => setTimeout(x, 5))
  await new Promise((x) => setTimeout(x, 60))
  const spawns = w.core.filter((c) => c.route === '/api/agents/spawn')
  assert.equal(spawns.length, 2, 'the unknown number spawned nothing')
  assert.match(spawns[0].body.task, new RegExp(`"to":"${OP}"`))
  assert.match(spawns[1].body.task, new RegExp(`"to":"${COL}"`))
  assert.doesNotMatch(spawns[1].body.task, new RegExp(OP), 'the second session never sees the first number')
  assert.equal(w.sent.length, 0, 'the stranger got no reply')
  const st = readJson(file)
  assert.ok(st.senders[OP].lastInboundAt && st.senders[COL].lastInboundAt && !st.senders['4999000111'])
})

/* --- migration ---------------------------------------------------------------- */

test('migration: the old single-session file keeps its session on the FIRST allowed number — and the file is rewritten', async () => {
  const file = stateFile()
  const legacy = { lastInboundAt: new Date().toISOString(), sessionId: 'kb-whatsapp-channel-a-standing-chat-session', createdAt: '2026-09-24T18:00:00.000Z' }
  fs.writeFileSync(file, JSON.stringify(legacy))
  const allowed = [OP, COL]

  // first read of the old shape rewrites it, before any network call
  const st = loadState(file, allowed)
  assert.deepEqual(readJson(file), {
    lastInboundAt: legacy.lastInboundAt,
    senders: { [OP]: { sessionId: legacy.sessionId, createdAt: legacy.createdAt, lastInboundAt: legacy.lastInboundAt } },
  })
  assert.deepEqual(st, readJson(file))

  // …and the running chat carries on: the operator's next message is a /prompt into the SAME session
  const w = makeWorld({ sessions: [{ id: legacy.sessionId, status: 'idle' }] })
  const deps = { env: ENV, fetch: w.fetch, file }
  assert.deepEqual(await forwardToAgent({ from: OP, text: 'weiter' }, deps), { ok: true, via: 'prompt', id: legacy.sessionId })
  assert.equal(w.spawned, 0)
  // the colleague gets a session of her own — not the operator's
  assert.equal((await forwardToAgent({ from: COL, text: 'hi' }, deps)).via, 'spawn')
  const after = readJson(file)
  assert.equal(after.senders[OP].sessionId, legacy.sessionId)
  assert.equal(after.senders[COL].sessionId, 'kb-atlas-1')
})

test('migration: the old file is migrated by the first message even when the colleague writes first', async () => {
  const file = stateFile()
  fs.writeFileSync(file, JSON.stringify({ sessionId: 'kb-old', createdAt: 'c', lastInboundAt: new Date().toISOString() }))
  const w = makeWorld({ sessions: [{ id: 'kb-old', status: 'idle' }] })
  const r = await forwardToAgent({ from: COL, text: 'ich zuerst' }, { env: ENV, fetch: w.fetch, file })
  assert.equal(r.via, 'spawn', 'her message must not be typed into the operator\'s session')
  assert.equal(readJson(file).senders[OP].sessionId, 'kb-old')
})

test('migration: readState is read-only (status() does not write); nothing to migrate or nobody allowed leaves the file alone', () => {
  const file = stateFile()
  const old = JSON.stringify({ sessionId: 'kb-old' })
  fs.writeFileSync(file, old)
  assert.equal(readState(file, [OP]).senders[OP].sessionId, 'kb-old')
  assert.equal(fs.readFileSync(file, 'utf-8'), old, 'reading for status() does not rewrite')
  loadState(file, []) // an empty allowlist has no first number to give the session to
  assert.equal(fs.readFileSync(file, 'utf-8'), old)
  fs.writeFileSync(file, '{}')
  loadState(file, [OP])
  assert.equal(fs.readFileSync(file, 'utf-8'), '{}')
  fs.writeFileSync(file, 'not json')
  assert.deepEqual(readState(file, [OP]), { senders: {} })
})

test('migration: an already migrated file is not touched again', () => {
  const file = stateFile()
  const now = JSON.stringify({ senders: { [COL]: { sessionId: 'kb-col' } } })
  fs.writeFileSync(file, now)
  assert.deepEqual(loadState(file, [OP, COL]).senders, { [COL]: { sessionId: 'kb-col' } })
  assert.equal(fs.readFileSync(file, 'utf-8'), now)
})

/* --- the brief ---------------------------------------------------------------- */

test('a session\'s brief carries its OWN number and makes "to" mandatory', () => {
  const b = sessionBrief({ port: '3001', number: COL })
  assert.match(b, new RegExp(`WhatsApp number ${COL}`))
  assert.match(b, new RegExp(`EVERY send carries "to":"${COL}" — no exception`))
  assert.match(b, /a reply without "to" is read by the wrong person/)
  assert.match(b, new RegExp(`\\{"to":"${COL}","text":"your reply here"\\}`), 'the curl example has it')
  assert.match(b, new RegExp(`\\{"to":"${COL}","text":"your reply here","voice":true\\}`), 'so does the voice example')
  assert.doesNotMatch(b, /defaults to the operator/)
  assert.doesNotMatch(b, /operator/, 'a colleague is not "the operator"')
  assert.match(b, /NOBODY reads this terminal/, 'the old rule stays')
  // the single-operator brief (no number) is unchanged in kind
  assert.match(sessionBrief({ port: '3001' }), /defaults to the operator's own/)
})

test('with a name the brief says whom the session talks to; without one it stays with the number', () => {
  assert.match(sessionBrief({ number: COL, name: 'Jessi' }), new RegExp(`You are talking to Jessi \\(WhatsApp number ${COL}\\)`))
  const bare = sessionBrief({ number: COL })
  assert.match(bare, new RegExp(`You are talking to the person on WhatsApp number ${COL}`))
  assert.doesNotMatch(bare, /Jessi/)
})

test('WHATSAPP_SENDER_NAMES reaches the spawned session\'s brief; the per-message line repeats the "to"', async () => {
  const w = makeWorld()
  const env = { ...ENV, WHATSAPP_SENDER_NAMES: ` ${OP}=Ko , +49 176 555 00011 = Jessi ` }
  const file = stateFile()
  await forwardToAgent({ from: OP, text: 'a' }, { env, fetch: w.fetch, file })
  await forwardToAgent({ from: COL, text: 'b' }, { env, fetch: w.fetch, file })
  const [ko, jessi] = w.core.filter((c) => c.route === '/api/agents/spawn').map((c) => c.body.task)
  assert.match(ko, /You are talking to Ko /)
  assert.match(jessi, /You are talking to Jessi /)
  assert.doesNotMatch(jessi, /Ko /)
  assert.match(jessi, new RegExp(`\\[WhatsApp from ${COL}\\] b\\n\\n\\(Reply with a POST to /api/whatsapp/send with "to":"${COL}"`))
  await forwardToAgent({ from: COL, text: 'c' }, { env, fetch: w.fetch, file })
  assert.match(turns(w).at(-1).body.text, new RegExp(`with "to":"${COL}"`))
})

test('WHATSAPP_SENDER_NAMES parsing is robust: spaces, empty entries, no "=", "+" in numbers, "=" in a name', () => {
  assert.deepEqual(senderNames({}), {})
  assert.deepEqual(senderNames({ WHATSAPP_SENDER_NAMES: '' }), {})
  assert.deepEqual(
    senderNames({ WHATSAPP_SENDER_NAMES: ' 491=Ko ,, 492 = Jessi  Müller ,nonsense, =NoNumber, 493=, +49 4 94=A=B ,' }),
    { 491: 'Ko', 492: 'Jessi Müller', 49494: 'A=B' },
  )
})

/* --- /send without `to` ----------------------------------------------------------- */

async function serveSend(env) {
  const w = makeWorld()
  const log = []
  const { routes } = buildRoutes(ctx, { env, fetch: w.fetch, log: (m) => log.push(m), file: stateFile() })
  const app = express()
  app.use(routes)
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  after(() => server.close())
  const send = (body) =>
    fetch(`http://127.0.0.1:${server.address().port}/api/whatsapp/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${BEARER}` },
      body: JSON.stringify(body),
    })
  return { w, log, send }
}

test('/send without `to` while several senders are configured: warned in the log, still goes to the default number', async () => {
  const { w, log, send } = await serveSend(ENV)
  const r = await send({ text: 'wem gehöre ich?' })
  assert.equal(r.status, 200, 'not an error — the default stays')
  assert.equal(w.sent[0].body.to, OP)
  const warn = log.filter((l) => /reply without `to` while 2 senders are configured — went to the default number/.test(l))
  assert.equal(warn.length, 1)
  assert.doesNotMatch(warn[0], new RegExp(OP), 'the log carries the masked number only')
  assert.match(warn[0], /49…678/)
})

test('/send with `to`, or with only one sender configured, does not warn', async () => {
  const many = await serveSend(ENV)
  assert.equal((await many.send({ to: COL, text: 'x' })).status, 200)
  assert.equal(many.w.sent[0].body.to, COL)
  assert.deepEqual(many.log, [])
  const one = await serveSend({ ...ENV, WHATSAPP_ALLOWED_FROM: OP })
  assert.equal((await one.send({ text: 'x' })).status, 200)
  assert.deepEqual(one.log, [])
})

/* --- status() and install.sh --check ------------------------------------------------ */

function withEnv(env, fn) {
  const real = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('offline') } // status() probes the voice addon
  const keep = { ...process.env }
  for (const k of Object.keys(process.env)) if (k.startsWith('WHATSAPP_')) delete process.env[k]
  Object.assign(process.env, env)
  try {
    return fn()
  } finally {
    globalThis.fetch = real
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]
    Object.assign(process.env, keep)
  }
}

test('status() lists every allowed number: masked, its session, since when, and ITS window', () => {
  const file = stateFile()
  const recent = new Date().toISOString()
  fs.writeFileSync(file, JSON.stringify({
    lastInboundAt: recent,
    senders: {
      [OP]: { sessionId: 'kb-atlas-1', createdAt: '2026-09-24T18:00:00.000Z', lastInboundAt: new Date(Date.now() - 30 * 3600e3).toISOString() },
      [COL]: { sessionId: 'kb-atlas-2', createdAt: '2026-09-25T09:00:00.000Z', lastInboundAt: recent },
    },
  }))
  const st = withEnv({ ...ENV, WHATSAPP_STATE_FILE: file, WHATSAPP_SENDER_NAMES: `${COL}=Jessi` }, () => registerAddon(ctx).status())
  assert.equal(st.allowedSenders, 2)
  assert.equal(st.lastInboundAt, recent, 'the global "last from anyone" stays')
  assert.deepEqual(st.sessions, [
    { number: '49…678', session: 'kb-atlas-1', since: '2026-09-24T18:00:00.000Z', lastInboundAt: st.sessions[0].lastInboundAt, windowOpen: false },
    { number: '49…011', name: 'Jessi', session: 'kb-atlas-2', since: '2026-09-25T09:00:00.000Z', lastInboundAt: recent, windowOpen: true },
  ])
  const dump = JSON.stringify(st)
  assert.equal(dump.includes(OP) || dump.includes(COL), false, 'no full number in status')
  assert.equal(fs.readFileSync(file, 'utf-8').includes('"senders"'), true)
})

test('status() before anyone wrote: a row per allowed number with no session yet, window unknown', () => {
  const st = withEnv({ ...ENV, WHATSAPP_STATE_FILE: stateFile() }, () => registerAddon(ctx).status())
  assert.equal(st.sessions.length, 2)
  for (const s of st.sessions) {
    assert.match(s.session, /none yet/)
    assert.equal(s.windowOpen, null)
  }
})

test('status() reads a not-yet-migrated file as the operator\'s session (without rewriting it)', () => {
  const file = stateFile()
  const old = JSON.stringify({ sessionId: 'kb-old', lastInboundAt: new Date().toISOString() })
  fs.writeFileSync(file, old)
  const st = withEnv({ ...ENV, WHATSAPP_STATE_FILE: file }, () => registerAddon(ctx).status())
  assert.equal(st.sessions[0].session, 'kb-old')
  assert.equal(st.sessions[0].windowOpen, true)
  assert.match(st.sessions[1].session, /none yet/)
  assert.equal(fs.readFileSync(file, 'utf-8'), old)
})

test('install.sh --check reports the sessions per sender (masked), and skips them quietly when the module is not there', () => {
  const root = path.join(TMP, `root-${crypto.randomUUID()}`)
  const bin = path.join(root, 'bin')
  fs.mkdirSync(path.join(root, 'addons', 'whatsapp', 'api'), { recursive: true })
  fs.mkdirSync(bin)
  const here = new URL('..', import.meta.url).pathname
  fs.copyFileSync(path.join(here, 'install.sh'), path.join(root, 'addons', 'whatsapp', 'install.sh'))
  for (const f of ['agent.mjs', 'config.mjs']) fs.copyFileSync(path.join(here, 'api', f), path.join(root, 'addons', 'whatsapp', 'api', f))
  for (const t of ['bash', 'grep', 'dirname']) fs.symlinkSync(spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf-8' }).stdout.trim(), path.join(bin, t))
  fs.symlinkSync(process.execPath, path.join(bin, 'node'))
  const file = stateFile()
  fs.writeFileSync(file, JSON.stringify({ senders: { [OP]: { sessionId: 'kb-atlas-1', createdAt: '2026-09-24T18:00:00.000Z', lastInboundAt: new Date().toISOString() } } }))
  const run = () => spawnSync(path.join(bin, 'bash'), [path.join(root, 'addons', 'whatsapp', 'install.sh'), '--check'], {
    encoding: 'utf-8',
    env: { PATH: bin, HOME: root, API_PORT: '1', ATLAS_ADDONS: '', ...ENV, WHATSAPP_STATE_FILE: file, WHATSAPP_SENDER_NAMES: `${COL}=Jessi` },
    timeout: 30000,
  })
  const r = run()
  assert.match(r.stdout, /2 allowed sender\(s\), one session each/)
  assert.match(r.stdout, /49…678 — kb-atlas-1, since 2026-09-24T18:00:00.000Z, 24 h window open/)
  assert.match(r.stdout, /49…011 \(Jessi\) — none yet \(created on the first message\), 24 h window never opened/)
  assert.match(r.stdout, /every reply must carry "to"/)
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp(`${OP}|${COL}`), 'no full number printed')
  assert.doesNotMatch(r.stderr, /could not read the sessions/)
  fs.rmSync(path.join(root, 'addons', 'whatsapp', 'api'), { recursive: true })
  const bare = run()
  assert.doesNotMatch(bare.stdout, /allowed sender/)
  assert.doesNotMatch(bare.stderr, /could not read the sessions/)
})

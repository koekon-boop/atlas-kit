/* ------------------------------------------------------------------ *
 * addons/telegram — shared and LIVE locations (README "Location").
 *
 * What this pins:
 *   · a shared location from an allowed chat runs TELEGRAM_LOCATION_HOOK (no shell)
 *     with one JSON argument, and the hook's `reply` goes back to the chat;
 *   · a live-location update (edited_message) runs the hook too, but never sends a
 *     reply and never counts as the operator answering (lastInboundAt untouched);
 *   · the hook's `forward` reaches the agent as a `[Standort]` line;
 *   · an unknown chat is dropped silently; a broken hook is logged, nothing else;
 *   · without a hook: a shared location still gets "can't read that", live updates
 *     are dropped — the behaviour before this existed;
 *   · any other edited_message is still ignored.
 *
 * Hermetic: Telegram and core's agent routes are one stubbed `fetch`, the hook is a
 * stubbed `exec`. Run: node --test addons/telegram/test/location.test.mjs
 * ------------------------------------------------------------------ */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInbound, LOCATION_MARK } from '../api/inbound.mjs'
import { readState } from '../api/agent.mjs'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-location-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const BASE = { TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_HOME_CHAT_ID: '111', DASHBOARD_BEARER_TOKEN: 'dash-bearer', API_PORT: '3001' }
const ENV = { ...BASE, TELEGRAM_LOCATION_HOOK: '/opt/standort' }

function makeWorld() {
  const w = { telegram: [], core: [] }
  w.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined
    const json = (status, j) => ({ ok: status < 400, status, json: async () => j })
    if (url.startsWith('https://api.telegram.org/')) {
      w.telegram.push({ method: url.split('/').pop(), body })
      return json(200, { ok: true, result: true })
    }
    const route = url.replace('http://127.0.0.1:3001', '')
    w.core.push({ route, body })
    if (route === '/api/agents') return json(200, { sessions: [{ id: 'kb-telegram-x', status: 'idle' }] })
    if (route === '/api/agents/spawn') return json(200, { ok: true, id: 'kb-telegram-x' })
    return json(200, { ok: true })
  }
  return w
}

const where = { latitude: 40.3613, longitude: 0.402, horizontal_accuracy: 12, live_period: 2147483647, heading: 90 }
const shared = (chatId = 111, location = where) => ({ update_id: 1, message: { message_id: 50, date: 1761200000, chat: { id: chatId }, location } })
const liveUpdate = (chatId = 111) => ({ update_id: 2, edited_message: { message_id: 50, date: 1761200000, edit_date: 1761200300, chat: { id: chatId }, location: { ...where, latitude: 40.37 } } })
const hookSaying = (calls, out, code = 0) => async (bin, args, opts) => {
  calls.push({ bin, args, opts })
  return { code, stderr: code ? 'kaputt' : '', stdout: typeof out === 'string' ? out : JSON.stringify(out) }
}
const sent = (w, method = 'sendMessage') => w.telegram.filter((c) => c.method === method)
const toAgent = (w) => w.core.filter((c) => c.route !== '/api/agents')

test('a shared location runs the hook with one JSON argument and sends its reply', async () => {
  const w = makeWorld()
  const calls = []
  const file = path.join(TMP, 'a.json')
  const inbound = createInbound({ env: ENV, fetch: w.fetch, log: () => {}, file, exec: hookSaying(calls, { reply: '📍 Angekommen' }) })
  await inbound.handleOne(shared())
  assert.equal(calls.length, 1)
  assert.equal(calls[0].bin, '/opt/standort')
  assert.equal(calls[0].args.length, 1)
  const p = JSON.parse(calls[0].args[0])
  assert.equal(p.lat, 40.3613)
  assert.equal(p.lon, 0.402)
  assert.equal(p.accuracy, 12)
  assert.equal(p.live, true)
  assert.equal(p.update, false)
  assert.equal(p.chatId, '111')
  assert.equal(p.messageId, 50)
  assert.deepEqual(sent(w).map((c) => c.body.text), ['📍 Angekommen'])
  assert.equal(toAgent(w).length, 0, 'no forward asked → nothing for the agent')
  assert.ok(readState(file).lastInboundAt, 'a shared location counts as the operator answering')
  assert.equal(inbound.counters.locations, 1)
})

test('a live update runs the hook, never replies and does not count as the operator answering', async () => {
  const w = makeWorld()
  const calls = []
  const file = path.join(TMP, 'b.json')
  const inbound = createInbound({ env: ENV, fetch: w.fetch, log: () => {}, file, exec: hookSaying(calls, { reply: 'sollte nicht kommen' }) })
  await inbound.handleOne(liveUpdate())
  assert.equal(calls.length, 1)
  const p = JSON.parse(calls[0].args[0])
  assert.equal(p.update, true)
  assert.equal(p.lat, 40.37)
  assert.equal(p.date, 1761200300, 'an update carries its edit_date')
  assert.equal(sent(w).length, 0)
  assert.equal(readState(file).lastInboundAt ?? null, null)
  assert.equal(inbound.counters.locationUpdates, 1)
})

test("the hook's forward reaches the agent as a [Standort] line", async () => {
  const w = makeWorld()
  const inbound = createInbound({ env: ENV, fetch: w.fetch, log: () => {}, file: path.join(TMP, 'c.json'), exec: hookSaying([], { forward: 'Ko ist bei 40.37, 0.40' }) })
  await inbound.handleOne(liveUpdate())
  const marked = w.core.filter((c) => c.body && JSON.stringify(c.body).includes(`${LOCATION_MARK} Ko ist bei 40.37, 0.40`))
  assert.equal(marked.length, 1, 'the agent got exactly the marked line')
})

test('an unknown chat is dropped silently: no hook, no reply', async () => {
  const w = makeWorld()
  const calls = []
  const inbound = createInbound({ env: ENV, fetch: w.fetch, log: () => {}, file: path.join(TMP, 'd.json'), exec: hookSaying(calls, { reply: 'x' }) })
  await inbound.handleOne(shared(999))
  await inbound.handleOne(liveUpdate(999))
  assert.equal(calls.length, 0)
  assert.equal(w.telegram.length, 0)
  assert.equal(inbound.counters.dropped, 2)
})

test('a broken hook is logged and nothing else happens', async () => {
  const w = makeWorld()
  const logs = []
  const inbound = createInbound({ env: ENV, fetch: w.fetch, log: (l) => logs.push(l), file: path.join(TMP, 'e.json'), exec: hookSaying([], 'kein json', 1) })
  await inbound.handleOne(shared())
  assert.equal(sent(w).length, 0)
  assert.equal(toAgent(w).length, 0)
  assert.equal(inbound.counters.locationErrors, 1)
  assert.ok(logs.some((l) => l.includes('location hook failed')))
})

test('out-of-range coordinates never reach the hook', async () => {
  const w = makeWorld()
  const calls = []
  const inbound = createInbound({ env: ENV, fetch: w.fetch, log: () => {}, file: path.join(TMP, 'f.json'), exec: hookSaying(calls, {}) })
  await inbound.handleOne(shared(111, { latitude: 123, longitude: 0 }))
  assert.equal(calls.length, 0)
})

test('without a hook: a shared location gets "can\'t read that", live updates are dropped', async () => {
  const w = makeWorld()
  const calls = []
  const inbound = createInbound({ env: BASE, fetch: w.fetch, log: () => {}, file: path.join(TMP, 'g.json'), exec: hookSaying(calls, {}) })
  await inbound.handleOne(shared())
  await inbound.handleOne(liveUpdate())
  assert.equal(calls.length, 0)
  assert.equal(sent(w).length, 1)
  assert.match(sent(w)[0].body.text, /noch nicht lesen/)
  assert.equal(inbound.counters.unsupported, 1)
})

test('any other edited message is still ignored', async () => {
  const w = makeWorld()
  const calls = []
  const inbound = createInbound({ env: ENV, fetch: w.fetch, log: () => {}, file: path.join(TMP, 'h.json'), exec: hookSaying(calls, {}) })
  await inbound.handleOne({ update_id: 3, edited_message: { message_id: 9, chat: { id: 111 }, text: 'Tippfehler korrigiert' } })
  assert.equal(calls.length, 0)
  assert.equal(w.telegram.length, 0)
  assert.equal(w.core.length, 0)
})

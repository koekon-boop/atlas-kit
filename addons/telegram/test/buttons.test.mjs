/* ------------------------------------------------------------------ *
 * addons/telegram — taps on inline buttons (callback_query, README "Buttons").
 *
 * What this pins:
 *   · getUpdates subscribes to callback_query next to message;
 *   · a tap from an allowed chat runs TELEGRAM_CALLBACK_HOOK (no shell) with one
 *     JSON argument, and the hook's `toast` closes the spinner;
 *   · the hook's `forward` reaches the agent as a `[Knopf]` line, nothing else does;
 *   · a tap from an unknown chat is dropped silently — no hook, no answer;
 *   · no hook configured, or a hook that fails → the spinner is still closed;
 *   · a tap counts as the operator answering (lastInboundAt is bumped).
 *
 * Hermetic: Telegram and core's agent routes are one stubbed `fetch`, the hook
 * is a stubbed `exec`. Run: node --test addons/telegram/test/buttons.test.mjs
 * ------------------------------------------------------------------ */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInbound } from '../api/inbound.mjs'
import { ALLOWED_UPDATES } from '../api/poller.mjs'
import { readState } from '../api/agent.mjs'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-buttons-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const ENV = {
  TELEGRAM_BOT_TOKEN: 'bot-token',
  TELEGRAM_HOME_CHAT_ID: '111',
  DASHBOARD_BEARER_TOKEN: 'dash-bearer',
  API_PORT: '3001',
  TELEGRAM_CALLBACK_HOOK: '/opt/hook',
}

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

const tap = (data, chatId = 111) => ({ update_id: 7, callback_query: { id: 'cq-1', data, from: { id: chatId }, message: { message_id: 42, chat: { id: chatId } } } })
const hookSaying = (calls, out, code = 0) => async (bin, args, opts) => {
  calls.push({ bin, args, opts })
  return { code, stderr: code ? 'kaputt' : '', stdout: typeof out === 'string' ? out : JSON.stringify(out) }
}

test('getUpdates asks for button taps as well as messages (and edits, for live locations)', () => {
  assert.deepEqual(JSON.parse(decodeURIComponent(ALLOWED_UPDATES)), ['message', 'edited_message', 'callback_query'])
})

test('a tap runs the hook with one JSON argument and shows its toast', async () => {
  const w = makeWorld()
  const calls = []
  const file = path.join(TMP, 'a.json')
  const inbound = createInbound({ env: ENV, fetch: w.fetch, log: () => {}, file, exec: hookSaying(calls, { toast: 'Erledigt' }) })
  await inbound.handleOne(tap('t:domain'))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].bin, '/opt/hook')
  assert.deepEqual(JSON.parse(calls[0].args[0]), { data: 't:domain', chatId: '111', messageId: 42, fromId: 111 })
  assert.equal(calls[0].opts.captureStdout, true)
  assert.deepEqual(w.telegram, [{ method: 'answerCallbackQuery', body: { callback_query_id: 'cq-1', text: 'Erledigt' } }])
  assert.equal(w.core.length, 0, 'no forward asked for → the agent is not woken')
  assert.equal(inbound.counters.buttonTaps, 1)
  assert.ok(readState(file).lastInboundAt, 'a tap counts as the operator answering')
})

test('the hook can pass a line on to the agent, marked as a button', async () => {
  const w = makeWorld()
  const inbound = createInbound({ env: ENV, fetch: w.fetch, log: () => {}, file: path.join(TMP, 'b.json'), exec: hookSaying([], { toast: 'ok', forward: 'Ko hat „Domain“ abgehakt.' }) })
  await inbound.handleOne(tap('t:domain'))
  const sent = w.core.filter((c) => c.body && /\[Knopf\] Ko hat „Domain“ abgehakt\./.test(JSON.stringify(c.body)))
  assert.equal(sent.length, 1, 'the agent got exactly the marked line')
})

test('a tap from an unknown chat is dropped silently', async () => {
  const w = makeWorld()
  const calls = []
  const inbound = createInbound({ env: ENV, fetch: w.fetch, log: () => {}, file: path.join(TMP, 'c.json'), exec: hookSaying(calls, { toast: 'x' }) })
  await inbound.handleOne(tap('t:domain', 999))
  assert.equal(calls.length, 0)
  assert.equal(w.telegram.length, 0)
  assert.equal(inbound.counters.dropped, 1)
})

test('without a hook, or with a failing one, the spinner is still closed', async () => {
  const w = makeWorld()
  const noHook = { ...ENV, TELEGRAM_CALLBACK_HOOK: '' }
  const a = createInbound({ env: noHook, fetch: w.fetch, log: () => {}, file: path.join(TMP, 'd.json'), exec: hookSaying([], {}) })
  await a.handleOne(tap('t:x'))
  assert.equal(w.telegram.at(-1).method, 'answerCallbackQuery')
  assert.match(w.telegram.at(-1).body.text, /nicht eingerichtet/)

  for (const [out, code] of [[{}, 3], ['kein json', 0]]) {
    const b = createInbound({ env: ENV, fetch: w.fetch, log: () => {}, file: path.join(TMP, 'e.json'), exec: hookSaying([], out, code) })
    await b.handleOne(tap('t:x'))
    assert.equal(w.telegram.at(-1).method, 'answerCallbackQuery')
    assert.match(w.telegram.at(-1).body.text, /nicht geklappt/)
    assert.equal(b.counters.buttonErrors, 1)
  }
})

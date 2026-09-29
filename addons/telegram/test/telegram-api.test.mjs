/* ------------------------------------------------------------------ *
 * addons/telegram — the Bot API side: the 4096-char split, sendMessage's error
 * reporting, sendVoice's multipart shape, sendChatAction. Unlike WhatsApp there
 * is no signature to verify (inbound is a long-poll pull, not a pushed webhook)
 * — that surface is poller.test.mjs instead.
 *
 * Hermetic: a stubbed fetch, explicit env objects, no network.
 * Run: node --test addons/telegram/test/telegram-api.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sendChatAction, sendMessage, sendVoice, splitMessage } from '../api/telegram.mjs'

const ENV = { TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_HOME_CHAT_ID: '111' }

test('split: short text is one message; empty is none', () => {
  assert.deepEqual(splitMessage('hallo'), ['hallo'])
  assert.deepEqual(splitMessage('  \n '), [])
  assert.deepEqual(splitMessage(undefined), [])
})

test('split: long text breaks at paragraph boundaries and loses nothing', () => {
  const para = (c) => c.repeat(1500)
  const text = [para('a'), para('b'), para('c'), para('d')].join('\n\n')
  const parts = splitMessage(text)
  assert.deepEqual(parts, [`${para('a')}\n\n${para('b')}`, `${para('c')}\n\n${para('d')}`])
  assert.ok(parts.every((p) => p.length <= 4096))
})

test('split: a single paragraph over the cap is cut on a line/word, never past the cap', () => {
  const words = Array.from({ length: 1200 }, (_, i) => `wort${i}`).join(' ')
  const parts = splitMessage(words, 4096)
  assert.ok(parts.length >= 2)
  assert.ok(parts.every((p) => p.length <= 4096))
  assert.equal(parts.join(' '), words, 'no word is lost or split')
  const solid = 'x'.repeat(9000)
  const cut = splitMessage(solid, 4096)
  assert.deepEqual(cut.map((p) => p.length), [4096, 4096, 808])
})

test('split: a hard cut never lands inside a surrogate pair', () => {
  const parts = splitMessage('😀'.repeat(3000), 4096)
  assert.ok(parts.length >= 2)
  for (const p of parts) {
    assert.ok(p.length <= 4096)
    assert.equal(p, [...p].join(''), 'every part is whole code points')
    assert.ok(!/[\ud800-\udbff]$/.test(p) && !/^[\udc00-\udfff]/.test(p))
  }
})

const okResp = () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) })

test('sendMessage: posts to the Bot API with the token in the URL, not a header', async () => {
  const calls = []
  const f = async (url, opts) => (calls.push({ url, opts }), okResp())
  const r = await sendMessage({ chatId: '111', text: 'hi' }, { env: ENV, fetch: f, log: () => {} })
  assert.deepEqual(r, { ok: true, sent: 1, parts: 1 })
  assert.equal(calls[0].url, 'https://api.telegram.org/bot' + ENV.TELEGRAM_BOT_TOKEN + '/sendMessage')
  assert.equal(calls[0].opts.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].opts.body), { chat_id: '111', text: 'hi' })
  assert.equal(Object.keys(calls[0].opts.headers).some((k) => /auth/i.test(k)), false, 'no Authorization header — the token is in the URL')
})

test('sendMessage: a long text goes out as several messages, in order', async () => {
  const bodies = []
  const f = async (_u, opts) => (bodies.push(JSON.parse(opts.body).text), okResp())
  const text = ['a'.repeat(3000), 'b'.repeat(3000)].join('\n\n')
  const r = await sendMessage({ chatId: '1', text }, { env: ENV, fetch: f, log: () => {} })
  assert.equal(r.sent, 2)
  assert.deepEqual(bodies, ['a'.repeat(3000), 'b'.repeat(3000)])
})

test("sendMessage: Telegram's error is logged and returned with its status and text, and stops the run", async () => {
  const logs = []
  let n = 0
  const f = async () => (n++, { ok: false, status: 400, json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }) })
  const text = ['a'.repeat(3000), 'b'.repeat(3000)].join('\n\n')
  const r = await sendMessage({ chatId: '1', text }, { env: ENV, fetch: f, log: (m) => logs.push(m) })
  assert.equal(r.ok, false)
  assert.equal(r.status, 400)
  assert.equal(r.error, 'Bad Request: chat not found')
  assert.equal(r.sent, 0)
  assert.equal(n, 1, 'no second part after a failure')
  assert.match(logs[0], /400.*chat not found/)
  assert.equal(logs[0].includes(ENV.TELEGRAM_BOT_TOKEN), false, 'the token never reaches a log line')
})

test('sendMessage: a network failure is a result, not a throw', async () => {
  const f = async () => { throw new Error('ECONNRESET') }
  const r = await sendMessage({ chatId: '1', text: 'x' }, { env: ENV, fetch: f, log: () => {} })
  assert.deepEqual([r.ok, r.error], [false, 'ECONNRESET'])
})

test('sendChatAction: posts the action, is silent on success, logs (but returns a result) on failure', async () => {
  const calls = []
  let ok1 = await sendChatAction({ chatId: '1' }, { env: ENV, fetch: async (u, o) => (calls.push({ u, o }), okResp()), log: () => assert.fail('should not log on success') })
  assert.equal(ok1, true)
  assert.deepEqual(JSON.parse(calls[0].o.body), { chat_id: '1', action: 'typing' })
  const logs = []
  const ok2 = await sendChatAction({ chatId: '1' }, { env: ENV, fetch: async () => ({ ok: false, status: 400, json: async () => ({ ok: false, description: 'boom' }) }), log: (m) => logs.push(m) })
  assert.equal(ok2, false)
  assert.match(logs[0], /boom/)
})

test('sendVoice: ONE multipart call — chat_id and the file, no separate upload step', async () => {
  const calls = []
  const bytes = Buffer.from('OGG-fake-opus')
  const f = async (url, opts) => {
    calls.push({ url, opts })
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 2 } }) }
  }
  const r = await sendVoice({ chatId: '111', bytes }, { env: ENV, fetch: f, log: () => {} })
  assert.deepEqual(r, { ok: true })
  assert.equal(calls.length, 1, 'one call does the whole job, unlike WhatsApp')
  assert.equal(calls[0].url, 'https://api.telegram.org/bot' + ENV.TELEGRAM_BOT_TOKEN + '/sendVoice')
  const form = calls[0].opts.body
  assert.ok(form instanceof FormData)
  assert.equal(form.get('chat_id'), '111')
  const file = form.get('voice')
  assert.equal(file.type, 'audio/ogg')
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes)
})

test('sendVoice: Telegram refusing the send, or a network error, is a result not a throw — and never logs the token', async () => {
  const logs = []
  const refused = await sendVoice({ chatId: '111', bytes: Buffer.from('x') }, { env: ENV, fetch: async () => ({ ok: false, status: 400, json: async () => ({ ok: false, description: 'VOICE_MESSAGES_FORBIDDEN' }) }), log: (m) => logs.push(m) })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /VOICE_MESSAGES_FORBIDDEN/)
  const thrown = await sendVoice({ chatId: '111', bytes: Buffer.from('x') }, { env: ENV, fetch: async () => { throw new Error('ECONNRESET') }, log: (m) => logs.push(m) })
  assert.deepEqual([thrown.ok, thrown.error], [false, 'ECONNRESET'])
  assert.ok(logs.every((l) => !l.includes(ENV.TELEGRAM_BOT_TOKEN)))
})

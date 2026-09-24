/* ------------------------------------------------------------------ *
 * addons/whatsapp — the Meta side: the handshake, the HMAC signature and the
 * 4096-char split, plus sendText's error reporting. The failure modes guarded
 * here are all quiet ones: an unset token that "matches" an empty query, a
 * webhook waved through with no secret, an answer cut mid-emoji.
 *
 * Hermetic: a stubbed fetch, explicit env objects, no network.
 * Run: node --test addons/whatsapp/test/meta.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { verifyHandshake, verifySignature, splitMessage, sendText } from '../api/meta.mjs'

const ENV = { WHATSAPP_VERIFY_TOKEN: 'v-token', WHATSAPP_ACCESS_TOKEN: 'a-token', WHATSAPP_PHONE_NUMBER_ID: '555' }
const sign = (raw, secret) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`

test('handshake: the right token echoes the challenge, anything else is refused', () => {
  const q = (o) => ({ 'hub.mode': 'subscribe', 'hub.verify_token': 'v-token', 'hub.challenge': '12345', ...o })
  assert.equal(verifyHandshake(q({}), ENV), '12345')
  assert.equal(verifyHandshake(q({ 'hub.verify_token': 'nope' }), ENV), null)
  assert.equal(verifyHandshake(q({ 'hub.verify_token': 'v-token-longer' }), ENV), null)
  assert.equal(verifyHandshake(q({ 'hub.mode': 'unsubscribe' }), ENV), null)
  assert.equal(verifyHandshake({}, ENV), null)
  assert.equal(verifyHandshake(q({ 'hub.verify_token': ['v-token'] }), ENV), null)
})

test('handshake: an UNSET verify token never verifies — not even an empty query token', () => {
  const q = { 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': 'c' }
  assert.equal(verifyHandshake(q, {}), null)
  assert.equal(verifyHandshake(q, { WHATSAPP_VERIFY_TOKEN: '' }), null)
})

test('signature: valid passes; tampered body, wrong secret, bad header shapes fail', () => {
  const raw = Buffer.from('{"entry":[]}')
  assert.equal(verifySignature(raw, sign(raw, 's3cret'), 's3cret'), true)
  assert.equal(verifySignature(Buffer.from('{"entry":[1]}'), sign(raw, 's3cret'), 's3cret'), false)
  assert.equal(verifySignature(raw, sign(raw, 'other'), 's3cret'), false)
  assert.equal(verifySignature(raw, undefined, 's3cret'), false)
  assert.equal(verifySignature(raw, 'sha256=zz', 's3cret'), false)
  assert.equal(verifySignature(raw, sign(raw, 's3cret').replace('sha256=', ''), 's3cret'), false)
  assert.equal(verifySignature(raw, sign(raw, 's3cret').toUpperCase().replace('SHA256=', 'sha256='), 's3cret'), true, 'hex case is not significant')
})

test('signature: NO secret refuses — even a signature made with the empty secret', () => {
  const raw = Buffer.from('{}')
  assert.equal(verifySignature(raw, sign(raw, ''), ''), false)
  assert.equal(verifySignature(raw, sign(raw, ''), undefined), false)
})

test('signature: only a Buffer is verifiable — a parsed object is not the signed bytes', () => {
  assert.equal(verifySignature({ entry: [] }, sign('{"entry":[]}', 's'), 's'), false)
})

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

const okResp = () => ({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.1' }] }) })

test('send: posts the Cloud API text payload with the access token', async () => {
  const calls = []
  const f = async (url, opts) => (calls.push({ url, opts }), okResp())
  const r = await sendText({ to: '+49 170 111', text: 'hi' }, { env: ENV, fetch: f, log: () => {} })
  assert.deepEqual(r, { ok: true, sent: 1, parts: 1 })
  assert.equal(calls[0].url, 'https://graph.facebook.com/v21.0/555/messages')
  assert.equal(calls[0].opts.method, 'POST')
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer a-token')
  assert.deepEqual(JSON.parse(calls[0].opts.body), { messaging_product: 'whatsapp', to: '49170111', type: 'text', text: { body: 'hi' } })
})

test('send: a long text goes out as several messages, in order', async () => {
  const bodies = []
  const f = async (_u, opts) => (bodies.push(JSON.parse(opts.body).text.body), okResp())
  const text = ['a'.repeat(3000), 'b'.repeat(3000)].join('\n\n')
  const r = await sendText({ to: '1', text }, { env: ENV, fetch: f, log: () => {} })
  assert.equal(r.sent, 2)
  assert.deepEqual(bodies, ['a'.repeat(3000), 'b'.repeat(3000)])
})

test('send: Meta\'s error is logged and returned with its status and text, and stops the run', async () => {
  const logs = []
  let n = 0
  const f = async () => (n++, { ok: false, status: 400, json: async () => ({ error: { message: 'Recipient not in allowed list', code: 131030 } }) })
  const text = ['a'.repeat(3000), 'b'.repeat(3000)].join('\n\n')
  const r = await sendText({ to: '1', text }, { env: ENV, fetch: f, log: (m) => logs.push(m) })
  assert.equal(r.ok, false)
  assert.equal(r.status, 400)
  assert.equal(r.error, 'Recipient not in allowed list')
  assert.equal(r.sent, 0)
  assert.equal(n, 1, 'no second part after a failure')
  assert.match(logs[0], /400.*131030.*Recipient not in allowed list/)
})

test('send: the closed 24-hour window gets an explanation', async () => {
  const f = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Re-engagement message', code: 131047 } }) })
  const r = await sendText({ to: '1', text: 'x' }, { env: ENV, fetch: f, log: () => {} })
  assert.match(r.error, /24-hour window/)
})

test('send: a network failure is a result, not a throw', async () => {
  const f = async () => { throw new Error('ECONNRESET') }
  const r = await sendText({ to: '1', text: 'x' }, { env: ENV, fetch: f, log: () => {} })
  assert.deepEqual([r.ok, r.error], [false, 'ECONNRESET'])
})

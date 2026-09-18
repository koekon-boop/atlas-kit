/* ------------------------------------------------------------------ *
 * The `voice` addon's client decisions (voice.ts) — the pure half.
 *
 * deriveEvents() is what decides HOW OFTEN THE DASHBOARD SPEAKS, so it is the
 * part worth pinning: a fleet poll that produced an event per poll instead of
 * per transition would turn auto-speak into a dashboard narrating itself, and a
 * first poll that reported history would make every page load recite the day.
 *
 * Runs the real TS module through node's native type-stripping (no build, no
 * browser): everything asserted here is pure — the DOM/speech half of voice.ts
 * is exercised in the browser, not here.
 * Run: node --test web/src/lib/voice.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  agentName,
  cleanForSpeech,
  deriveEvents,
  joinDictation,
  newestReply,
  nextSpeech,
  pickDictation,
  replySig,
  voiceStatus,
} from './voice.ts'

const AT = '2026-08-15T12:00:00.000Z'
const session = (over) => ({ id: 'a1', task: 'do a thing', status: 'running', lastOutput: 'tail text', ...over })

test('the first sighting of a session is never an event', () => {
  const { events, snapshot } = deriveEvents({}, [session({ status: 'idle' }), session({ id: 'a2', status: 'done' })], AT)
  assert.deepEqual(events, [])
  assert.deepEqual(snapshot, { a1: { status: 'idle', shipState: undefined }, a2: { status: 'done', shipState: undefined } })
})

test('a turn ends when an agent goes from running to idle — and only then', () => {
  const first = deriveEvents({}, [session({ status: 'running' })], AT)
  const { events } = deriveEvents(first.snapshot, [session({ status: 'idle' })], AT)
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'turn-end')
  assert.match(events[0].line, /ended a turn/)
  assert.equal(events[0].tail, 'tail text', 'the tail rides along, for the optional recap')

  // Still idle on the next poll → nothing new to say.
  const quiet = deriveEvents(
    { a1: { status: 'idle' } },
    [session({ status: 'idle' })],
    AT,
  )
  assert.deepEqual(quiet.events, [])
})

test('a parked agent is announced as waiting on you, not as having ended a turn', () => {
  const { events } = deriveEvents({ a1: { status: 'running' } }, [session({ status: 'idle', menu: true })], AT)
  assert.match(events[0].line, /waiting on you/)
})

test('ship signals: ready once, shipped once, and shipped wins a tie', () => {
  const ready = deriveEvents({ a1: { status: 'running' } }, [session({ status: 'idle', shipState: 'ready' })], AT)
  assert.equal(ready.events[0].kind, 'ready')

  // The same 'ready' on every subsequent poll must NOT re-announce itself.
  const stillReady = deriveEvents(ready.snapshot, [session({ status: 'idle', shipState: 'ready' })], AT)
  assert.deepEqual(stillReady.events, [])

  const shipped = deriveEvents(ready.snapshot, [session({ status: 'done', shipState: 'merged', shipInfo: 'PR #12 abc1234' })], AT)
  assert.equal(shipped.events.length, 1, 'merged AND done in one tick is one piece of news')
  assert.equal(shipped.events[0].kind, 'shipped')
  assert.match(shipped.events[0].line, /PR #12 abc1234/)
})

test('a session that ends or fails says so, once', () => {
  const done = deriveEvents({ a1: { status: 'running' } }, [session({ status: 'done' })], AT)
  assert.equal(done.events[0].kind, 'done')
  assert.deepEqual(deriveEvents(done.snapshot, [session({ status: 'done' })], AT).events, [])

  const failed = deriveEvents({ a1: { status: 'running' } }, [session({ status: 'error' })], AT)
  assert.equal(failed.events[0].kind, 'error')
})

test('events carry a key that is stable per agent, kind and poll', () => {
  const { events } = deriveEvents({ a1: { status: 'running' } }, [session({ status: 'idle' })], AT)
  assert.equal(events[0].key, `a1:turn-end:${AT}`)
})

test('an agent is named for the ear: shortest useful label, truncated', () => {
  assert.equal(agentName({ micro: 'docs sweep', title: 'Sweep the docs', task: 'x', id: 'a1' }), 'docs sweep')
  assert.equal(agentName({ title: 'Sweep the docs', task: 'x', id: 'a1' }), 'Sweep the docs')
  assert.equal(agentName({ task: '  a  long   task  ', id: 'a1' }), 'a long task')
  assert.equal(agentName({ id: 'a1' }), 'a1')
  const long = agentName({ task: 'x'.repeat(200), id: 'a1' })
  assert.equal(long.length, 58)
  assert.ok(long.endsWith('…'))
})

test('dictation appends to the draft — it never replaces it', () => {
  assert.equal(joinDictation('Fix the', ' parser  bug '), 'Fix the parser bug')
  assert.equal(joinDictation('', 'from scratch'), 'from scratch')
  assert.equal(joinDictation('typed only', ''), 'typed only')
})

test('the box engine wins where it is configured — even over Chrome\'s; the browser is the fallback; neither is a reason', () => {
  assert.deepEqual(pickDictation(true, true), { engine: 'on-box', reason: '' }, 'an on-box STT must keep Chrome audio off Google')
  assert.deepEqual(pickDictation(true, false), { engine: 'browser', reason: '' })
  assert.equal(pickDictation(false, true).engine, 'on-box')
  const none = pickDictation(false, false)
  assert.equal(none.engine, 'none')
  assert.match(none.reason, /ATLAS_VOICE_STT_CMD/)
})

test('voiceStatus tolerates an addon that is absent or answering something else', () => {
  assert.equal(voiceStatus(null), null)
  assert.equal(voiceStatus({ name: 'voice', description: '', hooks: [], status: null }), null)
  assert.equal(voiceStatus({ name: 'voice', description: '', hooks: [], status: { error: 'boom' } }), null)
  const real = { tts: { configured: false, available: false }, stt: { configured: false, available: false } }
  assert.equal(voiceStatus({ name: 'voice', description: '', hooks: [], status: real }), real)
})

/* --- read replies aloud (the header toggle) ----------------------------- *
 * nextSpeech is what stops the toggle from narrating the backlog — a page load,
 * a toggle flip or a chat switch must seed silently and only speak what arrives
 * AFTER. Pure, so it is pinned here rather than in the browser.
 */

const reply = (over) => ({ role: 'assistant', ts: '2026-08-31T10:00:00Z', text: 'hello', tools: [], ...over })
const hist = (...messages) => ({ messages })

test('nextSpeech: nothing is spoken while the toggle is off', () => {
  const r = nextSpeech({ armed: false, lastSig: null }, { on: false, loaded: true, idle: true, reply: reply() })
  assert.equal(r.speak, null)
  assert.equal(r.state.armed, false)
})

test('nextSpeech: arming on an existing chat only seeds — the backlog is never narrated', () => {
  const seed = nextSpeech(
    { armed: false, lastSig: null },
    { on: true, loaded: true, idle: true, reply: reply({ text: 'an old backlog reply' }) },
  )
  assert.equal(seed.speak, null, 'the reply already on screen is not read out')
  assert.equal(seed.state.armed, true)
  const again = nextSpeech(seed.state, { on: true, loaded: true, idle: true, reply: reply({ text: 'an old backlog reply' }) })
  assert.equal(again.speak, null, 'still the same newest reply → still silent')
})

test('nextSpeech: an unloaded history never speaks or arms', () => {
  const r = nextSpeech({ armed: false, lastSig: null }, { on: true, loaded: false, idle: true, reply: null })
  assert.equal(r.speak, null)
  assert.equal(r.state.armed, false)
})

test('nextSpeech: a NEW reply after arming is spoken once, verbatim, only when the turn is done', () => {
  const seed = nextSpeech({ armed: false, lastSig: null }, { on: true, loaded: true, idle: false, reply: null })
  const streaming = nextSpeech(seed.state, { on: true, loaded: true, idle: false, reply: reply({ ts: 't2', text: 'partial…' }) })
  assert.equal(streaming.speak, null, 'a reply mid-turn (agent still running) is not spoken')
  const done = nextSpeech(streaming.state, { on: true, loaded: true, idle: true, reply: reply({ ts: 't2', text: 'the full answer' }) })
  assert.equal(done.speak, 'the full answer')
  const repoll = nextSpeech(done.state, { on: true, loaded: true, idle: true, reply: reply({ ts: 't2', text: 'the full answer' }) })
  assert.equal(repoll.speak, null, 'the same reply is not spoken again on the next poll')
})

test('nextSpeech: turning the toggle off disarms — re-arming re-seeds, still no backlog', () => {
  const spoke = nextSpeech({ armed: true, lastSig: 'old' }, { on: true, loaded: true, idle: true, reply: reply({ ts: 't9', text: 'newest' }) })
  assert.equal(spoke.speak, 'newest')
  const off = nextSpeech(spoke.state, { on: false, loaded: true, idle: true, reply: reply({ ts: 't9', text: 'newest' }) })
  assert.equal(off.state.armed, false)
  const back = nextSpeech(off.state, { on: true, loaded: true, idle: true, reply: reply({ ts: 't9', text: 'newest' }) })
  assert.equal(back.speak, null, 're-seeded against what is on screen now')
})

test('newestReply picks the last assistant turn that actually said something', () => {
  assert.equal(newestReply(null), null)
  assert.equal(
    newestReply(hist(reply({ text: 'a' }), { role: 'user', ts: null, text: 'q', tools: [] }, reply({ text: 'b' }))).text,
    'b',
  )
  assert.equal(
    newestReply(hist(reply({ text: 'real' }), reply({ text: '   ' }))).text,
    'real',
    'an empty / tool-only trailing turn does not count',
  )
})

test('replySig changes when the reply grows or a new turn starts', () => {
  assert.notEqual(replySig(reply({ ts: 't', text: 'hi' })), replySig(reply({ ts: 't', text: 'hi there' })))
  assert.notEqual(replySig(reply({ ts: 't1', text: 'x' })), replySig(reply({ ts: 't2', text: 'x' })))
})

test('cleanForSpeech strips markdown, code fences and links down to plain prose', () => {
  const md = '# Heading\n\nHere is `code` and a [link](https://x.com) and **bold**.\n\n```\nrm -rf /\n```\n\n- one\n- two'
  const out = cleanForSpeech(md)
  assert.doesNotMatch(out, /```|rm -rf|\]\(http|\*\*/)
  assert.doesNotMatch(out, /^#/m)
  assert.match(out, /Here is code and a link and bold/)
  assert.match(out, /code block/)
})

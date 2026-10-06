/* ------------------------------------------------------------------ *
 * addons/telegram — the long-poll consumer: the singleton pidfile lock, offset
 * persistence, error backoff, and the getUpdates loop itself.
 *
 * What this pins:
 *   · claimSingleton: exclusive create, a stale lock (dead pid) is reclaimed, a
 *     live one is respected — never throws;
 *   · pollOnce drives ONE getUpdates call at the persisted offset, calls
 *     onUpdate per result IN ORDER, and persists the offset after EACH one (not
 *     once per batch);
 *   · a getUpdates failure is a result, not a throw, and does not move the offset;
 *   · createPoller claims the lock once, loses to an already-held one, and backs
 *     off (doubling, capped) between failed polls — driven deterministically via
 *     `_maxIterations` and a fake `sleep`, never a real timer or a hanging fetch;
 *   · onTick runs after every iteration (hit or miss) and a throw from it never
 *     stops the loop — the periodic hook register.mjs wires to a chat route's retry.
 * Run: node --test addons/telegram/test/poller.test.mjs
 * ------------------------------------------------------------------ */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { claimSingleton, createPoller, nextBackoff, pollOnce, readOffset, releaseSingleton, saveOffset } from '../api/poller.mjs'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-poller-test-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const ENV = { TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_HOME_CHAT_ID: '111', TELEGRAM_POLL_TIMEOUT_S: '1' }
const lock = () => path.join(TMP, `lock-${crypto.randomUUID()}`)
const off = () => path.join(TMP, `offset-${crypto.randomUUID()}.json`)

/* --- claimSingleton --------------------------------------------------------- */

test('claimSingleton: the first caller owns it, a second (different, ALIVE, foreign) pid is refused', () => {
  const f = lock()
  assert.equal(claimSingleton(f, process.pid), true)
  assert.equal(claimSingleton(f, process.ppid), false, 'process.pid owns it and is alive, so ppid loses')
  assert.equal(fs.existsSync(f), true)
})

test('claimSingleton: the SAME pid reclaims its own lock (a re-register in the same process)', () => {
  const f = lock()
  assert.equal(claimSingleton(f, process.pid), true)
  assert.equal(claimSingleton(f, process.pid), true, 'not a foreign lock, so it is reclaimed')
})

test('claimSingleton: a stale lock (dead pid) is reclaimed automatically', () => {
  const f = lock()
  // a pid that (almost certainly) does not exist
  fs.writeFileSync(f, JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }))
  assert.equal(claimSingleton(f, process.pid), true)
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf-8')).pid, process.pid)
})

test('claimSingleton: an unwritable directory fails closed (false, never a throw)', () => {
  const bogus = path.join(TMP, 'not-a-real-file-as-a-dir', 'x')
  fs.writeFileSync(path.join(TMP, 'not-a-real-file-as-a-dir'), 'x') // a FILE where the lock's parent dir should be
  assert.equal(claimSingleton(bogus, 1), false)
})

test('releaseSingleton: removes only a lock this pid still owns', () => {
  const f = lock()
  claimSingleton(f, process.pid)
  releaseSingleton(f, 12345) // not us
  assert.equal(fs.existsSync(f), true, 'a foreign pid cannot release our lock')
  releaseSingleton(f, process.pid)
  assert.equal(fs.existsSync(f), false)
  assert.doesNotThrow(() => releaseSingleton(f, process.pid), 'releasing an already-gone lock is silent')
})

/* --- offset persistence ----------------------------------------------------- */

test('readOffset: 0 for an absent or corrupt file, never a throw', () => {
  assert.equal(readOffset(path.join(TMP, 'nope.json')), 0)
  const bad = off()
  fs.writeFileSync(bad, 'not json')
  assert.equal(readOffset(bad), 0)
})

test('saveOffset + readOffset round-trip, tmp+rename (no partial file survives a read)', () => {
  const f = off()
  saveOffset(f, 42)
  assert.equal(readOffset(f), 42)
  assert.equal(fs.existsSync(`${f}.tmp`), false)
})

/* --- nextBackoff ------------------------------------------------------------- */

test('nextBackoff: starts at base, doubles, caps at max', () => {
  assert.equal(nextBackoff(0, 1000, 30000), 1000)
  assert.equal(nextBackoff(1000, 1000, 30000), 2000)
  assert.equal(nextBackoff(20000, 1000, 30000), 30000)
  assert.equal(nextBackoff(30000, 1000, 30000), 30000)
})

/* --- pollOnce ----------------------------------------------------------------- */

const updates = (...ids) => ids.map((id) => ({ update_id: id, message: { message_id: id, chat: { id: 1 }, text: `msg ${id}` } }))

test('pollOnce: one getUpdates call at the persisted offset, onUpdate per result in order, offset advanced after EACH', async () => {
  const offsetFile = off()
  saveOffset(offsetFile, 100)
  const calls = []
  const seen = []
  const f = async (url) => {
    calls.push(url)
    return { ok: true, json: async () => ({ ok: true, result: updates(100, 101, 102) }) }
  }
  // Read INSIDE onUpdate: this captures the file as it stands DURING that
  // update's handling — i.e. before this update's own offset is persisted, but
  // (from the second update on) already carrying the PREVIOUS update's save.
  // If persistence happened once at the end of the whole batch instead, every
  // one of these reads would see the original 100.
  const offsetsDuringEach = []
  const r = await pollOnce({ env: ENV, fetch: f, log: () => {}, offsetFile, onUpdate: async (u) => { seen.push(u.update_id); offsetsDuringEach.push(readOffset(offsetFile)) } })
  assert.equal(r.ok, true)
  assert.equal(r.count, 3)
  assert.deepEqual(seen, [100, 101, 102])
  assert.equal(calls.length, 1)
  assert.match(calls[0], /offset=100/)
  assert.match(calls[0], /timeout=1\b/)
  assert.equal(readOffset(offsetFile), 103, 'the FINAL offset, after the whole batch')
  assert.deepEqual(offsetsDuringEach, [100, 101, 102], 'each save lands before the NEXT update is handled, not once per batch')
})

test('pollOnce: an onUpdate that throws is caught, logged, and does not stop the offset from advancing', async () => {
  const offsetFile = off()
  const f = async () => ({ ok: true, json: async () => ({ ok: true, result: updates(1, 2) }) })
  const logs = []
  const r = await pollOnce({ env: ENV, fetch: f, log: (m) => logs.push(m), offsetFile, onUpdate: async (u) => { if (u.update_id === 1) throw new Error('agent route down') } })
  assert.equal(r.ok, true)
  assert.equal(readOffset(offsetFile), 3)
  assert.match(logs.join('\n'), /agent route down/)
})

test('pollOnce: getUpdates failing (HTTP error, Telegram error, or a thrown fetch) is a result, offset untouched', async () => {
  const offsetFile = off()
  saveOffset(offsetFile, 5)
  for (const f of [
    async () => ({ ok: false, status: 401, json: async () => ({ ok: false, description: 'Unauthorized' }) }),
    async () => { throw new Error('ECONNRESET') },
    async () => ({ ok: true, json: async () => ({ ok: false, description: 'terminated by other getUpdates request' }) }), // the 409 case
  ]) {
    const logs = []
    const r = await pollOnce({ env: ENV, fetch: f, log: (m) => logs.push(m), offsetFile, onUpdate: async () => assert.fail('never called') })
    assert.equal(r.ok, false)
    assert.ok(r.error)
    assert.equal(readOffset(offsetFile), 5, 'a failed poll never moves the offset')
    assert.ok(logs.some((l) => l.includes(r.error)))
  }
})

test('pollOnce: an empty result list is fine — count 0, offset unchanged', async () => {
  const offsetFile = off()
  saveOffset(offsetFile, 9)
  const f = async () => ({ ok: true, json: async () => ({ ok: true, result: [] }) })
  const r = await pollOnce({ env: ENV, fetch: f, log: () => {}, offsetFile, onUpdate: async () => assert.fail() })
  assert.deepEqual(r, { ok: true, count: 0 })
  assert.equal(readOffset(offsetFile), 9)
})

/* --- createPoller -------------------------------------------------------------- */

test('createPoller: not the owner (lock already held by a live, FOREIGN pid) → no polling at all', async () => {
  const lockFile = lock()
  const offsetFile = off()
  // process.ppid is a real, live, but foreign pid from this test's point of view.
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }))
  const calls = []
  const p = createPoller({ env: ENV, fetch: async (u) => (calls.push(u), { ok: true, json: async () => ({ ok: true, result: [] }) }), log: () => {}, offsetFile, lockFile, onUpdate: async () => {}, _maxIterations: 3 })
  await p.ready
  assert.equal(p.status().owner, false)
  assert.equal(calls.length, 0, 'never even calls getUpdates when it lost the race')
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf-8')).pid, process.ppid, 'the foreign lock is left untouched')
})

test('createPoller: the lock IS claimed when it names this same process (a re-register)', async () => {
  const lockFile = lock()
  const offsetFile = off()
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
  const p = createPoller({ env: ENV, fetch: async () => ({ ok: true, json: async () => ({ ok: true, result: [] }) }), log: () => {}, offsetFile, lockFile, onUpdate: async () => {}, _maxIterations: 1 })
  await p.ready
  assert.equal(p.status().owner, true)
})

test('createPoller: claims the lock, polls _maxIterations times, backs off (doubling) on repeated failure, and .stop() releases it', async () => {
  const lockFile = lock()
  const offsetFile = off()
  let n = 0
  const f = async () => {
    n++
    return { ok: false, status: 500, json: async () => ({ ok: false, description: 'server error' }) }
  }
  const sleeps = []
  const p = createPoller({ env: ENV, fetch: f, log: () => {}, offsetFile, lockFile, onUpdate: async () => {}, sleep: (ms) => (sleeps.push(ms), Promise.resolve()), _maxIterations: 4 })
  await p.ready
  assert.equal(n, 4)
  assert.deepEqual(sleeps, [1000, 2000, 4000, 8000], 'doubling from TELEGRAM_POLL_ERROR_BACKOFF_MS, no real delay')
  assert.equal(p.status().pollCount, 4)
  assert.match(p.status().lastError, /server error/)
  assert.equal(fs.existsSync(lockFile), true, 'still held until stop()')
  p.stop()
  assert.equal(fs.existsSync(lockFile), false)
})

test('createPoller: a successful poll resets the backoff to the base on the next failure', async () => {
  const lockFile = lock()
  const offsetFile = off()
  let n = 0
  const f = async () => {
    n++
    if (n === 2) return { ok: true, json: async () => ({ ok: true, result: [] }) }
    return { ok: false, status: 500, json: async () => ({ ok: false, description: 'x' }) }
  }
  const sleeps = []
  const p = createPoller({ env: ENV, fetch: f, log: () => {}, offsetFile, lockFile, onUpdate: async () => {}, sleep: (ms) => (sleeps.push(ms), Promise.resolve()), _maxIterations: 3 })
  await p.ready
  assert.deepEqual(sleeps, [1000, 1000], 'the ok poll (#2) reset backoff to base before failure #3')
})

test('createPoller: onTick runs after EVERY pollOnce (hit or miss), and a throwing one is caught, logged, and never stops the loop', async () => {
  const lockFile = lock()
  const offsetFile = off()
  let ticks = 0
  const logs = []
  const p = createPoller({
    env: ENV, fetch: async () => ({ ok: true, json: async () => ({ ok: true, result: [] }) }), log: (m) => logs.push(m),
    offsetFile, lockFile, onUpdate: async () => {}, onTick: () => { ticks++; throw new Error('route flush boom') }, _maxIterations: 3,
  })
  await p.ready
  assert.equal(ticks, 3, 'once per iteration, including the ones with nothing to update')
  assert.equal(p.status().pollCount, 3, 'the throw never stopped the poll loop')
  assert.match(logs.join('\n'), /route flush boom/)
})

test('createPoller: without onTick, nothing is called — it is fully optional', async () => {
  const lockFile = lock()
  const offsetFile = off()
  const p = createPoller({ env: ENV, fetch: async () => ({ ok: true, json: async () => ({ ok: true, result: [] }) }), log: () => {}, offsetFile, lockFile, onUpdate: async () => {}, _maxIterations: 2 })
  await assert.doesNotReject(p.ready)
  assert.equal(p.status().pollCount, 2)
})

test('createPoller: TELEGRAM_BOT_TOKEN missing means register.mjs never starts one — covered by register.test via buildRoutes; here just confirm createPoller itself does not care (it is register()\'s job to gate on the token)', async () => {
  const lockFile = lock()
  const offsetFile = off()
  const p = createPoller({ env: { ...ENV, TELEGRAM_BOT_TOKEN: '' }, fetch: async () => ({ ok: true, json: async () => ({ ok: true, result: [] }) }), log: () => {}, offsetFile, lockFile, onUpdate: async () => {}, _maxIterations: 1 })
  await p.ready
  assert.equal(p.status().owner, true, 'createPoller itself still polls if asked to — the token gate lives in register.mjs')
})

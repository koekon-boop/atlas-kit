/* ------------------------------------------------------------------ *
 * addons/telegram — the long-poll consumer: the singleton pidfile lock, offset
 * persistence, error backoff, and the getUpdates loop itself.
 *
 * What this pins:
 *   · claimSingleton: exclusive create, a stale lock (dead pid) is reclaimed, a
 *     live one is respected — never throws; an EMPTY or PARTIAL lock is HELD (never
 *     deleted for failing to parse) until it is old; and under real concurrency —
 *     separate processes released at the same instant, on no lock / a dead-pid lock
 *     / an old empty or partial lock — exactly ONE claimant wins (the 2026-10-26
 *     incident: two processes both polled after a mass restart);
 *   · pollOnce drives ONE getUpdates call at the persisted offset, calls
 *     onUpdate per result IN ORDER, and persists the offset after EACH one (not
 *     once per batch);
 *   · a getUpdates failure is a result, not a throw, and does not move the offset;
 *   · createPoller claims the lock once, loses to an already-held one, and backs
 *     off (doubling, capped) between failed polls — driven deterministically via
 *     `_maxIterations` and a fake `sleep`, never a real timer or a hanging fetch;
 *   · failover: a non-owner keeps re-trying the claim and takes over once the
 *     owner's pid is dead; a 409 Conflict while the lock names another live pid
 *     makes the poller yield instead of fighting;
 *   · onTick runs after every iteration (hit or miss) and a throw from it never
 *     stops the loop — the periodic hook register.mjs wires to a chat route's retry.
 * Run: node --test addons/telegram/test/poller.test.mjs
 * ------------------------------------------------------------------ */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CLAIM_RETRY_MS, claimSingleton, createPoller, nextBackoff, pollOnce, readOffset, releaseSingleton, saveOffset } from '../api/poller.mjs'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-poller-test-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const ENV = { TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_HOME_CHAT_ID: '111', TELEGRAM_POLL_TIMEOUT_S: '1' }
const lock = () => path.join(TMP, `lock-${crypto.randomUUID()}`)
const off = () => path.join(TMP, `offset-${crypto.randomUUID()}.json`)
/** A pid that certainly WAS a process and is now dead. */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid
const age = (f, s = 60) => fs.utimesSync(f, new Date(Date.now() - s * 1000), new Date(Date.now() - s * 1000))

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

test('claimSingleton: an EMPTY or PARTIAL lock (a writer mid-write) is HELD — refused, and never deleted for failing to parse', () => {
  // The incident path, deterministically: a claimant got EEXIST, read the owner's
  // lock before its content was written, failed to parse it, deleted it as
  // "stale", and claimed it too — two owners. Now a young unreadable lock is held.
  for (const content of ['', '{"pid":', 'garbage']) {
    const f = lock()
    fs.writeFileSync(f, content)
    assert.equal(claimSingleton(f, process.pid), false, `${JSON.stringify(content)} is held while young`)
    assert.equal(fs.readFileSync(f, 'utf-8'), content, 'left exactly as it was')
  }
})

test('claimSingleton: an unreadable lock that has been unreadable for a while (old mtime) is stale and reclaimed', () => {
  const f = lock()
  fs.writeFileSync(f, '')
  age(f)
  assert.equal(claimSingleton(f, process.pid), true)
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf-8')).pid, process.pid)
})

test('claimSingleton: the lock file is never visible empty — created complete (temp file + link), no temp or mutex left behind', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'atomic-'))
  const f = path.join(dir, 'telegram-poller.lock')
  assert.equal(claimSingleton(f, process.pid), true)
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf-8')).pid, process.pid)
  fs.writeFileSync(f, JSON.stringify({ pid: deadPid() }))
  assert.equal(claimSingleton(f, process.pid), true, 'stale → reclaimed')
  assert.deepEqual(fs.readdirSync(dir), ['telegram-poller.lock'])
})

test('claimSingleton: a reclaim mutex left by a crashed reclaimer only blocks while young, then is broken', () => {
  const f = lock()
  fs.writeFileSync(f, JSON.stringify({ pid: deadPid() }))
  fs.writeFileSync(`${f}.reclaim`, '1')
  assert.equal(claimSingleton(f, process.pid), false, 'someone is reclaiming right now — let them')
  age(`${f}.reclaim`)
  assert.equal(claimSingleton(f, process.pid), false, 'this attempt breaks the abandoned mutex…')
  assert.equal(fs.existsSync(`${f}.reclaim`), false)
  assert.equal(claimSingleton(f, process.pid), true, '…and the next retry reclaims the lock')
})

/* --- claimSingleton under real concurrency ------------------------------------ *
 * N separate node processes, each released at the same wall-clock instant, each
 * calling claimSingleton() once on the SAME lock and then staying ALIVE (a dead
 * winner would just be a stale lock) until every one has answered.            */

const POLLER_URL = new URL('../api/poller.mjs', import.meta.url).href
const CLAIMANT = `
  import { claimSingleton } from ${JSON.stringify(POLLER_URL)}
  const at = Number(process.env.START_AT)
  while (Date.now() < at) {}
  process.stdout.write(claimSingleton(process.env.LOCK) ? 'owner' : 'not')
  process.stdin.resume()
  process.stdin.on('end', () => process.exit(0))
`

async function race(lockFile, n = 8) {
  const START_AT = String(Date.now() + 700)
  const kids = Array.from({ length: n }, () => spawn(process.execPath, ['--input-type=module', '-e', CLAIMANT], { env: { ...process.env, LOCK: lockFile, START_AT } }))
  const answers = await Promise.all(kids.map((k) => new Promise((resolve, reject) => {
    let out = ''
    k.stdout.on('data', (d) => { out += d; if (out === 'owner' || out === 'not') resolve({ pid: k.pid, out }) })
    k.on('exit', (code) => reject(new Error(`claimant exited (${code}) before answering: ${out}`)))
  })))
  const owners = answers.filter((a) => a.out === 'owner')
  const holder = JSON.parse(fs.readFileSync(lockFile, 'utf-8')).pid
  await Promise.all(kids.map((k) => new Promise((r) => { k.on('exit', r); k.stdin.end() })))
  return { owners, holder }
}

for (const [name, seed] of [
  ['no lock at all', () => {}],
  ['a dead-pid lock (the restart case: every claimant sees it stale at once)', (f) => fs.writeFileSync(f, JSON.stringify({ pid: deadPid(), startedAt: new Date().toISOString() }))],
  ['an old EMPTY lock', (f) => { fs.writeFileSync(f, ''); age(f) }],
  ['an old PARTIAL lock', (f) => { fs.writeFileSync(f, '{"pid":'); age(f) }],
]) {
  test(`claimSingleton race: ${name} + 8 concurrent claimants → exactly ONE owner, and the lock names it (5 rounds)`, async () => {
    for (let round = 0; round < 5; round++) {
      const dir = fs.mkdtempSync(path.join(TMP, 'race-'))
      const f = path.join(dir, 'telegram-poller.lock')
      seed(f)
      const { owners, holder } = await race(f)
      assert.equal(owners.length, 1, `round ${round}: ${owners.length} owners`)
      assert.equal(holder, owners[0].pid, 'the lock names the one owner')
      assert.deepEqual(fs.readdirSync(dir), ['telegram-poller.lock'], 'no temp file or reclaim mutex left behind')
    }
  })
}

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
  const sleeps = []
  const p = createPoller({ env: ENV, fetch: async (u) => (calls.push(u), { ok: true, json: async () => ({ ok: true, result: [] }) }), log: () => {}, offsetFile, lockFile, onUpdate: async () => {}, sleep: (ms) => (sleeps.push(ms), Promise.resolve()), _maxIterations: 3 })
  await p.ready
  assert.equal(p.status().owner, false)
  assert.equal(calls.length, 0, 'never even calls getUpdates when it lost the race')
  assert.deepEqual(sleeps, [CLAIM_RETRY_MS, CLAIM_RETRY_MS, CLAIM_RETRY_MS], 'it only waits and re-tries the claim, the owner being alive')
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

/* --- failover and yield ----------------------------------------------------------- */

test('createPoller failover: a non-owner re-tries the claim and takes over polling once the owner\'s pid is dead', async () => {
  const lockFile = lock()
  const offsetFile = off()
  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']) // a live, foreign owner
  fs.writeFileSync(lockFile, JSON.stringify({ pid: owner.pid, startedAt: new Date().toISOString() }))
  const calls = []
  const logs = []
  const sleeps = []
  const p = createPoller({
    env: ENV, fetch: async (u) => (calls.push(u), { ok: true, json: async () => ({ ok: true, result: [] }) }), log: (m) => logs.push(m),
    offsetFile, lockFile, onUpdate: async () => {}, claimRetryMs: 45,
    // the owner dies during this process' SECOND claim-retry wait
    sleep: async (ms) => { sleeps.push(ms); if (sleeps.length === 2) await new Promise((r) => { owner.on('exit', r); owner.kill() }) },
    _maxIterations: 4,
  })
  assert.equal(p.status().owner, false, 'lost at start — the owner is alive')
  await p.ready
  assert.deepEqual(sleeps, [45, 45], 'one retry while the owner lived, the second found it dead')
  assert.equal(p.status().owner, true)
  assert.equal(calls.length, 2, 'the two remaining turns polled')
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf-8')).pid, process.pid)
  assert.match(logs.join('\n'), /takes over/)
  p.stop()
})

const conflict = async () => ({ ok: false, status: 409, json: async () => ({ ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running' }) })

test('createPoller yield: a 409 Conflict while the lock names another LIVE pid stops polling here (no fight), and the foreign lock is left alone', async () => {
  const lockFile = lock()
  const offsetFile = off()
  let n = 0
  const sleeps = []
  const logs = []
  const p = createPoller({
    env: ENV,
    // the first poll succeeds; then another live process (ppid) holds the lock and polls too → 409
    fetch: async (u) => { if (++n === 1) return { ok: true, json: async () => ({ ok: true, result: [] }) }; fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid })); return conflict() },
    log: (m) => logs.push(m), offsetFile, lockFile, onUpdate: async () => {}, sleep: (ms) => (sleeps.push(ms), Promise.resolve()), _maxIterations: 5,
  })
  assert.equal(p.status().owner, true)
  await p.ready
  assert.equal(n, 2, 'polled until the first Conflict, never again')
  assert.equal(p.status().owner, false)
  assert.deepEqual(sleeps, [CLAIM_RETRY_MS, CLAIM_RETRY_MS, CLAIM_RETRY_MS], 'no error backoff — straight to re-trying the claim')
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf-8')).pid, process.ppid, 'the other owner\'s lock untouched')
  assert.match(logs.join('\n'), /yielding/)
})

test('createPoller: a 409 Conflict while the lock is still OURS (a consumer outside this box) → keep the lock, back off, keep polling', async () => {
  const lockFile = lock()
  const offsetFile = off()
  let n = 0
  const sleeps = []
  const p = createPoller({ env: ENV, fetch: async () => (n++, conflict()), log: () => {}, offsetFile, lockFile, onUpdate: async () => {}, sleep: (ms) => (sleeps.push(ms), Promise.resolve()), _maxIterations: 3 })
  await p.ready
  assert.equal(n, 3)
  assert.equal(p.status().owner, true)
  assert.deepEqual(sleeps, [1000, 2000, 4000])
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf-8')).pid, process.pid)
  p.stop()
})

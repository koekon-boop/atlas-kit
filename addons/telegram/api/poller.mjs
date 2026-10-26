/* ------------------------------------------------------------------ *
 * The inbound side of the bridge: Telegram has no public webhook target on
 * this box (it sits behind Tailscale, no exposed port for Telegram to push
 * to), so this addon PULLS with `getUpdates` long-polling instead.
 *
 * 🔴 A TELEGRAM BOT ALLOWS EXACTLY ONE ACTIVE `getUpdates` CONSUMER. A second
 * one racing the same token gets Telegram's own 409 Conflict — and this repo's
 * `loadAddons()` runs in the MAIN API *and* in a fresh `api/src/mcp/server.mjs`
 * process for EVERY agent session (dev agents, the Atlas worker, the
 * orchestrator all spawn one over stdio — see docs/ADDONS.md and
 * api/src/addons.mjs). Unconditionally starting a poll loop in `register()`
 * would start one per concurrent session. `claimSingleton()` is the guard: a
 * small pidfile lock so at most ONE process on this box actually polls; every
 * other one notices the live lock and stays out — but keeps re-trying the
 * claim, so it takes over when the owner dies (see README "Long-polling, not
 * a webhook").
 *
 *   claimSingleton()   pidfile lock: atomic create (complete file or none), a
 *                      stale one (dead pid) is reclaimed under a reclaim
 *                      mutex — never throws, → true/false
 *   pollOnce()         ONE getUpdates call at the current offset, `onUpdate`
 *                      per update, the offset persisted after each — the unit
 *                      every test drives directly (no timers, no real loop)
 *   createPoller()      pollOnce() in a loop with error backoff, a periodic
 *                      claim retry while not the owner, and a yield on 409
 *                      Conflict when the lock names another live owner; what
 *                      register() actually starts in production
 *
 * Nothing here throws past its own boundary: a getUpdates failure is a logged
 * line and a backoff, never a crash — an addon may never take the process down.
 * Everything takes its `fetch` / `sleep` as arguments, so the tests never sleep
 * for real and never hit the network.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import path from 'node:path'
import { apiUrl, config, offsetFile as defaultOffsetFile, lockFile as defaultLockFile } from './config.mjs'

/** The update kinds this bridge subscribes to: messages, and taps on the inline
 *  buttons the bot itself sent (README "Buttons"). Everything else is never delivered. */
// edited_message: a LIVE location arrives as one message, then as edits of it (README "Location");
// inbound.mjs reads only the location out of an edit and ignores every other edit.
export const ALLOWED_UPDATES = encodeURIComponent(JSON.stringify(['message', 'edited_message', 'callback_query']))

const isAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM' // exists, just not ours to signal
  }
}

/** An unreadable lock this young may be a writer mid-write — HELD, not stale.
 *  (Locks this module writes are never partial; this covers anything else.) */
const UNREADABLE_GRACE_MS = 10_000
/** A reclaim mutex older than this belongs to a reclaimer that died inside its
 *  few-microsecond critical section — it is broken (and the claim retried later). */
const RECLAIM_MUTEX_STALE_MS = 10_000

/** Create `file` with `data` ATOMICALLY: written in full to a private temp file,
 *  then hard-linked into place. link() fails with EEXIST if `file` exists, so a
 *  reader sees either no file or the complete content — never an empty or half-
 *  written one (`writeFileSync(…, { flag: 'wx' })` creates first and writes after,
 *  which is exactly the window the 2026-10-26 double poller fell into). Throws. */
function createAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  fs.writeFileSync(tmp, data, { mode: 0o600 })
  try {
    fs.linkSync(tmp, file)
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch {}
  }
}

/** → `{ pid }` (whatever JSON it holds), `null` if it exists but cannot be parsed,
 *  `undefined` if it is gone. */
function readLock(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf-8')
  } catch (e) {
    return e?.code === 'ENOENT' ? undefined : null
  }
  try {
    return JSON.parse(raw) ?? null
  } catch {
    return null
  }
}

const olderThan = (file, ms) => {
  try {
    return Date.now() - fs.statSync(file).mtimeMs > ms
  } catch {
    return false
  }
}

/** 'gone' | 'mine' | 'held' | 'stale' — the one place that decides what a lock means.
 *  Unreadable is HELD until it is older than UNREADABLE_GRACE_MS: a lock that failed
 *  to parse is never deleted on that ground alone. */
function lockState(lockFile, pid) {
  const held = readLock(lockFile)
  if (held === undefined) return 'gone'
  if (held === null || !Number.isInteger(held.pid)) return olderThan(lockFile, UNREADABLE_GRACE_MS) ? 'stale' : 'held'
  if (held.pid === pid) return 'mine'
  return isAlive(held.pid) ? 'held' : 'stale'
}

/** Pidfile lock: atomic create; a stale one (dead pid, or unreadable for longer
 *  than UNREADABLE_GRACE_MS) is reclaimed.
 *  → true if THIS process now owns it, false if another live process does (or a
 *  reclaim is in progress elsewhere — the caller simply retries later).
 *  Never throws — an unwritable state dir just means "not the owner here".
 *
 *  Reclaiming is the subtle part: two claimants that both judged the SAME dead
 *  lock stale must not both delete-and-recreate it (the second delete would hit
 *  the first one's fresh lock). So a stale lock is only ever removed while
 *  holding `<lock>.reclaim` (itself atomically created), after re-checking it is
 *  still stale — between that re-check and the unlink nobody else can create
 *  the lock (it exists) or delete it (they would need the mutex). */
export function claimSingleton(lockFile, pid = process.pid) {
  try {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true })
  } catch {
    return false
  }
  const body = () => JSON.stringify({ pid, startedAt: new Date().toISOString() })
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      createAtomic(lockFile, body())
      return true
    } catch (e) {
      if (e?.code !== 'EEXIST') return false
    }
    const state = lockState(lockFile, pid)
    if (state === 'gone') continue // released between our create and our read — try again
    if (state === 'mine') return true // a re-register in the same process
    if (state === 'held') return false // someone else genuinely holds it
    return reclaimStale(lockFile, pid, body)
  }
  return false
}

function reclaimStale(lockFile, pid, body) {
  const mutex = `${lockFile}.reclaim`
  try {
    createAtomic(mutex, String(pid))
  } catch (e) {
    // Someone else is reclaiming right now — they will own it. A mutex left behind
    // by a reclaimer that died mid-way is broken here; the claim retries later.
    if (e?.code === 'EEXIST' && olderThan(mutex, RECLAIM_MUTEX_STALE_MS)) {
      try {
        fs.unlinkSync(mutex)
      } catch {}
    }
    return false
  }
  try {
    const state = lockState(lockFile, pid)
    if (state === 'mine') return true
    if (state === 'held') return false
    if (state === 'stale') fs.unlinkSync(lockFile)
    createAtomic(lockFile, body())
    return true
  } catch {
    return false
  } finally {
    try {
      fs.unlinkSync(mutex)
    } catch {}
  }
}

/** Release the lock, but only if THIS process still holds it (never steals
 *  another owner's lock). Best-effort — staleness detection covers a crash. */
export function releaseSingleton(lockFile, pid = process.pid) {
  try {
    const held = JSON.parse(fs.readFileSync(lockFile, 'utf-8'))
    if (held?.pid === pid) fs.unlinkSync(lockFile)
  } catch {}
}

export function readOffset(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return Number.isInteger(j?.offset) ? j.offset : 0
  } catch {
    return 0
  }
}

export function saveOffset(file, offset, log = console.error) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ offset }, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch (e) {
    log(`[telegram] could not persist the poll offset: ${e?.message || e}`)
  }
}

/** current → next error-backoff delay, doubling up to `max`. Pure. */
export const nextBackoff = (current, base, max) => (current ? Math.min(current * 2, max) : base)

/**
 * ONE getUpdates call at the persisted offset, `onUpdate(update)` for each
 * result in order, the offset advanced and persisted AFTER each — so a crash
 * mid-batch redelivers at most the one update that was in flight, never the
 * whole batch. `onUpdate` throwing is caught and logged; it never stops the
 * offset from advancing (a message the agent side rejected must not be
 * redelivered forever — inbound.mjs's own reply-to-sender is what tells the
 * story of a failure, this loop's job is only "never redeliver the same update
 * twice on a clean run").
 * → `{ ok: true, count }` | `{ ok: false, error }`. Never throws.
 */
export async function pollOnce({ env = process.env, fetch: f = globalThis.fetch, log = console.error, onUpdate, offsetFile = defaultOffsetFile(env) } = {}) {
  const c = config(env)
  let offset = readOffset(offsetFile)
  let updates
  try {
    const url = `${apiUrl(c.botToken, 'getUpdates')}?timeout=${c.pollTimeoutS}&offset=${offset}&allowed_updates=${ALLOWED_UPDATES}`
    const r = await f(url, { signal: AbortSignal.timeout((c.pollTimeoutS + 10) * 1000) })
    const j = await r.json().catch(() => null)
    if (!r.ok || !j?.ok) throw new Error(j?.description || `HTTP ${r.status}`)
    updates = Array.isArray(j.result) ? j.result : []
  } catch (e) {
    const error = String(e?.message || e)
    log(`[telegram] getUpdates failed: ${error}`)
    return { ok: false, error }
  }
  for (const u of updates) {
    offset = Math.max(offset, u.update_id + 1)
    try {
      await onUpdate?.(u)
    } catch (e) {
      log(`[telegram] update handling failed: ${e?.message || e}`)
    }
    saveOffset(offsetFile, offset, log)
  }
  return { ok: true, count: updates.length }
}

// unref: a backoff or claim-retry timer never keeps a process alive on its own.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref())

/** How often a process that is NOT the owner re-tries the claim — the failover
 *  delay after the owner dies (e.g. the stdio MCP server of a closed session). */
export const CLAIM_RETRY_MS = 30_000

/** Telegram's answer when a second getUpdates consumer runs on the same token (HTTP 409). */
const CONFLICT = /\bConflict\b|terminated by other getUpdates request/i

/**
 * The production loop: claims the singleton, then calls pollOnce() forever,
 * backing off on error. If another process already owns the lock, this one
 * does not poll (`owner: false` in status()) but re-tries the claim every
 * `claimRetryMs` and starts polling once the owner is gone — failover without
 * a restart. An owner whose getUpdates answers 409 Conflict re-checks the lock:
 * if it now names another LIVE process, it yields (stops polling, back to
 * re-trying the claim) instead of fighting it; if the lock is still its own,
 * the conflict is someone outside this box and it just backs off.
 * `onTick` (optional), when given, runs after EVERY pollOnce() call — whether it
 * found updates or not — so a caller can piggyback a periodic retry on this
 * already-running loop (register.mjs wires it to inbound.flushRoutes(), the only
 * way a chat-route's stored message gets a second try without the sender writing
 * again). A throwing `onTick` is caught and logged; it never stops the poll.
 * `_maxIterations` is test-only: it stops the loop after that many turns (a
 * pollOnce() call or a claim retry) instead of running until `.stop()`, so tests never need a hanging
 * fetch or a real timer to end deterministically.
 */
export function createPoller({ env = process.env, fetch: f = globalThis.fetch, log = console.error, onUpdate, onTick, offsetFile = defaultOffsetFile(env), lockFile = defaultLockFile(env), sleep: sleepFn = sleep, claimRetryMs = CLAIM_RETRY_MS, _maxIterations = Infinity } = {}) {
  let owner = claimSingleton(lockFile)
  let stopped = false
  let backoff = 0
  let lastPollAt = null
  let lastError = null
  let pollCount = 0

  if (!owner) log('[telegram] another process already runs the getUpdates poller on this box — not starting a second one here (re-trying the claim in case it goes away)')

  const ready = (async () => {
    let i = 0
    while (!stopped && i < _maxIterations) {
      i++
      if (!owner) {
        await sleepFn(claimRetryMs)
        if (stopped) break
        owner = claimSingleton(lockFile)
        if (owner) log('[telegram] the previous getUpdates poller is gone — this process takes over polling')
        continue
      }
      const r = await pollOnce({ env, fetch: f, log, onUpdate, offsetFile })
      pollCount++
      if (r.ok) {
        backoff = 0
        lastError = null
      } else {
        lastError = r.error
        if (CONFLICT.test(r.error) && !claimSingleton(lockFile)) {
          owner = false
          backoff = 0
          log('[telegram] getUpdates Conflict and the lock is held by another live process — yielding the poll to it')
        } else {
          backoff = nextBackoff(backoff, config(env).pollErrorBackoffMs, config(env).pollErrorBackoffMaxMs)
          await sleepFn(backoff)
        }
      }
      lastPollAt = new Date().toISOString()
      try {
        await onTick?.()
      } catch (e) {
        log(`[telegram] onTick failed: ${e?.message || e}`)
      }
    }
  })()

  return {
    ready,
    stop() {
      stopped = true
      if (owner) releaseSingleton(lockFile)
    },
    status: () => ({ owner, lastPollAt, lastError, pollCount, offset: readOffset(offsetFile) }),
  }
}

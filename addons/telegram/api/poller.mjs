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
 * other one notices the live lock and stays out (see README "Long-polling,
 * not a webhook").
 *
 *   claimSingleton()   pidfile lock: exclusive create, and a stale one (dead
 *                      pid) is reclaimed — never throws, → true/false
 *   pollOnce()         ONE getUpdates call at the current offset, `onUpdate`
 *                      per update, the offset persisted after each — the unit
 *                      every test drives directly (no timers, no real loop)
 *   createPoller()      pollOnce() in a loop with error backoff; what
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

const isAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Exclusive-create a small pidfile; a stale one (its pid is dead) is reclaimed.
 *  → true if THIS process now owns it, false if another live process does.
 *  Never throws — an unwritable state dir just means "not the owner here". */
export function claimSingleton(lockFile, pid = process.pid) {
  try {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true })
  } catch {
    return false
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockFile, JSON.stringify({ pid, startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 })
      return true
    } catch (e) {
      if (e?.code !== 'EEXIST') return false
      let held = null
      try {
        held = JSON.parse(fs.readFileSync(lockFile, 'utf-8'))
      } catch {}
      if (held?.pid && held.pid !== pid && isAlive(held.pid)) return false // someone else genuinely holds it
      try {
        fs.unlinkSync(lockFile)
      } catch {} // stale (dead pid, or unreadable) — reclaim on the next attempt
    }
  }
  return false
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
    const url = `${apiUrl(c.botToken, 'getUpdates')}?timeout=${c.pollTimeoutS}&offset=${offset}&allowed_updates=%5B%22message%22%5D`
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * The production loop: claims the singleton, then calls pollOnce() forever,
 * backing off on error. If another process already owns the lock, this
 * returns immediately with `owner: false` in status() — no loop, no retry.
 * `onTick` (optional), when given, runs after EVERY pollOnce() call — whether it
 * found updates or not — so a caller can piggyback a periodic retry on this
 * already-running loop (register.mjs wires it to inbound.flushRoutes(), the only
 * way a chat-route's stored message gets a second try without the sender writing
 * again). A throwing `onTick` is caught and logged; it never stops the poll.
 * `_maxIterations` is test-only: it stops the loop after that many pollOnce()
 * calls instead of running until `.stop()`, so tests never need a hanging
 * fetch or a real timer to end deterministically.
 */
export function createPoller({ env = process.env, fetch: f = globalThis.fetch, log = console.error, onUpdate, onTick, offsetFile = defaultOffsetFile(env), lockFile = defaultLockFile(env), sleep: sleepFn = sleep, _maxIterations = Infinity } = {}) {
  const owner = claimSingleton(lockFile)
  let stopped = !owner
  let backoff = 0
  let lastPollAt = null
  let lastError = null
  let pollCount = 0

  if (!owner) log('[telegram] another process already runs the getUpdates poller on this box — not starting a second one here')

  const ready = (async () => {
    let i = 0
    while (!stopped && i < _maxIterations) {
      i++
      const r = await pollOnce({ env, fetch: f, log, onUpdate, offsetFile })
      pollCount++
      if (r.ok) {
        backoff = 0
        lastError = null
      } else {
        lastError = r.error
        backoff = nextBackoff(backoff, config(env).pollErrorBackoffMs, config(env).pollErrorBackoffMaxMs)
        await sleepFn(backoff)
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

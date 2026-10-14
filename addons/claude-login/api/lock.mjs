/* ------------------------------------------------------------------ *
 * A small pidfile lock — an addon is self-contained (docs/ADDONS.md), so this
 * is its own copy of the exact pattern addons/telegram's poller.mjs uses, not
 * an import across addon boundaries. Used for two separate things, each with
 * its own lock file:
 *
 *   1. THE WATCHER SINGLETON (watcher.mjs). `loadAddons()` runs in the main
 *      API AND in a fresh MCP stdio server per agent session — register() is
 *      called far more than once per box. Only the process that wins this
 *      lock runs the check interval.
 *   2. THE RENEWAL MUTEX (renew.mjs). Never two `claude auth login` tmux
 *      flows at once (the task's own "Lock gegen parallele Erneuerungen").
 *
 * A stale lock (its pid is dead) is reclaimed automatically — a crash must
 * never wedge either lock shut.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import path from 'node:path'

const isAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Exclusive-create a small pidfile; a stale one (its pid is dead) is
 *  reclaimed. → true if THIS process now owns it, false if another live
 *  process does. Never throws. */
export function claimLock(lockFile, pid = process.pid) {
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

/** Release the lock, but only if THIS process still holds it. Best-effort. */
export function releaseLock(lockFile, pid = process.pid) {
  try {
    const held = JSON.parse(fs.readFileSync(lockFile, 'utf-8'))
    if (held?.pid === pid) fs.unlinkSync(lockFile)
  } catch {}
}

/** Whether a lock is currently held by a live process (without claiming it). */
export function lockHeld(lockFile) {
  try {
    const held = JSON.parse(fs.readFileSync(lockFile, 'utf-8'))
    return Boolean(held?.pid && isAlive(held.pid))
  } catch {
    return false
  }
}

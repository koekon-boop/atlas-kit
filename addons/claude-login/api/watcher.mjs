/* ------------------------------------------------------------------ *
 * The in-process watcher — point 1 of the task: an INTERVAL in the API
 * process, not a cron entry, so a fresh install needs nothing extra beyond
 * enabling the addon. `CLAUDE_LOGIN_WATCH=0` disables it outright.
 *
 * 🔴 SINGLETON-GUARDED, own copy of addons/telegram's poller pattern
 * (lock.mjs): `loadAddons()` runs in the main API AND in a fresh MCP stdio
 * server per agent session, so only the process that wins the lock actually
 * ticks.
 *
 * 🔴 NOTHING TOUCHES THE FILESYSTEM AT CONSTRUCTION TIME. `createTick()`
 * claims the singleton lock lazily, on its FIRST call — not at construction —
 * and `createWatcher()`'s `setInterval` never fires immediately, so a process
 * that starts and exits quickly (a test run, a one-off script importing this
 * module) never claims the lock and never spawns anything. The handle is also
 * `.unref()`d, so the scheduled interval never keeps such a process alive on
 * its own. `createTick` is exported separately so a test can drive one tick
 * directly, exactly like addons/telegram's pollOnce/createPoller split.
 * ------------------------------------------------------------------ */
import { config } from './config.mjs'
import { claimLock, releaseLock } from './lock.mjs'
import { checkOnce } from './renew.mjs'

/** One tick's worth of logic, with the singleton claim folded in: the FIRST
 *  call claims the lock (or notices someone else already holds it); every
 *  call after that either runs `checkOnce()` (this process owns it) or is a
 *  no-op (it does not). → { owner, ok?, error? }. Never throws. */
export function createTick({ env = process.env, fetch: f = globalThis.fetch, exec, file, log = console.error } = {}) {
  const c = config(env)
  let owner = false
  async function tick() {
    if (!owner) {
      owner = claimLock(c.watchLockFile)
      if (!owner) {
        log('[claude-login] another process already runs the watcher on this box — not ticking here')
        return { owner: false }
      }
    }
    try {
      await checkOnce({ env, fetch: f, exec, file })
      return { owner: true, ok: true }
    } catch (e) {
      const error = String(e?.message || e)
      log(`[claude-login] watcher tick failed: ${error}`)
      return { owner: true, ok: false, error }
    }
  }
  return { tick, isOwner: () => owner, lockFile: c.watchLockFile }
}

/**
 * Start the watcher. `status().owner` is `false` until the first tick
 * actually runs (and wins the lock) — never claimed up front.
 */
export function createWatcher(deps = {}) {
  const c = config(deps.env ?? process.env)
  if (!c.watch) return { stop() {}, status: () => ({ owner: false, enabled: false }) }

  const { tick, isOwner, lockFile } = createTick(deps)
  let lastTickAt = null
  let lastError = null
  let tickCount = 0

  const timer = setInterval(async () => {
    const r = await tick()
    lastError = r.ok === false ? r.error : null
    tickCount++
    lastTickAt = new Date().toISOString()
  }, c.checkIntervalMs)
  timer.unref?.()

  return {
    stop() {
      clearInterval(timer)
      if (isOwner()) releaseLock(lockFile)
    },
    status: () => ({ owner: isOwner(), enabled: true, intervalMs: c.checkIntervalMs, tickCount, lastTickAt, lastError }),
  }
}

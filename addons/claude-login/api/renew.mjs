/* ------------------------------------------------------------------ *
 * The renewal state machine — point 2 of the task. One attempt:
 *
 *   1. start a tmux session running `claude auth login --claudeai`, read the
 *      OAuth authorize URL off the pane (tmux-session.mjs)
 *   2. mac-chrome, if configured AND consented (config.mjs's macChromeConsent):
 *      try it automatically — no human needed, ~10s (mac-chrome.mjs)
 *   3. otherwise (or if mac-chrome failed/was unavailable): ask a human for the
 *      code, through the first usable channel in CLAUDE_LOGIN_METHODS order
 *      (telegram, else the dashboard banner) — the SAME tmux session and URL,
 *      no second login flow started
 *   4. a code arrives via `submitCode()` (called by addons/telegram's
 *      interception or the dashboard's POST route) → typed into the pane,
 *      the credentials file + `claude auth status` confirm success
 *   5. `expireStaleAwaiting()` (called every watcher tick) gives up on an
 *      awaiting attempt nobody answered within `codeWaitMs`
 *
 * 🔴 LOCKED AGAINST PARALLEL ATTEMPTS (lock.mjs's renewLockFile): held from
 * `startAttempt` until the attempt resolves one way or the other — a second
 * `startAttempt` call while one is live is refused outright.
 * ------------------------------------------------------------------ */
import { claudeBin } from '../../../api/src/claude-bin.mjs'
import { latestAuthFailureSince } from './auth-failures.mjs'
import { config, activeMethods } from './config.mjs'
import { formatExpiry, msUntilExpiry, readCredentials } from './credentials.mjs'
import { claimLock, lockHeld, releaseLock } from './lock.mjs'
import { approveViaMacChrome } from './mac-chrome.mjs'
import { notifyOperator, writeBanner } from './notify.mjs'
import { redact } from './security.mjs'
import { readState, recordAttempt, saveState } from './state.mjs'
import { killSession, sendCode, startLoginSession, waitForUrl } from './tmux-session.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nowIso = () => new Date().toISOString()

/** Poll for the credentials file to change AND `claude auth status` to agree
 *  it is logged in. → { ok, expiresAt? } | { ok: false, error }. */
async function confirmLogin({ exec, claudeBin: bin, credentialsFile, beforeMtimeMs, timeoutMs = 30000, pollMs = 1000, sleepFn = sleep, readCreds = readCredentials }) {
  const attempts = Math.max(1, Math.ceil(timeoutMs / pollMs))
  let cred = readCreds(credentialsFile)
  for (let i = 0; i < attempts; i++) {
    cred = readCreds(credentialsFile)
    if (cred.ok && cred.mtimeMs > (beforeMtimeMs || 0)) break
    await sleepFn(pollMs)
  }
  if (!cred.ok || cred.mtimeMs <= (beforeMtimeMs || 0)) return { ok: false, error: 'the credentials file was not updated' }
  const status = await exec(bin, ['auth', 'status'])
  if (!/"loggedIn":\s*true/.test(status.stdout || '')) return { ok: false, error: 'claude auth status does not report logged in' }
  return { ok: true, expiresAt: cred.expiresAt }
}

/** Ask a human for the code through the first usable channel in configured
 *  order — the live tmux session's URL, not a new flow. → the channel used. */
async function requestCodeFromHuman({ env, fetch: f, file, url, order }) {
  const text = (via) =>
    via === 'telegram'
      ? `Die Claude-Anmeldung auf dem Server muss erneuert werden. Bitte: 1. Link öffnen, 2. "Autorisieren" tippen, 3. den angezeigten Code hier in den Chat schicken.\n\n${url}`
      : `Die Claude-Anmeldung muss erneuert werden — öffne das Dashboard, tippe den Link an und trage den Code dort ein.\n\n${url}`
  for (const method of order.filter((m) => m !== 'mac-chrome')) {
    if (method === 'telegram') {
      const r = await notifyOperator(text('telegram'), { env, fetch: f, file })
      if (r.via === 'telegram') return 'telegram'
      continue // telegram unreachable/unconfigured — try the next method
    }
    if (method === 'dashboard') {
      writeBanner(text('dashboard'), { file })
      return 'dashboard'
    }
  }
  // Nothing in CLAUDE_LOGIN_METHODS was usable — the dashboard banner always
  // works (no network needed), so it is the unconditional last resort.
  writeBanner(text('dashboard'), { file })
  return 'dashboard'
}

/**
 * Start ONE renewal attempt. `trigger`: 'broken' (a fresh authentication_failed
 * line) or 'preventive' (the refresh token is close to expiry). Never throws.
 * → { ok: true, via } | { ok: false, error }
 */
export async function startAttempt({ env = process.env, fetch: f = globalThis.fetch, exec, file = config(env).stateFile, trigger }) {
  const c = config(env)
  if (lockHeld(c.renewLockFile)) return { ok: false, error: 'a renewal is already in progress' }
  if (!claimLock(c.renewLockFile)) return { ok: false, error: 'could not claim the renewal lock' }

  const bin = claudeBin()
  if (!bin) {
    const err = 'the claude CLI could not be resolved (see GET /api/health)'
    saveState(recordAttempt(readState(file), { trigger, via: null, ok: false, error: err }), file)
    releaseLock(c.renewLockFile)
    return { ok: false, error: err }
  }

  const started = await startLoginSession({ exec, session: c.tmuxSession, claudeBin: bin })
  if (!started.ok) {
    saveState(recordAttempt(readState(file), { trigger, via: null, ok: false, error: started.error }), file)
    releaseLock(c.renewLockFile)
    await notifyOperator(`Die Claude-Anmeldung konnte nicht erneuert werden: ${redact(started.error)}`, { env, fetch: f, file, repeat: true, alarmIntervalMs: c.alarmIntervalMs })
    return started
  }

  const got = await waitForUrl({ exec, session: c.tmuxSession, waitMs: c.urlWaitMs })
  if (!got.ok) {
    await killSession({ exec, session: c.tmuxSession })
    saveState(recordAttempt(readState(file), { trigger, via: null, ok: false, error: got.error }), file)
    releaseLock(c.renewLockFile)
    await notifyOperator(`Die Claude-Anmeldung konnte nicht erneuert werden: ${redact(got.error)}`, { env, fetch: f, file, repeat: true, alarmIntervalMs: c.alarmIntervalMs })
    return got
  }

  const credBefore = readCredentials(c.credentialsFile)
  const methods = activeMethods(env)

  if (methods.includes('mac-chrome')) {
    const r = await approveViaMacChrome({
      exec,
      host: c.macChromeHost,
      idleS: c.macChromeIdleS,
      sofort: trigger === 'broken',
      url: got.url,
      clickTimeoutMs: c.macChromeClickTimeoutMs,
      timeoutMs: c.macChromeSshTimeoutMs,
    })
    if (r.ok) {
      const sent = await sendCode({ exec, session: c.tmuxSession, code: r.code })
      const confirmed = sent.ok && (await confirmLogin({ exec, claudeBin: bin, credentialsFile: c.credentialsFile, beforeMtimeMs: credBefore.mtimeMs, timeoutMs: c.confirmTimeoutMs, pollMs: c.confirmPollMs }))
      if (confirmed && confirmed.ok) {
        await killSession({ exec, session: c.tmuxSession })
        saveState(recordAttempt(readState(file), { trigger, via: 'mac-chrome', ok: true, result: `valid until ${formatExpiry(confirmed.expiresAt)}` }), file)
        releaseLock(c.renewLockFile)
        await notifyOperator(`Die Claude-Anmeldung wurde automatisch erneuert — gültig bis ${formatExpiry(confirmed.expiresAt)}.`, { env, fetch: f, file })
        return { ok: true, via: 'mac-chrome' }
      }
      // The click succeeded but the submitted code did not confirm (or
      // sending it failed) — rather than give up, fall through to asking a
      // human with the SAME still-open tmux session.
    }
    // mac-chrome unavailable, declined, or failed — fall through to asking a
    // human with the SAME still-open tmux session, rather than giving up.
  }

  const via = await requestCodeFromHuman({ env, fetch: f, file, url: got.url, order: methods.length ? methods : ['dashboard'] })
  const state = readState(file)
  saveState({ ...state, awaiting: { via, url: got.url, startedAt: nowIso(), expiresAt: Date.now() + c.codeWaitMs, trigger } }, file)
  // The lock stays held (one attempt in flight) until submitCode() or
  // expireStaleAwaiting() resolves it — see the module header.
  return { ok: true, via }
}

/**
 * A code arrived from `source` ('telegram' | 'dashboard'). Types it into the
 * still-open tmux session and confirms the outcome. → { ok, expiresAt? } |
 * { ok: false, error, attemptsLeft? }. Never throws, never logs `code`.
 */
export async function submitCode(code, { env = process.env, fetch: f = globalThis.fetch, exec, file = config(env).stateFile, source }) {
  const c = config(env)
  const state = readState(file)
  if (!state.awaiting) return { ok: false, error: 'no renewal is currently waiting for a code' }
  if (Date.now() > state.awaiting.expiresAt) {
    await expireStaleAwaiting({ env, fetch: f, exec, file })
    return { ok: false, error: 'the renewal window has expired — a new one will start on the next check' }
  }

  const credBefore = readCredentials(c.credentialsFile)
  const sent = await sendCode({ exec, session: c.tmuxSession, code })
  if (!sent.ok) return { ok: false, error: sent.error }
  const confirmed = await confirmLogin({ exec, claudeBin: claudeBin() || 'claude', credentialsFile: c.credentialsFile, beforeMtimeMs: credBefore.mtimeMs, timeoutMs: c.confirmTimeoutMs, pollMs: c.confirmPollMs })

  const withSubmitted = (s) => ({ ...s, counters: { ...s.counters, codesSubmitted: (s.counters?.codesSubmitted || 0) + 1 } })

  if (confirmed.ok) {
    await killSession({ exec, session: c.tmuxSession })
    const s2 = withSubmitted(readState(file))
    saveState({ ...recordAttempt(s2, { trigger: state.awaiting.trigger, via: state.awaiting.via, ok: true, result: `valid until ${formatExpiry(confirmed.expiresAt)}` }), awaiting: null }, file)
    releaseLock(c.renewLockFile)
    await notifyOperator(`Danke! Die Claude-Anmeldung ist erneuert — gültig bis ${formatExpiry(confirmed.expiresAt)}.`, { env, fetch: f, file })
    return { ok: true, expiresAt: confirmed.expiresAt }
  }

  // A wrong/garbled code: let the same renewal window take a couple more
  // tries before giving up — the tmux session (and its URL) stays open.
  const rejected = (state.counters?.codesRejected || 0) + 1
  saveState(withSubmitted({ ...state, counters: { ...state.counters, codesRejected: rejected } }), file)
  if (rejected >= 3) {
    await expireStaleAwaiting({ env, fetch: f, exec, file, reason: 'three wrong codes' })
    return { ok: false, error: 'that code did not work, and this renewal has given up after 3 tries' }
  }
  return { ok: false, error: redact(confirmed.error || 'that code did not work'), attemptsLeft: 3 - rejected }
}

/** Give up on an awaiting attempt nobody (correctly) answered in time. */
export async function expireStaleAwaiting({ env = process.env, fetch: f = globalThis.fetch, exec, file = config(env).stateFile, reason = 'no code received in time' }) {
  const c = config(env)
  const state = readState(file)
  if (!state.awaiting) return { ok: true, expired: false }
  await killSession({ exec, session: c.tmuxSession })
  saveState({ ...recordAttempt(state, { trigger: state.awaiting.trigger, via: state.awaiting.via, ok: false, error: reason }), awaiting: null }, file)
  releaseLock(c.renewLockFile)
  await notifyOperator('Die Claude-Anmeldung ist weiterhin abgelaufen — der Link ist verfallen, der nächste Versuch startet automatisch.', {
    env,
    fetch: f,
    file,
    repeat: true,
    alarmIntervalMs: c.alarmIntervalMs,
  })
  return { ok: true, expired: true }
}

/**
 * The watcher's one decision point, run every interval tick:
 *   1. an awaiting attempt past its deadline → expire it
 *   2. a FRESH authentication_failed line (after the last successful renewal)
 *      → renew immediately ("broken")
 *   3. the refresh token has < warnDays left, no attempt in the last
 *      retryIntervalMs → renew preventively
 *   4. otherwise → just record the check
 * Never throws; one failing step never stops the next tick.
 */
export async function checkOnce({ env = process.env, fetch: f = globalThis.fetch, exec, file = config(env).stateFile, now = Date.now() }) {
  const c = config(env)
  const state = readState(file)

  if (state.awaiting && now > state.awaiting.expiresAt) await expireStaleAwaiting({ env, fetch: f, exec, file })

  const cred = readCredentials(c.credentialsFile)
  const since = Math.max(now - c.failureWindowMs, cred.ok ? cred.mtimeMs : 0)
  const brokenAt = latestAuthFailureSince(since, { projectsDir: c.projectsDir })

  const afterCheck = (patch) => saveState({ ...readState(file), ...patch, lastCheckAt: new Date(now).toISOString(), counters: { ...readState(file).counters, checks: readState(file).counters.checks + 1 } }, file)

  if (brokenAt) {
    // A FRESH failure always gets an immediate first attempt; a repeat of the
    // SAME still-broken situation is throttled to retryIntervalMs between
    // tries (never a rapid-fire loop of tmux spawns + fresh links).
    const recentlyFailed = state.lastAttempt && state.lastAttempt.ok === false && now - Date.parse(state.lastAttempt.at) < c.retryIntervalMs
    if (lockHeld(c.renewLockFile)) {
      await notifyOperator('Die Claude-Anmeldung ist abgelaufen — eine Erneuerung läuft bereits.', { env, fetch: f, file, repeat: true, alarmIntervalMs: c.alarmIntervalMs })
    } else if (recentlyFailed) {
      await notifyOperator('Die Claude-Anmeldung ist weiterhin abgelaufen — der nächste automatische Versuch folgt in Kürze.', { env, fetch: f, file, repeat: true, alarmIntervalMs: c.alarmIntervalMs })
    } else {
      await startAttempt({ env, fetch: f, exec, file, trigger: 'broken' })
    }
    afterCheck({ lastExpiryMs: cred.ok ? cred.expiresAt : null })
    return { action: 'broken' }
  }

  const left = msUntilExpiry(cred, now)
  if (left != null && left < c.warnDays * 86400000 && !lockHeld(c.renewLockFile)) {
    // Gated on the time since the LAST attempt of any kind, not just
    // 'preventive' ones — a renewed token already clears this branch
    // entirely (left grows back past warnDays), so this only ever throttles
    // a run of FAILED attempts, regardless of what triggered the first one.
    const last = state.lastAttempt ? Date.parse(state.lastAttempt.at) : 0
    if (now - last >= c.retryIntervalMs) {
      await startAttempt({ env, fetch: f, exec, file, trigger: 'preventive' })
      afterCheck({ lastExpiryMs: cred.ok ? cred.expiresAt : null })
      return { action: 'preventive' }
    }
  }

  afterCheck({ lastExpiryMs: cred.ok ? cred.expiresAt : null })
  return { action: 'none' }
}

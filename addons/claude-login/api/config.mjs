/* ------------------------------------------------------------------ *
 * Every knob `addons/claude-login` reads, in one place.
 *
 * Read at CALL time from an `env` object (default `process.env`), never frozen
 * at import — same rule as every other addon's config.mjs (see addons/telegram).
 * ------------------------------------------------------------------ */
import os from 'node:os'
import path from 'node:path'

const str = (env, k, d = '') => {
  const v = env[k]
  return v === undefined || v === '' ? d : String(v)
}
const bool = (env, k, d) => {
  const v = env[k]
  return v === undefined || v === '' ? d : !['0', 'false', 'no', 'off'].includes(String(v).trim().toLowerCase())
}
const posInt = (env, k, d) => {
  const n = Number(env[k])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d
}

/** Where operator-local state lives — same convention as every other addon
 *  (never the repo, never the vault; AGENT_LOCAL_DIR default ~/.atlas-kit). */
export const stateFile = (env = process.env) =>
  str(env, 'CLAUDE_LOGIN_STATE_FILE', path.join(str(env, 'AGENT_LOCAL_DIR', path.join(os.homedir(), '.atlas-kit')), 'claude-login.json'))

/** The watcher's singleton pidfile — see lock.mjs: at most one process on this
 *  box runs the check interval (register() runs in the main API AND in a fresh
 *  MCP stdio server per agent session, exactly like addons/telegram's poller). */
export const watchLockFile = (env = process.env) => path.join(path.dirname(stateFile(env)), 'claude-login-watch.lock')

/** The renewal-attempt lock: never two `claude auth login` flows at once. */
export const renewLockFile = (env = process.env) => path.join(path.dirname(stateFile(env)), 'claude-login-renew.lock')

export const config = (env = process.env) => ({
  credentialsFile: str(env, 'CLAUDE_LOGIN_CREDENTIALS_FILE', path.join(os.homedir(), '.claude', '.credentials.json')),
  projectsDir: str(env, 'CLAUDE_LOGIN_PROJECTS_DIR', path.join(os.homedir(), '.claude', 'projects')),
  stateFile: stateFile(env),
  watchLockFile: watchLockFile(env),
  renewLockFile: renewLockFile(env),
  bearer: str(env, 'DASHBOARD_BEARER_TOKEN'),
  apiPort: str(env, 'API_PORT', '3001'),

  // The watcher (point 1 of the task): an interval in THIS process, not a cron
  // entry — an install needs nothing extra. CLAUDE_LOGIN_WATCH=0 disables it.
  watch: bool(env, 'CLAUDE_LOGIN_WATCH', true),
  checkIntervalMs: posInt(env, 'CLAUDE_LOGIN_CHECK_INTERVAL_MS', 5 * 60 * 1000),
  warnDays: posInt(env, 'CLAUDE_LOGIN_WARN_DAYS', 3), // preventive: refresh token has this many days left
  failureWindowMs: posInt(env, 'CLAUDE_LOGIN_FAILURE_WINDOW_MS', 15 * 60 * 1000), // "fresh" authentication_failed lines
  retryIntervalMs: posInt(env, 'CLAUDE_LOGIN_RETRY_INTERVAL_MS', 30 * 60 * 1000), // min gap between PREVENTIVE attempts
  alarmIntervalMs: posInt(env, 'CLAUDE_LOGIN_ALARM_INTERVAL_MS', 2 * 60 * 60 * 1000), // "still broken" repeats at most this often
  codeWaitMs: posInt(env, 'CLAUDE_LOGIN_CODE_WAIT_MS', 15 * 60 * 1000), // how long an awaiting-code attempt stays open

  // Renewal (point 2): pluggable, ordered approval channels.
  methods: str(env, 'CLAUDE_LOGIN_METHODS', 'telegram,dashboard')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // mac-chrome is OFF by default even when named in CLAUDE_LOGIN_METHODS — it
  // clicks the OAuth approval in the operator's OWN browser, so it needs this
  // SEPARATE, explicit consent flag (README: ask before setting it on a
  // customer box). Listing it in CLAUDE_LOGIN_METHODS alone is not enough.
  macChromeConsent: bool(env, 'CLAUDE_LOGIN_MAC_CHROME_CONSENT', false),
  macChromeHost: str(env, 'CLAUDE_LOGIN_MAC_CHROME_HOST', 'mac'),
  macChromeIdleS: posInt(env, 'CLAUDE_LOGIN_MAC_CHROME_IDLE_S', 90),
  macChromeSshTimeoutMs: posInt(env, 'CLAUDE_LOGIN_MAC_CHROME_SSH_TIMEOUT_MS', 8000),
  macChromeClickTimeoutMs: posInt(env, 'CLAUDE_LOGIN_MAC_CHROME_CLICK_TIMEOUT_MS', 25000),

  tmuxSession: str(env, 'CLAUDE_LOGIN_TMUX_SESSION', 'claude-login-renew'),
  urlWaitMs: posInt(env, 'CLAUDE_LOGIN_URL_WAIT_MS', 30000), // waiting for the oauth URL to appear in the pane
  confirmTimeoutMs: posInt(env, 'CLAUDE_LOGIN_CONFIRM_TIMEOUT_MS', 30000), // waiting for the credentials file + `claude auth status` after a code is typed in
  confirmPollMs: posInt(env, 'CLAUDE_LOGIN_CONFIRM_POLL_MS', 1000),
})

/** Which approval channels are actually usable right now (consent-gated,
 *  deduped, in configured order) — never includes mac-chrome without consent. */
export function activeMethods(env = process.env) {
  const c = config(env)
  return c.methods.filter((m) => m === 'mac-chrome' ? c.macChromeConsent : m === 'telegram' || m === 'dashboard')
}

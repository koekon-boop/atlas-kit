/* ------------------------------------------------------------------ *
 * The tmux side of a renewal: start `claude auth login --claudeai`, read the
 * OAuth authorize URL off the pane, hand a code back in once one arrives, and
 * confirm the outcome — a JS port of `claude-login-erneuern.sh`'s tmux half.
 *
 * 🔴 THE CODE NEVER TOUCHES A SHELL STRING OR A LOG LINE. `sendCode` passes it
 * as a tmux `send-keys -l` ARGUMENT (an argv entry, not interpolated into a
 * command string), and no function here logs its own arguments — callers
 * must not either (see security.mjs's `redact`, applied to anything that
 * COULD contain one, e.g. a captured pane or an exec error).
 *
 * Every effect is injected (`exec`, `sleep`) so tests never touch a real tmux.
 * ------------------------------------------------------------------ */
const URL_RE = /https:\/\/claude\.(com|ai)\/\S*oauth\/authorize\?\S*state=[A-Za-z0-9_-]+/

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** (Re)start the tmux session that runs the login flow — idempotent: an old
 *  session under the same name is killed first, exactly like the reference
 *  script, so a stuck prior attempt never lingers under the name a new one
 *  expects. `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` are unset for the
 *  child so a box that also has API-key inference configured still goes
 *  through the interactive OAuth flow this addon drives. */
export async function startLoginSession({ exec, session, claudeBin }) {
  await exec('tmux', ['kill-session', '-t', session])
  const cmd = `env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN ${shQuote(claudeBin)} auth login --claudeai; echo EXIT=$?; sleep 1200`
  const r = await exec('tmux', ['new-session', '-d', '-s', session, '-x', '900', '-y', '60', 'sh', '-lc', cmd])
  if (r.missing) return { ok: false, error: 'tmux is not installed on this box' }
  if (r.code !== 0) return { ok: false, error: `tmux new-session failed: ${r.stderr || `exit ${r.code}`}` }
  return { ok: true }
}

const shQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`

/** Poll the pane for the OAuth authorize URL. → { ok, url } | { ok: false, error }. */
export async function waitForUrl({ exec, session, waitMs = 30000, pollMs = 1000, sleepFn = sleep }) {
  const attempts = Math.max(1, Math.ceil(waitMs / pollMs))
  for (let i = 0; i < attempts; i++) {
    const r = await exec('tmux', ['capture-pane', '-p', '-t', session, '-J', '-S', '-100'])
    const m = URL_RE.exec(r.stdout || '')
    if (m) return { ok: true, url: m[0] }
    await sleepFn(pollMs)
  }
  return { ok: false, error: 'no OAuth URL appeared in the login session' }
}

/** Type the code into the pane and press Enter — a tmux argv entry, never a
 *  shell-interpolated string, so the code never appears in a process list or
 *  a shell history. */
export async function sendCode({ exec, session, code }) {
  const a = await exec('tmux', ['send-keys', '-t', session, '-l', code])
  if (a.missing || a.code !== 0) return { ok: false, error: 'could not type the code into the login session' }
  const b = await exec('tmux', ['send-keys', '-t', session, 'Enter'])
  return b.code === 0 ? { ok: true } : { ok: false, error: 'could not submit the code' }
}

export async function killSession({ exec, session }) {
  await exec('tmux', ['kill-session', '-t', session])
}

/** Has tmux actually produced any output we could be reading? Used to decide
 *  "no URL yet, keep waiting" vs "tmux itself is broken". */
export async function sessionAlive({ exec, session }) {
  const r = await exec('tmux', ['has-session', '-t', session])
  return r.code === 0
}

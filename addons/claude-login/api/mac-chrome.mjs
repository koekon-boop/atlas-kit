/* ------------------------------------------------------------------ *
 * The `mac-chrome` approval channel — a JS port of the `mac` mode in
 * `claude-login-erneuern.sh`: open the OAuth URL as its OWN tab in the
 * operator's already-logged-in Chrome over `ssh`, click "Authorize" with JS
 * (never a keystroke into a foreign window), read the code back out of the
 * page, close the tab, restore the one that was active.
 *
 * 🔴 OFF BY DEFAULT, CONSENT-GATED (config.mjs's `macChromeConsent`) — this
 * clicks an approval in someone else's browser session. register.mjs/renew.mjs
 * never call into this module unless that flag is explicitly set; see
 * README.md "mac-chrome" for the consent requirement on a customer box.
 *
 * 🔴 NEVER A KEYSTROKE. Only `execute … javascript` against the tab THIS
 * module itself opened (tracked by Chrome's own tab id, not a window index —
 * the reference script's fix for stale-callback-tab reuse) — no
 * `System Events`, no `keystroke`, nothing that could land in a DIFFERENT
 * window if the operator's focus moved. The code is read by JS regex over
 * `document.body.innerText`, never typed anywhere.
 *
 * Every SSH/AppleScript call goes through the injected `exec` — tests never
 * touch a real Mac.
 * ------------------------------------------------------------------ */
import { redact } from './security.mjs'

const BUTTON_JS = '[...document.querySelectorAll("button")].find(b=>/^(Autorisieren|Authorize)$/.test(b.innerText.trim()))'
const CODE_FIND_JS = `(document.body.innerText.match(/[A-Za-z0-9_-]{20,}#[A-Za-z0-9_-]{10,}/)||[''])[0]`

const OSASCRIPT = `
on run argv
  set was to item 1 of argv
  tell application "Google Chrome"
    set w to window 1
    if was is "open" then
      set alt to active tab index of w
      set t to make new tab at end of tabs of w with properties {URL:(item 2 of argv)}
      set active tab index of w to (count of tabs of w)
      return ((id of t) as text) & " " & (alt as text)
    end if
    repeat with i from 1 to count of tabs of w
      set t to tab i of w
      if ((id of t) as text) is (item 2 of argv) then
        if was is "js" then return execute t javascript (item 3 of argv)
        if was is "close" then
          close t
          try
            set active tab index of w to ((item 3 of argv) as integer)
          end try
          return "closed"
        end if
      end if
    end repeat
    return ""
  end tell
end run
`.trim()

async function osa(exec, host, args, timeoutMs) {
  return exec('ssh', [host, 'osascript', '-e', OSASCRIPT, ...args], { timeoutMs })
}

/** Is the Mac reachable, Chrome running, and is the operator away from the
 *  keyboard (or the screen locked)? → { ok, reason? }. `sofort` (the watcher's
 *  "login is already broken" flag) skips the idle check — see
 *  claude-login-waechter.py's ERNEUERN_SOFORT. */
export async function preflight({ exec, host, idleS, sofort = false, timeoutMs = 8000 }) {
  const reach = await exec('ssh', ['-o', 'ConnectTimeout=8', '-o', 'BatchMode=yes', host, 'true'], { timeoutMs })
  if (reach.code !== 0) return { ok: false, reason: 'mac not reachable over ssh' }
  const r = await exec('ssh', [
    host,
    'echo $(( $(ioreg -c IOHIDSystem | awk "/HIDIdleTime/ {print \\$NF; exit}") / 1000000000 )) $(ioreg -n Root -d1 -a | grep -c CGSSessionScreenIsLocked) $(pgrep -x "Google Chrome" >/dev/null && echo 1 || echo 0)',
  ], { timeoutMs })
  const [idle, locked, chrome] = (r.stdout || '').trim().split(/\s+/).map(Number)
  if (chrome !== 1) return { ok: false, reason: 'Chrome is not running on the mac' }
  if (sofort || locked !== 0) return { ok: true }
  if (!(idle >= idleS)) return { ok: false, reason: `the operator is active on the mac (idle ${idle || 0}s)` }
  return { ok: true }
}

/** Open `url` as a new Chrome tab. → { ok, tabId, previousTabIndex } | { ok: false, error }. */
export async function openTab({ exec, host, url, timeoutMs = 8000 }) {
  const r = await osa(exec, host, ['open', url], timeoutMs)
  const [tabId, alt] = (r.stdout || '').trim().split(/\s+/)
  if (!tabId) return { ok: false, error: 'could not open the OAuth URL as a tab' }
  return { ok: true, tabId, previousTabIndex: alt || '1' }
}

/** Click "Authorize"/"Autorisieren" via JS in the tab this module opened, then
 *  read the code back out. Polls because the page needs a moment to render
 *  and the button is disabled (clickjacking guard) until the tab has focus —
 *  the caller is expected to have just made it the active tab (`openTab`
 *  already does, via `set active tab index`). */
export async function clickAndReadCode({ exec, host, tabId, waitMs = 25000, pollMs = 1000, sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 8000 }) {
  const attempts = Math.max(1, Math.ceil(waitMs / pollMs))
  let state = ''
  for (let i = 0; i < attempts; i++) {
    const js = `(()=>{if(/oauth\\/code/.test(location.pathname))return 'code';const b=${BUTTON_JS};if(!b)return /Anmelden|Log in|Sign in/i.test(document.body.innerText)?'loggedout':'loading';if(b.disabled)return 'disabled';b.click();return 'clicked'})()`
    const r = await osa(exec, host, ['js', tabId, js], timeoutMs)
    state = (r.stdout || '').trim()
    if (['clicked', 'code', 'loggedout'].includes(state)) break
    await sleepFn(pollMs)
  }
  if (!['clicked', 'code'].includes(state)) return { ok: false, error: `could not click Authorize (state: ${state || 'empty'})` }
  for (let i = 0; i < attempts; i++) {
    const r = await osa(exec, host, ['js', tabId, CODE_FIND_JS], timeoutMs)
    const code = (r.stdout || '').trim()
    if (code) return { ok: true, code }
    await sleepFn(pollMs)
  }
  return { ok: false, error: 'no code appeared on the OAuth page' }
}

export async function closeTab({ exec, host, tabId, previousTabIndex, timeoutMs = 8000 }) {
  await osa(exec, host, ['close', tabId, previousTabIndex], timeoutMs)
}

/**
 * The whole mac-chrome flow for one OAuth URL: preflight → open tab → click +
 * read code → close tab (always, even on failure — never leaves a stray tab
 * behind). → { ok, code } | { ok: false, error }. Never throws; any thrown
 * error from a step is caught and redacted before it leaves this function.
 */
export async function approveViaMacChrome({ exec, host, idleS, sofort, url, clickTimeoutMs, timeoutMs = 8000, pollMs = 1000, sleepFn }) {
  try {
    const pre = await preflight({ exec, host, idleS, sofort, timeoutMs })
    if (!pre.ok) return { ok: false, error: pre.reason }
    const tab = await openTab({ exec, host, url, timeoutMs })
    if (!tab.ok) return tab
    try {
      const got = await clickAndReadCode({ exec, host, tabId: tab.tabId, waitMs: clickTimeoutMs, pollMs, ...(sleepFn ? { sleepFn } : {}), timeoutMs })
      return got
    } finally {
      await closeTab({ exec, host, tabId: tab.tabId, previousTabIndex: tab.previousTabIndex, timeoutMs })
    }
  } catch (e) {
    return { ok: false, error: redact(String(e?.message || e)) }
  }
}

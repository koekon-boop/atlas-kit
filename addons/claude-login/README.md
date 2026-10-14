# addons/claude-login

The Claude Code login on **this box** renews **itself**, so no customer (or
operator) ever sits in front of silent agents again.

## Why this exists

The full `claude auth login` (OAuth, your subscription) lasts only about
**four weeks** — `refreshTokenExpiresAt` in `~/.claude/.credentials.json`. On
2026-10-14 that login lapsed on this box and every agent and chat channel
went **silent, with no visible error**, for 4¾ hours before anyone noticed. A
server restart does not fix it — only a fresh `claude auth login` does, and
that needs a human to tap "Authorize" in a browser and type a short-lived
code back in.

This addon turns that into something the box handles on its own:

```
watcher (an interval in the API         claude auth login --claudeai
process, not a cron entry)      ──────► in a tmux session
        │                                      │
        │ expiring soon, or a fresh            │ prints an OAuth authorize URL
        │ "authentication_failed" line         ▼
        ▼                               mac-chrome (opt-in, consented)
  decides: renew now                    clicks Authorize automatically,
                                         reads the code back — no human
                                              │ (unavailable / declined / failed)
                                              ▼
                                         ask a human: Telegram message, or
                                         a dashboard banner, with the link
                                              │
                                              ▼
                                   POST /api/claude-login/code
                                   (addons/telegram intercepts the reply;
                                    the dashboard banner has its own field)
                                              │
                                              ▼
                                   typed into the open tmux session,
                                   confirmed via the credentials file +
                                   `claude auth status`
```

## What it needs

- **`tmux`** on `PATH` — the renewal flow runs `claude auth login --claudeai`
  inside a session so it can read the OAuth URL and type the code back in.
- **The `claude` CLI resolvable** — the same resolver core uses
  (`CLAUDE_BIN`, else `PATH`, else the usual fallback dirs).
- **An existing login once, by hand.** This addon renews a login; it does not
  create the very first one. Run `claude auth login` yourself once, and this
  addon takes over keeping it alive from there.
- To actually ask a human for a code: **either** `addons/telegram` enabled and
  configured (the message goes to its home chat, and it intercepts the
  reply), **or** the dashboard open in a browser (the banner has its own
  code field), **or** both. Neither is required to be set up — the fallback
  order below always ends at the dashboard banner, which needs nothing extra.

## What it costs

- **Nothing on disk** beyond one small state file (`<AGENT_LOCAL_DIR>/claude-login.json`
  by default) — timestamps, which channel, the OAuth URL (not a secret), and
  counters. **Never a code, never a token.** Plus the watcher's own tiny
  pidfile lock, same pattern as `addons/telegram`'s poller.
- **No model call of its own.** The renewal is a plain OAuth exchange, not an
  agent turn.
- **A Telegram message** (if that addon is enabled) per renewal attempt — not
  metered beyond what Telegram itself allows.
- **mac-chrome (opt-in only):** one `ssh` round-trip to the Mac and a few
  `osascript` calls over it, a few seconds. Nothing if you never turn it on.

## The watcher (point 1: nothing extra needed)

`CLAUDE_LOGIN_WATCH` (default **on**) runs an interval in the API process —
not a cron entry, so a fresh install needs nothing extra beyond enabling the
addon. Exactly one process on the box actually ticks (`loadAddons()` runs in
the main API **and** in a fresh MCP stdio server per agent session — the
watcher's pidfile lock, `lock.mjs`, is its own copy of `addons/telegram`'s
poller-singleton pattern). The first tick fires only after one full
`CLAUDE_LOGIN_CHECK_INTERVAL_MS` (default 5 min) — never at boot — so a quick
script or test that merely imports this addon's code never spawns anything.

Each tick:

1. **An awaiting attempt past its deadline** (`CLAUDE_LOGIN_CODE_WAIT_MS`,
   default 15 min) is given up on — the tmux session is killed, the operator
   is told, and the next tick is free to try again.
2. **A FRESH `"authentication_failed"` line** in a session transcript
   (`~/.claude/projects/<id>/<session>.jsonl`), **newer than the credentials
   file's own mtime** — so a failure from *before* the last successful
   renewal can never re-trigger one — renews **immediately**. A repeat of the
   *same* still-broken situation is throttled to `CLAUDE_LOGIN_RETRY_INTERVAL_MS`
   between actual retry attempts (never a rapid-fire loop of fresh tmux
   sessions and fresh links); the operator still hears about it, throttled to
   `CLAUDE_LOGIN_ALARM_INTERVAL_MS` (default 2 h).
3. **Fewer than `CLAUDE_LOGIN_WARN_DAYS`** (default 3) days left on the
   refresh token, and no attempt in the last `CLAUDE_LOGIN_RETRY_INTERVAL_MS`
   → renews **preventively**, before anything actually breaks.
4. Otherwise: just records the check (`GET /api/addons` → `claude-login.status.lastCheckAt`).

## Renewal channels (point 2: pluggable, ordered)

`CLAUDE_LOGIN_METHODS` (default `telegram,dashboard`) is a comma list, tried
in order, for **asking a human for the code** — `claude auth login` itself
always runs the same way (tmux), and the SAME already-open session and URL is
reused across a fallback, never a second login flow.

### `mac-chrome` — OFF by default, needs explicit consent

> ⚠️ **This clicks the OAuth "Authorize" button in the operator's OWN,
> already-logged-in Chrome, over `ssh` + AppleScript.** Listing `mac-chrome`
> in `CLAUDE_LOGIN_METHODS` is **not enough** — it only ever runs with
> `CLAUDE_LOGIN_MAC_CHROME_CONSENT=1` also set, a separate, explicit switch.
> **On a customer installation, ask first** — tell them plainly that the box
> will, from time to time, briefly take over their Mac's Chrome to click one
> button on claude.ai's own login page, and get their go-ahead before you set
> this. The dashboard banner and/or Telegram (below) need no such consent —
> they only ever show a link and wait for someone to tap it.

When consented and the Mac is reachable, this is the fast, fully automatic
path (a few seconds, ported from this box's own `claude-login-erneuern.sh`
reference): it skips while the operator is actively using the Mac
(`CLAUDE_LOGIN_MAC_CHROME_IDLE_S`, default 90s of idle — skipped if the
screen is locked, or the login is already broken) so it never steals focus
mid-task. **Never a keystroke into a foreign window** — only
`execute … javascript` against the ONE tab this addon itself opened (tracked
by Chrome's own tab id, not a window index, so a stale callback tab from a
previous attempt can never be mistaken for the current one), and that tab is
**always** closed again, even on failure. If it fails or is unavailable, the
flow falls through to the next method below — same tmux session, same URL.

### `telegram`

A message to the home chat with the link and instructions. The code typed
back is **intercepted by `addons/telegram`** (`claude-login-bridge.mjs`,
wired into `inbound.mjs`) — but **only while a renewal here is actually
open** (`GET /api/claude-login/awaiting`); otherwise a code-shaped message is
just an ordinary message to the agent, unaffected. The sender gets a short
reply with the real outcome. See
[addons/telegram's README](../telegram/README.md) for nothing extra to set up
there — this is automatic once both addons are enabled.

### `dashboard`

A banner card on the dashboard (gated at runtime like every other addon
surface) with the link and a code field — `POST /api/claude-login/code`. This
is the unconditional last resort: if every other configured method is
unusable, this is what happens regardless of `CLAUDE_LOGIN_METHODS`, because
it needs nothing extra (no Telegram, no Mac) to work.

## Notifications (point 3)

Telegram when it is reachable and configured, the dashboard banner otherwise
— never both for the same event. A one-off ("awaiting your tap", "renewed —
valid until …") is never throttled; a repeating "still broken" situation is
throttled to at most once per `CLAUDE_LOGIN_ALARM_INTERVAL_MS` (default 2 h).

## `status()` (point 4)

`GET /api/addons` → the `claude-login` entry:

```jsonc
{
  "credentials": { "expiresAt": "2026-11-11T09:21:00.000Z", "daysLeft": 3 },
  "methods": ["telegram", "dashboard"],
  "macChromeConsent": false,
  "watcher": { "owner": true, "enabled": true, "intervalMs": 300000, "tickCount": 42, "lastTickAt": "…" },
  "lastCheckAt": "…",
  "lastAttempt": { "at": "…", "trigger": "preventive", "via": "telegram", "ok": true, "result": "valid until 11.11.2026, 10:21" },
  "awaiting": null,
  "banner": null,
  "counters": { "checks": 42, "attempts": 1, "renewed": 1, "failed": 0, "codesSubmitted": 1, "codesRejected": 0 }
}
```

Never a code, never a token — `lastAttempt.result`/`.error` are redacted
before they are ever stored (`security.mjs`'s `redact()`, the same guard
every module in this addon runs free text through before logging or
persisting it).

## Security (point 5)

- **A code or a token is never logged, stored, or returned in an HTTP
  response.** `security.mjs`'s `redact()` strips anything code-shaped (or a
  bearer token) out of every free-text string before it is logged or
  persisted; the state file only ever holds timestamps, the (non-secret)
  OAuth URL, and sanitized ok/error text.
- **Locked against parallel renewals** (`lock.mjs`'s `renewLockFile`): held
  from the moment a renewal starts until it resolves (success, failure, or
  the code-wait window expiring) — a second attempt while one is live is
  refused outright, never a second tmux session or a second link.
- **Never a keystroke into a foreign window** — see mac-chrome above.
- **The code travels as its own tmux argv entry** (`send-keys -l <code>`),
  never interpolated into a shell string — it cannot leak into a process list
  or a shell history that way.
- `POST /api/claude-login/code` is bearer-gated like every write route in
  this repo (`DASHBOARD_BEARER_TOKEN`, constant-time check); `GET
  /api/claude-login/awaiting` is an open read — it answers only whether a
  renewal is open and the (non-secret) URL, never the code.

## Enable — step by step

1. Make sure you have logged in **once**, by hand: `claude auth login`.
2. `addons.json` → `{"enabled": ["claude-login"]}` (or `ATLAS_ADDONS=…,claude-login`),
   then `scripts/serve.sh restart`.
3. `bash addons/claude-login/install.sh --check` confirms tmux, the resolved
   `claude` CLI, and the credentials file.
4. Leave `CLAUDE_LOGIN_METHODS` at its default (`telegram,dashboard`) unless
   you want to reorder them, and leave `CLAUDE_LOGIN_MAC_CHROME_CONSENT`
   unset unless you have deliberately decided to turn that channel on (see
   above).
5. That's it — nothing else to configure. The watcher starts ticking on its
   own interval; `GET /api/addons` shows what it is doing.

### Moving off the box's own reference scripts

If you are enabling this on **this specific box** (the one
`claude-login-erneuern.sh` / `claude-login-waechter.py` already protect),
after confirming the addon is ready:

1. Set `CLAUDE_LOGIN_MAC_CHROME_CONSENT=1` and `CLAUDE_LOGIN_MAC_CHROME_HOST=mac`
   in `.env` if you want the same automatic Mac-Chrome path those scripts use
   (you already consented to that pattern when they were set up).
2. `scripts/serve.sh restart`.
3. Remove the old cron entry for `claude-login-waechter.py` (it polled every
   10 minutes; this addon's watcher replaces it) — the scripts themselves can
   stay on disk as a manual fallback, or be deleted once you have seen a
   renewal go through the addon.

## For customer installations

A checklist for whoever sets this up on someone else's box:

- [ ] They have logged in once by hand (`claude auth login`) — this addon
      renews, it does not create the first login.
- [ ] `addons.json`/`ATLAS_ADDONS` includes `claude-login`.
- [ ] Decide `CLAUDE_LOGIN_METHODS` — the default (`telegram,dashboard`) works
      with **no extra consent or setup** beyond what `addons/telegram` already
      needs if you also want it on Telegram.
- [ ] **mac-chrome: ask first.** If you are even considering
      `CLAUDE_LOGIN_MAC_CHROME_CONSENT=1`, explain to the customer — in plain
      language — that the box will occasionally take over their Mac's Chrome
      for a few seconds to click "Authorize" on claude.ai's own page, and get
      an explicit yes before setting it. Default (not set) is almost always
      the right choice for a customer box; the dashboard banner and Telegram
      need no such consent.
- [ ] `bash addons/claude-login/install.sh --check` is green.
- [ ] Watch one real renewal happen (or trigger a test one) before handing
      the box over, so you have seen the whole path work at least once.

## Turning it off

Remove `claude-login` from `addons.json` / `ATLAS_ADDONS` and restart: no
route, no watcher, no tmux, nothing. The state file and the two pidfile locks
(`<AGENT_LOCAL_DIR>/claude-login.json`, `claude-login-watch.lock`,
`claude-login-renew.lock`) can be deleted by hand.

## Tests

`node --test addons/claude-login/test/*.test.mjs` (also part of `cd api && npm test`).
`tmux`/`ssh`/`fetch`/the filesystem are all stubbed; no real tmux, ssh, or
network call, and no credential is real. Covers: expiry/breakage detection
(including the "only after the last renewal" rule), method order and
fallback, the parallel-renewal lock, the telegram code interception gated on
an actually-open renewal, and that a code never appears in anything logged or
persisted.

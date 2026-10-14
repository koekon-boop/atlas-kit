#!/usr/bin/env bash
# addons/claude-login has nothing to download: no binary, no model, no key.
# This script reports whether the box can actually RUN a renewal (see README.md).
#
# MODES
#   (no args) | --check
#     exit 0 — ready: tmux present, the claude CLI resolves, a credentials
#              file exists and parses (also lists days left and the configured
#              CLAUDE_LOGIN_METHODS)
#     exit 2 — installable: something above is still to do (each gap is printed)
#     exit 1 — cannot: node missing
#
# Read-only and idempotent — it changes nothing on the box.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "!! node is required" >&2; exit 1; }
[ -f "$ROOT/.env" ] && set -a && . "$ROOT/.env" && set +a

gaps=0
gap() { echo "[claude-login] TODO: $*" >&2; gaps=$((gaps + 1)); }

# 1. Enabled? ATLAS_ADDONS wins whenever it is DEFINED (even empty).
enabled=$(ROOT="$ROOT" node -e "
const fs = require('fs')
let names
if (process.env.ATLAS_ADDONS !== undefined) names = process.env.ATLAS_ADDONS.split(',').map((s) => s.trim())
else { try { names = JSON.parse(fs.readFileSync(process.env.ROOT + '/addons.json', 'utf8')).enabled || [] } catch { names = [] } }
process.stdout.write(names.includes('claude-login') ? 'yes' : 'no')
")
[ "$enabled" = "yes" ] || gap "claude-login is not enabled — add it to addons.json (or ATLAS_ADDONS), then scripts/serve.sh restart"

# 2. tmux — the renewal flow needs it (claude auth login runs inside a session).
if command -v tmux >/dev/null 2>&1; then
  echo "[claude-login] tmux found ($(tmux -V))"
else
  gap "tmux is required (apt install tmux) — the renewal flow drives claude auth login inside one"
fi

# 3. The claude CLI — asks core's own resolver (CLAUDE_BIN, then PATH, then the
#    usual fallback dirs), so this reports exactly what a real renewal would see.
CLAUDE_BIN_MJS="$ROOT/api/src/claude-bin.mjs"
if [ -f "$CLAUDE_BIN_MJS" ]; then
  resolved=$(CLAUDE_BIN_MJS="$CLAUDE_BIN_MJS" node --input-type=module -e "
import { pathToFileURL } from 'node:url'
const { claudeBinInfo } = await import(pathToFileURL(process.env.CLAUDE_BIN_MJS).href)
const info = claudeBinInfo()
process.stdout.write(info.ok ? 'ok:' + info.path : 'missing:' + info.error)
")
  case "$resolved" in
    ok:*) echo "[claude-login] claude CLI resolves to ${resolved#ok:}" ;;
    missing:*) gap "the claude CLI could not be resolved: ${resolved#missing:}" ;;
  esac
fi

# 4. The credentials file — informational: days left on the refresh token, and
#    whether a fresh renewal would even have something to act on.
CRED="${CLAUDE_LOGIN_CREDENTIALS_FILE:-$HOME/.claude/.credentials.json}"
CREDENTIALS_MJS="$ROOT/addons/claude-login/api/credentials.mjs"
if [ -f "$CREDENTIALS_MJS" ]; then
  CRED="$CRED" CREDENTIALS_MJS="$CREDENTIALS_MJS" node --input-type=module -e "
import { pathToFileURL } from 'node:url'
const { readCredentials, msUntilExpiry, formatExpiry } = await import(pathToFileURL(process.env.CREDENTIALS_MJS).href)
const c = readCredentials(process.env.CRED)
if (!c.ok) { console.error('[claude-login] ' + c.error); process.exit(1) }
const left = msUntilExpiry(c)
console.log('[claude-login] credentials file OK — refresh token valid until ' + formatExpiry(c.expiresAt) + ' (' + Math.round(left / 86400000) + ' day(s) left)')
" || gap "no readable credentials file at $CRED yet — log in once by hand (claude auth login) and this addon takes over from there"
else
  gap "addon files missing — this should not happen on a checkout that has this script"
fi

# 5. Methods + mac-chrome consent — informational, never a gap (both have sane defaults).
echo "[claude-login] CLAUDE_LOGIN_METHODS=${CLAUDE_LOGIN_METHODS:-telegram,dashboard}"
if [ "${CLAUDE_LOGIN_MAC_CHROME_CONSENT:-0}" = 1 ]; then
  HOST="${CLAUDE_LOGIN_MAC_CHROME_HOST:-mac}"
  if ssh -o ConnectTimeout=5 -o BatchMode=yes "$HOST" true >/dev/null 2>&1; then
    echo "[claude-login] mac-chrome: consented, and '$HOST' is reachable over ssh"
  else
    echo "[claude-login] mac-chrome: consented, but '$HOST' is NOT reachable over ssh right now (not necessarily a config problem — it may just be asleep)" >&2
  fi
else
  echo "[claude-login] mac-chrome: not consented (default) — see README.md before turning it on, especially on a customer box"
fi

if [ "$gaps" -eq 0 ]; then
  echo "[claude-login] ready"
  exit 0
fi
exit 2

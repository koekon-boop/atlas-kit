#!/usr/bin/env bash
# addons/whatsapp has nothing to download: no binary, no model. What it needs is
# CONFIGURATION spread over four places, and this script reports which are done
# (see README.md for the Meta-console click-through).
#
# MODES
#   (no args) | --check
#     exit 0 — installed: every env var set, addon enabled, Caddy block present,
#              speech recognition for voice notes and speech synthesis + ffmpeg (with libopus)
#              for voice replies configured (addons/voice)
#              (it also lists each allowed sender's session — informational, never a gap)
#     exit 2 — installable: something above is still to do (each gap is printed)
#     exit 1 — cannot: node missing
#
# Read-only and idempotent — it changes nothing on the box. The one thing it does
# not (and cannot) check is the Cloudflare Access bypass for the webhook path:
# that lives in Cloudflare, not on this box.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "!! node is required" >&2; exit 1; }
[ -f "$ROOT/.env" ] && set -a && . "$ROOT/.env" && set +a

gaps=0
gap() { echo "[whatsapp] TODO: $*" >&2; gaps=$((gaps + 1)); }

# 1. Env — names only, never values.
for v in WHATSAPP_VERIFY_TOKEN WHATSAPP_APP_SECRET WHATSAPP_ACCESS_TOKEN WHATSAPP_PHONE_NUMBER_ID WHATSAPP_ALLOWED_FROM DASHBOARD_BEARER_TOKEN; do
  [ -n "${!v:-}" ] || gap "$v is not set in .env"
done

# 2. Enabled? ATLAS_ADDONS wins whenever it is DEFINED (even empty).
enabled=$(ROOT="$ROOT" node -e "
const fs = require('fs')
let names
if (process.env.ATLAS_ADDONS !== undefined) names = process.env.ATLAS_ADDONS.split(',').map((s) => s.trim())
else { try { names = JSON.parse(fs.readFileSync(process.env.ROOT + '/addons.json', 'utf8')).enabled || [] } catch { names = [] } }
process.stdout.write(names.includes('whatsapp') ? 'yes' : 'no')
")
[ "$enabled" = "yes" ] || gap "whatsapp is not enabled — add it to addons.json (or ATLAS_ADDONS), then scripts/serve.sh restart"

# 3. Caddy: the webhook block (with the Content-Type rewrite) and the prefix block.
CADDY="$ROOT/infra/Caddyfile"
if [ ! -f "$CADDY" ]; then
  gap "infra/Caddyfile does not exist — copy infra/Caddyfile.example (it carries the /api/whatsapp/* blocks)"
else
  grep -q 'handle /api/whatsapp/webhook' "$CADDY" \
    && grep -A8 'handle /api/whatsapp/webhook' "$CADDY" | grep -q 'header_up Content-Type' \
    || gap "infra/Caddyfile has no 'handle /api/whatsapp/webhook' block with the Content-Type rewrite — copy it from infra/Caddyfile.example (without it every webhook is refused), then scripts/serve.sh restart"
  grep -q 'handle /api/whatsapp/\*' "$CADDY" \
    || gap "infra/Caddyfile has no 'handle /api/whatsapp/*' bearer block — /send would 401 through the proxy"
fi

# 3b. Who is connected: one standing session per allowed number (numbers masked). Informational,
#     never a gap — a number with no session just has not written yet. Asks the addon's own code so
#     it reads the state file exactly as the running API does (including the old single-session shape).
SESSIONS_MJS="$ROOT/addons/whatsapp/api/agent.mjs"
if [ -f "$SESSIONS_MJS" ] && [ -n "${WHATSAPP_ALLOWED_FROM:-}" ]; then
  SESSIONS_MJS="$SESSIONS_MJS" node --input-type=module -e "
import { pathToFileURL } from 'node:url'
const { senderSessions } = await import(pathToFileURL(process.env.SESSIONS_MJS).href)
const { config } = await import(pathToFileURL(process.env.SESSIONS_MJS.replace('agent.mjs', 'config.mjs')).href)
const c = config()
const rows = senderSessions({ allowed: c.allowedFrom, names: c.senderNames })
console.log('[whatsapp] ' + rows.length + ' allowed sender(s), one session each:')
for (const r of rows) console.log('[whatsapp]   ' + r.number + (r.name ? ' (' + r.name + ')' : '') + ' — ' + r.session + (r.since ? ', since ' + r.since : '') + ', 24 h window ' + (r.windowOpen === null ? 'never opened' : r.windowOpen ? 'open' : 'closed'))
if (rows.length > 1) console.log('[whatsapp]   (several senders: every reply must carry \"to\" — README \"Several people\"; Meta\'s test number knows at most 5 recipients)')
" 2>&1 || echo "[whatsapp] could not read the sessions (state file unreadable?)" >&2
fi

# 4. Voice notes (in) and voice replies (out) need addons/voice with on-box engines: enabled, the
#    command var set and its binary on PATH. (The browser's own speech engines, the voice addon's
#    default, cannot help here.) If the API is running, also ask it what it actually loaded —
#    informational: an API that predates a config change just needs a restart.
voice_on=$(ROOT="$ROOT" node -e "
const fs = require('fs')
let names
if (process.env.ATLAS_ADDONS !== undefined) names = process.env.ATLAS_ADDONS.split(',').map((s) => s.trim())
else { try { names = JSON.parse(fs.readFileSync(process.env.ROOT + '/addons.json', 'utf8')).enabled || [] } catch { names = [] } }
process.stdout.write(names.includes('voice') ? 'yes' : 'no')
")

# voice_live <stt|tts> → "yes", or why the running API does not report that engine available
voice_live() {
  SECTION="$1" PORT="${API_PORT:-3001}" node -e "
fetch('http://127.0.0.1:' + process.env.PORT + '/api/addons', { signal: AbortSignal.timeout(3000) })
  .then((r) => r.json())
  .then((j) => {
    const v = (j.addons || []).find((a) => a.name === 'voice')
    const s = v && v.status && v.status[process.env.SECTION]
    process.stdout.write(!v ? 'the running API has no voice addon loaded (restart it?)' : s && s.available ? 'yes' : 'the running API says: ' + ((s && s.reason) || 'no status for it'))
  })
  .catch(() => process.stdout.write('the API is not answering on 127.0.0.1 — cannot ask'))
"
}

# voice_engine <stt|tts> <label> <ENV_VAR> <noun> <advice> — one gap, or one "reachable" line
voice_engine() {
  local section="$1" label="$2" var="$3" noun="$4" advice="$5" cmd="${!3:-}" live
  if [ -z "$cmd" ]; then
    gap "$label need on-box speech $noun — set $var ($advice)"
  elif ! command -v "${cmd%% *}" >/dev/null 2>&1; then
    gap "$var names '${cmd%% *}', which is not an executable — run: bash addons/voice/install.sh --check"
  else
    live=$(voice_live "$section")
    if [ "$live" = "yes" ]; then
      echo "[whatsapp] $label: $var resolves, the running API reports it available"
    else
      echo "[whatsapp] $label: $var resolves, but $live" >&2
    fi
  fi
}

if [ "$voice_on" != "yes" ]; then
  gap "voice notes and voice replies need the voice addon — enable 'voice' (addons.json / ATLAS_ADDONS); without it a voice note gets a 'speech recognition is not active' reply and voice: true replies go out as text"
else
  voice_engine stt "voice notes" ATLAS_VOICE_STT_CMD recognition "bash addons/voice/install.sh --engine whisper prints the line"
  voice_engine tts "voice replies" ATLAS_VOICE_TTS_CMD synthesis "a command: text on stdin, audio on stdout — see addons/voice/README.md"
fi

# 5. Voice replies re-encode with ffmpeg: WhatsApp shows a voice note (waveform) only for OGG/Opus, so
#    it needs the libopus encoder. (Without it every voice: true reply falls back to text.)
if ! command -v ffmpeg >/dev/null 2>&1; then
  gap "voice replies need ffmpeg (with libopus) on PATH — apt install ffmpeg; without it voice: true replies go out as text"
else
  # captured first: 'ffmpeg | grep -q' would trip pipefail when grep exits early
  encoders=$(ffmpeg -hide_banner -encoders 2>/dev/null || true)
  if grep -q libopus <<<"$encoders"; then
    echo "[whatsapp] voice replies: ffmpeg with libopus found"
  else
    gap "ffmpeg has no libopus encoder — voice replies need it for OGG/Opus (install a full ffmpeg build); voice: true replies go out as text meanwhile"
  fi
fi

if [ "$gaps" -eq 0 ]; then
  echo "[whatsapp] ready — env set, addon enabled, Caddy blocks present"
  echo "[whatsapp] not checkable from here: the Cloudflare Access bypass for /api/whatsapp/webhook, and Meta's webhook subscription (README steps 6–7)"
  exit 0
fi
exit 2

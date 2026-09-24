#!/usr/bin/env bash
# addons/whatsapp has nothing to download: no binary, no model. What it needs is
# CONFIGURATION spread over four places, and this script reports which are done
# (see README.md for the Meta-console click-through).
#
# MODES
#   (no args) | --check
#     exit 0 — installed: every env var set, addon enabled, Caddy block present,
#              and speech recognition for voice notes configured (addons/voice)
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

# 4. Voice notes need addons/voice with an on-box STT: enabled, ATLAS_VOICE_STT_CMD set and its
#    binary on PATH. (The browser's own speech recognition, the voice addon's default, cannot help
#    here.) If the API is running, also ask it what it actually loaded — informational: an API
#    that predates a config change just needs a restart.
voice_on=$(ROOT="$ROOT" node -e "
const fs = require('fs')
let names
if (process.env.ATLAS_ADDONS !== undefined) names = process.env.ATLAS_ADDONS.split(',').map((s) => s.trim())
else { try { names = JSON.parse(fs.readFileSync(process.env.ROOT + '/addons.json', 'utf8')).enabled || [] } catch { names = [] } }
process.stdout.write(names.includes('voice') ? 'yes' : 'no')
")
if [ "$voice_on" != "yes" ]; then
  gap "voice notes need the voice addon — enable 'voice' (addons.json / ATLAS_ADDONS); without it a voice note gets a 'speech recognition is not active' reply"
elif [ -z "${ATLAS_VOICE_STT_CMD:-}" ]; then
  gap "voice notes need on-box speech recognition — set ATLAS_VOICE_STT_CMD (bash addons/voice/install.sh --engine whisper prints the line)"
elif ! command -v "${ATLAS_VOICE_STT_CMD%% *}" >/dev/null 2>&1; then
  gap "ATLAS_VOICE_STT_CMD names '${ATLAS_VOICE_STT_CMD%% *}', which is not an executable — run: bash addons/voice/install.sh --check"
else
  live=$(PORT="${API_PORT:-3001}" node -e "
fetch('http://127.0.0.1:' + process.env.PORT + '/api/addons', { signal: AbortSignal.timeout(3000) })
  .then((r) => r.json())
  .then((j) => {
    const v = (j.addons || []).find((a) => a.name === 'voice')
    const s = v && v.status && v.status.stt
    process.stdout.write(!v ? 'the running API has no voice addon loaded (restart it?)' : s && s.available ? 'yes' : 'the running API says: ' + ((s && s.reason) || 'no STT status'))
  })
  .catch(() => process.stdout.write('the API is not answering on 127.0.0.1 — cannot ask'))
")
  if [ "$live" = "yes" ]; then
    echo "[whatsapp] voice notes: speech recognition reachable (ATLAS_VOICE_STT_CMD resolves, the running API reports it available)"
  else
    echo "[whatsapp] voice notes: ATLAS_VOICE_STT_CMD resolves, but $live" >&2
  fi
fi

if [ "$gaps" -eq 0 ]; then
  echo "[whatsapp] ready — env set, addon enabled, Caddy blocks present"
  echo "[whatsapp] not checkable from here: the Cloudflare Access bypass for /api/whatsapp/webhook, and Meta's webhook subscription (README steps 6–7)"
  exit 0
fi
exit 2

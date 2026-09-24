#!/usr/bin/env bash
# addons/whatsapp has nothing to download: no binary, no model. What it needs is
# CONFIGURATION spread over four places, and this script reports which are done
# (see README.md for the Meta-console click-through).
#
# MODES
#   (no args) | --check
#     exit 0 — installed: every env var set, addon enabled, Caddy block present
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

if [ "$gaps" -eq 0 ]; then
  echo "[whatsapp] ready — env set, addon enabled, Caddy blocks present"
  echo "[whatsapp] not checkable from here: the Cloudflare Access bypass for /api/whatsapp/webhook, and Meta's webhook subscription (README steps 6–7)"
  exit 0
fi
exit 2

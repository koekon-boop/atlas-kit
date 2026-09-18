#!/usr/bin/env bash
# addons/weather has nothing to install: no binary, no model, no key.
# This script only reports whether the place is configured (see README.md).
#
# MODES
#   (no args) | --check
#     exit 0 — configured (ATLAS_WEATHER_LAT/LON parse)
#     exit 2 — not configured yet; set the two .env lines
#     exit 1 — node missing
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "!! node is required" >&2; exit 1; }
[ -f "$ROOT/.env" ] && set -a && . "$ROOT/.env" && set +a

node --input-type=module -e "
import { weatherConfig } from '$ROOT/addons/weather/api/weather.mjs'
const c = weatherConfig()
if (c.ok) { console.log('[weather] configured: ' + (c.label || c.lat + ',' + c.lon)); process.exit(0) }
console.error('[weather] ' + c.error); process.exit(2)
"

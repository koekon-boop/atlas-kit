#!/usr/bin/env bash
# addons/maps has nothing to install: three free, keyless OSM services (OSRM,
# Nominatim, Overpass) and no binary or model of its own. The one thing it
# truly needs is DASHBOARD_BEARER_TOKEN — its two POST routes gate themselves
# with it (docs/ADDONS.md), same as every other addon write — which core
# already wants set for the dashboard's own writes, so this only reports
# whether that is done.
#
# MODES
#   (no args) | --check
#     exit 0 — DASHBOARD_BEARER_TOKEN is set
#     exit 2 — not set yet
#     exit 1 — node missing
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "!! node is required" >&2; exit 1; }
[ -f "$ROOT/.env" ] && set -a && . "$ROOT/.env" && set +a

if [ -n "${DASHBOARD_BEARER_TOKEN:-}" ]; then
  echo "[maps] ready — DASHBOARD_BEARER_TOKEN is set; OSRM/Nominatim/Overpass need no key"
  exit 0
fi
echo "[maps] DASHBOARD_BEARER_TOKEN is not set in .env — core needs it too, for the dashboard's own writes" >&2
exit 2

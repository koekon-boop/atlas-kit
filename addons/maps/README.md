# `addons/maps` — route/ETA and nearby places, hands-free

Lets the operator ask Jarvis things like *"how far to the Hauptbahnhof"* or
*"any gas station nearby"* while driving, and get a spoken/typed answer back.
Google/Apple Maps on the phone still does the actual turn-by-turn driving —
**this is not a navigation-app replacement**, just voice-accessible route and
places info.

- `POST /api/maps/route` → `{ ok, distanceKm, durationMin, origin, destination, destinationLabel?, source }`
  or `{ ok: false, error }`.
- `POST /api/maps/nearby` → `{ ok, category, label, radiusM, places: [{ name, lat, lon, distanceKm }], source }`
  or `{ ok: false, error }`.
- The same two operations again as MCP tools (`maps_route`, `maps_nearby`) —
  box-local, so the Jarvis chat (and any dev/knowledge session) can call them
  directly instead of curling a local port.
- Three sources, all **free and keyless**:
  [OSRM](http://project-osrm.org/) (routing), [Nominatim](https://nominatim.org/)
  (geocoding), [Overpass](https://overpass-api.de/) (places) — the same
  no-API-key, no-billing-account posture as `addons/weather`'s Open-Meteo.

```
maps_route({ originLat: 48.14, originLon: 11.58, destination: "Munich Hauptbahnhof" })
maps_nearby({ lat: 48.14, lon: 11.58, category: "fuel" })
```

## How location reaches it

This addon has **no server-side notion of "here"** — `origin` (route) and
`lat`/`lon` (nearby) are required inputs, not defaults. The Jarvis tab reads
the phone's position with the browser's Geolocation API, **only when the
operator sends a message while this addon is enabled** (never polled in the
background — that is a battery and privacy cost nobody asked to pay). The fix
is folded into the opening turn of a **new** Jarvis chat as plain text
("the operator's phone reports its current location as …"); the chat then
passes those coordinates into `maps_route`/`maps_nearby` if the question needs
a starting point and none was stated. A follow-up question later in the same
conversation does not get a fresh fix — start "New chat" for one (see
`web/src/lib/jarvis.ts` `jarvisTask()` and `web/src/lib/geolocation.ts`).

## What it costs

Nothing on disk, no model, no key, no account. Each call is one outbound
HTTPS request to a free public service, made only while the dashboard or a
chat asks — and even then, cached:

| endpoint | cache | why |
|---|---|---|
| route | 5 min (`ATLAS_MAPS_ROUTE_CACHE_TTL_MS`) | identical questions ("how far to X") land inside the same drive |
| nearby | 5 min (`ATLAS_MAPS_NEARBY_CACHE_TTL_MS`) | "gas station near me" from roughly the same spot twice |
| geocode | 60 min (`ATLAS_MAPS_GEOCODE_CACHE_TTL_MS`) | a place's coordinates do not change between questions |

## Enable

```json
// addons.json
{ "enabled": ["maps"] }
```

…or `ATLAS_ADDONS=maps,weather` (wins whenever set). Needs
`DASHBOARD_BEARER_TOKEN` set in `.env` — core already wants this for its own
writes; `bash addons/maps/install.sh --check` reports whether it is. Then
restart — enabling is a restart, not a reload:

```sh
scripts/serve.sh restart
```

`infra/Caddyfile` needs the `handle /api/maps/*` block from
`infra/Caddyfile.example` (a hand-sync point on this fork, same as the voice
addon's — see that file's own note) so the dashboard's own POSTs to these two
routes do not 401.

Check it took:

```sh
curl -s -X POST localhost:3001/api/maps/route \
  -H "Authorization: Bearer $DASHBOARD_BEARER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"origin":{"lat":48.14,"lon":11.58},"destination":"Munich Hauptbahnhof"}'
```

## What it cannot do

Read this before relying on it while actually driving.

- **No turn-by-turn navigation.** `maps_route` answers one distance and one
  ETA, not a list of turns. It structurally cannot narrate a drive — use the
  phone's own Google/Apple Maps for that, which is the whole point of this
  addon staying out of that business.
- **No live traffic, ever, on the free tier.** OSRM's public router models
  road speeds from OSM tags, not current conditions — an ETA at 8am rush hour
  reads the same as one at 3am. See "Swapping in a paid provider" below if
  that matters enough to pay for.
- **`router.project-osrm.org` is a shared demo server**, not an SLA'd
  service — OSRM's own docs call it unsuitable for heavy or commercial use.
  This addon is polite about it (caches, one request per question) but cannot
  make it more available than it is; a `route unavailable` answer sometimes
  just means the demo server is busy.
- **Nominatim's usage policy is enforced, not just documented**: a descriptive
  User-Agent on every request (`ATLAS_MAPS_CONTACT` if you want to add contact
  info) and a hard **1 request/second** ceiling, serialised across every
  caller in this process — a burst of questions queues instead of getting the
  IP rate-limited or blocked.
- **Overpass coverage is only as good as OSM tagging** in that area — a
  missing result can mean "there is one but it is untagged", not "there is
  none". Categories are a small fixed set (see `api/config.mjs` `CATEGORIES`);
  a category not in that list needs a code change, not a config one.
- **No reverse geocoding** (coordinates → address) is wired up — neither
  endpoint needs it. Nominatim supports it and `api/nominatim.mjs` is where a
  `reverseGeocode()` would go, through the same rate limit, if a future
  question needs "where am I" in words.
- **No rendered map.** Answers are text (distance, time, names) for a
  voice/chat reply — there is no Leaflet/Mapbox widget here, on purpose (this
  is informational Q&A, not a map app).

## Swapping in a paid provider later

Every backend is an env-var-driven base URL, the same seam
`ATLAS_VOICE_TTS_CMD` uses to make the voice engine swappable — this addon's
shape does not need to change to add live traffic:

| variable | default | |
|---|---|---|
| `ATLAS_MAPS_OSRM_BASE` | `https://router.project-osrm.org` | point at your own OSRM deployment, or a routing engine that speaks the same `/route/v1/{profile}/{coords}` shape (Mapbox Directions and several self-hosted OSRM-compatible services do) |
| `ATLAS_MAPS_NOMINATIM_BASE` | `https://nominatim.openstreetmap.org` | a self-hosted Nominatim, or swap `api/nominatim.mjs` for a Google/Mapbox geocoder if you want to pay for it |
| `ATLAS_MAPS_OVERPASS_BASE` | `https://overpass-api.de/api/interpreter` | a self-hosted Overpass instance, or another OSM mirror |
| `ATLAS_MAPS_CONTACT` | — | contact info folded into Nominatim's required User-Agent |
| `ATLAS_MAPS_ROUTE_CACHE_TTL_MS` | `300000` (5 min) | route/ETA cache window |
| `ATLAS_MAPS_NEARBY_CACHE_TTL_MS` | `300000` (5 min) | nearby-places cache window |
| `ATLAS_MAPS_GEOCODE_CACHE_TTL_MS` | `3600000` (60 min) | place-name → coordinates cache window |
| `ATLAS_MAPS_NEARBY_RADIUS_M` | `3000` | default search radius, max `20000` |
| `ATLAS_MAPS_MAX_NEARBY_RESULTS` | `5` | how many places come back, max `10` |

A live-traffic provider (Google Directions, Mapbox, TomTom) needs its own key
and billing account — none of which belongs in this addon's free-by-default
path. Wiring one in is a second adapter behind the same `routeBetween()`
shape, chosen by which base URL / key env vars are set, the way
`addons/flight-search/api/adapters/` adds a second flight source.

## Tests

```sh
node --test addons/maps/test/*.test.mjs
```

No network — every external call (OSRM, Nominatim, Overpass) is mocked. The
Nominatim rate limiter's own wait is skipped in tests via an injected
`sleepImpl`; the DECISION it makes (`nextCallDelay`) is asserted directly with
a fake clock instead.

**Skipped, deliberately:** a rendered results card in the Jarvis tab (the chat
transcript already shows the answer conversationally — add one if the
operator wants a persistent glance-able widget); reverse geocoding (neither
endpoint needs it yet); attaching a fresh location to every follow-up message
in an existing Jarvis conversation, not just a new chat's opening turn.

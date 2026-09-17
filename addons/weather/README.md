# addons/weather

Current weather for **one configured place**, for the dashboard's **Jarvis** tab.

- `GET /api/weather` → `{ ok, label, tempC, feelsC, humidity, windKmh, summary, highC, lowC, observedAt, source }`
  or `{ ok: false, error }` with a reason a human can act on.
- Source: [Open-Meteo](https://open-meteo.com/) — **no API key, no account.**
- Cached server-side (15 min by default), so any number of open dashboards cost
  one upstream request per cache window.

## Enable

```bash
# .env  (never the repo — a latitude/longitude is a home address)
ATLAS_WEATHER_LAT=48.14
ATLAS_WEATHER_LON=11.58
ATLAS_WEATHER_LABEL=Munich        # optional, shown on the tile
# ATLAS_WEATHER_TTL_MS=900000     # optional cache window, ≥ 60000
```

Add `weather` to `addons.json` (or `ATLAS_ADDONS`) and `scripts/serve.sh restart`.
`bash addons/weather/install.sh --check` reports whether it is configured.

## What it costs

Nothing on disk, nothing in RAM worth naming, no model call. One outbound HTTPS
request to `api.open-meteo.com` per cache window, and only while something asks.
Open-Meteo's free tier is for non-commercial use.

## What it cannot do

No forecast beyond today's high/low, no alerts, one place only. A read route
only — there is nothing to write, so no bearer gate and no Caddyfile block.

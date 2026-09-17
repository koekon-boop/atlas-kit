/* ------------------------------------------------------------------ *
 * `addons/weather` — the whole data path: one Open-Meteo forecast read for one
 * configured place, cached.
 *
 * WHY OPEN-METEO: no key, no account, no billing — the one weather source that
 * fits "the kit ships no API key". The place is operator config (.env), never
 * the repo: a latitude/longitude on a public repo is a home address.
 *
 * DEGRADE, NEVER CRASH (docs/ADDONS.md): not configured, no network, a slow or
 * malformed answer — each is `{ ok: false, error }`, and the Jarvis tab shows
 * that reason instead of a number. A stale cached reading is served (flagged)
 * when a refresh fails, because an hour-old temperature beats none.
 * ------------------------------------------------------------------ */

/** The configured place, or `{ ok: false, error }` saying what to set. Read at
 *  CALL time, not import time, so an .env edit + restart is all it takes. */
export function weatherConfig(env = process.env) {
  const rawLat = String(env.ATLAS_WEATHER_LAT ?? '').trim()
  const rawLon = String(env.ATLAS_WEATHER_LON ?? '').trim()
  if (!rawLat && !rawLon) return { ok: false, error: 'set ATLAS_WEATHER_LAT and ATLAS_WEATHER_LON in .env' }
  const lat = Number(rawLat)
  const lon = Number(rawLon)
  if (!rawLat || !rawLon || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    return { ok: false, error: 'ATLAS_WEATHER_LAT / ATLAS_WEATHER_LON must be a valid latitude and longitude' }
  const ttl = Number(env.ATLAS_WEATHER_TTL_MS)
  return {
    ok: true,
    lat,
    lon,
    label: (env.ATLAS_WEATHER_LABEL ?? '').trim(),
    ttlMs: Number.isFinite(ttl) && ttl >= 60000 ? ttl : 15 * 60 * 1000,
  }
}

/* WMO weather interpretation codes, as Open-Meteo documents them. */
const WMO = [
  [[0], 'Clear sky'],
  [[1], 'Mainly clear'],
  [[2], 'Partly cloudy'],
  [[3], 'Overcast'],
  [[45, 48], 'Fog'],
  [[51, 53, 55], 'Drizzle'],
  [[56, 57], 'Freezing drizzle'],
  [[61, 63, 65], 'Rain'],
  [[66, 67], 'Freezing rain'],
  [[71, 73, 75, 77], 'Snow'],
  [[80, 81, 82], 'Rain showers'],
  [[85, 86], 'Snow showers'],
  [[95], 'Thunderstorm'],
  [[96, 99], 'Thunderstorm with hail'],
]
export function describeWmo(code) {
  for (const [codes, label] of WMO) if (codes.includes(code)) return label
  return 'Unknown'
}

export function forecastUrl({ lat, lon }) {
  const q = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m',
    daily: 'temperature_2m_max,temperature_2m_min',
    timezone: 'auto',
    forecast_days: '1',
  })
  return `https://api.open-meteo.com/v1/forecast?${q}`
}

/** Open-Meteo JSON → the shape the dashboard reads. Throws on a body that is
 *  missing the current block, so a malformed answer is an error, not a 0 °C. */
export function shapeForecast(json, label = '') {
  const c = json?.current
  if (!c || !Number.isFinite(c.temperature_2m) || !Number.isFinite(c.weather_code)) throw new Error('unexpected Open-Meteo response')
  const d = json.daily || {}
  return {
    ok: true,
    label,
    observedAt: String(c.time || ''),
    timezone: String(json.timezone || ''),
    tempC: c.temperature_2m,
    feelsC: Number.isFinite(c.apparent_temperature) ? c.apparent_temperature : null,
    humidity: Number.isFinite(c.relative_humidity_2m) ? c.relative_humidity_2m : null,
    windKmh: Number.isFinite(c.wind_speed_10m) ? c.wind_speed_10m : null,
    code: c.weather_code,
    summary: describeWmo(c.weather_code),
    highC: Number.isFinite(d.temperature_2m_max?.[0]) ? d.temperature_2m_max[0] : null,
    lowC: Number.isFinite(d.temperature_2m_min?.[0]) ? d.temperature_2m_min[0] : null,
    source: 'open-meteo.com',
  }
}

let cache = null // { at, key, payload }

/** The reading for the configured place, from cache while it is fresh. */
export async function currentWeather({ fetchImpl = fetch, now = Date.now(), env = process.env } = {}) {
  const cfg = weatherConfig(env)
  if (!cfg.ok) return cfg
  const key = `${cfg.lat},${cfg.lon}`
  if (cache && cache.key === key && now - cache.at < cfg.ttlMs) return cache.payload
  try {
    const res = await fetchImpl(forecastUrl(cfg), { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`Open-Meteo answered HTTP ${res.status}`)
    const payload = shapeForecast(await res.json(), cfg.label)
    cache = { at: now, key, payload }
    return payload
  } catch (e) {
    if (cache && cache.key === key) return { ...cache.payload, stale: true, error: String(e?.message || e) }
    return { ok: false, error: `weather unavailable: ${e?.message || e}` }
  }
}

export function _resetCache() {
  cache = null
}

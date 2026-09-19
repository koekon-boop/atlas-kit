/* ------------------------------------------------------------------ *
 * Nearby OSM points of interest via the public Overpass API — free, no key.
 *
 * A small FIXED category → OSM tag map (config.CATEGORIES) rather than a
 * free-text tag: "gas station near me" has to become one deterministic query,
 * not a guess at what tag a model felt like typing. Results are capped
 * (config.maxNearbyResults) and the query itself asks Overpass for at most 20
 * elements — keeping calls minimal per the task brief and Overpass's own
 * fair-use expectations.
 *
 * DEGRADE, NEVER CRASH (docs/ADDONS.md): a bad location, an unknown category,
 * a down/overloaded Overpass instance, or a malformed reply are each
 * `{ ok: false, error }`.
 * ------------------------------------------------------------------ */
import { CATEGORIES, defaultRadiusM, maxNearbyResults, nearbyCacheTtlMs, overpassBase, userAgent } from './config.mjs'

/** Great-circle distance in km — plenty accurate for "how far is the nearest
 *  X", and needs no library. */
export function haversineKm(a, b) {
  const R = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLon = ((b.lon - a.lon) * Math.PI) / 180
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
}

/** Overpass QL for "nodes and ways tagged tag=value within radiusM of
 *  lat,lon", asking for way centroids (`out center`) so a fuel station mapped
 *  as an area still gets one coordinate to measure distance from. */
export function overpassQuery({ lat, lon, tag, value, radiusM }) {
  const around = `(around:${radiusM},${lat},${lon})`
  return `[out:json][timeout:10];(node["${tag}"="${value}"]${around};way["${tag}"="${value}"]${around};);out center 20;`
}

let cache = new Map() // "lat,lon|category|radius" -> { at, payload }

export async function nearbyPlaces({ lat, lon, category, radiusM }, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    return { ok: false, error: 'lat/lon are required — e.g. the phone\'s current GPS position' }
  const cat = CATEGORIES[category]
  if (!cat) return { ok: false, error: `unknown category "${category}" — try one of: ${Object.keys(CATEGORIES).join(', ')}` }
  const radius = Math.min(20000, Math.max(200, Number(radiusM) || defaultRadiusM()))

  const key = `${lat.toFixed(3)},${lon.toFixed(3)}|${category}|${radius}`
  const hit = cache.get(key)
  if (hit && now - hit.at < nearbyCacheTtlMs()) return hit.payload

  try {
    const q = overpassQuery({ lat, lon, tag: cat.tag, value: cat.value, radiusM: radius })
    const res = await fetchImpl(overpassBase(), {
      method: 'POST',
      // Overpass answers HTTP 406 to a request with no User-Agent — same
      // identifying-header discipline as nominatim.mjs, same function.
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgent() },
      body: `data=${encodeURIComponent(q)}`,
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) throw new Error(`Overpass answered HTTP ${res.status}`)
    const json = await res.json()
    const elements = Array.isArray(json?.elements) ? json.elements : []
    const places = elements
      .map((el) => {
        const p = el.type === 'node' ? { lat: el.lat, lon: el.lon } : el.center
        if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return null
        return { name: el.tags?.name || cat.label, lat: p.lat, lon: p.lon, distanceKm: Math.round(haversineKm({ lat, lon }, p) * 10) / 10 }
      })
      .filter(Boolean)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, maxNearbyResults())

    const payload = { ok: true, category, label: cat.label, radiusM: radius, count: places.length, places, source: 'overpass-api.de' }
    cache.set(key, { at: now, payload })
    return payload
  } catch (e) {
    return { ok: false, error: `nearby search unavailable: ${e?.message || e}` }
  }
}

export function _resetCache() {
  cache = new Map()
}

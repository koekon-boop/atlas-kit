/* ------------------------------------------------------------------ *
 * Driving distance + ETA via OSRM's public demo router — free, no key.
 *
 * ⚠️ SHARED DEMO SERVER: router.project-osrm.org is explicitly "not suitable
 * for large scale use" (OSRM's own docs) — no SLA, informal rate limits, no
 * guarantee it stays up. This module respects that the only way code can:
 * caching identical requests for a few minutes (routeCacheTtlMs) so a chat
 * asking "how far to X" three times in a row costs one upstream call, and
 * keeping the request itself minimal (`overview=false`, no steps — this addon
 * answers a distance and a time, never turn-by-turn, see README).
 *
 * DEGRADE, NEVER CRASH (docs/ADDONS.md): a bad/missing origin, an
 * ungeocodable destination, a down router or a malformed reply are each
 * `{ ok: false, error }` a human (or the LLM relaying it) can act on.
 * ------------------------------------------------------------------ */
import { osrmBase, routeCacheTtlMs } from './config.mjs'
import { geocode } from './nominatim.mjs'

function isCoord(o) {
  return !!o && Number.isFinite(o.lat) && Number.isFinite(o.lon) && Math.abs(o.lat) <= 90 && Math.abs(o.lon) <= 180
}

export function osrmRouteUrl({ origin, destination }) {
  return `${osrmBase()}/route/v1/driving/${origin.lon},${origin.lat};${destination.lon},${destination.lat}?overview=false&alternatives=false&steps=false`
}

let cache = new Map() // "olat,olon>dlat,dlon" -> { at, payload }

/**
 * `origin` must be `{ lat, lon }` — this addon has no server-side notion of
 * "here"; the caller (the phone, or the Jarvis chat relaying its GPS fix)
 * supplies it. `destination` is `{ lat, lon }`, a place-name string, or
 * `{ place: string }` — a string destination is geocoded via Nominatim first,
 * through its own rate limit and cache.
 */
export async function routeBetween({ origin, destination }, { fetchImpl = fetch, now = Date.now(), geocodeImpl = geocode } = {}) {
  if (!isCoord(origin)) return { ok: false, error: 'origin {lat,lon} is required — e.g. the phone\'s current GPS position' }

  let dest = destination
  let destinationLabel
  const place = typeof dest === 'string' ? dest : typeof dest?.place === 'string' ? dest.place : null
  if (place) {
    const g = await geocodeImpl(place, { fetchImpl, now })
    if (!g.ok) return g
    dest = { lat: g.lat, lon: g.lon }
    destinationLabel = g.displayName
  }
  if (!isCoord(dest)) return { ok: false, error: 'destination must be {lat,lon} or a place name to geocode' }

  const key = `${origin.lat.toFixed(4)},${origin.lon.toFixed(4)}>${dest.lat.toFixed(4)},${dest.lon.toFixed(4)}`
  const hit = cache.get(key)
  if (hit && now - hit.at < routeCacheTtlMs()) return hit.payload

  try {
    const res = await fetchImpl(osrmRouteUrl({ origin, destination: dest }), { signal: AbortSignal.timeout(10000) })
    if (!res.ok) throw new Error(`OSRM answered HTTP ${res.status}`)
    const json = await res.json()
    const r = json?.routes?.[0]
    if (json?.code !== 'Ok' || !r || !Number.isFinite(r.distance) || !Number.isFinite(r.duration)) {
      throw new Error(json?.message || `unexpected OSRM response (code: ${json?.code || 'none'})`)
    }
    const payload = {
      ok: true,
      profile: 'driving',
      distanceKm: Math.round((r.distance / 1000) * 10) / 10,
      durationMin: Math.round(r.duration / 60),
      origin,
      destination: dest,
      ...(destinationLabel ? { destinationLabel } : {}),
      source: 'router.project-osrm.org',
      note: 'free public demo router — no live traffic, ETA is a modelled drive time',
    }
    cache.set(key, { at: now, payload })
    return payload
  } catch (e) {
    return { ok: false, error: `route unavailable: ${e?.message || e}` }
  }
}

export function _resetCache() {
  cache = new Map()
}

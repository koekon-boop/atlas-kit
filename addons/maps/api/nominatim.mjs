/* ------------------------------------------------------------------ *
 * Forward geocoding (place name → coordinates) via OSM Nominatim's public
 * endpoint — free, no key, no account.
 *
 * ⚠️ USAGE POLICY, BUILT IN, NOT DOCUMENTED-AND-HOPED: Nominatim requires a
 * descriptive User-Agent identifying the app (config.userAgent()) and caps
 * every caller at one request per second. `_throttle` below serialises every
 * call this process makes through a single queue so that cap holds globally —
 * two nearly-simultaneous questions from two Jarvis chats still land ≥1.1s
 * apart, never a documentation note nobody enforces.
 *
 * Reverse geocoding (coordinates → address) is NOT built here — neither
 * /api/maps/route nor /api/maps/nearby needs it (see README "What it cannot
 * do"); add a reverseGeocode() alongside this one, through the same throttle,
 * when something needs "where am I" in words.
 * ------------------------------------------------------------------ */
import { NOMINATIM_MIN_INTERVAL_MS, geocodeCacheTtlMs, nominatimBase, userAgent } from './config.mjs'

let lastCallAt = -Infinity
let queue = Promise.resolve()

/** How long until the next call may go out, given when the last one did. Pure
 *  so the rate-limit DECISION is testable without a real clock. */
export function nextCallDelay(lastAt, now, minIntervalMs = NOMINATIM_MIN_INTERVAL_MS) {
  return Math.max(0, lastAt + minIntervalMs - now)
}

/** Runs `fn` after waiting out whatever the last call still owes the 1 req/s
 *  floor, queued behind every other in-flight call so concurrent callers
 *  serialise instead of racing the floor. `sleepImpl`/`nowImpl` are seams for
 *  tests, not operator knobs — production always uses the real clock. */
function throttled(fn, { sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const run = queue.then(async () => {
    const wait = nextCallDelay(lastCallAt, Date.now())
    if (wait > 0) await sleepImpl(wait)
    lastCallAt = Date.now()
    return fn()
  })
  queue = run.catch(() => {}) // one failed lookup must not wedge the queue for the next caller
  return run
}

let cache = new Map() // lowercased query -> { at, payload }

/** One place name → { ok, lat, lon, displayName, source } or a reason. Cached
 *  for an hour by default — a place's coordinates do not change between
 *  questions, so re-asking "Hauptbahnhof" a minute later costs nothing. */
export async function geocode(place, { fetchImpl = fetch, now = Date.now(), sleepImpl } = {}) {
  const q = String(place || '').trim()
  if (!q) return { ok: false, error: 'no place name given to geocode' }
  const key = q.toLowerCase()
  const hit = cache.get(key)
  if (hit && now - hit.at < geocodeCacheTtlMs()) return hit.payload

  try {
    const payload = await throttled(
      async () => {
        const url = new URL(`${nominatimBase()}/search`)
        url.searchParams.set('q', q)
        url.searchParams.set('format', 'jsonv2')
        url.searchParams.set('limit', '1')
        const res = await fetchImpl(url, { headers: { 'User-Agent': userAgent() }, signal: AbortSignal.timeout(8000) })
        if (!res.ok) throw new Error(`Nominatim answered HTTP ${res.status}`)
        const rows = await res.json()
        const row = rows?.[0]
        if (!row) return { ok: false, error: `no place found for "${q}"` }
        const lat = Number(row.lat)
        const lon = Number(row.lon)
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('unexpected Nominatim response')
        return { ok: true, lat, lon, displayName: String(row.display_name || q), source: 'nominatim.openstreetmap.org' }
      },
      { sleepImpl },
    )
    cache.set(key, { at: now, payload })
    return payload
  } catch (e) {
    return { ok: false, error: `geocoding unavailable: ${e?.message || e}` }
  }
}

export function _resetCache() {
  cache = new Map()
  lastCallAt = -Infinity
  queue = Promise.resolve()
}

/* ------------------------------------------------------------------ *
 * Every knob `addons/maps` reads, in one place.
 *
 * Read at CALL time, never frozen at import — register() imports this module
 * at boot, so a top-level `const` would pin whatever .env said at process
 * start and quietly ignore the operator's next edit (same discipline as
 * flight-search/api/config.mjs).
 *
 * THREE FREE, KEYLESS BACKENDS, EACH SWAPPABLE: the base URL for each is an
 * env var with a working public default, so an operator who later wants live
 * traffic (Google, Mapbox, TomTom) points ATLAS_MAPS_OSRM_BASE at their own
 * OSRM-compatible endpoint instead of forking this addon — same seam
 * ATLAS_VOICE_TTS_CMD uses to make the voice engine swappable.
 * ------------------------------------------------------------------ */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ADDON_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const str = (k, d = '') => {
  const v = process.env[k]
  return v === undefined || v === '' ? d : v
}
const num = (k, d) => {
  const n = Number(process.env[k])
  return Number.isFinite(n) && n >= 0 ? n : d
}

export const osrmBase = () => str('ATLAS_MAPS_OSRM_BASE', 'https://router.project-osrm.org').replace(/\/$/, '')
export const nominatimBase = () => str('ATLAS_MAPS_NOMINATIM_BASE', 'https://nominatim.openstreetmap.org').replace(/\/$/, '')
export const overpassBase = () => str('ATLAS_MAPS_OVERPASS_BASE', 'https://overpass-api.de/api/interpreter')

/** Nominatim's usage policy requires a descriptive User-Agent identifying the
 *  calling application — a generic one (or none) gets an IP range blocked.
 *  Contact info is optional but recommended by that policy; it is operator
 *  config (.env), never baked into this public repo. */
export const userAgent = () => {
  const contact = str('ATLAS_MAPS_CONTACT', '')
  const ua = `atlas-kit-maps-addon/1.0${contact ? ` (${contact})` : ' (contact not configured - set ATLAS_MAPS_CONTACT in .env)'}`
  // Header values must be ByteString (Latin-1) — Node's fetch/Headers throws a
  // TypeError otherwise, and that throw would surface as a confusing "geocoding
  // unavailable" error rather than pointing at this string. Catch it here instead.
  if (!/^[\x00-\xff]*$/.test(ua)) throw new Error(`userAgent() produced a non-Latin-1 string, unsafe as a header value: ${ua}`)
  return ua
}

export const routeCacheTtlMs = () => Math.max(60000, num('ATLAS_MAPS_ROUTE_CACHE_TTL_MS', 5 * 60 * 1000))
export const nearbyCacheTtlMs = () => Math.max(60000, num('ATLAS_MAPS_NEARBY_CACHE_TTL_MS', 5 * 60 * 1000))
export const geocodeCacheTtlMs = () => Math.max(60000, num('ATLAS_MAPS_GEOCODE_CACHE_TTL_MS', 60 * 60 * 1000))

export const defaultRadiusM = () => Math.min(20000, Math.max(200, num('ATLAS_MAPS_NEARBY_RADIUS_M', 3000)))
export const maxNearbyResults = () => Math.min(10, Math.max(1, num('ATLAS_MAPS_MAX_NEARBY_RESULTS', 5)))

/** Nominatim's hard usage-policy floor — at most one request per second,
 *  globally, no matter how many callers ask at once. This is NOT a knob: it
 *  is not read from the environment on purpose. */
export const NOMINATIM_MIN_INTERVAL_MS = 1100

/** A small, fixed set of friendly categories a spoken/typed question actually
 *  uses ("gas station", "coffee"), mapped to the OSM tag that answers them.
 *  Deliberately not exhaustive — see README "What it cannot do". */
export const CATEGORIES = {
  fuel: { label: 'fuel station', tag: 'amenity', value: 'fuel' },
  parking: { label: 'parking', tag: 'amenity', value: 'parking' },
  food: { label: 'restaurant', tag: 'amenity', value: 'restaurant' },
  coffee: { label: 'cafe', tag: 'amenity', value: 'cafe' },
  pharmacy: { label: 'pharmacy', tag: 'amenity', value: 'pharmacy' },
  hospital: { label: 'hospital', tag: 'amenity', value: 'hospital' },
  atm: { label: 'ATM', tag: 'amenity', value: 'atm' },
  ev_charging: { label: 'EV charging station', tag: 'amenity', value: 'charging_station' },
}

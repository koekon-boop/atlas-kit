/* ------------------------------------------------------------------ *
 * `addons/maps` — the addon's whole registration surface.
 *
 * Two POST routes (route/ETA and nearby places, both free/keyless: OSRM +
 * Nominatim + Overpass) and the SAME two operations again as `mcpTools`, so a
 * box-local Claude Code session — the Jarvis chat included — can call them
 * directly instead of having to know to curl a local port. Mirrors
 * flight-search's `search_flights`: one MCP tool per question shape, box-local
 * only (docs/ADDONS.md), never in core's remote KNOWLEDGE_TOOLS.
 *
 * 🔴 THE ROUTES GATE THEMSELVES. Addon routers are mounted WITHOUT core's
 * bearer middleware (docs/ADDONS.md), and POST is a write as far as
 * `api/test/addon-caddyfile-bearer.test.mjs` is concerned even though neither
 * route mutates any state — so both carry the same constant-time
 * DASHBOARD_BEARER_TOKEN check core's own writes use (mirrors
 * instagram-ingest), and `infra/Caddyfile.example` gets the matching
 * `handle /api/maps/*` block. The MCP tools below are NOT behind this gate —
 * they run in-process, the same trust boundary as every other addon tool.
 * ------------------------------------------------------------------ */
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { CATEGORIES, defaultRadiusM, nearbyCacheTtlMs, nominatimBase, osrmBase, overpassBase, routeCacheTtlMs, userAgent } from './config.mjs'
import { routeBetween } from './osrm.mjs'
import { nearbyPlaces } from './overpass.mjs'

/* `zod` is what the MCP SDK builds a tool's input schema from. A bare import
 * does not resolve from inside an addon (`addons/<name>/api/` walks up to a
 * repo root with no node_modules), so it is required out of core's own tree —
 * still not an npm dependency of THIS addon, core already installed it. If it
 * cannot be resolved the tools are simply not registered and status() says so
 * (same pattern as flight-search/api/register.mjs). */
function loadZod() {
  try {
    return createRequire(new URL('../../../api/src/', import.meta.url))('zod').z
  } catch {
    return null
  }
}

function bearerAuth(req, res, next) {
  const token = process.env.DASHBOARD_BEARER_TOKEN || ''
  if (!token) return res.status(500).json({ error: 'server missing DASHBOARD_BEARER_TOKEN' })
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')
  if (!m) return res.status(401).json({ error: 'unauthorized' })
  const a = Buffer.from(m[1])
  const b = Buffer.from(token)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'unauthorized' })
  next()
}

const ROUTE_DESCRIPTION =
  'Driving distance and ETA between two points, via the free OSRM public demo router. ' +
  'origin is the CURRENT location (lat/lon) — pass the operator\'s phone GPS fix if one was given in context. ' +
  'destination is either a place name to geocode (e.g. "Munich Hauptbahnhof") or explicit lat/lon. ' +
  'Answers { distanceKm, durationMin } for the driving profile. NOT turn-by-turn directions and NOT live-traffic-aware — ' +
  'it is a modelled drive time for "how far / how long", not a navigation app; tell the operator to use their phone\'s ' +
  'own maps app for actual turn-by-turn.'

const NEARBY_DESCRIPTION =
  'The closest few OpenStreetMap points of interest in one category, via the free Overpass API. ' +
  `Categories: ${Object.keys(CATEGORIES).join(', ')} — pass the CURRENT location (lat/lon). ` +
  'Answers { places: [{ name, distanceKm }] }, nearest first. Coverage and names are only as good as OSM tagging in that ' +
  'area — a missing result does not always mean nothing is there.'

export default function register({ Router, express }) {
  const z = loadZod()

  const routes = Router()
  routes.use('/api/maps', express.json({ limit: '4kb' }))

  routes.post('/api/maps/route', bearerAuth, async (req, res) => {
    const { origin, destination } = req.body || {}
    res.json(await routeBetween({ origin, destination }))
  })

  routes.post('/api/maps/nearby', bearerAuth, async (req, res) => {
    const { lat, lon, category, radiusM } = req.body || {}
    res.json(await nearbyPlaces({ lat: Number(lat), lon: Number(lon), category, radiusM }))
  })

  const routeSchema = z && {
    originLat: z.number().describe('current latitude — e.g. the operator\'s phone GPS fix'),
    originLon: z.number().describe('current longitude'),
    destination: z.string().optional().describe('a place name to geocode, e.g. "Munich Hauptbahnhof" — omit if destinationLat/destinationLon are given'),
    destinationLat: z.number().optional().describe('destination latitude, if already known — skips geocoding'),
    destinationLon: z.number().optional().describe('destination longitude, if already known — skips geocoding'),
  }
  const nearbySchema = z && {
    lat: z.number().describe('current latitude — e.g. the operator\'s phone GPS fix'),
    lon: z.number().describe('current longitude'),
    category: z.enum(Object.keys(CATEGORIES)).describe('what to look for'),
    radiusM: z.number().optional().describe(`search radius in meters (default ${defaultRadiusM()}, max 20000)`),
  }

  return {
    description:
      'Route/ETA and nearby-places info for hands-free driving questions — OSRM + Nominatim + Overpass, all free and ' +
      'keyless. POST /api/maps/route, POST /api/maps/nearby (bearer-gated, like every addon write), and the same two ' +
      'operations as MCP tools for the Jarvis chat. Not a navigation app: no turn-by-turn, no live traffic.',
    routes,
    mcpTools: z
      ? [
          {
            name: 'maps_route',
            description: ROUTE_DESCRIPTION,
            inputSchema: routeSchema,
            handler: (args = {}) =>
              routeBetween({
                origin: { lat: args.originLat, lon: args.originLon },
                destination:
                  args.destinationLat != null && args.destinationLon != null
                    ? { lat: args.destinationLat, lon: args.destinationLon }
                    : args.destination,
              }),
          },
          {
            name: 'maps_nearby',
            description: NEARBY_DESCRIPTION,
            inputSchema: nearbySchema,
            handler: (args = {}) => nearbyPlaces({ lat: args.lat, lon: args.lon, category: args.category, radiusM: args.radiusM }),
          },
        ]
      : undefined,

    status: () => ({
      backends: { osrm: osrmBase(), nominatim: nominatimBase(), overpass: overpassBase() },
      userAgent: userAgent(),
      categories: Object.keys(CATEGORIES),
      routeCacheMinutes: Math.round(routeCacheTtlMs() / 60000),
      nearbyCacheMinutes: Math.round(nearbyCacheTtlMs() / 60000),
      tools: z ? ['maps_route', 'maps_nearby'] : 'NOT REGISTERED — zod could not be resolved from core; run npm ci in api/',
      bearerConfigured: !!(process.env.DASHBOARD_BEARER_TOKEN || ''),
    }),
  }
}

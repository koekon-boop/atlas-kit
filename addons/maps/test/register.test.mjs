/* ------------------------------------------------------------------ *
 * The addon's registration surface: the two routes on a real Express app, the
 * two mcpTools, and the manifest core reads.
 *
 * What this pins:
 *   · BOTH ROUTES GATE THEMSELVES — addon routers are mounted without core's
 *     bearer middleware (docs/ADDONS.md), and a server with no token
 *     configured refuses rather than falling open;
 *   · the mcpTools are box-local — NOT in core's remote KNOWLEDGE_TOOLS;
 *   · a bad request is a 200 answer with `ok:false`, never a 500 — the route
 *     and the tool both go through the same pure functions, so this also
 *     exercises them end to end once each.
 *
 * Hermetic: fetchImpl is monkey-patched globally for the duration of this file
 * (no addon here exposes a fetch injection point on its route handlers, same
 * as weather's `GET /api/weather`), so every assertion works off a canned
 * response. The app listens on an OS-assigned loopback port.
 * Run: node --test addons/maps/test/register.test.mjs
 * ------------------------------------------------------------------ */
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _resetCache as resetRouteCache } from '../api/osrm.mjs'
import { _resetCache as resetNearbyCache } from '../api/overpass.mjs'
import { _resetCache as resetGeocodeCache } from '../api/nominatim.mjs'

const ADDON_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const REPO_ROOT = path.resolve(ADDON_DIR, '..', '..')

const express = createRequire(new URL('../../../api/src/', import.meta.url))('express')
const deps = { name: 'maps', dir: ADDON_DIR, repoRoot: REPO_ROOT, express, Router: (o) => express.Router(o) }

const TOKEN = 'test-token-maps'
process.env.DASHBOARD_BEARER_TOKEN = TOKEN

const registerAddon = (await import('../api/register.mjs')).default
const manifest = registerAddon(deps)

const OK_ROUTE_BODY = { code: 'Ok', routes: [{ distance: 10000, duration: 600 }] }
const realFetch = globalThis.fetch
function stubFetch(handler) {
  globalThis.fetch = handler
}

const app = express()
app.use(manifest.routes)
const server = await new Promise((res) => {
  const s = app.listen(0, '127.0.0.1', () => res(s))
})
const base = `http://127.0.0.1:${server.address().port}`
after(() => {
  server.close()
  globalThis.fetch = realFetch
})

beforeEach(() => {
  resetRouteCache()
  resetNearbyCache()
  resetGeocodeCache()
  stubFetch(async () => ({ ok: true, status: 200, json: async () => OK_ROUTE_BODY }))
})

// Uses the SAVED real fetch, never the ambient global — stubFetch() below
// replaces globalThis.fetch so the addon's own outbound calls (OSRM/Overpass)
// are mocked, and this helper would otherwise be swallowed by that same stub
// instead of ever reaching the real test server.
const post = (p, { body, token } = {}) =>
  realFetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  })

test('both routes refuse without the bearer', async () => {
  for (const [route, body] of Object.entries({
    '/api/maps/route': { origin: { lat: 48, lon: 11 }, destination: { lat: 49, lon: 12 } },
    '/api/maps/nearby': { lat: 48, lon: 11, category: 'fuel' },
  })) {
    assert.equal((await post(route, { body })).status, 401, `${route} without a token`)
    assert.equal((await post(route, { body, token: 'wrong' })).status, 401, `${route} with a wrong token`)
  }
})

test('a server with no token configured refuses rather than falling open', async () => {
  delete process.env.DASHBOARD_BEARER_TOKEN
  const res = await post('/api/maps/route', { body: { origin: { lat: 48, lon: 11 }, destination: { lat: 49, lon: 12 } }, token: TOKEN })
  assert.equal(res.status, 500)
  assert.match((await res.json()).error, /DASHBOARD_BEARER_TOKEN/)
  process.env.DASHBOARD_BEARER_TOKEN = TOKEN
})

test('route: an authorized call answers distance/duration; a bad body answers ok:false, not a 500', async () => {
  const ok = await post('/api/maps/route', { body: { origin: { lat: 48, lon: 11 }, destination: { lat: 49, lon: 12 } }, token: TOKEN })
  assert.equal(ok.status, 200)
  const j = await ok.json()
  assert.equal(j.ok, true)
  assert.equal(j.distanceKm, 10)

  const bad = await post('/api/maps/route', { body: { origin: null, destination: { lat: 49, lon: 12 } }, token: TOKEN })
  assert.equal(bad.status, 200)
  assert.equal((await bad.json()).ok, false)
})

test('nearby: an authorized call answers places; an unknown category answers ok:false', async () => {
  stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ elements: [{ type: 'node', lat: 48.001, lon: 11.001, tags: { name: 'Shell' } }] }) }))
  const ok = await post('/api/maps/nearby', { body: { lat: 48, lon: 11, category: 'fuel' }, token: TOKEN })
  assert.equal(ok.status, 200)
  const j = await ok.json()
  assert.equal(j.ok, true)
  assert.equal(j.places[0].name, 'Shell')

  const bad = await post('/api/maps/nearby', { body: { lat: 48, lon: 11, category: 'not-a-category' }, token: TOKEN })
  assert.equal((await bad.json()).ok, false)
})

test('the manifest declares only routes + mcpTools + status', () => {
  assert.deepEqual(Object.keys(manifest).filter((k) => manifest[k] != null).sort(), ['description', 'mcpTools', 'routes', 'status'])
  assert.match(manifest.description, /free/i)
})

test('status() names the three backends and never throws', () => {
  const st = manifest.status()
  assert.match(st.backends.osrm, /router\.project-osrm\.org/)
  assert.match(st.backends.nominatim, /nominatim\.openstreetmap\.org/)
  assert.match(st.backends.overpass, /overpass-api\.de/)
  assert.ok(st.categories.includes('fuel'))
  assert.deepEqual(st.tools, ['maps_route', 'maps_nearby'])
  assert.equal(st.bearerConfigured, true)
})

test('mcpTools: coordinate destination bypasses geocoding; both answer rather than throw on nonsense', async () => {
  const route = manifest.mcpTools.find((t) => t.name === 'maps_route')
  const nearby = manifest.mcpTools.find((t) => t.name === 'maps_nearby')
  assert.ok(route && nearby)

  const r = await route.handler({ originLat: 48, originLon: 11, destinationLat: 49, destinationLon: 12 })
  assert.equal(r.ok, true)
  assert.equal(r.distanceKm, 10)

  stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ elements: [] }) }))
  const n = await nearby.handler({ lat: 48, lon: 11, category: 'coffee' })
  assert.equal(n.ok, true)
  assert.equal(n.places.length, 0)

  assert.equal((await route.handler({})).ok, false)
  assert.equal((await route.handler()).ok, false)
  assert.equal((await nearby.handler({})).ok, false)
})

test('THE SCHEMA IS ONE A REAL McpServer ACCEPTS — a bad one is skipped silently at boot', async () => {
  const req = createRequire(path.join(REPO_ROOT, 'api', 'src', 'addons.mjs'))
  const { McpServer } = await import(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/server/mcp.js')).href)
  const s = new McpServer({ name: 'test', version: '0' })
  for (const tool of manifest.mcpTools) {
    assert.doesNotThrow(() => s.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, async () => ({ content: [] })))
  }
})

test('BOX-LOCAL: neither tool is in core\'s remote knowledge surface', () => {
  const tools = fs.readFileSync(path.join(REPO_ROOT, 'api', 'src', 'mcp', 'tools.mjs'), 'utf-8')
  const knowledge = /KNOWLEDGE_TOOLS = new Set\(\[([^\]]*)\]/.exec(tools)
  assert.ok(knowledge)
  for (const name of ['maps_route', 'maps_nearby']) assert.ok(!knowledge[1].includes(name), `${name} was added to the audited remote surface`)
})

test('every non-GET route this addon registers is matched by a bearer block in Caddyfile.example', () => {
  const caddy = fs.readFileSync(path.join(REPO_ROOT, 'infra', 'Caddyfile.example'), 'utf-8')
  const block = 'handle /api/maps/* {\n\t\treverse_proxy localhost:3001 {\n\t\t\theader_up Authorization "Bearer {env.DASHBOARD_BEARER_TOKEN}"\n\t\t}\n\t}'
  assert.ok(caddy.includes(block), 'infra/Caddyfile.example is missing a bearer-injecting "handle /api/maps/*" block')
  // Ordering matters: Caddy takes the FIRST matching handle, so this block must
  // come before the open fallback or the bearer is never injected.
  assert.ok(caddy.indexOf(block) < caddy.indexOf('handle /api/* {'), 'the /api/maps/* block must appear above the open "handle /api/*" fallback')
})

test('the addon adds no npm dependency of its own', () => {
  for (const f of ['package.json', 'package-lock.json', 'node_modules']) assert.equal(fs.existsSync(path.join(ADDON_DIR, f)), false)
  const files = fs.readdirSync(path.join(ADDON_DIR, 'api'), { recursive: true }).filter((f) => String(f).endsWith('.mjs'))
  for (const f of files) {
    const src = fs.readFileSync(path.join(ADDON_DIR, 'api', String(f)), 'utf-8')
    for (const [, spec] of src.matchAll(/^import .*? from '([^']+)'/gm)) {
      assert.ok(spec.startsWith('node:') || spec.startsWith('.'), `api/${f} imports "${spec}" — an addon may only import node builtins and its own files`)
    }
  }
})

test('the addon is documented the way docs/ADDONS.md asks', () => {
  const readme = fs.readFileSync(path.join(ADDON_DIR, 'README.md'), 'utf-8')
  for (const must of ['What it cannot do', 'What it costs', 'ATLAS_ADDONS', 'scripts/serve.sh restart', 'DASHBOARD_BEARER_TOKEN']) {
    assert.ok(readme.includes(must), `README.md is missing "${must}"`)
  }
  const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'ADDONS.md'), 'utf-8')
  assert.ok(doc.includes('`maps`') || doc.includes('addons/maps'), 'docs/ADDONS.md does not list this addon in its catalog')
})

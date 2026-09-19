/* ------------------------------------------------------------------ *
 * Overpass nearby-places: the query shape, distance sorting, node vs way
 * centers, caching, and honest failure. No network — fetch is stubbed.
 *
 * Run: node --test addons/maps/test/overpass.test.mjs
 * ------------------------------------------------------------------ */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { nearbyPlaces, overpassQuery, haversineKm, _resetCache } from '../api/overpass.mjs'

const HERE = { lat: 48.14, lon: 11.58 }
const ELEMENTS = [
  { type: 'node', lat: 48.141, lon: 11.581, tags: { name: 'Near Fuel' } }, // ~130m
  { type: 'way', center: { lat: 48.20, lon: 11.60 }, tags: { name: 'Far Fuel' } }, // several km
  { type: 'node', lat: 48.1405, lon: 11.5805, tags: {} }, // unnamed, close
]
const okFetch = (calls) => async (url, opts) => {
  calls.push({ url, opts })
  return { ok: true, status: 200, json: async () => ({ elements: ELEMENTS }) }
}

beforeEach(() => _resetCache())

test('haversine: zero for the same point, roughly right for a known pair', () => {
  assert.equal(haversineKm(HERE, HERE), 0)
  // Munich Hauptbahnhof to Munich Airport is ~30-35 km as the crow flies.
  const km = haversineKm(HERE, { lat: 48.35, lon: 11.79 })
  assert.ok(km > 25 && km < 40, `expected ~25-40km, got ${km}`)
})

test('query: tag/value/radius embedded, node and way both searched, center requested', () => {
  const q = overpassQuery({ lat: 48.1, lon: 11.5, tag: 'amenity', value: 'fuel', radiusM: 2000 })
  assert.match(q, /node\["amenity"="fuel"\]\(around:2000,48\.1,11\.5\)/)
  assert.match(q, /way\["amenity"="fuel"\]\(around:2000,48\.1,11\.5\)/)
  assert.match(q, /out center/)
})

test('bad location or unknown category is a reason, not a network call', async () => {
  const calls = []
  const f = okFetch(calls)
  assert.equal((await nearbyPlaces({ lat: 999, lon: 0, category: 'fuel' }, { fetchImpl: f })).ok, false)
  assert.equal((await nearbyPlaces({ lat: 48, lon: 11, category: 'spaceship' }, { fetchImpl: f })).ok, false)
  assert.equal(calls.length, 0)
})

test('nearest first, unnamed places get the category label, POSTed as form-encoded data', async () => {
  const calls = []
  const r = await nearbyPlaces({ lat: HERE.lat, lon: HERE.lon, category: 'fuel' }, { fetchImpl: okFetch(calls), now: 0 })
  assert.equal(r.ok, true)
  assert.equal(r.places[0].name, 'Near Fuel')
  assert.equal(r.places.at(-1).name, 'Far Fuel', 'farthest sorts last')
  assert.ok(r.places.find((p) => p.name === 'fuel station'), 'unnamed element falls back to the category label')
  assert.equal(calls[0].opts.method, 'POST')
  assert.match(calls[0].opts.headers['Content-Type'], /x-www-form-urlencoded/)
  assert.match(calls[0].opts.headers['User-Agent'], /atlas-kit-maps-addon/, 'Overpass answers HTTP 406 without a User-Agent')
  assert.match(decodeURIComponent(calls[0].opts.body), /amenity.*fuel/)
})

test('a way center with no coordinates is skipped rather than crashing', async () => {
  const f = async () => ({ ok: true, status: 200, json: async () => ({ elements: [{ type: 'way', tags: { name: 'Broken' } }] }) })
  const r = await nearbyPlaces({ lat: HERE.lat, lon: HERE.lon, category: 'fuel' }, { fetchImpl: f, now: 0 })
  assert.equal(r.ok, true)
  assert.equal(r.places.length, 0)
})

test('cached within the TTL: repeated "near me" asks cost one upstream call', async () => {
  const calls = []
  const f = okFetch(calls)
  await nearbyPlaces({ lat: HERE.lat, lon: HERE.lon, category: 'coffee' }, { fetchImpl: f, now: 1000 })
  await nearbyPlaces({ lat: HERE.lat, lon: HERE.lon, category: 'coffee' }, { fetchImpl: f, now: 60_000 })
  assert.equal(calls.length, 1)
  await nearbyPlaces({ lat: HERE.lat, lon: HERE.lon, category: 'coffee' }, { fetchImpl: f, now: 1000 + 6 * 60 * 1000 })
  assert.equal(calls.length, 2)
})

test('radius is clamped to [200, 20000]', async () => {
  const calls = []
  const f = okFetch(calls)
  await nearbyPlaces({ lat: HERE.lat, lon: HERE.lon, category: 'fuel', radiusM: 999999 }, { fetchImpl: f, now: 0 })
  assert.match(decodeURIComponent(calls[0].opts.body), /around:20000/)
  await nearbyPlaces({ lat: HERE.lat, lon: HERE.lon, category: 'parking', radiusM: 1 }, { fetchImpl: f, now: 0 })
  assert.match(decodeURIComponent(calls[1].opts.body), /around:200/)
})

test('a down Overpass instance is an answer, not a throw', async () => {
  const r = await nearbyPlaces({ lat: HERE.lat, lon: HERE.lon, category: 'fuel' }, { fetchImpl: async () => ({ ok: false, status: 504 }) })
  assert.equal(r.ok, false)
  assert.match(r.error, /504/)
})

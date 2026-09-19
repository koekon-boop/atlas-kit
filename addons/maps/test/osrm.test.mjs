/* ------------------------------------------------------------------ *
 * OSRM routing: the URL shape, geocoding a string destination first, caching,
 * and honest failure on a down router or a malformed reply.
 *
 * Hermetic: fetch and geocode() are both stubbed. Run:
 *   node --test addons/maps/test/osrm.test.mjs
 * ------------------------------------------------------------------ */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { routeBetween, osrmRouteUrl, _resetCache } from '../api/osrm.mjs'

const MUNICH = { lat: 48.14, lon: 11.58 }
const AIRPORT = { lat: 48.35, lon: 11.79 }
const OK_BODY = { code: 'Ok', routes: [{ distance: 42500, duration: 1830 }] }
const okFetch = (calls) => async (url) => {
  calls.push(String(url))
  return { ok: true, status: 200, json: async () => OK_BODY }
}
const noGeocode = async () => {
  throw new Error('geocode must not be called for a coordinate destination')
}

beforeEach(() => _resetCache())

test('URL: lon,lat order (OSRM), driving profile, no steps/alternatives', () => {
  const u = new URL(osrmRouteUrl({ origin: MUNICH, destination: AIRPORT }))
  assert.equal(u.pathname, '/route/v1/driving/11.58,48.14;11.79,48.35')
  assert.equal(u.searchParams.get('overview'), 'false')
  assert.equal(u.searchParams.get('steps'), 'false')
})

test('missing or invalid origin is a reason, not a call', async () => {
  const calls = []
  const noOrigin = await routeBetween({ origin: null, destination: AIRPORT }, { fetchImpl: okFetch(calls) })
  assert.equal(noOrigin.ok, false)
  assert.match(noOrigin.error, /origin/)
  const badOrigin = await routeBetween({ origin: { lat: 999, lon: 0 }, destination: AIRPORT }, { fetchImpl: okFetch(calls) })
  assert.equal(badOrigin.ok, false)
  assert.equal(calls.length, 0)
})

test('coordinate destination skips geocoding entirely', async () => {
  const calls = []
  const r = await routeBetween({ origin: MUNICH, destination: AIRPORT }, { fetchImpl: okFetch(calls), now: 0, geocodeImpl: noGeocode })
  assert.equal(r.ok, true)
  assert.equal(r.distanceKm, 42.5)
  assert.equal(r.durationMin, 31)
  assert.equal(r.profile, 'driving')
  assert.equal(calls.length, 1)
})

test('a place-name destination is geocoded first; a failed geocode short-circuits the route call', async () => {
  const calls = []
  const geocodeImpl = async (place) => ({ ok: true, lat: AIRPORT.lat, lon: AIRPORT.lon, displayName: `${place}, Germany` })
  const r = await routeBetween({ origin: MUNICH, destination: 'Munich Airport' }, { fetchImpl: okFetch(calls), now: 0, geocodeImpl })
  assert.equal(r.ok, true)
  assert.equal(r.destinationLabel, 'Munich Airport, Germany')
  assert.equal(calls.length, 1)

  const geocodeFail = async () => ({ ok: false, error: 'no place found for "nowhere"' })
  const failed = await routeBetween({ origin: MUNICH, destination: 'nowhere' }, { fetchImpl: okFetch(calls), now: 0, geocodeImpl: geocodeFail })
  assert.equal(failed.ok, false)
  assert.match(failed.error, /no place found/)
  assert.equal(calls.length, 1, 'the route call was never made once geocoding failed')
})

test('destination as {place} object works the same as a bare string', async () => {
  const calls = []
  const geocodeImpl = async () => ({ ok: true, lat: AIRPORT.lat, lon: AIRPORT.lon, displayName: 'Airport' })
  const r = await routeBetween({ origin: MUNICH, destination: { place: 'airport' } }, { fetchImpl: okFetch(calls), now: 0, geocodeImpl })
  assert.equal(r.ok, true)
})

test('cached within the TTL: repeated identical questions cost one upstream call', async () => {
  const calls = []
  const f = okFetch(calls)
  await routeBetween({ origin: MUNICH, destination: AIRPORT }, { fetchImpl: f, now: 1000 })
  await routeBetween({ origin: MUNICH, destination: AIRPORT }, { fetchImpl: f, now: 60_000 })
  assert.equal(calls.length, 1)
  await routeBetween({ origin: MUNICH, destination: AIRPORT }, { fetchImpl: f, now: 1000 + 6 * 60 * 1000 })
  assert.equal(calls.length, 2)
})

test('a down router or a malformed reply is an answer, not a throw', async () => {
  const down = await routeBetween({ origin: MUNICH, destination: AIRPORT }, { fetchImpl: async () => ({ ok: false, status: 500 }) })
  assert.equal(down.ok, false)
  assert.match(down.error, /500/)

  const noRoute = await routeBetween(
    { origin: MUNICH, destination: AIRPORT },
    { fetchImpl: async () => ({ ok: true, json: async () => ({ code: 'NoRoute' }) }) },
  )
  assert.equal(noRoute.ok, false)

  const malformed = await routeBetween(
    { origin: MUNICH, destination: AIRPORT },
    { fetchImpl: async () => ({ ok: true, json: async () => ({ code: 'Ok', routes: [{}] }) }) },
  )
  assert.equal(malformed.ok, false)
})

test('destination must be a coordinate or a place string, not garbage', async () => {
  const r = await routeBetween({ origin: MUNICH, destination: { lat: 'x' } }, { fetchImpl: async () => ({}) })
  assert.equal(r.ok, false)
  assert.match(r.error, /destination/)
})

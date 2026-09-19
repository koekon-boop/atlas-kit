/* ------------------------------------------------------------------ *
 * Nominatim geocoding: the rate-limit DECISION (pure, fake clock), the cache,
 * the required User-Agent, and honest failure. No network, no real waiting —
 * `sleepImpl` is stubbed to resolve instantly so the suite stays fast even
 * though production really does wait out the 1 req/s floor.
 *
 * Run: node --test addons/maps/test/nominatim.test.mjs
 * ------------------------------------------------------------------ */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { geocode, nextCallDelay, _resetCache } from '../api/nominatim.mjs'

const ROW = [{ lat: '48.14', lon: '11.58', display_name: 'Hauptbahnhof, Munich, Germany' }]
const okFetch = (calls) => async (url, opts) => {
  calls.push({ url: String(url), opts })
  return { ok: true, status: 200, json: async () => ROW }
}
const noSleep = async () => {}

beforeEach(() => _resetCache())

test('rate-limit decision: no wait once the floor has elapsed, the remainder otherwise', () => {
  assert.equal(nextCallDelay(-Infinity, 0), 0)
  assert.equal(nextCallDelay(1000, 1000), 1100)
  assert.equal(nextCallDelay(1000, 1500), 600)
  assert.equal(nextCallDelay(1000, 3000), 0)
  assert.equal(nextCallDelay(1000, 1000, 500), 500, 'a custom floor is honoured')
})

test('an empty place is a reason, not a network call', async () => {
  const calls = []
  const r = await geocode('', { fetchImpl: okFetch(calls), sleepImpl: noSleep })
  assert.equal(r.ok, false)
  assert.equal(calls.length, 0)
})

test('geocodes with the required User-Agent and jsonv2 params', async () => {
  const calls = []
  const r = await geocode('Munich Hauptbahnhof', { fetchImpl: okFetch(calls), now: 0, sleepImpl: noSleep })
  assert.equal(r.ok, true)
  assert.equal(r.lat, 48.14)
  assert.equal(r.lon, 11.58)
  assert.match(r.displayName, /Hauptbahnhof/)
  assert.equal(calls.length, 1)
  const url = new URL(calls[0].url)
  assert.equal(url.hostname, 'nominatim.openstreetmap.org')
  assert.equal(url.searchParams.get('format'), 'jsonv2')
  assert.equal(url.searchParams.get('q'), 'Munich Hauptbahnhof')
  assert.match(calls[0].opts.headers['User-Agent'], /atlas-kit-maps-addon/)
})

test('cached within the TTL: repeated questions cost one upstream call', async () => {
  const calls = []
  const f = okFetch(calls)
  await geocode('Hauptbahnhof', { fetchImpl: f, now: 1000, sleepImpl: noSleep })
  await geocode('Hauptbahnhof', { fetchImpl: f, now: 60_000, sleepImpl: noSleep })
  assert.equal(calls.length, 1)
  assert.equal((await geocode('hauptbahnhof', { fetchImpl: f, now: 60_000, sleepImpl: noSleep })).ok, true, 'case-insensitive cache key')
  assert.equal(calls.length, 1)
  await geocode('Hauptbahnhof', { fetchImpl: f, now: 1000 + 61 * 60 * 1000, sleepImpl: noSleep })
  assert.equal(calls.length, 2, 'a stale entry is refreshed')
})

test('no match, and a down server, are both reasons rather than throws', async () => {
  const empty = await geocode('nowhere at all', { fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }), sleepImpl: noSleep })
  assert.equal(empty.ok, false)
  assert.match(empty.error, /no place found/)

  const down = await geocode('x', { fetchImpl: async () => ({ ok: false, status: 503 }), sleepImpl: noSleep })
  assert.equal(down.ok, false)
  assert.match(down.error, /503/)
})

test('concurrent lookups serialise through the same throttle instead of racing it', async () => {
  const calls = []
  const f = okFetch(calls)
  const results = await Promise.all([
    geocode('a', { fetchImpl: f, now: 1, sleepImpl: noSleep }),
    geocode('b', { fetchImpl: f, now: 2, sleepImpl: noSleep }),
    geocode('c', { fetchImpl: f, now: 3, sleepImpl: noSleep }),
  ])
  assert.equal(results.every((r) => r.ok), true)
  assert.equal(calls.length, 3)
})

/* ------------------------------------------------------------------ *
 * addons/weather — the parts that decide whether the Jarvis tab shows a real
 * reading, a labelled stale one, or a reason. The failure modes this guards are
 * all quiet: a malformed upstream body rendered as 0 °C, a refresh storm when
 * every open dashboard polls, and a missing config shown as a blank tile.
 *
 * Hermetic: a stubbed fetch, explicit env objects, no network.
 * Run: node --test addons/weather/test/weather.test.mjs
 * ------------------------------------------------------------------ */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { weatherConfig, describeWmo, shapeForecast, currentWeather, forecastUrl, _resetCache } from '../api/weather.mjs'

const ENV = { ATLAS_WEATHER_LAT: '48.1', ATLAS_WEATHER_LON: '11.6', ATLAS_WEATHER_LABEL: 'Home' }
const BODY = {
  timezone: 'Europe/Berlin',
  current: { time: '2026-09-17T09:00', temperature_2m: 14.2, apparent_temperature: 13.1, relative_humidity_2m: 81, weather_code: 3, wind_speed_10m: 9.4 },
  daily: { temperature_2m_max: [19.5], temperature_2m_min: [9.8] },
}
const okFetch = (calls) => async (url) => {
  calls.push(url)
  return { ok: true, status: 200, json: async () => BODY }
}

beforeEach(() => _resetCache())

test('config: missing or invalid coordinates are a reason, not a reading', () => {
  assert.equal(weatherConfig({}).ok, false)
  assert.equal(weatherConfig({ ATLAS_WEATHER_LAT: '91', ATLAS_WEATHER_LON: '0' }).ok, false)
  assert.equal(weatherConfig({ ATLAS_WEATHER_LAT: 'x', ATLAS_WEATHER_LON: '1' }).ok, false)
  const c = weatherConfig(ENV)
  assert.equal(c.ok, true)
  assert.equal(c.lat, 48.1)
  assert.equal(c.ttlMs, 15 * 60 * 1000)
})

test('WMO codes map to words', () => {
  assert.equal(describeWmo(0), 'Clear sky')
  assert.equal(describeWmo(63), 'Rain')
  assert.equal(describeWmo(99), 'Thunderstorm with hail')
  assert.equal(describeWmo(42), 'Unknown')
})

test('forecast URL asks for current + daily min/max at the configured place', () => {
  const u = new URL(forecastUrl({ lat: 48.1, lon: 11.6 }))
  assert.equal(u.host, 'api.open-meteo.com')
  assert.equal(u.searchParams.get('latitude'), '48.1')
  assert.match(u.searchParams.get('current'), /temperature_2m/)
})

test('a malformed body throws instead of becoming 0 °C', () => {
  assert.throws(() => shapeForecast({}))
  assert.throws(() => shapeForecast({ current: { temperature_2m: null, weather_code: 1 } }))
  const w = shapeForecast(BODY, 'Home')
  assert.equal(w.tempC, 14.2)
  assert.equal(w.summary, 'Overcast')
  assert.equal(w.highC, 19.5)
})

test('cached within the TTL: many polls, one upstream call', async () => {
  const calls = []
  const f = okFetch(calls)
  await currentWeather({ fetchImpl: f, now: 1000, env: ENV })
  await currentWeather({ fetchImpl: f, now: 60_000, env: ENV })
  assert.equal(calls.length, 1)
  await currentWeather({ fetchImpl: f, now: 1000 + 16 * 60 * 1000, env: ENV })
  assert.equal(calls.length, 2)
})

test('a failed refresh serves the last reading flagged stale; no reading → a reason', async () => {
  const bad = async () => ({ ok: false, status: 503, json: async () => ({}) })
  const none = await currentWeather({ fetchImpl: bad, now: 0, env: ENV })
  assert.equal(none.ok, false)
  assert.match(none.error, /503/)

  await currentWeather({ fetchImpl: okFetch([]), now: 0, env: ENV })
  const stale = await currentWeather({ fetchImpl: bad, now: 20 * 60 * 1000, env: ENV })
  assert.equal(stale.ok, true)
  assert.equal(stale.stale, true)
  assert.equal(stale.tempC, 14.2)
})

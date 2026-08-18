/* ------------------------------------------------------------------ *
 * Guards the one place that knows what Duffel's wire format looks like — and
 * every way it can fail to answer.
 *
 * 🔴 NO NETWORK. The adapter takes `fetchImpl`, so the "HTTP" here is a function
 * over `test/fixtures/duffel-offer-request.json`. That is not a convenience: an
 * adapter that can only be exercised by spending a supplier call is an adapter
 * nobody exercises, and this suite has to pass on a CI runner with no token —
 * which is also the state of the box it was written on.
 *
 * The degradation cases carry as much weight as the happy path. No token, 401,
 * a body that is not JSON, a timeout — every one has to be `{ ok: false, error }`
 * with a sentence an operator can act on, and none of them may throw.
 * Run: node --test addons/flight-search/test/duffel.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { duffelAdapter, duffelPassengers, normalizeAirport, normalizeOffer, offerRequestBody } = await import('../api/adapters/duffel.mjs')
const { adapterStatus, configuredAdapters, loadAdapters } = await import('../api/adapters/index.mjs')
const { offersResponse, rawOfferRequest, stubFetch } = await import('./fixtures/duffel.mjs')

const TOKEN = { DUFFEL_API_TOKEN: 'duffel_test_notARealToken' }
const offers = () => rawOfferRequest().data.offers

test('an airport carries its IANA zone and its CITY code through unchanged', () => {
  const seg = offers()[0].slices[0].segments[1]
  assert.deepEqual(normalizeAirport(seg.destination, seg.destination_terminal), {
    iata: 'HND',
    name: 'Haneda Airport',
    cityCode: 'TYO', // ← what tells HND and NRT apart from a different city
    cityName: 'Tokyo',
    timeZone: 'Asia/Tokyo', // ← what makes the wall clocks arithmetic
    terminal: '3',
  })
  // A source that sends nothing must not invent anything.
  assert.deepEqual(normalizeAirport(undefined, undefined), { iata: '', name: '', cityCode: '', cityName: '', timeZone: '', terminal: '' })
})

test('a Duffel offer becomes the neutral Ticket shape, string amounts and all', () => {
  const t = normalizeOffer(offers()[0])
  assert.equal(t.source, 'duffel')
  assert.equal(t.id, 'off_0000AoneTicketTK')
  assert.deepEqual(t.price, { total: 782.4, currency: 'EUR', base: 610, tax: 172.4 })
  assert.deepEqual(t.owner, { iata: 'TK', name: 'Turkish Airlines' })
  assert.equal(t.emissionsKg, 1104)
  assert.deepEqual(t.conditions.changeable, true)
  assert.deepEqual(t.conditions.refundable, false)
  assert.deepEqual(t.conditions.change, { allowed: true, penalty: 120, currency: 'EUR' })

  assert.equal(t.journeys.length, 1)
  const [s1, s2] = t.journeys[0].segments
  assert.equal(t.journeys[0].durationMinutes, 1270) // PT21H10M
  assert.equal(s1.flightNumber, 'TK1728')
  assert.equal(s1.departingAt, '2026-10-15T09:35:00') // LOCAL, no offset — carried verbatim
  assert.equal(s1.durationMinutes, 210)
  assert.equal(s1.aircraft, 'Airbus A321')
  assert.equal(s1.cabinName, 'Economy')
  assert.deepEqual(s1.baggage, { carryOn: 1, checked: 1 })
  assert.equal(s2.origin.iata, 'IST')
  assert.equal(s2.destination.timeZone, 'Asia/Tokyo')
})

test('the BINDING baggage allowance is the smallest one on any leg', () => {
  const raw = rawOfferRequest().data.offers[0]
  raw.slices[0].segments[1].passengers[0].baggages = [{ type: 'checked', quantity: 0 }]
  // Free to Istanbul and chargeable onward is a bag you pay for.
  assert.deepEqual(normalizeOffer(raw).baggage, { carryOn: 0, checked: 0 })
})

test('the baggage enum is accepted in both spellings Duffel\'s own docs use', () => {
  // Offer 2 writes it "carry-on"; offer 1 writes it "carry_on".
  assert.deepEqual(normalizeOffer(offers()[1]).baggage, { carryOn: 1, checked: 2 })
})

test('a PARTIAL offer is refused — it is half a search flow, not something you can buy', () => {
  assert.equal(normalizeOffer(offers()[2]), null)
  assert.equal(normalizeOffer({ id: 'x', slices: [] }), null)
  assert.equal(normalizeOffer(null), null)
})

test('a segment with no stated duration falls back to INSTANT maths, not to string subtraction', () => {
  const raw = rawOfferRequest().data.offers[1] // BER 11:00 → HND 05:45+1, nonstop
  delete raw.slices[0].segments[0].duration
  // 11:00 Berlin (09:00Z) → 05:45+1 Tokyo (20:45Z) = 11h45. A naive difference
  // of the two strings would say 18h45.
  assert.equal(normalizeOffer(raw).journeys[0].segments[0].durationMinutes, 705)
})

test('the request body is the mapping Duffel documents, and the source-side filters are pushed down', () => {
  const body = offerRequestBody({
    slices: [
      { origin: 'BER', destination: 'HND', departureDate: '2026-10-15', departureTime: { from: '06:00', to: '12:00' } },
      { origin: 'HND', destination: 'BER', departureDate: '2026-10-25', arrivalTime: { from: '06:00', to: '23:00' } },
    ],
    passengers: { adults: 2, childAges: [7] },
    cabin: 'business',
    maxConnections: 1,
    allowSourceSplit: true,
  })
  assert.deepEqual(body.data.slices[0], { origin: 'BER', destination: 'HND', departure_date: '2026-10-15', departure_time: { from: '06:00', to: '12:00' } })
  assert.deepEqual(body.data.slices[1], { origin: 'HND', destination: 'BER', departure_date: '2026-10-25', arrival_time: { from: '06:00', to: '23:00' } })
  assert.deepEqual(body.data.passengers, [{ type: 'adult' }, { type: 'adult' }, { age: 7 }])
  assert.equal(body.data.cabin_class, 'business')
  assert.equal(body.data.max_connections, 1)
  assert.equal(body.data.include_split_ticket, true)
  // max_connections is clamped to what Duffel accepts rather than passed through.
  assert.equal(offerRequestBody({ slices: [{ origin: 'A', destination: 'B' }], maxConnections: 9 }).data.max_connections, 2)
  assert.equal(offerRequestBody({ slices: [{ origin: 'A', destination: 'B' }] }).data.include_split_ticket, undefined)
})

test('passengers are adults and explicit ages — nothing is guessed', () => {
  assert.deepEqual(duffelPassengers({}), [{ type: 'adult' }])
  assert.deepEqual(duffelPassengers({ adults: 0 }), [{ type: 'adult' }]) // somebody has to fly
  assert.deepEqual(duffelPassengers({ adults: 2, childAges: [4, 11, 'x', 42] }), [{ type: 'adult' }, { type: 'adult' }, { age: 4 }, { age: 11 }])
})

test('NO TOKEN: the adapter reports itself unconfigured and refuses to call anything', async () => {
  let called = false
  const a = duffelAdapter({ env: {}, fetchImpl: () => { called = true } })
  assert.deepEqual(a.status(), { configured: false, reason: 'DUFFEL_API_TOKEN is not set' })
  const r = await a.search({ slices: [{ origin: 'BER', destination: 'HND', departureDate: '2026-10-15' }] })
  assert.deepEqual(r, { ok: false, tickets: [], error: 'DUFFEL_API_TOKEN is not set' })
  assert.equal(called, false, 'an unconfigured adapter must not reach the network')
})

test('status() reports the token MODE and never the token', () => {
  assert.equal(duffelAdapter({ env: { DUFFEL_API_TOKEN: 'duffel_test_x' } }).status().mode, 'test')
  assert.equal(duffelAdapter({ env: { DUFFEL_API_TOKEN: 'duffel_live_x' } }).status().mode, 'live')
  assert.equal(duffelAdapter({ env: { DUFFEL_API_TOKEN: 'something-else' } }).status().mode, 'unknown')
  const s = JSON.stringify(duffelAdapter({ env: { DUFFEL_API_TOKEN: 'duffel_test_SECRET' } }).status())
  assert.ok(!s.includes('SECRET'), `the token leaked into status(): ${s}`)
})

test('a search sends the headers Duffel requires and returns bookable tickets only', async () => {
  const fetchImpl = stubFetch({ 'BER-HND': offers() })
  const a = duffelAdapter({ env: TOKEN, fetchImpl })
  const r = await a.search({ slices: [{ origin: 'BER', destination: 'HND', departureDate: '2026-10-15' }], passengers: { adults: 1 } })
  assert.equal(r.ok, true)
  assert.equal(r.offersSeen, 3)
  assert.equal(r.tickets.length, 2) // the partial one is not a ticket
  assert.deepEqual(r.tickets.map((t) => t.id), ['off_0000AoneTicketTK', 'off_0000AnonstopJL'])

  const call = fetchImpl.calls[0]
  assert.match(call.url, /^https:\/\/api\.duffel\.com\/air\/offer_requests\?return_offers=true&supplier_timeout=\d+$/)
  assert.equal(call.headers['Duffel-Version'], 'v2')
  assert.equal(call.headers.Authorization, 'Bearer duffel_test_notARealToken')
  assert.equal(call.headers.Accept, 'application/json')
})

test('every failure is an answer with a reason, and none of them throws', async () => {
  const cases = [
    [() => new Response(JSON.stringify({ errors: [{ title: 'Unauthorized', message: 'The access token is invalid' }] }), { status: 401 }), /Duffel HTTP 401: Unauthorized — The access token is invalid/],
    [() => new Response('<html>502 Bad Gateway</html>', { status: 502 }), /Duffel answered HTTP 502 with a body that is not JSON/],
    [() => new Response(JSON.stringify({ errors: [{ title: 'Rate limit exceeded' }] }), { status: 429 }), /Duffel HTTP 429: Rate limit exceeded/],
    [() => { throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }) }, /no answer within \d+ ms/],
    [() => { throw new Error('fetch failed') }, /Duffel request failed: fetch failed/],
  ]
  for (const [answer, re] of cases) {
    const a = duffelAdapter({ env: TOKEN, fetchImpl: stubFetch({ 'BER-HND': answer }) })
    const r = await a.search({ slices: [{ origin: 'BER', destination: 'HND', departureDate: '2026-10-15' }] })
    assert.equal(r.ok, false)
    assert.deepEqual(r.tickets, [])
    assert.match(r.error, re)
  }
})

test('a well-formed answer with no offers is a SUCCESS with nothing in it', async () => {
  const a = duffelAdapter({ env: TOKEN, fetchImpl: stubFetch({ 'BTS-MRU': [] }) })
  const r = await a.search({ slices: [{ origin: 'BTS', destination: 'MRU', departureDate: '2026-10-15' }] })
  // "did not run" and "ran and found nothing" are different facts, and both the
  // registry and the answer have to be able to tell them apart.
  assert.deepEqual({ ok: r.ok, tickets: r.tickets, offersSeen: r.offersSeen }, { ok: true, tickets: [], offersSeen: 0 })
})

test('the registry keeps an unconfigured source VISIBLE rather than dropping it', () => {
  const adapters = loadAdapters({ env: {} })
  assert.deepEqual(adapters.map((a) => a.name), ['duffel'])
  assert.deepEqual(adapterStatus(adapters), [{ name: 'duffel', label: 'Duffel (api.duffel.com)', configured: false, reason: 'DUFFEL_API_TOKEN is not set' }])
  assert.deepEqual(configuredAdapters(adapters), [])
  assert.equal(configuredAdapters(loadAdapters({ env: TOKEN })).length, 1)
})

test('a source whose status() throws is reported, not propagated', () => {
  const broken = { name: 'broken', label: 'Broken', status: () => { throw new Error('kaboom') } }
  assert.deepEqual(adapterStatus([broken]), [{ name: 'broken', configured: false, reason: 'status failed: kaboom' }])
  assert.deepEqual(configuredAdapters([broken]), [])
})

test('offersResponse is the shape the adapter reads, so the fixture cannot drift from it', async () => {
  const a = duffelAdapter({ env: TOKEN, fetchImpl: async () => new Response(JSON.stringify(offersResponse([])), { status: 200 }) })
  assert.equal((await a.search({ slices: [{ origin: 'A', destination: 'B' }] })).ok, true)
})

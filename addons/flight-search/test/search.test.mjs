/* ------------------------------------------------------------------ *
 * The whole pipeline, end to end, with no network: normalise → grid → adapters
 * → assemble → hard filters → score → Pareto front → the answer a model reads.
 *
 * The adapter is a PARAMETER, which is the only reason this test can exist —
 * and the reason it is worth writing: the interesting behaviour is not in any
 * one stage but in what survives all of them. A split ticket that is 280 EUR
 * cheaper and infeasible by twenty minutes has to leave here as a counted
 * rejection, not as the recommendation.
 *
 * THE UNCONFIGURED PATH IS A FIRST-CLASS CASE. This box has no DUFFEL_API_TOKEN
 * and most boxes never will, so "no source" must be a clear, actionable ANSWER
 * that spends nothing — asserted here as carefully as a successful search.
 * Run: node --test addons/flight-search/test/search.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { normalizeRequest, searchFlights } = await import('../api/search.mjs')
const { offer, segment, stubAdapter, tickets } = await import('./fixtures/duffel.mjs')

const THROUGH = offer({
  id: 'off_through',
  amount: 782.4,
  emissions: 1104,
  slices: [[
    segment({ from: 'BER', to: 'IST', depart: '2026-10-15T09:35:00', arrive: '2026-10-15T14:05:00', minutes: 210, checked: 1 }),
    segment({ from: 'IST', to: 'HND', depart: '2026-10-15T20:15:00', arrive: '2026-10-16T13:45:00', minutes: 690, checked: 1, number: '198' }),
  ]],
})
const NONSTOP = offer({
  id: 'off_nonstop',
  amount: 1240,
  owner: 'JL',
  emissions: 980,
  slices: [[segment({ from: 'BER', to: 'HND', depart: '2026-10-15T11:00:00', arrive: '2026-10-16T05:45:00', minutes: 705, carrier: 'JL', checked: 2, number: '408' })]],
})
const HEAD = offer({ id: 'off_head', amount: 260, slices: [[segment({ from: 'BER', to: 'IST', depart: '2026-10-15T09:35:00', arrive: '2026-10-15T14:05:00', minutes: 210 })]] })
const TAIL = offer({ id: 'off_tail', amount: 240, owner: 'PC', slices: [[segment({ from: 'IST', to: 'HND', depart: '2026-10-15T20:15:00', arrive: '2026-10-16T13:45:00', minutes: 690, carrier: 'PC', number: '620' })]] })
/** Leaves IST 100 minutes after the head lands: legal on one ticket, not on two. */
const TAIL_TIGHT = offer({ id: 'off_tail_tight', amount: 150, owner: 'PC', slices: [[segment({ from: 'IST', to: 'HND', depart: '2026-10-15T15:45:00', arrive: '2026-10-16T09:15:00', minutes: 690, carrier: 'PC', number: '622' })]] })

const ask = (over = {}) => ({ origin: 'BER', destination: 'HND', departureDate: '2026-10-15', via: ['IST'], maxAdapterCalls: 4, ...over })

async function adapters(routes) {
  const resolved = {}
  for (const [k, v] of Object.entries(routes)) resolved[k] = typeof v === 'function' ? v : await tickets(...v)
  return [stubAdapter(resolved)]
}

/* --- 1. the request is a trust boundary ---------------------------------- */

test('a request that cannot be used is refused BEFORE anything is spent', async () => {
  const a = await adapters({})
  const r = await searchFlights({ origin: 'Berlin', destination: '', departureDate: '15.10.2026' }, { adapters: a })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'the request could not be used as given')
  assert.deepEqual(r.problems, [
    'origin: "BERLIN" is not a 3-letter IATA airport code',
    'origin is required',
    'destination is required',
    'departureDate is required, as YYYY-MM-DD',
  ])
  assert.deepEqual(r.options, [])
  assert.equal(a[0].calls.length, 0)
})

test('an absent ceiling stays absent — Number(null) is 0 and would reject everything', () => {
  const { request } = normalizeRequest({ origin: 'BER', destination: 'HND', departureDate: '2026-10-15', maxPrice: null, maxStops: undefined, maxTravelHours: '' })
  assert.deepEqual({ maxPrice: request.filters.maxPrice, maxStops: request.filters.maxStops, maxTravelMinutes: request.filters.maxTravelMinutes }, { maxPrice: null, maxStops: null, maxTravelMinutes: null })
  assert.equal(normalizeRequest({ origin: 'BER', destination: 'HND', departureDate: '2026-10-15', maxPrice: 0 }).request.filters.maxPrice, 0)
})

test('a connection floor can be RAISED by the caller and never lowered', () => {
  const raised = normalizeRequest({ origin: 'BER', destination: 'HND', departureDate: '2026-10-15', minConnectionMinutes: 300 }).request.rules
  assert.deepEqual([raised.sameTicket, raised.selfTransfer, raised.airportChange], [300, 300, 300])
  const lowered = normalizeRequest({ origin: 'BER', destination: 'HND', departureDate: '2026-10-15', minConnectionMinutes: 10 }).request.rules
  assert.deepEqual([lowered.sameTicket, lowered.selfTransfer, lowered.airportChange], [45, 150, 240])
})

test('a flexible stay length with nothing to anchor it is an error, not a silent no-op', () => {
  const { errors } = normalizeRequest({ origin: 'BER', destination: 'HND', departureDate: '2026-10-15', tripDayRange: [10, 14] })
  assert.deepEqual(errors, ['tripDayRange needs a returnDate to anchor the round trip'])
})

/* --- 2. no source configured — this box's actual state -------------------- */

test('NO SOURCE CONFIGURED: an answer that tells the operator what to do, and spends nothing', async () => {
  const dead = stubAdapter({}, { configured: false })
  const r = await searchFlights(ask(), { adapters: [dead] })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no flight source is configured on this box, so no search was run')
  assert.deepEqual(r.sources, [{ name: 'stub', label: 'stub (stub)', configured: false, reason: 'no token in the stub' }])
  assert.match(r.howToEnable, /DUFFEL_API_TOKEN=duffel_test_/)
  assert.match(r.howToEnable, /app\.duffel\.com\/join/)
  assert.match(r.howToEnable, /scripts\/serve\.sh restart/)
  assert.deepEqual(r.options, [])
  assert.equal(dead.calls.length, 0)
  // It must be answerable, i.e. actually serialisable back to a model.
  assert.ok(JSON.stringify(r).length > 200)
})

/* --- 3. a real search ----------------------------------------------------- */

test('a split ticket, a through fare and a nonstop come back as a PARETO FRONT with reasons', async () => {
  const a = await adapters({ 'BER-HND': [THROUGH, NONSTOP], 'BER-IST': [HEAD], 'IST-HND': [TAIL] })
  const r = await searchFlights(ask(), { adapters: a })
  assert.equal(r.ok, true)

  // The budget: one whole-trip search plus the two halves of one split.
  assert.equal(r.search.adapterCalls, 3)
  assert.deepEqual(a[0].calls.map((c) => c.key), ['BER-HND', 'BER-IST', 'IST-HND'])
  assert.equal(r.search.ticketsSeen, 4)
  assert.equal(r.considered.itinerariesBuilt, 3)
  assert.equal(r.considered.passedHardFilters, 3)

  const byPrice = [...r.options].sort((x, y) => x.price.total - y.price.total)
  assert.equal(byPrice[0].price.total, 500) // the split: 260 + 240
  assert.equal(byPrice[0].tickets.count, 2)
  assert.equal(byPrice[0].tickets.selfTransfers, 1)
  assert.ok(byPrice[0].wins.includes('cheapest'))
  assert.match(byPrice[0].tradeoffs.join(' | '), /no airline owes you a rebooking/)
  assert.match(byPrice[0].journeys[0].connections[0].note, /SELF-TRANSFER/)
  assert.equal(byPrice[0].booking.tickets.length, 2)
  assert.match(byPrice[0].booking.how, /2 SEPARATE orders/)

  const fastest = r.options.find((o) => o.wins.includes('fastest door to door'))
  assert.equal(fastest.stops, 0)
  assert.equal(fastest.travel.total, '11h 45m')

  const single = r.options.find((o) => o.tickets.single)
  assert.match(single.booking.how, /ordered through its API/)
  assert.ok(single.booking.tickets[0].verifyUrl.startsWith('https://www.google.com/travel/flights?q='))

  // Every option is self-describing: a model must not need the raw data.
  for (const o of r.options) {
    assert.ok(o.summary.includes(o.price.currency))
    assert.ok(o.why.length > 10)
    assert.ok(Array.isArray(o.tradeoffs))
    assert.ok(o.journeys[0].segments.every((s) => /^[A-Z]{2}\d+ [A-Z]{3}/.test(s)), o.journeys[0].segments.join(' / '))
  }
  assert.match(r.scoring.note, /LOWER IS BETTER/)
  // Each option says which point of the grid produced it.
  assert.equal(r.options.find((o) => o.tickets.count === 2).foundBy, 'self-transfer combination')
  assert.equal(r.options.find((o) => o.tickets.single).foundBy, 'exactly as asked')
})

test('an INFEASIBLE split is a counted rejection, never the recommendation', async () => {
  const a = await adapters({ 'BER-HND': [THROUGH], 'BER-IST': [HEAD], 'IST-HND': [TAIL_TIGHT] })
  const r = await searchFlights(ask(), { adapters: a })
  // 410 EUR would have won on price by a mile — and it is 100 minutes at IST on
  // two tickets, which is not a connection, so it does not exist.
  assert.equal(r.options.length, 1)
  assert.equal(r.options[0].price.total, 782.4)
  const rejection = r.rejected.find((x) => /under the 150 min floor for a self-transfer/.test(x.reason))
  assert.ok(rejection, `expected the tight split to be reported: ${JSON.stringify(r.rejected)}`)
  assert.equal(rejection.count, 1)
})

test('a hard filter reports HOW MANY it dropped, so a thin answer explains itself', async () => {
  const a = await adapters({ 'BER-HND': [THROUGH, NONSTOP], 'BER-IST': [HEAD], 'IST-HND': [TAIL] })
  const r = await searchFlights(ask({ noArrivalAfter: '12:00' }), { adapters: a })
  assert.equal(r.considered.itinerariesBuilt, 3)
  assert.equal(r.considered.passedHardFilters, 1) // only the 05:45 nonstop lands before noon
  assert.equal(r.options[0].stops, 0)
  assert.equal(r.rejected.find((x) => /arrives at 13:45/.test(x.reason)).count, 2)
})

test('requireSingleTicket removes the split from the search, not just from the answer', async () => {
  const a = await adapters({ 'BER-HND': [THROUGH, NONSTOP], 'BER-IST': [HEAD], 'IST-HND': [TAIL] })
  const r = await searchFlights(ask({ requireSingleTicket: true }), { adapters: a })
  assert.ok(r.options.every((o) => o.tickets.single))
  assert.match(r.rejected[0].reason, /separate tickets, and one ticket was required/)
})

test('the checked bag the traveller asked for is IN the price, per ticket', async () => {
  const a = await adapters({ 'BER-HND': [THROUGH], 'BER-IST': [HEAD], 'IST-HND': [TAIL] })
  const r = await searchFlights(ask({ checkedBags: 1 }), { adapters: a })
  const split = r.options.find((o) => o.tickets.count === 2)
  // 500 of fare, plus an estimated 55 on EACH hand-baggage-only one-way — which
  // is what turns a 282 EUR "saving" into a 172 EUR one.
  assert.equal(split.price.fare, 500)
  assert.equal(split.price.estimatedBagFees, 110)
  assert.equal(split.price.total, 610)
  assert.match(split.price.note, /ESTIMATED 110 EUR for 2 checked bag\(s\)/)
  // The through fare already includes it and pays nothing extra.
  const through = r.options.find((o) => o.tickets.count === 1)
  assert.equal(through.price.estimatedBagFees, 0)
  assert.match(through.price.note, /fare includes the requested baggage/)
})

test('ground time to a further-out airport is counted against it', async () => {
  const NRT = offer({ id: 'off_nrt', amount: 700, slices: [[segment({ from: 'BER', to: 'NRT', depart: '2026-10-15T11:00:00', arrive: '2026-10-16T05:45:00', minutes: 705, number: '900' })]] })
  const a = await adapters({ 'BER-HND': [NONSTOP], 'BER-NRT': [NRT] })
  const r = await searchFlights({ origin: 'BER', destination: ['HND', { code: 'NRT', groundMinutes: 90 }], departureDate: '2026-10-15', allowSplitTickets: false, maxAdapterCalls: 2 }, { adapters: a })
  const viaNrt = r.options.find((o) => o.journeys[0].route.endsWith('NRT'))
  assert.equal(viaNrt.travel.groundAccessMinutes, 90)
  assert.equal(viaNrt.travel.total, '13h 15m') // 11h45 in the air, 90 min on the ground
  const viaHnd = r.options.find((o) => o.journeys[0].route.endsWith('HND'))
  assert.equal(viaHnd.travel.total, '11h 45m')
})

test('a source error is reported, and the search still answers from what did come back', async () => {
  const a = await adapters({ 'BER-HND': [THROUGH], 'BER-IST': () => ({ ok: false, tickets: [], error: 'Duffel HTTP 429: Rate limit exceeded' }), 'IST-HND': [TAIL] })
  const r = await searchFlights(ask(), { adapters: a })
  assert.equal(r.ok, true)
  assert.equal(r.search.errors.length, 1)
  assert.match(r.search.errors[0].error, /429/)
  assert.equal(r.options.length, 1) // the through fare survived
})

test('a search that finds nothing says so rather than pretending it looked everywhere', async () => {
  const a = await adapters({})
  const r = await searchFlights(ask({ dateFlexDays: 3, maxAdapterCalls: 3 }), { adapters: a })
  assert.equal(r.ok, true)
  assert.equal(r.considered.itinerariesBuilt, 0)
  assert.deepEqual(r.options, [])
  assert.ok(r.notes.some((n) => /Nothing survived/.test(n)))
  assert.ok(r.notes.some((n) => /dropped to stay inside the 3-call budget/.test(n)))
  assert.equal(r.search.gridDropped > 0, true)
})

test('a ROUND TRIP can carry a split in one direction and a plain one-way home', async () => {
  const HOME = offer({ id: 'off_home', amount: 300, owner: 'JL', slices: [[segment({ from: 'HND', to: 'BER', depart: '2026-10-25T10:00:00', arrive: '2026-10-25T18:30:00', minutes: 870, carrier: 'JL', number: '407' })]] })
  const RETURN = offer({
    id: 'off_return',
    amount: 1100,
    slices: [
      [segment({ from: 'BER', to: 'HND', depart: '2026-10-15T11:00:00', arrive: '2026-10-16T05:45:00', minutes: 705, number: '408' })],
      [segment({ from: 'HND', to: 'BER', depart: '2026-10-25T10:00:00', arrive: '2026-10-25T18:30:00', minutes: 870, number: '409' })],
    ],
  })
  const a = await adapters({ 'BER-HND': [RETURN, HEAD_TO_HND()], 'HND-BER': [HOME], 'BER-IST': [HEAD], 'IST-HND': [TAIL] })
  const r = await searchFlights({ origin: 'BER', destination: 'HND', departureDate: '2026-10-15', returnDate: '2026-10-25', via: ['IST'], maxAdapterCalls: 8 }, { adapters: a })
  assert.equal(r.ok, true)
  const mixed = r.options.find((o) => o.tickets.count === 3)
  assert.ok(mixed, `expected an outbound split + a one-way home: ${r.options.map((o) => o.tickets.count)}`)
  assert.equal(mixed.price.total, 800) // 260 + 240 outbound, 300 home
  assert.equal(mixed.journeys.length, 2)
  assert.equal(mixed.journeys[0].role, 'outbound')
  assert.equal(mixed.journeys[1].role, 'inbound')
  // The trip has to end where it started.
  for (const o of r.options) assert.equal(o.journeys[o.journeys.length - 1].route.endsWith('BER'), true)
})

/** A BER→HND one-way, so the round-trip test's one-way leg search has an answer. */
function HEAD_TO_HND() {
  return offer({ id: 'off_out_oneway', amount: 600, slices: [[segment({ from: 'BER', to: 'HND', depart: '2026-10-15T11:00:00', arrive: '2026-10-16T05:45:00', minutes: 705, number: '408' })]] })
}

test('the answer is bounded and serialisable — it lands in a model\'s context', async () => {
  const a = await adapters({ 'BER-HND': [THROUGH, NONSTOP], 'BER-IST': [HEAD], 'IST-HND': [TAIL] })
  const r = await searchFlights(ask({ maxResults: 3 }), { adapters: a })
  assert.ok(r.options.length <= 3)
  const json = JSON.stringify(r)
  assert.ok(json.length < 40000, `the answer is ${json.length} chars`)
  assert.deepEqual(JSON.parse(json).options.length, r.options.length)
  // No raw supplier payload leaks into it.
  assert.ok(!json.includes('total_amount') && !json.includes('marketing_carrier'), 'a raw API field reached the answer')
})

/* ------------------------------------------------------------------ *
 * Guards the CALL BUDGET — the one property that decides whether this addon is
 * safe to enable at all.
 *
 * The generator's job is to enumerate far more searches than anyone can afford
 * and then cut them, so the assertions that matter are: the cut happens BEFORE
 * anything is spent, the order it cuts in is deterministic (same request in,
 * same searches out), the primary search is never the one dropped, and a
 * split-ticket pair is never half-bought. A regression here does not produce a
 * wrong answer — it produces a bill.
 * Run: node --test addons/flight-search/test/grid.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { buildGrid, dateOffsets, stayLengths } = await import('../api/grid.mjs')

const end = (code, groundMinutes = 0) => ({ code, groundMinutes })
const base = (over = {}) => ({
  journeys: [{ role: 'outbound', origins: [end('BER')], destinations: [end('HND')], date: '2026-10-15' }],
  roundTrip: false,
  tripDayRange: null,
  dateFlexDays: 0,
  via: [],
  allowSplitTickets: false,
  cabin: 'economy',
  maxConnections: 1,
  passengers: { adults: 1, childAges: [] },
  maxAdapterCalls: 12,
  ...over,
})
const routes = (grid) => grid.groups.flatMap((g) => g.specs.map((s) => s.slices.map((x) => `${x.origin}-${x.destination}@${x.departureDate}`).join('+')))

test('date offsets fan out from the middle, so a truncation keeps the near dates', () => {
  assert.deepEqual(dateOffsets(0), [0])
  assert.deepEqual(dateOffsets(3), [0, 1, -1, 2, -2, 3, -3])
  assert.deepEqual(dateOffsets(999).length, 29) // clamped at ±14
  assert.deepEqual(dateOffsets('nonsense'), [0])
})

test('stay lengths run from the middle of the range outwards — "10 to 14 days" means 12', () => {
  assert.deepEqual(stayLengths([10, 14]), [12, 11, 13, 10, 14])
  assert.deepEqual(stayLengths([14, 10]), [12, 11, 13, 10, 14]) // order-insensitive
  assert.deepEqual(stayLengths([7, 7]), [7])
  assert.deepEqual(stayLengths(null), [])
  assert.deepEqual(stayLengths([0, 5]), [])
})

test('the simplest request is exactly one search', () => {
  const g = buildGrid(base())
  assert.equal(g.calls, 1)
  assert.deepEqual(routes(g), ['BER-HND@2026-10-15'])
  assert.equal(g.dropped, 0)
  assert.equal(g.groups[0].specs[0].why, 'exactly as asked')
})

test('a return trip is ONE call for both directions — which is the only way to get one ticket', () => {
  const g = buildGrid(base({ journeys: [
    { role: 'outbound', origins: [end('BER')], destinations: [end('HND')], date: '2026-10-15' },
    { role: 'inbound', origins: [end('HND')], destinations: [end('BER')], date: '2026-10-25' },
  ], roundTrip: true }))
  assert.equal(g.calls, 1)
  assert.deepEqual(routes(g), ['BER-HND@2026-10-15+HND-BER@2026-10-25'])
})

test('THE BUDGET IS ENFORCED BEFORE ANY CALL, and the primary search survives it', () => {
  const g = buildGrid(base({ dateFlexDays: 5, journeys: [{ role: 'outbound', origins: [end('BER'), end('SXF', 90)], destinations: [end('HND'), end('NRT', 75)], date: '2026-10-15' }], maxAdapterCalls: 4 }))
  assert.equal(g.calls, 4)
  assert.equal(g.enumerated, 44) // 2 origins x 2 destinations x 11 dates
  assert.equal(g.dropped, 40)
  // The exact request comes first. Then the alternate airports on the SAME day,
  // ahead of the primary pair a day out: flying from the next airport over is a
  // smaller imposition than moving the trip, and the ranking says so.
  assert.deepEqual(routes(g), ['BER-HND@2026-10-15', 'BER-NRT@2026-10-15', 'SXF-HND@2026-10-15', 'BER-HND@2026-10-16'])
})

test('the same request twice produces the same searches in the same order', () => {
  const req = () => base({ dateFlexDays: 3, allowSplitTickets: true, via: ['IST', 'DXB'], maxAdapterCalls: 9 })
  assert.deepEqual(routes(buildGrid(req())), routes(buildGrid(req())))
})

test('at equal distance the LATER date is searched first, and a far-out alternate airport falls behind a date shift', () => {
  // NRT at 75 min of ground time ranks 6.5; at 10 hours it is capped at 20+4 and
  // drops below both date shifts. Same request, different ground time, different
  // order — which is the ranking doing its job.
  const near = buildGrid(base({ dateFlexDays: 1, journeys: [{ role: 'outbound', origins: [end('BER')], destinations: [end('HND'), end('NRT', 75)], date: '2026-10-15' }], maxAdapterCalls: 4 }))
  assert.deepEqual(routes(near), ['BER-HND@2026-10-15', 'BER-NRT@2026-10-15', 'BER-HND@2026-10-16', 'BER-HND@2026-10-14'])
  const far = buildGrid(base({ dateFlexDays: 1, journeys: [{ role: 'outbound', origins: [end('BER')], destinations: [end('HND'), end('NRT', 600)], date: '2026-10-15' }], maxAdapterCalls: 4 }))
  assert.deepEqual(routes(far), ['BER-HND@2026-10-15', 'BER-HND@2026-10-16', 'BER-HND@2026-10-14', 'BER-NRT@2026-10-15'])
})

test('SPLIT LEGS ARE SPENT IN PAIRS, and get a reserved share of the budget', () => {
  const g = buildGrid(base({ dateFlexDays: 4, allowSplitTickets: true, via: ['IST'], maxAdapterCalls: 6 }))
  assert.equal(g.calls, 6)
  const pairs = g.groups.filter((x) => x.specs.length === 2)
  assert.equal(pairs.length, 1)
  // A head with no tail composes with nothing, so both halves are always present.
  assert.deepEqual(pairs[0].specs.map((s) => s.splitRole), ['head', 'tail'])
  assert.deepEqual(pairs[0].specs.map((s) => `${s.slices[0].origin}-${s.slices[0].destination}`), ['BER-IST', 'IST-HND'])
  // …and without the reserve the four cheap date variants would have taken the
  // whole budget: every split ranks below every whole-trip search, correctly.
  assert.equal(g.groups.filter((x) => x.specs.length === 1).length, 4)
})

test('with a via point but no budget for it, the whole-trip search still runs', () => {
  const g = buildGrid(base({ allowSplitTickets: true, via: ['IST'], maxAdapterCalls: 1 }))
  assert.equal(g.calls, 1)
  assert.deepEqual(routes(g), ['BER-HND@2026-10-15'])
})

test('a round trip with splits also enumerates TWO ONE-WAYS — the only partner an outbound split has', () => {
  const g = buildGrid(base({
    journeys: [
      { role: 'outbound', origins: [end('BER')], destinations: [end('HND')], date: '2026-10-15' },
      { role: 'inbound', origins: [end('HND')], destinations: [end('BER')], date: '2026-10-25' },
    ],
    roundTrip: true,
    allowSplitTickets: true,
    via: ['IST'],
    maxAdapterCalls: 8,
  }))
  const oneways = g.groups.find((x) => x.specs.every((s) => s.splitRole === 'oneway'))
  assert.ok(oneways, 'expected a one-way group')
  assert.deepEqual(oneways.specs.map((s) => `${s.slices[0].origin}-${s.slices[0].destination}`), ['BER-HND', 'HND-BER'])
  // Both directions in ONE group: a set that only bought half of itself buys nothing.
  assert.equal(oneways.specs.length, 2)
})

test('a via point that is one of the endpoints is not a via point', () => {
  const g = buildGrid(base({ allowSplitTickets: true, via: ['BER', 'HND'], maxAdapterCalls: 12 }))
  assert.equal(g.groups.filter((x) => x.specs.some((s) => s.splitRole === 'head')).length, 0)
})

test('the stay-length window drives the return date, and the flex window does not multiply it', () => {
  const g = buildGrid(base({
    journeys: [
      { role: 'outbound', origins: [end('BER')], destinations: [end('HND')], date: '2026-10-15' },
      { role: 'inbound', origins: [end('HND')], destinations: [end('BER')], date: '2026-10-25' },
    ],
    roundTrip: true,
    tripDayRange: [10, 14],
    dateFlexDays: 1,
    maxAdapterCalls: 4,
  }))
  assert.equal(g.enumerated, 15) // 3 departure dates x 5 stay lengths, NOT 3 x 3 x 5
  // 12 days first (the middle of "10 to 14"), then 11, 13, 10 — the order
  // stayLengths() produces, which only survives because the rank encodes it.
  assert.deepEqual(routes(g), [
    'BER-HND@2026-10-15+HND-BER@2026-10-27',
    'BER-HND@2026-10-15+HND-BER@2026-10-26',
    'BER-HND@2026-10-15+HND-BER@2026-10-28',
    'BER-HND@2026-10-15+HND-BER@2026-10-25',
  ])
})

test('every spec carries what the adapter needs, and the time windows land on the right half of a split', () => {
  const g = buildGrid(base({
    journeys: [{ role: 'outbound', origins: [end('BER')], destinations: [end('HND')], date: '2026-10-15', departureTime: { from: '06:00', to: '12:00' }, arrivalTime: { from: '06:00', to: '23:00' } }],
    allowSplitTickets: true,
    via: ['IST'],
    maxAdapterCalls: 3,
    cabin: 'business',
    maxConnections: 0,
  }))
  const trip = g.groups[0].specs[0]
  assert.deepEqual({ cabin: trip.cabin, maxConnections: trip.maxConnections, allowSourceSplit: trip.allowSourceSplit }, { cabin: 'business', maxConnections: 0, allowSourceSplit: true })
  const [head, tail] = g.groups.find((x) => x.specs.length === 2).specs
  assert.deepEqual(head.slices[0].departureTime, { from: '06:00', to: '12:00' })
  assert.equal(head.slices[0].arrivalTime, undefined) // the via point's clock is not a preference
  assert.equal(tail.slices[0].departureTime, undefined)
  assert.deepEqual(tail.slices[0].arrivalTime, { from: '06:00', to: '23:00' })
})

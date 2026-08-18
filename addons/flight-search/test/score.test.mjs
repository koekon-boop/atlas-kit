/* ------------------------------------------------------------------ *
 * Guards the two things that decide what a traveller is shown: the HARD FILTERS
 * (things they will not do at any price, applied before anything is ranked) and
 * the weighted utility over what is left.
 *
 * The filter assertions are the load-bearing ones. A filter that silently does
 * not fire is invisible — the answer still looks like an answer — so each one is
 * exercised on a candidate that is otherwise perfect, and the REASON is asserted
 * too, because the reason is what the tool reports back as "38 dropped for
 * arriving after 23:00".
 * Run: node --test addons/flight-search/test/score.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { DEFAULT_WEIGHTS, hardFilter, measure, resolveWeights, scoreAll } = await import('../api/score.mjs')
const { RULES, itineraryOf, offer, segment } = await import('./fixtures/duffel.mjs')

/** BER 09:35 → IST → HND 13:45+1 on one ticket, 782.40 EUR, one checked bag. */
const through = (over = {}) =>
  itineraryOf(
    [
      offer({
        id: 'off_through',
        amount: 782.4,
        emissions: 1104,
        slices: [
          [
            segment({ from: 'BER', to: 'IST', depart: '2026-10-15T09:35:00', arrive: '2026-10-15T14:05:00', minutes: 210, checked: 1 }),
            segment({ from: 'IST', to: 'HND', depart: '2026-10-15T20:15:00', arrive: '2026-10-16T13:45:00', minutes: 690, checked: 1, number: '198' }),
          ],
        ],
        ...over,
      }),
    ],
    over.opts,
  )

const nonstop = () =>
  itineraryOf([
    offer({
      id: 'off_nonstop',
      amount: 1240,
      owner: 'JL',
      emissions: 980,
      slices: [[segment({ from: 'BER', to: 'HND', depart: '2026-10-15T11:00:00', arrive: '2026-10-16T05:45:00', minutes: 705, carrier: 'JL', checked: 2 })]],
    }),
  ])

const split = () =>
  itineraryOf(
    [
      offer({ id: 'off_h', amount: 280, slices: [[segment({ from: 'BER', to: 'IST', depart: '2026-10-15T09:35:00', arrive: '2026-10-15T14:05:00', minutes: 210, checked: 0 })]] }),
      offer({ id: 'off_t', amount: 350, owner: 'PC', slices: [[segment({ from: 'IST', to: 'HND', depart: '2026-10-15T20:15:00', arrive: '2026-10-16T13:45:00', minutes: 690, carrier: 'PC', checked: 0, number: '620' })]] }),
    ],
    { wantedChecked: 1, bagFee: 55 },
  )

test('measure() reads the numbers every filter and Pareto dimension needs', async () => {
  const m = measure(await through())
  assert.equal(m.price, 782.4)
  assert.equal(m.travelMinutes, 1270)
  assert.equal(m.stops, 1)
  assert.equal(m.ticketCount, 1)
  assert.equal(m.minConnectionMinutes, 370)
  assert.equal(m.departMinute, 575) // 09:35 local at BER
  assert.equal(m.arriveMinute, 825) // 13:45 local at HND, the next day
  assert.equal(m.emissionsKg, 1104)
})

test('a hard filter fires on a candidate that is otherwise perfect, and says why', async () => {
  const it = await through()
  const cases = [
    [{ maxPrice: 700 }, /over the 700 ceiling/],
    [{ maxStops: 0 }, /1 stop\(s\), over the 0 allowed/],
    [{ maxTravelMinutes: 900 }, /over the 15 h ceiling/],
    [{ requireSingleTicket: false, avoidAirlines: ['TK'] }, /flown by TK, which is on the avoid list/],
    [{ arrivalWindow: [0, 720] }, /arrives at 13:45, outside the requested arrival window/],
    [{ departureWindow: [1080, 1380] }, /departs at 09:35, outside the requested departure window/],
  ]
  for (const [filters, re] of cases) {
    const r = hardFilter(it, filters)
    assert.equal(r.pass, false, `expected ${JSON.stringify(filters)} to reject`)
    assert.match(r.reasons[0], re)
  }
  assert.deepEqual(hardFilter(it, {}), { pass: true, reasons: [] })
})

test('an arrival window WRAPS midnight, so "no red-eye" and "the red-eye is fine" are both expressible', async () => {
  const it = await through() // arrives 13:45
  assert.equal(hardFilter(it, { arrivalWindow: [360, 1380] }).pass, true) // 06:00–23:00
  assert.equal(hardFilter(it, { arrivalWindow: [1320, 360] }).pass, false) // 22:00–06:00 only
})

test('requireSingleTicket and requireCheckedBag drop exactly what they say', async () => {
  const s = await split()
  assert.match(hardFilter(s, { requireSingleTicket: true }).reasons[0], /separate tickets, and one ticket was required/)
  assert.match(hardFilter(s, { requireCheckedBag: true }).reasons[0], /does not include the checked bag/)
  // …and the same trip with the bag PRICED IN rather than required still passes.
  assert.equal(hardFilter(s, {}).pass, true)
  assert.equal(s.price.fare, 630)
  assert.equal(s.price.bagFees, 110) // 55 per ticket, because the bag is bought twice
  assert.equal(s.price.total, 740)
})

test('an avoid list checks the OPERATING carrier too — a codeshare is still that airline', async () => {
  const wetLease = await itineraryOf([
    offer({ id: 'off_cs', amount: 400, owner: 'LH', slices: [[segment({ from: 'BER', to: 'IST', depart: '2026-10-15T09:35:00', arrive: '2026-10-15T14:05:00', minutes: 210, carrier: 'LH', operator: 'TK' })]] }),
  ])
  assert.match(hardFilter(wetLease, { avoidAirlines: ['TK'] }).reasons[0], /flown by TK/)
  assert.equal(hardFilter(wetLease, { avoidAirlines: ['AF'] }).pass, true)
})

test('weights are merged over the defaults, clamped, and unknown keys ignored', () => {
  const w = resolveWeights({ price: 3, emissions: 0, nonsense: 99, duration: -5, stops: 'x' })
  assert.equal(w.price, 3)
  assert.equal(w.emissions, 0)
  assert.equal(w.duration, 0) // clamped up from -5
  assert.equal(w.stops, DEFAULT_WEIGHTS.stops) // NaN keeps the default
  assert.equal('nonsense' in w, false)
  assert.deepEqual(resolveWeights(undefined), DEFAULT_WEIGHTS)
})

test('scoring is 0–100 LOWER IS BETTER, with every dimension reported', async () => {
  const rows = scoreAll([await through(), await nonstop(), await split()], { weights: {}, prefs: {}, rules: RULES })
  for (const r of rows) {
    assert.ok(r.score >= 0 && r.score <= 100, `score out of range: ${r.score}`)
    assert.deepEqual(Object.keys(r.penalties).sort(), Object.keys(DEFAULT_WEIGHTS).sort())
    for (const [k, v] of Object.entries(r.penalties)) assert.ok(v >= 0 && v <= 1, `penalty ${k}=${v} out of range`)
  }
  const [t, n, s] = rows
  assert.equal(s.penalties.price, 0) // cheapest of the three
  assert.equal(n.penalties.price, 1) // dearest
  assert.equal(n.penalties.stops, 0) // nonstop
  assert.equal(n.penalties.duration, 0) // and fastest
  assert.equal(t.penalties.ticketRisk, 0)
  assert.equal(s.penalties.ticketRisk, 0.5) // two tickets
  assert.equal(s.penalties.baggage, 1) // a bag missing on both
})

test('a weight of 0 genuinely switches a dimension off', async () => {
  const rows = [await through(), await split()]
  const withPrice = scoreAll(rows, { weights: {}, prefs: {}, rules: RULES })
  const withoutPrice = scoreAll(rows, { weights: { price: 0 }, prefs: {}, rules: RULES })
  // The cheap split loses its advantage once price stops counting.
  assert.ok(withPrice[1].score < withPrice[0].score)
  assert.ok(withoutPrice[1].score > withPrice[1].score)
})

test('a preferred airline is a preference, not a filter — and a soft window costs score, not the option', async () => {
  const [t] = scoreAll([await through()], { weights: {}, prefs: { preferAirlines: ['LH'] }, rules: RULES })
  assert.equal(t.penalties.airline, 1) // wholly on TK
  const [t2] = scoreAll([await through()], { weights: {}, prefs: { preferAirlines: ['TK'] }, rules: RULES })
  assert.equal(t2.penalties.airline, 0)
  // Arrives 13:45; a soft "land in the evening" window is 3 h away, the whole tolerance.
  const [t3] = scoreAll([await through()], { weights: {}, prefs: { preferArrivalWindow: [1020, 1320] }, rules: RULES })
  assert.equal(t3.penalties.arrivalWindow, 1)
  const [t4] = scoreAll([await through()], { weights: {}, prefs: { preferArrivalWindow: [720, 900] }, rules: RULES })
  assert.equal(t4.penalties.arrivalWindow, 0)
})

test('a tight connection is a RISK and a huge one is WASTE, both without disqualifying anything', async () => {
  const tight = await itineraryOf([
    offer({
      id: 'off_tight',
      amount: 500,
      slices: [[
        segment({ from: 'BER', to: 'IST', depart: '2026-10-15T09:35:00', arrive: '2026-10-15T14:05:00', minutes: 210 }),
        segment({ from: 'IST', to: 'HND', depart: '2026-10-15T15:00:00', arrive: '2026-10-16T08:30:00', minutes: 690, number: '198' }),
      ]],
    }),
  ])
  const long = await through() // 6h10 at IST
  const [r1, r2] = scoreAll([tight, long], { weights: {}, prefs: {}, rules: RULES })
  assert.equal(r1.measure.minConnectionMinutes, 55) // 10 min over the 45 floor
  assert.ok(r1.penalties.connectionRisk > 0.8, `expected a high risk penalty, got ${r1.penalties.connectionRisk}`)
  assert.equal(r1.penalties.connectionWaste, 0)
  assert.equal(r2.penalties.connectionRisk, 0)
  assert.ok(r2.penalties.connectionWaste > 0, 'a 6-hour layover should cost something')
})

test('a set where everything ties scores every relative dimension at 0 rather than NaN', async () => {
  const a = await through()
  const rows = scoreAll([a, { ...a, key: 'copy' }], { weights: {}, prefs: {}, rules: RULES })
  assert.equal(rows[0].penalties.price, 0)
  assert.equal(rows[0].penalties.duration, 0)
  assert.equal(rows[0].penalties.emissions, 0)
  assert.ok(Number.isFinite(rows[0].score))
})

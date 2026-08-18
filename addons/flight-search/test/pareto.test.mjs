/* ------------------------------------------------------------------ *
 * Guards the ANSWER SHAPE: dominated variants are DISCARDED, and what survives
 * is labelled with what it wins and what that win costs.
 *
 * The one that matters is domination. A trip that is dearer AND slower AND
 * worse-connected AND on more tickets than another is not a trade-off, and
 * ranking it fifth instead of dropping it is how a 5-row answer becomes as
 * useless as the 40-row list it replaced. It is asserted on candidates built by
 * the real assembly, so a change to what "comfort" means shows up here.
 * Run: node --test addons/flight-search/test/pareto.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { PARETO_DIMS, champions, paretoFront } = await import('../api/pareto.mjs')
const { scoreAll } = await import('../api/score.mjs')
const { RULES, itineraryOf, offer, segment } = await import('./fixtures/duffel.mjs')

const leg = (over) => segment({ from: 'BER', to: 'HND', depart: '2026-10-15T11:00:00', arrive: '2026-10-16T05:45:00', minutes: 705, ...over })

/** A nonstop at a given price, so a set can differ in exactly one dimension. */
const plain = (id, amount, over = {}) => itineraryOf([offer({ id, amount, slices: [[leg(over)]] })])

const score = async (rows) => scoreAll(rows, { weights: {}, prefs: {}, rules: RULES })

test('DOMINATED IS DISCARDED: worse on every dimension and better on none leaves the answer', async () => {
  const cheapFast = await plain('off_good', 500)
  const dearSame = await plain('off_bad', 900) // identical trip, 400 EUR more
  const front = paretoFront(await score([cheapFast, dearSame]))
  assert.equal(front.length, 1)
  assert.equal(front[0].price.total, 500)
})

test('a genuine trade-off survives: dearer but faster is not dominated', async () => {
  const slowCheap = await itineraryOf([
    offer({ id: 'off_slow', amount: 500, slices: [[
      segment({ from: 'BER', to: 'IST', depart: '2026-10-15T09:35:00', arrive: '2026-10-15T14:05:00', minutes: 210 }),
      segment({ from: 'IST', to: 'HND', depart: '2026-10-15T20:15:00', arrive: '2026-10-16T13:45:00', minutes: 690, number: '198' }),
    ]] }),
  ])
  const fastDear = await plain('off_fast', 1240, { carrier: 'JL' })
  const front = paretoFront(await score([slowCheap, fastDear]))
  assert.equal(front.length, 2)
})

test('every Pareto dimension is LOWER IS BETTER, so the comparison means one thing', async () => {
  const it = await plain('off_dims', 500)
  const [scored] = await score([it])
  assert.deepEqual(PARETO_DIMS.map((d) => d.key), ['price', 'travel', 'discomfort', 'tickets'])
  for (const d of PARETO_DIMS) assert.ok(Number.isFinite(d.get(scored)), `${d.key} is not a number`)
})

test('the champions cover the corners, each with what it wins and what it gives up', async () => {
  const cheapSplit = await itineraryOf(
    [
      offer({ id: 'off_h', amount: 260, slices: [[segment({ from: 'BER', to: 'IST', depart: '2026-10-15T09:35:00', arrive: '2026-10-15T14:05:00', minutes: 210 })]] }),
      offer({ id: 'off_t', amount: 240, owner: 'PC', slices: [[segment({ from: 'IST', to: 'HND', depart: '2026-10-15T20:15:00', arrive: '2026-10-16T13:45:00', minutes: 690, carrier: 'PC', number: '620' })]] }),
    ],
    { wantedChecked: 0 },
  )
  const nonstopDear = await plain('off_nonstop', 1240, { carrier: 'JL' })
  const middle = await itineraryOf([
    offer({ id: 'off_mid', amount: 782.4, slices: [[
      segment({ from: 'BER', to: 'IST', depart: '2026-10-15T09:35:00', arrive: '2026-10-15T14:05:00', minutes: 210 }),
      segment({ from: 'IST', to: 'HND', depart: '2026-10-15T16:45:00', arrive: '2026-10-16T10:15:00', minutes: 690, number: '198' }),
    ]] }),
  ])

  const front = paretoFront(await score([cheapSplit, nonstopDear, middle]))
  const rows = champions(front, { max: 5 })
  assert.ok(rows.length >= 3 && rows.length <= 5)

  const cheapest = rows.find((r) => r.wins.includes('cheapest'))
  assert.equal(cheapest.itinerary.price.total, 500)
  assert.match(cheapest.why, /cheapest/)
  assert.match(cheapest.tradeoffs.join(' | '), /2 separate tickets — if the first flight is late, no airline owes you/)

  const fastest = rows.find((r) => r.wins.includes('fastest door to door'))
  assert.equal(fastest.itinerary.stops, 0)
  assert.match(fastest.tradeoffs.join(' | '), /more than the cheapest/)

  // The single-ticket champion is a distinct guarantee: it exists even when the
  // cheapest thing on the board is not one.
  const oneTicket = rows.find((r) => r.wins.includes('one ticket only'))
  assert.equal(oneTicket.itinerary.ticketCount, 1)
})

test('a champion that wins several corners is listed ONCE, carrying all of them', async () => {
  const best = await plain('off_best', 400)
  const worse = await plain('off_worse', 401)
  const rows = champions(paretoFront(await score([best, worse])), { max: 5 })
  assert.equal(rows.length, 1)
  assert.ok(rows[0].wins.length > 1, `expected several wins, got ${rows[0].wins}`)
  assert.ok(rows[0].wins.includes('cheapest') && rows[0].wins.includes('best overall'))
})

test('a front smaller than max is answered in full — no padding with dominated options', async () => {
  const rows = champions(paretoFront(await score([await plain('off_a', 400)])), { max: 5 })
  assert.equal(rows.length, 1)
  assert.equal(champions([], { max: 5 }).length, 0)
})

test('the answer never exceeds the requested width', async () => {
  const set = await score([
    await plain('off_1', 400),
    await plain('off_2', 500, { depart: '2026-10-15T06:00:00', arrive: '2026-10-16T00:20:00', minutes: 680 }),
    await plain('off_3', 600, { depart: '2026-10-15T21:00:00', arrive: '2026-10-16T14:00:00', minutes: 660 }),
  ])
  assert.ok(champions(paretoFront(set), { max: 2 }).length <= 2)
})

test('ties are broken deterministically, so the same set answers the same way twice', async () => {
  const set = await score([await plain('off_x', 700), await plain('off_y', 700)])
  const a = champions(paretoFront(set), { max: 5 }).map((r) => r.itinerary.tickets[0].id)
  const b = champions(paretoFront(set), { max: 5 }).map((r) => r.itinerary.tickets[0].id)
  assert.deepEqual(a, b)
})

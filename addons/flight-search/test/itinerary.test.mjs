/* ------------------------------------------------------------------ *
 * Guards the SAFETY half of the addon: whether a connection is survivable, and
 * whether two separately-bought tickets may be presented as one trip.
 *
 * This is where a bug costs somebody a flight rather than a few euros. A
 * self-transfer that clears the same-ticket floor and nothing else, an airport
 * change nobody accounted for, a via point in a different city, a source that
 * sent no timezone — each has to be a REFUSAL with a reason, not a candidate.
 * Hermetic: pure functions over built fixtures, no network, no clock.
 * Run: node --test addons/flight-search/test/itinerary.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { buildItinerary, buildJourney, connectionsOf, feasibility, journeysOfTicket, splice } = await import('../api/itinerary.mjs')
const { segment, offer, tickets } = await import('./fixtures/duffel.mjs')

const RULES = { sameTicket: 45, selfTransfer: 150, airportChange: 240, checkedBagExtra: 30, max: 720 }

const one = async (o) => (await tickets(o))[0]
const segsOf = (ticket, i = 0) => journeysOfTicket(ticket)[i].segments

// BER → IST → HND on ONE Turkish ticket. The layover at IST is 6h10.
const throughTicket = () =>
  one(
    offer({
      id: 'off_through',
      amount: 782.4,
      slices: [
        [
          segment({ from: 'BER', to: 'IST', depart: '2026-10-15T09:35:00', arrive: '2026-10-15T14:05:00', minutes: 210, checked: 1, fromTerminal: '1', toTerminal: 'I' }),
          segment({ from: 'IST', to: 'HND', depart: '2026-10-15T20:15:00', arrive: '2026-10-16T13:45:00', minutes: 690, checked: 1, number: '198', fromTerminal: 'I' }),
        ],
      ],
    }),
  )

test('a connection is measured in INSTANTS and reports what kind it is', async () => {
  const conn = connectionsOf(segsOf(await throughTicket()))
  assert.equal(conn.length, 1)
  assert.deepEqual(
    { at: conn[0].at, minutes: conn[0].minutes, sameTicket: conn[0].sameTicket, changeOfAirport: conn[0].changeOfAirport, changeOfCity: conn[0].changeOfCity, timeZoneKnown: conn[0].timeZoneKnown },
    { at: 'IST', minutes: 370, sameTicket: true, changeOfAirport: false, changeOfCity: false, timeZoneKnown: true },
  )
})

test('SPLIT TICKETS: 100 minutes at IST is fine on one ticket and refused on two', async () => {
  const head = await one(offer({ id: 'off_head', amount: 280, slices: [[segment({ from: 'BER', to: 'IST', depart: '2026-10-15T09:35:00', arrive: '2026-10-15T14:05:00', minutes: 210 })]] }))
  const tail = await one(offer({ id: 'off_tail', amount: 350, owner: 'JL', slices: [[segment({ from: 'IST', to: 'HND', depart: '2026-10-15T15:45:00', arrive: '2026-10-16T09:15:00', minutes: 690, carrier: 'JL' })]] }))

  const asSplit = splice({ head, tail, rules: RULES, wantedChecked: 0, bagFee: 55 })
  assert.equal(asSplit.ok, false)
  assert.match(asSplit.reason, /100 min at IST is under the 150 min floor for a self-transfer/)

  // The same 100 minutes, sold by one airline as one contract, is legal: the
  // difference is entirely who carries the risk, which is exactly the point.
  const asOne = buildJourney({ tickets: [head], segments: [...segsOf(head), ...segsOf(tail).map((s) => ({ ...s, ticketId: head.id }))], rules: RULES })
  assert.equal(asOne.ok, true)
  assert.equal(asOne.journey.connections[0].minutes, 100)
})

test('a checked bag raises the self-transfer floor — you carry it to the desk yourself', async () => {
  const head = await one(offer({ id: 'off_h2', amount: 280, slices: [[segment({ from: 'BER', to: 'IST', depart: '2026-10-15T09:35:00', arrive: '2026-10-15T14:05:00', minutes: 210, checked: 1 })]] }))
  // 170 minutes: over the 150 floor, under 150 + 30 once a bag has to be re-checked.
  const tail = await one(offer({ id: 'off_t2', amount: 350, owner: 'JL', slices: [[segment({ from: 'IST', to: 'HND', depart: '2026-10-15T16:55:00', arrive: '2026-10-16T10:25:00', minutes: 690, carrier: 'JL', checked: 1 })]] }))
  assert.equal(splice({ head, tail, rules: RULES, wantedChecked: 0 }).ok, true)
  const withBag = splice({ head, tail, rules: RULES, wantedChecked: 1 })
  assert.equal(withBag.ok, false)
  assert.match(withBag.reason, /under the 180 min floor/)
})

test('an AIRPORT CHANGE in the same city needs four hours; a different city is refused outright', async () => {
  const head = await one(offer({ id: 'off_h3', amount: 120, slices: [[segment({ from: 'BER', to: 'IST', depart: '2026-10-15T09:35:00', arrive: '2026-10-15T14:05:00', minutes: 210 })]] }))
  const tight = await one(offer({ id: 'off_t3', amount: 200, slices: [[segment({ from: 'SAW', to: 'DXB', depart: '2026-10-15T17:30:00', arrive: '2026-10-15T22:40:00', minutes: 250 })]] }))
  const roomy = await one(offer({ id: 'off_t4', amount: 200, slices: [[segment({ from: 'SAW', to: 'DXB', depart: '2026-10-15T18:30:00', arrive: '2026-10-15T23:40:00', minutes: 250 })]] }))
  // IST → SAW is one city (iata_city_code IST) but two airports: 205 min is short.
  assert.match(splice({ head, tail: tight, rules: RULES }).reason, /under the 240 min floor/)
  assert.equal(splice({ head, tail: roomy, rules: RULES }).ok, true)

  // A via point in a DIFFERENT city is not a connection this tool can vouch for.
  const elsewhere = await one(offer({ id: 'off_t5', amount: 200, slices: [[segment({ from: 'DXB', to: 'HND', depart: '2026-10-16T09:00:00', arrive: '2026-10-16T23:30:00', minutes: 570 })]] }))
  assert.match(splice({ head, tail: elsewhere, rules: RULES }).reason, /different city/)
})

test('a source with no timezone makes the connection UNVERIFIABLE, not fine', async () => {
  const head = await one(offer({ id: 'off_h4', amount: 120, slices: [[segment({ from: 'BER', to: 'XXX', depart: '2026-10-15T09:35:00', arrive: '2026-10-15T14:05:00', minutes: 210 })]] }))
  const tail = await one(offer({ id: 'off_t6', amount: 200, slices: [[segment({ from: 'XXX', to: 'HND', depart: '2026-10-16T09:00:00', arrive: '2026-10-16T23:30:00', minutes: 570 })]] }))
  const r = splice({ head, tail, rules: RULES })
  assert.equal(r.ok, false)
  assert.match(r.reason, /cannot verify the connection at XXX/)
})

test('a layover over the ceiling is refused as a layover, not accepted as a bargain', async () => {
  const head = await one(offer({ id: 'off_h5', amount: 120, slices: [[segment({ from: 'BER', to: 'IST', depart: '2026-10-15T09:35:00', arrive: '2026-10-15T14:05:00', minutes: 210 })]] }))
  const tail = await one(offer({ id: 'off_t7', amount: 200, slices: [[segment({ from: 'IST', to: 'HND', depart: '2026-10-16T09:00:00', arrive: '2026-10-16T23:30:00', minutes: 570 })]] }))
  assert.match(splice({ head, tail, rules: RULES }).reason, /over the 12 h layover ceiling/)
})

test('feasibility() reports EVERY failing connection, not just the first', () => {
  const conns = [
    { at: 'IST', fromAirport: 'IST', toAirport: 'IST', minutes: 30, sameTicket: true, changeOfAirport: false, changeOfCity: false, changeOfTerminal: false },
    { at: 'DXB', fromAirport: 'DXB', toAirport: 'DXB', minutes: 60, sameTicket: false, changeOfAirport: false, changeOfCity: false, changeOfTerminal: false },
  ]
  const f = feasibility(conns, RULES, false)
  assert.equal(f.ok, false)
  assert.equal(f.reasons.length, 2)
  assert.deepEqual(f.connections.map((c) => c.required), [45, 150])
})

test('the price that comes out is fare PLUS the missing baggage, charged PER TICKET', async () => {
  // Two hand-baggage-only one-ways: the bag is bought twice, which is the whole
  // reason a split can lose to a dearer through fare.
  const head = await one(offer({ id: 'off_h6', amount: 280, slices: [[segment({ from: 'BER', to: 'IST', depart: '2026-10-15T09:35:00', arrive: '2026-10-15T14:05:00', minutes: 210, checked: 0 })]] }))
  const tail = await one(offer({ id: 'off_t8', amount: 350, slices: [[segment({ from: 'IST', to: 'HND', depart: '2026-10-15T20:15:00', arrive: '2026-10-16T13:45:00', minutes: 690, checked: 0 })]] }))
  const j = splice({ head, tail, rules: RULES, wantedChecked: 1, bagFee: 55 })
  assert.equal(j.ok, true)
  assert.deepEqual(j.journey.price, { fare: 630, bagFees: 110, total: 740, currency: 'EUR' })
  assert.equal(j.journey.missingCheckedBags, 2)
  assert.equal(j.journey.singleTicket, false)
  assert.deepEqual(j.journey.splitAt, ['IST'])
})

test('prices in two currencies are refused rather than added', async () => {
  const head = await one(offer({ id: 'off_h7', amount: 280, currency: 'EUR', slices: [[segment({ from: 'BER', to: 'IST', depart: '2026-10-15T09:35:00', arrive: '2026-10-15T14:05:00', minutes: 210 })]] }))
  const tail = await one(offer({ id: 'off_t9', amount: 350, currency: 'USD', slices: [[segment({ from: 'IST', to: 'HND', depart: '2026-10-15T20:15:00', arrive: '2026-10-16T13:45:00', minutes: 690 })]] }))
  assert.match(splice({ head, tail, rules: RULES }).reason, /will not add prices across currencies/)
})

test('the same ticket cannot be both halves of a split', async () => {
  const t = await one(offer({ id: 'off_same', amount: 280, slices: [[segment({ from: 'BER', to: 'IST', depart: '2026-10-15T09:35:00', arrive: '2026-10-15T14:05:00', minutes: 210 })]] }))
  assert.match(splice({ head: t, tail: t, rules: RULES }).reason, /cannot be both halves/)
})

test('a whole trip sums its journeys and adds the ground time to and from each airport', async () => {
  const t = await throughTicket()
  const outbound = buildJourney({ tickets: [t], segments: segsOf(t), rules: RULES, role: 'outbound' })
  assert.equal(outbound.ok, true)
  // 09:35 Berlin (07:35Z) → 13:45+1 Tokyo (04:45Z next day) = 21h10.
  assert.equal(outbound.journey.durationMinutes, 1270)

  const bare = buildItinerary({ journeys: [outbound.journey] })
  assert.equal(bare.itinerary.travelMinutes, 1270)
  assert.equal(bare.itinerary.accessMinutes, 0)

  // …and with a 55-minute drive to BER and 40 minutes out of HND, the SAME
  // flights are a 22h45 trip — which is what makes a further-out airport
  // comparable at all.
  const withGround = buildItinerary({ journeys: [outbound.journey], access: { BER: 55, HND: 40 } })
  assert.equal(withGround.itinerary.travelMinutes, 1365)
  assert.equal(withGround.itinerary.accessMinutes, 95)
  assert.equal(withGround.itinerary.singleTicket, true)
  assert.equal(withGround.itinerary.stops, 1)
  assert.equal(withGround.itinerary.selfTransfers, 0)
  assert.deepEqual(withGround.itinerary.baggage, { carryOn: 1, checked: 1 })
})

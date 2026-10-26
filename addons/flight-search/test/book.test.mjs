/* ------------------------------------------------------------------ *
 * The booking pipeline, end to end, with no network: re-verify → preview (no
 * confirm) → the two locks (live token, price ceiling) → one order per offer,
 * in sequence, never rolled back automatically.
 *
 * THE DEFAULT HAS TO BE "NOTHING HAPPENS". Every path through this file that
 * does not pass `confirm: true` is asserted to make ZERO `createOrder` calls —
 * that is the one invariant a booking tool cannot afford to get wrong, so it is
 * checked on nearly every test here, not just the ones about previews.
 *
 * PASSENGER DATA NEVER LEAKS: the last test asserts a birth date, an email and
 * a phone number — all three actually sent to Duffel — do not reach the
 * tool's JSON answer.
 * Run: node --test addons/flight-search/test/book.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { bookFlight, normalizeBookInput } = await import('../api/book.mjs')
const { offer, segment, stubBookingAdapter, tickets } = await import('./fixtures/duffel.mjs')

const PASSENGER = { givenName: 'Erika', familyName: 'Musterfrau', bornOn: '1990-05-01', gender: 'f', title: 'mrs', email: 'erika@example.com', phone: '+491701234567' }

/** One offer, already wrapped the way `getOffer` answers: `{ ok, ticket,
 *  passengerIds }`. Built through the REAL `normalizeOffer` (via `tickets()`),
 *  so a test never asserts against a shape the adapter could not produce. */
async function offerAnswer(raw, { passengerIds = ['pas_1'] } = {}) {
  const [ticket] = await tickets(raw)
  return { ok: true, ticket, passengerIds }
}

const THROUGH = offer({ id: 'off_through', amount: 782.4, slices: [[segment({ from: 'BER', to: 'IST', depart: '2026-10-15T09:35:00', arrive: '2026-10-15T14:05:00', minutes: 210 }), segment({ from: 'IST', to: 'HND', depart: '2026-10-15T20:15:00', arrive: '2026-10-16T13:45:00', minutes: 690, number: '198' })]] })
const HEAD = offer({ id: 'off_head', amount: 260, expiresAt: '2026-08-18T10:00:00.000Z', slices: [[segment({ from: 'BER', to: 'IST', depart: '2026-10-15T09:35:00', arrive: '2026-10-15T14:05:00', minutes: 210 })]] })
const TAIL = offer({ id: 'off_tail', amount: 240, owner: 'PC', expiresAt: '2026-08-18T10:00:00.000Z', slices: [[segment({ from: 'IST', to: 'HND', depart: '2026-10-15T20:15:00', arrive: '2026-10-16T13:45:00', minutes: 690, carrier: 'PC', number: '620' })]] })

const NOW = () => new Date('2026-08-18T09:00:00.000Z') // before every fixture offer's expiry

/* --- normalizeBookInput: a trust boundary, same as search's --------------- */

test('a request missing everything is refused with every problem named', () => {
  const { errors } = normalizeBookInput({})
  assert.deepEqual(errors, ['offerIds is required — one id for a single ticket, two for a self-transfer split', 'passengers is required — at least one, in the same order for every offerId'])
})

test('at most two offerIds, and they must be distinct', () => {
  assert.deepEqual(normalizeBookInput({ offerIds: ['a', 'b', 'c'], passengers: [PASSENGER] }).errors, ['at most two offerIds — this tool books at most a two-ticket split, one order per offer'])
  assert.deepEqual(normalizeBookInput({ offerIds: ['a', 'a'], passengers: [PASSENGER] }).errors, ['offerIds must be distinct — the same offer cannot be booked twice'])
  assert.deepEqual(normalizeBookInput({ offerIds: 'off_1', passengers: [PASSENGER] }).request.offerIds, ['off_1']) // a bare string is accepted as one id
})

test('every passenger field is checked, and the reason names the field and the passenger', () => {
  const { errors } = normalizeBookInput({ offerIds: ['off_1'], passengers: [{ givenName: '', familyName: 'X', bornOn: '18.5.1990', gender: 'x', title: 'sir', email: 'not-an-email', phone: '0170123' }] })
  assert.deepEqual(errors, [
    'passenger 1: givenName is required, as in the passport',
    'passenger 1: bornOn must be YYYY-MM-DD',
    'passenger 1: gender must be "m" or "f"',
    'passenger 1: title must be one of mr, mrs, ms, miss, dr',
    'passenger 1: email is required and must look like an email address',
    'passenger 1: phone must be E.164, e.g. "+491701234567"',
  ])
})

test('a request that cannot be used is refused before any adapter is touched', async () => {
  const a = stubBookingAdapter({})
  const r = await bookFlight({}, { adapters: [a] })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'the request could not be used as given')
  assert.equal(a.orders.length, 0)
})

/* --- no bookable source — the default state of most boxes ----------------- */

test('NO SOURCE CONFIGURED FOR BOOKING: an answer that says what to do, and books nothing', async () => {
  const dead = stubBookingAdapter({ configured: false })
  const r = await bookFlight({ offerIds: ['off_x'], passengers: [PASSENGER] }, { adapters: [dead] })
  assert.equal(r.ok, false)
  assert.match(r.reason, /no flight source is configured for booking/)
  assert.match(r.howToEnable, /DUFFEL_API_TOKEN=duffel_test_/)
  assert.deepEqual(r.bookings, [])
  assert.equal(dead.orders.length, 0)
})

test('a source that can search but not book (no getOffer/createOrder) is invisible to book_flight', async () => {
  const searchOnly = { name: 'search-only', label: 'search-only', status: () => ({ configured: true }), search: async () => ({ ok: true, tickets: [] }) }
  const r = await bookFlight({ offerIds: ['off_x'], passengers: [PASSENGER] }, { adapters: [searchOnly] })
  assert.equal(r.ok, false)
  assert.match(r.reason, /no flight source is configured for booking/)
})

/* --- the re-verify step: fresh price, expiry, passenger count -------------- */

test('an offer that fails to re-fetch is reported, and nothing is booked', async () => {
  const a = stubBookingAdapter({ offers: { off_x: { ok: false, error: 'Duffel HTTP 404: Not Found' } } })
  const r = await bookFlight({ offerIds: ['off_x'], passengers: [PASSENGER], confirm: true }, { adapters: [a] })
  assert.equal(r.ok, false)
  assert.match(r.reason, /could not be re-verified/)
  assert.deepEqual(r.failedOffers, [{ offerId: 'off_x', error: 'Duffel HTTP 404: Not Found' }])
  assert.equal(a.orders.length, 0)
})

test('an EXPIRED offer refuses to book, even with confirm: true', async () => {
  const stale = offer({ id: 'off_stale', amount: 300, expiresAt: '2026-08-18T08:00:00.000Z', slices: [[segment({ from: 'BER', to: 'HND' })]] })
  const a = stubBookingAdapter({ offers: { off_stale: await offerAnswer(stale) } })
  const r = await bookFlight({ offerIds: ['off_stale'], passengers: [PASSENGER], confirm: true }, { adapters: [a], now: NOW })
  assert.equal(r.ok, false)
  assert.match(r.reason, /offer\(s\) expired/)
  assert.match(r.reason, /off_stale/)
  assert.equal(a.orders.length, 0)
})

test('a passenger count that does not match the offer refuses before booking', async () => {
  const a = stubBookingAdapter({ offers: { off_through: await offerAnswer(THROUGH, { passengerIds: ['pas_1', 'pas_2'] }) } })
  const r = await bookFlight({ offerIds: ['off_through'], passengers: [PASSENGER], confirm: true }, { adapters: [a], now: NOW })
  assert.equal(r.ok, false)
  assert.match(r.reason, /number of passengers given does not match/)
  assert.deepEqual(r.mismatched, [{ offerId: 'off_through', needsPassengers: 2, given: 1 }])
  assert.equal(a.orders.length, 0)
})

/* --- WITHOUT confirm: a preview, and NOTHING is ever booked ---------------- */

test('without confirm, the answer is a PREVIEW and books nothing — the default has to be inert', async () => {
  const a = stubBookingAdapter({ offers: { off_through: await offerAnswer(THROUGH) } })
  const r = await bookFlight({ offerIds: ['off_through'], passengers: [PASSENGER] }, { adapters: [a], now: NOW })
  assert.equal(r.ok, true)
  assert.equal(r.confirmed, false)
  assert.equal(r.mode, 'test')
  assert.equal(r.legs.length, 1)
  assert.equal(r.legs[0].route, 'BER → HND')
  assert.equal(r.total.amount, 782.4)
  assert.equal(r.total.currency, 'EUR')
  assert.equal(r.bookable.allowed, true)
  assert.match(r.note, /PREVIEW ONLY/)
  assert.equal(a.orders.length, 0)
  // `confirm: false` explicitly is the same as omitting it.
  const r2 = await bookFlight({ offerIds: ['off_through'], passengers: [PASSENGER], confirm: false }, { adapters: [a], now: NOW })
  assert.equal(r2.confirmed, false)
  assert.equal(a.orders.length, 0)
})

test('a SPLIT preview sums both legs and still books nothing', async () => {
  const a = stubBookingAdapter({ offers: { off_head: await offerAnswer(HEAD), off_tail: await offerAnswer(TAIL) } })
  const r = await bookFlight({ offerIds: ['off_head', 'off_tail'], passengers: [PASSENGER] }, { adapters: [a], now: NOW })
  assert.equal(r.ok, true)
  assert.equal(r.legs.length, 2)
  assert.equal(r.total.amount, 500) // 260 + 240
  assert.equal(a.orders.length, 0)
})

/* --- the live-booking lock -------------------------------------------------- */

test('a LIVE token without ATLAS_FLIGHTS_ALLOW_LIVE_BOOKING refuses to book, confirm or not', async () => {
  const a = stubBookingAdapter({ offers: { off_through: await offerAnswer(THROUGH) }, mode: 'live' })
  const saved = process.env.ATLAS_FLIGHTS_ALLOW_LIVE_BOOKING
  delete process.env.ATLAS_FLIGHTS_ALLOW_LIVE_BOOKING
  try {
    const preview = await bookFlight({ offerIds: ['off_through'], passengers: [PASSENGER] }, { adapters: [a], now: NOW })
    assert.equal(preview.bookable.allowed, false)
    assert.match(preview.bookable.reason, /ATLAS_FLIGHTS_ALLOW_LIVE_BOOKING/)

    const r = await bookFlight({ offerIds: ['off_through'], passengers: [PASSENGER], confirm: true }, { adapters: [a], now: NOW })
    assert.equal(r.ok, false)
    assert.match(r.reason, /ATLAS_FLIGHTS_ALLOW_LIVE_BOOKING/)
    assert.equal(a.orders.length, 0, 'a live booking must never reach createOrder without the env lock')
  } finally {
    if (saved === undefined) delete process.env.ATLAS_FLIGHTS_ALLOW_LIVE_BOOKING
    else process.env.ATLAS_FLIGHTS_ALLOW_LIVE_BOOKING = saved
  }
})

test('a LIVE token WITH ATLAS_FLIGHTS_ALLOW_LIVE_BOOKING=1 and confirm: true books for real', async () => {
  const a = stubBookingAdapter({ offers: { off_through: await offerAnswer(THROUGH) }, mode: 'live' })
  const saved = process.env.ATLAS_FLIGHTS_ALLOW_LIVE_BOOKING
  process.env.ATLAS_FLIGHTS_ALLOW_LIVE_BOOKING = '1'
  try {
    const r = await bookFlight({ offerIds: ['off_through'], passengers: [PASSENGER], confirm: true }, { adapters: [a], now: NOW })
    assert.equal(r.ok, true)
    assert.equal(r.bookings[0].liveMode, true)
    assert.equal(a.orders.length, 1)
  } finally {
    if (saved === undefined) delete process.env.ATLAS_FLIGHTS_ALLOW_LIVE_BOOKING
    else process.env.ATLAS_FLIGHTS_ALLOW_LIVE_BOOKING = saved
  }
})

/* --- the price ceiling ------------------------------------------------------ */

test('a total over ATLAS_FLIGHTS_MAX_BOOKING_EUR is refused before booking', async () => {
  const pricey = offer({ id: 'off_pricey', amount: 5000, slices: [[segment({ from: 'BER', to: 'HND' })]] })
  const a = stubBookingAdapter({ offers: { off_pricey: await offerAnswer(pricey) } })
  const saved = process.env.ATLAS_FLIGHTS_MAX_BOOKING_EUR
  process.env.ATLAS_FLIGHTS_MAX_BOOKING_EUR = '1500'
  try {
    const r = await bookFlight({ offerIds: ['off_pricey'], passengers: [PASSENGER], confirm: true }, { adapters: [a], now: NOW })
    assert.equal(r.ok, false)
    assert.match(r.reason, /over the 1500 EUR booking ceiling/)
    assert.equal(a.orders.length, 0)
  } finally {
    if (saved === undefined) delete process.env.ATLAS_FLIGHTS_MAX_BOOKING_EUR
    else process.env.ATLAS_FLIGHTS_MAX_BOOKING_EUR = saved
  }
})

test('the ceiling is skipped, not silently bypassed, when the total is not in EUR', async () => {
  const usd = offer({ id: 'off_usd', amount: 5000, currency: 'USD', slices: [[segment({ from: 'LAX', to: 'ORD' })]] })
  const a = stubBookingAdapter({ offers: { off_usd: await offerAnswer(usd) } })
  const r = await bookFlight({ offerIds: ['off_usd'], passengers: [PASSENGER] }, { adapters: [a], now: NOW })
  assert.equal(r.bookable.allowed, true)
})

/* --- confirm: true — the real booking path --------------------------------- */

test('CONFIRMED: a single ticket is booked, and the answer carries the PNR, not the birth date', async () => {
  const a = stubBookingAdapter({ offers: { off_through: await offerAnswer(THROUGH) }, book: { off_through: { ok: true, orderId: 'ord_1', bookingReference: 'K6773F', liveMode: false, amount: 782.4, currency: 'EUR' } } })
  const r = await bookFlight({ offerIds: ['off_through'], passengers: [PASSENGER], confirm: true }, { adapters: [a], now: NOW })
  assert.equal(r.ok, true)
  assert.equal(r.confirmed, true)
  assert.equal(a.orders.length, 1)
  assert.deepEqual(r.bookings, [{ leg: 0, offerId: 'off_through', route: 'BER → HND', passengerNames: ['Erika Musterfrau'], pnr: 'K6773F', orderId: 'ord_1', amount: 782.4, currency: 'EUR', liveMode: false }])
  assert.equal(r.total.amount, 782.4)

  const json = JSON.stringify(r)
  for (const leaked of [PASSENGER.bornOn, PASSENGER.email, PASSENGER.phone]) assert.ok(!json.includes(leaked), `${leaked} leaked into the answer`)
})

test('CONFIRMED SPLIT: both offers are booked, one order each, in order', async () => {
  const a = stubBookingAdapter({ offers: { off_head: await offerAnswer(HEAD), off_tail: await offerAnswer(TAIL) } })
  const r = await bookFlight({ offerIds: ['off_head', 'off_tail'], passengers: [PASSENGER], confirm: true }, { adapters: [a], now: NOW })
  assert.equal(r.ok, true)
  assert.equal(r.bookings.length, 2)
  assert.deepEqual(a.orders.map((o) => o.offerId), ['off_head', 'off_tail'])
  assert.equal(r.total.amount, 500)
})

test('a split where the SECOND booking fails says the first is already booked, and does not pretend to roll it back', async () => {
  const a = stubBookingAdapter({
    offers: { off_head: await offerAnswer(HEAD), off_tail: await offerAnswer(TAIL) },
    book: { off_tail: { ok: false, error: 'Duffel HTTP 422: Insufficient balance' } },
  })
  const r = await bookFlight({ offerIds: ['off_head', 'off_tail'], passengers: [PASSENGER], confirm: true }, { adapters: [a], now: NOW })
  assert.equal(r.ok, false)
  assert.match(r.reason, /ALREADY BOOKED/)
  assert.match(r.reason, /Insufficient balance/)
  assert.equal(r.bookings.length, 1)
  assert.equal(r.bookings[0].offerId, 'off_head')
  assert.equal(a.orders.length, 2, 'the failing second call must still have been attempted, not skipped')
})

test('a split where the FIRST booking fails says plainly that nothing was booked', async () => {
  const a = stubBookingAdapter({
    offers: { off_head: await offerAnswer(HEAD), off_tail: await offerAnswer(TAIL) },
    book: { off_head: { ok: false, error: 'Duffel HTTP 429: Rate limit exceeded' } },
  })
  const r = await bookFlight({ offerIds: ['off_head', 'off_tail'], passengers: [PASSENGER], confirm: true }, { adapters: [a], now: NOW })
  assert.equal(r.ok, false)
  assert.match(r.reason, /nothing was booked/)
  assert.deepEqual(r.bookings, [])
  assert.equal(a.orders.length, 1, 'the second ticket must never be attempted once the first failed')
})

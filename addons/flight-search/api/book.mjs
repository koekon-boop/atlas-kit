/* ------------------------------------------------------------------ *
 * `book_flight` — turn one option `search_flights` already found into a real
 * Duffel order. The second half of the addon; everything here is downstream of
 * an offer id a caller already has, never a new search.
 *
 *   re-verify every offer (fresh price, expiry, conditions) → refuse if stale
 *   → without confirm: true, STOP and hand back a preview → with confirm: true,
 *   check the live-booking lock and the price ceiling → book each offer in
 *   order, one Duffel order per offer, never in parallel
 *
 * 🔴 WITHOUT `confirm: true` THIS NEVER BOOKS. A model that calls a tool named
 * `book_flight` is trying to book something, which is exactly why the default
 * has to be "tell me what that would cost, do nothing" — the one case where an
 * optional addon's default behaviour spending real (if test-mode) money would
 * be a surprise no README warning fixes after the fact.
 *
 * 🔴 A SPLIT IS TWO ORDERS, NOT ONE TRANSACTION. If the second Duffel call fails
 * after the first succeeded, nothing is cancelled automatically — the answer
 * says plainly what is booked and what is not, and leaves the decision what to
 * do about a half-booked trip to the human who asked for it (README "Buchen").
 *
 * 🔴 PASSENGER DATA IS NEVER LOGGED. It passes from the tool's input straight
 * into the Duffel request body and nowhere else; the answer reports only names
 * and the booking reference, never a birth date, email or phone number back.
 * ------------------------------------------------------------------ */
import { adapterStatus, bookableAdapters, loadAdapters } from './adapters/index.mjs'
import { liveBookingAllowed, maxBookingEur, SETUP_HINT } from './config.mjs'

const round2 = (n) => Math.round(n * 100) / 100

const GENDERS = { m: 'm', f: 'f' }
const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr'])
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_RE = /^\+[1-9]\d{6,14}$/ // E.164, as Duffel requires

function normalizePassenger(p, i, errors) {
  const givenName = String(p?.givenName || '').trim()
  const familyName = String(p?.familyName || '').trim()
  const bornOn = String(p?.bornOn || '').trim()
  const gender = GENDERS[String(p?.gender || '').trim().toLowerCase()]
  const title = String(p?.title || '').trim().toLowerCase()
  const email = String(p?.email || '').trim()
  const phone = String(p?.phone || '').trim()
  if (!givenName) errors.push(`passenger ${i + 1}: givenName is required, as in the passport`)
  if (!familyName) errors.push(`passenger ${i + 1}: familyName is required, as in the passport`)
  if (!DATE_RE.test(bornOn)) errors.push(`passenger ${i + 1}: bornOn must be YYYY-MM-DD`)
  if (!gender) errors.push(`passenger ${i + 1}: gender must be "m" or "f"`)
  if (!TITLES.has(title)) errors.push(`passenger ${i + 1}: title must be one of ${[...TITLES].join(', ')}`)
  if (!EMAIL_RE.test(email)) errors.push(`passenger ${i + 1}: email is required and must look like an email address`)
  if (!PHONE_RE.test(phone)) errors.push(`passenger ${i + 1}: phone must be E.164, e.g. "+491701234567"`)
  return { givenName, familyName, bornOn, gender, title, email, phone }
}

/** The tool's input → the shape `bookFlight` works from, plus every problem
 *  with it. Validation is a trust boundary here too: a malformed passenger
 *  silently reaching Duffel is how a real order gets created with the wrong
 *  name on it. */
export function normalizeBookInput(input = {}) {
  const errors = []
  const offerIds = (Array.isArray(input.offerIds) ? input.offerIds : [input.offerIds]).map((v) => String(v || '').trim()).filter(Boolean)
  if (!offerIds.length) errors.push('offerIds is required — one id for a single ticket, two for a self-transfer split')
  if (offerIds.length > 2) errors.push('at most two offerIds — this tool books at most a two-ticket split, one order per offer')
  if (new Set(offerIds).size !== offerIds.length) errors.push('offerIds must be distinct — the same offer cannot be booked twice')

  const passengersIn = Array.isArray(input.passengers) ? input.passengers : []
  if (!passengersIn.length) errors.push('passengers is required — at least one, in the same order for every offerId')
  const passengers = passengersIn.map((p, i) => normalizePassenger(p, i, errors))

  return { errors, request: { offerIds, passengers, confirm: input.confirm === true } }
}

/** The answer when no configured source can book. Mirrors `search.mjs`'s
 *  `notConfiguredAnswer` on purpose: an unconfigured addon is the default
 *  state, not an error, and the reply's job is to say what to do about it. */
export function notConfiguredBookAnswer(sources) {
  return { ok: false, reason: 'no flight source is configured for booking on this box, so nothing was booked', sources, howToEnable: SETUP_HINT, bookings: [] }
}

const legSummary = (ticket) => {
  const first = ticket.journeys[0]
  const last = ticket.journeys[ticket.journeys.length - 1]
  const firstSeg = first?.segments?.[0]
  const lastSeg = last?.segments?.[last.segments.length - 1]
  return {
    offerId: ticket.id,
    route: firstSeg && lastSeg ? `${firstSeg.origin.iata} → ${lastSeg.destination.iata}` : '',
    departs: firstSeg?.departingAt || '',
    arrives: lastSeg?.arrivingAt || '',
    owner: ticket.owner.name || ticket.owner.iata,
    price: { total: ticket.price.total, currency: ticket.price.currency },
    refundable: ticket.conditions.refundable,
    changeable: ticket.conditions.changeable,
    expiresAt: ticket.expiresAt,
  }
}

/** Whether `confirm: true` is actually allowed to spend money right now — the
 *  two locks, checked together so a preview can show the same verdict a real
 *  booking attempt would get, before anything is spent either way. */
function assessBookability({ mode, totalPrice, currency }) {
  if (mode === 'live' && !liveBookingAllowed())
    return { allowed: false, reason: 'this is a LIVE Duffel token and ATLAS_FLIGHTS_ALLOW_LIVE_BOOKING is not set to "1" — a live booking is refused by default. Set it in .env and restart to allow real purchases.' }
  const cap = maxBookingEur()
  if (currency === 'EUR' && totalPrice != null && totalPrice > cap)
    return { allowed: false, reason: `total ${totalPrice} EUR is over the ${cap} EUR booking ceiling (ATLAS_FLIGHTS_MAX_BOOKING_EUR)` }
  return { allowed: true, reason: '' }
}

/**
 * Run one booking attempt (a preview, or a real one with `confirm: true`).
 *
 * `adapters` is injected in tests; in production `register()` passes the ones
 * `loadAdapters()` built — the same list `search_flights` uses, so a box with
 * no `DUFFEL_API_TOKEN` degrades here exactly as it does there.
 */
export async function bookFlight(input, { adapters = loadAdapters(), now = () => new Date() } = {}) {
  const sources = adapterStatus(adapters)
  const { errors, request } = normalizeBookInput(input)
  if (errors.length) return { ok: false, reason: 'the request could not be used as given', problems: errors, sources, bookings: [] }

  const usable = bookableAdapters(adapters)
  if (!usable.length) return notConfiguredBookAnswer(sources)
  // Today there is exactly one bookable source. Once a second one ships, the
  // offers a caller hands back from search_flights already carry `source` —
  // picking by that, rather than always taking the first, is the change to
  // make then, not a guess to bake in now.
  const adapter = usable[0]
  const mode = adapter.status().mode || 'unknown'

  /* ---- (a) re-verify every offer, fresh --------------------------------- */
  const fetched = await Promise.all(request.offerIds.map((id) => adapter.getOffer(id)))
  const fetchFailures = fetched.map((f, i) => (f.ok ? null : { offerId: request.offerIds[i], error: f.error })).filter(Boolean)
  if (fetchFailures.length) return { ok: false, reason: 'one or more offers could not be re-verified — nothing was booked', failedOffers: fetchFailures, sources, bookings: [] }

  const nowMs = now().getTime()
  const expired = fetched.filter((f) => f.ticket.expiresAt && Date.parse(f.ticket.expiresAt) < nowMs).map((f) => f.ticket.id)
  if (expired.length) return { ok: false, reason: `offer(s) expired — re-run search_flights for a fresh one: ${expired.join(', ')}`, sources, bookings: [] }

  const mismatched = fetched.map((f, i) => (f.passengerIds.length === request.passengers.length ? null : { offerId: request.offerIds[i], needsPassengers: f.passengerIds.length, given: request.passengers.length })).filter(Boolean)
  if (mismatched.length) return { ok: false, reason: 'the number of passengers given does not match what an offer was priced for — nothing was booked', mismatched, sources, bookings: [] }

  const legs = fetched.map((f) => legSummary(f.ticket))
  const currencies = [...new Set(legs.map((l) => l.price.currency).filter(Boolean))]
  const totalPrice = currencies.length === 1 ? round2(legs.reduce((n, l) => n + l.price.total, 0)) : null
  const bookability = assessBookability({ mode, totalPrice, currency: currencies[0] })

  /* ---- (b) no confirm: a priced, up-to-date preview — and nothing booked - */
  if (!request.confirm) {
    return {
      ok: true,
      confirmed: false,
      mode,
      legs,
      total: currencies.length === 1 ? { amount: totalPrice, currency: currencies[0] } : { note: 'legs are priced in different currencies and are not summed', amounts: legs.map((l) => l.price) },
      bookable: bookability,
      note: 'PREVIEW ONLY — nothing was booked. Prices, expiry and conditions were just re-checked against Duffel and can still change. Call again with confirm: true to actually book.',
    }
  }

  /* ---- (c)+(d) confirm: true — the two locks, then one order per offer -- */
  if (!bookability.allowed) return { ok: false, reason: bookability.reason, mode, legs, bookings: [] }

  const bookings = []
  for (const [i, f] of fetched.entries()) {
    const passengers = f.passengerIds.map((id, pi) => ({ offerPassengerId: id, ...request.passengers[pi] }))
    const r = await adapter.createOrder({ offerId: f.ticket.id, amount: f.ticket.price.total, currency: f.ticket.price.currency, passengers })
    if (!r.ok) {
      return {
        ok: false,
        reason:
          i === 0
            ? `booking failed on the first ticket — nothing was booked: ${r.error}`
            : `booking failed on ticket ${i + 1} of ${fetched.length} — the earlier ${i} ticket(s) below are ALREADY BOOKED and were NOT cancelled automatically: ${r.error}`,
        mode,
        bookings,
        error: r.error,
      }
    }
    bookings.push({
      leg: i,
      offerId: f.ticket.id,
      route: legs[i].route,
      // Names and the booking reference only — never the birth date, email or
      // phone that went into the Duffel request.
      passengerNames: request.passengers.map((p) => `${p.givenName} ${p.familyName}`),
      pnr: r.bookingReference,
      orderId: r.orderId,
      amount: r.amount,
      currency: r.currency,
      liveMode: r.liveMode,
    })
  }

  return {
    ok: true,
    confirmed: true,
    mode,
    bookings,
    total: currencies.length === 1 ? { amount: round2(bookings.reduce((n, b) => n + b.amount, 0)), currency: bookings[0]?.currency } : null,
  }
}

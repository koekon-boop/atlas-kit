/* ------------------------------------------------------------------ *
 * The DUFFEL source adapter — today the only one, deliberately shaped so it is
 * not the only one it could ever be.
 *
 * Everything Duffel-specific stops at this file: the `Duffel-Version` header,
 * the `offer_requests` → `offers` two-step, `total_amount` as a STRING, ISO 8601
 * durations, `iata_city_code`. What leaves is the neutral `Ticket` shape
 * itinerary.mjs documents, which is the whole reason an Amadeus adapter can be
 * dropped in beside this one without touching the generator, the scorer or the
 * Pareto front.
 *
 * 🔴 NOTHING HERE THROWS. No token, a 401, a 429, a socket reset, a body that is
 * not the JSON the docs promise — every one of them is `{ ok: false, error }`
 * with a sentence an operator can act on. An optional addon that can 500 a tool
 * call is an optional addon that costs you the tool (docs/ADDONS.md).
 *
 * ⚠️ DUFFEL SENDS LOCAL WALL CLOCKS. `departing_at: "2026-10-15T09:35:00"` has no
 * offset; `time_zone` on the airport object is what makes it arithmetic. Both are
 * carried through to the internal shape, and time.mjs is where they meet — see
 * that file for why subtracting the strings is wrong in exactly the cases that
 * matter.
 *
 * WHAT DUFFEL STRUCTURALLY DOES NOT GIVE US, and what this file does instead:
 *   · no booking URL — an offer is ordered through the API, so the answer
 *     carries the offer id and an expiry, not a link that books anything
 *   · no price for baggage the fare excludes without a second per-offer call
 *     (`?return_available_services=true`), so the fee is ESTIMATED upstream
 *   · no low-cost carriers that refuse aggregation (Ryanair, Wizz, easyJet and
 *     most of the ultra-low-cost world are simply absent from the results)
 * ------------------------------------------------------------------ */
import { isoDurationMinutes, minutesBetween } from '../time.mjs'
import { duffelToken, duffelBase, duffelVersion, timeouts } from '../config.mjs'

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Duffel's Place object → the neutral airport shape. `time_zone` is the field
 *  everything downstream depends on, so it is carried verbatim and never faked. */
export function normalizeAirport(p, terminal) {
  return {
    iata: p?.iata_code || '',
    name: p?.name || '',
    cityCode: p?.iata_city_code || p?.city?.iata_code || '',
    cityName: p?.city_name || p?.city?.name || '',
    timeZone: p?.time_zone || '',
    terminal: terminal || '',
  }
}

/* `baggages` is per passenger per segment, and the enum has been written both
 * `carry_on` and `carry-on` in Duffel's own docs, so both are accepted. Anything
 * else counts as neither rather than as a checked bag: over-reporting an
 * allowance is the error that costs money at the desk. */
function baggageOf(passenger) {
  let carryOn = 0
  let checked = 0
  for (const b of passenger?.baggages || []) {
    const q = Number(b?.quantity) || 0
    const t = String(b?.type || '').replace('-', '_')
    if (t === 'carry_on') carryOn += q
    else if (t === 'checked') checked += q
  }
  return { carryOn, checked }
}

function normalizeSegment(seg) {
  const origin = normalizeAirport(seg?.origin, seg?.origin_terminal)
  const destination = normalizeAirport(seg?.destination, seg?.destination_terminal)
  const pax = seg?.passengers?.[0]
  const marketing = { iata: seg?.marketing_carrier?.iata_code || '', name: seg?.marketing_carrier?.name || '' }
  const operating = { iata: seg?.operating_carrier?.iata_code || marketing.iata, name: seg?.operating_carrier?.name || marketing.name }
  return {
    origin,
    destination,
    departingAt: seg?.departing_at || '',
    arrivingAt: seg?.arriving_at || '',
    marketingCarrier: marketing,
    operatingCarrier: operating,
    flightNumber: `${marketing.iata}${seg?.marketing_carrier_flight_number || ''}`,
    aircraft: seg?.aircraft?.name || '',
    cabinClass: pax?.cabin_class || '',
    cabinName: pax?.cabin_class_marketing_name || '',
    // The stated duration is authoritative (it is the airline's own), but it is
    // optional in practice, and the fallback has to be instant arithmetic — the
    // naive difference of two local strings is wrong across every timezone.
    durationMinutes: isoDurationMinutes(seg?.duration) || minutesBetween(seg?.departing_at, origin.timeZone, seg?.arriving_at, destination.timeZone) || 0,
    baggage: baggageOf(pax),
  }
}

const condition = (c) => (c == null ? null : { allowed: c.allowed ?? null, penalty: num(c.penalty_amount), currency: c.penalty_currency || '' })

/**
 * One Duffel offer → one `Ticket`. Pure and exported so the whole normalisation
 * is testable against a saved response with no network anywhere near it.
 *
 * Returns `null` for an offer that cannot be bought as it stands: `partial: true`
 * is Duffel's marker for a half-offer from the multi-step search flow, and an
 * offer with no segments is not a trip.
 */
export function normalizeOffer(offer, { source = 'duffel' } = {}) {
  if (!offer || offer.partial === true) return null
  const journeys = (offer.slices || []).map((s) => ({
    segments: (s.segments || []).map(normalizeSegment),
    durationMinutes: isoDurationMinutes(s.duration),
    fareBrand: s.fare_brand_name || '',
  }))
  const segments = journeys.flatMap((j) => j.segments)
  if (!segments.length) return null

  // The BINDING allowance is the smallest one on any leg: a bag that is free to
  // Istanbul and chargeable onward is a bag you pay for.
  const bags = segments.map((s) => s.baggage)
  return {
    source,
    id: offer.id || '',
    price: {
      total: num(offer.total_amount) ?? 0,
      currency: offer.total_currency || '',
      base: num(offer.base_amount),
      tax: num(offer.tax_amount),
    },
    owner: { iata: offer.owner?.iata_code || '', name: offer.owner?.name || '' },
    journeys,
    baggage: { carryOn: Math.min(...bags.map((b) => b.carryOn)), checked: Math.min(...bags.map((b) => b.checked)) },
    conditions: {
      changeable: offer.conditions?.change_before_departure?.allowed ?? null,
      refundable: offer.conditions?.refund_before_departure?.allowed ?? null,
      change: condition(offer.conditions?.change_before_departure),
      refund: condition(offer.conditions?.refund_before_departure),
    },
    emissionsKg: num(offer.total_emissions_kg),
    expiresAt: offer.expires_at || '',
  }
}

/** The passenger list Duffel wants. Adults and explicit child AGES only — an
 *  age is unambiguous where the `child`/`young_adult` enums are carrier-specific,
 *  and infants-in-arms are not supported rather than guessed at (see README). */
export function duffelPassengers({ adults = 1, childAges = [] } = {}) {
  const out = Array.from({ length: Math.max(1, Math.min(9, Math.floor(adults) || 1)) }, () => ({ type: 'adult' }))
  for (const a of (childAges || []).slice(0, 8)) {
    const n = Math.floor(Number(a))
    if (Number.isFinite(n) && n >= 0 && n < 18) out.push({ age: n })
  }
  return out
}

/** One grid spec → the Duffel offer-request body. Pure, so the mapping from
 *  "what the generator wants" to "what Duffel accepts" is asserted, not hoped. */
export function offerRequestBody(spec) {
  const data = {
    slices: spec.slices.map((s) => {
      const slice = { origin: s.origin, destination: s.destination, departure_date: s.departureDate }
      // Pushing the time windows to the SOURCE is the cheap prune: an offer that
      // was never returned costs nothing to filter. The hard filter re-checks
      // anyway, because a split leg's windows do not cover its own via point.
      if (s.departureTime) slice.departure_time = { from: s.departureTime.from, to: s.departureTime.to }
      if (s.arrivalTime) slice.arrival_time = { from: s.arrivalTime.from, to: s.arrivalTime.to }
      return slice
    }),
    passengers: duffelPassengers(spec.passengers),
  }
  if (spec.cabin) data.cabin_class = spec.cabin
  if (Number.isFinite(spec.maxConnections)) data.max_connections = Math.max(0, Math.min(2, spec.maxConnections))
  // Duffel's own split-ticket product: offers it assembles and sells as ONE
  // order. Different thing from the split tickets this addon builds (those are
  // two orders and two liabilities) — but the same intent, so it follows the
  // same switch, and the answer labels them apart by ticket count.
  if (spec.allowSourceSplit) data.include_split_ticket = true
  return { data }
}

/**
 * The adapter. `fetchImpl` is injectable for exactly one reason: the tests must
 * never reach the network, and an adapter you can only exercise by paying for a
 * supplier call is an adapter nobody exercises.
 */
export function duffelAdapter({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const token = () => duffelToken(env)
  const mode = () => (token().startsWith('duffel_live_') ? 'live' : token().startsWith('duffel_test_') ? 'test' : token() ? 'unknown' : '')

  return {
    name: 'duffel',
    label: 'Duffel (api.duffel.com)',

    /* Never leaks the token — only whether there is one and which kind. */
    status() {
      const t = token()
      if (!t) return { configured: false, reason: 'DUFFEL_API_TOKEN is not set' }
      return { configured: true, mode: mode(), base: duffelBase(), apiVersion: duffelVersion() }
    },

    async search(spec) {
      const t = token()
      if (!t) return { ok: false, tickets: [], error: 'DUFFEL_API_TOKEN is not set' }
      const { supplier, request } = timeouts()
      const url = `${duffelBase()}/air/offer_requests?return_offers=true&supplier_timeout=${supplier}`
      const started = Date.now()
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${t}`,
            'Duffel-Version': duffelVersion(),
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(offerRequestBody(spec)),
          signal: AbortSignal.timeout(request),
        })
        const text = await res.text()
        let body
        try {
          body = JSON.parse(text)
        } catch {
          return { ok: false, tickets: [], ms: Date.now() - started, error: `Duffel answered HTTP ${res.status} with a body that is not JSON` }
        }
        if (!res.ok) {
          const e = body?.errors?.[0]
          return { ok: false, tickets: [], ms: Date.now() - started, error: `Duffel HTTP ${res.status}: ${e?.title || 'error'}${e?.message ? ` — ${e.message}` : ''}` }
        }
        const offers = body?.data?.offers || []
        return { ok: true, ms: Date.now() - started, offersSeen: offers.length, tickets: offers.map((o) => normalizeOffer(o)).filter(Boolean) }
      } catch (e) {
        // AbortSignal.timeout surfaces as TimeoutError; say which bound was hit,
        // because "raise the timeout" and "the route has no availability" are
        // very different next moves.
        const why = e?.name === 'TimeoutError' ? `no answer within ${request} ms` : String(e?.message || e)
        return { ok: false, tickets: [], ms: Date.now() - started, error: `Duffel request failed: ${why}` }
      }
    },
  }
}

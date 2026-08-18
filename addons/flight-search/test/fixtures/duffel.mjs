/* Duffel-shaped test data, built rather than recorded.
 *
 * `duffel-offer-request.json` beside this file is the one full, real-shaped
 * response — it exists so the adapter's normalisation is asserted against the
 * documented wire format, quirks included (string amounts, offsetless local
 * times, ISO durations, `partial`). The BUILDERS here are for the pipeline
 * tests, where the point is a specific timing or price relationship and a
 * hand-written 200-line JSON per case would hide it.
 *
 * 🔴 NOTHING IN THIS DIRECTORY MAY REACH THE NETWORK. Every adapter in the tests
 * is either a stub or the real one wired to a `fetchImpl` that answers from
 * here, and the whole suite passes on a CI runner with no credentials — which is
 * the rule for an addon (docs/ADDONS.md §5). */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const rawOfferRequest = () => JSON.parse(fs.readFileSync(path.join(HERE, 'duffel-offer-request.json'), 'utf-8'))

/** The airports the builders know about. Real IANA zones — the tz maths under
 *  test is the platform's, so faking a zone would be testing nothing. */
export const AIRPORTS = {
  BER: { iata_code: 'BER', name: 'Berlin Brandenburg', iata_city_code: 'BER', city_name: 'Berlin', time_zone: 'Europe/Berlin' },
  SXF: { iata_code: 'SXF', name: 'Berlin Schönefeld', iata_city_code: 'BER', city_name: 'Berlin', time_zone: 'Europe/Berlin' },
  IST: { iata_code: 'IST', name: 'Istanbul', iata_city_code: 'IST', city_name: 'Istanbul', time_zone: 'Europe/Istanbul' },
  SAW: { iata_code: 'SAW', name: 'Sabiha Gökçen', iata_city_code: 'IST', city_name: 'Istanbul', time_zone: 'Europe/Istanbul' },
  DXB: { iata_code: 'DXB', name: 'Dubai', iata_city_code: 'DXB', city_name: 'Dubai', time_zone: 'Asia/Dubai' },
  HND: { iata_code: 'HND', name: 'Haneda', iata_city_code: 'TYO', city_name: 'Tokyo', time_zone: 'Asia/Tokyo' },
  NRT: { iata_code: 'NRT', name: 'Narita', iata_city_code: 'TYO', city_name: 'Tokyo', time_zone: 'Asia/Tokyo' },
  LAX: { iata_code: 'LAX', name: 'Los Angeles', iata_city_code: 'LAX', city_name: 'Los Angeles', time_zone: 'America/Los_Angeles' },
  ORD: { iata_code: 'ORD', name: "O'Hare", iata_city_code: 'CHI', city_name: 'Chicago', time_zone: 'America/Chicago' },
  // Deliberately zone-less: a source that omits `time_zone` must make the
  // connection UNVERIFIABLE, never optimistically fine.
  XXX: { iata_code: 'XXX', name: 'No Timezone Intl', iata_city_code: 'XXX', city_name: 'Nowhere' },
}

const iso = (min) => `PT${String(Math.floor(min / 60)).padStart(2, '0')}H${String(min % 60).padStart(2, '0')}M`

/** One Duffel segment. Times are LOCAL wall clocks, exactly as Duffel sends. */
export function segment({ from, to, depart, arrive, carrier = 'TK', number = '100', minutes = 0, carryOn = 1, checked = 0, fromTerminal = '', toTerminal = '', operator = null }) {
  return {
    duration: minutes ? iso(minutes) : undefined,
    departing_at: depart,
    arriving_at: arrive,
    origin_terminal: fromTerminal || undefined,
    destination_terminal: toTerminal || undefined,
    marketing_carrier: { iata_code: carrier, name: carrier },
    marketing_carrier_flight_number: number,
    operating_carrier: { iata_code: operator || carrier, name: operator || carrier },
    aircraft: { name: 'Airbus A320' },
    origin: AIRPORTS[from],
    destination: AIRPORTS[to],
    passengers: [
      {
        passenger_id: 'pas_1',
        cabin_class: 'economy',
        baggages: [
          { type: 'carry_on', quantity: carryOn },
          { type: 'checked', quantity: checked },
        ],
      },
    ],
  }
}

/** One Duffel offer: `slices` is a list of segment lists, one per direction. */
export function offer({ id, amount, currency = 'EUR', slices, owner = 'TK', emissions = null, refundable = false, changeable = true, partial = false }) {
  return {
    id,
    partial,
    total_amount: String(amount),
    total_currency: currency,
    base_amount: String(Math.round(amount * 0.8 * 100) / 100),
    tax_amount: String(Math.round(amount * 0.2 * 100) / 100),
    total_emissions_kg: emissions == null ? null : String(emissions),
    expires_at: '2026-08-18T10:00:00.000Z',
    owner: { iata_code: owner, name: owner },
    conditions: {
      change_before_departure: { allowed: changeable, penalty_amount: '80.00', penalty_currency: currency },
      refund_before_departure: { allowed: refundable, penalty_amount: null, penalty_currency: null },
    },
    slices: slices.map((segs) => ({
      duration: undefined,
      fare_brand_name: 'Basic',
      segments: segs,
    })),
  }
}

export const offersResponse = (offers) => ({ data: { id: 'orq_stub', offers } })

/**
 * A `fetchImpl` for the real Duffel adapter that answers from a routing table
 * keyed by `"ORIGIN-DESTINATION"` of the FIRST slice, and records every request
 * it was given. No socket is opened.
 */
export function stubFetch(routes, { status = 200, calls = [] } = {}) {
  const impl = async (url, init) => {
    const body = JSON.parse(init.body)
    const key = `${body.data.slices[0].origin}-${body.data.slices[0].destination}`
    calls.push({ url, headers: init.headers, body: body.data, key })
    const answer = routes[key]
    if (answer === undefined) return new Response(JSON.stringify(offersResponse([])), { status: 200, headers: { 'content-type': 'application/json' } })
    if (typeof answer === 'function') return answer(body)
    return new Response(JSON.stringify(offersResponse(answer)), { status, headers: { 'content-type': 'application/json' } })
  }
  impl.calls = calls
  return impl
}

/**
 * A whole ADAPTER stub — the pipeline tests use this rather than the Duffel one,
 * because they are about the generator, the feasibility check and the front, and
 * routing them through a wire format would only add a way to be wrong.
 */
export function stubAdapter(routes, { name = 'stub', configured = true } = {}) {
  const calls = []
  return {
    name,
    label: `${name} (stub)`,
    calls,
    status: () => (configured ? { configured: true, mode: 'test' } : { configured: false, reason: 'no token in the stub' }),
    async search(spec) {
      const s = spec.slices[0]
      const key = `${s.origin}-${s.destination}`
      calls.push({ key, spec })
      const answer = routes[key]
      if (typeof answer === 'function') return answer(spec)
      return { ok: true, tickets: answer || [] }
    },
  }
}

/* Duffel offers → the neutral `Ticket` shape, through the REAL normaliser. The
 * pipeline stubs answer with these: building tickets by hand would let a test
 * pass against a shape the adapter never actually produces. */
export async function tickets(...offers) {
  const { normalizeOffer } = await import('../../api/adapters/duffel.mjs')
  return offers.map((o) => normalizeOffer(o)).filter(Boolean)
}

/** The production connection floors, so a test that means "the default rules"
 *  says so instead of restating them and drifting from config.mjs. */
export const RULES = { sameTicket: 45, selfTransfer: 150, airportChange: 240, checkedBagExtra: 30, max: 720 }

/**
 * Duffel offers → a scored-ready ITINERARY, through the real assembly.
 *
 * One offer = one ticket covering the whole trip (its slices become the
 * journeys). Two or more = a SPLIT: their segments are concatenated into one
 * journey, which is exactly what `splice` does, so the connection between them
 * has to survive the self-transfer floor here too.
 */
export async function itineraryOf(offers, { wantedChecked = 0, bagFee = 55, rules = RULES, access = {}, label = '' } = {}) {
  const { buildItinerary, buildJourney, journeysOfTicket } = await import('../../api/itinerary.mjs')
  const ts = await tickets(...offers)
  const built = []
  if (ts.length === 1) {
    for (const [i, part] of journeysOfTicket(ts[0]).entries()) {
      const j = buildJourney({ tickets: ts, segments: part.segments, rules, wantedChecked, bagFee, role: i === 0 ? 'outbound' : 'inbound' })
      if (!j.ok) throw new Error(`fixture itinerary is not feasible: ${j.reason}`)
      built.push(j.journey)
    }
  } else {
    const segments = ts.flatMap((t) => journeysOfTicket(t)[0].segments)
    const j = buildJourney({ tickets: ts, segments, rules, wantedChecked, bagFee, role: 'outbound' })
    if (!j.ok) throw new Error(`fixture itinerary is not feasible: ${j.reason}`)
    built.push(j.journey)
  }
  const r = buildItinerary({ journeys: built, access, label })
  if (!r.ok) throw new Error(`fixture itinerary did not build: ${r.reason}`)
  return r.itinerary
}

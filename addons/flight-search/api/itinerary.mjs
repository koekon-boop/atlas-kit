/* ------------------------------------------------------------------ *
 * The internal shape every adapter normalises INTO, and the assembly that turns
 * separately-bookable tickets into one trip.
 *
 * ── THE ADAPTER CONTRACT (what `adapters/*.mjs` must produce) ──────────────
 *
 *   Segment  { origin, destination, departingAt, arrivingAt, marketingCarrier,
 *              operatingCarrier, flightNumber, aircraft, cabinClass,
 *              durationMinutes, baggage:{carryOn,checked} }
 *   Airport  { iata, name, cityCode, cityName, timeZone, terminal }
 *   Ticket   { source, id, price:{total,currency,base,tax}, owner,
 *              journeys:[{segments,durationMinutes,fareBrand}],
 *              baggage, conditions:{changeable,refundable}, emissionsKg,
 *              expiresAt, links }
 *
 * `departingAt` / `arrivingAt` are LOCAL wall clocks with no offset (that is
 * what airline APIs send) and `Airport.timeZone` is the IANA name that makes
 * them arithmetic — see time.mjs for why that separation is not optional.
 *
 * 🔴 SPLIT TICKETS ARE THE REASON THIS FILE EXISTS. Kiwi's Tequila API — the one
 * public source that shipped virtual interlining ready-made — has been closed to
 * new developers since 2026, so the combination has to be built here: two
 * one-way tickets bought from different airlines, joined at a via point, with
 * the traveller carrying every risk the airlines have not agreed to carry. That
 * makes `feasibility()` a safety check, not a formatting step. A connection that
 * clears the same-ticket floor is nowhere near clearing the self-transfer one:
 * on separate tickets you reclaim the bag, walk landside, and check in again
 * against a fresh cut-off, and if the first flight is late nobody rebooks you.
 * ------------------------------------------------------------------ */
import { minutesBetween, knownZone } from './time.mjs'

const sum = (xs) => xs.reduce((a, b) => a + b, 0)
const round2 = (n) => Math.round(n * 100) / 100

/** A stable, order-sensitive id for a set of segments — used to dedupe the
 *  cross product and to name an option in the answer. Deterministic: the same
 *  segments always produce the same key, so tests can assert on it. */
export function segmentsKey(segments) {
  return segments.map((s) => `${s.marketingCarrier?.iata || '??'}${s.flightNumber || '?'}@${s.departingAt}`).join('|')
}

/**
 * The connections between consecutive segments of ONE journey.
 *
 * `minutes` is `null` — never a number — when either airport is missing its
 * timezone: an unverifiable connection has to read as unverifiable all the way
 * to the answer, because every consumer downstream turns this into a go/no-go.
 */
export function connectionsOf(segments) {
  const out = []
  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1]
    const next = segments[i]
    const from = prev.destination || {}
    const to = next.origin || {}
    const changeOfAirport = !!(from.iata && to.iata) && from.iata !== to.iata
    // Unknown city on either side of an airport change is treated as a DIFFERENT
    // city: we cannot show that a ground transfer is even possible, and guessing
    // in the permissive direction is how you strand someone.
    const changeOfCity = changeOfAirport && !(from.cityCode && to.cityCode && from.cityCode === to.cityCode)
    out.push({
      at: to.iata || from.iata || '???',
      fromAirport: from.iata || '???',
      toAirport: to.iata || '???',
      minutes: minutesBetween(prev.arrivingAt, from.timeZone, next.departingAt, to.timeZone),
      sameTicket: prev.ticketId === next.ticketId,
      changeOfAirport,
      changeOfCity,
      changeOfTerminal: !changeOfAirport && !!(from.terminal && to.terminal) && from.terminal !== to.terminal,
      timeZoneKnown: knownZone(from.timeZone) && knownZone(to.timeZone),
    })
  }
  return out
}

/**
 * The floor a given connection has to clear, and whether it does.
 *
 * `hasCheckedBag` matters only across separate tickets: on one ticket the
 * airline through-checks the bag, on two you carry it to the next check-in desk
 * against a cut-off that has nothing to do with your inbound flight.
 */
export function checkConnection(c, rules, hasCheckedBag) {
  if (c.changeOfCity) return { ...c, required: null, ok: false, reason: `${c.fromAirport} → ${c.toAirport} is a different city — no ground transfer this tool can verify` }
  let required = c.sameTicket ? rules.sameTicket : rules.selfTransfer
  if (c.changeOfAirport) required = Math.max(required, rules.airportChange)
  if (!c.sameTicket && hasCheckedBag) required += rules.checkedBagExtra
  if (c.minutes === null) return { ...c, required, ok: false, reason: `cannot verify the connection at ${c.at} — the source gave no timezone for one of the airports` }
  if (c.minutes < required) return { ...c, required, ok: false, reason: `${c.minutes} min at ${c.at} is under the ${required} min floor${c.sameTicket ? '' : ' for a self-transfer'}` }
  if (c.minutes > rules.max) return { ...c, required, ok: false, reason: `${Math.round(c.minutes / 60)} h at ${c.at} is over the ${Math.round(rules.max / 60)} h layover ceiling` }
  return { ...c, required, ok: true, reason: '' }
}

/** Every connection checked; the journey is feasible only if all of them are. */
export function feasibility(connections, rules, hasCheckedBag) {
  const checked = connections.map((c) => checkConnection(c, rules, hasCheckedBag))
  return { ok: checked.every((c) => c.ok), connections: checked, reasons: checked.filter((c) => !c.ok).map((c) => c.reason) }
}

/**
 * One direction of the trip, built from one or more tickets. Returns `null` with
 * a reason rather than an unusable object — an infeasible combination is a
 * normal, countable outcome of the generator, not an error.
 *
 * `wantedChecked` is how many checked bags the traveller asked for; it decides
 * both the connection floor above and the fee estimate below.
 */
export function buildJourney({ tickets, segments, rules, wantedChecked = 0, bagFee = 0, role = 'journey' }) {
  const first = segments[0]
  const last = segments[segments.length - 1]
  if (!first || !last) return { ok: false, reason: 'no segments' }

  const currencies = [...new Set(tickets.map((t) => t.price?.currency).filter(Boolean))]
  if (currencies.length > 1) return { ok: false, reason: `tickets priced in ${currencies.join(' and ')} — this tool will not add prices across currencies` }

  const conn = connectionsOf(segments)
  const singleTicket = new Set(segments.map((s) => s.ticketId)).size <= 1
  const hasCheckedBag = wantedChecked > 0
  const feas = feasibility(conn, rules, hasCheckedBag)
  if (!feas.ok) return { ok: false, reason: feas.reasons[0], reasons: feas.reasons }

  const durationMinutes = minutesBetween(first.departingAt, first.origin?.timeZone, last.arrivingAt, last.destination?.timeZone)
  if (durationMinutes === null || durationMinutes <= 0)
    return { ok: false, reason: `cannot compute the elapsed time of ${first.origin?.iata || '?'} → ${last.destination?.iata || '?'} — a missing or unusable timezone` }

  // Per TICKET, because an extra bag is bought per ticket: two hand-baggage-only
  // one-ways cost the fee twice, which is precisely what makes some split
  // itineraries lose once the real total is compared.
  const missingCheckedBags = sum(tickets.map((t) => Math.max(0, wantedChecked - (t.baggage?.checked ?? 0))))
  const fare = round2(sum(tickets.map((t) => Number(t.price?.total) || 0)))
  const bagFees = round2(missingCheckedBags * bagFee)

  return {
    ok: true,
    journey: {
      role,
      key: segmentsKey(segments),
      segments,
      tickets,
      ticketIds: tickets.map((t) => t.id),
      singleTicket,
      origin: first.origin,
      destination: last.destination,
      departingAt: first.departingAt,
      arrivingAt: last.arrivingAt,
      durationMinutes,
      connections: feas.connections,
      stops: segments.length - 1,
      via: conn.map((c) => c.at),
      splitAt: conn.filter((c) => !c.sameTicket).map((c) => c.at),
      price: { fare, bagFees, total: round2(fare + bagFees), currency: currencies[0] || '' },
      missingCheckedBags,
      baggage: {
        carryOn: Math.min(...tickets.map((t) => t.baggage?.carryOn ?? 0)),
        checked: Math.min(...tickets.map((t) => t.baggage?.checked ?? 0)),
      },
      emissionsKg: tickets.every((t) => t.emissionsKg == null) ? null : round2(sum(tickets.map((t) => t.emissionsKg || 0))),
      carriers: [...new Set(segments.map((s) => s.marketingCarrier?.iata).filter(Boolean))],
      operators: [...new Set(segments.map((s) => s.operatingCarrier?.iata || s.marketingCarrier?.iata).filter(Boolean))],
    },
  }
}

/** Every journey a single ticket covers, tagged with that ticket's id so the
 *  connection check can tell a through-checked change from a self-transfer. */
export function journeysOfTicket(ticket) {
  return (ticket.journeys || []).map((j, i) => ({
    index: i,
    segments: (j.segments || []).map((s) => ({ ...s, ticketId: ticket.id })),
    fareBrand: j.fareBrand || '',
  }))
}

/**
 * Two one-way tickets joined at a via point → one journey, or a reason it does
 * not work. The feasibility check inside `buildJourney` is what decides; this
 * only refuses the shapes that are wrong before any timing question arises.
 */
export function splice({ head, tail, rules, wantedChecked = 0, bagFee = 0, role = 'journey' }) {
  const headJourneys = journeysOfTicket(head)
  const tailJourneys = journeysOfTicket(tail)
  if (headJourneys.length !== 1 || tailJourneys.length !== 1) return { ok: false, reason: 'a split leg must be built from one-way tickets' }
  const a = headJourneys[0].segments
  const b = tailJourneys[0].segments
  if (!a.length || !b.length) return { ok: false, reason: 'a split leg has an empty ticket' }
  if (head.id === tail.id) return { ok: false, reason: 'the same ticket cannot be both halves of a split' }
  return buildJourney({ tickets: [head, tail], segments: [...a, ...b], rules, wantedChecked, bagFee, role })
}

/**
 * The whole trip: one journey per direction the traveller asked for.
 *
 * `access` is the ground time to and from each airport, in minutes, keyed by
 * IATA code. It is what makes a nearby-airport candidate comparable at all — a
 * fare 80 € cheaper out of an airport 90 minutes further away is not 80 € better
 * — and it defaults to 0, in which case the total is honestly gate-to-gate.
 */
export function buildItinerary({ journeys, access = {}, label = '' }) {
  const currencies = [...new Set(journeys.map((j) => j.price.currency).filter(Boolean))]
  if (currencies.length > 1) return { ok: false, reason: `journeys priced in ${currencies.join(' and ')} — this tool will not add prices across currencies` }

  const ground = (code) => Math.max(0, Number(access[code]) || 0)
  const accessMinutes = sum(journeys.map((j) => ground(j.origin?.iata) + ground(j.destination?.iata)))
  const tickets = []
  for (const j of journeys) for (const t of j.tickets) if (!tickets.some((x) => x.id === t.id)) tickets.push(t)
  const connections = journeys.flatMap((j) => j.connections)
  const layovers = connections.map((c) => c.minutes).filter((m) => Number.isFinite(m))

  return {
    ok: true,
    itinerary: {
      /* The flights AND the tickets. Duffel returns the same flights under
       * several fare brands, and those are genuinely different things to buy —
       * different baggage, different change rules, different price — so keying
       * on the flights alone would collapse them and hand back whichever was
       * seen first. */
      key: `${journeys.map((j) => j.key).join('||')}#${tickets.map((t) => t.id).join('+')}`,
      label,
      journeys,
      tickets,
      ticketCount: tickets.length,
      singleTicket: tickets.length === 1,
      sources: [...new Set(tickets.map((t) => t.source))],
      price: {
        fare: round2(sum(journeys.map((j) => j.price.fare))),
        bagFees: round2(sum(journeys.map((j) => j.price.bagFees))),
        total: round2(sum(journeys.map((j) => j.price.total))),
        currency: currencies[0] || '',
      },
      // Travel time, not elapsed trip time: the stay between an outbound and an
      // inbound is the point of the trip, not a cost of it.
      travelMinutes: sum(journeys.map((j) => j.durationMinutes)) + accessMinutes,
      accessMinutes,
      stops: sum(journeys.map((j) => j.stops)),
      connections,
      minConnectionMinutes: layovers.length ? Math.min(...layovers) : null,
      maxConnectionMinutes: layovers.length ? Math.max(...layovers) : null,
      airportChanges: connections.filter((c) => c.changeOfAirport).length,
      terminalChanges: connections.filter((c) => c.changeOfTerminal).length,
      selfTransfers: connections.filter((c) => !c.sameTicket).length,
      missingCheckedBags: sum(journeys.map((j) => j.missingCheckedBags)),
      baggage: {
        carryOn: Math.min(...journeys.map((j) => j.baggage.carryOn)),
        checked: Math.min(...journeys.map((j) => j.baggage.checked)),
      },
      emissionsKg: journeys.every((j) => j.emissionsKg == null) ? null : round2(sum(journeys.map((j) => j.emissionsKg || 0))),
      carriers: [...new Set(journeys.flatMap((j) => j.carriers))],
      operators: [...new Set(journeys.flatMap((j) => j.operators))],
      refundable: tickets.every((t) => t.conditions?.refundable === true) ? true : tickets.some((t) => t.conditions?.refundable === false) ? false : null,
      changeable: tickets.every((t) => t.conditions?.changeable === true) ? true : tickets.some((t) => t.conditions?.changeable === false) ? false : null,
    },
  }
}

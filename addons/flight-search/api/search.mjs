/* ------------------------------------------------------------------ *
 * One question in, a Pareto front out — the pipeline, and nothing else.
 *
 *   normalise → grid (candidate generator) → adapters → assemble → hard filters
 *             → score → Pareto front → champions → an answer written for a model
 *
 * Every stage lives in its own file and this one only wires them together, which
 * is what keeps the seams real: `adapters` is a PARAMETER, so the whole pipeline
 * runs in tests against saved Duffel bodies with no network anywhere, and an
 * Amadeus adapter arrives as one more entry in that list.
 *
 * 🔴 THE ANSWER SAYS WHAT IT DID NOT DO. Calls spent, grid entries dropped for
 * budget, candidates rejected and by which filter, sources that were not
 * configured. A flight search that quietly searched three of the forty date
 * combinations it enumerated, and answers as if it searched all forty, is worse
 * than no search — the reader cannot tell "nothing better exists" from "we did
 * not look". Same rule core's search legs follow: "did not run" and "ran and
 * found nothing" are different facts (docs/ADDONS.md).
 * ------------------------------------------------------------------ */
import { buildGrid } from './grid.mjs'
import { buildItinerary, buildJourney, journeysOfTicket, splice } from './itinerary.mjs'
import { hardFilter, scoreAll } from './score.mjs'
import { champions, paretoFront } from './pareto.mjs'
import { adapterStatus, configuredAdapters, loadAdapters } from './adapters/index.mjs'
import { bagFeeEstimate, connectionRules, limits, SETUP_HINT } from './config.mjs'
import { humanMinutes, localDate, parseClock } from './time.mjs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const IATA_RE = /^[A-Z]{3}$/

/* ⚠️ `Number(null)` is 0 and `Number('')` is 0, so a plain `Number.isFinite`
 * turns an ABSENT ceiling into a ceiling of zero — a `maxPrice` nobody set that
 * rejects every candidate. Absent has to stay absent. */
const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** `"BER"` or `{code,groundMinutes}` or a list of either → the generator's end
 *  shape. The first entry is the primary; order is preserved because the grid
 *  ranks by it. */
function ends(v, field, errors) {
  const list = (Array.isArray(v) ? v : [v]).filter((x) => x != null && x !== '')
  const out = []
  for (const item of list) {
    const code = String(typeof item === 'string' ? item : item?.code || '').trim().toUpperCase()
    if (!IATA_RE.test(code)) {
      errors.push(`${field}: "${code || item}" is not a 3-letter IATA airport code`)
      continue
    }
    out.push({ code, groundMinutes: Math.max(0, Number(typeof item === 'object' ? item.groundMinutes : 0) || 0) })
  }
  return out
}

const window = (v, field, errors) => {
  if (!v) return null
  const from = parseClock(v.from ?? v[0])
  const to = parseClock(v.to ?? v[1])
  if (from == null || to == null) {
    errors.push(`${field}: expected {from:"HH:MM", to:"HH:MM"}`)
    return null
  }
  return [from, to]
}
const asClockRange = (w) => (w ? { from: clock(w[0]), to: clock(w[1]) } : undefined)
const clock = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

/**
 * The tool's input → the shape every stage below expects, plus the list of
 * things that are wrong with it.
 *
 * Validation is a trust boundary here even though the caller is a model: a
 * malformed date silently becoming `NaN` days of grid is how a call budget gets
 * spent on nothing.
 */
export function normalizeRequest(input = {}) {
  const errors = []
  const origins = ends(input.origin, 'origin', errors)
  const destinations = ends(input.destination, 'destination', errors)
  if (!origins.length) errors.push('origin is required')
  if (!destinations.length) errors.push('destination is required')

  const departureDate = String(input.departureDate || '').trim()
  if (!DATE_RE.test(departureDate)) errors.push('departureDate is required, as YYYY-MM-DD')
  const returnDate = String(input.returnDate || '').trim()
  if (returnDate && !DATE_RE.test(returnDate)) errors.push('returnDate must be YYYY-MM-DD')

  const tripDayRange = Array.isArray(input.tripDayRange) && input.tripDayRange.length === 2 ? input.tripDayRange.map(Number) : null
  if (tripDayRange && tripDayRange.some((n) => !Number.isFinite(n) || n < 1)) errors.push('tripDayRange must be two positive day counts, e.g. [10, 14]')
  // A flexible stay length is meaningless without a return leg to move, and
  // silently ignoring it would hide that the search never varied anything.
  if (tripDayRange && !returnDate) errors.push('tripDayRange needs a returnDate to anchor the round trip')

  const departureWindow = window(input.departureWindow, 'departureWindow', errors)
  const arrivalWindow = window(input.arrivalWindow, 'arrivalWindow', errors)
  const returnDepartureWindow = window(input.returnDepartureWindow, 'returnDepartureWindow', errors)
  const returnArrivalWindow = window(input.returnArrivalWindow, 'returnArrivalWindow', errors)

  const journeys = [
    { role: 'outbound', origins, destinations, date: departureDate, departureTime: asClockRange(departureWindow), arrivalTime: asClockRange(arrivalWindow) },
  ]
  if (returnDate)
    journeys.push({ role: 'inbound', origins: destinations, destinations: origins, date: returnDate, departureTime: asClockRange(returnDepartureWindow), arrivalTime: asClockRange(returnArrivalWindow) })

  const wantedChecked = Math.max(0, Math.min(3, Math.floor(numOrNull(input.checkedBags) || 0)))
  const rules = connectionRules()
  // A caller-supplied floor may only ever be RAISED. "45 minutes is fine for me"
  // is not a thing a tool should agree to on a self-transfer.
  const minConn = numOrNull(input.minConnectionMinutes)
  if (minConn != null) {
    rules.sameTicket = Math.max(rules.sameTicket, minConn)
    rules.selfTransfer = Math.max(rules.selfTransfer, minConn)
    rules.airportChange = Math.max(rules.airportChange, minConn)
  }
  const maxConn = numOrNull(input.maxConnectionMinutes)
  if (maxConn != null) rules.max = Math.max(30, maxConn)

  const lim = limits()
  return {
    errors,
    request: {
      journeys,
      roundTrip: journeys.length === 2,
      tripDayRange,
      dateFlexDays: Math.max(0, Math.floor(numOrNull(input.dateFlexDays) || 0)),
      via: (input.via || []).map((v) => String(v).trim().toUpperCase()).filter((v) => IATA_RE.test(v)),
      allowSplitTickets: input.allowSplitTickets !== false,
      cabin: ['economy', 'premium_economy', 'business', 'first'].includes(input.cabin) ? input.cabin : 'economy',
      maxConnections: numOrNull(input.maxConnections) == null ? 1 : Math.max(0, Math.min(2, numOrNull(input.maxConnections))),
      passengers: { adults: Math.max(1, Math.min(9, Math.floor(numOrNull(input.adults) || 1))), childAges: Array.isArray(input.childAges) ? input.childAges : [] },
      wantedChecked,
      rules,
      maxAdapterCalls: Math.max(1, Math.min(60, Math.floor(numOrNull(input.maxAdapterCalls) || lim.adapterCalls))),
      maxResults: Math.max(1, Math.min(10, Math.floor(numOrNull(input.maxResults) || lim.results))),
      weights: input.weights || {},
      filters: {
        maxPrice: numOrNull(input.maxPrice),
        maxStops: numOrNull(input.maxStops),
        maxTravelMinutes: numOrNull(input.maxTravelHours) == null ? null : numOrNull(input.maxTravelHours) * 60,
        requireSingleTicket: !!input.requireSingleTicket,
        requireCheckedBag: !!input.requireCheckedBag && wantedChecked > 0,
        departureWindow,
        arrivalWindow: arrivalWindow || (input.noArrivalAfter ? [0, parseClock(input.noArrivalAfter) ?? 1439] : null),
        avoidAirlines: (input.avoidAirlines || []).map((s) => String(s).trim().toUpperCase()).filter(Boolean),
      },
      prefs: {
        preferAirlines: (input.preferAirlines || []).map((s) => String(s).trim().toUpperCase()).filter(Boolean),
        preferDepartureWindow: window(input.preferDepartureWindow, 'preferDepartureWindow', errors),
        preferArrivalWindow: window(input.preferArrivalWindow, 'preferArrivalWindow', errors),
      },
      access: Object.fromEntries([...origins, ...destinations].filter((e) => e.groundMinutes).map((e) => [e.code, e.groundMinutes])),
    },
  }
}

/** The answer when there is no source to ask. Not an error: an unconfigured
 *  addon is the default state of this one, and the reply's whole job is to tell
 *  the operator the two things they have to do about it. */
export function notConfiguredAnswer(sources) {
  return {
    ok: false,
    reason: 'no flight source is configured on this box, so no search was run',
    sources,
    howToEnable: SETUP_HINT,
    options: [],
  }
}

/* One spec's tickets, from EVERY source that answered it. Two configured
 * adapters produce two results per spec, and a plain `id → result` map would
 * silently keep whichever ran last — so they are merged, which is also what
 * makes a split between two different sources possible at all. */
const bySpecId = (results) => {
  const out = {}
  for (const r of results) (out[r.spec.id] ||= { tickets: [] }).tickets.push(...(r.tickets || []))
  return out
}

/* Every ticket a spec's answer contributed, in a stable order (cheapest first,
 * then by id) and capped — a busy route returns hundreds of near-identical
 * offers and scoring all of them buys nothing the cheap prefilter does not. */
const ticketsOf = (result, cap) =>
  [...(result?.tickets || [])].sort((a, b) => a.price.total - b.price.total || String(a.id).localeCompare(String(b.id))).slice(0, cap)

/**
 * Run one search.
 *
 * `adapters` is injected in tests; in production `register()` passes the ones
 * `loadAdapters()` built. `now` is only used to date the answer.
 */
export async function searchFlights(input, { adapters = loadAdapters(), now = () => new Date() } = {}) {
  const sources = adapterStatus(adapters)
  const { errors, request } = normalizeRequest(input)
  if (errors.length) return { ok: false, reason: 'the request could not be used as given', problems: errors, sources, options: [] }

  const usable = configuredAdapters(adapters)
  if (!usable.length) return notConfiguredAnswer(sources)

  const lim = limits()
  const bagFee = bagFeeEstimate()
  const rules = request.rules
  // The budget is TOTAL calls, so a second configured source halves what each
  // one may spend rather than doubling the bill.
  const perAdapter = Math.max(1, Math.floor(request.maxAdapterCalls / usable.length))
  const grid = buildGrid({ ...request, maxAdapterCalls: perAdapter })

  /* Groups run one after another; the specs INSIDE a group run together. That
   * is at most two requests in flight (a split's head and its tail), which
   * halves the latency of the one case where both halves are useless alone and
   * keeps the load on the supplier at roughly one search at a time. A wide grid
   * is therefore also a SLOW grid — `maxAdapterCalls` is the dial for the money
   * and the minutes, and it is the same dial on purpose. */
  const results = []
  const searchErrors = []
  for (const group of grid.groups) {
    const batch = group.specs.flatMap((spec) => usable.map((adapter) => ({ spec, adapter })))
    for (const { spec, adapter, r } of await Promise.all(batch.map(async (b) => ({ ...b, r: await b.adapter.search(b.spec) })))) {
      if (!r.ok) searchErrors.push({ source: adapter.name, spec: spec.why, error: r.error })
      results.push({ spec, source: adapter.name, ...r })
    }
  }
  const calls = results.length
  const ticketsSeen = results.reduce((n, r) => n + (r.tickets?.length || 0), 0)

  /* ---- assembly ------------------------------------------------------------
   * Two families of candidate, and they are not interchangeable. A whole-trip
   * offer is ONE ticket covering every direction — the only way to get a return
   * on a single ticket. Everything else is composed here, per journey, and then
   * crossed. */
  const itineraries = []
  const assemblyRejects = []
  const seen = new Set()
  const push = (built) => {
    if (!built.ok) return assemblyRejects.push(built.reason)
    if (seen.has(built.itinerary.key)) return
    seen.add(built.itinerary.key)
    itineraries.push(built.itinerary)
  }

  for (const r of results.filter((x) => x.spec.kind === 'trip')) {
    for (const ticket of ticketsOf(r, lim.ticketsPerCall)) {
      const parts = journeysOfTicket(ticket)
      if (parts.length !== request.journeys.length) continue // an answer that is not the trip we asked for
      const journeys = []
      let bad = null
      for (const [i, p] of parts.entries()) {
        const j = buildJourney({ tickets: [ticket], segments: p.segments, rules, wantedChecked: request.wantedChecked, bagFee, role: request.journeys[i].role })
        if (!j.ok) { bad = j.reason; break }
        journeys.push(j.journey)
      }
      if (bad) { assemblyRejects.push(bad); continue }
      push(buildItinerary({ journeys, access: request.access, label: r.spec.why }))
    }
  }

  /* Per-journey options: a plain one-way, or a virtual interline built from a
   * head and a tail bought separately. `splice` is where the connection has to
   * survive the self-transfer floor, so an impossible combination never becomes
   * a candidate — it becomes a counted rejection. */
  const perJourney = request.journeys.map(() => [])
  for (const r of results.filter((x) => x.spec.kind === 'leg' && x.spec.splitRole === 'oneway')) {
    for (const ticket of ticketsOf(r, lim.ticketsPerCall)) {
      const parts = journeysOfTicket(ticket)
      if (parts.length !== 1) continue
      const j = buildJourney({ tickets: [ticket], segments: parts[0].segments, rules, wantedChecked: request.wantedChecked, bagFee, role: r.spec.role })
      if (j.ok) perJourney[r.spec.journeyIndex].push(j.journey)
      else assemblyRejects.push(j.reason)
    }
  }
  const legs = bySpecId(results.filter((x) => x.spec.kind === 'leg'))
  for (const group of grid.groups) {
    const [head, tail] = group.specs
    if (group.specs.length !== 2 || head?.splitRole !== 'head' || tail?.splitRole !== 'tail') continue
    // The pairwise product of two answers is the second place the combinatorics
    // can run away — 40 heads x 40 tails is 1600 feasibility checks per via
    // point — so it is capped, and the cap is on FEASIBLE pairs kept.
    let made = 0
    pairs: for (const a of ticketsOf(legs[head.id], lim.ticketsPerCall)) {
      for (const b of ticketsOf(legs[tail.id], lim.ticketsPerCall)) {
        if (made >= lim.splitsPerVia) break pairs
        const j = splice({ head: a, tail: b, rules, wantedChecked: request.wantedChecked, bagFee, role: head.role })
        if (j.ok) { perJourney[head.journeyIndex].push(j.journey); made++ }
        else assemblyRejects.push(j.reason)
      }
    }
  }

  /* The cross product, bounded twice: each journey keeps its cheapest N options,
   * and the product itself is cut at `limits().itineraries`. */
  const kept = perJourney.map((opts) =>
    [...opts].sort((a, b) => a.price.total - b.price.total || a.key.localeCompare(b.key)).slice(0, lim.optionsPerJourney),
  )
  for (const combo of cross(kept, lim.itineraries)) {
    // A round trip has to end where it started; otherwise the "alternate airport"
    // freedom silently leaves your car at the wrong one.
    if (request.roundTrip && combo[combo.length - 1].destination?.iata !== combo[0].origin?.iata) continue
    push(buildItinerary({ journeys: combo, access: request.access, label: combo.some((j) => !j.singleTicket) ? 'self-transfer combination' : 'separate one-way tickets' }))
  }

  /* ---- filter, score, front ------------------------------------------------ */
  const rejected = new Map()
  const survivors = []
  for (const itin of itineraries) {
    const f = hardFilter(itin, request.filters)
    if (f.pass) survivors.push(itin)
    else for (const r of f.reasons) rejected.set(r, (rejected.get(r) || 0) + 1)
  }
  for (const r of assemblyRejects) rejected.set(r, (rejected.get(r) || 0) + 1)

  const scored = scoreAll(survivors, { weights: request.weights, prefs: request.prefs, rules })
  const front = paretoFront(scored)
  const rows = champions(front, { max: request.maxResults })

  return {
    ok: true,
    generatedAt: now().toISOString(),
    query: describeQuery(request),
    sources,
    search: {
      adapterCalls: calls,
      callBudget: request.maxAdapterCalls,
      gridEnumerated: grid.enumerated,
      gridDropped: grid.dropped,
      searchesRun: grid.groups.flatMap((g) => g.specs.map((s) => s.why)),
      ticketsSeen,
      errors: searchErrors,
    },
    considered: {
      itinerariesBuilt: itineraries.length,
      passedHardFilters: survivors.length,
      onParetoFront: front.length,
      returned: rows.length,
    },
    rejected: [...rejected.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([reason, count]) => ({ reason, count })),
    scoring: { note: 'score is 0–100 and LOWER IS BETTER; every penalty is 0 (ideal) to 1 (worst in this set)', weights: request.weights },
    options: rows.map((row, i) => renderOption(row, i, request)),
    notes: notes(request, grid, front),
  }
}

/** Cartesian product with a hard ceiling on the RESULT, applied while building
 *  rather than after: the point of a cap is never to materialise the thing it is
 *  capping. Inputs are pre-sorted cheapest-first, so a cut keeps the cheap end. */
function cross(lists, cap) {
  if (lists.some((l) => !l.length)) return []
  let out = [[]]
  for (const list of lists) {
    const next = []
    for (const prefix of out) for (const item of list) if (next.length < cap) next.push([...prefix, item])
    out = next
  }
  return out
}

const describeQuery = (r) => ({
  trip: r.roundTrip ? 'return' : r.journeys.length > 1 ? 'multi-city' : 'one-way',
  legs: r.journeys.map((j) => `${j.origins.map((o) => o.code).join('/')} → ${j.destinations.map((d) => d.code).join('/')} on ${j.date}`),
  dateFlexDays: r.dateFlexDays,
  tripDayRange: r.tripDayRange,
  via: r.via,
  cabin: r.cabin,
  passengers: r.passengers,
  checkedBags: r.wantedChecked,
  splitTicketsAllowed: r.allowSplitTickets,
  connectionFloors: { sameTicket: r.rules.sameTicket, selfTransfer: r.rules.selfTransfer, airportChange: r.rules.airportChange, ceiling: r.rules.max },
})

const segLine = (s) =>
  `${s.flightNumber} ${s.origin.iata}${s.origin.terminal ? `/T${s.origin.terminal}` : ''} ${s.departingAt.slice(11, 16)} → ` +
  `${s.destination.iata}${s.destination.terminal ? `/T${s.destination.terminal}` : ''} ${s.arrivingAt.slice(11, 16)}` +
  ` (${humanMinutes(s.durationMinutes)}${s.operatingCarrier.iata !== s.marketingCarrier.iata ? `, operated by ${s.operatingCarrier.name || s.operatingCarrier.iata}` : ''})`

const verifyUrl = (ticket) => {
  const first = ticket.journeys[0]?.segments?.[0]
  const lastJourney = ticket.journeys[ticket.journeys.length - 1]
  const last = lastJourney?.segments?.[lastJourney.segments.length - 1]
  if (!first || !last) return ''
  const a = first.origin.iata
  const b = ticket.journeys[0].segments[ticket.journeys[0].segments.length - 1].destination.iata
  const d1 = localDate(first.departingAt)
  const q = ticket.journeys.length > 1 ? `Flights from ${a} to ${b} on ${d1} through ${localDate(lastJourney.segments[0].departingAt)}` : `One way flights from ${a} to ${b} on ${d1}`
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`
}

function renderOption({ itinerary: it, wins, why, tradeoffs }, i, request) {
  return {
    rank: i + 1,
    wins,
    why,
    tradeoffs,
    // Which point of the search grid this came from — the answer to "did you
    // even look at the Tuesday?" without re-reading `search.searchesRun`.
    foundBy: it.label,
    summary:
      `${it.price.total.toFixed(2)} ${it.price.currency} · ${humanMinutes(it.travelMinutes)} travelling · ` +
      `${it.stops === 0 ? 'nonstop' : `${it.stops} stop(s)`} · ${it.ticketCount === 1 ? 'one ticket' : `${it.ticketCount} separate tickets`}` +
      `${it.selfTransfers ? ` · ${it.selfTransfers} self-transfer(s)` : ''}`,
    price: {
      total: it.price.total,
      currency: it.price.currency,
      fare: it.price.fare,
      estimatedBagFees: it.price.bagFees,
      note: it.price.bagFees ? `includes an ESTIMATED ${it.price.bagFees} ${it.price.currency} for ${it.missingCheckedBags} checked bag(s) the fare excludes — confirm with the airline before booking` : 'fare includes the requested baggage',
    },
    travel: { total: humanMinutes(it.travelMinutes), minutes: it.travelMinutes, groundAccessMinutes: it.accessMinutes },
    stops: it.stops,
    tickets: { count: it.ticketCount, single: it.singleTicket, selfTransfers: it.selfTransfers },
    baggage: it.baggage,
    emissionsKg: it.emissionsKg,
    conditions: { refundable: it.refundable, changeable: it.changeable },
    journeys: it.journeys.map((j) => ({
      role: j.role,
      route: `${j.origin.iata} → ${j.destination.iata}`,
      departs: j.departingAt,
      arrives: j.arrivingAt,
      arrivesOnDayOffset: dayOffset(j.departingAt, j.arrivingAt),
      duration: humanMinutes(j.durationMinutes),
      carriers: j.carriers,
      segments: j.segments.map(segLine),
      connections: j.connections.map((c) => ({
        at: c.at,
        wait: humanMinutes(c.minutes),
        minutes: c.minutes,
        sameTicket: c.sameTicket,
        note: [
          c.sameTicket ? 'through-checked by the airline' : 'SELF-TRANSFER: collect the bag, check in again, and carry the delay risk yourself',
          c.changeOfAirport ? `airport change ${c.fromAirport} → ${c.toAirport}` : c.changeOfTerminal ? 'terminal change' : '',
        ].filter(Boolean).join('; '),
      })),
    })),
    booking: {
      how:
        it.ticketCount === 1
          ? 'One Duffel offer. Duffel offers are ordered through its API (POST /air/orders), not on a web page, and they expire — re-run the search before booking.'
          : `${it.ticketCount} SEPARATE orders, bought independently. Nobody protects the connection: if the first is late you rebuy the next at your own cost. Book the tight one first.`,
      tickets: it.tickets.map((t) => ({ source: t.source, offerId: t.id, price: `${t.price.total} ${t.price.currency}`, owner: t.owner.name || t.owner.iata, expiresAt: t.expiresAt, verifyUrl: verifyUrl(t) })),
    },
    score: it.score,
    penalties: it.penalties,
  }
}

const dayOffset = (from, to) => {
  const a = Date.parse(`${localDate(from)}T00:00:00Z`)
  const b = Date.parse(`${localDate(to)}T00:00:00Z`)
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86400000) : 0
}

function notes(request, grid, front) {
  const out = []
  if (grid.dropped) out.push(`${grid.dropped} of ${grid.enumerated} enumerated searches were dropped to stay inside the ${request.maxAdapterCalls}-call budget — raise maxAdapterCalls to widen the grid.`)
  if (request.allowSplitTickets && !request.via.length) out.push('No via points were given, so the only split tickets considered were separate one-ways on the same route. Pass `via: ["IST","DXB"]` to have real self-transfer combinations built.')
  if (!front.length) out.push('Nothing survived. Check `rejected` — a single hard filter usually accounts for most of it.')
  out.push('Prices, availability and baggage rules change between a search and a booking. Everything here is a lead to verify with the airline, not a reservation.')
  return out
}

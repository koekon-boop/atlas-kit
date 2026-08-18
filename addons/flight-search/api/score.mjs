/* ------------------------------------------------------------------ *
 * HARD FILTERS first, then a weighted utility over what survives.
 *
 * The order is the design. A filter is a thing the traveller will not do at any
 * price — landing at 01:40, flying an airline they refuse to fly, a 35-minute
 * self-transfer — and folding those into a score means a big enough discount
 * eventually buys them. So they are applied first, they are counted, and the
 * count is reported: "38 of 214 dropped for arriving after 23:00" is the single
 * most useful sentence this tool can say when the answer looks thin.
 *
 * 🔴 THE PRICE THAT IS SCORED IS THE PRICE YOU PAY. A hand-baggage-only headline
 * fare and a full-service fare are not comparable numbers, and ranking on the
 * headline is how a search engine sells you the worse trip. `price.total` here
 * is fare + the estimated cost of the baggage the traveller ASKED FOR, charged
 * per ticket — which is exactly what makes some split itineraries lose: two
 * one-ways means paying the bag fee twice. The estimate is labelled as one
 * everywhere it surfaces (see config.mjs for why it is an estimate at all).
 *
 * Penalties are absolute wherever an absolute meaning exists (two stops is two
 * stops) and relative to the candidate set only where it does not (price,
 * duration, CO₂ — 900 € is cheap or dear only against the alternatives). Every
 * per-dimension penalty is returned alongside the score, because the Pareto
 * output has to be able to say WHY, and a bare number cannot.
 * ------------------------------------------------------------------ */
import { localMinuteOfDay } from './time.mjs'

/** Lower is better on every one of these. */
export const DEFAULT_WEIGHTS = {
  price: 1,
  duration: 0.6,
  stops: 0.3,
  connectionRisk: 0.5, // a connection close to its own floor
  connectionWaste: 0.25, // …and one you will spend half a day in
  airportChange: 0.4,
  terminalChange: 0.1,
  ticketRisk: 0.7, // separate tickets: a delay is YOUR problem, not the airline's
  baggage: 0.3,
  departureWindow: 0.3,
  arrivalWindow: 0.3,
  airline: 0.2,
  emissions: 0.1,
}

/* Where "comfortable" sits, in minutes. Above the floor by this much and a
 * connection stops being a risk; above `COMFORT_MAX` it starts being a waiting
 * room. Both are opinions, so both are named rather than inlined. */
const RISK_BUFFER = 90
const COMFORT_MAX = 240
const WINDOW_TOLERANCE = 180

const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0)
const r3 = (n) => Math.round(n * 1000) / 1000

/** Caller weights merged over the defaults: unknown keys ignored, values clamped
 *  to 0–10. A weight of 0 switches a dimension off, which is a legitimate ask
 *  ("I do not care what it costs") and must not divide by zero downstream. */
export function resolveWeights(given) {
  const out = { ...DEFAULT_WEIGHTS }
  for (const [k, v] of Object.entries(given || {})) {
    if (!(k in DEFAULT_WEIGHTS)) continue
    const n = Number(v)
    if (Number.isFinite(n)) out[k] = Math.min(10, Math.max(0, n))
  }
  return out
}

/** The raw numbers a filter or a Pareto dimension reads off an itinerary. */
export function measure(itin) {
  const firstJourney = itin.journeys[0]
  const lastJourney = itin.journeys[itin.journeys.length - 1]
  return {
    price: itin.price.total,
    currency: itin.price.currency,
    travelMinutes: itin.travelMinutes,
    stops: itin.stops,
    ticketCount: itin.ticketCount,
    selfTransfers: itin.selfTransfers,
    airportChanges: itin.airportChanges,
    terminalChanges: itin.terminalChanges,
    minConnectionMinutes: itin.minConnectionMinutes,
    maxConnectionMinutes: itin.maxConnectionMinutes,
    missingCheckedBags: itin.missingCheckedBags,
    departMinute: localMinuteOfDay(firstJourney.departingAt),
    arriveMinute: localMinuteOfDay(lastJourney.arrivingAt),
    emissionsKg: itin.emissionsKg,
    carriers: itin.carriers,
    operators: itin.operators,
  }
}

/* A window is `[fromMinute, toMinute]` past local midnight and may WRAP — "no
 * arrival after 23:00" is `[0, 1380]`, but "arrive in the evening" is
 * `[1020, 1380]` and "the red-eye is fine" is `[1320, 360]`. Wrapping is why
 * this is not a pair of comparisons. */
const inWindow = (minute, [from, to]) => (from <= to ? minute >= from && minute <= to : minute >= from || minute <= to)
const distanceToWindow = (minute, [from, to]) => {
  if (inWindow(minute, [from, to])) return 0
  const d = (a, b) => Math.min(Math.abs(a - b), 1440 - Math.abs(a - b))
  return Math.min(d(minute, from), d(minute, to))
}

/**
 * Everything the traveller will not do at any price.
 *
 * The connection FLOORS are not here: they are enforced in `itinerary.mjs` at
 * assembly time, because an infeasible connection must never become an object
 * that something later could rank. What is here is everything that needs the
 * whole trip in view.
 */
export function hardFilter(itin, f) {
  const m = measure(itin)
  const fail = []
  if (f.maxPrice != null && m.price > f.maxPrice) fail.push(`${m.price} ${m.currency} is over the ${f.maxPrice} ceiling`)
  if (f.maxStops != null && m.stops > f.maxStops) fail.push(`${m.stops} stop(s), over the ${f.maxStops} allowed`)
  if (f.maxTravelMinutes != null && m.travelMinutes > f.maxTravelMinutes) fail.push(`${Math.round(m.travelMinutes / 60)} h of travel, over the ${Math.round(f.maxTravelMinutes / 60)} h ceiling`)
  if (f.requireSingleTicket && m.ticketCount > 1) fail.push('separate tickets, and one ticket was required')
  if (f.requireCheckedBag && m.missingCheckedBags > 0) fail.push('the fare does not include the checked bag that was required')
  if (f.departureWindow && m.departMinute != null && !inWindow(m.departMinute, f.departureWindow)) fail.push(`departs at ${clock(m.departMinute)}, outside the requested departure window`)
  if (f.arrivalWindow && m.arriveMinute != null && !inWindow(m.arriveMinute, f.arrivalWindow)) fail.push(`arrives at ${clock(m.arriveMinute)}, outside the requested arrival window`)
  if (f.avoidAirlines?.length) {
    const hit = [...new Set([...m.carriers, ...m.operators])].filter((c) => f.avoidAirlines.includes(c))
    if (hit.length) fail.push(`flown by ${hit.join(', ')}, which is on the avoid list`)
  }
  return { pass: fail.length === 0, reasons: fail }
}

const clock = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

/* Min–max over the set, for the dimensions where "good" has no absolute
 * meaning. A set where every candidate ties gets 0 rather than NaN: if every
 * option costs the same, price is not a reason to prefer any of them. */
const normalizer = (values) => {
  const nums = values.filter((v) => Number.isFinite(v))
  if (!nums.length) return () => 0
  const lo = Math.min(...nums)
  const hi = Math.max(...nums)
  return (v) => (!Number.isFinite(v) || hi === lo ? 0 : (v - lo) / (hi - lo))
}

/**
 * Score every candidate. Returns the same objects with `score` (0–100, LOWER is
 * better) and `penalties` attached — the per-dimension breakdown is not
 * debugging output, it is what the answer's reasoning is written from.
 */
export function scoreAll(itineraries, { weights, prefs = {}, rules }) {
  const w = resolveWeights(weights)
  const measures = itineraries.map(measure)
  const normPrice = normalizer(measures.map((m) => m.price))
  const normDuration = normalizer(measures.map((m) => m.travelMinutes))
  const normEmissions = normalizer(measures.map((m) => m.emissionsKg))
  const totalWeight = Object.values(w).reduce((a, b) => a + b, 0) || 1

  return itineraries.map((itin, i) => {
    const m = measures[i]
    const risk = itin.connections.length
      ? Math.max(...itin.connections.map((c) => clamp01(((c.required ?? rules.sameTicket) + RISK_BUFFER - c.minutes) / RISK_BUFFER)))
      : 0
    const waste = itin.connections.length
      ? Math.max(...itin.connections.map((c) => clamp01((c.minutes - COMFORT_MAX) / Math.max(1, rules.max - COMFORT_MAX))))
      : 0
    const preferred = prefs.preferAirlines?.length
      ? clamp01(1 - m.carriers.filter((c) => prefs.preferAirlines.includes(c)).length / Math.max(1, m.carriers.length))
      : 0

    const penalties = {
      price: r3(normPrice(m.price)),
      duration: r3(normDuration(m.travelMinutes)),
      stops: r3(clamp01(m.stops / 3)),
      connectionRisk: r3(risk),
      connectionWaste: r3(waste),
      airportChange: r3(clamp01(m.airportChanges)),
      terminalChange: r3(clamp01(m.terminalChanges / 2)),
      ticketRisk: r3(clamp01((m.ticketCount - 1) / 2)),
      baggage: r3(clamp01(m.missingCheckedBags / Math.max(1, m.ticketCount))),
      departureWindow: r3(prefs.preferDepartureWindow && m.departMinute != null ? clamp01(distanceToWindow(m.departMinute, prefs.preferDepartureWindow) / WINDOW_TOLERANCE) : 0),
      arrivalWindow: r3(prefs.preferArrivalWindow && m.arriveMinute != null ? clamp01(distanceToWindow(m.arriveMinute, prefs.preferArrivalWindow) / WINDOW_TOLERANCE) : 0),
      airline: r3(preferred),
      emissions: r3(normEmissions(m.emissionsKg)),
    }
    const score = Object.entries(penalties).reduce((acc, [k, v]) => acc + v * w[k], 0) / totalWeight
    return { ...itin, measure: m, penalties, score: Math.round(score * 1000) / 10 }
  })
}

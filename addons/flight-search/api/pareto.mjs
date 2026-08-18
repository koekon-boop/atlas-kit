/* ------------------------------------------------------------------ *
 * The ANSWER SHAPE: a Pareto front, not a winner.
 *
 * "Cheapest" is a question a portal already answers, and answering it again is
 * worth nothing. The useful answer is the small set of trips where you cannot
 * improve one thing without giving up another — and then, for each, what it wins
 * and what that win costs.
 *
 * 🔴 DOMINATED VARIANTS ARE DISCARDED, NOT RANKED LOWER. If another option is at
 * least as good on price, on total travel time, on connection comfort AND on the
 * number of tickets, and strictly better on one of them, this one is not a
 * trade-off — it is simply worse, and putting it on the list wastes the reader's
 * only scarce resource. That is the whole reason the answer is 3–5 rows instead
 * of 40.
 *
 * FOUR dimensions, deliberately — the four the traveller actually trades between
 * (see PARETO_DIMS). Adding a fifth and a sixth is tempting and is how a Pareto
 * front degenerates into "everything is non-dominated": with enough axes, every
 * candidate wins something. Price, time, comfort, and how much of the risk you
 * are carrying yourself. Everything else lives in the weighted score, which
 * picks the RECOMMENDATION from inside the front.
 * ------------------------------------------------------------------ */
import { humanMinutes } from './time.mjs'

const EPS = 1e-9

/** Lower is better on all four. `discomfort` folds the connection penalties the
 *  scorer already computed — they are absolute (a floor plus an opinion about
 *  comfort), not set-relative, so they are safe to compare across candidates. */
export const PARETO_DIMS = [
  { key: 'price', label: 'price', get: (i) => i.price.total },
  { key: 'travel', label: 'total travel time', get: (i) => i.travelMinutes },
  { key: 'discomfort', label: 'connection comfort', get: (i) => i.penalties.connectionRisk + i.penalties.connectionWaste + 0.5 * i.penalties.airportChange },
  { key: 'tickets', label: 'tickets to book', get: (i) => i.ticketCount },
]

const dominates = (a, b) => {
  let strictly = false
  for (const d of PARETO_DIMS) {
    const x = d.get(a)
    const y = d.get(b)
    if (x > y + EPS) return false
    if (x < y - EPS) strictly = true
  }
  return strictly
}

/**
 * The non-dominated set, in the input's order.
 *
 * O(n²) on purpose: `n` is the scored candidate count, which the generator's own
 * budget already bounds to the low hundreds, and a sweep-line version of this
 * would be four dimensions of fiddly for microseconds nobody is waiting on.
 */
export function paretoFront(itineraries) {
  return itineraries.filter((a) => !itineraries.some((b) => b !== a && dominates(b, a)))
}

/* The champions, in the order they are offered. `bestOverall` leads because it
 * is the recommendation; the rest are the corners of the front, so the reader
 * can see the shape of the trade rather than one opinion about it. Every one is
 * picked from INSIDE the front, which is what keeps "dominated variants are
 * discarded" true of the answer and not just of an intermediate list. */
const CHAMPIONS = [
  { key: 'bestOverall', label: 'best overall', pick: (rows) => best(rows, (i) => i.score) },
  { key: 'cheapest', label: 'cheapest', pick: (rows) => best(rows, (i) => i.price.total) },
  { key: 'fastest', label: 'fastest door to door', pick: (rows) => best(rows, (i) => i.travelMinutes) },
  { key: 'mostRelaxed', label: 'most relaxed connections', pick: (rows) => best(rows, (i) => PARETO_DIMS[2].get(i)) },
  { key: 'singleTicket', label: 'one ticket only', pick: (rows) => best(rows.filter((i) => i.ticketCount === 1), (i) => i.price.total) },
  { key: 'fewestStops', label: 'fewest stops', pick: (rows) => best(rows, (i) => i.stops) },
]

/* Ties broken by the weighted score, then by the itinerary key — so a rerun on
 * the same data answers with the same rows in the same order. */
function best(rows, of) {
  let winner = null
  for (const r of rows) {
    if (!winner) { winner = r; continue }
    const d = of(r) - of(winner)
    if (d < -EPS || (Math.abs(d) <= EPS && (r.score < winner.score || (r.score === winner.score && r.key < winner.key)))) winner = r
  }
  return winner
}

const money = (n, cur) => `${n.toFixed(2)} ${cur}`.trim()

/**
 * Turn the front into the 3–5 rows the tool answers with: each one labelled with
 * what it wins, why it is in, and what that costs in money and in comfort.
 *
 * A front smaller than `max` is answered in full — padding it with dominated
 * options to hit a row count would undo the whole point.
 */
export function champions(front, { max = 5 } = {}) {
  if (!front.length) return []
  const bests = Object.fromEntries(PARETO_DIMS.map((d) => [d.key, Math.min(...front.map(d.get))]))
  const picked = new Map()

  for (const c of CHAMPIONS) {
    if (picked.size >= max) break
    const row = c.pick(front)
    if (!row) continue
    const existing = picked.get(row.key)
    if (existing) {
      existing.wins.push(c.label)
      continue
    }
    picked.set(row.key, { itinerary: row, wins: [c.label] })
  }

  return [...picked.values()].map(({ itinerary, wins }) => ({
    itinerary,
    wins,
    why: whyIn(itinerary, wins, front),
    tradeoffs: tradeoffs(itinerary, bests),
  }))
}

function whyIn(itin, wins, front) {
  const bits = [`${wins.join(', ')} of the ${front.length} option(s) nothing else beats outright`]
  if (wins.includes('cheapest')) {
    const others = front.filter((i) => i.key !== itin.key).map((i) => i.price.total)
    if (others.length) bits.push(`${money(Math.min(...others) - itin.price.total, itin.price.currency)} under the next cheapest`)
  }
  if (itin.ticketCount === 1) bits.push('one ticket, so a missed connection is the airline\'s problem')
  return bits.join('; ')
}

/** What this option gives up against the best-in-class on each dimension it does
 *  not win — the "was es kostet, in Geld und in Bequemlichkeit" half. */
function tradeoffs(itin, bests) {
  const out = []
  const dPrice = itin.price.total - bests.price
  if (dPrice > EPS) out.push(`${money(dPrice, itin.price.currency)} more than the cheapest`)
  const dTravel = itin.travelMinutes - bests.travel
  if (dTravel > 0) out.push(`${humanMinutes(dTravel)} longer than the fastest`)
  if (itin.ticketCount > 1)
    out.push(`${itin.ticketCount} separate tickets — if the first flight is late, no airline owes you a rebooking, a refund or a hotel; that risk is the discount`)
  if (itin.airportChanges) out.push(`${itin.airportChanges} airport change(s) on the way`)
  if (itin.missingCheckedBags > 0) out.push(`${itin.missingCheckedBags} checked bag(s) not in the fare — priced here as an estimate, confirm before booking`)
  if (itin.minConnectionMinutes != null && itin.minConnectionMinutes < 90) out.push(`tightest connection is ${humanMinutes(itin.minConnectionMinutes)}`)
  if (itin.maxConnectionMinutes != null && itin.maxConnectionMinutes > 300) out.push(`longest layover is ${humanMinutes(itin.maxConnectionMinutes)}`)
  if (itin.stops === 0) return out.length ? out : ['nothing — it wins its dimension outright and is nonstop']
  return out.length ? out : ['nothing material against the rest of the front']
}

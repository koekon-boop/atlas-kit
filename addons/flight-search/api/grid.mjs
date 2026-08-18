/* ------------------------------------------------------------------ *
 * The CANDIDATE GENERATOR — the part a booking portal does not do for you.
 *
 * A portal answers the question you typed. This turns one loosely-stated wish
 * ("mid-October to Tokyo, 10–14 days, nothing landing after 23:00") into a GRID
 * of concrete searches:
 *
 *     departure dates (±n)  ×  origin airports  ×  destination airports
 *                           ×  stay lengths     ×  via points (split tickets)
 *
 * and then — this is the half that matters — throws most of it away before
 * spending anything.
 *
 * 🔴 THE GRID IS RANKED AND TRUNCATED BEFORE THE FIRST CALL GOES OUT. ±3 days
 * over 2×2 airports with a 10–14 day stay window is 140 searches; add three via
 * points and it is 500. Every one is a paid supplier call and 20-odd seconds of
 * latency, so the budget is not a circuit breaker that trips while requests are
 * in flight — it is a cap applied to a fully enumerated, DETERMINISTICALLY
 * ORDERED list. Same request in, same searches out, every time.
 *
 * Ranking is "distance from what the operator actually asked for": a date drift
 * of one day costs less than two, the primary airport costs less than the one 90
 * minutes down the motorway, and a split ticket costs more than either because
 * it is a worse thing to buy at equal price.
 *
 * ⚠️ SPLIT LEGS ARE SPENT IN PAIRS. A head with no tail is a wasted call — half a
 * virtual-interline combination composes with nothing — so a split enters the
 * budget as a two-call group or not at all. And splits get a RESERVED share of
 * the budget, because they always rank below every whole-trip variant (correctly
 * — they are worse to buy at equal price) and a plain "best N groups" would
 * spend everything on date shuffling and never do the one thing a portal cannot.
 * ------------------------------------------------------------------ */
import { addDays } from './time.mjs'

/* Hard ceilings on the ENUMERATION itself, upstream of the call budget. The
 * enumeration is pure and cheap, but `dateFlexDays: 400` should still cost
 * nothing, and an unbounded array is an unbounded array. */
const MAX_FLEX_DAYS = 14
const MAX_VIA = 6
const MAX_AIRPORTS_PER_END = 4
const MAX_GROUPS = 2000
const SPLIT_RESERVE_SHARE = 0.5

/** Date offsets nearest-first: 0, +1, −1, +2, −2 … — which is exactly the order
 *  a truncation should keep. Later beats earlier at equal distance only to make
 *  the order total; nothing rides on the tie, but it has to be A tie-break, or
 *  the alphabetical fallback below decides it and "nearest first" stops meaning
 *  anything. See `driftRank`. */
export function dateOffsets(flex) {
  const n = Math.max(0, Math.min(MAX_FLEX_DAYS, Math.floor(flex) || 0))
  const out = [0]
  for (let i = 1; i <= n; i++) out.push(i, -i)
  return out
}

/** Stay lengths for a flexible round trip, ordered from the middle of the range
 *  outwards — an operator who says "10 to 14 days" means 12, and would rather
 *  lose 14 than 12 when the budget runs out. */
export function stayLengths(range) {
  if (!Array.isArray(range) || range.length !== 2) return []
  const lo = Math.min(range[0], range[1])
  const hi = Math.max(range[0], range[1])
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 1 || hi - lo > 60) return []
  const mid = (lo + hi) / 2
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b)
}

/* An airport end is `{ code, groundMinutes }`. The FIRST entry is the primary —
 * what the operator named — and every later one pays a rank penalty on top of
 * whatever ground time it carries, because "I would also fly from there" is not
 * the same as "I want to fly from there". */
const ends = (list) => (Array.isArray(list) ? list : [list]).filter(Boolean).slice(0, MAX_AIRPORTS_PER_END)
const groundRank = (a, i) => i * 4 + Math.min(20, (Number(a.groundMinutes) || 0) / 30)
/* A day of drift costs 10 — which puts it just behind a second-choice airport
 * (4, plus half a point per half hour of ground time), because flying from the
 * next airport over is a smaller imposition than moving the trip. The +1 breaks
 * the ±n tie in favour of leaving later. */
const driftRank = (off) => Math.abs(off) * 10 + (off < 0 ? 1 : 0)

const groupKey = (g) => g.specs.map((s) => `${s.kind}:${s.slices.map((x) => `${x.origin}-${x.destination}-${x.departureDate}`).join('+')}`).join('|')

function describeEnds({ off, o, d, oi, di }) {
  const bits = []
  if (off) bits.push(`departure ${off > 0 ? '+' : ''}${off}d`)
  if (oi) bits.push(`from ${o.code}`)
  if (di) bits.push(`into ${d.code}`)
  return bits.join(', ') || 'exactly as asked'
}

/**
 * Build the grid.
 *
 * Returns `{ groups, calls, enumerated, dropped }` where a GROUP is one
 * indivisible unit of spend: `[spec]` for a whole-trip search, `[head, tail]`
 * for one split-ticket combination. `groups` is already cut to the budget.
 *
 * ⚠️ Alternate airports vary the FIRST journey's two ends only (and, on a return,
 * mirror onto the second). A 3+-leg multi-city search keeps every later leg's
 * airports exactly as given — varying all of them at once is a cross product
 * nobody has a call budget for, and the caller can always ask twice.
 */
export function buildGrid(req) {
  const budget = Math.max(1, Math.floor(req.maxAdapterCalls) || 1)
  const offsets = dateOffsets(req.dateFlexDays)
  const stays = req.journeys.length === 2 && req.tripDayRange ? stayLengths(req.tripDayRange) : []
  const via = [...new Set((req.via || []).filter(Boolean))].slice(0, MAX_VIA)
  const roundTrip = req.journeys.length === 2

  const direct = []
  const split = []

  /* ---- whole-trip searches -------------------------------------------------
   * One call buys every offer for the whole shape at once, which is why these
   * are cheap per candidate and always get the first slot. A return flown on ONE
   * ticket can only ever come from here. */
  const first = req.journeys[0]
  for (const [oi, o] of ends(first.origins).entries()) {
    for (const [di, d] of ends(first.destinations).entries()) {
      for (const off of offsets) {
        const baseRank = groundRank(o, oi) + groundRank(d, di) + driftRank(off)
        const why = describeEnds({ off, o, d, oi, di })
        const sliceFor = (j, date, override) => ({
          origin: override?.origin ?? j.origins[0].code,
          destination: override?.destination ?? j.destinations[0].code,
          departureDate: date,
          departureTime: j.departureTime,
          arrivalTime: j.arrivalTime,
        })
        const outDate = addDays(first.date, off)
        if (!outDate) continue
        const outSlice = sliceFor(first, outDate, { origin: o.code, destination: d.code })

        if (!roundTrip) {
          const rest = req.journeys.slice(1).map((j) => sliceFor(j, addDays(j.date, off)))
          if (rest.some((s) => !s.departureDate)) continue
          direct.push({ rank: baseRank, specs: [{ kind: 'trip', slices: [outSlice, ...rest], why }] })
          continue
        }
        // A round trip's return date is either fixed (moved by the same flex) or
        // derived from the stay-length range — never both, or the two windows
        // multiply into a grid nobody asked for.
        const back = req.journeys[1]
        const returns = stays.length
          // The penalty is the stay's POSITION in the middle-out order, not its
          // length: without it every stay in the range ties and the alphabetical
          // tie-break silently reorders them shortest-first.
          ? stays.map((n, i) => ({ date: addDays(outDate, n), penalty: i * 2, note: `${n}-day stay` }))
          : offsets.map((ro) => ({ date: addDays(back.date, ro), penalty: driftRank(ro), note: ro ? `return ${ro > 0 ? '+' : ''}${ro}d` : '' }))
        for (const r of returns) {
          if (!r.date) continue
          direct.push({
            rank: baseRank + r.penalty,
            specs: [{ kind: 'trip', slices: [outSlice, sliceFor(back, r.date, { origin: d.code, destination: o.code })], why: [why, r.note].filter(Boolean).join(', ') }],
          })
        }
      }
    }
  }

  /* ---- separately-bought legs ----------------------------------------------
   * Everything the traveller books as more than one order. Enumerated per
   * JOURNEY (per direction): combining an outbound split with an inbound split
   * is a cross product `search.mjs` does afterwards, for free, on results it
   * already has — doing it here would multiply the call budget by itself. */
  if (req.allowSplitTickets && req.journeys.length > 1) {
    /* Two ONE-WAYS instead of a return. Cheaper than the return fare often
     * enough to be worth a slot, and — the structural reason it is here — the
     * only thing an outbound split ticket can compose with on the way home: a
     * return offer's inbound half is not separately bookable, so without these
     * a round trip could never carry a split in one direction only. Emitted as
     * ONE group covering every journey, so a half-bought set can never happen. */
    for (const [oi, o] of ends(first.origins).entries()) {
      for (const [di, d] of ends(first.destinations).entries()) {
        for (const off of offsets) {
          const specs = req.journeys.map((j, ji) => {
            const date = addDays(j.date, off)
            const [from, to] = ji === 0 ? [o.code, d.code] : roundTrip ? [d.code, o.code] : [j.origins[0].code, j.destinations[0].code]
            return date && { kind: 'leg', journeyIndex: ji, role: j.role, splitRole: 'oneway', via: null, slices: [{ origin: from, destination: to, departureDate: date, departureTime: j.departureTime, arrivalTime: j.arrivalTime }], why: `one-way ${from}→${to}` }
          })
          if (specs.some((s) => !s)) continue
          split.push({ rank: 25 + groundRank(o, oi) + groundRank(d, di) + driftRank(off), specs })
        }
      }
    }
  }

  /* The virtual interline itself: two one-way searches that only mean something
   * together, joined at a via point. Kiwi's Tequila API used to sell this
   * ready-made and has been closed to new developers since 2026, so the head and
   * the tail are bought here and the feasibility of the join is checked here
   * (itinerary.mjs) rather than trusted to a supplier. */
  if (req.allowSplitTickets && via.length) {
    for (const [ji, j] of req.journeys.entries()) {
      for (const [oi, o] of ends(j.origins).entries()) {
        for (const [di, d] of ends(j.destinations).entries()) {
          for (const off of offsets) {
            const date = addDays(j.date, off)
            if (!date) continue
            for (const [vi, v] of via.entries()) {
              if (v === o.code || v === d.code) continue
              split.push({
                rank: 30 + groundRank(o, oi) + groundRank(d, di) + driftRank(off) + vi * 2 + ji,
                specs: [
                  // The head carries the journey's DEPARTURE window; the tail carries
                  // its ARRIVAL window. Neither carries the other's — the via point's
                  // own clock is a connection question, not a preference.
                  { kind: 'leg', journeyIndex: ji, role: j.role, splitRole: 'head', via: v, slices: [{ origin: o.code, destination: v, departureDate: date, departureTime: j.departureTime }], why: `split via ${v}: ${o.code}→${v}` },
                  { kind: 'leg', journeyIndex: ji, role: j.role, splitRole: 'tail', via: v, slices: [{ origin: v, destination: d.code, departureDate: date, arrivalTime: j.arrivalTime }], why: `split via ${v}: ${v}→${d.code}` },
                ],
              })
            }
          }
        }
      }
    }
  }

  const order = (a, b) => a.rank - b.rank || groupKey(a).localeCompare(groupKey(b))
  direct.sort(order)
  split.sort(order)
  const enumerated = direct.length + split.length
  direct.length = Math.min(direct.length, MAX_GROUPS)
  split.length = Math.min(split.length, MAX_GROUPS)

  const splitReserve = split.length ? Math.min(budget - 1, Math.floor(budget * SPLIT_RESERVE_SHARE)) : 0
  const groups = []
  let spent = 0
  const take = (list, cap) => {
    while (list.length && spent + list[0].specs.length <= cap) {
      const g = list.shift()
      groups.push(g)
      spent += g.specs.length
    }
  }
  take(direct, budget - splitReserve) // the primary search is always in here
  take(split, budget)
  take(direct, budget) // whatever the split reserve could not use goes back
  // WHICH groups were taken is what the reserve decides; the order they run in
  // is free, so put them back in rank order — the answer prints this list.
  groups.sort(order)

  return {
    groups: groups.map((g, i) => ({
      rank: g.rank,
      specs: g.specs.map((s, k) => ({
        id: `g${i}s${k}`,
        maxConnections: req.maxConnections,
        cabin: req.cabin,
        passengers: req.passengers,
        allowSourceSplit: !!req.allowSplitTickets,
        ...s,
      })),
    })),
    calls: spent,
    enumerated,
    dropped: direct.length + split.length,
  }
}

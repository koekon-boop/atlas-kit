/* ------------------------------------------------------------------ *
 * Every knob `addons/flight-search` reads, in one place.
 *
 * Read at CALL time, never frozen at import — `register()` imports this module
 * at boot, so a value captured in a top-level `const` would pin whatever `.env`
 * said at process start and quietly ignore the operator's next edit.
 *
 * 🔴 THE CALL BUDGET IS THE COST CONTROL. Duffel bills a search fee once a box
 * goes past a 1500:1 search-to-book ratio, and the candidate generator's whole
 * job is to fan ONE question out into many searches — a ±3-day window over 2×2
 * airports with 3 via points is already 100+ requests if nothing bounds it. So
 * every request is capped at `maxAdapterCalls` (default 12) and the grid is
 * ranked and TRUNCATED before a single call goes out, not while they run.
 *
 * ⚠️ `DUFFEL_API_TOKEN` is the one value that is not optional, and it is
 * deliberately NOT read anywhere but here and in the adapter. It never reaches a
 * tool answer, a log line or a status block — `status()` reports the token's
 * MODE (test/live) and nothing else.
 * ------------------------------------------------------------------ */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ADDON_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const str = (k, d = '') => {
  const v = process.env[k]
  return v === undefined || v === '' ? d : v
}
const num = (k, d) => {
  const n = Number(process.env[k])
  return Number.isFinite(n) && n >= 0 ? n : d
}

/** The Duffel access token. `duffel_test_…` costs nothing and returns Duffel's
 *  own fixture airline; `duffel_live_…` needs an approved account. */
export const duffelToken = (env = process.env) => (env.DUFFEL_API_TOKEN || '').trim()

/** Which Duffel API version the adapter pins. Duffel requires the header. */
export const duffelVersion = () => str('ATLAS_FLIGHTS_DUFFEL_VERSION', 'v2')

export const duffelBase = () => str('ATLAS_FLIGHTS_DUFFEL_BASE', 'https://api.duffel.com').replace(/\/$/, '')

export const timeouts = () => ({
  /* Duffel's own supplier timeout, passed through as a query param — it bounds
   * how long DUFFEL waits on the airlines. Its documented range is 2000–60000. */
  supplier: Math.min(60000, Math.max(2000, num('ATLAS_FLIGHTS_SUPPLIER_TIMEOUT_MS', 20000))),
  /* Ours, on the HTTP round trip. Comfortably above the supplier bound so a slow
   * airline reads as a slow answer rather than as our own abort. */
  request: num('ATLAS_FLIGHTS_REQUEST_TIMEOUT_MS', 40000),
})

export const limits = () => ({
  /* The spend bound: adapter calls per search_flights invocation. */
  adapterCalls: Math.max(1, num('ATLAS_FLIGHTS_MAX_ADAPTER_CALLS', 12)),
  /* How many tickets one adapter answer may contribute. Duffel happily returns
   * 300 offers for a busy route; scoring all of them buys nothing a cheap
   * per-search prefilter does not. */
  ticketsPerCall: Math.max(1, num('ATLAS_FLIGHTS_MAX_TICKETS_PER_CALL', 40)),
  /* Journey options kept per direction before the cross-product that builds
   * whole-trip itineraries — the second combinatorial fuse. */
  optionsPerJourney: Math.max(1, num('ATLAS_FLIGHTS_MAX_OPTIONS_PER_JOURNEY', 60)),
  /* Whole-trip itineraries scored. The cross product is truncated to this. */
  itineraries: Math.max(1, num('ATLAS_FLIGHTS_MAX_ITINERARIES', 400)),
  /* Split-ticket pairs formed per journey per via point. */
  splitsPerVia: Math.max(1, num('ATLAS_FLIGHTS_MAX_SPLITS_PER_VIA', 30)),
  /* Options handed back. The Pareto front is the shape; this is its width. */
  results: Math.min(10, Math.max(1, num('ATLAS_FLIGHTS_MAX_RESULTS', 5))),
})

/**
 * The connection rules, in minutes. These are the HARD feasibility floors — the
 * scorer adds its own opinion about comfort on top, but nothing below these ever
 * reaches the answer.
 *
 * The self-transfer floor is deliberately far above the same-ticket one: on
 * separate tickets you collect your bag, clear immigration to reach landside,
 * check in again against a fresh baggage cut-off, and no airline owes you a
 * rebook if the first flight is late. Two and a half hours is the low end of
 * what experienced self-connectors use, not a safe number.
 */
export const connectionRules = () => ({
  sameTicket: num('ATLAS_FLIGHTS_MIN_CONNECTION_MIN', 45),
  selfTransfer: num('ATLAS_FLIGHTS_MIN_SELF_TRANSFER_MIN', 150),
  airportChange: num('ATLAS_FLIGHTS_MIN_AIRPORT_CHANGE_MIN', 240),
  checkedBagExtra: num('ATLAS_FLIGHTS_CHECKED_BAG_EXTRA_MIN', 30),
  max: num('ATLAS_FLIGHTS_MAX_CONNECTION_MIN', 720),
})

/**
 * What one checked bag is ASSUMED to cost when a fare does not include the
 * baggage the traveller asked for.
 *
 * ⚠️ This is an estimate, and it is here because the alternative is worse. A
 * Duffel offer states what baggage is INCLUDED but not what an extra bag costs —
 * that needs a second call per offer (`GET /air/offers/{id}?return_available_
 * services=true`), which would multiply the call budget by the number of offers.
 * Comparing a hand-baggage-only headline price against a full-service fare
 * without this correction is exactly the "Lockpreis" trap the scorer exists to
 * avoid, so an honest, labelled, overridable estimate beats a precise lie.
 */
export const bagFeeEstimate = () => num('ATLAS_FLIGHTS_CHECKED_BAG_FEE', 55)

/** Where the tool points an operator with no token. Kept in one place so the
 *  status block, the empty answer and the README cannot drift apart. */
export const SETUP_HINT =
  'Create a free account at https://app.duffel.com/join, open Settings → Access tokens, ' +
  'copy the TEST token (it starts with `duffel_test_`), add `DUFFEL_API_TOKEN=duffel_test_…` ' +
  'to the repo\'s .env, then run `scripts/serve.sh restart`. A test token costs nothing and ' +
  'returns Duffel\'s own fixture airline on a fixed set of routes (e.g. LHR→DXB, DXB→AMS); ' +
  'real airline content needs a live token (`duffel_live_…`) from an approved Duffel account.'

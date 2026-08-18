/* ------------------------------------------------------------------ *
 * `addons/flight-search` — the addon's whole registration surface.
 *
 * ONE hook and a status block: an `mcpTools` entry called `search_flights`, and
 * `status()` so `GET /api/addons` can say whether a source is configured. No
 * routes, no cron, no search leg, no evidence leg, no scorecard tiles — this
 * addon adds a way to ASK a question from a chat and touches no read path core
 * already had. Disable it and the kit is byte-identical to one that never had it
 * (docs/ADDONS.md). No routes also means no write route, so no bearer gate and
 * no Caddyfile block: there is nothing here for the browser to reach.
 *
 * ⚠️ BOX-LOCAL ON PURPOSE. Addon tools are registered on the local MCP surfaces
 * (dev/worker/control) and are deliberately NOT part of `KNOWLEDGE_TOOLS`, the
 * fixed audited set the remote HTTP connector serves. This one spends a supplier
 * budget against the operator's own Duffel account on input a caller controls —
 * exactly the kind of tool that surface exists to keep out. Putting it there
 * would be a separate, argued change to `api/src/mcp/tools.mjs`, not a side
 * effect of enabling an addon.
 *
 * 🔴 REGISTER() MUST NOT THROW, AND MUST COST NOTHING WHEN UNCONFIGURED. There is
 * no token on most boxes and that is the expected state: nothing here reads the
 * network, opens a file or validates a credential at boot. The token is read at
 * CALL time, and a missing one produces an ANSWER — what to get, where to put
 * it — rather than an error.
 * ------------------------------------------------------------------ */
import { createRequire } from 'node:module'
import { adapterStatus, loadAdapters } from './adapters/index.mjs'
import { bagFeeEstimate, connectionRules, limits, SETUP_HINT } from './config.mjs'
import { searchFlights } from './search.mjs'

/* `zod` is what the MCP SDK builds a tool's input schema from, and a bare import
 * does not resolve from inside an addon — `addons/<name>/api/` walks up to a repo
 * root with no node_modules. The loader injects `express` for exactly this
 * reason but not zod, so it is required out of core's own tree, which is the
 * form the addons written before that seam use (docs/ADDONS.md). Still not an
 * npm dependency of this addon: core already installed it.
 *
 * If it cannot be resolved the tool is NOT registered with an empty schema — a
 * tool that silently accepts no arguments looks like it works and answers
 * nonsense. It is left out, and `status()` says why. */
function loadZod() {
  try {
    return createRequire(new URL('../../../api/src/', import.meta.url))('zod').z
  } catch {
    return null
  }
}

const DESCRIPTION = `COMPOSE a flight itinerary rather than list one. Give it a loosely-stated trip \
("Tokyo in mid-October, 10–14 days, nothing landing after 23:00") and it spans a search grid over \
date window x alternate airports x via points x SPLIT TICKETS (separately booked legs on different \
airlines — "self-transfer"/virtual interlining, which no consumer portal will build for you), checks \
every combination for a connection that is actually survivable, prices the trip INCLUDING the baggage \
you asked for, and answers with a PARETO FRONT: 3-5 options that each win a dimension (cheapest / \
fastest door to door / most relaxed connections / one ticket only), each with why it is on the list \
and what it costs you in money and in comfort. Dominated options are discarded, not ranked lower.

Use it for "find me a way to get to X", comparing whether a stopover or a nearby airport is worth it, \
and for checking whether splitting a route across two airlines beats the through fare. It does NOT book \
anything and holds no reservation — every option is a lead to verify with the airline.

Costs a real supplier call per grid point against the operator's Duffel account, so it is capped: \
maxAdapterCalls (default 12) bounds the whole search, and the grid is ranked and truncated BEFORE \
anything is spent. Widen it deliberately, not by habit.

Pass alternate airports yourself — this tool has no airport geography ("Tokyo" is destination: \
["HND","NRT"], with groundMinutes if one is further out). Same for alliances: preferAirlines takes \
IATA codes, so expand a Star Alliance preference into its carriers before calling.

If no source is configured the answer says so and tells the operator exactly what to do; that is not \
an error and does not need a retry.`

export default function register() {
  const z = loadZod()
  const adapters = loadAdapters()

  const inputSchema = z && {
    origin: z.union([z.string(), z.array(z.union([z.string(), z.object({ code: z.string(), groundMinutes: z.number().optional() })]))]).describe('departure airport(s), IATA. A list makes them alternatives, first = preferred; `{code,groundMinutes}` states how long the ground trip to that airport takes so a further-out airport is compared honestly'),
    destination: z.union([z.string(), z.array(z.union([z.string(), z.object({ code: z.string(), groundMinutes: z.number().optional() })]))]).describe('arrival airport(s), same shape as origin — e.g. ["HND","NRT"] for Tokyo'),
    departureDate: z.string().describe('YYYY-MM-DD — the middle of the window, not a hard date, unless dateFlexDays is 0'),
    returnDate: z.string().optional().describe('YYYY-MM-DD; omit for a one-way'),
    dateFlexDays: z.number().optional().describe('search ±n days around the given dates (default 0, max 14). The single biggest lever on price, and on cost'),
    tripDayRange: z.array(z.number()).optional().describe('[min,max] stay length in days for a round trip, e.g. [10,14] — the return date is derived from the outbound rather than fixed'),
    via: z.array(z.string()).optional().describe('IATA codes you would accept as a connection point for a SPLIT ticket, e.g. ["IST","DXB"]. Without these, the only separately-booked option considered is two one-ways on the same route'),
    allowSplitTickets: z.boolean().optional().describe('default true — allow itineraries made of more than one separately booked ticket. Set false to see only what one airline will sell as one contract'),
    cabin: z.enum(['economy', 'premium_economy', 'business', 'first']).optional(),
    adults: z.number().optional().describe('default 1'),
    childAges: z.array(z.number()).optional().describe('one age per child; infants in arms are not supported'),
    checkedBags: z.number().optional().describe('checked bags PER PASSENGER you actually need (default 0). Fares that exclude them are charged an estimated fee so the comparison is not against a headline price'),
    maxConnections: z.number().optional().describe('0 = nonstop only, 1 (default) or 2, per ticket'),
    minConnectionMinutes: z.number().optional().describe('raise the connection floor; it can only be raised, never lowered below the built-in self-transfer minimum'),
    maxConnectionMinutes: z.number().optional().describe('layover ceiling, default 720'),
    noArrivalAfter: z.string().optional().describe('"HH:MM" local at the destination — a HARD filter, applied before scoring'),
    departureWindow: z.object({ from: z.string(), to: z.string() }).optional().describe('hard "HH:MM" window on the outbound departure'),
    arrivalWindow: z.object({ from: z.string(), to: z.string() }).optional().describe('hard "HH:MM" window on the outbound arrival'),
    returnDepartureWindow: z.object({ from: z.string(), to: z.string() }).optional(),
    returnArrivalWindow: z.object({ from: z.string(), to: z.string() }).optional(),
    preferDepartureWindow: z.object({ from: z.string(), to: z.string() }).optional().describe('SOFT window — outside it costs score, it does not disqualify'),
    preferArrivalWindow: z.object({ from: z.string(), to: z.string() }).optional().describe('SOFT window'),
    preferAirlines: z.array(z.string()).optional().describe('IATA airline codes you would rather fly; expand an alliance into its members yourself'),
    avoidAirlines: z.array(z.string()).optional().describe('IATA codes you will not fly — a HARD filter on marketing AND operating carrier'),
    maxPrice: z.number().optional().describe('hard ceiling on the TOTAL, baggage estimate included'),
    maxStops: z.number().optional().describe('hard ceiling across the whole trip'),
    maxTravelHours: z.number().optional().describe('hard ceiling on time actually spent travelling (the stay does not count)'),
    requireSingleTicket: z.boolean().optional().describe('drop everything that is not one bookable contract'),
    requireCheckedBag: z.boolean().optional().describe('drop fares that do not INCLUDE the checked bags asked for, instead of pricing an estimate'),
    weights: z.record(z.string(), z.number()).optional().describe('override the scoring weights: price, duration, stops, connectionRisk, connectionWaste, airportChange, terminalChange, ticketRisk, baggage, departureWindow, arrivalWindow, airline, emissions. 0 switches a dimension off'),
    maxResults: z.number().optional().describe('how many Pareto options to return, 1–10 (default 5)'),
    maxAdapterCalls: z.number().optional().describe('the search budget: supplier calls for this whole request (default 12, max 60). Every one costs the operator money'),
  }

  return {
    description: 'A flight search agent as an MCP tool: fans one trip request out over dates, nearby airports and split-ticket combinations, checks every connection for feasibility, and answers with a Pareto front of 3–5 options instead of a cheapest-first list. Needs a Duffel API token; inert without one.',

    mcpTools: inputSchema
      ? [
          {
            name: 'search_flights',
            description: DESCRIPTION,
            inputSchema,
            // The handler is the whole tool. It never throws on its own account —
            // every failure the pipeline can have is already an ANSWER with a
            // reason — but the MCP wrapper catches anyway, as core's does.
            handler: (args) => searchFlights(args, { adapters }),
          },
        ]
      : undefined,

    /** Enough to tell "ready" from "enabled but nothing will happen". Never
     *  reports the token itself, only whether there is one and which kind. */
    status: () => {
      const sources = adapterStatus(adapters)
      const ready = sources.some((s) => s.configured)
      return {
        tool: inputSchema ? 'search_flights' : 'NOT REGISTERED — zod could not be resolved from core; run npm ci in api/',
        sources,
        ready,
        ...(ready ? {} : { howToEnable: SETUP_HINT }),
        callBudgetPerSearch: limits().adapterCalls,
        maxResults: limits().results,
        connectionFloorsMinutes: connectionRules(),
        checkedBagFeeEstimate: bagFeeEstimate(),
      }
    },
  }
}

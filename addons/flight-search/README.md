# `flight-search` — a flight search agent as one MCP tool

A portal shows you a list. This **composes a trip**.

Ask it in a box-local Claude Code session — a dev agent, a knowledge worker, the
Atlas orchestrator — and it turns one loosely-stated wish into a search grid,
buys the parts of that grid it can afford, builds the combinations no single
airline sells, throws away everything that cannot actually be flown, and answers
with a **Pareto front**: 3–5 options that each win a dimension, with what that
win costs you.

```
search_flights({
  origin: "BER",
  destination: ["HND", { code: "NRT", groundMinutes: 75 }],
  departureDate: "2026-10-15", returnDate: "2026-10-25",
  tripDayRange: [10, 14], dateFlexDays: 2,
  via: ["IST", "DXB"],
  checkedBags: 1, noArrivalAfter: "23:00",
})
```

> 🔴 **It books nothing and holds nothing.** Every option is a lead to verify with
> the airline. Prices, availability and baggage rules change between a search and
> a booking, and offers expire in minutes.

---

## What it actually does

| stage | file | what it is for |
|---|---|---|
| **Candidate generator** | `api/grid.mjs` | dates (±n) × alternate airports × stay lengths × via points × split tickets, **ranked and truncated before the first call** |
| **Source adapters** | `api/adapters/` | Duffel today, behind a neutral `Ticket` shape — a second source is a new file and one line |
| **Feasibility** | `api/itinerary.mjs` | is this connection survivable: floors, airport changes, timezones, the date line |
| **Instants** | `api/time.mjs` | airline APIs send local wall clocks with no offset; everything is converted to UTC instants before anything is subtracted |
| **Hard filters + scoring** | `api/score.mjs` | what you will not do at any price, then a weighted utility over the rest |
| **The answer** | `api/pareto.mjs` | dominated options discarded; the survivors labelled with what they win |

### The candidate generator is the point

**Split tickets** — two separately bought one-ways joined at a via point, what the
industry calls self-transfer or virtual interlining — are the thing no consumer
portal will build for you. Kiwi.com's Tequila API used to sell them ready-made
and has been closed to new developers since 2026, so this addon builds the
combinations itself: it searches `origin→via` and `via→destination` separately
and then checks whether the join is a connection a human could actually make.

That check is a safety feature, not formatting:

| connection | floor | why |
|---|---|---|
| same ticket, same airport | **45 min** | the airline through-checks your bag and rebooks you if it misses |
| separate tickets, same airport | **150 min** | you reclaim the bag, go landside, check in again against a fresh cut-off |
| …with a checked bag | **+30 min** | you are carrying it to the desk yourself |
| airport change in the same city | **240 min** | IST → SAW is not a corridor |
| airport change between cities | **refused** | no ground transfer this tool can vouch for |
| any layover | **≤ 12 h** | above that it is a stopover you should have asked for |

All of them are configurable and can only ever be **raised** by a caller, never
lowered.

### The budget is enforced before anything is spent

±3 days over 2×2 airports with a 10–14 day stay window is 140 searches; add three
via points and it is 500. The grid is fully enumerated, ranked by *distance from
what you actually asked for* (a day of drift costs more than the next airport
over; a split ticket costs more than either), and then cut to
`maxAdapterCalls` — **12 by default**. Same request in, same searches out. The
answer always reports how many grid entries were dropped, so a thin result never
looks like "nothing better exists" when it means "we did not look".

Split legs are spent in **pairs**: a head with no tail composes with nothing.

### The price it ranks on is the price you pay

A hand-baggage-only headline fare and a full-service fare are not comparable
numbers. Pass `checkedBags` and every fare that excludes them is charged an
**estimated** fee, **per ticket** — which is exactly what turns a split ticket's
280 € "saving" into 170 €, because two one-ways means buying the bag twice. The
estimate is labelled as one everywhere it appears.

---

## What it cannot do

Read this part before enabling it.

- **Duffel does not carry every airline.** Ryanair, Wizz Air, easyJet and most of
  the ultra-low-cost world do not distribute through aggregators at all, so they
  are simply **absent from the results** — not "not found", *never looked at*. On
  the routes where a ULCC is the real answer, this tool will confidently show you
  the third-cheapest option. Cross-check the big European short-hauls by hand.
- **It cannot book.** Duffel offers are ordered through its API (`POST /air/orders`),
  not on a web page, so there is no booking deep link to hand you. Each option
  carries its Duffel offer id, its expiry, and a Google Flights **search** URL to
  verify the itinerary with a human eye. Booking is your job, at the airline or
  through a Duffel order you write yourself.
- **Split tickets are your own risk, entirely.** If the first flight is late, the
  second airline owes you nothing: not a rebooking, not a refund, not a hotel.
  You buy the next ticket yourself. The floors above are a margin, not a
  protection, and the answer says so on every affected option.
- **It has no airport geography.** It does not know that HND and NRT are both
  Tokyo, or how far LTN is from London. **You** pass the alternatives, with
  `groundMinutes` if one is further out. Same for alliances: `preferAirlines`
  takes IATA codes, so expand "Star Alliance" into its members before calling.
  (A caller that is a language model is very good at exactly this, which is why
  the tool does not ship a table that would be stale within a year.)
- **Baggage fees are estimated, not priced.** Getting the real number needs one
  extra Duffel call *per offer* (`GET /air/offers/{id}?return_available_services=true`),
  which would multiply the call budget by the number of offers.
- **Emissions and fare conditions are passed through, not computed.** If Duffel
  sends no `total_emissions_kg`, that dimension scores 0 for everyone.
- **No infants in arms**, no seat selection, no fare-family upsells, no
  multi-passenger split pricing.
- **Alternate airports vary the first leg's two ends only** (mirrored onto the
  return). A 3+-leg multi-city search keeps every later leg's airports as given.
- **Nothing is cached.** The same question asked twice costs twice.

---

## What it costs

| | |
|---|---|
| disk / RAM | **nothing** — no model, no index, no dependency. Pure JS over node builtins |
| Duffel account | **required.** A **test** token is free and returns Duffel's own fixture airline on a fixed set of routes; a **live** token needs an approved account |
| per search | up to `maxAdapterCalls` (default **12**) Duffel offer requests, each up to ~20 s of supplier timeout. A wide grid is therefore also a *slow* grid |
| Duffel's billing | pay-as-you-go, and it bills the **booking**, not the search: roughly **$3 per confirmed order**, ~1 % of order value for managed content, ~$1–2 per paid ancillary, plus an excess-search fee (~$0.005/search) once a box goes past a **1500 : 1 search-to-book ratio**. Check <https://duffel.com/pricing> before you rely on any of those figures |
| Claude subscription | **nothing.** No `claude -p` call anywhere in this addon |

> ⚠️ **The search-to-book ratio is the cost trap, not the per-search price.** An
> agent that runs a 12-call grid a few times a day and never books anything will
> cross that ratio. `ATLAS_FLIGHTS_MAX_ADAPTER_CALLS` is the dial.

---

## Enabling it

Nothing is installed and nothing is downloaded. Two steps:

**1. Get a Duffel token** — <https://app.duffel.com/join>, then *Settings →
Access tokens*. Take the **test** one first (`duffel_test_…`); it costs nothing
and proves the wiring. Add it to the repo's gitignored `.env`:

```sh
DUFFEL_API_TOKEN=duffel_test_...
```

**2. Enable the addon.** Either add it to `addons.json` at the repo root
(gitignored, operator-local — copy `addons.example.json` if you have none):

```json
{ "enabled": ["flight-search"] }
```

…or set the env var, which **wins whenever it is defined**:

```sh
ATLAS_ADDONS=flight-search,news-ingest
```

Then restart — enabling is a restart, not a reload:

```sh
scripts/serve.sh restart
```

Check it took:

```sh
curl -s localhost:3001/api/addons | jq '.addons[] | select(.name=="flight-search").status'
bash addons/flight-search/install.sh --check
```

**No Caddyfile block is needed.** This addon registers no Express route — there
is nothing for the browser to reach, so there is no bearer gate and no reverse
proxy entry to add.

### The first real search

Duffel's **test** environment answers only on fixed routes, so ask for one of
them or you will correctly get nothing back:

```
search_flights({ origin: "LHR", destination: "DXB", departureDate: "2026-10-15" })   // connecting flights
search_flights({ origin: "DXB", destination: "AMS", departureDate: "2026-10-15" })   // flights with stops
search_flights({ origin: "BTS", destination: "MRU", departureDate: "2026-10-15" })   // fares with no baggage
```

Once those look right, swap in a live token and ask a real question.

---

## Configuration

Everything has a working default; all of it is read at call time, so an `.env`
edit needs a restart only because the process re-reads `.env` at boot.

| variable | default | what it does |
|---|---|---|
| `DUFFEL_API_TOKEN` | — | **the only required one.** No token → the tool answers with how to get one |
| `ATLAS_FLIGHTS_MAX_ADAPTER_CALLS` | `12` | supplier calls per search — the spend bound |
| `ATLAS_FLIGHTS_MAX_RESULTS` | `5` | width of the Pareto front |
| `ATLAS_FLIGHTS_CHECKED_BAG_FEE` | `55` | the estimated per-ticket fee for a bag a fare excludes |
| `ATLAS_FLIGHTS_MIN_CONNECTION_MIN` | `45` | same-ticket connection floor |
| `ATLAS_FLIGHTS_MIN_SELF_TRANSFER_MIN` | `150` | separate-ticket floor |
| `ATLAS_FLIGHTS_MIN_AIRPORT_CHANGE_MIN` | `240` | airport change within one city |
| `ATLAS_FLIGHTS_CHECKED_BAG_EXTRA_MIN` | `30` | added to a self-transfer when a bag has to be re-checked |
| `ATLAS_FLIGHTS_MAX_CONNECTION_MIN` | `720` | layover ceiling |
| `ATLAS_FLIGHTS_SUPPLIER_TIMEOUT_MS` | `20000` | how long Duffel waits on the airlines (its range: 2000–60000) |
| `ATLAS_FLIGHTS_REQUEST_TIMEOUT_MS` | `40000` | how long we wait on Duffel |
| `ATLAS_FLIGHTS_DUFFEL_VERSION` | `v2` | the pinned `Duffel-Version` header |
| `ATLAS_FLIGHTS_DUFFEL_BASE` | `https://api.duffel.com` | overridable for a proxy or a replay fixture |

Per-request overrides (`maxAdapterCalls`, `minConnectionMinutes`, `weights`, …)
are arguments to the tool; see its description for the full list.

### Scoring weights

Lower is better; every dimension is reported per option so the answer can explain
itself. Pass `weights: { price: 2, emissions: 0 }` to reshape it — `0` switches a
dimension off.

`price` 1 · `ticketRisk` 0.7 · `duration` 0.6 · `connectionRisk` 0.5 ·
`airportChange` 0.4 · `baggage` 0.3 · `stops` 0.3 · `departureWindow` 0.3 ·
`arrivalWindow` 0.3 · `connectionWaste` 0.25 · `airline` 0.2 ·
`terminalChange` 0.1 · `emissions` 0.1

---

## Adding a second source

`api/adapters/index.mjs` is the whole seam. An adapter is an object with
`name`, `label`, `status()` and `search(spec) → { ok, tickets, error }`, where a
`Ticket` is the shape documented at the top of `api/itinerary.mjs`. Nothing in
the generator, the feasibility check, the scorer or the Pareto front has ever
seen a Duffel field, so Amadeus is a new file and one line in `loadAdapters()`.
Two configured sources **share** the call budget rather than doubling it.

An adapter with no credentials stays in the list reporting `configured: false`
with a reason — it is never dropped, because "we did not ask" and "we asked and
there was nothing" are different facts.

---

## Tests

```sh
node --test addons/flight-search/test/*.test.mjs
```

No network, no token, no fixtures recorded from a live call. CI runs them in the
same job as `api/test`. The cases worth knowing about: connection maths across
timezones and the date line, a DST fall-back layover, split-ticket feasibility,
each hard filter, Pareto domination, and the whole pipeline with no
`DUFFEL_API_TOKEN` set.

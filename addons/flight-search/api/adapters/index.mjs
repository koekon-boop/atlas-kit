/* ------------------------------------------------------------------ *
 * The source registry.
 *
 * One entry today. It exists as its own file anyway, because the seam is the
 * point: `search.mjs` is handed a LIST of adapters and knows nothing about any
 * of them beyond `name`, `status()` and `search(spec) → { ok, tickets, error }`.
 * Adding Amadeus is adding a file here and a line below — no change to the
 * candidate generator, the feasibility check, the scorer or the Pareto front,
 * because none of them has ever seen a Duffel field.
 *
 * ⚠️ An adapter with no credentials is NOT an error and is NOT dropped. It stays
 * in the list reporting `configured: false` with a reason, because "we did not
 * ask" and "we asked and there was nothing" are different facts and a search
 * that cannot tell them apart is a search you cannot trust. That is the same
 * rule core's search legs follow (docs/ADDONS.md).
 * ------------------------------------------------------------------ */
import { duffelAdapter } from './duffel.mjs'

export function loadAdapters({ env = process.env, fetchImpl } = {}) {
  return [duffelAdapter({ env, fetchImpl })]
}

/** What `GET /api/addons` and the tool's empty answer both report. Never throws:
 *  a status block that can fail is a status block that hides the failure. */
export function adapterStatus(adapters) {
  return adapters.map((a) => {
    try {
      return { name: a.name, label: a.label, ...a.status() }
    } catch (e) {
      return { name: a.name, configured: false, reason: `status failed: ${e?.message || e}` }
    }
  })
}

/** The adapters that can actually be called right now. */
export const configuredAdapters = (adapters) =>
  adapters.filter((a) => {
    try {
      return a.status().configured === true
    } catch {
      return false
    }
  })

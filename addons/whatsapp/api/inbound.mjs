/* ------------------------------------------------------------------ *
 * What happens to a webhook payload AFTER its signature checked out and the
 * route has already answered 200.
 *
 *   statuses[]            (sent/delivered/read receipts)  → ignored
 *   messages[] seen id    (Meta delivers the same event repeatedly) → dropped
 *   messages[] not allowed sender                         → dropped, counted
 *   messages[] type text                                  → forwarded to the agent
 *   messages[] anything else                              → one short "can't read that"
 *
 * Messages are handled ONE AT A TIME through a promise chain: two messages
 * arriving before the first has spawned the session would otherwise spawn two.
 * Nothing here throws into the request — the caller has already answered.
 * ------------------------------------------------------------------ */
import { config, normalizeNumber, stateFile } from './config.mjs'
import { forwardToAgent, readState, saveState } from './agent.mjs'
import { sendText } from './meta.mjs'

const UNSUPPORTED = 'Das kann ich noch nicht lesen — schreib mir bitte Text. / I can’t read that yet — text only, please.'
const AGENT_DOWN = 'Ich erreiche den Agenten gerade nicht — versuch es gleich noch mal. / I can’t reach the agent right now — please try again shortly.'

/** A bounded set that forgets its OLDEST id first. */
export class LruSet {
  constructor(max = 1000) {
    this.max = max
    this.ids = new Map()
  }
  /** true if `id` was already there (and refreshes it); false if new (and adds it). */
  seen(id) {
    const had = this.ids.delete(id)
    this.ids.set(id, true)
    if (this.ids.size > this.max) this.ids.delete(this.ids.keys().next().value)
    return had
  }
}

/** Every message in a Cloud API payload: `entry[].changes[].value.messages[]`. */
export function extractMessages(payload) {
  const out = []
  for (const entry of payload?.entry ?? [])
    for (const change of entry?.changes ?? [])
      for (const m of change?.value?.messages ?? []) if (m && typeof m === 'object') out.push(m)
  return out
}

export function createInbound({ env = process.env, fetch: f = globalThis.fetch, log = console.error, file } = {}) {
  const dedupe = new LruSet(1000)
  const counters = { received: 0, forwarded: 0, duplicates: 0, dropped: 0, unsupported: 0, badSignature: 0, rawBodyMissing: 0, forwardErrors: 0 }
  let chain = Promise.resolve()
  const deps = () => ({ env, fetch: f, file: file ?? stateFile(env) })

  async function handleOne(m) {
    const from = normalizeNumber(m.from)
    if (!from || !config(env).allowedFrom.includes(from)) {
      counters.dropped++ // silent: an unknown number gets no reply and no hint we exist
      return
    }
    counters.received++
    const st = readState(deps().file)
    saveState({ ...st, lastInboundAt: new Date().toISOString() }, deps().file) // opens the 24 h window
    if (m.type !== 'text' || typeof m.text?.body !== 'string' || !m.text.body.trim()) {
      counters.unsupported++
      await sendText({ to: from, text: UNSUPPORTED }, { env, fetch: f, log })
      return
    }
    const r = await forwardToAgent({ from, text: m.text.body }, deps())
    if (r.ok) {
      counters.forwarded++
      return
    }
    counters.forwardErrors++
    log(`[whatsapp] could not hand the message to the agent: ${r.error}`)
    await sendText({ to: from, text: AGENT_DOWN }, { env, fetch: f, log })
  }

  return {
    counters,
    /** Queue a verified payload; resolves when its messages have been handled
     *  (the route does not await this — it has already answered 200). */
    process(payload) {
      const fresh = []
      for (const m of extractMessages(payload)) {
        if (typeof m.id === 'string' && dedupe.seen(m.id)) counters.duplicates++
        else fresh.push(m)
      }
      chain = chain.then(async () => {
        for (const m of fresh) {
          try {
            await handleOne(m)
          } catch (e) {
            log(`[whatsapp] message handling failed: ${e?.message || e}`)
          }
        }
      })
      return chain
    },
  }
}

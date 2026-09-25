/* ------------------------------------------------------------------ *
 * What happens to a webhook payload AFTER its signature checked out and the
 * route has already answered 200.
 *
 *   statuses[]            (sent/delivered/read receipts)  → ignored
 *   messages[] seen id    (Meta delivers the same event repeatedly) → dropped
 *   messages[] not allowed sender                         → dropped, counted
 *   messages[] type text                                  → forwarded to that sender's own agent session
 *   messages[] type audio (voice note or attached file)   → transcribed on the box, then
 *                                                            forwarded as marked text
 *   messages[] type image / document / video              → saved on the box, the PATHS forwarded as marked
 *                                                            text (video: stills + transcribed soundtrack)
 *   messages[] anything else                              → one short "can't read that"
 *
 * Messages are handled ONE AT A TIME through a promise chain: two messages
 * arriving before the first has spawned the session would otherwise spawn two.
 * Nothing here throws into the request — the caller has already answered.
 * ------------------------------------------------------------------ */
import { config, normalizeNumber, stateFile } from './config.mjs'
import { forwardToAgent, markInbound } from './agent.mjs'
import { fetchAudio, transcribe } from './audio.mjs'
import { createMedia, MEDIA_TYPES } from './media.mjs'
import { sendText } from './meta.mjs'
import { run } from './voice-reply.mjs'

const UNSUPPORTED = 'Das kann ich noch nicht lesen — schreib mir bitte Text. / I can’t read that yet — text only, please.'
const NO_STT = 'Spracherkennung ist auf der Box gerade nicht aktiv — schreib es mir bitte. / Speech recognition is not active on the box right now — please type it.'
const NO_SPEECH = 'In der Sprachnachricht war nichts zu hören — versuch es noch mal oder schreib es mir. / I couldn’t hear anything in that voice note — try again or type it.'
const TOO_BIG = 'Die Sprachnachricht ist zu lang für mich — schick sie kürzer oder schreib es mir. / That voice note is too long for me — send a shorter one or type it.'
const MEDIA_FAIL = 'Ich konnte die Sprachnachricht nicht laden — versuch es gleich noch mal oder schreib es mir. / I couldn’t fetch that voice note — please try again or type it.'
const STT_FAIL = 'Die Sprachnachricht konnte ich nicht auswerten — versuch es gleich noch mal oder schreib es mir. / I couldn’t process that voice note — please try again or type it.'
const AGENT_DOWN = 'Ich erreiche den Agenten gerade nicht — versuch es gleich noch mal. / I can’t reach the agent right now — please try again shortly.'

/** What the agent reads in front of a transcribed voice note. */
export const VOICE_MARK = '[Sprachnachricht, transkribiert]'

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

export function createInbound({ env = process.env, fetch: f = globalThis.fetch, log = console.error, file, exec = run } = {}) {
  const dedupe = new LruSet(1000)
  const counters = { received: 0, forwarded: 0, duplicates: 0, dropped: 0, unsupported: 0, audioReceived: 0, transcribed: 0, transcribeErrors: 0, transcribeEmpty: 0, audioTooLarge: 0, imagesReceived: 0, videosReceived: 0, documentsReceived: 0, framesExtracted: 0, mediaTooLarge: 0, mediaErrors: 0, badSignature: 0, rawBodyMissing: 0, forwardErrors: 0 }
  let chain = Promise.resolve()
  const deps = () => ({ env, fetch: f, file: file ?? stateFile(env) })
  const media = createMedia({ env, fetch: f, log, exec, counters })

  /** Voice note or attached audio file → text for the agent, or a short reply
   *  to the sender saying why not. → the transcript, or null once it has answered. */
  async function transcribeAudio(m, from) {
    counters.audioReceived++
    const reply = (text) => sendText({ to: from, text }, { env, fetch: f, log })
    const id = m.audio?.id
    if (typeof id !== 'string' || !id) {
      counters.mediaErrors++
      log('[whatsapp] an audio message came without a media id')
      await reply(MEDIA_FAIL)
      return null
    }
    const got = await fetchAudio(id, { env, fetch: f, log })
    if (!got.ok) {
      if (got.kind === 'too-large') counters.audioTooLarge++
      else counters.mediaErrors++
      await reply(got.kind === 'too-large' ? TOO_BIG : MEDIA_FAIL)
      return null
    }
    const t = await transcribe(got.audio, got.mime, { env, fetch: f, log })
    if (t.ok) {
      counters.transcribed++
      return t.text
    }
    if (t.kind === 'empty') counters.transcribeEmpty++
    else counters.transcribeErrors++
    await reply({ empty: NO_SPEECH, unavailable: NO_STT, 'too-large': TOO_BIG }[t.kind] ?? STT_FAIL)
    return null
  }

  async function handleOne(m) {
    const from = normalizeNumber(m.from)
    if (!from || !config(env).allowedFrom.includes(from)) {
      counters.dropped++ // silent: an unknown number gets no reply and no hint we exist
      return
    }
    counters.received++
    markInbound(from, { file: deps().file, allowed: config(env).allowedFrom }) // opens THIS sender's 24 h window
    let text
    if (m.type === 'audio') {
      const spoken = await transcribeAudio(m, from)
      if (spoken === null) return
      text = `${VOICE_MARK} ${spoken}`
    } else if (MEDIA_TYPES.includes(m.type)) {
      const got = await media.receive(m, m.type)
      if (!got.ok) {
        await sendText({ to: from, text: got.reply }, { env, fetch: f, log })
        return
      }
      text = got.text
    } else if (m.type !== 'text' || typeof m.text?.body !== 'string' || !m.text.body.trim()) {
      counters.unsupported++
      await sendText({ to: from, text: UNSUPPORTED }, { env, fetch: f, log })
      return
    } else text = m.text.body
    const r = await forwardToAgent({ from, text }, deps())
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

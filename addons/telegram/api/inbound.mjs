/* ------------------------------------------------------------------ *
 * What happens to ONE Telegram update, handed in by poller.mjs.
 *
 *   message.text                          → forwarded to the standing agent session
 *   message.voice / message.audio         → transcribed on the box, then
 *                                            forwarded as marked text
 *   message.photo / .document / .video    → saved on the box, the PATHS forwarded as
 *                                            marked text (video: stills + transcribed
 *                                            soundtrack)
 *   anything else                         → one short "can't read that"
 *   callback_query (a tap on a button     → handed to TELEGRAM_CALLBACK_HOOK; its answer
 *     the bot sent)                          becomes the tap's toast and, if it says so,
 *                                            a marked line for the agent (README "Buttons")
 *   message.location, and the edits of a → handed to TELEGRAM_LOCATION_HOOK; it may answer
 *     LIVE location (edited_message)         the sender and/or pass a marked line to the
 *                                            agent (README "Location"). Live updates never
 *                                            count as the operator answering.
 *   an unallowed chat_id                  → dropped, silently, counted
 *
 * A chat id in TELEGRAM_CHAT_ROUTES (config.mjs' chatRoutes) is dispatched to
 * `forwardToRoute` instead of `forwardToAgent` at the very last step — everything
 * above it (allowlist, voice, media) is identical for a routed chat.
 *
 * A plain TEXT message that looks like a `claude auth login` OAuth code is
 * checked against addons/claude-login FIRST (claude-login-bridge.mjs) — only
 * while a renewal there is actually open; otherwise it falls through to the
 * ordinary agent forward below, unchanged.
 *
 * Updates are handled ONE AT A TIME (poller.mjs already awaits onUpdate per
 * update, in order — there is no separate queue here, unlike the webhook-driven
 * addons/whatsapp, because getUpdates itself delivers one batch at a time and
 * the poller does not fetch the next batch until this one is done).
 * ------------------------------------------------------------------ */
import { config } from './config.mjs'
import { flushAllRoutes, forwardToAgent, forwardToRoute, markInbound } from './agent.mjs'
import { fetchAudio, transcribe } from './audio.mjs'
import { tryInterceptClaudeLoginCode } from './claude-login-bridge.mjs'
import { createMedia, MEDIA_TYPES } from './media.mjs'
import { answerCallbackQuery, sendChatAction, sendMessage } from './telegram.mjs'
import { run } from './voice-reply.mjs'

const UNSUPPORTED = 'Das kann ich noch nicht lesen — schreib mir bitte Text. / I can’t read that yet — text only, please.'
const NO_STT = 'Spracherkennung ist auf der Box gerade nicht aktiv — schreib es mir bitte. / Speech recognition is not active on the box right now — please type it.'
const NO_SPEECH = 'In der Sprachnachricht war nichts zu hören — versuch es noch mal oder schreib es mir. / I couldn’t hear anything in that voice note — try again or type it.'
const TOO_BIG = 'Die Sprachnachricht ist zu lang für mich — schick sie kürzer oder schreib es mir. / That voice note is too long for me — send a shorter one or type it.'
const MEDIA_FAIL = 'Ich konnte die Sprachnachricht nicht laden — versuch es gleich noch mal oder schreib es mir. / I couldn’t fetch that voice note — please try again or type it.'
const STT_FAIL = 'Die Sprachnachricht konnte ich nicht auswerten — versuch es gleich noch mal oder schreib es mir. / I couldn’t process that voice note — please try again or type it.'
const AGENT_DOWN = 'Ich erreiche den Agenten gerade nicht — versuch es gleich noch mal. / I can’t reach the agent right now — please try again shortly.'
const BASE_UNREACHABLE = 'Die Basis ist gerade nicht erreichbar — deine Nachricht ist gespeichert und wird zugestellt, sobald sie wieder läuft. / The base is not reachable right now — your message is stored and will be delivered once it is back.'

/** What the agent reads in front of a transcribed voice note. */
export const VOICE_MARK = '[Sprachnachricht, transkribiert]'

/** What the agent reads in front of a line the button hook asked to pass on. */
export const BUTTON_MARK = '[Knopf]'

/** What the agent reads in front of a line the location hook asked to pass on. */
export const LOCATION_MARK = '[Standort]'

const NO_HOOK = 'Knöpfe sind auf der Box nicht eingerichtet. / Buttons are not set up on the box.'
const HOOK_FAIL = 'Das hat nicht geklappt — versuch es gleich noch mal. / That did not work — please try again.'

/** Telegram message types this bridge reads as spoken audio: a real voice note
 *  (`voice`) and an audio file attached from the gallery (`audio`) — same as
 *  WhatsApp treating `voice: false` audio the same way. */
const AUDIO_TYPES = { voice: 'audio/ogg', audio: '' }

export function createInbound({ env = process.env, fetch: f = globalThis.fetch, log = console.error, file, exec = run } = {}) {
  const counters = { buttonTaps: 0, buttonErrors: 0, locations: 0, locationUpdates: 0, locationErrors: 0, received: 0, forwarded: 0, dropped: 0, unsupported: 0, audioReceived: 0, transcribed: 0, transcribeErrors: 0, transcribeEmpty: 0, audioTooLarge: 0, imagesReceived: 0, videosReceived: 0, documentsReceived: 0, framesExtracted: 0, mediaTooLarge: 0, mediaErrors: 0, forwardErrors: 0, claudeLoginCodes: 0 }
  const media = createMedia({ env, fetch: f, log, exec, counters })

  /** Voice note or attached audio → text for the agent, or a short reply to the
   *  sender saying why not. → the transcript, or null once it has answered. */
  async function transcribeAudio(m, chatId, kind) {
    counters.audioReceived++
    const reply = (text) => sendMessage({ chatId, text }, { env, fetch: f, log })
    const id = m[kind]?.file_id
    if (typeof id !== 'string' || !id) {
      counters.mediaErrors++
      log(`[telegram] a ${kind} message came without a file id`)
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
    const t = await transcribe(got.audio, m[kind]?.mime_type || AUDIO_TYPES[kind] || 'audio/ogg', { env, fetch: f, log })
    if (t.ok) {
      counters.transcribed++
      return t.text
    }
    if (t.kind === 'empty') counters.transcribeEmpty++
    else counters.transcribeErrors++
    await reply({ empty: NO_SPEECH, unavailable: NO_STT, 'too-large': TOO_BIG }[t.kind] ?? STT_FAIL)
    return null
  }

  /** Hand an agent-bound text to the routed session or the standing one; tell the
   *  sender when neither takes it. Shared by messages and button taps. */
  async function deliver(chatId, text) {
    const route = config(env).chatRoutes[chatId]
    const r = route ? await forwardToRoute({ chatId, text }, route, { env, fetch: f, file }) : await forwardToAgent({ chatId, text }, { env, fetch: f, file })
    if (r.ok) {
      counters.forwarded++
      return
    }
    counters.forwardErrors++
    log(`[telegram] could not hand the message to the ${route ? 'routed session' : 'agent'}: ${r.error}`)
    await sendMessage({ chatId, text: route ? BASE_UNREACHABLE : AGENT_DOWN }, { env, fetch: f, log })
  }

  /**
   * A tap on an inline button the bot sent. The allowlist applies exactly as for
   * messages (the chat the button sits in). The hook — an executable on the box,
   * never a shell — gets one JSON argument `{ data, chatId, messageId, fromId }`
   * and may print one JSON object: `{ toast?, alert?, forward? }`. `toast` becomes
   * the little notice on the phone (`alert: true` makes it a popup), `forward` is
   * passed on to the agent as a `[Knopf]` line. The spinner is always closed, also
   * when the hook is missing or fails.
   */
  async function handleCallback(q) {
    const chatId = String(q.message?.chat?.id ?? '')
    if (!chatId || !config(env).allowedChatIds.includes(chatId)) {
      counters.dropped++
      return
    }
    counters.buttonTaps++
    markInbound(file)
    const c = config(env)
    const answer = (text, showAlert = false) => answerCallbackQuery({ id: q.id, text, showAlert }, { env, fetch: f, log })
    if (!c.callbackHook) return answer(NO_HOOK)
    const payload = { data: String(q.data ?? ''), chatId, messageId: q.message?.message_id ?? null, fromId: q.from?.id ?? null }
    const r = await exec(c.callbackHook, [JSON.stringify(payload)], { timeoutMs: c.callbackTimeoutMs, captureStdout: true })
    let out = null
    if (r.code === 0) {
      try {
        out = JSON.parse(String(r.stdout || '').trim() || '{}')
      } catch {}
    }
    if (!out || typeof out !== 'object') {
      counters.buttonErrors++
      log(`[telegram] the button hook failed (exit ${r.code ?? 'none'}): ${String(r.stderr || '').trim().slice(0, 300)}`)
      return answer(HOOK_FAIL)
    }
    await answer(typeof out.toast === 'string' ? out.toast : '', out.alert === true)
    if (typeof out.forward === 'string' && out.forward.trim()) await deliver(chatId, `${BUTTON_MARK} ${out.forward.trim()}`)
  }

  /**
   * A shared location (`message.location`) or an update of a LIVE location (an
   * `edited_message` carrying `location`). The allowlist applies as for messages.
   * The hook — an executable on the box, never a shell — gets one JSON argument
   * `{ lat, lon, accuracy, heading, livePeriod, live, update, date, chatId, messageId }`
   * and may print one JSON object `{ reply?, forward? }`: `reply` is sent to the chat
   * (only for a freshly shared location, never for live updates), `forward` reaches the
   * agent as a `[Standort]` line. Live updates do NOT count as the operator answering
   * (no markInbound): they arrive every few minutes on their own.
   * Without a hook a freshly shared location gets the usual "can't read that", and
   * live updates are dropped silently — exactly the behaviour before this existed.
   */
  async function handleLocation(m, isUpdate) {
    const chatId = String(m.chat?.id ?? '')
    if (!chatId || !config(env).allowedChatIds.includes(chatId)) {
      counters.dropped++
      return
    }
    const c = config(env)
    if (!c.locationHook) {
      if (isUpdate) return
      counters.received++
      markInbound(file)
      counters.unsupported++
      await sendMessage({ chatId, text: UNSUPPORTED }, { env, fetch: f, log })
      return
    }
    const loc = m.location
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    const lat = num(loc.latitude)
    const lon = num(loc.longitude)
    if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return
    if (isUpdate) counters.locationUpdates++
    else {
      counters.received++
      counters.locations++
      markInbound(file)
    }
    const payload = {
      lat, lon, accuracy: num(loc.horizontal_accuracy), heading: num(loc.heading), livePeriod: num(loc.live_period),
      live: num(loc.live_period) !== null, update: isUpdate, date: num(m.edit_date) ?? num(m.date), chatId, messageId: m.message_id ?? null,
    }
    const r = await exec(c.locationHook, [JSON.stringify(payload)], { timeoutMs: c.locationTimeoutMs, captureStdout: true })
    let out = null
    if (r.code === 0) {
      try {
        out = JSON.parse(String(r.stdout || '').trim() || '{}')
      } catch {}
    }
    if (!out || typeof out !== 'object') {
      counters.locationErrors++
      log(`[telegram] the location hook failed (exit ${r.code ?? 'none'}): ${String(r.stderr || '').trim().slice(0, 300)}`)
      return
    }
    if (!isUpdate && typeof out.reply === 'string' && out.reply.trim()) await sendMessage({ chatId, text: out.reply.trim() }, { env, fetch: f, log })
    if (typeof out.forward === 'string' && out.forward.trim()) await deliver(chatId, `${LOCATION_MARK} ${out.forward.trim()}`)
  }

  /** Handle one update. Never throws — poller.mjs already catches, this is a second belt. */
  async function handleOne(u) {
    if (u?.callback_query) return handleCallback(u.callback_query)
    if (u?.message?.location) return handleLocation(u.message, false)
    if (u?.edited_message?.location) return handleLocation(u.edited_message, true)
    const m = u?.message
    if (!m) return // any other edited_message, channel_post, … — ignored
    const chatId = String(m.chat?.id ?? '')
    if (!chatId || !config(env).allowedChatIds.includes(chatId)) {
      counters.dropped++ // silent: an unknown chat gets no reply and no hint we exist
      return
    }
    counters.received++
    markInbound(file)
    const id = String(u.update_id)
    const type = m.voice ? 'voice' : m.audio ? 'audio' : m.photo ? 'photo' : m.document ? 'document' : m.video ? 'video' : m.text != null ? 'text' : null
    if (type && type !== 'text') await sendChatAction({ chatId }, { env, fetch: f, log }) // a hint that something is happening while media/transcription runs
    let text
    if (type === 'voice' || type === 'audio') {
      const spoken = await transcribeAudio(m, chatId, type)
      if (spoken === null) return
      text = `${VOICE_MARK} ${spoken}`
    } else if (type && MEDIA_TYPES.includes(type)) {
      const got = await media.receive(m, type, id)
      if (!got.ok) {
        await sendMessage({ chatId, text: got.reply }, { env, fetch: f, log })
        return
      }
      text = got.text
    } else if (type !== 'text' || typeof m.text !== 'string' || !m.text.trim()) {
      counters.unsupported++
      await sendMessage({ chatId, text: UNSUPPORTED }, { env, fetch: f, log })
      return
    } else text = m.text
    if (type === 'text') {
      const code = await tryInterceptClaudeLoginCode(text, { env, fetch: f, log })
      if (code.handled) {
        counters.claudeLoginCodes++
        await sendMessage({ chatId, text: code.reply }, { env, fetch: f, log })
        return
      }
    }
    await deliver(chatId, text)
  }

  /** The poller-tick hook (register.mjs wires this into poller.mjs's onTick):
   *  retry every configured route's pending backlog, so a stored message still
   *  gets through even when the sender never writes again. */
  async function flushRoutes() {
    const routes = config(env).chatRoutes
    if (Object.keys(routes).length) await flushAllRoutes(routes, { env, fetch: f, file })
  }

  return { counters, handleOne, flushRoutes }
}

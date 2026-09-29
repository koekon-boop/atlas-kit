/* ------------------------------------------------------------------ *
 * `addons/telegram` — a bridge between the Telegram Bot API and ONE standing
 * Atlas knowledge-agent session, exactly the pattern of addons/whatsapp, with
 * two differences: inbound arrives by long-polling `getUpdates` (this box has
 * no public webhook target) instead of a pushed webhook, and there is one
 * shared session rather than one per sender.
 *
 *   POST /api/telegram/send   the agent's reply path (bearer-gated): text, or with
 *                              `voice: true` a read-aloud voice note (text on any failure)
 *
 * Disable it and the kit is byte-identical to one that never had it
 * (docs/ADDONS.md): no route, no poller, no state file, no outbound call.
 *
 * 🔴 THE POLLER IS SINGLETON-GUARDED (poller.mjs). `loadAddons()` runs in the
 * main API AND in a fresh MCP stdio server per agent session — register() is
 * therefore called far more than once per box. Starting the poll loop
 * unconditionally would start one getUpdates consumer per session, and
 * Telegram allows exactly one; `createPoller()` claims a pidfile lock and
 * every process that loses the race simply does not poll.
 *
 * 🔴 THE SEND ROUTE GATES ITSELF, like every addon write (docs/ADDONS.md), with
 * the constant-time DASHBOARD_BEARER_TOKEN check core uses.
 * ------------------------------------------------------------------ */
import crypto from 'node:crypto'
import { config, maskChatId, missing, offsetFile, stateFile } from './config.mjs'
import { sessionInfo } from './agent.mjs'
import { createSttProbe, createTtsProbe } from './audio.mjs'
import { mediaStatus } from './media.mjs'
import { createInbound } from './inbound.mjs'
import { createPoller, readOffset } from './poller.mjs'
import { sendMessage } from './telegram.mjs'
import { createVoiceReplies, onPath, run } from './voice-reply.mjs'

/** Constant-time string equality (an addon is self-contained — see docs/ADDONS.md
 *  — so this is its own copy of the same check addons/whatsapp and core use,
 *  not an import across addon boundaries). Both sides are hashed first, so a
 *  length difference does not short-circuit and leak the secret's length. */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest()
  const hb = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(ha, hb)
}

export function buildRoutes({ Router, express }, { env = process.env, fetch: f = globalThis.fetch, log = console.error, file, exec = run, startPoller = true } = {}) {
  const routes = Router()
  const inbound = createInbound({ env, fetch: f, log, file, exec })
  const stt = createSttProbe({ env, fetch: f })
  const tts = createTtsProbe({ env, fetch: f })
  const voice = createVoiceReplies({ env, fetch: f, log, exec })
  const poller = startPoller && config(env).botToken ? createPoller({ env, fetch: f, log, onUpdate: (u) => inbound.handleOne(u) }) : null

  function bearerAuth(req, res, next) {
    const token = config(env).bearer
    if (!token) return res.status(500).json({ error: 'server missing DASHBOARD_BEARER_TOKEN' })
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')
    if (!m || !safeEqual(m[1], token)) return res.status(401).json({ error: 'unauthorized' })
    next()
  }

  routes.use('/api/telegram/send', express.json({ limit: '64kb' }))
  routes.post('/api/telegram/send', bearerAuth, async (req, res) => {
    const absent = missing('outbound', env)
    if (absent.length) return res.status(503).json({ ok: false, error: `not configured — set ${absent.join(', ')}` })
    const c = config(env)
    const { chat_id: chatId, text, voice: wantVoice } = req.body || {}
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ ok: false, error: 'missing "text"' })
    const target = chatId == null || chatId === '' ? c.homeChatId : String(chatId).trim()
    // A prompt-injected agent must not be able to message arbitrary chats.
    if (!c.allowedChatIds.includes(target)) return res.status(400).json({ ok: false, error: '"chat_id" is not in TELEGRAM_ALLOWED_CHAT_IDS' })
    if (wantVoice != null && typeof wantVoice !== 'boolean') return res.status(400).json({ ok: false, error: '"voice" must be true or false' })
    const r = wantVoice ? await voice.send({ chatId: target, text }) : await sendMessage({ chatId: target, text }, { env, fetch: f, log })
    res.status(r.ok ? 200 : 502).json(r)
  })

  return { routes, inbound, stt, tts, voice, poller }
}

/** Voice notes need addons/voice with a working on-box STT — say honestly whether it is there. */
function voiceNotesStatus(stt) {
  const s = stt.get()
  return {
    transcription: s.available === true ? 'ready' : s.available === false ? `NOT AVAILABLE — ${s.reason}` : `unknown — ${s.reason}`,
    maxAudioBytes: config().maxAudioBytes,
  }
}

/** Voice replies need addons/voice with an on-box TTS command AND ffmpeg (with libopus,
 *  which only install.sh --check can see) — say honestly whether they are there. */
function voiceRepliesStatus(tts) {
  const s = tts.get()
  const c = config()
  return {
    synthesis: s.available === true ? 'ready' : s.available === false ? `NOT AVAILABLE — ${s.reason}` : `unknown — ${s.reason}`,
    ffmpeg: onPath('ffmpeg'),
    maxSpokenChars: c.maxSpokenChars,
    maxVoiceChars: c.maxVoiceChars,
  }
}

export default function register(ctx) {
  const { routes, inbound, stt, tts, voice, poller } = buildRoutes(ctx)
  return {
    description:
      'Telegram Bot API ↔ ONE standing Atlas agent session: a long-polling getUpdates consumer (singleton-guarded, this box has no public webhook target) into the agent — text, voice notes transcribed on the box via addons/voice, and pictures / videos / documents saved on the box for the agent to look at — and a bearer-gated send route the agent answers through, as text or as a read-aloud voice note.',
    routes,
    status: () => {
      const inMiss = missing('inbound')
      const outMiss = missing('outbound')
      const c = config()
      return {
        inbound: inMiss.length ? `NOT READY — set ${inMiss.join(', ')}` : 'ready',
        outbound: outMiss.length ? `NOT READY — set ${outMiss.join(', ')}` : 'ready',
        homeChat: c.homeChatId ? maskChatId(c.homeChatId) : null,
        allowedChats: c.allowedChatIds.length,
        session: sessionInfo({ file: stateFile() }),
        poller: poller ? poller.status() : { owner: false, reason: !c.botToken ? 'TELEGRAM_BOT_TOKEN is not set' : 'not started in this process' },
        offset: readOffset(offsetFile()),
        voiceNotes: voiceNotesStatus(stt),
        voiceReplies: voiceRepliesStatus(tts),
        media: mediaStatus(),
        counters: { ...inbound.counters, ...voice.counters },
      }
    },
  }
}

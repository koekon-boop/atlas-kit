/* ------------------------------------------------------------------ *
 * `addons/whatsapp` — a bridge between the WhatsApp Cloud API (Meta) and standing
 * Atlas knowledge-agent sessions, one per allowed number.
 *
 *   GET  /api/whatsapp/webhook   Meta's verification handshake
 *   POST /api/whatsapp/webhook   inbound messages (HMAC-signed by Meta)
 *   POST /api/whatsapp/send      the agent's reply path (bearer-gated): text, or with
 *                                `voice: true` a read-aloud voice note (text on any failure)
 *
 * Disable it and the kit is byte-identical to one that never had it
 * (docs/ADDONS.md): no route, no state file, no outbound call.
 *
 * 🔴 THE WEBHOOK NEEDS THE RAW BODY, AND CORE'S GLOBAL JSON PARSER EATS IT.
 * `server.mjs` runs `express.json()` on every path before addon routers are
 * mounted, so by the time this route runs a JSON body is already parsed and
 * the exact bytes Meta signed are gone (re-serialising is not byte-identical:
 * Meta escapes "/" and non-ASCII, JSON.stringify does not). The one thing that
 * makes body-parser stand aside is a Content-Type that is not JSON — so the
 * Caddyfile's webhook block rewrites it (infra/Caddyfile.example), and this
 * route reads the body with `express.raw`. If a request arrives already parsed
 * the route FAILS CLOSED (500 + a log line + `rawBodyMissing` in status()) —
 * it never falls back to trusting an unverifiable body.
 *
 * 🔴 THE SEND ROUTE GATES ITSELF, like every addon write (docs/ADDONS.md), with
 * the constant-time DASHBOARD_BEARER_TOKEN check core uses. The webhook does
 * not: Meta cannot hold that token, and its request is authenticated by the
 * HMAC signature instead.
 * ------------------------------------------------------------------ */
import { config, maskNumber, missing, normalizeNumber, stateFile } from './config.mjs'
import { readState, senderSessions } from './agent.mjs'
import { createSttProbe, createTtsProbe } from './audio.mjs'
import { mediaStatus } from './media.mjs'
import { createInbound } from './inbound.mjs'
import { safeEqual, sendText, verifyHandshake, verifySignature } from './meta.mjs'
import { createVoiceReplies, onPath, run } from './voice-reply.mjs'

export function buildRoutes({ Router, express }, { env = process.env, fetch: f = globalThis.fetch, log = console.error, file, exec = run } = {}) {
  const routes = Router()
  const inbound = createInbound({ env, fetch: f, log, file, exec })
  const stt = createSttProbe({ env, fetch: f })
  const tts = createTtsProbe({ env, fetch: f })
  const voice = createVoiceReplies({ env, fetch: f, log, exec })

  function bearerAuth(req, res, next) {
    const token = config(env).bearer
    if (!token) return res.status(500).json({ error: 'server missing DASHBOARD_BEARER_TOKEN' })
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')
    if (!m || !safeEqual(m[1], token)) return res.status(401).json({ error: 'unauthorized' })
    next()
  }

  routes.get('/api/whatsapp/webhook', (req, res) => {
    const challenge = verifyHandshake(req.query, env)
    if (challenge === null) return res.sendStatus(403)
    res.type('text/plain').status(200).send(challenge)
  })

  routes.post('/api/whatsapp/webhook', express.raw({ type: () => true, limit: '256kb' }), (req, res) => {
    const c = config(env)
    if (!c.appSecret) {
      log('[whatsapp] webhook refused: WHATSAPP_APP_SECRET is not set')
      return res.status(503).json({ error: 'webhook not configured' })
    }
    if (!Buffer.isBuffer(req.body)) {
      if (req.body && Object.keys(req.body).length) {
        inbound.counters.rawBodyMissing++
        log('[whatsapp] webhook body was already parsed — the Caddy webhook block must rewrite Content-Type (see addons/whatsapp/README.md). Refusing: the signature cannot be checked.')
        return res.status(500).json({ error: 'raw body unavailable' })
      }
      return res.sendStatus(400)
    }
    if (!verifySignature(req.body, req.get('x-hub-signature-256'), c.appSecret)) {
      inbound.counters.badSignature++
      return res.sendStatus(403)
    }
    let payload
    try {
      payload = JSON.parse(req.body.toString('utf-8'))
    } catch {
      return res.sendStatus(400)
    }
    // Answer at once — Meta retries anything slower than a few seconds — and do
    // the work after. process() never rejects.
    res.sendStatus(200)
    inbound.process(payload)
  })

  routes.use('/api/whatsapp/send', express.json({ limit: '64kb' }))
  routes.post('/api/whatsapp/send', bearerAuth, async (req, res) => {
    const absent = missing('outbound', env)
    if (absent.length) return res.status(503).json({ ok: false, error: `not configured — set ${absent.join(', ')}` })
    const c = config(env)
    const { to, text, voice: wantVoice } = req.body || {}
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ ok: false, error: 'missing "text"' })
    const target = to == null || to === '' ? c.allowedFrom[0] : normalizeNumber(to)
    // The default is the FIRST number. With several people that is somebody else's chat
    // whenever a session forgot its own `to` — the one mistake the brief exists to prevent.
    if ((to == null || to === '') && c.allowedFrom.length > 1)
      log(`[whatsapp] reply without \`to\` while ${c.allowedFrom.length} senders are configured — went to the default number (${maskNumber(target)}). A session must send "to":"<its own number>" with every reply.`)
    // A prompt-injected agent must not be able to message arbitrary numbers.
    if (!c.allowedFrom.includes(target)) return res.status(400).json({ ok: false, error: '"to" is not in WHATSAPP_ALLOWED_FROM' })
    if (wantVoice != null && typeof wantVoice !== 'boolean') return res.status(400).json({ ok: false, error: '"voice" must be true or false' })
    const r = wantVoice ? await voice.send({ to: target, text }) : await sendText({ to: target, text }, { env, fetch: f, log })
    res.status(r.ok ? 200 : 502).json(r)
  })

  return { routes, inbound, stt, tts, voice }
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
  const { routes, inbound, stt, tts, voice } = buildRoutes(ctx)
  return {
    description:
      'WhatsApp Cloud API ↔ one standing Atlas agent session per sender: inbound webhook (HMAC-verified) into the agent — text, voice notes transcribed on the box via addons/voice, and pictures / videos / documents saved on the box for the agent to look at — and a bearer-gated send route the agent answers through, as text or as a read-aloud voice note.',
    routes,
    status: () => {
      const inMiss = missing('inbound')
      const outMiss = missing('outbound')
      const c = config()
      return {
        inbound: inMiss.length ? `NOT READY — set ${inMiss.join(', ')}` : 'ready',
        outbound: outMiss.length ? `NOT READY — set ${outMiss.join(', ')}` : 'ready',
        allowedSenders: c.allowedFrom.length,
        // One row per allowed number: Meta's 24 h window is per user, and so is the session.
        sessions: senderSessions({ allowed: c.allowedFrom, names: c.senderNames, file: stateFile() }),
        lastInboundAt: readState(stateFile(), c.allowedFrom).lastInboundAt || null, // from anyone
        voiceNotes: voiceNotesStatus(stt),
        voiceReplies: voiceRepliesStatus(tts),
        media: mediaStatus(),
        counters: { ...inbound.counters, ...voice.counters },
        ...(inbound.counters.rawBodyMissing
          ? { warning: 'webhook bodies arrive already parsed — the Caddy webhook block is missing its Content-Type rewrite (README)' }
          : {}),
      }
    },
  }
}

/* ------------------------------------------------------------------ *
 * `addons/whatsapp` — a bridge between the WhatsApp Cloud API (Meta) and one
 * standing Atlas knowledge-agent session.
 *
 *   GET  /api/whatsapp/webhook   Meta's verification handshake
 *   POST /api/whatsapp/webhook   inbound messages (HMAC-signed by Meta)
 *   POST /api/whatsapp/send      the agent's reply path (bearer-gated)
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
import { config, missing, normalizeNumber, stateFile } from './config.mjs'
import { readState } from './agent.mjs'
import { createInbound } from './inbound.mjs'
import { safeEqual, sendText, verifyHandshake, verifySignature } from './meta.mjs'

const DAY_MS = 24 * 60 * 60 * 1000

export function buildRoutes({ Router, express }, { env = process.env, fetch: f = globalThis.fetch, log = console.error, file } = {}) {
  const routes = Router()
  const inbound = createInbound({ env, fetch: f, log, file })

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
    const { to, text } = req.body || {}
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ ok: false, error: 'missing "text"' })
    const target = to == null || to === '' ? c.allowedFrom[0] : normalizeNumber(to)
    // A prompt-injected agent must not be able to message arbitrary numbers.
    if (!c.allowedFrom.includes(target)) return res.status(400).json({ ok: false, error: '"to" is not in WHATSAPP_ALLOWED_FROM' })
    const r = await sendText({ to: target, text }, { env, fetch: f, log })
    res.status(r.ok ? 200 : 502).json(r)
  })

  return { routes, inbound }
}

export default function register(ctx) {
  const { routes, inbound } = buildRoutes(ctx)
  return {
    description:
      'WhatsApp Cloud API ↔ one standing Atlas agent session: inbound webhook (HMAC-verified) into the agent, and a bearer-gated send route the agent answers through.',
    routes,
    status: () => {
      const inMiss = missing('inbound')
      const outMiss = missing('outbound')
      const st = readState(stateFile())
      const last = st.lastInboundAt ? Date.parse(st.lastInboundAt) : NaN
      return {
        inbound: inMiss.length ? `NOT READY — set ${inMiss.join(', ')}` : 'ready',
        outbound: outMiss.length ? `NOT READY — set ${outMiss.join(', ')}` : 'ready',
        allowedSenders: config().allowedFrom.length,
        session: st.sessionId || 'none yet (created on the first message)',
        lastInboundAt: st.lastInboundAt || null,
        windowOpen: Number.isFinite(last) ? Date.now() - last < DAY_MS : null,
        counters: { ...inbound.counters },
        ...(inbound.counters.rawBodyMissing
          ? { warning: 'webhook bodies arrive already parsed — the Caddy webhook block is missing its Content-Type rewrite (README)' }
          : {}),
      }
    },
  }
}

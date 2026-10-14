/* ------------------------------------------------------------------ *
 * `addons/claude-login` — the Claude Code login on THIS box renews itself.
 *
 * The full login (`claude auth login`, the subscription OAuth) lasts only
 * about 4 weeks (`refreshTokenExpiresAt`); once it lapses every agent and
 * every chat channel goes silent with no visible error until someone notices
 * (see README.md for the 2026-10-14 incident this addon exists to prevent).
 *
 *   GET  /api/claude-login/awaiting   open read — is a renewal waiting for a
 *                                     human to paste a code back? (the OAuth
 *                                     URL is not a secret; the code itself is
 *                                     never in this answer) — addons/telegram's
 *                                     interception and the dashboard banner
 *                                     both poll this
 *   POST /api/claude-login/code       bearer-gated — submit the code, from the
 *                                     dashboard banner or (with the bearer the
 *                                     server already holds) addons/telegram
 *
 * Disable it and the kit is byte-identical to one that never had it
 * (docs/ADDONS.md): no route, no watcher, no tmux, no state file.
 * ------------------------------------------------------------------ */
import crypto from 'node:crypto'
import { config } from './config.mjs'
import { run } from './exec.mjs'
import { msUntilExpiry, readCredentials } from './credentials.mjs'
import { readState } from './state.mjs'
import { submitCode } from './renew.mjs'
import { createWatcher } from './watcher.mjs'

/** Constant-time string equality — an addon is self-contained (docs/ADDONS.md),
 *  so this is its own copy of the check every write route in this repo uses. */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest()
  const hb = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(ha, hb)
}

export function buildRoutes({ Router, express }, { env = process.env, fetch: f = globalThis.fetch, exec = run, log = console.error, file = config(env).stateFile, startWatcher = true } = {}) {
  const routes = Router()
  const c = config(env)
  const watcher = startWatcher ? createWatcher({ env, fetch: f, exec, file, log }) : { status: () => ({ owner: false }) }

  function bearerAuth(req, res, next) {
    const token = config(env).bearer
    if (!token) return res.status(500).json({ error: 'server missing DASHBOARD_BEARER_TOKEN' })
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')
    if (!m || !safeEqual(m[1], token)) return res.status(401).json({ error: 'unauthorized' })
    next()
  }

  // Open read — the OAuth URL is not a secret (the same URL a notification
  // already sent in plain text); the code itself never appears here.
  routes.get('/api/claude-login/awaiting', (_req, res) => {
    const state = readState(file)
    if (!state.awaiting) return res.json({ awaiting: false })
    const { via, url, startedAt, expiresAt } = state.awaiting
    res.json({ awaiting: true, via, url, startedAt, expiresAt })
  })

  routes.use('/api/claude-login/code', express.json({ limit: '4kb' }))
  routes.post('/api/claude-login/code', bearerAuth, async (req, res) => {
    const { code, source } = req.body || {}
    if (typeof code !== 'string' || !code.trim()) return res.status(400).json({ ok: false, error: 'missing "code"' })
    const r = await submitCode(code.trim(), { env, fetch: f, exec, file, source: typeof source === 'string' ? source : 'dashboard' })
    res.status(r.ok ? 200 : 409).json(r)
  })

  /** Enough to tell "ready" from "waiting on a human" from "nothing to do",
   *  without a log — GET /api/addons' per-addon status block. Never the code
   *  or a token: `state.awaiting`/`state.lastAttempt` are already stripped of
   *  those by renew.mjs/state.mjs before they are ever persisted. */
  function status() {
    const cred = readCredentials(c.credentialsFile)
    const state = readState(file)
    const left = msUntilExpiry(cred)
    return {
      credentials: cred.ok ? { expiresAt: new Date(cred.expiresAt).toISOString(), daysLeft: left == null ? null : Math.round(left / 86400000) } : { error: cred.error },
      methods: c.methods,
      macChromeConsent: c.macChromeConsent,
      watcher: watcher.status(),
      lastCheckAt: state.lastCheckAt,
      lastAttempt: state.lastAttempt,
      awaiting: state.awaiting ? { via: state.awaiting.via, startedAt: state.awaiting.startedAt, expiresAt: state.awaiting.expiresAt } : null,
      banner: state.banner,
      counters: state.counters,
    }
  }

  return { routes, watcher, status }
}

export default function register(ctx) {
  const { routes, status } = buildRoutes(ctx)
  return {
    description:
      'The Claude Code login on this box renews ITSELF: an in-process watcher detects an expiring or broken refresh token and drives `claude auth login` in tmux, asking a human for the OAuth code over Telegram (addons/telegram intercepts the reply) or the dashboard banner — or, opt-in only, by clicking Authorize in the operator\'s own already-logged-in Chrome over SSH.',
    routes,
    status,
  }
}

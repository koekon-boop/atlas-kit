/* ------------------------------------------------------------------ *
 * Every knob `addons/whatsapp` reads, in one place.
 *
 * Read at CALL time from an `env` object (default `process.env`), never frozen
 * at import: `register()` imports this at boot, so a top-level `const` would pin
 * whatever `.env` said at process start — and tests hand in their own env.
 * ------------------------------------------------------------------ */
import os from 'node:os'
import path from 'node:path'

const str = (env, k, d = '') => {
  const v = env[k]
  return v === undefined || v === '' ? d : String(v)
}

/** "+49 170 1234567" → "491701234567". Meta wants international digits, no "+". */
export const normalizeNumber = (s) => String(s ?? '').replace(/\D/g, '')

/** The sender allowlist: a comma list of numbers, digits only. Empty = nobody. */
export function allowedFrom(env = process.env) {
  return [...new Set(str(env, 'WHATSAPP_ALLOWED_FROM').split(',').map(normalizeNumber).filter(Boolean))]
}

/** Env names that must be set for each half of the bridge. */
export const NEEDS = {
  inbound: ['WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_ALLOWED_FROM', 'DASHBOARD_BEARER_TOKEN'],
  outbound: ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ALLOWED_FROM'],
}

/** Names still unset for a half ('inbound' | 'outbound'). */
export const missing = (half, env = process.env) => NEEDS[half].filter((k) => !str(env, k))

const posInt = (env, k, d) => {
  const n = Number(env[k])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d
}

export const config = (env = process.env) => ({
  verifyToken: str(env, 'WHATSAPP_VERIFY_TOKEN'),
  appSecret: str(env, 'WHATSAPP_APP_SECRET'),
  accessToken: str(env, 'WHATSAPP_ACCESS_TOKEN'),
  phoneNumberId: str(env, 'WHATSAPP_PHONE_NUMBER_ID'),
  allowedFrom: allowedFrom(env),
  bearer: str(env, 'DASHBOARD_BEARER_TOKEN'),
  apiBase: `http://127.0.0.1:${str(env, 'API_PORT', '3001')}`,
  apiPort: str(env, 'API_PORT', '3001'),
  // Voice notes (README "Voice notes"): the size cap is checked BEFORE any download.
  maxAudioBytes: posInt(env, 'WHATSAPP_MAX_AUDIO_BYTES', 16 * 1024 * 1024),
  mediaTimeoutMs: posInt(env, 'WHATSAPP_MEDIA_TIMEOUT_MS', 30000), // per request: the media lookup, then the byte download
  transcribeTimeoutMs: posInt(env, 'WHATSAPP_TRANSCRIBE_TIMEOUT_MS', 120000),
})

export const GRAPH_BASE = 'https://graph.facebook.com/v21.0'

/** Where operator-local state lives — the same dir the agent runtime and the
 *  other addons (news-ingest, instagram-ingest) keep theirs in. Never the repo,
 *  never the vault: it is bookkeeping (one session id), not knowledge. */
export const stateFile = (env = process.env) =>
  str(env, 'WHATSAPP_STATE_FILE', path.join(str(env, 'AGENT_LOCAL_DIR', path.join(os.homedir(), '.atlas-kit')), 'whatsapp.json'))

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

/** "49176…=Ko, 49152…=Jessi" → { "49176…": "Ko", "49152…": "Jessi" }. Optional: the
 *  session brief names the person it talks to. Robust on purpose — spaces, empty
 *  entries, a "+" in the number, an entry without "=" or with an empty side are all
 *  skipped; only the FIRST "=" splits, and a name's whitespace is collapsed to one line
 *  (it lands in a prompt). */
export function senderNames(env = process.env) {
  const out = {}
  for (const entry of str(env, 'WHATSAPP_SENDER_NAMES').split(',')) {
    const i = entry.indexOf('=')
    if (i < 0) continue
    const number = normalizeNumber(entry.slice(0, i))
    const name = entry.slice(i + 1).replace(/\s+/g, ' ').trim()
    if (number && name) out[number] = name
  }
  return out
}

/** "4915112345678" → "49…678": enough to tell two senders apart, not enough to dial. */
export const maskNumber = (n) => {
  const d = normalizeNumber(n)
  return d.length > 6 ? `${d.slice(0, 2)}…${d.slice(-3)}` : '…'
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
  senderNames: senderNames(env),
  bearer: str(env, 'DASHBOARD_BEARER_TOKEN'),
  apiBase: `http://127.0.0.1:${str(env, 'API_PORT', '3001')}`,
  apiPort: str(env, 'API_PORT', '3001'),
  // Voice notes (README "Voice notes"): the size cap is checked BEFORE any download.
  maxAudioBytes: posInt(env, 'WHATSAPP_MAX_AUDIO_BYTES', 16 * 1024 * 1024),
  mediaTimeoutMs: posInt(env, 'WHATSAPP_MEDIA_TIMEOUT_MS', 30000), // per request: the media lookup, then the byte download
  transcribeTimeoutMs: posInt(env, 'WHATSAPP_TRANSCRIBE_TIMEOUT_MS', 120000),
  // Voice replies (README "Voice replies"). maxSpokenChars pairs with addons/voice's
  // ATLAS_VOICE_MAX_SPOKEN_CHARS, which silently truncates: keep it at or below that.
  maxSpokenChars: Math.max(50, posInt(env, 'WHATSAPP_MAX_SPOKEN_CHARS', 700)), // per /api/voice/speak call
  maxVoiceChars: posInt(env, 'WHATSAPP_MAX_VOICE_CHARS', 3000), // above this the reply goes out as text
  ttsTimeoutMs: posInt(env, 'WHATSAPP_TTS_TIMEOUT_MS', 30000), // per chunk
  ffmpegTimeoutMs: posInt(env, 'WHATSAPP_FFMPEG_TIMEOUT_MS', 60000),
})

export const GRAPH_BASE = 'https://graph.facebook.com/v21.0'

/** Where operator-local state lives — the same dir the agent runtime and the
 *  other addons (news-ingest, instagram-ingest) keep theirs in. Never the repo,
 *  never the vault: it is bookkeeping (a session id per sender), not knowledge. */
export const stateFile = (env = process.env) =>
  str(env, 'WHATSAPP_STATE_FILE', path.join(str(env, 'AGENT_LOCAL_DIR', path.join(os.homedir(), '.atlas-kit')), 'whatsapp.json'))

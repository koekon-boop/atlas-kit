/* ------------------------------------------------------------------ *
 * Every knob `addons/telegram` reads, in one place.
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

/** Telegram chat ids are integers (negative for groups/channels) — keep the
 *  exact digits/sign, just trim stray whitespace. */
export const normalizeChatId = (s) => String(s ?? '').trim()

/** The allowlist: an explicit comma list, else just the home chat (so the
 *  minimal single-operator setup needs only TELEGRAM_HOME_CHAT_ID). Empty
 *  when neither is set — nobody is accepted. */
export function allowedChatIds(env = process.env) {
  const raw = str(env, 'TELEGRAM_ALLOWED_CHAT_IDS')
  if (raw) return [...new Set(raw.split(',').map(normalizeChatId).filter(Boolean))]
  const home = normalizeChatId(str(env, 'TELEGRAM_HOME_CHAT_ID'))
  return home ? [home] : []
}

/** "-1001234567890" → "…7890": enough to tell two chats apart in a log line. */
export const maskChatId = (id) => {
  const s = normalizeChatId(id)
  return s.length > 4 ? `…${s.slice(-4)}` : '…'
}

/** Env names that must be set for each half of the bridge. */
export const NEEDS = {
  inbound: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_HOME_CHAT_ID', 'DASHBOARD_BEARER_TOKEN'],
  outbound: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_HOME_CHAT_ID'],
}

/** Names still unset for a half ('inbound' | 'outbound'). */
export const missing = (half, env = process.env) => NEEDS[half].filter((k) => !str(env, k))

const posInt = (env, k, d) => {
  const n = Number(env[k])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d
}

export const config = (env = process.env) => ({
  botToken: str(env, 'TELEGRAM_BOT_TOKEN'),
  homeChatId: normalizeChatId(str(env, 'TELEGRAM_HOME_CHAT_ID')),
  allowedChatIds: allowedChatIds(env),
  bearer: str(env, 'DASHBOARD_BEARER_TOKEN'),
  apiBase: `http://127.0.0.1:${str(env, 'API_PORT', '3001')}`,
  apiPort: str(env, 'API_PORT', '3001'),
  // Voice notes in (README "Voice notes"): Telegram's own getFile caps a
  // downloadable file at 20 MB — raising this past that would just be misleading.
  maxAudioBytes: posInt(env, 'TELEGRAM_MAX_AUDIO_BYTES', 20 * 1024 * 1024),
  mediaTimeoutMs: posInt(env, 'TELEGRAM_MEDIA_TIMEOUT_MS', 30000), // per Telegram request: getFile, then the download, then a sendVoice upload
  transcribeTimeoutMs: posInt(env, 'TELEGRAM_TRANSCRIBE_TIMEOUT_MS', 120000),
  // Voice replies (README "Voice replies"). maxSpokenChars pairs with addons/voice's
  // ATLAS_VOICE_MAX_SPOKEN_CHARS, which silently truncates: keep it at or below that.
  maxSpokenChars: Math.max(50, posInt(env, 'TELEGRAM_MAX_SPOKEN_CHARS', 700)), // per /api/voice/speak call
  maxVoiceChars: posInt(env, 'TELEGRAM_MAX_VOICE_CHARS', 3000), // above this the reply goes out as text
  ttsTimeoutMs: posInt(env, 'TELEGRAM_TTS_TIMEOUT_MS', 30000), // per chunk
  ffmpegTimeoutMs: posInt(env, 'TELEGRAM_FFMPEG_TIMEOUT_MS', 60000), // also each ffprobe / frame / soundtrack run of an incoming video
  // Pictures, videos, documents in (README "Pictures, videos and documents"): the cap
  // is checked against Telegram's own file_size BEFORE any download, and is itself
  // capped by Telegram's 20 MB getFile limit (see maxAudioBytes above).
  maxMediaBytes: posInt(env, 'TELEGRAM_MAX_MEDIA_BYTES', 20 * 1024 * 1024),
  maxVideoSeconds: posInt(env, 'TELEGRAM_MAX_VIDEO_SECONDS', 120), // longer videos are accepted, but only this much soundtrack is transcribed
  videoFrames: posInt(env, 'TELEGRAM_VIDEO_FRAMES', 6), // at most this many stills per video
  videoFramePx: posInt(env, 'TELEGRAM_VIDEO_FRAME_PX', 1024), // longest edge of a still
  mediaKeepDays: posInt(env, 'TELEGRAM_MEDIA_KEEP_DAYS', 14),
  mediaDir: mediaDir(env),
  // The long-poll consumer (README "Long-polling, not a webhook").
  pollTimeoutS: posInt(env, 'TELEGRAM_POLL_TIMEOUT_S', 50), // getUpdates' own "timeout" param — how long Telegram holds the request open with nothing new
  pollErrorBackoffMs: posInt(env, 'TELEGRAM_POLL_ERROR_BACKOFF_MS', 1000), // first retry delay after a failed getUpdates
  pollErrorBackoffMaxMs: posInt(env, 'TELEGRAM_POLL_ERROR_BACKOFF_MAX_MS', 30000), // the backoff doubles up to this cap
})

/** Telegram's Bot API is one base URL PER METHOD, token embedded in the path —
 *  unlike Meta's bearer header, so callers must never LOG a URL built from this
 *  (it would leak the token into the log). */
export const apiUrl = (token, method) => `https://api.telegram.org/bot${token}/${method}`
export const fileUrl = (token, filePath) => `https://api.telegram.org/file/bot${token}/${filePath}`

/** Where operator-local state lives — the same dir the agent runtime and the
 *  other addons (whatsapp, news-ingest) keep theirs in. Never the repo, never
 *  the vault: it is bookkeeping, not knowledge. */
export const stateFile = (env = process.env) =>
  str(env, 'TELEGRAM_STATE_FILE', path.join(str(env, 'AGENT_LOCAL_DIR', path.join(os.homedir(), '.atlas-kit')), 'telegram.json'))

/** The getUpdates offset, kept apart from the session state so the poller and
 *  the agent bookkeeping never read-modify-write the same file. */
export const offsetFile = (env = process.env) => path.join(path.dirname(stateFile(env)), 'telegram-offset.json')

/** The singleton pidfile — see poller.mjs: at most one process on this box may
 *  hold Telegram's one getUpdates consumer. */
export const lockFile = (env = process.env) => path.join(path.dirname(stateFile(env)), 'telegram-poller.lock')

/** Where incoming pictures / videos / documents are kept for the agent to look
 *  at: a `telegram-media/` folder next to the state file. Operator-local, never
 *  the repo or the vault. */
export const mediaDir = (env = process.env) => path.join(path.dirname(stateFile(env)), 'telegram-media')

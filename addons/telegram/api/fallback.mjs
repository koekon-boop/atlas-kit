/* ------------------------------------------------------------------ *
 * Automatic emergency fallback (the README section of the same name): when
 * the standing Telegram session cannot reach Anthropic at all (an expired
 * login, a weekly/5h rate limit, a billing error — fallback-detect.mjs's
 * job), a REPLACEMENT knowledge chat on a different model-BACKEND profile
 * (providers.json, see docs/PROVIDERS.md) takes over the SAME Telegram
 * conversation until the subscription works again, then hands back with one
 * message summarizing what it answered in the meantime.
 *
 *   onFallbackTick()      the poller-tick hook (register.mjs, next to
 *                         inbound.flushRoutes()): while NOT active, re-checks
 *                         the main session's transcript; while active, decides
 *                         whether it is time to probe for recovery
 *   deliverToFallback()   one message → the fallback session, spawning it
 *                         (trying TELEGRAM_FALLBACK_PROVIDERS in order) or
 *                         reusing the live one from a previous episode
 *   switchToMain()        the handoff: one message to the main session
 *                         listing what came in and what the fallback replied,
 *                         explicitly marked already-answered
 *   tryInterceptCommand() /ersatz, /claude, /modell — home-chat only
 *
 * State lives nested (`fallback: {...}`) in the SAME small state file as the
 * rest of the addon (telegram.json) — one more key, not a second file.
 *
 * TELEGRAM_FALLBACK_PROVIDERS="" (explicitly empty) is the documented kill
 * switch for ALL of this — see fallbackProviders() in config.mjs. Every entry
 * point below checks it (directly, or through the `active` flag it gates).
 * ------------------------------------------------------------------ */
import { spawn } from 'node:child_process'
import os from 'node:os'
import { requireClaudeBin } from '../../../api/src/claude-bin.mjs'
import { config, stateFile } from './config.mjs'
import { core, framed, forwardToAgent, readState, saveState, sessionBrief } from './agent.mjs'
import { detectBlocked } from './fallback-detect.mjs'

const LOG_CAP = 30
const LOG_TEXT_CAP = 300

const REASON_LABEL = {
  rate_limit: 'Ratenlimit erreicht',
  authentication_failed: 'Anmeldung abgelaufen',
  billing_error: 'Abrechnungsproblem',
  manual: 'von Hand ausgelöst',
}

function emptyFallback() {
  return {
    active: false,
    reason: null,
    resetText: null,
    resetAt: null,
    since: null,
    fallbackSessionId: null,
    providerUsed: null,
    providerOverride: null,
    switchedAt: null,
    noted: false, // a pending "you are the fallback" announcement is owed
    lastProbeAt: null,
    log: [], // { dir: 'in'|'out', text, at } — what the handoff summarizes
    counters: { switches: 0, delivered: 0, probes: 0 },
  }
}

function readFallback(file) {
  const fb = readState(file).fallback
  if (!fb || typeof fb !== 'object') return emptyFallback()
  return { ...emptyFallback(), ...fb, counters: { ...emptyFallback().counters, ...(fb.counters || {}) } }
}

function saveFallback(patch, file) {
  const state = readState(file)
  saveState({ ...state, fallback: { ...readFallback(file), ...patch } }, file)
}

function bumpCounters(file, inc) {
  const fb = readFallback(file)
  const counters = { ...fb.counters }
  for (const [k, v] of Object.entries(inc)) counters[k] = (counters[k] || 0) + v
  saveFallback({ counters }, file)
}

/** Flip into fallback mode. `switches` counts only a genuine inactive→active
 *  transition (the tick-driven re-detection never re-enters this while
 *  already active), and `noted` resets to false only on that same transition
 *  — so a provider-only update on an already-active episode never re-queues
 *  the "you are the fallback" announcement. */
function activate(file, patch) {
  const fb = readFallback(file)
  const wasActive = fb.active
  saveFallback({ ...patch, active: true, noted: wasActive ? fb.noted : false }, file)
  if (!wasActive) bumpCounters(file, { switches: 1 })
}

/** Append one log line (capped), for the eventual handoff summary. */
function appendLog(file, dir, text) {
  const fb = readFallback(file)
  const log = [...fb.log, { dir, text: String(text || '').slice(0, LOG_TEXT_CAP), at: new Date().toISOString() }].slice(-LOG_CAP)
  saveFallback({ log }, file)
}

/** Cheap, no network: is the channel in fallback mode right now? What
 *  inbound.mjs's deliver() branches on for every unrouted message. */
export function fallbackActive(file = stateFile()) {
  return !!readFallback(file).active
}

/* --- the lost-message guard --------------------------------------------- *
 * The incident this exists for: Ko writes "Hallo", it reaches the standing
 * session fine (a /prompt or /queue 200), the session's OWN turn then fails
 * against Anthropic, and nobody ever answers — detection only runs on the
 * NEXT poller tick, by which point the message that triggered the failure is
 * long delivered and forgotten. So every message handed to the MAIN session
 * (never the fallback one — that path never touches this) is remembered here,
 * top-level in the state file (outside `fallback`, since it must keep
 * accruing independent of whether fallback is active), capped at
 * DELIVERY_CAP entries / DELIVERY_MAX_AGE_MS old. On activation, every entry
 * strictly after fallback-detect's `cutoffAt` is replayed to the fallback
 * session, in order — see onFallbackTick below. */
const DELIVERY_CAP = 10
const DELIVERY_MAX_AGE_MS = 30 * 60 * 1000

/** Record one message just handed to the MAIN session — called from
 *  inbound.mjs's deliver() right after a successful forwardToAgent, never
 *  while fallback is already active (that path never reaches main at all). */
export function recordMainDelivery({ chatId, text }, { file = stateFile() } = {}) {
  const state = readState(file)
  const now = Date.now()
  const kept = (Array.isArray(state.mainDeliveries) ? state.mainDeliveries : []).filter((e) => now - Date.parse(e.at) < DELIVERY_MAX_AGE_MS)
  kept.push({ at: new Date(now).toISOString(), chatId, text: String(text ?? '') })
  saveState({ ...state, mainDeliveries: kept.slice(-DELIVERY_CAP) }, file)
}

/** Every recorded main-session delivery strictly after `cutoffAt`, oldest
 *  first. `[]` when `cutoffAt` is not a finite number (nothing to replay). */
function mainDeliveriesSince(file, cutoffAt) {
  if (!Number.isFinite(cutoffAt)) return []
  const list = readState(file).mainDeliveries
  if (!Array.isArray(list)) return []
  return list.filter((e) => Date.parse(e.at) > cutoffAt).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

async function describeMain(d) {
  const file = d.file ?? stateFile(d.env)
  const state = readState(file)
  if (!state.sessionId) return null
  const r = await core('GET', `/api/agents/describe?id=${encodeURIComponent(state.sessionId)}`, null, d)
  if (!r.ok || !r.body?.session) return null
  return r.body.session
}

const fallbackHeader = (fb) =>
  `WICHTIG — DU BIST GERADE DIE ERSATZ-SITZUNG. Die Haupt-Sitzung (das reguläre Claude-Abo) ist blockiert: ${REASON_LABEL[fb.reason] || fb.reason || 'unbekannt'}${fb.resetText ? ` (${fb.resetText})` : ''}. Du antwortest über ein ANDERES Modell-Backend (OpenRouter) — jede Antwort kostet echtes Geld, also arbeite knapp. Gleiche Regeln wie sonst (Antwortweg, Ton, Sprache). Sag Ko EINMAL, ganz am Anfang deiner ERSTEN Antwort in diesem Notbetrieb, in einem kurzen Satz, dass gerade der Ersatz antwortet und — falls bekannt — wann Claude voraussichtlich zurück ist. Danach normal weiterarbeiten, bis eine Nachricht kommt, dass Claude wieder übernimmt.\n\n`

async function trySpawnFallback(providers, task, d) {
  for (const provider of providers) {
    const r = await core('POST', '/api/agents/spawn', { task, kind: 'knowledge', vault: 'atlas', model: 'opus', provider }, d)
    if (r.ok && r.body?.id) return { ok: true, id: r.body.id, provider }
  }
  return { ok: false, error: `no fallback provider could be spawned (tried ${providers.join(', ') || 'none'})` }
}

/**
 * One message → the fallback session: reuse the live one from a previous
 * episode (via /prompt or /queue, exactly forwardToAgent's own reuse rule),
 * or spawn a fresh one by trying TELEGRAM_FALLBACK_PROVIDERS (or a forced
 * single override from /ersatz <profile>) in order, the first that spawns
 * wins. The caller (inbound.mjs's deliver(), or a command handler) has
 * already decided fallback mode applies — this never touches the main
 * session. → `{ ok, via, id, provider? }` | `{ ok: false, error }`.
 */
export async function deliverToFallback({ chatId, text }, deps = {}) {
  const d = { env: process.env, fetch: globalThis.fetch, file: undefined, ...deps }
  const c = config(d.env)
  const file = d.file ?? stateFile(d.env)
  const fb = readFallback(file)
  let live = null
  if (fb.fallbackSessionId) {
    const list = await core('GET', '/api/agents', null, d)
    if (!list.ok) return { ok: false, error: `GET /api/agents → ${list.status}` }
    live = (list.body.sessions || []).find((s) => s.id === fb.fallbackSessionId) || null
    if (live && ['done', 'error', 'dormant'].includes(live.status)) live = null
  }
  const header = fb.noted ? '' : fallbackHeader(fb)
  if (!live) {
    const providers = fb.providerOverride ? [fb.providerOverride] : c.fallbackProviders
    if (!providers.length) return { ok: false, error: 'no fallback provider configured (TELEGRAM_FALLBACK_PROVIDERS is empty)' }
    const brief = sessionBrief({
      port: c.apiPort,
      maxVoiceChars: c.maxVoiceChars,
      homeChatId: c.homeChatId,
      otherChats: c.allowedChatIds.filter((x) => x !== c.homeChatId),
    })
    const task = `${header}${brief}\n\n---\nFirst message:\n${framed(chatId, text)}`
    const r = await trySpawnFallback(providers, task, d)
    if (!r.ok) return r
    saveFallback({ fallbackSessionId: r.id, providerUsed: r.provider, noted: true, switchedAt: fb.switchedAt || new Date().toISOString() }, file)
    bumpCounters(file, { delivered: 1 })
    appendLog(file, 'in', text)
    return { ok: true, via: 'spawn', id: r.id, provider: r.provider }
  }
  const message = { id: live.id, text: `${header}${framed(chatId, text)}` }
  if (live.status !== 'running') {
    const p = await core('POST', '/api/agents/prompt', message, d)
    if (p.ok) {
      if (header) saveFallback({ noted: true }, file)
      bumpCounters(file, { delivered: 1 })
      appendLog(file, 'in', text)
      return { ok: true, via: 'prompt', id: live.id, provider: fb.providerUsed }
    }
  }
  const q = await core('POST', '/api/agents/queue', message, d)
  if (q.ok) {
    if (header) saveFallback({ noted: true }, file)
    bumpCounters(file, { delivered: 1 })
    appendLog(file, 'in', text)
    return { ok: true, via: 'queue', id: live.id, provider: fb.providerUsed }
  }
  return { ok: false, error: `queue → ${q.status} ${q.body?.error || ''}`.trim() }
}

/** Note an OUTBOUND reply for the eventual handoff summary — register.mjs
 *  calls this from POST /api/telegram/send, only while fallback is active. */
export function noteOutbound(text, { file = stateFile() } = {}) {
  if (!fallbackActive(file)) return
  appendLog(file, 'out', text)
}

function buildHandoffText(fb) {
  const lines = fb.log.length
    ? fb.log.map((e) => `${e.dir === 'in' ? '← Ko' : '→ Ersatz'}: ${e.text}`)
    : ['(keine Nachrichten in der Zwischenzeit)']
  return [
    'SYSTEM-HANDOFF: Der Notbetrieb ist beendet — du bist wieder dran.',
    `Während du blockiert warst (${REASON_LABEL[fb.reason] || fb.reason || 'unbekannt'}${fb.resetText ? `, ${fb.resetText}` : ''}) hat die Ersatz-Sitzung (${fb.providerUsed || 'ein Ersatz-Modell'}) für dich geantwortet. Diese Nachrichten sind SCHON BEANTWORTET — beantworte sie NICHT noch einmal, führe nur Offenes weiter:`,
    ...lines,
  ].join('\n')
}

/**
 * The handback: one message to the MAIN session (spawning it fresh if it is
 * somehow gone too — forwardToAgent's own rule) summarizing what came in and
 * went out while it was blocked, then clears the episode (the fallback
 * session itself is left idle, for the next episode to reuse).
 * → whatever forwardToAgent returns. `{ ok: false, error }` if fallback
 * was not active at all.
 */
export async function switchToMain(deps = {}) {
  const d = { env: process.env, fetch: globalThis.fetch, file: undefined, ...deps }
  const c = config(d.env)
  const file = d.file ?? stateFile(d.env)
  const fb = readFallback(file)
  if (!fb.active) return { ok: false, error: 'der Notbetrieb ist gerade nicht aktiv' }
  const r = await forwardToAgent({ chatId: c.homeChatId, text: buildHandoffText(fb) }, d)
  saveFallback(
    { active: false, reason: null, resetText: null, resetAt: null, since: null, switchedAt: null, noted: true, lastProbeAt: null, log: [], providerOverride: null },
    file,
  )
  return r
}

/** The cheap probe: one `claude -p` turn on the plain, default Anthropic env
 *  (never a provider override) — success means the subscription answers
 *  again. Exit 0 is enough; the content is never read. Injectable. */
export function probeClaude({ env = process.env, model = 'claude-haiku-4-5', timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    let bin
    try {
      bin = requireClaudeBin()
    } catch {
      return resolve(false)
    }
    const child = spawn(bin, ['-p', '--model', model, '--output-format', 'text'], {
      cwd: os.homedir(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...env, ANTHROPIC_API_KEY: '' },
    })
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      resolve(ok)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(false)
    }, timeoutMs)
    child.on('error', () => {
      clearTimeout(timer)
      finish(false)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish(code === 0)
    })
    child.stdin.write('Antworte nur mit OK.')
    child.stdin.end()
  })
}

/**
 * The poller-tick hook (register.mjs wires this in beside inbound.flushRoutes()):
 *   not active  → re-read the main session's transcript tail; a detected block
 *                 flips into fallback mode (no message is spawned yet — the
 *                 first real inbound message does that, lazily, through
 *                 deliverToFallback, so a quiet block costs nothing until
 *                 there is something to answer)
 *   active      → due for a probe? (past the known reset time, or every
 *                 fallbackProbeIntervalMs when it isn't known) → run it, and
 *                 hand back on success
 * A no-op (not even the describe lookup) once TELEGRAM_FALLBACK_PROVIDERS is
 * empty. Never throws.
 */
export async function onFallbackTick(deps = {}) {
  // tail/buildPath/statFile: detectBlocked's own injectable deps, threaded
  // through so a test can fake the transcript without touching the real
  // filesystem — never read by anything else here.
  const { tail, buildPath, statFile, ...rest } = deps
  const d = { env: process.env, fetch: globalThis.fetch, file: undefined, log: console.error, probe: probeClaude, ...rest }
  const c = config(d.env)
  if (!c.fallbackProviders.length) return
  const file = d.file ?? stateFile(d.env)
  const fb = readFallback(file)
  const now = Date.now()
  if (!fb.active) {
    const main = await describeMain(d)
    if (!main) return
    const det = detectBlocked({
      worktree: main.worktree,
      claudeSessionId: main.claudeSessionId,
      now,
      staleMs: c.fallbackStaleMs,
      ...(tail ? { tail } : {}),
      ...(buildPath ? { buildPath } : {}),
      ...(statFile ? { statFile } : {}),
    })
    if (det.blocked) {
      activate(file, { reason: det.reason, resetAt: det.resetAt, resetText: det.resetText, since: det.since })
      // The lost-message guard: replay, in order, every message handed to the
      // main session after the last point it was known to be working — it
      // never got (and now never will get) an answer from there. Cleared right
      // after, whether or not anything was actually replayed: anything at or
      // before cutoffAt was genuinely already answered and is no longer
      // useful, and anything after it has now been handed to the replacement
      // — either way, NOTHING here may survive to be replayed a second time
      // in a later episode (a handback within the 30-min window would
      // otherwise see the SAME old entries again and double-deliver them).
      const lost = mainDeliveriesSince(file, det.cutoffAt)
      saveState({ ...readState(file), mainDeliveries: [] }, file)
      for (const item of lost) {
        await deliverToFallback({ chatId: item.chatId, text: item.text }, d)
      }
    }
    return
  }
  const switchedAtMs = Date.parse(fb.switchedAt || '') || now
  const nextProbeAt = fb.lastProbeAt ? fb.lastProbeAt + c.fallbackProbeIntervalMs : fb.resetAt || switchedAtMs + c.fallbackProbeIntervalMs
  if (now < nextProbeAt) return
  saveFallback({ lastProbeAt: now }, file)
  bumpCounters(file, { probes: 1 })
  const ok = await d.probe({ env: d.env, model: c.fallbackProbeModel, timeoutMs: c.fallbackProbeTimeoutMs })
  if (ok) await switchToMain(d)
}

const PROVIDER_ALIASES = { deepseek: 'deepseek-openrouter', gpt: 'gpt-openrouter' }

/**
 * /ersatz [profile], /claude, /modell — home-chat only, handled by this addon
 * itself (never forwarded to an agent). → `{ handled: false }` for anything
 * else (including these words from a non-home chat — they fall through to an
 * ordinary message there). Never throws.
 */
export async function tryInterceptCommand(text, chatId, deps = {}) {
  const d = { env: process.env, fetch: globalThis.fetch, file: undefined, log: console.error, ...deps }
  const c = config(d.env)
  if (!c.homeChatId || chatId !== c.homeChatId) return { handled: false }
  const m = /^\/(ersatz|claude|modell)(?:\s+(\S+))?\s*$/i.exec(String(text ?? '').trim())
  if (!m) return { handled: false }
  const cmd = m[1].toLowerCase()
  const arg = (m[2] || '').toLowerCase()
  const file = d.file ?? stateFile(d.env)

  if (cmd === 'modell') {
    const fb = readFallback(file)
    if (!fb.active) return { handled: true, reply: 'Claude antwortet gerade normal — kein Notbetrieb aktiv.' }
    return {
      handled: true,
      reply: `Der Ersatz (${fb.providerUsed || '?'}) antwortet gerade — Grund: ${REASON_LABEL[fb.reason] || fb.reason || 'unbekannt'}${fb.resetText ? `, ${fb.resetText}` : ''}.`,
    }
  }
  if (cmd === 'claude') {
    if (!readFallback(file).active) return { handled: true, reply: 'Claude ist schon dran — kein Notbetrieb aktiv.' }
    const r = await switchToMain(d)
    return { handled: true, reply: r.ok ? 'Zurück auf Claude — die Übergabe ist raus.' : `Konnte nicht zurückschalten: ${r.error}` }
  }
  // '/ersatz'
  if (!c.fallbackProviders.length) return { handled: true, reply: 'Der Notbetrieb ist nicht konfiguriert (TELEGRAM_FALLBACK_PROVIDERS ist leer).' }
  let forced = null
  if (arg) {
    forced = PROVIDER_ALIASES[arg] || (c.fallbackProviders.includes(arg) ? arg : null)
    if (!forced) return { handled: true, reply: `Unbekanntes Profil "${arg}".` }
  }
  activate(file, { reason: 'manual', resetAt: null, resetText: null, since: Date.now(), providerOverride: forced })
  const r = await deliverToFallback({ chatId, text: '(Der Operator hat den Notbetrieb von Hand ausgelöst — keine eigentliche Nachricht.)' }, d)
  return { handled: true, reply: r.ok ? `Ersatz (${r.provider || readFallback(file).providerUsed}) übernimmt jetzt.` : `Konnte nicht umschalten: ${r.error}` }
}

/** `GET /api/addons`' telegram.status.fallback. */
export function fallbackStatus({ file = stateFile(), env = process.env } = {}) {
  const c = config(env)
  const fb = readFallback(file)
  return {
    enabled: c.fallbackProviders.length > 0,
    providers: c.fallbackProviders,
    active: fb.active,
    reason: fb.reason,
    resetAt: fb.resetAt ? new Date(fb.resetAt).toISOString() : null,
    resetText: fb.resetText,
    fallbackSession: fb.fallbackSessionId,
    provider: fb.providerUsed,
    switchedAt: fb.switchedAt,
    counters: fb.counters,
  }
}

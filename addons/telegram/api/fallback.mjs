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
 * Hardened after the outages of 24./25.11.2026 (README "Automatic fallback" →
 * "What keeps it from getting stuck"):
 *   · the fallback session is spawned under its OWN id prefix and can never
 *     take over the standing session's id (spawnTitle() in agent.mjs)
 *   · while active, a recovery probe ALWAYS comes due — an episode without a
 *     start time probes at once instead of never
 *   · a fallback that fails itself (no credits, …) → probe Claude at once;
 *     if that fails too: ONE direct Bot-API note to the home chat per outage,
 *     and every message is buffered (`pending`) until something can answer
 *   · a safety refusal ("Start a new session") replaces the standing session
 *   · a transient error first tries Claude again before paying for a fallback
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
import { channelBrief, core, framed, forwardToAgent, readState, saveState, spawnTitle } from './agent.mjs'
import { detectBlocked } from './fallback-detect.mjs'
import { sendMessage } from './telegram.mjs'

const LOG_CAP = 30
const LOG_TEXT_CAP = 300
// Messages nobody has answered yet, kept in FULL (unlike the log) so the
// handback can hand them over verbatim. Far above any real backlog.
const PENDING_CAP = 50
// While even the fallback is down, probe Claude at least this often — Ko is
// waiting on every message in the buffer.
const OUTAGE_PROBE_MS = 5 * 60 * 1000
// Refusal restarts and transient retries are both counted over this window.
const WINDOW_MS = 30 * 60 * 1000
// A transient error is retried on Claude at most this often per window before
// the paid fallback takes over after all.
const RETRY_CAP = 2

const REASON_LABEL = {
  rate_limit: 'Ratenlimit erreicht',
  authentication_failed: 'Anmeldung abgelaufen',
  billing_error: 'Abrechnungsproblem / Guthaben leer',
  refused: 'Ablehnung durch den Sicherheitsfilter',
  server_error: 'Verbindungsfehler',
  manual: 'von Hand ausgelöst',
}
const label = (reason) => REASON_LABEL[reason] || reason || 'unbekannt'

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
    outage: null, // { since, reason, notifiedAt } — the fallback is down too
    pending: [], // { chatId, text, at } — not answered yet (full text, see PENDING_CAP)
    log: [], // { dir: 'in'|'out', text, at } — what the handoff summarizes
    counters: { switches: 0, delivered: 0, probes: 0, buffered: 0, outages: 0, restarts: 0, retries: 0 },
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
  // A fresh episode gets its start time HERE — it used to be set only when a
  // fallback session was SPAWNED, so an episode that reused a live one had
  // `switchedAt: null` and its recovery probe never came due (25.11.2026).
  const fresh = wasActive ? {} : { switchedAt: new Date().toISOString(), lastProbeAt: null, outage: null, pending: [] }
  saveFallback({ ...patch, ...fresh, active: true, noted: wasActive ? fb.noted : false }, file)
  if (!wasActive) bumpCounters(file, { switches: 1 })
}

/** One message nobody has answered yet — cleared by the next fallback reply
 *  (noteOutbound), handed over verbatim on the handback otherwise. */
function pushPending(file, chatId, text) {
  const fb = readFallback(file)
  saveFallback({ pending: [...fb.pending, { chatId, text: String(text ?? ''), at: new Date().toISOString() }].slice(-PENDING_CAP) }, file)
}

/** A stale error line must not decide anything: one older than the last time
 *  main was handed back / replaced / retried is from BEFORE that, and the
 *  session simply has not written a newer line yet. */
const resumedAt = (file) => Number(readState(file).mainResumedAt) || 0
const markResumed = (file, patch = {}) => saveState({ ...readState(file), ...patch, mainResumedAt: Date.now() }, file)

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

async function describeSession(id, d) {
  if (!id) return null
  const r = await core('GET', `/api/agents/describe?id=${encodeURIComponent(id)}`, null, d)
  if (!r.ok || !r.body?.session) return null
  return { id, ...r.body.session }
}

const fallbackHeader = (fb) =>
  `WICHTIG — DU BIST GERADE DIE ERSATZ-SITZUNG. Die Haupt-Sitzung (das reguläre Claude-Abo) ist blockiert: ${label(fb.reason)}${fb.resetText ? ` (${fb.resetText})` : ''}. Du antwortest über ein ANDERES Modell-Backend (OpenRouter) — jede Antwort kostet echtes Geld, also arbeite knapp. Gleiche Regeln wie sonst (Antwortweg, Ton, Sprache). Sag Ko EINMAL, ganz am Anfang deiner ERSTEN Antwort in diesem Notbetrieb, in einem kurzen Satz, dass gerade der Ersatz antwortet und — falls bekannt — wann Claude voraussichtlich zurück ist. Danach normal weiterarbeiten, bis eine Nachricht kommt, dass Claude wieder übernimmt.\n\n`

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
 * session. While the fallback itself is down (`outage`), the message is only
 * BUFFERED — never sent into a session that cannot answer, never dropped.
 * → `{ ok, via: 'spawn'|'prompt'|'queue'|'buffered', id?, provider? }` | `{ ok: false, error }`.
 */
export async function deliverToFallback({ chatId, text }, deps = {}) {
  const d = { env: process.env, fetch: globalThis.fetch, file: undefined, ...deps }
  const c = config(d.env)
  const file = d.file ?? stateFile(d.env)
  const fb = readFallback(file)
  if (fb.outage) {
    pushPending(file, chatId, text)
    bumpCounters(file, { buffered: 1 })
    appendLog(file, 'in', text)
    return { ok: true, via: 'buffered' }
  }
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
    // Its own title line FIRST — that is what core derives the session id
    // from (spawnTitle in agent.mjs), so it can never collide with the
    // standing session's id again.
    const task = `${spawnTitle('fallback')}\n\n${header}${channelBrief(c)}\n\n---\nFirst message:\n${framed(chatId, text)}`
    const r = await trySpawnFallback(providers, task, d)
    if (!r.ok) return r
    saveFallback({ fallbackSessionId: r.id, providerUsed: r.provider, noted: true, switchedAt: fb.switchedAt || new Date().toISOString() }, file)
    bumpCounters(file, { delivered: 1 })
    appendLog(file, 'in', text)
    pushPending(file, chatId, text)
    return { ok: true, via: 'spawn', id: r.id, provider: r.provider }
  }
  const message = { id: live.id, text: `${header}${framed(chatId, text)}` }
  if (live.status !== 'running') {
    const p = await core('POST', '/api/agents/prompt', message, d)
    if (p.ok) {
      if (header) saveFallback({ noted: true }, file)
      bumpCounters(file, { delivered: 1 })
      appendLog(file, 'in', text)
      pushPending(file, chatId, text)
      return { ok: true, via: 'prompt', id: live.id, provider: fb.providerUsed }
    }
  }
  const q = await core('POST', '/api/agents/queue', message, d)
  if (q.ok) {
    if (header) saveFallback({ noted: true }, file)
    bumpCounters(file, { delivered: 1 })
    appendLog(file, 'in', text)
    pushPending(file, chatId, text)
    return { ok: true, via: 'queue', id: live.id, provider: fb.providerUsed }
  }
  return { ok: false, error: `queue → ${q.status} ${q.body?.error || ''}`.trim() }
}

/** Note an OUTBOUND reply for the eventual handoff summary — register.mjs
 *  calls this from POST /api/telegram/send, only while fallback is active.
 *  A reply also answers everything pending so far (the brief's rule: several
 *  messages → one reply). */
export function noteOutbound(text, { file = stateFile() } = {}) {
  if (!fallbackActive(file)) return
  appendLog(file, 'out', text)
  saveFallback({ pending: [] }, file)
}

function buildHandoffText(fb) {
  // With messages still pending, the log's tail after the last reply IS those
  // messages — they belong in the "not answered" block, not under "answered".
  const lastOut = fb.log.map((e) => e.dir).lastIndexOf('out')
  const answered = fb.pending.length ? fb.log.slice(0, lastOut + 1) : fb.log
  const lines = answered.length
    ? answered.map((e) => `${e.dir === 'in' ? '← Ko' : '→ Ersatz'}: ${e.text}`)
    : ['(keine Nachrichten in der Zwischenzeit)']
  const open = fb.pending.length
    ? [
        '',
        `NOCH UNBEANTWORTET — diese ${fb.pending.length === 1 ? 'Nachricht hat' : `${fb.pending.length} Nachrichten haben`} noch keine Antwort bekommen${fb.outage ? ' (auch der Ersatz war nicht erreichbar)' : ''}. Beantworte sie JETZT, zusammen in einer Antwort:`,
        ...fb.pending.map((p) => `[Telegram from ${p.chatId}] ${p.text}`),
      ]
    : []
  return [
    'SYSTEM-HANDOFF: Der Notbetrieb ist beendet — du bist wieder dran.',
    `Während du blockiert warst (${label(fb.reason)}${fb.resetText ? `, ${fb.resetText}` : ''}) hat die Ersatz-Sitzung (${fb.providerUsed || 'ein Ersatz-Modell'}) für dich geantwortet. Diese Nachrichten sind SCHON BEANTWORTET — beantworte sie NICHT noch einmal, führe nur Offenes weiter:`,
    ...lines,
    ...open,
  ].join('\n')
}

/**
 * The handback: one message to the MAIN session (spawning it fresh if it is
 * somehow gone too — forwardToAgent's own rule) summarizing what came in and
 * went out while it was blocked — plus, verbatim, everything still
 * unanswered — then clears the episode (the fallback session itself is left
 * idle, for the next episode to reuse). If the handoff cannot be delivered,
 * the episode stays active (nothing pending is thrown away); the next probe
 * tries again.
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
  if (!r.ok) return r
  saveFallback(
    { active: false, reason: null, resetText: null, resetAt: null, since: null, switchedAt: null, noted: true, lastProbeAt: null, log: [], pending: [], outage: null, providerOverride: null },
    file,
  )
  // The main session's old error line is still its LAST line until it writes
  // the handoff turn — it must not flip the channel straight back over.
  markResumed(file)
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

/** detectBlocked() for one described session; the test-only tail/buildPath/
 *  statFile deps are threaded through, nothing else reads them. */
function detectFor(session, now, c, t) {
  return detectBlocked({
    worktree: session.worktree,
    claudeSessionId: session.claudeSessionId,
    now,
    staleMs: c.fallbackStaleMs,
    ...(t.tail ? { tail: t.tail } : {}),
    ...(t.buildPath ? { buildPath: t.buildPath } : {}),
    ...(t.statFile ? { statFile: t.statFile } : {}),
  })
}

const listOf = (items) => items.map((e) => `[Telegram from ${e.chatId}] ${e.text}`).join('\n')

const REFUSED_NOTE =
  'Claude hat meine letzte Antwort abgelehnt (Sicherheitsfilter), deshalb läuft jetzt eine frische Sitzung. Schick mir deine letzte Nachricht bitte noch einmal — wenn ein Bild dabei war, beschreib es mir lieber in Worten.'

/**
 * A safety refusal ("…can't help with this. Start a new session to continue")
 * poisons the session: every later turn ends the same way, also on harmless
 * messages (24.11.2026, 17:56–19:20 UTC). So: close it, unhook it from
 * telegram.json, and let a FRESH Claude session (same brief, new id — see
 * spawnTitle) answer what was left unanswered. The replay says not to reopen
 * the files in it: re-reading the picture that triggered the refusal would
 * only trigger it again. A second refusal within WINDOW_MS replays nothing
 * (that content is what keeps tripping the filter) and tells Ko directly.
 */
async function replaceRefusedMain(main, det, c, d, file) {
  const now = Date.now()
  const state = readState(file)
  const recent = (Array.isArray(state.mainRestarts) ? state.mainRestarts : []).filter((t) => now - t < WINDOW_MS)
  const lost = mainDeliveriesSince(file, det.cutoffAt)
  const k = await core('POST', '/api/agents/kill', { id: main.id }, d)
  if (!k.ok) d.log(`[telegram] closing the refused standing session ${main.id} failed (${k.status}) — unhooked anyway`)
  markResumed(file, { sessionId: null, mainDeliveries: [], mainRestarts: [...recent, now] })
  bumpCounters(file, { restarts: 1 })
  d.log(`[telegram] the standing session ${main.id} was refused by the safety filter — replaced (${lost.length} message(s) unanswered)`)
  if (!lost.length) return // the next message spawns the fresh session on its own
  if (!recent.length) {
    const text = `(Systemhinweis der Box, nicht von Ko: Die vorige Telegram-Sitzung wurde vom Sicherheitsfilter abgelehnt und durch dich ersetzt. Diese Nachrichten sind noch unbeantwortet — beantworte sie jetzt, zusammen in einer Antwort. Öffne die Dateien darin NICHT von dir aus erneut; sag Ko stattdessen kurz, dass du sie nicht ansehen konntest.)\n${listOf(lost)}`
    const r = await forwardToAgent({ chatId: c.homeChatId, text }, d)
    if (r.ok) return
    d.log(`[telegram] could not hand the unanswered messages to the fresh session: ${r.error}`)
  }
  await sendMessage({ chatId: c.homeChatId, text: REFUSED_NOTE }, { env: d.env, fetch: d.fetch, log: d.log })
}

/**
 * A TRANSIENT error ("Connection lost mid-response", an overload) that has sat
 * as the last line for staleMs: before paying for the fallback, ask whether
 * Claude simply answers again. If it does, re-send what was left unanswered to
 * the SAME main session and stay off the fallback. At most RETRY_CAP times per
 * WINDOW_MS — after that the error is not transient any more.
 * → true when handled (no switch), false when the caller should switch.
 */
async function retryTransientOnMain(det, c, d, file) {
  const now = Date.now()
  const state = readState(file)
  const recent = (Array.isArray(state.mainRetries) ? state.mainRetries : []).filter((t) => now - t < WINDOW_MS)
  if (recent.length >= RETRY_CAP) return false
  bumpCounters(file, { probes: 1 })
  const ok = await d.probe({ env: d.env, model: c.fallbackProbeModel, timeoutMs: c.fallbackProbeTimeoutMs })
  if (!ok) return false
  const lost = mainDeliveriesSince(file, det.cutoffAt)
  markResumed(file, { mainDeliveries: [], mainRetries: [...recent, now] })
  bumpCounters(file, { retries: 1 })
  if (!lost.length) return true
  const text = `(Systemhinweis der Box, nicht von Ko: Deine letzte Antwort brach mit einem Fehler ab (${label(det.reason)}). Diese Nachrichten sind noch unbeantwortet — beantworte sie jetzt, zusammen in einer Antwort:)\n${listOf(lost)}`
  const r = await forwardToAgent({ chatId: c.homeChatId, text }, d)
  if (!r.ok) {
    d.log(`[telegram] retrying on the standing session failed: ${r.error}`)
    // put them back, so the switch the caller now makes still replays them
    saveState({ ...readState(file), mainDeliveries: lost }, file)
    return false
  }
  for (const item of lost) recordMainDelivery(item, { file }) // a second failure can replay them again
  return true
}

/** The fallback session itself fails (out of credits — 25.11.2026 from 12:27
 *  UTC every GPT turn ended in a 402 — or any other blocking error newer than
 *  this episode): Claude is probed RIGHT AWAY; if it answers, hand back. If
 *  not, this is an outage: ONE short note straight to the home chat over the
 *  Bot API (no agent involved), every further message buffered. */
async function handleFallbackDown(det, fb, c, d, file) {
  saveFallback({ lastProbeAt: Date.now() }, file)
  bumpCounters(file, { probes: 1 })
  const ok = await d.probe({ env: d.env, model: c.fallbackProbeModel, timeoutMs: c.fallbackProbeTimeoutMs })
  if (ok && (await switchToMain(d)).ok) return
  const outage = { since: Date.now(), reason: det.reason, notifiedAt: null }
  saveFallback({ outage }, file)
  bumpCounters(file, { outages: 1 })
  d.log(`[telegram] the fallback session failed too (${det.reason}) and Claude does not answer — buffering messages`)
  const text = `KI gerade nicht erreichbar. Grund: Claude ${label(fb.reason)}, Ersatz ${label(det.reason)}. Ich halte deine Nachrichten fest und melde mich, sobald es wieder geht.`
  const sent = await sendMessage({ chatId: c.homeChatId, text }, { env: d.env, fetch: d.fetch, log: d.log })
  if (sent?.ok) saveFallback({ outage: { ...outage, notifiedAt: Date.now() } }, file)
}

/**
 * The poller-tick hook (register.mjs wires this in beside inbound.flushRoutes()):
 *   not active  → re-read the main session's transcript tail. A refusal
 *                 replaces the session; a stale transient error first retries
 *                 on Claude; any other block flips into fallback mode (no
 *                 session is spawned yet — the first real inbound message, or
 *                 a replayed lost one, does that through deliverToFallback)
 *   active      → is the fallback session itself failing? → probe now, else
 *                 an outage (see handleFallbackDown). Otherwise: due for a
 *                 probe? — ALWAYS eventually: every fallbackProbeIntervalMs
 *                 from the last probe (or the episode start; an episode with
 *                 no readable start time probes at once), earlier if a known
 *                 reset time comes first; every 5 min at most during an
 *                 outage. A successful probe hands back.
 * A no-op (not even the describe lookup) once TELEGRAM_FALLBACK_PROVIDERS is
 * empty. Never throws.
 */
export async function onFallbackTick(deps = {}) {
  // tail/buildPath/statFile: detectBlocked's own injectable deps, threaded
  // through so a test can fake the transcript without touching the real
  // filesystem — never read by anything else here.
  const { tail, buildPath, statFile, ...rest } = deps
  const t = { tail, buildPath, statFile }
  const d = { env: process.env, fetch: globalThis.fetch, file: undefined, log: console.error, probe: probeClaude, ...rest }
  const c = config(d.env)
  if (!c.fallbackProviders.length) return
  const file = d.file ?? stateFile(d.env)
  try {
    await tick(c, d, t, file)
  } catch (e) {
    d.log(`[telegram] fallback tick failed: ${e?.message || e}`)
  }
}

async function tick(c, d, t, file) {
  const fb = readFallback(file)
  const now = Date.now()
  if (!fb.active) {
    const state = readState(file)
    // A main id equal to the fallback's is the 24./25.11. collision: that
    // session is not the standing Claude session — nothing to check (the next
    // message spawns a fresh one, see forwardToAgent).
    if (!state.sessionId || state.sessionId === fb.fallbackSessionId) return
    const main = await describeSession(state.sessionId, d)
    if (!main) return
    const det = detectFor(main, now, c, t)
    if (!det.blocked || det.since < resumedAt(file)) return
    if (det.reason === 'refused') return replaceRefusedMain(main, det, c, d, file)
    if (det.transient && (await retryTransientOnMain(det, c, d, file))) return
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
    return
  }
  if (!fb.outage && fb.fallbackSessionId) {
    const session = await describeSession(fb.fallbackSessionId, d)
    const det = session ? detectFor(session, now, c, t) : null
    // Only an error from THIS episode: a session reused from an earlier one
    // still ends on that episode's last line until it answers again.
    const episodeStart = Date.parse(fb.switchedAt || '') || 0
    if (det?.blocked && det.since >= episodeStart) return handleFallbackDown(det, fb, c, d, file)
  }
  const interval = fb.outage ? Math.min(c.fallbackProbeIntervalMs, OUTAGE_PROBE_MS) : c.fallbackProbeIntervalMs
  const base = fb.lastProbeAt || Date.parse(fb.switchedAt || '') || fb.since || 0
  let nextProbeAt = base + interval
  if (fb.resetAt && fb.resetAt > (fb.lastProbeAt || 0)) nextProbeAt = Math.min(nextProbeAt, fb.resetAt)
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
      reply: fb.outage
        ? `Gerade antwortet niemand — Claude: ${label(fb.reason)}, Ersatz: ${label(fb.outage.reason)}. ${fb.pending.length} Nachricht(en) warten; ich melde mich, sobald es wieder geht.`
        : `Der Ersatz (${fb.providerUsed || '?'}) antwortet gerade — Grund: ${label(fb.reason)}${fb.resetText ? `, ${fb.resetText}` : ''}.`,
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
  // `outage: null`: a forced /ersatz is also how Ko says "the fallback works
  // again" (e.g. credits topped up) — it must not just land in the buffer.
  activate(file, { reason: 'manual', resetAt: null, resetText: null, since: Date.now(), providerOverride: forced, outage: null })
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
    lastProbeAt: fb.lastProbeAt ? new Date(fb.lastProbeAt).toISOString() : null,
    outage: fb.outage ? { since: new Date(fb.outage.since).toISOString(), reason: fb.outage.reason, notified: !!fb.outage.notifiedAt } : null,
    pending: fb.pending.length,
    counters: fb.counters,
  }
}

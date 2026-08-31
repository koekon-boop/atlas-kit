/* ------------------------------------------------------------------ *
 * The `voice` addon's client half: which fleet events are worth SAYING, and
 * the two ways to say them.
 *
 * 🔴 THE ZERO-INSTALL PATH MAKES NO SERVER CALL. `speak()` below is the
 * browser's own speechSynthesis: no download, no key, no round-trip, and it
 * reads the event LINE this file derives — which costs nothing at all. The
 * `claude -p` recap and the on-box engines are the enrichment on top, reached
 * through the addon's bearer-gated routes, and every one of them degrades to
 * "speak the line" rather than to silence.
 *
 * Everything above the fetch helpers is PURE and unit-tested (voice.test.mjs):
 * the event derivation is the part that decides how often anything speaks, and
 * an off-by-one there is a dashboard that narrates itself.
 * ------------------------------------------------------------------ */
import type { AgentSession, AddonInfo, AgentHistoryMessage } from './api'
// The one VALUE import here carries its extension (the type imports above erase),
// so `node --test` can load this module directly through type-stripping — bare
// specifiers are a bundler convention node does not share. See voice.test.mjs.
import { API_BASE } from './api.ts'

/* --- what the addon says about itself (GET /api/addons → status) ---------- */

export interface VoiceEngineInfo {
  /** An ATLAS_VOICE_*_CMD is set (whether or not it currently works). */
  configured: boolean
  available: boolean
  reason?: string
  cmd?: string
}
export interface VoiceStatus {
  speech: string
  dictation: string
  tts: VoiceEngineInfo
  stt: VoiceEngineInfo
  recap: { model: string; guards: string; day: string; spent: number; budget: number; tripped: boolean }
  bearer: string
}

/** The addon's status block, or null when the addon isn't enabled here. */
export function voiceStatus(info: AddonInfo | null): VoiceStatus | null {
  const s = info?.status as unknown as VoiceStatus | undefined
  return s && s.tts && s.stt ? s : null
}

/* --- fleet events -------------------------------------------------------- */

export type FleetEventKind = 'turn-end' | 'ready' | 'shipped' | 'done' | 'error'

export interface FleetEvent {
  /** Stable across re-renders: one event per agent per kind per timestamp. */
  key: string
  id: string
  agent: string
  kind: FleetEventKind
  at: string
  /** The spoken line itself — free, and the fallback whenever a recap can't run. */
  line: string
  /** The terminal tail as of the event, posted to /api/voice/recap on demand. */
  tail: string
}

/** What we call an agent out loud: the short tag first, then the title, then the
 *  task — truncated, because this is read aloud, not printed. */
export function agentName(s: Pick<AgentSession, 'micro' | 'title' | 'task' | 'id'>): string {
  const raw = (s.micro || s.title || s.task || s.id || 'an agent').replace(/\s+/g, ' ').trim()
  return raw.length > 60 ? `${raw.slice(0, 57)}…` : raw
}

/** One snapshot field per thing we watch for a transition. */
export interface AgentSnapshot {
  status: string
  shipState?: string
}

const snapshotOf = (s: AgentSession): AgentSnapshot => ({ status: s.status, shipState: s.shipState })

const lineFor = (kind: FleetEventKind, s: AgentSession): string => {
  const name = agentName(s)
  switch (kind) {
    case 'shipped':
      return `${name} shipped${s.shipInfo ? ` — ${s.shipInfo}` : ''}.`
    case 'ready':
      return `${name} says it is ready to ship.`
    case 'error':
      return `${name} ended with an error.`
    case 'done':
      return `${name} finished.`
    default:
      return s.menu ? `${name} is waiting on you.` : `${name} ended a turn.`
  }
}

/**
 * Diff two fleet polls into the events worth speaking.
 *
 * 🔴 A SESSION FIRST SEEN IS NEVER AN EVENT. Opening the dashboard must not
 * narrate the fleet's whole history — the first poll only seeds the snapshot,
 * and everything after it is a transition. (Same reason a reload is silent.)
 *
 * At most ONE event per agent per poll, most-significant first: an agent that
 * goes idle AND flags itself ready in the same tick shipped one piece of news,
 * not two, and speaking both would just talk over itself.
 */
export function deriveEvents(
  prev: Record<string, AgentSnapshot>,
  sessions: AgentSession[],
  at: string,
): { events: FleetEvent[]; snapshot: Record<string, AgentSnapshot> } {
  const events: FleetEvent[] = []
  const snapshot: Record<string, AgentSnapshot> = {}
  for (const s of sessions) {
    snapshot[s.id] = snapshotOf(s)
    const was = prev[s.id]
    if (!was) continue // first sighting — seed only
    const shipped = (v?: string) => v === 'shipped' || v === 'merged'
    let kind: FleetEventKind | null = null
    if (shipped(s.shipState) && !shipped(was.shipState)) kind = 'shipped'
    else if (s.shipState === 'ready' && was.shipState !== 'ready') kind = 'ready'
    else if (s.status === 'error' && was.status !== 'error') kind = 'error'
    else if (s.status === 'done' && was.status !== 'done') kind = 'done'
    else if (s.status === 'idle' && was.status === 'running') kind = 'turn-end'
    if (!kind) continue
    events.push({
      key: `${s.id}:${kind}:${at}`,
      id: s.id,
      agent: agentName(s),
      kind,
      at,
      line: lineFor(kind, s),
      tail: s.lastOutput || '',
    })
  }
  return { events, snapshot }
}

/* --- read new agent replies aloud (the dashboard header toggle) ---------- *
 * The pure half of the "read answers aloud" feature: which reply to speak, and
 * the discipline that keeps it from narrating the backlog. The DOM/audio half
 * is lib/speak.ts; the wiring is AgentList's AgentRow. Everything here is unit
 * tested (voice.test.mjs) — the seed-then-speak decision is what stops a page
 * load or a toggle flip from reciting the whole conversation.
 * ----------------------------------------------------------------------- */

/** Hard client cap on what is sent to be spoken — mirrors the voice addon's own
 *  default (`ATLAS_VOICE_MAX_SPOKEN_CHARS`, 700): the on-box route slices to it
 *  server-side anyway, and this keeps the browser fallback (which has no server
 *  cap) from reading out a wall of text. Long replies are truncated, not
 *  dropped. */
export const SPOKEN_CAP = 700

/** Markdown/code → plain prose for a TTS engine: no fences, no link or image
 *  syntax, no heading/list/emphasis punctuation. Same intent as the voice
 *  addon's own "no markdown, no code, no bullets" spoken-text rule. */
export function cleanForSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' — code block — ')
    .replace(/~~~[\s\S]*?~~~/g, ' — code block — ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*([-*_])(?:\s*\1){2,}\s*$/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)([^*_\n]+)\1/g, '$2')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n{2,} */g, '. ')
    .replace(/ *\n */g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim()
}

/** Signature that changes when the newest reply does — its timestamp plus its
 *  final length: enough to tell "same turn, still streaming" from "a new turn". */
export function replySig(m: AgentHistoryMessage): string {
  return `${m.ts ?? ''}#${m.text.length}`
}

/** The newest assistant turn that actually said something — tool-only turns and
 *  the empty in-progress turn do not count. */
export function newestReply(
  history: { messages: AgentHistoryMessage[] } | null | undefined,
): AgentHistoryMessage | null {
  const msgs = history?.messages
  if (!msgs) return null
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant' && msgs[i].text.trim()) return msgs[i]
  }
  return null
}

export interface SpeakState {
  /** false until the first history poll after the toggle was armed. */
  armed: boolean
  /** signature of the newest reply already accounted for. */
  lastSig: string | null
}

export const IDLE_SPEAK_STATE: SpeakState = { armed: false, lastSig: null }

/**
 * Decide whether an incoming history poll should be read aloud.
 *
 * 🔴 THE BACKLOG IS NEVER NARRATED. The first poll after the toggle is armed
 * (`on` true, history loaded) only SEEDS the marker; nothing is spoken then.
 * Only a later reply — a different signature, on a finished turn (`idle`) — is
 * spoken, and each one only once. Turning the toggle off, or closing the
 * transcript, disarms; re-arming re-seeds against whatever is on screen at that
 * moment. This mirrors deriveEvents' "a session first seen is never an event".
 */
export function nextSpeech(
  prev: SpeakState,
  input: { on: boolean; loaded: boolean; idle: boolean; reply: AgentHistoryMessage | null },
): { state: SpeakState; speak: string | null } {
  if (!input.on || !input.loaded) return { state: IDLE_SPEAK_STATE, speak: null }
  const sig = input.reply ? replySig(input.reply) : null
  if (!prev.armed) return { state: { armed: true, lastSig: sig }, speak: null }
  if (!input.idle || sig == null || sig === prev.lastSig) return { state: prev, speak: null }
  return { state: { armed: true, lastSig: sig }, speak: input.reply!.text }
}

/* --- dictation ------------------------------------------------------------ */

/** Dictation lands AFTER whatever the field already held, joined by one space —
 *  the mic adds to your draft, it never replaces it. */
export const joinDictation = (base: string, spoken: string): string => {
  const b = base.trim()
  const s = spoken.replace(/\s+/g, ' ').trim()
  return b ? (s ? `${b} ${s}` : b) : s
}

/** Which dictation engine this browser+box combination can actually use.
 *  `'none'` carries the reason, because "the mic is missing" and "the mic is
 *  broken" are different facts and the button's tooltip has to say which. */
export function pickDictation(hasWebSpeech: boolean, onBoxAvailable: boolean): { engine: 'browser' | 'on-box' | 'none'; reason: string } {
  if (hasWebSpeech) return { engine: 'browser', reason: '' }
  if (onBoxAvailable) return { engine: 'on-box', reason: '' }
  return {
    engine: 'none',
    reason: 'no dictation engine: this browser has no Web Speech API and this box has no ATLAS_VOICE_STT_CMD',
  }
}

/* --- the browser's own voice (the default, and the fallback) -------------- */

/** Does this browser speak? (Firefox and Chrome do; a stripped webview may not,
 *  and then the card shows the line instead of reading it.) */
export const speechSupported = (): boolean =>
  typeof window !== 'undefined' && !!window.speechSynthesis && typeof window.SpeechSynthesisUtterance === 'function'

/** Speak `text` with the browser's built-in voice, cancelling whatever is
 *  already speaking — a queue of stale recaps is worse than the newest one. */
export function speak(text: string, { onEnd }: { onEnd?: () => void } = {}): boolean {
  if (!speechSupported() || !text.trim()) return false
  const u = new SpeechSynthesisUtterance(text)
  if (onEnd) {
    u.onend = () => onEnd()
    u.onerror = () => onEnd()
  }
  window.speechSynthesis.cancel()
  window.speechSynthesis.speak(u)
  return true
}

export function stopSpeaking() {
  if (speechSupported()) window.speechSynthesis.cancel()
}

/* --- the addon's routes (all bearer-gated; see the addon README) ---------- */

export interface RecapResult {
  ok: boolean
  text?: string
  /** A guard held the call back (unchanged-tail · min-interval · daily-budget). */
  skipped?: string
  error?: string
  /** 401 here means the reverse proxy has no /api/voice/* handler yet. */
  httpStatus: number
}

export async function requestRecap(body: { agentId: string; agent: string; event: FleetEventKind | 'manual'; tail: string }): Promise<RecapResult> {
  try {
    const res = await fetch(`${API_BASE}/voice/recap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => ({}))) as Omit<RecapResult, 'httpStatus'>
    return { ...json, ok: !!json.ok, httpStatus: res.status }
  } catch (e) {
    return { ok: false, error: String(e), httpStatus: 0 }
  }
}

/** On-box TTS → an audio blob, or null when the box has no engine (or no
 *  handler in front of the route). The caller then falls back to the browser. */
export async function synthesize(text: string): Promise<Blob | null> {
  try {
    const res = await fetch(`${API_BASE}/voice/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!res.ok) return null
    const blob = await res.blob()
    return blob.size ? blob : null
  } catch {
    return null
  }
}

/** On-box STT for browsers with no Web Speech API: the recorded clip, posted raw. */
export async function transcribeClip(blob: Blob): Promise<{ ok: boolean; text?: string; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/voice/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
    })
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; text?: string; error?: string }
    if (!res.ok) return { ok: false, error: json.error || (res.status === 401 ? 'the dashboard cannot reach /api/voice/* (no proxy handler)' : `transcribe failed (${res.status})`) }
    return { ok: !!json.ok, text: json.text, error: json.error }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

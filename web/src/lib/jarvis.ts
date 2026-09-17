/* ------------------------------------------------------------------ *
 * The Jarvis tab's decisions — the PURE half (jarvis.test.mjs).
 *
 * Everything the tab shows or says is derived from data the kit already has
 * (host stats, tasks, the agent fleet, news, the weather addon); this module is
 * where those readings become words and numbers, so it is where an off-by-one
 * would turn into a lie on screen or out loud. No DOM, no fetch.
 *
 * The Jarvis "brain" is an ordinary Atlas knowledge chat. What makes a chat a
 * Jarvis chat is a marker at the start of its task — nothing server-side knows
 * about Jarvis, which is what keeps this a web-only feature.
 * ------------------------------------------------------------------ */
import type { AgentSession, AtlasTask, HostStats, NewsItem, CalEvent } from './api'

/* --- the Jarvis chat ------------------------------------------------------ */

export const JARVIS_MARK = '[JARVIS]'

/* Appended to the opening question of every Jarvis chat. Replies are READ
 * ALOUD, so the constraint that matters is length and form, not persona. */
const PERSONA =
  'You are answering through the dashboard\'s JARVIS interface: every reply is read aloud by a calm British voice. ' +
  'Keep replies short and spoken-style — two to four sentences, no tables, no code blocks, no bullet lists unless asked. ' +
  'Answer in the language the question was asked in. Do the actual work with your normal tools, then say what you did.'

/** The spawn task for a new Jarvis chat. */
export function jarvisTask(question: string): string {
  return `${JARVIS_MARK} ${question.trim()}\n\n${PERSONA}`
}

/** The question a Jarvis task was opened with (marker and persona stripped).
 *  The chat's first transcript turn wraps the task in the knowledge-chat
 *  preamble, so the marker is searched for anywhere, not only at the start. */
export function jarvisQuestion(text: string): string {
  const i = text.indexOf(JARVIS_MARK)
  return i < 0 ? text : text.slice(i + JARVIS_MARK.length).split('\n\n')[0].trim()
}

/** Commands the tab answers itself, without spending an agent turn. */
export function localIntent(cmd: string): 'brief' | 'stop' | null {
  const c = cmd.toLowerCase().replace(/[.!?,]/g, ' ').replace(/\s+/g, ' ').trim()
  if (/^(brief me|briefing|morning brief|status report|give me (a|the) (brief|briefing|status report))$/.test(c)) return 'brief'
  if (/^(stop|quiet|silence|be quiet|stop talking|shut up)$/.test(c)) return 'stop'
  return null
}

export const isJarvisSession = (s: Pick<AgentSession, 'kind' | 'task'>): boolean =>
  s.kind === 'knowledge' && (s.task || '').startsWith(JARVIS_MARK)

/** The live Jarvis chat, if any — sessions arrive newest-first, so the first
 *  running/idle one is the conversation to continue. */
export function activeJarvis<T extends Pick<AgentSession, 'kind' | 'task' | 'status' | 'closing'>>(sessions: T[]): T | null {
  return sessions.find((s) => isJarvisSession(s) && (s.status === 'running' || s.status === 'idle') && !s.closing) ?? null
}

/** How a typed/spoken command reaches the chat, given its state. */
export function deliveryFor(s: Pick<AgentSession, 'status' | 'menu'> | null): 'spawn' | 'prompt' | 'queue' | 'blocked' {
  if (!s) return 'spawn'
  if (s.status === 'running') return 'queue'
  if (s.menu) return 'blocked'
  return 'prompt'
}

/* --- wake word ------------------------------------------------------------ */

const WAKE = /\b(?:(?:hey|hi|ok|okay|hallo|hej)[\s,]+)?jarvis\b[\s,.!?:;—–-]*/i

/**
 * What a recognised utterance asks Jarvis to do.
 *  - null  → the wake word was not said: ignore the utterance.
 *  - ''    → only the wake word: listen for the command in the next utterance.
 *  - text  → the command that followed the wake word.
 */
export function wakeCommand(transcript: string): string | null {
  const m = WAKE.exec(transcript)
  if (!m) return null
  return transcript.slice(m.index + m[0].length).replace(/\s+/g, ' ').trim()
}

/* --- clock ---------------------------------------------------------------- */

export function greeting(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Good morning'
  if (hour >= 12 && hour < 18) return 'Good afternoon'
  if (hour >= 18 && hour < 23) return 'Good evening'
  return 'Working late'
}

export function fmtUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  return `${m}m`
}

/* --- vitals --------------------------------------------------------------- */

export interface NetSample {
  at: number
  rxBytes: number
  txBytes: number
}

/** Bytes/second between two counter samples; null when there is no honest rate
 *  (first sample, clock went backwards, or the counters reset — an interface
 *  bounce or a reboot must not render as a negative or astronomical speed). */
export function netRate(prev: NetSample | null, cur: NetSample | null): { rxBps: number; txBps: number } | null {
  if (!prev || !cur) return null
  const dt = (cur.at - prev.at) / 1000
  if (dt <= 0) return null
  const rx = cur.rxBytes - prev.rxBytes
  const tx = cur.txBytes - prev.txBytes
  if (rx < 0 || tx < 0) return null
  return { rxBps: rx / dt, txBps: tx / dt }
}

export function fmtRate(bps: number): string {
  if (bps >= 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(1)} MB/s`
  if (bps >= 1024) return `${(bps / 1024).toFixed(0)} kB/s`
  return `${Math.round(bps)} B/s`
}

/** 1-minute load as a percent of the box's cores, capped at 100 for the gauge. */
export function cpuPct(h: Pick<HostStats, 'load1' | 'cpus'> | null): number | null {
  if (!h || h.load1 == null || !h.cpus) return null
  return Math.min(100, (h.load1 / h.cpus) * 100)
}

/* --- agenda --------------------------------------------------------------- */

const PRIO: Record<string, number> = { high: 0, medium: 1, low: 2 }
const byPrio = (a: AtlasTask, b: AtlasTask) =>
  (PRIO[a.priority ?? ''] ?? 3) - (PRIO[b.priority ?? ''] ?? 3) || (a.due ?? '9999').localeCompare(b.due ?? '9999')

export interface Agenda {
  doing: AtlasTask[]
  next: AtlasTask[]
  overdue: AtlasTask[]
  dueToday: AtlasTask[]
}

/** `today` is the operator's local calendar date, YYYY-MM-DD. */
export function agendaOf(tasks: AtlasTask[], today: string): Agenda {
  const open = tasks.filter((t) => t.status !== 'done')
  return {
    doing: open.filter((t) => t.status === 'doing').sort(byPrio),
    next: open.filter((t) => t.status === 'next').sort(byPrio),
    overdue: open.filter((t) => !!t.due && t.due < today).sort(byPrio),
    dueToday: open.filter((t) => t.due === today).sort(byPrio),
  }
}

export const localDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Calendar events that touch `today` (all-day or timed), in start order. */
export function eventsToday(events: CalEvent[], today: string): CalEvent[] {
  return events.filter((e) => (e.start || '').slice(0, 10) <= today && (e.end || e.start || '').slice(0, 10) >= today).sort((a, b) => a.start.localeCompare(b.start))
}

/* --- the spoken brief ----------------------------------------------------- */

export interface BriefWeather {
  ok: boolean
  tempC?: number
  summary?: string
  highC?: number | null
  lowC?: number | null
  label?: string
}

export interface BriefInput {
  now: Date
  name?: string
  weather?: BriefWeather | null
  agenda?: Agenda | null
  events?: CalEvent[] | null
  host?: HostStats | null
  agents?: Pick<AgentSession, 'status' | 'kind'>[] | null
  news?: Pick<NewsItem, 'title'>[] | null
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

/**
 * The "brief me" text: every sentence is built from a reading the tab already
 * has, and a section whose data is missing is SKIPPED rather than guessed —
 * "no weather source" is said on screen, not invented out loud. Deterministic
 * and free: no model call, the voice engine reads it verbatim.
 */
export function composeBrief(b: BriefInput): string {
  const out: string[] = []
  const who = b.name && b.name !== 'Operator' ? `, ${b.name}` : ''
  out.push(`${greeting(b.now.getHours())}${who}. It is ${hhmm(b.now)}.`)

  const w = b.weather
  if (w?.ok && typeof w.tempC === 'number') {
    const range = w.highC != null && w.lowC != null ? `, between ${Math.round(w.lowC)} and ${Math.round(w.highC)} today` : ''
    out.push(`${w.label ? `In ${w.label} it is` : 'Outside it is'} ${Math.round(w.tempC)} degrees, ${(w.summary || '').toLowerCase()}${range}.`)
  }

  const ev = b.events ?? []
  if (ev.length) {
    const first = ev[0]
    out.push(`You have ${plural(ev.length, 'event')} today, starting with ${first.title}${first.allDay ? '' : ` at ${hhmm(new Date(first.start))}`}.`)
  }

  const a = b.agenda
  if (a) {
    const parts: string[] = []
    if (a.doing.length) parts.push(`${plural(a.doing.length, 'task')} in progress`)
    if (a.dueToday.length) parts.push(`${a.dueToday.length} due today`)
    if (a.overdue.length) parts.push(`${a.overdue.length} overdue`)
    if (parts.length) out.push(`On your list: ${parts.join(', ')}.`)
    else out.push('Nothing is in progress or due on your list.')
    const top = a.overdue[0] ?? a.dueToday[0] ?? a.doing[0]
    if (top) out.push(`Top of the pile: ${top.title}.`)
  }

  const ag = (b.agents ?? []).filter((s) => s.kind !== 'atlas-pass')
  if (b.agents) {
    const running = ag.filter((s) => s.status === 'running').length
    const waiting = ag.filter((s) => s.status === 'idle').length
    out.push(running || waiting ? `Agents: ${running} working, ${waiting} waiting on you.` : 'No agents are running.')
  }

  const h = b.host
  if (h?.ok) {
    const cpu = cpuPct(h)
    out.push(`The box is at ${Math.round(h.mem.pct)} percent memory${cpu != null ? ` and ${Math.round(cpu)} percent CPU load` : ''}.`)
  }

  const n = b.news ?? []
  if (n.length) out.push(`Latest headline: ${n[0].title}.`)

  return out.join(' ')
}

import { useEffect, useRef, useState } from 'preact/hooks'
import { NoteReader } from './NoteReader'
import { SearchBar } from './SearchBar'
import { Reactor, type ReactorMode } from './jarvis/Reactor'
import { MicIcon, StopIcon } from './icons'
import { Markdown } from '../lib/markdown'
import { useNoteReader } from '../lib/useNoteReader'
import { useData } from '../lib/useData'
import { useAddons } from '../lib/addons'
import { useAgents } from '../lib/useAgents'
import { useHost, gb } from '../lib/useHost'
import { useUsage, fmtReset } from '../lib/useUsage'
import { useDraft } from '../lib/useDraft'
import { useDictation } from '../lib/useDictation'
import { useWakeWord } from '../lib/useWakeWord'
import { useMicLevel, readLevel } from '../lib/audioLevel'
import { useReadAloud } from '../lib/readAloud'
import { focusAgent } from '../lib/agentFocus'
import { currentSpeechAnalyser, primeAudio, sayAloud, speechAnalyser, stopAll, useSpeaking } from '../lib/speak'
import { IDLE_SPEAK_STATE, SPOKEN_CAP, cleanForSpeech, newestReply, nextSpeech, voiceStatus } from '../lib/voice'
import {
  activeJarvis,
  agendaOf,
  composeBrief,
  cpuPct,
  deliveryFor,
  eventsToday,
  fmtRate,
  fmtUptime,
  greeting,
  isJarvisSession,
  JARVIS_MARK,
  jarvisQuestion,
  jarvisTask,
  localDate,
  localIntent,
  netRate,
  type NetSample,
} from '../lib/jarvis'
import {
  fetchAgentHistory,
  fetchDashboard,
  fetchNews,
  fetchTasks,
  fetchWeather,
  fetchWikiPages,
  promptAgent,
  queueAgent,
  spawnAgent,
  type AgentHistoryMessage,
  type AgentSession,
  type AtlasTask,
  type CalEvent,
  type GmailItem,
  type HostStats,
  type NewsItem,
  type WeatherView,
} from '../lib/api'

/* ------------------------------------------------------------------ *
 * The Jarvis tab — a voice-first HUD over what Atlas Kit already runs.
 *
 * Built from docs/jarvis-features.md (what "Jarvis AI" builds on Instagram
 * actually show). Nothing here is a second system: the brain is an Atlas
 * knowledge chat (spawn/prompt/queue + the transcript), the ears are
 * useDictation and the browser's SpeechRecognition, the voice is lib/speak.ts
 * (on-box piper via POST /api/voice/speak, browser fallback), and every panel
 * reads an existing endpoint — /api/host, /api/usage, /api/tasks, /api/agents,
 * /api/dashboard, /api/news, and the optional weather addon.
 *
 * 🔴 NO FAKE READINGS. A panel whose source is missing says which source and
 * how to connect it; it never renders a plausible number. Addon-backed parts
 * (voice, news, weather) are gated at RUNTIME on GET /api/addons, like every
 * other addon surface (docs/ADDONS.md).
 * ------------------------------------------------------------------ */

const VAULT = 'atlas'
const OPERATOR = import.meta.env.VITE_OPERATOR_NAME || 'Operator'

export function JarvisCenter() {
  const { data: pages } = useData(() => fetchWikiPages(VAULT))
  const { path, missing, canGoBack, openPath, navigate, back, close } = useNoteReader(pages)

  const addons = useAddons()
  const has = (n: string) => addons.ready && addons.enabled(n)
  const weatherOn = has('weather')
  const newsOn = has('news-ingest')

  // Addon-gated loaders: the first tick can land before /api/addons answers, so
  // each refetches the moment its gate opens rather than waiting a whole cycle.
  const weather = useData(() => (weatherOn ? fetchWeather() : Promise.resolve(null)), 10 * 60 * 1000)
  const news = useData(() => (newsOn ? fetchNews(10) : Promise.resolve(null)), 5 * 60 * 1000)
  useEffect(() => void (weatherOn && weather.refetch?.()), [weatherOn])
  useEffect(() => void (newsOn && news.refetch?.()), [newsOn])
  const { data: tasks } = useData(() => fetchTasks(VAULT), 60 * 1000)
  const { data: dash } = useData(fetchDashboard, 5 * 60 * 1000)
  const { host } = useHost()
  const { view } = useAgents()

  const now = useClock()
  const today = localDate(now)
  const agenda = tasks ? agendaOf(tasks, today) : null
  const events = dash?.calendar ? eventsToday(dash.calendar.events, today) : null
  const sessions = view?.sessions ?? []

  const brief = () =>
    composeBrief({
      now: new Date(),
      name: OPERATOR,
      weather: weatherOn ? weather.data : null,
      agenda,
      events,
      host,
      agents: view ? sessions.filter((s) => !isJarvisSession(s)) : null,
      news: newsOn ? news.data?.items : null,
    })

  return (
    <>
      <div className="jv">
        <Boot pages={pages?.length ?? null} voice={has('voice')} host={host} agents={view ? sessions.length : null} />
        <div className="jv-grid">
          {/* Side columns are display:contents below the widest breakpoint, so
              on a phone the panels reorder freely around the console. */}
          <div className="jv-col jv-col--left">
            <section className="jv-panel jv-area-clock" aria-label="clock and weather">
              <ClockPanel now={now} weatherOn={weatherOn} weather={weather.data} />
            </section>
            <section className="jv-panel jv-area-vitals" aria-label="system vitals">
              <Vitals host={host} />
            </section>
            <section className="jv-panel jv-area-recall" aria-label="memory">
              <h2 className="jv-h">Memory · Atlas</h2>
              <SearchBar onOpenWiki={openPath} vault={VAULT} placeholder="Recall from the vault…" />
            </section>
          </div>

          <section className="jv-core" aria-label="Jarvis">
            <Console brief={brief} />
          </section>

          <div className="jv-col jv-col--right">
            <section className="jv-panel jv-area-agenda" aria-label="agenda">
              <AgendaPanel
                tasks={tasks}
                agenda={agenda}
                events={events}
                mail={dash?.gmailHighlights?.items ?? null}
                onOpen={openPath}
              />
            </section>
            <section className="jv-panel jv-area-fleet" aria-label="agents">
              <Fleet sessions={view ? sessions : null} />
            </section>
          </div>
        </div>
        <Ticker on={newsOn} items={news.data?.items ?? null} onOpen={openPath} />
      </div>

      <NoteReader
        path={path}
        missing={missing}
        vault={VAULT}
        canGoBack={canGoBack}
        onBack={back}
        onClose={close}
        onWikiLink={navigate}
      />
    </>
  )
}

function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}

const two = (n: number) => String(n).padStart(2, '0')

/* --- boot sequence -------------------------------------------------------- */

// Once per page load: a tab switch back to Jarvis does not replay it.
let booted = false

function Boot({ pages, voice, host, agents }: { pages: number | null; voice: boolean; host: HostStats | null; agents: number | null }) {
  const [show, setShow] = useState(() => !booted && !window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    booted = true
    if (!show) return
    const id = setTimeout(() => setShow(false), 2600)
    return () => clearTimeout(id)
  }, [])
  if (!show) return null
  // Every line is a live reading; "…" until its source has answered.
  const lines = [
    'J.A.R.V.I.S. · Atlas Kit interface',
    `Atlas vault ··· ${pages == null ? '…' : `${pages} pages linked`}`,
    `Voice ········· ${voice ? 'online' : 'addon off'}`,
    `Agents ········ ${agents == null ? '…' : `${agents} session(s)`}`,
    `Host ·········· ${host ? `RAM ${Math.round(host.mem.pct)}%` : '…'}`,
    pages != null && host && agents != null ? 'All systems online.' : 'Linking…',
  ]
  return (
    <button type="button" className="jv-boot" onClick={() => setShow(false)} aria-label="skip boot sequence">
      <span className="jv-boot__lines">
        {lines.map((l, i) => (
          <span key={i} className="jv-boot__line" style={{ animationDelay: `${i * 260}ms` }}>
            {l}
          </span>
        ))}
      </span>
    </button>
  )
}

/* --- the console: reactor, voice in/out, chat ----------------------------- */

function Console({ brief }: { brief: () => string }) {
  const { view, kick } = useAgents()
  const sessions = view?.sessions ?? []
  const addons = useAddons()
  const voiceOn = addons.ready && addons.enabled('voice')
  const vs = voiceStatus(addons.get('voice'))
  const onBoxTts = !!vs?.tts.available
  const executor = !!view && view.localRepos.length > 0

  // Which conversation: the one this console spawned (by id), else the newest
  // live Jarvis chat — unless "new conversation" was pressed.
  const [pinned, setPinned] = useState<string | null>(null)
  const [fresh, setFresh] = useState(false)
  const live: AgentSession | null =
    (pinned && sessions.find((s) => s.id === pinned && (s.status === 'running' || s.status === 'idle'))) ||
    (fresh ? null : activeJarvis(sessions))

  const [text, setText] = useDraft('jarvis-command')
  const dict = useDictation(text, setText, !!vs?.stt.available)
  const dictated = useRef(false)
  useEffect(() => {
    if (dict.recording) dictated.current = true
  }, [dict.recording])

  const speaking = useSpeaking()
  const readAloud = useReadAloud()
  const [wakeOn, setWakeOn] = useState(false)
  const [voiceTurn, setVoiceTurn] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [said, setSaid] = useState('') // the last brief, shown as it is spoken

  // Splice the playback analyser in and bless audio — only ever from a gesture.
  const engage = () => {
    primeAudio()
    if (voiceOn) speechAnalyser()
  }

  const say = (t: string) => {
    setSaid(t)
    void sayAloud(t, { onBox: onBoxTts })
  }

  const send = async (raw: string, spoken: boolean) => {
    const t = raw.trim()
    if (!t || busy) return
    const intent = localIntent(t)
    if (intent === 'stop') {
      stopAll()
      setText('')
      return
    }
    if (intent === 'brief') {
      setText('')
      return say(brief())
    }
    const mode = deliveryFor(live)
    if (mode === 'blocked') {
      setErr('Jarvis is waiting on a choice — open the full transcript to answer it.')
      return
    }
    if (mode === 'spawn' && !executor) {
      setErr('Jarvis needs the box-local executor (agent-local-repos.json).')
      return
    }
    setBusy(true)
    setErr('')
    const r =
      mode === 'spawn'
        ? await spawnAgent({ task: jarvisTask(t), kind: 'knowledge', vault: VAULT, model: 'sonnet', effort: 'high' })
        : mode === 'queue'
          ? await queueAgent({ id: live!.id, text: t })
          : await promptAgent({ id: live!.id, text: t })
    setBusy(false)
    if (!r.ok) return setErr(r.error === 'menu' ? 'Jarvis is waiting on a choice — open the full transcript.' : r.error || `${mode} failed`)
    if (mode === 'spawn' && r.id) {
      setPinned(r.id)
      setFresh(false)
    }
    setText('')
    dictated.current = false
    if (spoken) setVoiceTurn(true)
    kick()
  }

  const wake = useWakeWord(voiceOn && wakeOn && !dict.recording, speaking, (cmd) => void send(cmd, true))

  /* The transcript of the live chat. */
  const [hist, setHist] = useState<AgentHistoryMessage[]>([])
  const [loaded, setLoaded] = useState(false)
  const rev = useRef<string | undefined>()
  // Reset only when the CONVERSATION changes. A running→idle flip must keep
  // what is loaded: re-seeding the speech marker on a fresh load at that moment
  // would swallow exactly the reply that just finished.
  useEffect(() => {
    setHist([])
    setLoaded(false)
    rev.current = undefined
  }, [live?.id])
  useEffect(() => {
    if (!live) return
    let alive = true
    const tick = async () => {
      if (document.hidden) return
      const h = await fetchAgentHistory(live.id, rev.current)
      if (!alive || !h || 'unchanged' in h) return
      rev.current = h.rev
      setHist(h.messages)
      setLoaded(true)
    }
    tick()
    const id = setInterval(tick, live.status === 'running' ? 3000 : 8000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [live?.id, live?.status])

  /* Voice out: each NEW finished reply is spoken once when the header's
   * "Read aloud" is on, or when the question was asked by voice. Same
   * seed-then-speak discipline as AgentRow (voice.ts nextSpeech). */
  const speakState = useRef(IDLE_SPEAK_STATE)
  useEffect(() => {
    const { state, speak } = nextSpeech(speakState.current, {
      on: voiceOn && (readAloud || voiceTurn),
      loaded,
      idle: live?.status === 'idle',
      reply: newestReply({ messages: hist }),
    })
    speakState.current = state
    if (speak) {
      void sayAloud(cleanForSpeech(speak).slice(0, SPOKEN_CAP), { onBox: onBoxTts })
      setVoiceTurn(false)
    }
  }, [hist, loaded, live?.status, readAloud, voiceTurn, voiceOn])

  /* Reactor level: the mic while listening, playback while speaking. */
  // Keyed on the wake SWITCH, not wake.listening: the recogniser restarts on its
  // own every so often, and the level stream should not reopen with it.
  const micLevel = useMicLevel(voiceOn && (dict.recording || wakeOn))
  const speechBuf = useRef<Uint8Array<ArrayBuffer> | null>(null)
  const level = () => {
    if (speaking) {
      const node = currentSpeechAnalyser()
      if (node && (!speechBuf.current || speechBuf.current.length !== node.fftSize)) speechBuf.current = new Uint8Array(node.fftSize)
      return readLevel(node, speechBuf.current)
    }
    return micLevel()
  }
  const mode: ReactorMode = speaking
    ? 'speaking'
    : dict.recording || wake.armed
      ? 'listening'
      : busy || live?.status === 'running'
        ? 'thinking'
        : wakeOn && wake.listening
          ? 'listening'
          : 'idle'

  const statusLine =
    mode === 'speaking'
      ? `Speaking · ${onBoxTts ? 'on-box voice' : 'browser voice'}`
      : dict.recording
        ? 'Listening…'
        : wake.armed
          ? 'Yes? I am listening.'
          : mode === 'thinking'
            ? 'Working on it…'
            : wakeOn && wake.listening
              ? 'Say “Jarvis, …”'
              : live
                ? 'Standing by'
                : 'Ready'

  const talk = () => {
    engage()
    if (speaking) return stopAll()
    if (!voiceOn) return setErr('Voice needs the voice addon (addons/voice).')
    dict.toggle()
  }

  const messages = hist.filter((m) => m.text.trim()).slice(-10)
  const logRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, said])

  return (
    <div className="jv-console">
      <Reactor mode={mode} level={level} onClick={talk} label={speaking ? 'stop speaking' : dict.recording ? 'stop listening' : 'talk to Jarvis'} />
      <div className="jv-status" aria-live="polite">
        <span className={`jv-status__dot jv-status__dot--${mode}`} />
        {statusLine}
      </div>

      <form
        className="jv-command"
        onSubmit={(e) => {
          e.preventDefault()
          engage()
          void send(text, dictated.current)
        }}
      >
        <button
          type="button"
          className={`jv-talk${dict.recording ? ' jv-talk--rec' : ''}`}
          onClick={talk}
          disabled={!voiceOn || dict.busy || dict.engine === 'none'}
          title={!voiceOn ? 'voice addon not enabled' : dict.unavailable || dict.error || (dict.recording ? 'stop' : 'push to talk')}
          aria-label={dict.recording ? 'stop dictation' : 'push to talk'}
        >
          {dict.busy ? <span className="agent__spin" aria-label="transcribing" /> : dict.recording ? <StopIcon /> : <MicIcon />}
        </button>
        <input
          className="jv-command__input"
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
          placeholder={live ? 'Tell Jarvis…' : 'Ask Jarvis anything — starts an Atlas chat'}
          aria-label="command"
        />
        <button type="submit" className="jv-btn jv-btn--primary" disabled={!text.trim() || busy}>
          {busy ? '…' : 'Send'}
        </button>
      </form>

      <div className="jv-controls">
        <button
          type="button"
          className="jv-btn"
          onClick={() => {
            engage()
            say(brief())
          }}
        >
          Brief me
        </button>
        {voiceOn && wake.supported ? (
          <button
            type="button"
            role="switch"
            aria-checked={wakeOn}
            className={`jv-btn${wakeOn ? ' jv-btn--on' : ''}`}
            onClick={() => {
              engage()
              setWakeOn(!wakeOn)
            }}
            title="Listen for “Jarvis, …”. The mic stays open while this is on — in Chrome that audio goes to Google’s speech service."
          >
            Wake word {wakeOn ? 'on' : 'off'}
          </button>
        ) : null}
        {speaking ? (
          <button type="button" className="jv-btn" onClick={stopAll}>
            Stop
          </button>
        ) : null}
        {live ? (
          <>
            <button type="button" className="jv-btn" onClick={() => focusAgent(live.id, 'command')} title="open this chat's full transcript on Home">
              Transcript
            </button>
            <button
              type="button"
              className="jv-btn"
              onClick={() => {
                setPinned(null)
                setFresh(true)
              }}
              title="the next command starts a new Jarvis chat"
            >
              New chat
            </button>
          </>
        ) : null}
      </div>
      {wakeOn && wake.heard ? <div className="jv-heard">heard: “{wake.heard}”</div> : null}
      {err || wake.error || dict.error ? <div className="jv-err">✗ {err || wake.error || dict.error}</div> : null}
      {!voiceOn && addons.ready ? (
        <div className="jv-note">Voice in/out is off on this box — enable the voice addon (addons/voice).</div>
      ) : null}

      <div className="jv-log" ref={logRef} aria-label="conversation">
        {messages.length === 0 && !said ? (
          <div className="jv-log__empty">{live ? 'Waiting for the first reply…' : 'No conversation yet. Speak, type, or ask for a brief.'}</div>
        ) : null}
        {messages.map((m, i) => (
          <div key={`${m.ts}-${i}`} className={`jv-msg jv-msg--${m.role}`}>
            <span className="jv-msg__who">{m.role === 'assistant' ? 'JARVIS' : m.source ? m.source.toUpperCase() : 'YOU'}</span>
            {m.role === 'assistant' ? (
              <Markdown source={m.text} />
            ) : (
              <span className="jv-msg__text">
                {m.text.includes(JARVIS_MARK) ? jarvisQuestion(m.text) : hist.indexOf(m) === 0 && live ? jarvisQuestion(live.task) : m.text}
              </span>
            )}
          </div>
        ))}
        {said ? (
          <div className="jv-msg jv-msg--assistant jv-msg--brief">
            <span className="jv-msg__who">BRIEF</span>
            <span className="jv-msg__text">{said}</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/* --- clock + weather ------------------------------------------------------ */

function ClockPanel({ now, weatherOn, weather }: { now: Date; weatherOn: boolean; weather: WeatherView | null }) {
  return (
    <>
      <div className="jv-greet">
        {greeting(now.getHours())}
        {OPERATOR !== 'Operator' ? `, ${OPERATOR}` : ''}.
      </div>
      <div className="jv-time tnum">
        {two(now.getHours())}:{two(now.getMinutes())}
        <span className="jv-time__s">{two(now.getSeconds())}</span>
      </div>
      <div className="jv-date">
        {now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
      </div>
      <div className="jv-weather">
        {!weatherOn ? (
          <span className="jv-note">Weather: enable addons/weather and set ATLAS_WEATHER_LAT / ATLAS_WEATHER_LON.</span>
        ) : !weather ? (
          <span className="jv-note">Weather: loading…</span>
        ) : !weather.ok ? (
          <span className="jv-note">Weather: {weather.error}</span>
        ) : (
          <>
            <span className="jv-weather__temp tnum">{Math.round(weather.tempC ?? 0)}°</span>
            <span className="jv-weather__meta">
              <span>
                {weather.summary}
                {weather.label ? ` · ${weather.label}` : ''}
              </span>
              <span className="tnum">
                {weather.lowC != null && weather.highC != null ? `${Math.round(weather.lowC)}° / ${Math.round(weather.highC)}°` : ''}
                {weather.windKmh != null ? ` · wind ${Math.round(weather.windKmh)} km/h` : ''}
                {weather.humidity != null ? ` · ${Math.round(weather.humidity)}% rh` : ''}
                {weather.stale ? ' · stale' : ''}
              </span>
            </span>
          </>
        )}
      </div>
    </>
  )
}

/* --- vitals --------------------------------------------------------------- */

function Gauge({ label, pct, value }: { label: string; pct: number | null; value: string }) {
  const level = pct == null ? '' : pct >= 90 ? ' jv-gauge--red' : pct >= 75 ? ' jv-gauge--amber' : ''
  return (
    <div className={`jv-gauge${level}`}>
      <div className="jv-gauge__row">
        <span className="jv-gauge__label">{label}</span>
        <span className="jv-gauge__value tnum">{value}</span>
      </div>
      <div className="jv-gauge__track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
        <span className="jv-gauge__fill" style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }} />
      </div>
    </div>
  )
}

function Vitals({ host }: { host: HostStats | null }) {
  const { usage } = useUsage()
  // Rates need two samples of the cumulative counters.
  const prev = useRef<NetSample | null>(null)
  const [rate, setRate] = useState<{ rxBps: number; txBps: number } | null>(null)
  useEffect(() => {
    if (!host?.net) return
    const cur = { at: Date.now(), ...host.net }
    const r = netRate(prev.current, cur)
    prev.current = cur
    if (r) setRate(r)
  }, [host])

  const cpu = cpuPct(host)
  return (
    <>
      <h2 className="jv-h">System vitals</h2>
      {!host ? (
        <div className="jv-note">Reading /api/host…</div>
      ) : (
        <>
          <Gauge label="CPU load" pct={cpu} value={cpu == null ? 'n/a' : `${Math.round(cpu)}% · ${host.load1?.toFixed(2)} / ${host.cpus}`} />
          <Gauge label="Memory" pct={host.mem.pct} value={`${gb(host.mem.usedMb)} / ${gb(host.mem.totalMb)} GB`} />
          {host.swap ? <Gauge label="Swap" pct={host.swap.pct} value={`${gb(host.swap.usedMb)} / ${gb(host.swap.totalMb)} GB`} /> : null}
          <div className="jv-kv">
            <span>Network</span>
            <span className="tnum">{host.net === null ? 'n/a' : rate ? `↓ ${fmtRate(rate.rxBps)} · ↑ ${fmtRate(rate.txBps)}` : 'measuring…'}</span>
          </div>
          {host.uptimeS != null ? (
            <div className="jv-kv">
              <span>Uptime</span>
              <span className="tnum">{fmtUptime(host.uptimeS)}</span>
            </div>
          ) : null}
        </>
      )}
      {usage?.fiveHour ? (
        <Gauge label="Claude · 5 h" pct={usage.fiveHour.utilization} value={`${Math.round(usage.fiveHour.utilization)}% · resets ${fmtReset(usage.fiveHour.resetsAt)}`} />
      ) : null}
      {usage?.sevenDay ? (
        <Gauge label="Claude · week" pct={usage.sevenDay.utilization} value={`${Math.round(usage.sevenDay.utilization)}% · resets ${fmtReset(usage.sevenDay.resetsAt)}`} />
      ) : null}
    </>
  )
}

/* --- agenda: calendar, tasks, mail ---------------------------------------- */

function TaskLine({ t, tag, onOpen }: { t: AtlasTask; tag: string; onOpen: (p: string) => void }) {
  return (
    <li>
      <button type="button" className="jv-item" onClick={() => onOpen(t.path)}>
        <span className={`jv-chip jv-chip--${tag}`}>{tag}</span>
        <span className="jv-item__title">{t.title}</span>
        {t.due ? <span className="jv-item__meta tnum">{t.due.slice(5)}</span> : null}
      </button>
    </li>
  )
}

function AgendaPanel({
  tasks,
  agenda,
  events,
  mail,
  onOpen,
}: {
  tasks: AtlasTask[] | null
  agenda: ReturnType<typeof agendaOf> | null
  events: CalEvent[] | null
  mail: GmailItem[] | null
  onOpen: (p: string) => void
}) {
  // One list, most urgent first, no task twice.
  const seen = new Set<string>()
  const rows: { t: AtlasTask; tag: string }[] = []
  for (const [list, tag] of [
    [agenda?.overdue ?? [], 'overdue'],
    [agenda?.dueToday ?? [], 'today'],
    [agenda?.doing ?? [], 'doing'],
    [agenda?.next ?? [], 'next'],
  ] as const) {
    for (const t of list) {
      if (seen.has(t.path)) continue
      seen.add(t.path)
      rows.push({ t, tag })
    }
  }
  return (
    <>
      <h2 className="jv-h">Today</h2>
      {events == null ? (
        <div className="jv-note">Calendar: no calendar source connected on this box.</div>
      ) : events.length === 0 ? (
        <div className="jv-note">Calendar: nothing today.</div>
      ) : (
        <ul className="jv-list">
          {events.slice(0, 5).map((e) => (
            <li key={e.id} className="jv-item jv-item--static">
              <span className="jv-chip">{e.allDay ? 'all day' : new Date(e.start).toTimeString().slice(0, 5)}</span>
              <span className="jv-item__title">{e.title}</span>
            </li>
          ))}
        </ul>
      )}

      <h3 className="jv-h jv-h--sub">Tasks</h3>
      {tasks == null ? (
        <div className="jv-note">Reading Tasks/…</div>
      ) : rows.length === 0 ? (
        <div className="jv-note">Nothing overdue, due or in progress.</div>
      ) : (
        <ul className="jv-list">
          {rows.slice(0, 7).map(({ t, tag }) => (
            <TaskLine key={t.path} t={t} tag={tag} onOpen={onOpen} />
          ))}
        </ul>
      )}

      <h3 className="jv-h jv-h--sub">Mail</h3>
      {mail == null ? (
        <div className="jv-note">No mail source connected on this box.</div>
      ) : mail.length === 0 ? (
        <div className="jv-note">No highlighted mail.</div>
      ) : (
        <ul className="jv-list">
          {mail.slice(0, 3).map((m) => (
            <li key={m.id} className="jv-item jv-item--static">
              <span className="jv-chip">{m.account}</span>
              <span className="jv-item__title">{m.subject}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/* --- fleet ---------------------------------------------------------------- */

function Fleet({ sessions }: { sessions: AgentSession[] | null }) {
  const list = (sessions ?? []).filter((s) => s.kind !== 'atlas-pass' && (s.status === 'running' || s.status === 'idle'))
  const running = list.filter((s) => s.status === 'running').length
  return (
    <>
      <h2 className="jv-h">
        Agents <span className="jv-h__count tnum">{sessions ? `${running} working · ${list.length - running} idle` : '…'}</span>
      </h2>
      {sessions && list.length === 0 ? <div className="jv-note">No agents online.</div> : null}
      <ul className="jv-list">
        {list.slice(0, 6).map((s) => (
          <li key={s.id}>
            <button type="button" className="jv-item" onClick={() => focusAgent(s.id, 'command')} title={s.task}>
              <span className={`jv-dot jv-dot--${s.status}`} />
              <span className="jv-item__title">{isJarvisSession(s) ? `Jarvis · ${jarvisQuestion(s.task)}` : s.micro || s.title || s.task}</span>
              <span className="jv-item__meta">{s.kind === 'knowledge' ? 'chat' : s.repo}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}

/* --- news ticker ---------------------------------------------------------- */

function Ticker({ on, items, onOpen }: { on: boolean; items: NewsItem[] | null; onOpen: (p: string) => void }) {
  if (!on) return <div className="jv-ticker jv-ticker--off">News ticker: enable addons/news-ingest.</div>
  if (!items?.length) return <div className="jv-ticker jv-ticker--off">News: nothing filed yet.</div>
  // Rendered twice so the marquee loops seamlessly; the copy is hidden from AT.
  const row = (hidden: boolean) => (
    <span className="jv-ticker__row" aria-hidden={hidden || undefined}>
      {items.map((it) => (
        <button key={it.key} type="button" className="jv-ticker__item" tabIndex={hidden ? -1 : 0} onClick={() => onOpen(it.page)}>
          <span className="jv-chip">{it.feed}</span> {it.title}
        </button>
      ))}
    </span>
  )
  return (
    <div className="jv-ticker" aria-label="news headlines">
      <div className="jv-ticker__track" style={{ animationDuration: `${Math.max(40, items.length * 9)}s` }}>
        {row(false)}
        {row(true)}
      </div>
    </div>
  )
}

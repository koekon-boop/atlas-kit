/* ------------------------------------------------------------------ *
 * The one speech path the dashboard speaks through.
 *
 * Extracted from Voice.tsx's `say()` so the Voice card (spoken fleet events)
 * and the header "read replies aloud" toggle share exactly one implementation:
 * try the on-box engine (POST /api/voice/speak via synthesize()), fall back to
 * the browser's speechSynthesis, and let a new utterance replace the one in
 * flight. One module-level <audio> element backs every caller, so "off means
 * silent" and "the newest reply wins" hold no matter which surface started it.
 *
 * 🔴 NO MODEL CALL, EVER. Both engines read the given text VERBATIM — the paid
 * `claude -p` recap lives only behind the Voice card's explicit "Recap" button.
 * ------------------------------------------------------------------ */
import { useEffect, useState } from 'preact/hooks'
import { speak, stopSpeaking, synthesize } from './voice'

// ~0.025s of 8-bit silence. Played once from the toggle-on click (primeAudio)
// to satisfy mobile Safari's "audio starts only inside a user gesture" rule, so
// a reply that arrives later — from a poll, off any gesture — can still play.
const SILENT_WAV =
  'data:audio/wav;base64,UklGRuwAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YcgAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA=='

let audioEl: HTMLAudioElement | null = null
function getAudio(): HTMLAudioElement | null {
  if (typeof Audio === 'undefined') return null
  if (!audioEl) audioEl = new Audio()
  return audioEl
}

/* Playback level for the Jarvis reactor. The analyser is spliced in between the
 * shared <audio> element and the speakers ONLY when the Jarvis tab asks for it,
 * from a user gesture (an AudioContext created outside one starts suspended, and
 * a suspended context would silence the element it now routes). Once spliced the
 * element plays through the context for the rest of the page's life, so every
 * play below resumes it first. Browser speechSynthesis has no audio stream to
 * tap — the reactor animates that case without a level. */
type AudioCtor = typeof AudioContext
let actx: AudioContext | null = null
let analyser: AnalyserNode | null = null

export function speechAnalyser(): AnalyserNode | null {
  if (analyser) return analyser
  const el = getAudio()
  const Ctx: AudioCtor | undefined =
    typeof window === 'undefined' ? undefined : window.AudioContext || (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext
  if (!el || !Ctx) return null
  try {
    const ctx = new Ctx()
    const node = ctx.createAnalyser()
    node.fftSize = 512
    ctx.createMediaElementSource(el).connect(node)
    node.connect(ctx.destination)
    actx = ctx
    analyser = node
  } catch {
    return null
  }
  return analyser
}

/** The analyser if the Jarvis tab already spliced it in — never creates one
 *  (safe to call from an animation frame, which is not a user gesture). */
export function currentSpeechAnalyser(): AnalyserNode | null {
  return analyser
}

function resumeAudioCtx() {
  if (actx && actx.state === 'suspended') actx.resume().catch(() => {})
}

// Bumped by every new sayAloud() and by stopAll(), so a say() that is still
// awaiting synthesize() when a newer one starts (or the toggle is switched off)
// bails instead of playing stale audio over it.
let gen = 0
let speaking = false
const subs = new Set<(v: boolean) => void>()
function setSpeaking(v: boolean) {
  if (v === speaking) return
  speaking = v
  subs.forEach((f) => f(v))
}

function releaseUrl(el: HTMLAudioElement) {
  if (el.src.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(el.src)
    } catch {
      /* noop */
    }
  }
}

/** Stop any dashboard speech right now — the browser utterance and the on-box
 *  clip both. The header toggle calls this the instant it is switched off. */
export function stopAll() {
  gen++
  stopSpeaking()
  if (audioEl) {
    audioEl.pause()
    releaseUrl(audioEl)
    audioEl.removeAttribute('src')
  }
  setSpeaking(false)
}

/** Prime the audio path from a user gesture (the toggle-on click). Mobile
 *  Safari blocks audio that does not originate in a gesture; blessing the
 *  shared element + the speech queue here is what lets later, poll-driven
 *  replies play. */
export function primeAudio() {
  resumeAudioCtx()
  const el = getAudio()
  if (el) {
    try {
      el.src = SILENT_WAV
      const p = el.play()
      if (p && typeof p.then === 'function')
        p.then(() => {
          el.pause()
          el.removeAttribute('src')
        }).catch(() => {})
    } catch {
      /* noop */
    }
  }
  try {
    if (typeof speechSynthesis !== 'undefined') {
      speechSynthesis.cancel()
      speechSynthesis.speak(new SpeechSynthesisUtterance(' '))
    }
  } catch {
    /* noop */
  }
}

/** Say `text` aloud. Tries the on-box engine first (unless `onBox` is false —
 *  the Voice card passes its known TTS-availability), else the browser voice.
 *  Resolves to which engine spoke, or 'silent' when neither could. */
export async function sayAloud(
  text: string,
  { onBox = true }: { onBox?: boolean } = {},
): Promise<'on-box' | 'browser' | 'silent'> {
  const mine = ++gen
  const clean = text.trim()
  stopSpeaking()
  audioEl?.pause()
  if (!clean) {
    setSpeaking(false)
    return 'silent'
  }
  setSpeaking(true)
  const el = getAudio()
  if (onBox && el) {
    const blob = await synthesize(clean)
    if (mine !== gen) return 'silent' // superseded by a newer say(), or stopAll()
    if (blob) {
      releaseUrl(el)
      el.src = URL.createObjectURL(blob)
      el.onended = el.onerror = () => {
        if (mine === gen) setSpeaking(false)
      }
      resumeAudioCtx()
      try {
        await el.play()
      } catch {
        if (mine === gen) setSpeaking(false)
      }
      return 'on-box'
    }
    // engine or route unreachable — fall through to the browser
  }
  if (speak(clean, { onEnd: () => mine === gen && setSpeaking(false) })) return 'browser'
  setSpeaking(false)
  return 'silent'
}

/** Subscribe to whether anything is being spoken right now (for a Stop button). */
export function useSpeaking(): boolean {
  const [v, setV] = useState(speaking)
  useEffect(() => {
    const f = (x: boolean) => setV(x)
    subs.add(f)
    setV(speaking)
    return () => {
      subs.delete(f)
    }
  }, [])
  return v
}

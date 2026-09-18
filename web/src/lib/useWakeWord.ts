/* ------------------------------------------------------------------ *
 * "Jarvis, …" — hands-free wake word for the Jarvis tab.
 *
 * Built on the browser's continuous SpeechRecognition (the same Web Speech API
 * useDictation uses), OPT-IN per page and off by default, because an always-on
 * recogniser is exactly the always-on microphone it sounds like — and ⚠️ in
 * Chrome that audio goes to Google for as long as it is on. The tab says so next
 * to the switch.
 *
 * Only an utterance that STARTS a command with the wake word is acted on
 * (wakeCommand in jarvis.ts). "Jarvis" on its own arms the next utterance for
 * ARM_MS. While Jarvis itself is speaking (`paused`) results are dropped, so the
 * reply read aloud through the speakers cannot trigger a command.
 *
 * Browsers end a continuous session on their own (silence, a network blip, a
 * tab in the background); while `on`, it is restarted with a short delay.
 * `not-allowed` / `service-not-allowed` stop it for good — retrying a denied mic
 * in a loop is how a page gets its permission revoked.
 * ------------------------------------------------------------------ */
import { useEffect, useRef, useState } from 'preact/hooks'
import { wakeCommand } from './jarvis'

const ARM_MS = 8000

interface Result {
  isFinal: boolean
  0: { transcript: string }
}
interface Recognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  abort(): void
  onresult: ((e: { resultIndex: number; results: { length: number; [i: number]: Result } }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}
type RecognitionCtor = new () => Recognition

const ctor = (): RecognitionCtor | null => {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition || w.webkitSpeechRecognition || null
}

export interface WakeWord {
  supported: boolean
  listening: boolean
  /** The wake word was heard alone; the next utterance is the command. */
  armed: boolean
  error: string
  /** Last final utterance heard (shown faintly, so a misfire is visible). */
  heard: string
}

export function useWakeWord(on: boolean, paused: boolean, onCommand: (text: string) => void): WakeWord {
  const supported = !!ctor()
  const [listening, setListening] = useState(false)
  const [armed, setArmed] = useState(false)
  const [error, setError] = useState('')
  const [heard, setHeard] = useState('')
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const cmdRef = useRef(onCommand)
  cmdRef.current = onCommand

  useEffect(() => {
    const Ctor = ctor()
    if (!on || !Ctor) return
    let alive = true
    let armedUntil = 0
    let rec: Recognition | null = null
    let restart: ReturnType<typeof setTimeout> | null = null
    setError('')

    const begin = () => {
      if (!alive) return
      const r = new Ctor()
      r.lang = navigator.language || 'en-US'
      r.continuous = true
      r.interimResults = false
      r.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i]
          if (!res.isFinal || pausedRef.current) continue
          const text = res[0].transcript.trim()
          if (!text) continue
          setHeard(text)
          const cmd = wakeCommand(text)
          if (cmd) {
            armedUntil = 0
            setArmed(false)
            cmdRef.current(cmd)
          } else if (cmd === '') {
            armedUntil = Date.now() + ARM_MS
            setArmed(true)
            setTimeout(() => {
              if (alive && Date.now() >= armedUntil) setArmed(false)
            }, ARM_MS + 50)
          } else if (Date.now() < armedUntil) {
            armedUntil = 0
            setArmed(false)
            cmdRef.current(text)
          }
        }
      }
      r.onerror = (e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          alive = false
          setError('microphone permission denied')
        } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
          setError(e.error)
        }
      }
      r.onend = () => {
        setListening(false)
        if (alive) restart = setTimeout(begin, 600)
      }
      rec = r
      try {
        r.start()
        setListening(true)
      } catch (e) {
        setError(String(e))
      }
    }
    begin()

    return () => {
      alive = false
      if (restart) clearTimeout(restart)
      rec?.abort()
      setListening(false)
      setArmed(false)
    }
  }, [on])

  return { supported, listening, armed, error, heard }
}

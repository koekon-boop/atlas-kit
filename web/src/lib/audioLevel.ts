/* ------------------------------------------------------------------ *
 * Live audio level (0..1) for the Jarvis reactor — from the microphone while
 * Jarvis listens, and from the on-box voice while it speaks (speak.ts).
 *
 * 🔴 THE MIC IS OPEN ONLY WHILE `active`. The stream is requested when listening
 * starts and every track is stopped the moment it ends or the tab unmounts — the
 * browser's recording indicator must never outlive what the operator asked for.
 * A denied or missing mic is not an error here: the level simply stays 0 and the
 * reactor still shows the listening state.
 * ------------------------------------------------------------------ */
import { useEffect, useRef } from 'preact/hooks'

/** RMS of the analyser's time-domain signal, scaled so speech lands ~0.3–1. */
export function readLevel(node: AnalyserNode | null, buf: Uint8Array<ArrayBuffer> | null): number {
  if (!node || !buf) return 0
  node.getByteTimeDomainData(buf)
  let sum = 0
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128
    sum += v * v
  }
  return Math.min(1, Math.sqrt(sum / buf.length) * 4)
}

/** A getter for the current mic level; 0 whenever `active` is false. */
export function useMicLevel(active: boolean): () => number {
  const nodeRef = useRef<AnalyserNode | null>(null)
  const bufRef = useRef<Uint8Array<ArrayBuffer> | null>(null)

  useEffect(() => {
    if (!active || typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return
    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null
    let alive = true
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((s) => {
        if (!alive) return s.getTracks().forEach((t) => t.stop())
        stream = s
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (!Ctx) return
        ctx = new Ctx()
        const node = ctx.createAnalyser()
        node.fftSize = 512
        ctx.createMediaStreamSource(s).connect(node) // analysed only — never routed to the speakers
        nodeRef.current = node
        bufRef.current = new Uint8Array(node.fftSize)
      })
      .catch(() => {
        /* denied / no device: level stays 0 */
      })
    return () => {
      alive = false
      nodeRef.current = null
      bufRef.current = null
      stream?.getTracks().forEach((t) => t.stop())
      ctx?.close().catch(() => {})
    }
  }, [active])

  return () => readLevel(nodeRef.current, bufRef.current)
}

import { useEffect, useRef } from 'preact/hooks'
import { useMediaQuery } from '../../lib/useMediaQuery'

export type ReactorMode = 'idle' | 'listening' | 'thinking' | 'speaking'

/* The arc-reactor orb at the centre of the Jarvis tab — the most-shared element
 * of every "Jarvis AI" build on Instagram (docs/jarvis-features.md #17).
 *
 * It is a READOUT, not decoration: its radius and glow follow `level()` — the
 * real microphone level while Jarvis listens, the real playback level while the
 * on-box voice speaks (lib/audioLevel.ts, lib/speak.ts). The browser-voice
 * fallback has no stream to measure, so that case pulses on a fixed rhythm.
 *
 * 🔴 IDLE IS STILL. The dashboard runs on a TV all day (AppShell: motion is
 * entrance-only), so the animation loop runs only in listening/thinking/speaking
 * and the idle orb is one static frame. prefers-reduced-motion drops rotation
 * and keeps only the level-driven glow. */
export function Reactor({
  mode,
  level,
  onClick,
  label,
}: {
  mode: ReactorMode
  level: () => number
  onClick?: () => void
  label: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const levelRef = useRef(level)
  levelRef.current = level
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)')

  useEffect(() => {
    const canvas = ref.current
    const g = canvas?.getContext('2d')
    if (!canvas || !g) return
    let raf = 0
    let smooth = 0
    const start = performance.now()

    const size = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const w = canvas.clientWidth || 300
      if (canvas.width !== Math.round(w * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(w * dpr)
      }
      return { dpr, w }
    }

    const frame = (now: number) => {
      const { dpr, w } = size()
      const t = (now - start) / 1000
      let raw = mode === 'idle' ? 0 : levelRef.current()
      if (mode === 'speaking' && raw === 0) raw = 0.35 + 0.25 * Math.sin(t * 7) * Math.sin(t * 2.3) // browser voice: no stream
      if (mode === 'thinking') raw = 0.12 + 0.08 * Math.sin(t * 3)
      smooth += (raw - smooth) * 0.25
      draw(g, w * dpr, t, smooth, mode, reduced)
      if (mode !== 'idle') raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    const onResize = () => {
      if (mode === 'idle') requestAnimationFrame(frame)
    }
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
    }
  }, [mode, reduced])

  return (
    <button type="button" className={`jv-reactor jv-reactor--${mode}`} onClick={onClick} aria-label={label} title={label}>
      <canvas ref={ref} className="jv-reactor__canvas" aria-hidden="true" />
    </button>
  )
}

const CYAN = '34, 211, 238'
const ICE = '224, 251, 255'

function draw(g: CanvasRenderingContext2D, px: number, t: number, level: number, mode: ReactorMode, reduced: boolean) {
  const c = px / 2
  const R = px * 0.3 // core ring radius
  const spin = reduced || mode === 'idle' ? 0 : t
  g.clearRect(0, 0, px, px)

  // Outer halo — grows with the level.
  const halo = g.createRadialGradient(c, c, R * 0.3, c, c, R * (1.55 + level * 0.45))
  halo.addColorStop(0, `rgba(${CYAN}, ${0.32 + level * 0.4})`)
  halo.addColorStop(0.55, `rgba(${CYAN}, ${0.08 + level * 0.12})`)
  halo.addColorStop(1, `rgba(${CYAN}, 0)`)
  g.fillStyle = halo
  g.beginPath()
  g.arc(c, c, px / 2, 0, Math.PI * 2)
  g.fill()

  // Tick ring (60 ticks), counter-rotating.
  g.save()
  g.translate(c, c)
  g.rotate(-spin * 0.15)
  for (let i = 0; i < 60; i++) {
    const long = i % 5 === 0
    g.strokeStyle = `rgba(${CYAN}, ${long ? 0.75 : 0.35})`
    g.lineWidth = px * (long ? 0.006 : 0.003)
    const a = (i / 60) * Math.PI * 2
    const r0 = R * 1.42
    const r1 = R * (long ? 1.52 : 1.48)
    g.beginPath()
    g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0)
    g.lineTo(Math.cos(a) * r1, Math.sin(a) * r1)
    g.stroke()
  }
  g.restore()

  // Voice ring — a closed wave whose amplitude is the level.
  g.save()
  g.translate(c, c)
  g.strokeStyle = `rgba(${ICE}, ${0.35 + level * 0.6})`
  g.lineWidth = px * 0.004
  g.shadowColor = `rgba(${CYAN}, 0.9)`
  g.shadowBlur = px * 0.03
  g.beginPath()
  for (let i = 0; i <= 120; i++) {
    const a = (i / 120) * Math.PI * 2
    const wobble = level * R * 0.12 * (Math.sin(a * 6 + t * 5) * 0.6 + Math.sin(a * 11 - t * 3.2) * 0.4)
    const r = R * 1.22 + wobble
    const x = Math.cos(a) * r
    const y = Math.sin(a) * r
    if (i) g.lineTo(x, y)
    else g.moveTo(x, y)
  }
  g.stroke()
  g.restore()

  // Ten reactor segments.
  g.save()
  g.translate(c, c)
  g.rotate(spin * 0.4)
  for (let i = 0; i < 10; i++) {
    const a0 = (i / 10) * Math.PI * 2 + 0.06
    const a1 = ((i + 1) / 10) * Math.PI * 2 - 0.06
    g.strokeStyle = `rgba(${CYAN}, ${0.55 + level * 0.45})`
    g.lineWidth = R * 0.16
    g.beginPath()
    g.arc(0, 0, R * (0.98 + level * 0.06), a0, a1)
    g.stroke()
  }
  g.restore()

  // Thinking: a sweeping arc.
  if (mode === 'thinking') {
    g.save()
    g.translate(c, c)
    g.rotate(reduced ? 0 : t * 2.2)
    g.strokeStyle = `rgba(${ICE}, 0.9)`
    g.lineWidth = px * 0.008
    g.beginPath()
    g.arc(0, 0, R * 1.3, 0, Math.PI * 0.5)
    g.stroke()
    g.restore()
  }

  // Core.
  const core = g.createRadialGradient(c, c, 0, c, c, R * 0.72)
  core.addColorStop(0, `rgba(255, 255, 255, 1)`)
  core.addColorStop(0.35, `rgba(${ICE}, ${0.9})`)
  core.addColorStop(0.75, `rgba(${CYAN}, ${0.45 + level * 0.4})`)
  core.addColorStop(1, `rgba(${CYAN}, 0.05)`)
  g.fillStyle = core
  g.beginPath()
  g.arc(c, c, R * (0.62 + level * 0.1), 0, Math.PI * 2)
  g.fill()

  // Inner triangle (Mk VI) — a quiet nod, stroked thin.
  g.save()
  g.translate(c, c)
  g.strokeStyle = `rgba(${ICE}, 0.55)`
  g.lineWidth = px * 0.004
  g.beginPath()
  for (let i = 0; i <= 3; i++) {
    const a = -Math.PI / 2 + (i / 3) * Math.PI * 2
    const x = Math.cos(a) * R * 0.45
    const y = Math.sin(a) * R * 0.45
    if (i) g.lineTo(x, y)
    else g.moveTo(x, y)
  }
  g.stroke()
  g.restore()
}

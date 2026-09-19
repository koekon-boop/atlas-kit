/* ------------------------------------------------------------------ *
 * One-shot browser geolocation for the Jarvis tab's maps questions
 * (addons/maps) — a fix is folded into a new chat's opening turn so a
 * question like "how far to X" has a starting point (see jarvis.ts jarvisTask).
 *
 * ONLY ever read from an explicit send/talk action, never polled in the
 * background — a phone's GPS is a battery and privacy cost nobody asked to
 * pay just by leaving the tab open. A fix is cached briefly so several sends
 * in a row do not re-block on a fresh GPS lock or re-prompt for permission.
 * ------------------------------------------------------------------ */
import { useRef, useState } from 'preact/hooks'

export interface LocationFix {
  lat: number
  lon: number
  accuracyM?: number
}

const MAX_AGE_MS = 2 * 60 * 1000

export interface LocationOnDemand {
  /** Resolves with a fresh-enough cached fix or a new one; null if the
   *  browser has no geolocation, permission was denied, or it timed out —
   *  callers proceed without a location rather than blocking on it. */
  get: () => Promise<LocationFix | null>
  /** Why the last attempt came back null; empty otherwise. */
  error: string
}

export function useLocationOnDemand(): LocationOnDemand {
  const cached = useRef<{ at: number; fix: LocationFix } | null>(null)
  const [error, setError] = useState('')

  const get = (): Promise<LocationFix | null> => {
    if (cached.current && Date.now() - cached.current.at < MAX_AGE_MS) return Promise.resolve(cached.current.fix)
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setError('geolocation not available in this browser')
      return Promise.resolve(null)
    }
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const fix: LocationFix = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracyM: pos.coords.accuracy ?? undefined }
          cached.current = { at: Date.now(), fix }
          setError('')
          resolve(fix)
        },
        (err) => {
          setError(err.message || 'location unavailable')
          resolve(null)
        },
        { enableHighAccuracy: true, timeout: 6000, maximumAge: MAX_AGE_MS },
      )
    })
  }

  return { get, error }
}

/* ------------------------------------------------------------------ *
 * "Read new agent replies aloud" — the header toggle's shared on/off state.
 *
 * A module-level flag (not React state) because the toggle lives in the app
 * header and the code that actually speaks lives in each open AgentRow — far
 * apart in the tree, same shape as agentFocus.ts. Persisted to localStorage in
 * the guarded style Voice.tsx uses for its own AUTO_KEY: private mode must not
 * throw, it just does not persist.
 * ------------------------------------------------------------------ */
import { useEffect, useState } from 'preact/hooks'

const KEY = 'atlas.voice.readReplies'

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}
function persist(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    /* private mode — the toggle still works for this session */
  }
}

let on = read()
const subs = new Set<() => void>()

export function readAloudOn(): boolean {
  return on
}

export function setReadAloud(next: boolean) {
  if (next === on) return
  on = next
  persist(next)
  subs.forEach((f) => f())
}

export function useReadAloud(): boolean {
  const [, force] = useState(0)
  useEffect(() => {
    const cb = () => force((x) => x + 1)
    subs.add(cb)
    return () => {
      subs.delete(cb)
    }
  }, [])
  return on
}

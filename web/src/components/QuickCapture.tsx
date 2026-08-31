import { useEffect, useRef, useState } from 'preact/hooks'
import { MicField } from './MicField'
import { createTask } from '../lib/api'

/* ------------------------------------------------------------------ *
 * The one-tap quick-capture surface (its own route — see main.tsx).
 *
 * One field, one button: type (or dictate — the field is a MicField, so the
 * `voice` addon's mic rides in its corner) a thought and file it straight into
 * the Atlas Inbox via the SAME POST /api/tasks/new the Kanban composer uses
 * (createTask below — no second write path, no bearer here: Caddy injects it).
 * After a successful file the field clears and keeps focus so the next thought
 * goes in without a tap elsewhere. A failed POST keeps the typed text and shows
 * the error — the thought is never lost.
 *
 * Pinnable to an iPhone home screen: while this screen is mounted the page's
 * manifest link points at capture.webmanifest (start_url /capture), so "Add to
 * Home Screen" lands back here, not on the dashboard root.
 * ------------------------------------------------------------------ */

// Files into the typed Atlas vault — same target as the Home tab and the Kanban.
const VAULT = 'atlas'
// Written verbatim into the task's `source:` frontmatter (the open-ended Legend
// `source` provenance enum), so phone-filed to-dos are distinguishable from the
// hourly email pass's and from agent-proposed ones.
const SOURCE = 'capture'
const CAPTURE_MANIFEST = '/capture.webmanifest'

export function QuickCapture() {
  // Prefill from the URL so an iOS Shortcut / the share sheet can hand content
  // in (?text= or ?title=). Present-but-not-submitted: the operator still taps.
  const prefill = (() => {
    const p = new URLSearchParams(location.search)
    return (p.get('text') ?? p.get('title') ?? '').trim()
  })()

  const [text, setText] = useState(prefill)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filed, setFiled] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Point the home-screen manifest at the capture-specific one while mounted;
  // restore it (and the title) on unmount so the dashboard is unaffected.
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')
    const prevHref = link?.getAttribute('href') ?? null
    const prevTitle = document.title
    link?.setAttribute('href', CAPTURE_MANIFEST)
    document.title = 'Atlas Capture'
    return () => {
      if (link && prevHref) link.setAttribute('href', prevHref)
      document.title = prevTitle
    }
  }, [])

  // Autofocus straight into the field (the `autofocus` attribute is unreliable
  // on a client-rendered root).
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const update = (next: string) => {
    setText(next)
    if (filed) setFiled(null)
  }

  const submit = async (e: Event) => {
    e.preventDefault()
    const title = text.trim()
    if (!title || busy) return
    setBusy(true)
    setError(null)
    const r = await createTask(title, undefined, undefined, undefined, VAULT, SOURCE)
    setBusy(false)
    if (!r.ok) {
      // Keep `text` — the typed thought is never lost. The button becomes Retry.
      setError(r.error || 'Could not file — check the connection and try again')
      inputRef.current?.focus()
      return
    }
    setFiled(title)
    setText('')
    inputRef.current?.focus()
  }

  return (
    <div className="qcap-screen app-bg">
      <form className="qcap glass" onSubmit={submit}>
        <h1 className="qcap__title hud-label">Quick capture</h1>
        <MicField value={text} onChange={update}>
          <input
            ref={inputRef}
            className="qcap__input"
            type="text"
            enterKeyHint="send"
            autoComplete="off"
            autoCapitalize="sentences"
            placeholder="What's on your mind?"
            aria-label="New to-do"
            value={text}
            onInput={(e) => update(e.currentTarget.value)}
          />
        </MicField>
        <button
          type="submit"
          className="btn btn--approve qcap__submit"
          disabled={busy || !text.trim()}
        >
          {busy ? 'Filing…' : error ? 'Retry' : 'File to Inbox'}
        </button>
        {error ? (
          <p className="qcap__msg qcap__msg--err" role="alert">
            {error}
          </p>
        ) : filed ? (
          <p className="qcap__msg qcap__msg--ok" role="status">
            Filed to Inbox: “{filed}”
          </p>
        ) : (
          <p className="qcap__msg qcap__msg--hint">Stays open — file as many as you like.</p>
        )}
      </form>
    </div>
  )
}

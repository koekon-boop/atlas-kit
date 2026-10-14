import { useState } from 'preact/hooks'
import { Card } from '../Card'
import { useData } from '../../lib/useData'
import { useAddons } from '../../lib/addons'
import { fetchClaudeLoginAwaiting, submitClaudeLoginCode } from '../../lib/api'

/* ClaudeLogin — the dashboard fallback channel for addons/claude-login: a
 * renewal is waiting for a human to tap the OAuth link and paste the code
 * back. Telegram (when configured) already asks for this in the chat; this
 * card is what shows up when nobody is watching Telegram, or on a box that
 * never set it up at all.
 *
 * 🔴 GATED AT RUNTIME, NOT AT BUILD TIME (docs/ADDONS.md) — null unless
 * GET /api/addons says `claude-login` is enabled ON THIS BOX. Polled on a
 * much shorter cycle than the other addon cards (News, Voice): the whole
 * point is that an unattended renewal expires in minutes, not hours, so this
 * has to actually be seen in time to matter. And unlike those cards, it also
 * renders NOTHING once the addon is enabled but no renewal is pending — a
 * banner that shows up only when something needs a human. */
export function ClaudeLogin({ className = '' }: { className?: string }) {
  const addons = useAddons()
  const enabled = addons.ready && addons.enabled('claude-login')
  const { data } = useData(() => (enabled ? fetchClaudeLoginAwaiting() : Promise.resolve(null)), 15000)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  if (!enabled || !data?.awaiting) return null

  const submit = async () => {
    const v = code.trim()
    if (!v || busy) return
    setBusy(true)
    setMsg(null)
    const r = await submitClaudeLoginCode(v)
    setBusy(false)
    if (r.ok) {
      setMsg('Erneuert — danke!')
      setCode('')
    } else if (r.attemptsLeft != null) {
      setMsg(`Das hat nicht geklappt — noch ${r.attemptsLeft} Versuch${r.attemptsLeft === 1 ? '' : 'e'}.`)
    } else {
      setMsg(r.error || 'Das hat nicht geklappt.')
    }
  }

  return (
    <Card title="Claude-Anmeldung" className={className}>
      <div className="dpass">
        <div className="search__warn">
          <span aria-hidden="true">⚠</span>
          <span>
            Die Claude-Anmeldung auf dieser Box muss erneuert werden.{' '}
            {data.via === 'telegram' ? 'Eine Nachricht ist bereits unterwegs zu Telegram — dasselbe klappt auch hier:' : 'Bitte den Link öffnen und danach den angezeigten Code hier eintragen:'}
          </span>
        </div>
        <p className="dpass__sub">
          <a href={data.url} target="_blank" rel="noopener noreferrer">
            {data.url}
          </a>
        </p>
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.4rem' }}>
          <input
            className="wiki-browse__filter"
            placeholder="Code von der Freigabe-Seite"
            value={code}
            onInput={(e) => setCode(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            disabled={busy}
          />
          <button type="button" className="btn btn--approve" onClick={submit} disabled={busy || !code.trim()}>
            Senden
          </button>
        </div>
        {msg ? <p className="dpass__sub">{msg}</p> : null}
      </div>
    </Card>
  )
}

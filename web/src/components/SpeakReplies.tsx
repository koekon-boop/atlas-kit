import { useAddons } from '../lib/addons'
import { useReadAloud, setReadAloud } from '../lib/readAloud'
import { primeAudio, stopAll } from '../lib/speak'

/* The dashboard header's big "read agent replies aloud" switch.
 *
 * 🔴 RUNTIME-GATED, like the Voice card: it renders only where GET /api/addons
 * says the `voice` addon is enabled ON THIS BOX, and costs no request anywhere
 * else (docs/ADDONS.md). One build of web/dist serves every install.
 *
 * While it is on, each NEW agent reply in the transcript the operator has open
 * is spoken once — the actual speaking is done by the open AgentRow through
 * lib/speak.ts, verbatim, with no model call. Flipping it ON is also the user
 * gesture mobile Safari needs before it will play audio, so primeAudio() runs
 * from this handler; flipping it OFF stops any audio in flight immediately. */
export function SpeakReplies() {
  const addons = useAddons()
  if (!(addons.ready && addons.enabled('voice'))) return null
  return <SpeakToggle />
}

function SpeakToggle() {
  const on = useReadAloud()
  const toggle = () => {
    const next = !on
    setReadAloud(next)
    if (next) primeAudio()
    else stopAll()
  }
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Read new agent replies aloud"
      className={`speak-toggle${on ? ' speak-toggle--on' : ''}`}
      onClick={toggle}
      title="Read each new agent reply in the chat you have open aloud — on-box voice, verbatim, no model call"
    >
      <span className="speak-toggle__icon" aria-hidden="true">
        {on ? '🔊' : '🔇'}
      </span>
      <span className="speak-toggle__label">Read aloud</span>
      <span className="speak-toggle__state">{on ? 'On' : 'Off'}</span>
    </button>
  )
}

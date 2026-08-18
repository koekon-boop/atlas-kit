/* ------------------------------------------------------------------ *
 * Instants, not clock faces.
 *
 * 🔴 EVERY FLIGHT TIME AN AIRLINE API HANDS YOU IS A LOCAL WALL CLOCK WITH NO
 * OFFSET. Duffel returns `"departing_at": "2026-10-15T09:35:00"` — that is 09:35
 * *at that airport*, and nothing in the string says which airport or which side
 * of a DST switch. Subtracting two such strings is correct only when both ends
 * sit in the same zone AND no transition falls between them; every other case is
 * silently wrong, and wrong in the direction that makes an impossible connection
 * look comfortable.
 *
 * So this module converts each wall clock to a UTC INSTANT using the airport's
 * IANA zone (Duffel puts `time_zone` on every airport object, so it costs no
 * lookup table) and does all arithmetic there. `Intl.DateTimeFormat` is the
 * offset oracle — it is the platform's own tz database, DST transitions and
 * historical offsets included, so there is no table to ship and nothing to keep
 * up to date.
 *
 * The three cases this exists for, all covered by test/time.test.mjs:
 *   · the date line — NRT 17:00 → LAX 10:00 "the same morning" is +9 h, not −7
 *   · a DST fall-back — a Chicago layover of 00:45 → 02:30 is 165 min, not 105
 *   · midnight — 23:30 → 00:40 is 70 min, not the naive −1370
 * ------------------------------------------------------------------ */

/** `"PT02H26M"` / `"P1DT3H"` → minutes. 0 for anything unparseable. */
export function isoDurationMinutes(s) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(String(s || '').trim())
  if (!m) return 0
  const [, d, h, min, sec] = m
  return (Number(d || 0) * 1440) + (Number(h || 0) * 60) + Number(min || 0) + Math.round(Number(sec || 0) / 60)
}

/* One formatter per zone, reused. Building an Intl.DateTimeFormat is the
 * expensive part of this file and the grid asks for the same handful of zones
 * thousands of times. `null` is cached too, so an invalid zone costs one throw
 * and never a second. */
const FORMATTERS = new Map()
function formatterFor(tz) {
  if (FORMATTERS.has(tz)) return FORMATTERS.get(tz)
  let f = null
  // ⚠️ An absent `timeZone` option does NOT mean "no zone" to Intl — it means the
  // HOST's zone, so a segment whose airport carried no `time_zone` would be
  // silently measured against whatever TZ the server happens to run in. Falsy is
  // refused here, before Intl gets a chance to be helpful.
  if (!tz || typeof tz !== 'string') {
    FORMATTERS.set(tz, null)
    return null
  }
  try {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    f = null // not a zone this runtime knows — the caller degrades, never throws
  }
  FORMATTERS.set(tz, f)
  return f
}

/** Is `tz` a zone this runtime can actually resolve? Cheap, cached, never throws. */
export const knownZone = (tz) => !!tz && !!formatterFor(tz)

/**
 * The UTC offset of `tz`, in minutes, AT the instant `utcMs` — so a summer date
 * and a winter date in the same zone answer differently, which is the entire
 * point. `NaN` for an unknown zone.
 */
export function offsetMinutesAt(tz, utcMs) {
  const f = formatterFor(tz)
  if (!f) return NaN
  const p = {}
  for (const part of f.formatToParts(new Date(utcMs))) p[part.type] = part.value
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second))
  return (asUtc - utcMs) / 60000
}

const NAIVE_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/
const HAS_OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/

/**
 * A wall clock in `tz` → epoch ms. `NaN` when the string or the zone is unusable
 * — callers treat that as "cannot verify", never as zero.
 *
 * A string that DOES carry an offset is trusted as-is and the zone is ignored:
 * Duffel never sends one, but the adapter seam is meant to take a second source
 * that might, and re-interpreting an already-absolute time would corrupt it.
 *
 * Two passes, because the offset depends on the instant we are still solving
 * for: guess with the offset at the naive time, then re-read the offset at the
 * guess. Inside a DST spring-forward GAP — a wall clock that never existed — no
 * answer is right; this one is deterministic and lands within the hour on one
 * side of the jump, which is all a caller can be owed. It must not throw: one
 * airline's rounding into a missing hour may not take down a whole search.
 */
export function zonedToUtc(local, tz) {
  const s = String(local || '').trim()
  if (HAS_OFFSET_RE.test(s)) {
    const t = Date.parse(s)
    return Number.isFinite(t) ? t : NaN
  }
  const m = NAIVE_RE.exec(s)
  if (!m) return NaN
  const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0))
  const first = offsetMinutesAt(tz, naive)
  if (!Number.isFinite(first)) return NaN
  const second = offsetMinutesAt(tz, naive - first * 60000)
  return Number.isFinite(second) ? naive - second * 60000 : NaN
}

/**
 * Minutes from one zoned wall clock to another. `null` when either end cannot be
 * resolved — a missing timezone must read as "unknown", never as a plausible
 * number, because every consumer here turns a number into a go/no-go.
 */
export function minutesBetween(fromLocal, fromTz, toLocal, toTz) {
  const a = zonedToUtc(fromLocal, fromTz)
  const b = zonedToUtc(toLocal, toTz)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.round((b - a) / 60000)
}

/** Minutes past local midnight of a wall clock — what a "no arrival after 23:00"
 *  filter compares against. Deliberately naive: that rule is about the CLOCK at
 *  the airport, so the timezone is already baked into the string. */
export function localMinuteOfDay(local) {
  const m = NAIVE_RE.exec(String(local || '').trim())
  return m ? Number(m[4]) * 60 + Number(m[5]) : null
}

/** `"YYYY-MM-DD"` of a wall clock — used to report "+1" arrivals. */
export function localDate(local) {
  const m = NAIVE_RE.exec(String(local || '').trim())
  return m ? `${m[1]}-${m[2]}-${m[3]}` : ''
}

/** `"HH:MM"` → minutes past midnight; `null` if it is not a time of day. */
export function parseClock(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  return h < 24 && min < 60 ? h * 60 + min : null
}

/** Calendar-day arithmetic on `YYYY-MM-DD`, in UTC so no zone can shift a date. */
export function addDays(isoDate, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || '').trim())
  if (!m) return ''
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * 86400000
  return new Date(t).toISOString().slice(0, 10)
}

/** Whole days from `a` to `b`, both `YYYY-MM-DD`. `null` if either is malformed. */
export function daysBetween(a, b) {
  const p = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim())
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN
  }
  const x = p(a)
  const y = p(b)
  return Number.isFinite(x) && Number.isFinite(y) ? Math.round((y - x) / 86400000) : null
}

/** `455` → `"7h 35m"`. For the human-readable half of the tool answer. */
export function humanMinutes(min) {
  if (!Number.isFinite(min)) return 'unknown'
  const sign = min < 0 ? '-' : ''
  const n = Math.abs(Math.round(min))
  const h = Math.floor(n / 60)
  return h ? `${sign}${h}h ${n % 60}m` : `${sign}${n}m`
}

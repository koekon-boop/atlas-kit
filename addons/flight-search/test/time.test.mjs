/* ------------------------------------------------------------------ *
 * Guards the arithmetic every other file in this addon depends on: local wall
 * clocks from an airline API turned into instants.
 *
 * These are the three cases where subtracting the strings — the obvious
 * implementation, and the one a reviewer will not notice is missing — gives an
 * answer that is not merely imprecise but the wrong sign or an hour short:
 *   · the date line (arrive "before" you left)
 *   · a layover across a DST fall-back (the clock lies by an hour)
 *   · a layover across midnight (the naive difference goes negative)
 * Hermetic: the tz database is the runtime's own, so there is nothing to stub
 * and nothing to keep in sync.
 * Run: node --test addons/flight-search/test/time.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { isoDurationMinutes, offsetMinutesAt, zonedToUtc, minutesBetween, localMinuteOfDay, localDate, parseClock, addDays, daysBetween, humanMinutes, knownZone } = await import('../api/time.mjs')

test('ISO 8601 durations, in the shapes Duffel actually sends', () => {
  assert.equal(isoDurationMinutes('PT02H26M'), 146)
  assert.equal(isoDurationMinutes('PT11H'), 660)
  assert.equal(isoDurationMinutes('PT45M'), 45)
  assert.equal(isoDurationMinutes('P1DT3H30M'), 1650)
  // Unparseable is 0, not NaN: a missing duration falls back to instant maths
  // upstream, and NaN would poison every sum it touched.
  assert.equal(isoDurationMinutes(''), 0)
  assert.equal(isoDurationMinutes('26 minutes'), 0)
  assert.equal(isoDurationMinutes(null), 0)
})

test('an unknown zone is knowable as unknown, and never throws', () => {
  assert.equal(knownZone('Europe/Berlin'), true)
  assert.equal(knownZone('Mars/Olympus'), false)
  assert.equal(knownZone(''), false)
  assert.equal(knownZone(undefined), false)
  assert.ok(Number.isNaN(offsetMinutesAt('Mars/Olympus', Date.now())))
})

test('offsets are read AT an instant, so DST is not a constant', () => {
  const summer = Date.UTC(2026, 6, 1)
  const winter = Date.UTC(2026, 11, 1)
  assert.equal(offsetMinutesAt('Europe/Berlin', summer), 120) // CEST
  assert.equal(offsetMinutesAt('Europe/Berlin', winter), 60) // CET
  assert.equal(offsetMinutesAt('Asia/Tokyo', summer), 540) // no DST, ever
  assert.equal(offsetMinutesAt('Asia/Tokyo', winter), 540)
})

test('a wall clock plus a zone is an instant', () => {
  assert.equal(zonedToUtc('2026-10-15T09:35:00', 'Europe/Berlin'), Date.UTC(2026, 9, 15, 7, 35))
  assert.equal(zonedToUtc('2026-10-15T20:15:00', 'Europe/Istanbul'), Date.UTC(2026, 9, 15, 17, 15))
  assert.equal(zonedToUtc('2026-10-16T13:45', 'Asia/Tokyo'), Date.UTC(2026, 9, 16, 4, 45))
  // A string that already carries an offset is absolute; the zone is ignored
  // rather than applied a second time. Duffel never sends one — a second adapter
  // might, and re-interpreting it would silently shift the whole itinerary.
  assert.equal(zonedToUtc('2026-10-15T09:35:00Z', 'Asia/Tokyo'), Date.UTC(2026, 9, 15, 9, 35))
  assert.equal(zonedToUtc('2026-10-15T09:35:00+02:00', 'Asia/Tokyo'), Date.UTC(2026, 9, 15, 7, 35))
  // Unusable input is NaN, never a plausible number.
  assert.ok(Number.isNaN(zonedToUtc('2026-10-15T09:35:00', 'Mars/Olympus')))
  assert.ok(Number.isNaN(zonedToUtc('next tuesday', 'Europe/Berlin')))
  assert.ok(Number.isNaN(zonedToUtc('2026-10-15T09:35:00', '')))
})

test('ACROSS THE DATE LINE: NRT 17:00 → LAX 10:00 the same morning is +9 h, not −7', () => {
  const minutes = minutesBetween('2026-10-15T17:00:00', 'Asia/Tokyo', '2026-10-15T10:00:00', 'America/Los_Angeles')
  assert.equal(minutes, 540)
  // The naive difference of the two strings — the bug this exists to prevent.
  assert.equal((Date.parse('2026-10-15T10:00:00Z') - Date.parse('2026-10-15T17:00:00Z')) / 60000, -420)
})

test('ACROSS A DST FALL-BACK: a Chicago layover is 165 minutes while the clock says 105', () => {
  // 2026-11-01, 02:00 CDT → 01:00 CST. Arrive before the switch, leave after it.
  const minutes = minutesBetween('2026-11-01T00:45:00', 'America/Chicago', '2026-11-01T02:30:00', 'America/Chicago')
  assert.equal(minutes, 165)
  assert.equal((Date.parse('2026-11-01T02:30:00Z') - Date.parse('2026-11-01T00:45:00Z')) / 60000, 105)
})

test('ACROSS MIDNIGHT: 23:30 → 00:40 the next day is 70 minutes', () => {
  assert.equal(minutesBetween('2026-10-15T23:30:00', 'Europe/Istanbul', '2026-10-16T00:40:00', 'Europe/Istanbul'), 70)
})

test('a wall clock inside a spring-forward gap resolves to SOMETHING, deterministically', () => {
  // 2026-03-08 02:30 America/Chicago never happens. There is no right answer, so
  // the contract is only that there is an ANSWER: finite, stable across calls,
  // and within an hour of the missing time. A throw here would take down a whole
  // search over one airline's rounding.
  const a = zonedToUtc('2026-03-08T02:30:00', 'America/Chicago')
  const b = zonedToUtc('2026-03-08T02:30:00', 'America/Chicago')
  assert.ok(Number.isFinite(a))
  assert.equal(a, b)
  assert.ok(Math.abs(a - Date.UTC(2026, 2, 8, 8, 0)) <= 3600000)
})

test('a missing timezone reads as unknown, never as zero', () => {
  assert.equal(minutesBetween('2026-10-15T14:05:00', '', '2026-10-15T15:30:00', 'Europe/Istanbul'), null)
  assert.equal(minutesBetween('2026-10-15T14:05:00', 'Europe/Istanbul', '2026-10-15T15:30:00', undefined), null)
})

test('local clock helpers stay naive on purpose — a "no arrival after 23:00" rule is about the airport clock', () => {
  assert.equal(localMinuteOfDay('2026-10-16T13:45:00'), 825)
  assert.equal(localMinuteOfDay('nope'), null)
  assert.equal(localDate('2026-10-16T13:45:00'), '2026-10-16')
  assert.equal(parseClock('23:00'), 1380)
  assert.equal(parseClock('9:05'), 545)
  assert.equal(parseClock('24:00'), null)
  assert.equal(parseClock('12:60'), null)
  assert.equal(parseClock(''), null)
})

test('calendar maths is UTC, so no zone can move a date across a month or a year', () => {
  assert.equal(addDays('2026-10-15', 3), '2026-10-18')
  assert.equal(addDays('2026-10-31', 1), '2026-11-01')
  assert.equal(addDays('2026-01-01', -1), '2025-12-31')
  assert.equal(addDays('2026-02-28', 1), '2026-03-01') // 2026 is not a leap year
  assert.equal(addDays('bad', 1), '')
  assert.equal(daysBetween('2026-10-15', '2026-10-25'), 10)
  assert.equal(daysBetween('2026-10-15', 'bad'), null)
})

test('durations render for a human', () => {
  assert.equal(humanMinutes(455), '7h 35m')
  assert.equal(humanMinutes(45), '45m')
  assert.equal(humanMinutes(-90), '-1h 30m')
  assert.equal(humanMinutes(null), 'unknown')
})

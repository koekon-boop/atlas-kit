/* ------------------------------------------------------------------ *
 * The Jarvis tab's pure decisions (jarvis.ts).
 *
 * What is pinned here is what the tab SAYS: the wake-word parse (a false
 * positive sends a stray sentence to an agent; a false negative is a Jarvis
 * that never answers), the network rate (a counter reset must not read as a
 * multi-gigabit burst), and the spoken brief (a missing reading is skipped,
 * never guessed out loud). Plus which chat a command goes to, and how.
 *
 * Runs the real TS module through node's type-stripping; no DOM, no fetch.
 * Run: node --test web/src/lib/jarvis.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  JARVIS_MARK,
  activeJarvis,
  agendaOf,
  composeBrief,
  cpuPct,
  deliveryFor,
  eventsToday,
  fmtRate,
  fmtUptime,
  greeting,
  isJarvisSession,
  jarvisQuestion,
  jarvisTask,
  localIntent,
  netRate,
  wakeCommand,
} from './jarvis.ts'

test('wake word: ignored without it, armed by it alone, command after it', () => {
  assert.equal(wakeCommand('what is the weather'), null)
  assert.equal(wakeCommand('jarvisson is a name'), null, 'a word merely starting with jarvis is not the wake word')
  assert.equal(wakeCommand('Jarvis'), '')
  assert.equal(wakeCommand('hey Jarvis.'), '')
  assert.equal(wakeCommand('Jarvis, what is on my list today?'), 'what is on my list today?')
  assert.equal(wakeCommand('ok jarvis   brief me'), 'brief me')
  assert.equal(wakeCommand('Hallo Jarvis, was steht heute an'), 'was steht heute an')
})

test('Jarvis chats are knowledge chats marked in their task; the live one is continued', () => {
  const task = jarvisTask('  status report ')
  assert.ok(task.startsWith(`${JARVIS_MARK} status report`))
  assert.equal(jarvisQuestion(task), 'status report')
  assert.equal(jarvisQuestion(`You are a knowledge agent…\n\nQuestion:\n${task}`), 'status report', 'found inside the chat preamble')
  assert.equal(jarvisQuestion('a follow-up'), 'a follow-up')
  assert.equal(isJarvisSession({ kind: 'knowledge', task }), true)
  assert.equal(isJarvisSession({ kind: 'dev', task }), false)
  assert.equal(isJarvisSession({ kind: 'knowledge', task: 'plain atlas chat' }), false)

  const sessions = [
    { id: 'x', kind: 'knowledge', task: 'other', status: 'idle' },
    { id: 'old', kind: 'knowledge', task, status: 'done' },
    { id: 'closing', kind: 'knowledge', task, status: 'idle', closing: true },
    { id: 'live', kind: 'knowledge', task, status: 'running' },
  ]
  assert.equal(activeJarvis(sessions)?.id, 'live')
  assert.equal(activeJarvis(sessions.slice(0, 3)), null)
})

test('delivery: spawn with no chat, queue while it works, never type into a menu', () => {
  assert.equal(deliveryFor(null), 'spawn')
  assert.equal(deliveryFor({ status: 'running' }), 'queue')
  assert.equal(deliveryFor({ status: 'idle', menu: true }), 'blocked')
  assert.equal(deliveryFor({ status: 'idle', menu: false }), 'prompt')
})

test('greeting and uptime', () => {
  assert.equal(greeting(7), 'Good morning')
  assert.equal(greeting(12), 'Good afternoon')
  assert.equal(greeting(19), 'Good evening')
  assert.equal(greeting(2), 'Working late')
  assert.equal(fmtUptime(59), '0m')
  assert.equal(fmtUptime(3 * 3600 + 5 * 60), '3h 5m')
  assert.equal(fmtUptime(2 * 86400 + 4 * 3600), '2d 4h')
})

test('network rate: diff of counters, null on first sample or counter reset', () => {
  const a = { at: 0, rxBytes: 1000, txBytes: 500 }
  const b = { at: 10_000, rxBytes: 21_000, txBytes: 2_500 }
  assert.deepEqual(netRate(a, b), { rxBps: 2000, txBps: 200 })
  assert.equal(netRate(null, b), null)
  assert.equal(netRate(b, a), null, 'time went backwards')
  assert.equal(netRate(b, { at: 20_000, rxBytes: 10, txBytes: 10 }), null, 'counters reset')
  assert.equal(fmtRate(512), '512 B/s')
  assert.equal(fmtRate(2048), '2 kB/s')
  assert.equal(fmtRate(3 * 1024 * 1024), '3.0 MB/s')
})

test('cpu percent reads load against cores and caps at 100', () => {
  assert.equal(cpuPct({ load1: 2, cpus: 4 }), 50)
  assert.equal(cpuPct({ load1: 9, cpus: 4 }), 100)
  assert.equal(cpuPct({ cpus: 4 }), null)
  assert.equal(cpuPct(null), null)
})

const task = (over) => ({ path: 'Tasks/x.md', title: 'x', status: 'next', priority: null, due: null, ...over })

test('agenda: open tasks only, overdue / today by local date, high priority first', () => {
  const tasks = [
    task({ title: 'late low', due: '2026-09-10', priority: 'low' }),
    task({ title: 'late high', due: '2026-09-12', priority: 'high' }),
    task({ title: 'today', due: '2026-09-17', status: 'doing' }),
    task({ title: 'done late', due: '2026-09-01', status: 'done' }),
    task({ title: 'later', due: '2026-09-30' }),
  ]
  const a = agendaOf(tasks, '2026-09-17')
  assert.deepEqual(a.overdue.map((t) => t.title), ['late high', 'late low'])
  assert.deepEqual(a.dueToday.map((t) => t.title), ['today'])
  assert.deepEqual(a.doing.map((t) => t.title), ['today'])
  assert.equal(a.next.length, 3)
})

test('events today include multi-day spans and exclude other days', () => {
  const ev = [
    { id: '1', title: 'b', start: '2026-09-17T15:00', end: '2026-09-17T16:00', allDay: false },
    { id: '2', title: 'a', start: '2026-09-16', end: '2026-09-18', allDay: true },
    { id: '3', title: 'c', start: '2026-09-18T09:00', end: '2026-09-18T10:00', allDay: false },
  ]
  assert.deepEqual(eventsToday(ev, '2026-09-17').map((e) => e.title), ['a', 'b'])
})

test('brief: built only from readings present — missing sections are skipped, not guessed', () => {
  const now = new Date(2026, 8, 17, 8, 5)
  const bare = composeBrief({ now })
  assert.equal(bare, 'Good morning. It is 08:05.')
  assert.ok(!/degrees|agents|memory|headline/i.test(bare))

  const full = composeBrief({
    now,
    name: 'Tony',
    weather: { ok: true, tempC: 14.4, summary: 'Overcast', highC: 19.6, lowC: 9.8, label: 'Home' },
    agenda: agendaOf([task({ title: 'Ship it', due: '2026-09-16' }), task({ title: 'Work', status: 'doing' })], '2026-09-17'),
    agents: [{ status: 'running' }, { status: 'idle' }, { status: 'running', kind: 'atlas-pass' }],
    host: { ok: true, mem: { pct: 44.9 }, swap: null, load1: 1, cpus: 4 },
    news: [{ title: 'Something happened' }],
  })
  assert.match(full, /^Good morning, Tony\. It is 08:05\./)
  assert.match(full, /In Home it is 14 degrees, overcast, between 10 and 20 today\./)
  assert.match(full, /1 task in progress, 1 overdue/)
  assert.match(full, /Top of the pile: Ship it\./)
  assert.match(full, /Agents: 1 working, 1 idle\./, 'background Atlas passes are not counted')
  assert.match(full, /45 percent memory and 25 percent CPU load/)
  assert.match(full, /Latest headline: Something happened\.$/)

  const noWeather = composeBrief({ now, weather: { ok: false } })
  assert.ok(!/degrees/.test(noWeather), 'a failed weather read is not spoken')
})

test('local intents: brief and stop are answered by the tab, anything else goes to the agent', () => {
  assert.equal(localIntent('Brief me.'), 'brief')
  assert.equal(localIntent('status report'), 'brief')
  assert.equal(localIntent('Stop!'), 'stop')
  assert.equal(localIntent('brief me on the flight search project'), null, 'a real question is not swallowed')
  assert.equal(localIntent('stop the deploy agent'), null)
})

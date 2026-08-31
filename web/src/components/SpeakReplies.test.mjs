/* ------------------------------------------------------------------ *
 * SpeakReplies — the header "read replies aloud" toggle must be RUNTIME-gated
 * on the `voice` addon exactly like the Voice card: on a box without the addon
 * it renders nothing and costs no request (docs/ADDONS.md). Same reason
 * MicField has its own gate test — and the same constraint that the web suite
 * runs on `node --test` with no DOM, so this is asserted structurally against
 * the source.
 * Run: node --test web/src/components/SpeakReplies.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const src = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'SpeakReplies.tsx'),
  'utf-8',
)

test('the addon gate is the first thing SpeakReplies does, and the gated-off path renders nothing', () => {
  const body = src.slice(src.indexOf('export function SpeakReplies('))
  const gate = body.indexOf("addons.enabled('voice')")
  const firstReturn = body.indexOf('return ')
  assert.ok(gate !== -1, 'it asks GET /api/addons whether THIS box runs the voice addon')
  assert.ok(gate < firstReturn, 'the gate precedes any render')
  assert.match(body, /addons\.ready\s*&&/, 'an unanswered /api/addons counts as not-enabled, so nothing flickers')
  assert.match(body.slice(firstReturn), /^return null/, 'the gated-off path renders nothing')
})

test('turning it ON primes audio from the click (the iOS gesture); OFF stops audio', () => {
  assert.match(src, /if \(next\) primeAudio\(\)/, 'the toggle-on handler is the user gesture that unlocks mobile audio')
  assert.match(src, /else stopAll\(\)/, 'off means silent immediately')
})

test('nothing here summarises the reply — no model call', () => {
  assert.doesNotMatch(src, /claude|summari|recap/i)
})

/* ------------------------------------------------------------------ *
 * The DE/EN stopword vote that routes ATLAS_VOICE_TTS_CMD="…tts_bilingual.py"
 * between Kokoro (English) and piper (German) — engines/lang_detect.py.
 *
 * This is the one piece of the kokoro/piper pairing where a wrong answer is
 * silent and wrong in a specific way: German text picked as English would come
 * back read by an English voice mangling German phonemes, and vice versa. So
 * it gets a real test even though it's plain Python, not JS — invoked via
 * python3 exactly as tts_bilingual.py imports it, no kokoro/piper installed.
 *
 * Run: node --test addons/voice/test/lang-detect.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ENGINES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engines')

function pick(text) {
  const out = execFileSync(
    'python3',
    ['-c', 'import sys; from lang_detect import pick; print(pick(sys.argv[1]))', text],
    { cwd: ENGINES_DIR, encoding: 'utf-8' },
  )
  return out.trim()
}

test('plain English sentences pick en', () => {
  assert.equal(pick('Agent seven finished its task and merged the pull request.'), 'en')
  assert.equal(pick('The build is green and the fleet is idle.'), 'en')
})

test('plain German sentences pick de', () => {
  assert.equal(pick('Der Agent hat die Aufgabe erledigt und den Pull Request zusammengeführt.'), 'de')
  assert.equal(pick('Das ist ein Test.'), 'de')
})

test('umlauts/eszett are a strong German signal even with no stopword', () => {
  // The case the live wrapper's docstring calls out by name: short input with
  // no stopword at all, where the vote alone would tie at 0-0.
  assert.equal(pick('Zahnarzttermine prüfen'), 'de')
  assert.equal(pick('Straße'), 'de')
})

test('a tie (including empty input) falls back to German, the vault default', () => {
  assert.equal(pick(''), 'de')
  assert.equal(pick('Agent Seven'), 'de') // no stopwords, no umlauts, no signal either way
})

test('punctuation around a stopword still counts', () => {
  assert.equal(pick('Done. The task is done, and the build is green.'), 'en')
})

test('a short English question with common short stopwords', () => {
  assert.equal(pick('What is the status now?'), 'en')
})

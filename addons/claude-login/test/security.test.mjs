/* ------------------------------------------------------------------ *
 * addons/claude-login — security.mjs: a code (or a bearer token) must never
 * survive into a log line, a stored state file, or an HTTP response. This
 * pins the one primitive every other module in this addon relies on for that.
 * Run: node --test addons/claude-login/test/security.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CODE_RE, extractCode, looksLikeCode, redact } from '../api/security.mjs'

const CODE = 'aAbBcCdDeEfFgGhHiIjJ#1234567890ab'

test('CODE_RE matches the exact shape claude auth login prints', () => {
  assert.ok(looksLikeCode(`the code is ${CODE}`))
  assert.ok(!looksLikeCode('just some ordinary sentence #with a hash'))
  assert.ok(!looksLikeCode('short#tooshort'))
})

test('looksLikeCode is NOT confused by the shared regex being stateful (two calls in a row)', () => {
  // CODE_RE is 'g'-flagged and shared across the module; a naive .test() twice
  // in a row would silently miss the match on the second call via lastIndex.
  assert.ok(looksLikeCode(CODE))
  assert.ok(looksLikeCode(CODE))
  assert.ok(looksLikeCode(CODE))
})

test('extractCode returns the code-shaped substring, or null', () => {
  assert.equal(extractCode(`please paste: ${CODE} thanks`), CODE)
  assert.equal(extractCode('nothing here'), null)
})

test('redact strips a code-shaped substring out of free text', () => {
  const msg = `tmux pane said: logged in with code ${CODE} at the prompt`
  const r = redact(msg)
  assert.ok(!r.includes(CODE))
  assert.ok(r.includes('[redacted]'))
})

test('redact strips a bearer token', () => {
  const r = redact('curl failed: Authorization: Bearer abc123SECRET was rejected')
  assert.ok(!r.includes('abc123SECRET'))
  assert.ok(r.includes('Bearer [redacted]'))
})

test('redact is a no-op on ordinary text and never throws on odd input', () => {
  assert.equal(redact('all fine here'), 'all fine here')
  assert.equal(redact(null), '')
  assert.equal(redact(undefined), '')
  assert.equal(redact(42), '42')
})

test('CODE_RE.lastIndex does not leak state between unrelated calls', () => {
  // Exercising redact (which uses .replace, which resets lastIndex internally)
  // must not leave CODE_RE in a state where the NEXT looksLikeCode call on a
  // DIFFERENT string starting position misses a real code.
  redact(`noise ${CODE} more noise`)
  assert.ok(looksLikeCode(CODE))
})

/* ------------------------------------------------------------------ *
 * addons/claude-login — auth-failures.mjs: detecting a BROKEN login from
 * ~/.claude/projects/<id>/<session>.jsonl transcripts.
 *
 * Pins the task's own requirement: a failure line is only "fresh" when it is
 * newer than `since` — the caller (renew.mjs's checkOnce) passes
 * max(now - window, credentials mtime), so a failure from BEFORE the last
 * successful renewal can never re-trigger one. Real temp files on disk (this
 * module reads real file tails), no network.
 * Run: node --test addons/claude-login/test/auth-failures.test.mjs
 * ------------------------------------------------------------------ */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { latestAuthFailureSince, listTranscripts, readTail } from '../api/auth-failures.mjs'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-login-authfail-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

function writeTranscript(root, name, lines, { mtimeMs } = {}) {
  const dir = path.join(root, 'proj-' + Math.random().toString(36).slice(2))
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  if (mtimeMs != null) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000)
  return file
}

const failLine = (timestamp) => ({ type: 'user', error: 'authentication_failed', timestamp })
const okLine = (timestamp) => ({ type: 'assistant', timestamp, message: { content: 'hi' } })

test('listTranscripts finds every <dir>/*/*.jsonl, skips non-jsonl files', () => {
  const root = fs.mkdtempSync(path.join(TMP, 'list-'))
  fs.mkdirSync(path.join(root, 'a'))
  fs.mkdirSync(path.join(root, 'b'))
  fs.writeFileSync(path.join(root, 'a', 'one.jsonl'), '')
  fs.writeFileSync(path.join(root, 'a', 'ignored.txt'), '')
  fs.writeFileSync(path.join(root, 'b', 'two.jsonl'), '')
  const files = listTranscripts(root).sort()
  assert.deepEqual(files, [path.join(root, 'a', 'one.jsonl'), path.join(root, 'b', 'two.jsonl')])
})

test('listTranscripts on a missing projects dir returns [], never throws', () => {
  assert.deepEqual(listTranscripts(path.join(TMP, 'does-not-exist')), [])
})

test('finds a fresh authentication_failed line at or after `since`', () => {
  const root = fs.mkdtempSync(path.join(TMP, 'fresh-'))
  const ts = Date.now()
  writeTranscript(root, 's.jsonl', [okLine(new Date(ts - 5000).toISOString()), failLine(new Date(ts).toISOString())], { mtimeMs: ts })
  const found = latestAuthFailureSince(ts - 60_000, { projectsDir: root })
  assert.equal(found, ts)
})

test('a failure BEFORE `since` (the last renewal) is never surfaced', () => {
  const root = fs.mkdtempSync(path.join(TMP, 'old-'))
  const ts = Date.now() - 1_000_000
  writeTranscript(root, 's.jsonl', [failLine(new Date(ts).toISOString())], { mtimeMs: ts })
  const found = latestAuthFailureSince(Date.now() - 60_000, { projectsDir: root })
  assert.equal(found, null)
})

test('a transcript file older than `since` is skipped WITHOUT even being read (mtime short-circuit)', () => {
  const root = fs.mkdtempSync(path.join(TMP, 'skip-mtime-'))
  const ts = Date.now()
  const file = writeTranscript(root, 's.jsonl', [failLine(new Date(ts).toISOString())], { mtimeMs: ts - 1_000_000 })
  const found = latestAuthFailureSince(ts - 1000, { projectsDir: root, readTail: () => { throw new Error('must not read this file') } })
  assert.equal(found, null)
  assert.ok(fs.existsSync(file))
})

test('no failures at all → null, never throws', () => {
  const root = fs.mkdtempSync(path.join(TMP, 'clean-'))
  writeTranscript(root, 's.jsonl', [okLine(new Date().toISOString())], { mtimeMs: Date.now() })
  assert.equal(latestAuthFailureSince(Date.now() - 60_000, { projectsDir: root }), null)
})

test('a malformed line at the tail (half-written) is skipped, not fatal', () => {
  const root = fs.mkdtempSync(path.join(TMP, 'malformed-'))
  const dir = path.join(root, 'proj')
  fs.mkdirSync(dir, { recursive: true })
  const ts = Date.now()
  const file = path.join(dir, 's.jsonl')
  fs.writeFileSync(file, `${JSON.stringify(failLine(new Date(ts).toISOString()))}\n{"error":"authentication_failed", not valid json`)
  fs.utimesSync(file, ts / 1000, ts / 1000)
  assert.equal(latestAuthFailureSince(ts - 60_000, { projectsDir: root }), ts)
})

test('readTail reads only the last N bytes of a large file', () => {
  const file = path.join(TMP, 'tail.txt')
  fs.writeFileSync(file, 'A'.repeat(1000) + 'TAIL-MARKER')
  const tail = readTail(file, 20)
  assert.ok(tail.includes('TAIL-MARKER'))
  assert.ok(tail.length <= 20)
})

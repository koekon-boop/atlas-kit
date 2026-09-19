/* ------------------------------------------------------------------ *
 * The resident Kokoro daemon + its thin client — kokoro_daemon.py and
 * kokoro_client.py, driven exactly as tts_bilingual.py drives them: one
 * text-in/WAV-out call at a time over a Unix socket.
 *
 * Hermetic like this addon's other engine tests: `tts_kokoro.py` is replaced
 * with a stub (no kokoro-onnx, no model, no network) that proves the WIRING —
 * daemon autostart, warm reuse, idle self-eviction, auto-recovery after that
 * eviction, the ATLAS_VOICE_KOKORO_DAEMON=0 bypass, and that a real
 * synthesis error from a live daemon is reported rather than swallowed as a
 * "daemon unreachable" degrade. The real Kokoro engine is exercised for real
 * by `install.sh --engine kokoro` (see README.md, "Kokoro daemon").
 *
 * Every test kills its own daemon by `pkill -f <its temp dir>` before
 * cleaning up — the temp dir is a fresh mkdtemp path per test, so this can't
 * catch another test's (or another process's) daemon.
 *
 * Run: node --test addons/voice/test/kokoro-daemon.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const ENGINES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engines')

// No kokoro-onnx, no model, no network — proves the client/daemon wiring,
// not the real engine (that's lang-detect.test.mjs's sibling concern and
// install.sh's own synth-before-you-configure check).
const STUB_TTS_KOKORO = `
import os

def state_dir():
    return os.environ.get("ATLAS_VOICE_DIR", "/tmp")

def synth(text):
    if os.environ.get("KOKORO_STUB_FAIL"):
        raise RuntimeError("stub synthesis failure")
    calls = os.environ.get("KOKORO_STUB_CALLS_FILE")
    if calls:
        with open(calls, "a") as f:
            f.write(text + "\\n")
    return ("WAV:" + text).encode("utf-8")
`

function stageEngine() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-kokoro-test-'))
  for (const f of ['kokoro_daemon.py', 'kokoro_client.py']) {
    fs.copyFileSync(path.join(ENGINES_DIR, f), path.join(dir, f))
  }
  fs.writeFileSync(path.join(dir, 'tts_kokoro.py'), STUB_TTS_KOKORO)
  return dir
}

function synthOnce(dir, text, env) {
  return execFileSync(
    'python3',
    ['-c', 'import sys; import kokoro_client; sys.stdout.buffer.write(kokoro_client.synth(sys.argv[1]))', text],
    { cwd: dir, env: { ...process.env, ...env } },
  )
}

/** Kill this test's own daemon (matched by its unique staged dir in argv) and
 * remove every temp path this test created — run in every test's `finally`. */
function cleanup(...dirs) {
  for (const d of dirs) {
    try {
      execFileSync('pkill', ['-f', d])
    } catch {
      /* already gone — pkill exits non-zero when nothing matched */
    }
  }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
}

async function waitFor(fn, timeoutMs = 4000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return true
    await sleep(stepMs)
  }
  return fn()
}

test('the first call starts the daemon; a second call reuses it warm', async () => {
  const dir = stageEngine()
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-kokoro-state-'))
  const sock = path.join(state, 'kokoro.sock')
  const calls = path.join(state, 'calls.txt')
  const env = { ATLAS_VOICE_DIR: state, ATLAS_VOICE_KOKORO_SOCK: sock, KOKORO_STUB_CALLS_FILE: calls, ATLAS_VOICE_KOKORO_IDLE_MS: '5000' }
  try {
    const out1 = synthOnce(dir, 'hello one', env)
    assert.equal(out1.toString('utf-8'), 'WAV:hello one')
    assert.ok(fs.existsSync(sock), 'the daemon socket should exist after the first call')

    const out2 = synthOnce(dir, 'hello two', env)
    assert.equal(out2.toString('utf-8'), 'WAV:hello two')

    // Both calls landed on the SAME resident process — the whole point.
    const lines = fs.readFileSync(calls, 'utf-8').trim().split('\n')
    assert.deepEqual(lines, ['hello one', 'hello two'])
  } finally {
    cleanup(dir, state)
  }
})

test('ATLAS_VOICE_KOKORO_DAEMON=0 never starts a daemon at all', async () => {
  const dir = stageEngine()
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-kokoro-state-'))
  const sock = path.join(state, 'kokoro.sock')
  const env = { ATLAS_VOICE_DIR: state, ATLAS_VOICE_KOKORO_SOCK: sock, ATLAS_VOICE_KOKORO_DAEMON: '0' }
  try {
    const out = synthOnce(dir, 'no daemon please', env)
    assert.equal(out.toString('utf-8'), 'WAV:no daemon please')
    assert.ok(!fs.existsSync(sock), 'no socket should be created — this is the old spawn-per-call fallback')
  } finally {
    cleanup(dir, state)
  }
})

test('the daemon evicts itself after the idle timeout, and the next call transparently restarts it', async () => {
  const dir = stageEngine()
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-kokoro-state-'))
  const sock = path.join(state, 'kokoro.sock')
  const env = { ATLAS_VOICE_DIR: state, ATLAS_VOICE_KOKORO_SOCK: sock, ATLAS_VOICE_KOKORO_IDLE_MS: '300' }
  try {
    synthOnce(dir, 'first', env)
    assert.ok(fs.existsSync(sock))

    const evicted = await waitFor(() => !fs.existsSync(sock))
    assert.ok(evicted, 'the daemon should remove its own socket once idle past ATLAS_VOICE_KOKORO_IDLE_MS')

    // Auto-recovery: the wrapper starts a fresh daemon rather than erroring.
    const out = synthOnce(dir, 'after restart', env)
    assert.equal(out.toString('utf-8'), 'WAV:after restart')
    assert.ok(fs.existsSync(sock), 'a later call should transparently restart the daemon')
  } finally {
    cleanup(dir, state)
  }
})

test('a synthesis error from a live daemon propagates — not swallowed as a connectivity failure', async () => {
  const dir = stageEngine()
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-kokoro-state-'))
  const sock = path.join(state, 'kokoro.sock')
  const env = { ATLAS_VOICE_DIR: state, ATLAS_VOICE_KOKORO_SOCK: sock, ATLAS_VOICE_KOKORO_IDLE_MS: '5000', KOKORO_STUB_FAIL: '1' }
  try {
    assert.throws(() => synthOnce(dir, 'will fail', env))
  } finally {
    cleanup(dir, state)
  }
})

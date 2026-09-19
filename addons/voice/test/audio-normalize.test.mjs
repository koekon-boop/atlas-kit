/* ------------------------------------------------------------------ *
 * The peak-normalization step both `tts_bilingual.py` legs pass their WAV
 * bytes through before stdout — engines/audio_normalize.py. Piper and Kokoro
 * synthesize at measurably different natural loudness (see README.md's
 * "Loudness" section for the real numbers), and this is the one place that
 * gets fixed for both at once.
 *
 * Invoked via python3 exactly like lang-detect.test.mjs does for
 * lang_detect.py — plain stdlib Python (`wave` + `array`), no kokoro/piper
 * installed, so this is hermetic and CI-safe.
 * Run: node --test addons/voice/test/audio-normalize.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ENGINES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engines')

// Builds a synthetic mono 440 Hz sine WAV at a chosen peak amplitude, runs it
// through normalize_wav(), and prints whatever the requested `mode` needs to
// assert on — same shape as lang-detect.test.mjs's inline helper.
const HELPER = `
import io, math, struct, sys, wave
from audio_normalize import normalize_wav

def make_wav(peak_amp, n=4410, sr=22050, nchan=1, sampwidth=2):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(nchan)
        w.setsampwidth(sampwidth)
        w.setframerate(sr)
        if sampwidth == 1:
            frame = bytes([128 + int(127 * math.sin(2 * math.pi * 440 * i / sr)) for i in range(n)])
            w.writeframes(frame)
        else:
            vals = []
            for i in range(n):
                v = int(peak_amp * math.sin(2 * math.pi * 440 * i / sr))
                vals += [v] * nchan
            w.writeframes(struct.pack("<%dh" % len(vals), *vals))
    return buf.getvalue()

def peak_dbfs(data):
    with wave.open(io.BytesIO(data), "rb") as w:
        if w.getsampwidth() != 2:
            return None
        frames = w.readframes(w.getnframes())
    import array
    a = array.array("h")
    a.frombytes(frames)
    peak = max(max(a, default=0), -min(a, default=0))
    return 20 * math.log10(peak / 32768) if peak > 0 else float("-inf")

mode = sys.argv[1]

if mode == "silence":
    data = make_wav(0)
    out = normalize_wav(data)
    print(peak_dbfs(out), out == data)
elif mode == "quiet":
    data = make_wav(int(32768 * 10 ** (-40 / 20)))
    out = normalize_wav(data)
    print(peak_dbfs(out))
elif mode == "near-floor":
    data = make_wav(int(32768 * 10 ** (-55 / 20)))
    out = normalize_wav(data)
    print(out == data)
elif mode == "loud":
    data = make_wav(int(32768 * 10 ** (-0.1 / 20)))
    out = normalize_wav(data)
    print(peak_dbfs(out))
elif mode == "full-scale":
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(22050)
        w.writeframes(struct.pack("<4h", 32767, -32768, 32767, -32768))
    data = buf.getvalue()
    out = normalize_wav(data)
    print(peak_dbfs(out))
elif mode == "params-preserved":
    data = make_wav(1000, sr=24000, nchan=2)
    out = normalize_wav(data)
    with wave.open(io.BytesIO(data)) as w1, wave.open(io.BytesIO(out)) as w2:
        print(w1.getparams()[:4] == w2.getparams()[:4])
elif mode == "unsupported-width":
    data = make_wav(0, sampwidth=1)
    out = normalize_wav(data)
    print(out == data)
elif mode == "not-a-wav":
    data = b"not a wav file at all"
    out = normalize_wav(data)
    print(out == data)
`

function run(mode) {
  return execFileSync('python3', ['-c', HELPER, mode], { cwd: ENGINES_DIR, encoding: 'utf-8' }).trim()
}

test('true digital silence stays silence — never divides by ~zero', () => {
  const [dbfs, unchanged] = run('silence').split(' ')
  assert.equal(dbfs, '-inf')
  assert.equal(unchanged, 'True')
})

test('a quiet-but-audible clip is boosted toward the target, capped by the max gain', () => {
  const dbfs = parseFloat(run('quiet'))
  // -40 dBFS in, target is -2 dBFS, but MAX_GAIN_DB=24 caps the boost short of that.
  assert.ok(dbfs > -20, `expected a real boost, got ${dbfs} dBFS`)
  assert.ok(dbfs < -14, `expected the gain cap to hold it back from the target, got ${dbfs} dBFS`)
})

test('near-silent input (below the floor) is left alone, not amplified into noise', () => {
  assert.equal(run('near-floor'), 'True')
})

test('already-loud input is brought down to the target, never left clipping', () => {
  const dbfs = parseFloat(run('loud'))
  assert.ok(dbfs <= 0, `must not clip, got ${dbfs} dBFS`)
  assert.ok(Math.abs(dbfs - -2) < 0.5, `expected ~-2 dBFS target, got ${dbfs} dBFS`)
})

test('a clip already touching full scale is pulled back under the target, not left at 0 dBFS', () => {
  const dbfs = parseFloat(run('full-scale'))
  assert.ok(dbfs <= 0, `must not clip, got ${dbfs} dBFS`)
  assert.ok(Math.abs(dbfs - -2) < 0.5, `expected ~-2 dBFS target, got ${dbfs} dBFS`)
})

test('channel count, sample rate and sample width survive a normalize round-trip', () => {
  assert.equal(run('params-preserved'), 'True')
})

test('a sample width normalize_wav does not understand comes back unchanged, not crashed', () => {
  assert.equal(run('unsupported-width'), 'True')
})

test('non-WAV input comes back unchanged rather than raising', () => {
  assert.equal(run('not-a-wav'), 'True')
})

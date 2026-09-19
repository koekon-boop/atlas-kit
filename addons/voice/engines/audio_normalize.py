#!/usr/bin/env python3
"""Peak-normalize 16-bit PCM WAV audio to a consistent loudness — the shared
last step both `tts_bilingual.py` legs go through before their WAV bytes hit
stdout, because piper and Kokoro synthesize at measurably different natural
levels (see addons/voice/README.md's "Loudness" section for the numbers).

Pure stdlib (`wave` + `array`), on purpose:
- `audioop` was removed in Python 3.13, and this module runs inside whichever
  venv `install.sh --engine kokoro`/`--engine piper` created with whatever
  `python3` was on the box at install time — no guarantee it stays <3.13.
- `numpy` happens to be present in the kokoro venv (a transitive dependency
  of onnxruntime), but that's an implementation detail of one engine's venv,
  not something this repo declares or controls, so it isn't "already a
  dependency" in the sense that matters here.

Peak normalization, not RMS/LUFS: measured on real piper/Kokoro output for a
representative sentence in each language, both engines' crest factor (peak
minus RMS) landed within ~2 dB of each other (~15 dB for piper, ~14 dB for
Kokoro) — normal, continuous speech, no rogue clicks or long silence padding
that would make peak a bad proxy for perceived loudness here. Matching peaks
therefore comes close to matching RMS too, for a fraction of the complexity
(and CPU) an LUFS/ITU-R BS.1770 implementation would cost — see the
latency budget in README.md.
"""
import array
import io
import math
import sys
import wave

FULL_SCALE = 32768.0
TARGET_DBFS = -2.0          # normalize peak to here — headroom against clipping
                             # and against inter-sample peaks after playback DACs
SILENCE_FLOOR_DBFS = -50.0  # quieter than this: leave it, don't amplify noise
MAX_GAIN_DB = 24.0          # hard cap either direction, even if the target asks for more
MIN_GAIN_CHANGE_DB = 0.05   # skip the re-encode if there's nothing worth doing


def _dbfs(amplitude):
    if amplitude <= 0:
        return float("-inf")
    return 20 * math.log10(amplitude / FULL_SCALE)


def normalize_wav(data, target_dbfs=TARGET_DBFS):
    """16-bit PCM WAV bytes -> loudness-normalized 16-bit PCM WAV bytes.

    Never raises and never returns something worse than `data`: anything this
    can't confidently handle (not a WAV, not 16-bit PCM, silent, already at
    the target, or already loud enough that "normalizing" would mean almost
    no change) comes back unchanged.
    """
    try:
        with wave.open(io.BytesIO(data), "rb") as w:
            if w.getsampwidth() != 2 or w.getcomptype() != "NONE":
                return data
            params = w.getparams()
            frames = w.readframes(w.getnframes())
    except (wave.Error, EOFError):
        return data

    if not frames:
        return data

    samples = array.array("h")
    samples.frombytes(frames)
    if sys.byteorder == "big":
        samples.byteswap()  # WAV PCM is little-endian; array uses native order

    peak = max(max(samples, default=0), -min(samples, default=0))
    peak_dbfs = _dbfs(peak)
    if peak_dbfs <= SILENCE_FLOOR_DBFS:
        # Near-silent (or exact digital silence): there's no real signal to
        # find the loudness of, and boosting it would mostly raise the noise
        # floor — the "divide by ~zero" case the whole safety margin is for.
        return data

    gain_db = max(-MAX_GAIN_DB, min(MAX_GAIN_DB, target_dbfs - peak_dbfs))
    if abs(gain_db) < MIN_GAIN_CHANGE_DB:
        return data

    gain = 10 ** (gain_db / 20)
    lo, hi = -32768, 32767
    for i, s in enumerate(samples):
        v = int(s * gain)
        samples[i] = hi if v > hi else lo if v < lo else v

    if sys.byteorder == "big":
        samples.byteswap()

    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setparams(params)
        w.writeframes(samples.tobytes())
    return out.getvalue()

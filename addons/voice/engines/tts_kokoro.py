#!/usr/bin/env python3
"""English-only Kokoro-82M TTS engine — TEXT on stdin, WAV on stdout.

Installed and wired in by `addons/voice/install.sh --engine kokoro`. Runs
WITHOUT a shell as `ATLAS_VOICE_TTS_CMD`, exactly like piper or espeak-ng — see
this addon's README ("On-box engines") for the contract.

Kokoro-82M (Apache 2.0, github.com/hexgrad/Kokoro-82M) is a ~82M-parameter
StyleTTS2-family model, a generation newer than piper's VITS voices and
noticeably less monotone on CPU-only hardware. It ships NO German — the voice
pack only covers American/British English plus a handful of other languages —
so this file is English-only by design; `tts_bilingual.py` pairs it with piper
for German without regressing that half.

All paths default to this addon's own state dir (`ATLAS_VOICE_DIR`, matching
`api/config.mjs`'s `engineDir()`) so a plain `--engine kokoro` install needs no
further configuration, but every one is overridable.
"""
import io
import os
import sys


def state_dir():
    """Mirrors api/config.mjs's engineDir() so both halves agree on ATLAS_VOICE_DIR."""
    return os.environ.get("ATLAS_VOICE_DIR") or os.path.join(
        os.environ.get("AGENT_LOCAL_DIR") or os.path.expanduser("~/.atlas-kit"), "voice"
    )


def _paths():
    voice_dir = state_dir()
    model = os.environ.get("ATLAS_VOICE_KOKORO_MODEL") or os.path.join(
        voice_dir, "kokoro-models", "kokoro-v1.0.onnx"
    )
    voices = os.environ.get("ATLAS_VOICE_KOKORO_VOICES") or os.path.join(
        voice_dir, "kokoro-models", "voices-v1.0.bin"
    )
    voice = os.environ.get("ATLAS_VOICE_KOKORO_VOICE", "bm_george")
    return model, voices, voice


# Loaded once per process and reused by tts_bilingual.py's in-process import —
# a fresh subprocess per call already pays ~1s to deserialize the ONNX graph
# (measured; quantized/pre-optimized variants did not improve on that), so
# there is nothing to gain from re-loading it a second time within one call.
_kokoro = None


def synth(text):
    """`text` (already single-line — see main()) -> WAV bytes."""
    global _kokoro
    from kokoro_onnx import Kokoro
    import soundfile as sf

    model, voices, voice = _paths()
    if _kokoro is None:
        _kokoro = Kokoro(model, voices)
    lang = "en-gb" if voice.startswith("b") else "en-us"
    samples, sr = _kokoro.create(text, voice=voice, speed=1.0, lang=lang)
    buf = io.BytesIO()
    sf.write(buf, samples, sr, format="WAV")
    return buf.getvalue()


def main():
    raw = sys.stdin.read().strip()
    if not raw:
        print("tts-kokoro: empty input", file=sys.stderr)
        return 2
    # One line, always — collapsing whitespace keeps this consistent with
    # tts_bilingual.py's piper leg, which needs it to dodge piper's per-line
    # RIFF-header bug (see that file). Kokoro doesn't have that bug, but a
    # single utterance either way keeps the two legs' behavior identical.
    text = " ".join(raw.split())
    try:
        audio = synth(text)
    except Exception as e:  # noqa: BLE001 - degrade, never crash (see engine.mjs)
        print(f"tts-kokoro: synthesis failed: {e}", file=sys.stderr)
        return 4
    if not audio:
        print("tts-kokoro: produced no audio", file=sys.stderr)
        return 5
    # Only now does anything reach stdout — a partial WAV is worse than none.
    sys.stdout.buffer.write(audio)
    return 0


if __name__ == "__main__":
    sys.exit(main())

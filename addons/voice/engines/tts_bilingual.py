#!/usr/bin/env python3
"""Bilingual TTS engine — TEXT on stdin, WAV on stdout, DE/EN picked from the
text itself. Kokoro-82M (`bm_george`, a calm British male) speaks English;
piper (`de_DE-thorsten-medium`) speaks German, because Kokoro ships no German
voice at all — verified empirically, not assumed (see addons/voice/README.md).

Installed and wired in by `addons/voice/install.sh --engine kokoro`, which
installs both halves and prints this file's path as `ATLAS_VOICE_TTS_CMD`. Runs
WITHOUT a shell (plain argv), same contract as every other on-box engine.

All paths default to this addon's own state dir, exactly like tts_kokoro.py.
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tts_kokoro  # noqa: E402
from lang_detect import pick  # noqa: E402


def _piper_paths():
    voice_dir = tts_kokoro.state_dir()
    piper_bin = os.environ.get("ATLAS_VOICE_PIPER_BIN") or os.path.join(voice_dir, "piper", "bin", "piper")
    voice_de = os.environ.get("ATLAS_VOICE_PIPER_VOICE_DE") or os.path.join(
        voice_dir, "voices", "de_DE-thorsten-medium.onnx"
    )
    return piper_bin, voice_de


def synth_de(text):
    piper_bin, voice_de = _piper_paths()
    r = subprocess.run(
        [piper_bin, "-m", voice_de, "-f", "-"],
        input=text.encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if r.returncode != 0 or not r.stdout:
        raise RuntimeError(f"piper exited {r.returncode}: {r.stderr.decode('utf-8', 'replace')[:300]}")
    return r.stdout


def main():
    raw = sys.stdin.read().strip()
    if not raw:
        print("tts-bilingual: empty input", file=sys.stderr)
        return 2
    # piper treats every input LINE as its own utterance and writes a separate
    # RIFF header for each, so multi-line text comes back as concatenated WAV
    # files whose first header describes only the first block — players stop
    # there and the rest is silently lost. Collapsing to one line fixes that
    # for the German leg and changes nothing for Kokoro, which never had the bug.
    text = " ".join(raw.split())
    lang = pick(text)
    try:
        audio = tts_kokoro.synth(text) if lang == "en" else synth_de(text)
    except Exception as e:  # noqa: BLE001 - degrade, never crash (see engine.mjs)
        print(f"tts-bilingual: lang={lang} synthesis failed: {e}", file=sys.stderr)
        return 4
    if not audio:
        print(f"tts-bilingual: lang={lang} produced no audio", file=sys.stderr)
        return 5
    print(f"tts-bilingual: lang={lang}", file=sys.stderr)
    # Only now does anything reach stdout — a partial WAV is worse than none.
    sys.stdout.buffer.write(audio)
    return 0


if __name__ == "__main__":
    sys.exit(main())

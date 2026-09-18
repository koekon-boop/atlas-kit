#!/usr/bin/env bash
# install.sh --engine whisper, and the STT wrapper it generates.
#
# The wrapper is what ATLAS_VOICE_STT_CMD runs for every dictated clip, and the
# part of it that can quietly go wrong is the LANGUAGE choice: auto-detect has to
# be honoured for German and English, a mis-detection (German heard as Dutch) has
# to fall back to the operator's default instead of transcribing as Dutch, and a
# pinned language must skip the detect pass entirely. Plus --check has to tell
# "wrapper present" from "wrapper present but its model is gone".
#
# NOT covered here: a real build or a real transcription — that is a ~1 min
# compile and a 148 MB model. Measured on the box instead; see the README.
#
# Hermetic: whisper-cli and ffmpeg are shell stubs on a temp PATH (exactly the
# contract the real ones meet), the model is a dummy file, the VAD model comes
# from a file:// URL. No network, no build, no $HOME.
#
# Run: bash addons/voice/test/whisper-install.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL="$HERE/../install.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fails=0
ok()   { echo "  ok   $1"; }
bad()  { echo "  FAIL $1"; fails=$((fails + 1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }

mkdir -p "$TMP/bin" "$TMP/mirror"
# whisper-cli: `-dl` reports $STUB_LANG on stderr the way the real one does;
# otherwise it "transcribes" by echoing the language and whether VAD was on.
cat > "$TMP/bin/whisper-cli" <<'STUB'
#!/bin/sh
echo "$*" >> "$STUB_LOG"
case " $* " in
  *" -dl "*) echo "whisper_full_with_state: auto-detected language: ${STUB_LANG:-de} (p = 0.97)" >&2; exit 0 ;;
esac
lang=""; vad=no
while [ $# -gt 0 ]; do
  case "$1" in -l) lang="$2"; shift ;; --vad) vad=yes ;; esac
  shift
done
echo "transcript lang=$lang vad=$vad"
STUB
# ffmpeg: "decode" = copy the input to the last argument.
cat > "$TMP/bin/ffmpeg" <<'STUB'
#!/bin/sh
in=""; for a; do [ "$prev" = -i ] && in="$a"; prev="$a"; last="$a"; done
cp "$in" "$last"
STUB
chmod +x "$TMP/bin/whisper-cli" "$TMP/bin/ffmpeg"
echo model > "$TMP/ggml-dummy.bin"
echo vad > "$TMP/mirror/vad.bin"
echo clip > "$TMP/clip.webm"
export STUB_LOG="$TMP/calls"

W="$TMP/voice/stt-whisper.sh"
install() {
  env PATH="$TMP/bin:$PATH" AGENT_LOCAL_DIR="$TMP" ATLAS_VOICE_DIR="$TMP/voice" \
      WHISPER_MODEL="$TMP/ggml-dummy.bin" ATLAS_VOICE_WHISPER_VAD_URL="file://$TMP/mirror/vad.bin" \
      "$@" bash "$INSTALL" --engine whisper >"$TMP/out" 2>&1
  echo $?
}
# The wrapper runs with the API's environment; the stubs stand in on PATH.
wrap() { : > "$STUB_LOG"; env PATH="$TMP/bin:$PATH" "$@" "$W" "$TMP/clip.webm" 2>/dev/null; }

echo "install.sh --engine whisper"
check "an existing whisper-cli + WHISPER_MODEL → exit 0, nothing built" "$(install)" 0
[ -d "$TMP/voice/whisper.cpp" ] && bad "it cloned whisper.cpp although one was on PATH" || ok "no build when whisper-cli is on PATH"
[ -x "$W" ] && ok "the wrapper is written and executable" || bad "no executable wrapper at $W"
grep -q "ATLAS_VOICE_STT_CMD=\"$W {file}\"" "$TMP/out" && ok "prints the exact .env line" || bad "the .env line is missing from the output"
[ -s "$TMP/voice/models/ggml-silero-v6.2.0.bin" ] && ok "the VAD model is fetched" || bad "no VAD model"
check "re-running is idempotent" "$(install)" 0
check "a WHISPER_MODEL that is not a file → exit 1" "$(install WHISPER_MODEL="$TMP/nope.bin")" 1

echo "the wrapper — language"
check "auto: German detected → transcribed as German" "$(wrap STUB_LANG=de)" "transcript lang=de vad=yes"
check "auto: English detected → transcribed as English" "$(wrap STUB_LANG=en)" "transcript lang=en vad=yes"
check "auto: Dutch detected → falls back to the first allowed (de)" "$(wrap STUB_LANG=nl)" "transcript lang=de vad=yes"
check "auto: the allowed set and its fallback are configurable" "$(wrap STUB_LANG=nl ATLAS_VOICE_STT_LANGS=en,de)" "transcript lang=en vad=yes"
check "pinned: ATLAS_VOICE_STT_LANG=en wins over detection" "$(wrap STUB_LANG=de ATLAS_VOICE_STT_LANG=en)" "transcript lang=en vad=yes"
check "pinned: …and skips the detect pass" "$(grep -c -- ' -dl' "$STUB_LOG")" 0
wrap ATLAS_VOICE_STT_THREADS=3 >/dev/null
grep -q -- '-t 3 ' "$STUB_LOG" && ok "ATLAS_VOICE_STT_THREADS reaches whisper-cli" || bad "thread count not passed"
ls "${TMPDIR:-/tmp}"/atlas-kit-stt-* >/dev/null 2>&1 && bad "the temp wav outlived the call" || ok "the temp wav is deleted"
check "no clip → usage, exit 2" "$(env PATH="$TMP/bin:$PATH" "$W" >/dev/null 2>&1; echo $?)" 2

echo "the wrapper — --check, and install.sh --check through it"
check "all present → 0" "$(env PATH="$TMP/bin:$PATH" "$W" --check >/dev/null 2>&1; echo $?)" 0
chk() { env PATH="$TMP/bin:$PATH" AGENT_LOCAL_DIR="$TMP" ATLAS_VOICE_DIR="$TMP/voice" ATLAS_VOICE_TTS_CMD= ATLAS_VOICE_STT_CMD="$W {file}" bash "$INSTALL" --check >/dev/null 2>&1; echo $?; }
check "install.sh --check → 0 while the model is there" "$(chk)" 0
mv "$TMP/ggml-dummy.bin" "$TMP/moved.bin"
check "model gone → the wrapper's --check fails" "$(env PATH="$TMP/bin:$PATH" "$W" --check >/dev/null 2>&1; echo $?)" 1
check "model gone → install.sh --check says installable (2), not ok" "$(chk)" 2
mv "$TMP/moved.bin" "$TMP/ggml-dummy.bin"

echo "without a VAD model"
rm -f "$TMP/voice/models/ggml-silero-v6.2.0.bin" "$TMP/mirror/vad.bin"
check "a failed VAD download does not fail the install" "$(install)" 0
check "…and the wrapper runs without --vad" "$(wrap STUB_LANG=en)" "transcript lang=en vad=no"

echo
[ "$fails" = 0 ] && echo "all passed" || { echo "$fails FAILED"; exit 1; }

#!/usr/bin/env bash
# The kokoro/piper bilingual wiring in install.sh — detect(), the usage/error
# paths, and the German-voice URL derivation piper's own install already
# depends on. NOT covered here, deliberately: `install_kokoro`'s and
# `install_piper`'s SUCCESS paths, which need a real `pip install` (network)
# and are exercised for real by running `install.sh --engine kokoro` by hand
# (see README.md's "On-box engines" — the latency/quality numbers there came
# from exactly that run).
#
# Hermetic: its own temp AGENT_LOCAL_DIR, no network, no real kokoro/piper —
# "installed" is faked with stub executables and placeholder files, which is
# all detect() ever looks at (existence + executable bit).
#
# Run: bash addons/voice/test/install.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL="$HERE/../install.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fails=0
ok()   { echo "  ok   $1"; }
bad()  { echo "  FAIL $1"; fails=$((fails + 1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }
contains() { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1 (did not find '$3')" ;; esac; }
not_contains() { case "$2" in *"$3"*) bad "$1 (unexpectedly found '$3')" ;; *) ok "$1" ;; esac; }

run() {
  env AGENT_LOCAL_DIR="$TMP/state" "$@" bash "$INSTALL" "${INSTALL_ARGS[@]}"
}

echo "install.sh --engine <bad name>"
INSTALL_ARGS=(--engine nope)
out="$(run 2>&1)"; rc=$?
check "an unknown engine is rejected" "$rc" 2
contains "the usage line mentions kokoro" "$out" "kokoro"

echo "install.sh (bad top-level flag)"
INSTALL_ARGS=(--bogus)
out="$(run 2>&1)"; rc=$?
check "an unknown flag is rejected" "$rc" 2
contains "the top-level usage line mentions kokoro" "$out" "kokoro"

echo "detect() with nothing installed"
INSTALL_ARGS=()
out="$(run 2>&1)"
not_contains "no bilingual DETECT line when nothing is installed" "$out" "kokoro + piper (bilingual"

echo "detect() with only kokoro's half staged"
D="$TMP/state/voice"
mkdir -p "$D/kokoro/bin" "$D/kokoro-models"
printf '#!/bin/sh\n' > "$D/kokoro/bin/python3"; chmod +x "$D/kokoro/bin/python3"
echo fake-model > "$D/kokoro-models/kokoro-v1.0.onnx"
out="$(run 2>&1)"
not_contains "no bilingual DETECT line with piper's German half still missing" "$out" "kokoro + piper (bilingual"

echo "detect() with both halves staged"
mkdir -p "$D/piper/bin" "$D/voices"
printf '#!/bin/sh\n' > "$D/piper/bin/piper"; chmod +x "$D/piper/bin/piper"
echo fake-voice > "$D/voices/de_DE-thorsten-medium.onnx"
out="$(run 2>&1)"
contains "the bilingual line appears once both halves are present" "$out" "kokoro + piper (bilingual"
contains "the printed command names tts_bilingual.py" "$out" "tts_bilingual.py"
contains "the printed command uses THIS engine's own python3" "$out" "$D/kokoro/bin/python3"

echo "--check reports the bilingual command like any other engine"
INSTALL_ARGS=(--check)
out="$(run env ATLAS_VOICE_TTS_CMD="$D/kokoro/bin/python3 $HERE/../engines/tts_bilingual.py" 2>&1)"; rc=$?
check "a resolvable bilingual command passes --check" "$rc" 0
contains "--check names the resolved binary" "$out" "ATLAS_VOICE_TTS_CMD ok"

echo
if [ "$fails" = 0 ]; then echo "install.sh kokoro/bilingual wiring: all checks passed"; else echo "install.sh kokoro/bilingual wiring: $fails FAILED"; fi
exit $((fails > 0))

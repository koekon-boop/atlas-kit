#!/usr/bin/env bash
# Wire up the OPTIONAL on-box engines for the voice addon. See this directory's
# README.md — especially the cost and privacy sections.
#
# 🔴 THE ADDON NEEDS NONE OF THIS. Enable `voice` and the dashboard already
# speaks (the browser's speechSynthesis) and already listens (its Web Speech
# API): no download, no key, no server round-trip. This script exists for the two
# cases the browser cannot cover — a browser with no Web Speech API, and an
# operator who wants the audio never to leave the box.
#
# Installs (idempotent — re-running skips what is already there):
#   - $STATE_DIR/voice.env.sample     the .env lines to paste, filled in with
#                                     whatever engines this box actually has
#   --engine espeak-ng                apt-get espeak-ng (~5 MB) → TTS command
#   --engine piper                    a venv + piper-tts + one voice (~250 MB)
#   --engine kokoro                   Kokoro-82M (a newer, less monotone voice
#                                     than piper's — ~535 MB) for English, PAIRED
#                                     with piper for German (which Kokoro ships
#                                     no voice for at all) via a bilingual
#                                     stdin/stdout wrapper that picks the
#                                     language from the text. See README.md
#                                     "On-box engines" for the latency/quality
#                                     numbers that make this the pairing.
#   --engine whisper                  whisper.cpp built from a pinned tag + the
#                                     multilingual `base` model (~150 MB) and the
#                                     STT wrapper; reuses a whisper-cli on PATH
#                                     and WHISPER_MODEL when you have them
#
# WHAT IT WILL NEVER DO: edit your .env, pick your voice, or install a model you
# did not ask for by name. It prints the two lines you paste, and stops.
#
# MODES
#   (no args)  detect what is here, write the sample, install nothing
#   --engine <espeak-ng|piper|kokoro|whisper>   install/wire that one engine
#   --check    report state without changing anything:
#                exit 0 — ready (either no engine is configured, i.e. the browser
#                         default, or every configured one resolves)
#                exit 2 — a configured engine is missing, and installable now
#                exit 1 — a configured engine is missing and cannot be installed
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="${AGENT_LOCAL_DIR:-$HOME/.atlas-kit}"
DIR="${ATLAS_VOICE_DIR:-$STATE_DIR/voice}"
SAMPLE="$STATE_DIR/voice.env.sample"
PIPER_BIN="$DIR/piper/bin/piper"
VOICE_NAME="${ATLAS_VOICE_PIPER_VOICE:-en_US-amy-medium}"
VOICE_ONNX="$DIR/voices/$VOICE_NAME.onnx"

# The rhasspy/piper-voices layout is <lang>/<lang_COUNTRY>/<name>/<quality>/ —
# derived from the voice name itself so install_piper can fetch ANY voice
# (amy for the default English install, thorsten for kokoro's German half)
# without a second hardcoded URL to keep in sync.
voice_url_base() {
  local voice="$1" lang_country rest name quality
  lang_country="${voice%%-*}"
  rest="${voice#*-}"
  name="${rest%-*}"
  quality="${rest##*-}"
  echo "https://huggingface.co/rhasspy/piper-voices/resolve/main/${lang_country%%_*}/$lang_country/$name/$quality"
}
# Overridable so a mirror, an air-gapped copy or a different voice needs no patch.
VOICE_BASE="${ATLAS_VOICE_PIPER_VOICE_URL:-$(voice_url_base "$VOICE_NAME")}"
STT_WRAPPER="$DIR/stt-whisper.sh"
# whisper.cpp, pinned: a release tag, built from source because there is no
# official Linux binary. Multilingual `base` (148 MB) is the default because it
# is the largest model that answers a spoken sentence in a few seconds on a
# 4-core CPU — `small` took ~9 s for the same clip (the README's measured table).
WHISPER_TAG="${ATLAS_VOICE_WHISPER_TAG:-v1.9.4}"
WHISPER_REPO="${ATLAS_VOICE_WHISPER_REPO:-https://github.com/ggml-org/whisper.cpp}"
WHISPER_SRC="$DIR/whisper.cpp"
WHISPER_BUILT="$WHISPER_SRC/build/bin/whisper-cli"
WHISPER_JOBS="${ATLAS_VOICE_WHISPER_JOBS:-2}"
WHISPER_MODEL_NAME="${ATLAS_VOICE_WHISPER_MODEL:-base}"
WHISPER_MODEL_FILE="$DIR/models/ggml-$WHISPER_MODEL_NAME.bin"
WHISPER_MODEL_URL="${ATLAS_VOICE_WHISPER_MODEL_URL:-https://huggingface.co/ggerganov/whisper.cpp/resolve/main}"
# Silero voice-activity detection (<1 MB): without it whisper "hears" words in a
# silent clip ("you", "Thanks for watching") — with it, silence is no transcript.
WHISPER_VAD_FILE="$DIR/models/ggml-silero-v6.2.0.bin"
WHISPER_VAD_URL="${ATLAS_VOICE_WHISPER_VAD_URL:-https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin}"
MIN_AVAIL_MB=600

# Kokoro (English) + piper (German, reusing install_piper below) — the pairing
# --engine kokoro installs. bm_george is a calm British male, in the same
# register as alan was; ATLAS_VOICE_KOKORO_VOICE picks another (bm_lewis,
# bm_daniel, bm_fable, or any af_*/am_* American voice).
KOKORO_VENV="$DIR/kokoro"
KOKORO_MODEL_DIR="$DIR/kokoro-models"
KOKORO_MODEL="$KOKORO_MODEL_DIR/kokoro-v1.0.onnx"
KOKORO_VOICES="$KOKORO_MODEL_DIR/voices-v1.0.bin"
KOKORO_VOICE_NAME="${ATLAS_VOICE_KOKORO_VOICE:-bm_george}"
KOKORO_RELEASE="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
KOKORO_MODEL_URL="${ATLAS_VOICE_KOKORO_MODEL_URL:-$KOKORO_RELEASE/kokoro-v1.0.onnx}"
KOKORO_VOICES_URL="${ATLAS_VOICE_KOKORO_VOICES_URL:-$KOKORO_RELEASE/voices-v1.0.bin}"
DE_VOICE_NAME="de_DE-thorsten-medium"
DE_VOICE_ONNX="$DIR/voices/$DE_VOICE_NAME.onnx"
BILINGUAL_SCRIPT="$ROOT/addons/voice/engines/tts_bilingual.py"
# ~183 MB venv + 326 MB model + 27 MB voices, plus piper's own ~250 MB + 63 MB
# voice if that is not already installed (install_kokoro calls install_piper).
KOKORO_MIN_AVAIL_MB=1200

log() { echo "[voice] $*"; }

# The first word of a configured command — what has to be executable for the
# addon to report `available: true`. Empty when nothing is configured.
cmd_bin() { echo "${1%% *}"; }

resolves() { [ -n "$1" ] && command -v "$(cmd_bin "$1")" >/dev/null 2>&1; }

# $1 (optional): MB required — defaults to $MIN_AVAIL_MB (a piper venv + one
# voice). install_kokoro passes $KOKORO_MIN_AVAIL_MB, which also has to cover
# piper's own venv + German voice.
disk_ok() {
  local need="${1:-$MIN_AVAIL_MB}"
  mkdir -p "$DIR" 2>/dev/null || true
  local avail
  avail=$(df -Pm "$DIR" 2>/dev/null | awk 'NR==2 {print $4}')
  if [ -z "$avail" ]; then
    echo "!! cannot read free space for $DIR" >&2
    return 1
  fi
  [ "$avail" -ge "$need" ] && return 0
  echo "!! only ${avail} MB free — need ~${need} MB" >&2
  return 1
}

# What this box could speak/listen with right now, whether or not it is configured.
detect() {
  local found=""
  [ -x "$KOKORO_VENV/bin/python3" ] && [ -s "$KOKORO_MODEL" ] && [ -x "$PIPER_BIN" ] && [ -s "$DE_VOICE_ONNX" ] && \
    found="$found  kokoro + piper (bilingual, this addon):  ATLAS_VOICE_TTS_CMD=\"$KOKORO_VENV/bin/python3 $BILINGUAL_SCRIPT\"\n"
  [ -x "$PIPER_BIN" ] && [ -s "$VOICE_ONNX" ] && found="$found  piper (this addon's venv):        ATLAS_VOICE_TTS_CMD=\"$PIPER_BIN -m $VOICE_ONNX -f -\"\n"
  command -v piper >/dev/null 2>&1 && found="$found  piper (on PATH):                 ATLAS_VOICE_TTS_CMD=\"piper -m /path/to/voice.onnx -f -\"\n"
  command -v espeak-ng >/dev/null 2>&1 && found="$found  espeak-ng (robotic but tiny):    ATLAS_VOICE_TTS_CMD=\"espeak-ng --stdout\"\n"
  [ -x "$STT_WRAPPER" ] && found="$found  whisper.cpp wrapper:             ATLAS_VOICE_STT_CMD=\"$STT_WRAPPER {file}\"\n"
  printf '%b' "$found"
}

write_sample() {
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR" 2>/dev/null || true
  {
    cat <<EOF
# addons/voice — paste the lines you need into your .env, then
# \`scripts/serve.sh restart\`. Generated by install.sh on $(date -u +%Y-%m-%d).
ATLAS_ADDONS=voice

# NOTHING BELOW IS REQUIRED. With no engine configured the browser speaks and
# listens, which is the zero-install default the addon is designed around.
EOF
    local d
    d="$(detect)"
    if [ -n "$d" ]; then
      echo "#"
      echo "# Engines found on this box:"
      printf '%s' "$d" | sed 's/^/# /'
    else
      echo "#"
      echo "# No on-box engine found. Add one with:  bash addons/voice/install.sh --engine espeak-ng"
    fi
    cat <<'EOF'
#
# ATLAS_VOICE_MODEL=claude-haiku-4-5   # the model that writes a spoken recap
# ATLAS_VOICE_DAILY_BUDGET=100         # recap calls per day, across the fleet
# ATLAS_VOICE_MIN_INTERVAL_MS=60000    # …and per agent
#
# The dashboard reaches POST /api/voice/* only through the reverse proxy, which
# is where the bearer token is injected. Add this to infra/Caddyfile:
#   handle /api/voice/* {
#     reverse_proxy localhost:3001 {
#       header_up Authorization "Bearer {env.DASHBOARD_BEARER_TOKEN}"
#     }
#   }
EOF
  } > "$SAMPLE"
  chmod 600 "$SAMPLE" 2>/dev/null || true
  log "config stub → $SAMPLE"
}

install_espeak() {
  if command -v espeak-ng >/dev/null 2>&1; then
    log "espeak-ng is already installed"
  else
    command -v apt-get >/dev/null 2>&1 || {
      echo "!! no apt-get here — install espeak-ng with your own package manager" >&2
      exit 1
    }
    [ "$(id -u)" = 0 ] || {
      echo "!! needs root:  sudo bash addons/voice/install.sh --engine espeak-ng" >&2
      exit 1
    }
    apt-get update -qq && apt-get install -y -qq espeak-ng
  fi
  echo 'test' | espeak-ng --stdout > /dev/null || {
    echo "!! espeak-ng is installed but produced no audio" >&2
    exit 1
  }
  log 'ready → ATLAS_VOICE_TTS_CMD="espeak-ng --stdout"'
}

# $1 (optional): the voice to fetch — defaults to $VOICE_NAME (the standalone
# `--engine piper` case). install_kokoro calls this with $DE_VOICE_NAME to get
# piper's German half of the bilingual pairing, reusing the same venv.
install_piper() {
  local voice="${1:-$VOICE_NAME}"
  local onnx="$DIR/voices/$voice.onnx"
  local base="${ATLAS_VOICE_PIPER_VOICE_URL:-$(voice_url_base "$voice")}"
  disk_ok || exit 1
  if [ ! -x "$PIPER_BIN" ]; then
    command -v python3 >/dev/null 2>&1 || {
      echo "!! python3 is required for piper" >&2
      exit 1
    }
    log "creating a venv at $DIR/piper (~250 MB with onnxruntime)"
    python3 -m venv "$DIR/piper"
    "$DIR/piper/bin/pip" install --quiet --upgrade pip
    "$DIR/piper/bin/pip" install --quiet piper-tts
  else
    log "piper venv present → $PIPER_BIN"
  fi
  mkdir -p "$DIR/voices"
  if [ ! -s "$onnx" ]; then
    log "downloading voice $voice (~60 MB)"
    curl -fSL --retry 2 -o "$onnx" "$base/$voice.onnx" || {
      rm -f "$onnx"
      echo "!! could not download $base/$voice.onnx — set ATLAS_VOICE_PIPER_VOICE_URL to a mirror, or drop the .onnx + .onnx.json into $DIR/voices yourself" >&2
      exit 1
    }
    curl -fSL --retry 2 -o "$onnx.json" "$base/$voice.onnx.json" || {
      rm -f "$onnx" "$onnx.json"
      echo "!! the voice config did not download — removed the half-installed voice" >&2
      exit 1
    }
  else
    log "voice present → $onnx"
  fi
  # Prove it before telling the operator to configure it: a command line that
  # does not actually synthesize is worse than no command line.
  echo 'test' | "$PIPER_BIN" -m "$onnx" -f - > /dev/null 2>&1 || {
    echo "!! piper is installed but did not synthesize — see $DIR/piper" >&2
    exit 1
  }
  log "ready → ATLAS_VOICE_TTS_CMD=\"$PIPER_BIN -m $onnx -f -\""
}

# Kokoro-82M for English, paired with piper (via install_piper) for German —
# Kokoro ships no German voice at all, confirmed by actually asking it for one
# (see README.md). Installs both halves and proves the ROUTING, not just each
# engine in isolation, before handing back a single ATLAS_VOICE_TTS_CMD.
install_kokoro() {
  disk_ok "$KOKORO_MIN_AVAIL_MB" || exit 1

  if [ ! -x "$KOKORO_VENV/bin/python3" ]; then
    command -v python3 >/dev/null 2>&1 || {
      echo "!! python3 is required for kokoro" >&2
      exit 1
    }
    log "creating a venv at $KOKORO_VENV (~183 MB — onnxruntime, no torch)"
    python3 -m venv "$KOKORO_VENV"
    "$KOKORO_VENV/bin/pip" install --quiet --upgrade pip
    "$KOKORO_VENV/bin/pip" install --quiet kokoro-onnx soundfile
  else
    log "kokoro venv present → $KOKORO_VENV"
  fi

  mkdir -p "$KOKORO_MODEL_DIR"
  if [ ! -s "$KOKORO_MODEL" ]; then
    log "downloading kokoro-v1.0.onnx (~326 MB)"
    curl -fSL --retry 2 -o "$KOKORO_MODEL" "$KOKORO_MODEL_URL" || {
      rm -f "$KOKORO_MODEL"
      echo "!! could not download $KOKORO_MODEL_URL — set ATLAS_VOICE_KOKORO_MODEL_URL to a mirror, or drop the file in yourself" >&2
      exit 1
    }
  else
    log "model present → $KOKORO_MODEL"
  fi
  if [ ! -s "$KOKORO_VOICES" ]; then
    log "downloading voices-v1.0.bin (~27 MB)"
    curl -fSL --retry 2 -o "$KOKORO_VOICES" "$KOKORO_VOICES_URL" || {
      rm -f "$KOKORO_VOICES"
      echo "!! could not download $KOKORO_VOICES_URL — set ATLAS_VOICE_KOKORO_VOICES_URL to a mirror, or drop the file in yourself" >&2
      exit 1
    }
  else
    log "voices present → $KOKORO_VOICES"
  fi

  # Prove the English half before touching the German half — a command line
  # that does not actually synthesize is worse than no command line.
  local verify_log
  verify_log="$(mktemp -t atlas-kit-kokoro-verify-XXXXXX.log)"
  echo 'This is a test.' | ATLAS_VOICE_DIR="$DIR" ATLAS_VOICE_KOKORO_VOICE="$KOKORO_VOICE_NAME" \
    "$KOKORO_VENV/bin/python3" "$ROOT/addons/voice/engines/tts_kokoro.py" > /dev/null 2>"$verify_log" || {
    echo "!! kokoro is installed but did not synthesize:" >&2
    cat "$verify_log" >&2
    rm -f "$verify_log"
    exit 1
  }
  rm -f "$verify_log"

  # The German half: piper, unchanged engine, a different voice.
  install_piper "$DE_VOICE_NAME"

  # Prove the ROUTING itself, in both directions — a wrapper that resolves
  # both engines but picks the wrong one for either language is worse than
  # either engine alone, and would regress German silently.
  local en_lang de_lang
  en_lang=$(echo 'This is a test.' | ATLAS_VOICE_DIR="$DIR" ATLAS_VOICE_KOKORO_VOICE="$KOKORO_VOICE_NAME" \
    "$KOKORO_VENV/bin/python3" "$BILINGUAL_SCRIPT" 2>&1 >/dev/null | grep -o 'lang=..' | cut -d= -f2)
  de_lang=$(echo 'Das ist ein Test.' | ATLAS_VOICE_DIR="$DIR" ATLAS_VOICE_KOKORO_VOICE="$KOKORO_VOICE_NAME" \
    "$KOKORO_VENV/bin/python3" "$BILINGUAL_SCRIPT" 2>&1 >/dev/null | grep -o 'lang=..' | cut -d= -f2)
  if [ "$en_lang" != "en" ] || [ "$de_lang" != "de" ]; then
    echo "!! bilingual routing check failed (English text → lang=${en_lang:-?}, German text → lang=${de_lang:-?}) — see $BILINGUAL_SCRIPT" >&2
    exit 1
  fi

  log "ready → ATLAS_VOICE_TTS_CMD=\"$KOKORO_VENV/bin/python3 $BILINGUAL_SCRIPT\""
}

# whisper.cpp is a build, not a package: this compiles a PINNED release out of
# tree (make -j2 under nice, so a live box keeps serving) and downloads ONE
# multilingual ggml model. Both are skipped when already there, and a
# `whisper-cli` on PATH plus WHISPER_MODEL=/path/to/ggml-*.bin is used as-is —
# nothing is built or downloaded then. The wrapper it writes decodes the
# browser's webm/opus clip to the 16 kHz mono wav whisper wants, picks the
# language, and prints the transcript.
install_whisper() {
  local bin model
  command -v ffmpeg >/dev/null 2>&1 || {
    echo "!! ffmpeg is required to decode the browser's clip:  apt-get install --no-install-recommends ffmpeg" >&2
    exit 1
  }
  if command -v whisper-cli >/dev/null 2>&1; then
    bin="$(command -v whisper-cli)"
    log "whisper-cli on PATH → $bin (not building)"
  elif [ -x "$WHISPER_BUILT" ]; then
    bin="$WHISPER_BUILT"
    log "whisper.cpp present → $bin"
  else
    local missing=""
    for t in git cmake c++; do command -v "$t" >/dev/null 2>&1 || missing="$missing $t"; done
    [ -z "$missing" ] || {
      echo "!! building whisper.cpp needs:$missing —  apt-get install --no-install-recommends git cmake g++ make" >&2
      exit 1
    }
    disk_ok || exit 1
    log "building whisper.cpp $WHISPER_TAG in $WHISPER_SRC (-j$WHISPER_JOBS, ~1 min on 2 cores)"
    rm -rf "$WHISPER_SRC"
    git -c advice.detachedHead=false clone -q --depth 1 --branch "$WHISPER_TAG" "$WHISPER_REPO" "$WHISPER_SRC"
    # Static libs: the binary then needs nothing from the source tree at runtime.
    nice -n 10 cmake -S "$WHISPER_SRC" -B "$WHISPER_SRC/build" -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF > /dev/null
    nice -n 10 cmake --build "$WHISPER_SRC/build" -j "$WHISPER_JOBS" --target whisper-cli > "$WHISPER_SRC/build.log" 2>&1 || {
      echo "!! whisper.cpp did not build — see $WHISPER_SRC/build.log" >&2
      exit 1
    }
    bin="$WHISPER_BUILT"
  fi

  if [ -n "${WHISPER_MODEL:-}" ]; then
    model="$WHISPER_MODEL"
    [ -s "$model" ] || { echo "!! WHISPER_MODEL=$model is not a file" >&2; exit 1; }
  else
    model="$WHISPER_MODEL_FILE"
    if [ ! -s "$model" ]; then
      disk_ok || exit 1
      mkdir -p "$(dirname "$model")"
      log "downloading model ggml-$WHISPER_MODEL_NAME.bin"
      curl -fSL --retry 2 -o "$model.part" "$WHISPER_MODEL_URL/ggml-$WHISPER_MODEL_NAME.bin" || {
        rm -f "$model.part"
        echo "!! could not download $WHISPER_MODEL_URL/ggml-$WHISPER_MODEL_NAME.bin — set ATLAS_VOICE_WHISPER_MODEL_URL to a mirror, or WHISPER_MODEL to a model you have" >&2
        exit 1
      }
      mv "$model.part" "$model"
    else
      log "model present → $model"
    fi
  fi

  local vad="$WHISPER_VAD_FILE"
  if [ ! -s "$vad" ]; then
    mkdir -p "$(dirname "$vad")"
    curl -fsSL --retry 2 -o "$vad.part" "$WHISPER_VAD_URL" && mv "$vad.part" "$vad" || {
      rm -f "$vad.part"
      vad=""
      log "no VAD model ($WHISPER_VAD_URL did not download) — works without, but a silent clip may come back as a stray word"
    }
  fi

  mkdir -p "$DIR"
  cat > "$STT_WRAPPER" <<EOF
#!/bin/sh
# Generated by addons/voice/install.sh — browser clip → 16 kHz wav → whisper.cpp.
# Called as: $STT_WRAPPER <clip>   (the addon substitutes {file})
#            $STT_WRAPPER --check  (binary, model and ffmpeg all present?)
# Read at call time from the API's environment (.env), so no re-install to change:
#   ATLAS_VOICE_STT_LANG     auto (default): detect per clip · or pin one code, e.g. de
#   ATLAS_VOICE_STT_LANGS    de,en (default): what auto may pick; anything else it
#                            detects falls back to the FIRST one listed
#   ATLAS_VOICE_STT_THREADS  default: half the cores (this box also serves the dashboard)
set -eu
BIN="$bin"
MODEL="$model"
VAD="$vad"
if [ "\${1:-}" = --check ]; then
  [ -x "\$BIN" ] || { echo "whisper-cli missing: \$BIN" >&2; exit 1; }
  [ -s "\$MODEL" ] || { echo "whisper model missing: \$MODEL" >&2; exit 1; }
  command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg missing" >&2; exit 1; }
  echo "ok"
  exit 0
fi
[ -n "\${1:-}" ] || { echo "usage: \$0 <clip> | --check" >&2; exit 2; }
clip="\$1"
t="\${ATLAS_VOICE_STT_THREADS:-\$(( \$(nproc 2>/dev/null || echo 2) / 2 ))}"
[ "\$t" -ge 1 ] 2>/dev/null || t=1
langs="\${ATLAS_VOICE_STT_LANGS:-de,en}"
lang="\${ATLAS_VOICE_STT_LANG:-auto}"
wav="\$(mktemp -t atlas-kit-stt-XXXXXX.wav)"
trap 'rm -f "\$wav"' EXIT
ffmpeg -nostdin -loglevel error -y -i "\$clip" -ar 16000 -ac 1 -f wav "\$wav"
if [ -s "\$VAD" ]; then set -- --vad -vm "\$VAD"; else set --; fi
if [ "\$lang" = auto ]; then
  # A short clip can be mis-detected as a neighbouring language (German as
  # Dutch); only the languages the operator actually speaks are accepted.
  lang="\$("\$BIN" -m "\$MODEL" -f "\$wav" -t "\$t" -l auto -dl 2>&1 | sed -n 's/.*auto-detected language: \([a-z]*\).*/\1/p' | head -n 1)"
  case ",\$langs," in
    *",\$lang,"*) [ -n "\$lang" ] || lang="\${langs%%,*}" ;;
    *) lang="\${langs%%,*}" ;;
  esac
fi
"\$BIN" -m "\$MODEL" -f "\$wav" -t "\$t" -l "\$lang" -nt -np "\$@"
EOF
  chmod 700 "$STT_WRAPPER"
  "$STT_WRAPPER" --check > /dev/null || exit 1

  # Prove it before telling the operator to configure it — on whisper.cpp's own
  # English sample when the source tree is here.
  if [ -s "$WHISPER_SRC/samples/jfk.wav" ]; then
    "$STT_WRAPPER" "$WHISPER_SRC/samples/jfk.wav" 2>&1 | grep -qi 'country' || {
      echo "!! the wrapper ran but did not transcribe whisper.cpp's sample — try it by hand:  $STT_WRAPPER $WHISPER_SRC/samples/jfk.wav" >&2
      exit 1
    }
    log "transcribed whisper.cpp's sample clip — the engine works"
  fi
  log "ready → ATLAS_VOICE_STT_CMD=\"$STT_WRAPPER {file}\""
}

case "${1:-}" in
  --check)
    rc=0
    for var in ATLAS_VOICE_TTS_CMD ATLAS_VOICE_STT_CMD; do
      cmd="${!var:-}"
      if [ -z "$cmd" ]; then
        echo "$var unset — the browser handles it (zero-install default)"
      elif [ "$(cmd_bin "$cmd")" = "$STT_WRAPPER" ] && [ -x "$STT_WRAPPER" ] && ! why="$("$STT_WRAPPER" --check 2>&1)"; then
        # The wrapper resolves, but what it wraps (binary, model, ffmpeg) may not.
        echo "$var names $STT_WRAPPER, but $why — re-run  bash addons/voice/install.sh --engine whisper" >&2
        rc=2
      elif resolves "$cmd"; then
        echo "$var ok → $(cmd_bin "$cmd")"
      else
        echo "$var names $(cmd_bin "$cmd"), which is not executable here" >&2
        rc=2
      fi
    done
    if [ "$rc" = 2 ] && ! command -v apt-get >/dev/null 2>&1 && ! command -v python3 >/dev/null 2>&1; then
      echo "!! and neither apt-get nor python3 is here to install one" >&2
      exit 1
    fi
    exit "$rc"
    ;;

  --engine)
    case "${2:-}" in
      espeak-ng) install_espeak ;;
      piper) install_piper ;;
      kokoro) install_kokoro ;;
      whisper) install_whisper ;;
      *)
        echo "usage: install.sh --engine <espeak-ng|piper|kokoro|whisper>" >&2
        exit 2
        ;;
    esac
    write_sample
    echo
    echo "Next: paste the ATLAS_VOICE_* line above into .env, then  scripts/serve.sh restart"
    ;;

  '')
    write_sample
    echo
    found="$(detect)"
    if [ -n "$found" ]; then
      echo "On-box engines available here:"
      printf '%b' "$found"
    else
      echo "No on-box engine here — the browser speaks and listens, which needs nothing."
      echo "Want one anyway?  bash addons/voice/install.sh --engine espeak-ng   (tiny, offline)"
      echo "                  bash addons/voice/install.sh --engine piper       (~250 MB, natural)"
      echo "                  bash addons/voice/install.sh --engine kokoro      (~535 MB, less monotone, bilingual w/ piper)"
    fi
    echo
    echo "Next:"
    echo "  1. add  ATLAS_ADDONS=voice  to .env  (see $SAMPLE)"
    echo "  2. add the /api/voice/* handler to infra/Caddyfile — see the sample and the README"
    echo "  3. restart:  scripts/serve.sh restart"
    ;;

  *)
    echo "usage: install.sh [--check | --engine <espeak-ng|piper|kokoro|whisper>]" >&2
    exit 2
    ;;
esac

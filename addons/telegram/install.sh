#!/usr/bin/env bash
# addons/telegram has nothing to download: no binary, no model. What it needs is
# CONFIGURATION spread over three places, and this script reports which are done
# (see README.md for the @BotFather click-through).
#
# MODES
#   (no args) | --check
#     exit 0 — installed: every env var set, addon enabled,
#              speech recognition for voice notes and speech synthesis + ffmpeg (with libopus)
#              for voice replies configured (addons/voice), and ffmpeg + ffprobe for incoming videos
#              (it also lists the standing session and what pictures/videos/documents are
#              stored on the box — informational, never a gap)
#     exit 2 — installable: something above is still to do (each gap is printed)
#     exit 1 — cannot: node missing
#
# Read-only and idempotent — it changes nothing on the box.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "!! node is required" >&2; exit 1; }
[ -f "$ROOT/.env" ] && set -a && . "$ROOT/.env" && set +a

gaps=0
gap() { echo "[telegram] TODO: $*" >&2; gaps=$((gaps + 1)); }

# 1. Env — names only, never values.
for v in TELEGRAM_BOT_TOKEN TELEGRAM_HOME_CHAT_ID DASHBOARD_BEARER_TOKEN; do
  [ -n "${!v:-}" ] || gap "$v is not set in .env"
done

# 2. Enabled? ATLAS_ADDONS wins whenever it is DEFINED (even empty).
enabled=$(ROOT="$ROOT" node -e "
const fs = require('fs')
let names
if (process.env.ATLAS_ADDONS !== undefined) names = process.env.ATLAS_ADDONS.split(',').map((s) => s.trim())
else { try { names = JSON.parse(fs.readFileSync(process.env.ROOT + '/addons.json', 'utf8')).enabled || [] } catch { names = [] } }
process.stdout.write(names.includes('telegram') ? 'yes' : 'no')
")
[ "$enabled" = "yes" ] || gap "telegram is not enabled — add it to addons.json (or ATLAS_ADDONS), then scripts/serve.sh restart"

# 2b. getUpdates reachable? A dedicated bot, over the real network — the one live
#     check this script can do without touching Telegram's send API. A bad token
#     answers 401 here; that is exactly what this line exists to catch early.
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
  reach=$(TOKEN="$TELEGRAM_BOT_TOKEN" node -e "
fetch('https://api.telegram.org/bot' + process.env.TOKEN + '/getMe', { signal: AbortSignal.timeout(8000) })
  .then((r) => r.json().then((j) => process.stdout.write(r.ok && j.ok ? 'ok:' + (j.result?.username || '') : 'bad:' + (j.description || ('HTTP ' + r.status)))))
  .catch((e) => process.stdout.write('unreachable:' + e.message))
")
  case "$reach" in
    ok:*) echo "[telegram] bot reachable: @${reach#ok:}" ;;
    bad:*) gap "TELEGRAM_BOT_TOKEN was rejected by Telegram: ${reach#bad:}" ;;
    unreachable:*) echo "[telegram] could not reach api.telegram.org: ${reach#unreachable:} (offline box, or a firewall — not necessarily a config problem)" >&2 ;;
  esac
fi

# 2c. The standing session and what has come in — informational, never a gap. Asks the
#     addon's own code so it reads the state file exactly as the running API does.
SESSION_MJS="$ROOT/addons/telegram/api/agent.mjs"
if [ -f "$SESSION_MJS" ]; then
  SESSION_MJS="$SESSION_MJS" node --input-type=module -e "
import { pathToFileURL } from 'node:url'
const { sessionInfo } = await import(pathToFileURL(process.env.SESSION_MJS).href)
const { config, maskChatId } = await import(pathToFileURL(process.env.SESSION_MJS.replace('agent.mjs', 'config.mjs')).href)
const c = config()
const s = sessionInfo()
console.log('[telegram] home chat ' + (c.homeChatId ? maskChatId(c.homeChatId) : '(not set)') + ', ' + c.allowedChatIds.length + ' allowed chat(s) total')
console.log('[telegram] session: ' + s.session + (s.since ? ', since ' + s.since : ''))
" 2>&1 || echo "[telegram] could not read the session state (state file unreadable?)" >&2
fi

# 3. Voice notes (in) and voice replies (out) need addons/voice with on-box engines: enabled, the
#    command var set and its binary on PATH. (The browser's own speech engines, the voice addon's
#    default, cannot help here.) If the API is running, also ask it what it actually loaded —
#    informational: an API that predates a config change just needs a restart.
voice_on=$(ROOT="$ROOT" node -e "
const fs = require('fs')
let names
if (process.env.ATLAS_ADDONS !== undefined) names = process.env.ATLAS_ADDONS.split(',').map((s) => s.trim())
else { try { names = JSON.parse(fs.readFileSync(process.env.ROOT + '/addons.json', 'utf8')).enabled || [] } catch { names = [] } }
process.stdout.write(names.includes('voice') ? 'yes' : 'no')
")

# voice_live <stt|tts> → "yes", or why the running API does not report that engine available
voice_live() {
  SECTION="$1" PORT="${API_PORT:-3001}" node -e "
fetch('http://127.0.0.1:' + process.env.PORT + '/api/addons', { signal: AbortSignal.timeout(3000) })
  .then((r) => r.json())
  .then((j) => {
    const v = (j.addons || []).find((a) => a.name === 'voice')
    const s = v && v.status && v.status[process.env.SECTION]
    process.stdout.write(!v ? 'the running API has no voice addon loaded (restart it?)' : s && s.available ? 'yes' : 'the running API says: ' + ((s && s.reason) || 'no status for it'))
  })
  .catch(() => process.stdout.write('the API is not answering on 127.0.0.1 — cannot ask'))
"
}

# voice_engine <stt|tts> <label> <ENV_VAR> <noun> <advice> — one gap, or one "reachable" line
voice_engine() {
  local section="$1" label="$2" var="$3" noun="$4" advice="$5" cmd="${!3:-}" live
  if [ -z "$cmd" ]; then
    gap "$label need on-box speech $noun — set $var ($advice)"
  elif ! command -v "${cmd%% *}" >/dev/null 2>&1; then
    gap "$var names '${cmd%% *}', which is not an executable — run: bash addons/voice/install.sh --check"
  else
    live=$(voice_live "$section")
    if [ "$live" = "yes" ]; then
      echo "[telegram] $label: $var resolves, the running API reports it available"
    else
      echo "[telegram] $label: $var resolves, but $live" >&2
    fi
  fi
}

if [ "$voice_on" != "yes" ]; then
  gap "voice notes and voice replies need the voice addon — enable 'voice' (addons.json / ATLAS_ADDONS); without it a voice note gets a 'speech recognition is not active' reply and voice: true replies go out as text"
else
  voice_engine stt "voice notes" ATLAS_VOICE_STT_CMD recognition "bash addons/voice/install.sh --engine whisper prints the line"
  voice_engine tts "voice replies" ATLAS_VOICE_TTS_CMD synthesis "a command: text on stdin, audio on stdout — see addons/voice/README.md"
fi

# 4. Voice replies re-encode with ffmpeg: Telegram shows a voice note (waveform) only for OGG/Opus, so
#    it needs the libopus encoder. (Without it every voice: true reply falls back to text.)
if ! command -v ffmpeg >/dev/null 2>&1; then
  gap "voice replies need ffmpeg (with libopus) on PATH — apt install ffmpeg; without it voice: true replies go out as text. Incoming videos need it too (plus ffprobe): without them a video gets a 'can't process videos' answer; pictures and documents still work"
else
  # captured first: 'ffmpeg | grep -q' would trip pipefail when grep exits early
  encoders=$(ffmpeg -hide_banner -encoders 2>/dev/null || true)
  if grep -q libopus <<<"$encoders"; then
    echo "[telegram] voice replies: ffmpeg with libopus found"
  else
    gap "ffmpeg has no libopus encoder — voice replies need it for OGG/Opus (install a full ffmpeg build); voice: true replies go out as text meanwhile"
  fi
  # 4b. Incoming videos: ffprobe (duration, streams) next to ffmpeg (stills, soundtrack). Pictures and documents need neither.
  if command -v ffprobe >/dev/null 2>&1; then
    echo "[telegram] incoming videos: ffmpeg and ffprobe found (pictures and documents need no tool)"
  else
    gap "incoming videos need ffprobe on PATH next to ffmpeg (same apt package) — until then a video gets a 'can't process videos' answer; pictures and documents work"
  fi
fi

# 4c. What the incoming pictures / videos / documents left on the box (informational, never a gap):
#     asks the addon's own code, so it reads the same folder and limits the running API does.
MEDIA_MJS="$ROOT/addons/telegram/api/media.mjs"
if [ -f "$MEDIA_MJS" ]; then
  MEDIA_MJS="$MEDIA_MJS" node --input-type=module -e "
import { pathToFileURL } from 'node:url'
const { mediaStatus } = await import(pathToFileURL(process.env.MEDIA_MJS).href)
const m = mediaStatus()
console.log('[telegram] incoming media: ' + m.stored + ' message(s) stored in ' + m.dir + ' (deleted after ' + m.keepDays + ' days, at most ' + Math.round(m.maxMediaBytes / 1048576) + ' MB each; videos: ' + m.videoFrames + ' stills, soundtrack up to ' + m.maxVideoSeconds + ' s)')
" 2>&1 || echo "[telegram] could not read the media status" >&2
fi

if [ "$gaps" -eq 0 ]; then
  echo "[telegram] ready — env set, addon enabled, bot reachable"
  echo "[telegram] not checkable from here: whether the API process actually WON the singleton poller lock (GET /api/addons → telegram.status.poller.owner) — a restart after enabling the addon settles that"
  exit 0
fi
exit 2

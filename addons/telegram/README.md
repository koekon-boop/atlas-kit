# addons/telegram

Chat with the Atlas agent from **Telegram**: you write on your phone, ONE standing
Atlas knowledge session on the `atlas` vault reads it, and answers in the same chat.
Unlike [`addons/whatsapp`](../whatsapp/README.md) (one session per sender), this is
the operator's single standing chat — the pattern it mirrors, minus the
per-sender bookkeeping, because there is only one conversation — EXCEPT for a chat
id named in `TELEGRAM_CHAT_ROUTES`, which is pinned to an existing dashboard session
of its own instead ([Routing per chat](#routing-per-chat-optional)). You can send it
**text, voice notes, pictures, videos and documents**
([Voice notes](#voice-notes), [Pictures, videos and documents](#pictures-videos-and-documents)).

```
phone ──► Telegram Bot API ──► getUpdates (long-poll, this addon PULLS — no public webhook)
                                                                   │
                        core: POST /api/agents/spawn | prompt | queue   (ONE standing session)
                                                                   ▼
phone ◄── Telegram Bot API ◄── POST /api/telegram/send ◄── the agent, via curl
```

- `POST /api/telegram/send` — `{ chat_id?, text, voice? }`, **bearer-gated**; splits
  texts over 4096 characters at paragraph boundaries. This is how the agent answers
  — as text, or with `voice: true` as a read-aloud voice note ([Voice replies](#voice-replies)).
  There is **no webhook route** — see [Long-polling, not a webhook](#long-polling-not-a-webhook).

**Replies are pushed, not scraped.** Nothing reads the session's terminal. The
session is told at creation (see `sessionBrief()` in `api/agent.mjs`) that nobody
sees its terminal, that it must answer with a `curl` to `/api/telegram/send`, and to
write short, spoken-style, table-free replies in the language of the question. If it
ever answers in the terminal instead, you see nothing on the phone — the session is
visible in the dashboard's agent list, where you can look and steer it.

## Long-polling, not a webhook

This box sits behind Tailscale with no public port for Telegram to push a webhook
to (unlike WhatsApp's Meta-pushed webhook, which needs — and gets — a Cloudflare
Access bypass for exactly one path). Telegram's Bot API supports the opposite
direction instead: `getUpdates` **long-polling** — the box calls Telegram, holding
the request open for up to `TELEGRAM_POLL_TIMEOUT_S` (default 50s) until a message
arrives or the timeout elapses, then calls again immediately. Nothing is exposed
publicly; `infra/Caddyfile.example` only needs the ordinary bearer-gated block for
`/api/telegram/send`, not a webhook block.

🔴 **A Telegram bot allows exactly ONE active `getUpdates` consumer.** A second
poller racing the same token gets Telegram's own `409 Conflict` on every call. Two
things follow:

1. **Use a bot token that talks to nothing else.** Create your own bot at
   [@BotFather](https://t.me/BotFather) — never point `TELEGRAM_BOT_TOKEN` at a bot
   another process already polls (this box already runs a Hermes reminders bot on
   its own, separate token; do not reuse it here).
2. **This addon guards against itself, too.** `api/src/addons.mjs`'s `loadAddons()`
   runs once in the main API **and once per agent session** (every dev agent, the
   Atlas worker and the orchestrator each spawn their own
   `api/src/mcp/server.mjs` over stdio — see `docs/ADDONS.md` and
   `api/src/mcp/*.mcp.json`). If `register()` started the poll loop unconditionally,
   every concurrent session would start its own consumer. Instead `api/poller.mjs`
   claims a small pidfile lock (`<AGENT_LOCAL_DIR>/telegram-poller.lock`) before
   polling; a process that loses the race — a stale lock is reclaimed by checking
   whether its pid is still alive — simply does not poll. `GET /api/addons` shows
   `telegram.status.poller.owner`: `true` in the process that actually consumes
   updates, `false` (with a reason) in every other one. This is an implementation
   detail of this addon, not a documented core seam — it exists because this
   specific repo starts many short-lived processes that all load addons.

The offset (which updates Telegram may discard as already-delivered) is persisted
to `<AGENT_LOCAL_DIR>/telegram-offset.json` **after every individual update is
handled**, not once per batch — a crash mid-batch can redeliver at most the one
update that was in flight, never the whole batch.

## What it costs

- **Telegram:** free. No 24-hour reply window (unlike WhatsApp's Cloud API), no
  verified-recipient limit, no template-message billing — a bot can message anyone
  who has started a chat with it, any time.
- **Claude:** the session is an ordinary Atlas chat on your subscription; every
  message you send is one agent turn (and it can search the vault, so some turns are long).
- **Box:** nothing on disk except one small JSON file with the standing session id
  (`<AGENT_LOCAL_DIR>/telegram.json`, default `~/.atlas-kit/telegram.json`) and the
  poll offset next to it. Pictures, videos and documents you send are **kept on the
  box** for the agent to open — in `<AGENT_LOCAL_DIR>/telegram-media/`, deleted after
  14 days ([details](#pictures-videos-and-documents)). A voice reply needs a
  short-lived temp dir (removed straight after) and costs one on-box TTS run per
  ~700 characters plus a few seconds of ffmpeg CPU — nothing when you never send
  `voice: true`.
- **Privacy:** Telegram messages pass through Telegram's servers (regular chats are
  not end-to-end encrypted; only Secret Chats are, and this bridge does not use
  those — a Bot API bot cannot join a Secret Chat at all). Do not put in it what you
  would not put in any ordinary Telegram chat. A picture, a video still or a
  document the agent **looks at** is read by the model like any file it opens (your
  Claude subscription, Anthropic) — do not send what you would not show it. Voice
  replies add one more hop: **the text is handed to your `ATLAS_VOICE_TTS_CMD`** —
  if that is a cloud engine (an edge-tts wrapper talks to Microsoft) the spoken text
  leaves the box that way; a local engine (piper, kokoro) keeps it on the box.

## What it cannot do — read this before you count on it

- **Text, voice notes, pictures, videos and documents in; text or a voice note out.**
  Stickers, locations, contacts, polls, round "video messages"… get one short
  "can't read that yet" back and never reach the agent. A video is **not watched**:
  the agent gets a handful of stills and the transcript of its soundtrack — see
  below. Replies are text, or — with `voice: true` — a read-aloud voice note
  ([Voice replies](#voice-replies)); never images or files.
- **One shared conversation, unless routed.** Every chat id in `TELEGRAM_ALLOWED_CHAT_IDS`
  (plus the home chat) can write to the SAME standing session — unlike `addons/whatsapp`,
  which gives each sender their own. Put a second chat id in only for someone you
  would let read and steer the same conversation as the operator; there is no
  separation between them the way WhatsApp's per-sender sessions provide. A chat id
  in `TELEGRAM_CHAT_ROUTES` is the one exception — see
  [Routing per chat](#routing-per-chat-optional) — but it is pinned to a specific
  EXISTING session someone else already owns, not a fresh one-per-sender session
  the way WhatsApp spawns.
- A session **remembers across messages** until it is closed or its tmux dies; then
  the next message creates a fresh one (the old context is not carried over).
- **At most one getUpdates consumer on this box** — see [above](#long-polling-not-a-webhook).
  A restart briefly holds the old lock until it is detected as stale (its pid is
  dead) on the next attempt; there is no gap where two processes poll at once.
- Redelivery on a crash is possible but narrow: at most the ONE update that was
  mid-flight when the process died, never a whole batch (offset is persisted after
  each update, not once per poll).

## Voice notes

A voice note (or an attached audio file from the gallery — `message.audio`, same as
a WhatsApp attachment) is turned into text and handed to the agent like a typed
message, marked so it knows:

```
[Telegram from 123456789] [Sprachnachricht, transkribiert] Was steht heute an?
```

1. `GET api.telegram.org/bot<token>/getFile?file_id=<id>` → `file_path`, `file_size`.
   `file_size` is checked against the limit **before anything is downloaded** (and
   Telegram itself refuses `getFile` for anything over its own 20 MB cap — the
   default limit here matches that, raising it further has no effect).
2. `GET api.telegram.org/file/bot<token>/<file_path>` — the token lives in the URL,
   not a header (unlike WhatsApp's bearer): every request built from it is careful
   never to log that URL.
3. `POST http://127.0.0.1:$API_PORT/api/voice/transcribe` with the raw bytes and the
   message's own declared mime type, authenticated with `DASHBOARD_BEARER_TOKEN` —
   the route `addons/voice` serves. The bridge does not run Whisper itself and
   imports nothing from `addons/voice`.
4. The transcript goes through the normal forward path to the standing session; the
   agent answers with `/api/telegram/send` as always.

The audio is held **in memory only** — never written to disk, the vault or the
repo. Updates are handled one at a time (`getUpdates` itself delivers one batch,
and the poller does not fetch the next until this one's messages are done), so a
long transcription delays whatever is queued behind it. The chat allowlist applies
exactly as for text.

### It needs `addons/voice` with a working on-box STT

Enable `voice` **and** point `ATLAS_VOICE_STT_CMD` at an engine (`bash addons/voice/install.sh --engine whisper`
builds whisper.cpp and prints the line; `bash addons/voice/install.sh --check` tells you it resolves).
The browser's own speech recognition — the voice addon's zero-install default — is no use here: no
browser is involved.

When that is missing the sender is **never left in silence** and the agent is never bothered:

| what happened | what the sender gets | counter |
|---|---|---|
| voice addon off, no `ATLAS_VOICE_STT_CMD`, whisper missing or failing (`503`/`404` from the route) | "Spracherkennung ist auf der Box gerade nicht aktiv — schreib es mir bitte" (the route's own error text stays in the log) | `transcribeErrors` |
| Whisper heard nothing | "In der Sprachnachricht war nichts zu hören …" | `transcribeEmpty` |
| `file_size` over the limit, or the voice route's `413` | "… zu lang für mich …" | `audioTooLarge` (`413`: `transcribeErrors`) |
| media lookup or download failed (Telegram error, `401`, network) | "Ich konnte die Sprachnachricht nicht laden …" | `mediaErrors` |
| the route errored otherwise or timed out | "… nicht auswerten …" | `transcribeErrors` |

Every failure is logged with its status code and text. `GET /api/addons` shows
`telegram.status.voiceNotes.transcription` — `ready`, `NOT AVAILABLE — <why>` or
`unknown` (the first answer after a restart, before the probe of the voice addon's
status has come back) — and `bash addons/telegram/install.sh --check` reports it
too. A **restart** of the API is needed after changing `.env`.

### Limits and timeouts

| | default | env | why |
|---|---|---|---|
| audio size | **20 MB** | `TELEGRAM_MAX_AUDIO_BYTES` | Telegram's own `getFile` cap — a voice note is Opus at roughly 6 KB/s, so this is far more than anyone speaks; it only stops something absurd being downloaded into memory. ⚠️ `addons/voice` caps its upload at `ATLAS_VOICE_MAX_AUDIO_BYTES` (**12 MB**) — a clip between the two is downloaded and then refused with the "too long" hint. Raise that variable if you want the full 20 MB. |
| Telegram requests | 30 s each | `TELEGRAM_MEDIA_TIMEOUT_MS` | the `getFile` lookup and the download are each one request; a voice note is a few hundred KB |
| transcription | 120 s | `TELEGRAM_TRANSCRIBE_TIMEOUT_MS` | whisper.cpp needs several seconds per minute of audio on this kind of box; the voice route kills its engine after `ATLAS_VOICE_STT_TIMEOUT_MS` (60 s), so this stays **above** that and the route's precise error wins over a blind abort |

Cost: one on-box Whisper run per voice note (~290 MB RAM for the `base` model, only
while it transcribes). No API call, no key.

## Pictures, videos and documents

The agent is a Claude Code process with file access — it can open a picture or a PDF
**itself**. So nothing is described to it: the file is fetched from Telegram,
**saved on the box**, and its **path goes into the message**, marked the way a
voice note is. That marker is the interface between this addon and the agent
(`sessionBrief()` in `api/agent.mjs` explains it to a new session):

| you send | what the agent reads |
|---|---|
| a photo | `[Telegram from 123456789] [Bild empfangen: /root/.atlas-kit/telegram-media/2026-09-29/48213/image.jpg] Was ist das für ein Pilz?` |
| a document | `[Dokument empfangen: /…/Rechnung_Mai_2026.pdf, 3 Seiten] Stimmt der Betrag?` — the name it was sent under (made safe), the page count for a PDF when it can be read |
| a video | `[Video empfangen: /…/video.mp4, 12 s] Hört sich komisch an` ⏎ `Einzelbilder (6, gleichmäßig über die ganze Länge verteilt): /…/frame-01.jpg, /…/frame-02.jpg, …` ⏎ `Tonspur, transkribiert: "…"` |
| a long video | `[Video empfangen: /…/video.mp4, 340 s — gekürzt: nur die ersten 120 s der Tonspur transkribiert] …` — the stills still cover the whole video |

The text after the first `]` is the **caption** you wrote (there may be none;
Telegram carries it on the message itself, not nested under the photo/document/video
object — unlike WhatsApp). A video with no soundtrack, or a silent one, simply has
no `Tonspur` line. The brief tells the agent: *the paths are local files — look at
them with your normal tools before you answer; a video arrives as stills plus a
transcript, not as a film.* Everything else (`sticker`, `location`, `contact`,
round "video messages" …) is answered with the "can't read that" line as before.
The folder is named by the Telegram **update id**, not the message id — Telegram's
`message_id` is only unique per chat, and the update id is unique across every chat
this bot ever sees, so two different chats can never collide on one folder.

### How it works

1. `GET api.telegram.org/bot<token>/getFile?file_id=<id>` → `file_path`, `file_size`;
   `file_size` is checked **before anything is downloaded**. Then
   `GET api.telegram.org/file/bot<token>/<file_path>` — exactly the path voice notes
   take (`fetchMedia()` in `api/audio.mjs`, shared). Telegram's mime type is not part
   of that answer (unlike Meta's lookup): it is read straight off the message object
   instead (`document.mime_type`, `video.mime_type`, or a fixed `image/jpeg` for a
   photo, which Telegram always re-encodes to JPEG).
2. The bytes go to `<AGENT_LOCAL_DIR>/telegram-media/<YYYY-MM-DD>/<update id>/`
   (next to the state file, `0600` files): `image.<ext>`, `video.<ext>`, or a
   document under its own name. A document's name is reduced to letters, digits,
   `.` `_` `-` and cannot leave its folder.
3. **Video only** (`api/media.mjs`): `ffprobe` (duration, streams) → up to **6 stills**
   with `ffmpeg`, one from the middle of each of six equal slices of the **whole**
   video — not "one per second", which would bury the agent in a long clip (a 3 s
   clip gets 3, a 0.4 s one gets 1) — longest edge **1024 px**, JPEG (`frame-01.jpg`
   …) → if there is a soundtrack, `ffmpeg` cuts at most `TELEGRAM_MAX_VIDEO_SECONDS`
   of it as 16 kHz mono WAV and it is POSTed to
   `http://127.0.0.1:$API_PORT/api/voice/transcribe` — the same loopback route as a
   voice note, so it needs the same `addons/voice` + `ATLAS_VOICE_STT_CMD`. The
   scratch WAV is deleted; only the video and the stills stay.
4. The marked text goes through the normal forward path to the standing session; the
   agent answers with `/api/telegram/send` as always.

The chat allowlist applies exactly as for text; a `sendChatAction` "typing…" hint is
sent while the download/transcription is in flight, best-effort.

### Limits, timeouts, clean-up

| | default | env | why |
|---|---|---|---|
| file size | **20 MB** | `TELEGRAM_MAX_MEDIA_BYTES` | Telegram's Bot API caps a `getFile` download at 20 MB regardless of what was uploaded — raising this past 20 MB has no effect. Over the limit → a short hint, **no download**; Telegram's `file_size` is a claim, so the real bytes are checked too |
| video length | **120 s** | `TELEGRAM_MAX_VIDEO_SECONDS` | a longer video is still accepted: stills over its whole length, but only the first 120 s of sound are transcribed — and the marker says so. 120 s of 16 kHz WAV is ~3.8 MB, well under `addons/voice`'s `ATLAS_VOICE_MAX_AUDIO_BYTES` (12 MB ≈ 6 min: **do not set this above ~350** or the route answers `413`), and whisper.cpp needs several seconds per minute of audio, inside the voice route's 60 s engine limit |
| stills per video | **6** | `TELEGRAM_VIDEO_FRAMES` | enough to follow a scene, few enough to read |
| still size | **1024 px** | `TELEGRAM_VIDEO_FRAME_PX` | longest edge, never upscaled |
| keep for | **14 days** | `TELEGRAM_MEDIA_KEEP_DAYS` | when a new medium arrives, every `<YYYY-MM-DD>` folder older than this is deleted — no cron. Only folders whose **name is a date** are ever touched; a folder or file of yours in that directory is safe |
| Telegram requests | 30 s each | `TELEGRAM_MEDIA_TIMEOUT_MS` | lookup and download, as for voice notes |
| ffprobe / ffmpeg | 60 s each | `TELEGRAM_FFMPEG_TIMEOUT_MS` | every single run: the probe, each still, the soundtrack |
| transcription | 120 s | `TELEGRAM_TRANSCRIBE_TIMEOUT_MS` | as for voice notes |

Nothing of this goes to the vault or the repo. The agent is told to copy a file into
the vault only when you ask for it.

### It never goes quiet

Every failure is **one short, specific reply** to the sender, **nothing reaches the
agent**, and a half-handled folder is removed:

| what happened | what the sender gets | counter |
|---|---|---|
| file over the limit (`file_size`, the bytes, or Telegram's own "file is too big") | "Die Datei ist zu groß für mich (mehr als 20 MB) …" | `mediaTooLarge` |
| `getFile` lookup / download failed, no media id | "Ich konnte die Datei nicht laden …" | `mediaErrors` |
| the folder cannot be written | "… nicht auf der Box ablegen …" | `mediaErrors` |
| **video**, `ffmpeg` or `ffprobe` not installed | "Videos kann ich gerade nicht auswerten (ffmpeg fehlt auf der Box) …" — **pictures and documents keep working** | `mediaErrors` |
| video unreadable (ffprobe fails, no picture stream, no duration, no still could be cut, the soundtrack could not be cut) | "Das Video konnte ich nicht auslesen …" | `mediaErrors` |
| video has a soundtrack but transcription is off / broken (`503`/`404`, or another error) | "Die Tonspur des Videos konnte ich nicht auswerten: Spracherkennung ist auf der Box gerade nicht aktiv …" (or "… versuch es gleich noch mal") | `transcribeErrors` |

A silent soundtrack (Whisper heard nothing) is **not** an error: the video goes on
without a `Tonspur` line (`transcribeEmpty`). A soundtrack that fails to transcribe
**is** one. Every failure is logged with its status code and text.

### Status, counters, tools

`GET /api/addons` shows `telegram.status.media`: `ffmpeg` and `ffprobe` (found on
`PATH`), `stored` (how many messages' media are on disk right now), `dir`,
`keepDays`, `maxMediaBytes`, `maxVideoSeconds`, `videoFrames`. Counters:
`imagesReceived`, `videosReceived`, `documentsReceived`, `framesExtracted`,
`mediaTooLarge`, `mediaErrors` (`transcribed` / `transcribeEmpty` / `transcribeErrors`
also count video soundtracks). `bash addons/telegram/install.sh --check` reports
`ffmpeg` + `ffprobe` (**needed for videos only** — pictures and documents work
without either), and how much is stored where. Nothing new to install: `ffmpeg` is
the same one voice replies use, and the transcription needs the same
`ATLAS_VOICE_STT_CMD` as voice notes.

## Voice replies

The way back of the voice notes above: the agent can answer as a **spoken Telegram
voice note** instead of text. `POST /api/telegram/send` takes
`{ "text": "…", "chat_id"?: "…", "voice"?: true }`. **Without `voice` nothing
changes** — the same text send, the same `{"ok":true,"sent":1,"parts":1}` answer.
With `"voice": true`:

```
text ─► chunk (≤ TELEGRAM_MAX_SPOKEN_CHARS) ─► POST /api/voice/speak  (once per chunk, in order)
     ─► ffmpeg: all clips → ONE mono OGG/Opus ─► POST bot<token>/sendVoice  (multipart, the file directly)
```

1. **Read aloud through the box's own route.** `POST http://127.0.0.1:$API_PORT/api/voice/speak`
   with the dashboard bearer and `{ text }`, the route `addons/voice` serves — the
   same loopback pattern as `/api/voice/transcribe`. The bridge starts no TTS itself
   and imports nothing from `addons/voice`. The answer's `content-type` is used only
   as the temp file's extension; ffmpeg decides by the bytes, so nothing assumes WAV
   (the voice addon labels its output `audio/wav` by default even when the engine
   emits something else — trusting the label would turn that into a hard failure).
2. **Re-encode** with `ffmpeg -c:a libopus -ac 1 -b:a 20k -application voip -f ogg`.
   The clips are joined by ffmpeg's `concat` *filter*, which decodes each first, so
   different formats or sample rates still join — **no tone and no pause between the
   parts; it plays like one recording.**
3. **Send.** Unlike WhatsApp (a separate media-upload call, then a send), Telegram's
   `sendVoice` takes the file directly in ONE multipart call
   (`chat_id`, `voice`: the file) — there is no separate upload step to fail on.

`chat_id` is checked against `TELEGRAM_ALLOWED_CHAT_IDS` exactly as for text, and
defaults to the home chat when omitted. `voice` must be `true` or `false` (anything
else is a `400`: a string `"true"` must not silently turn into text).

**The answer says what went out:**

| | answer |
|---|---|
| voice note sent | `200 {"ok":true,"mode":"voice","sent":1,"parts":1,"chunks":<n>}` — `chunks` is how many pieces were read |
| voice failed or too long, text sent | `200 {"ok":true,"mode":"text","voiceError":"<why>","sent":…,"parts":…}` |
| voice failed **and** the text send failed | `502 {"ok":false,"mode":"text","voiceError":"…","error":"<Telegram's text>","status":…}` |

### Why OGG/Opus, mono

Telegram's Bot API shows a file as a real **voice message** (round bubble,
waveform, playback speed control) only if it is sent through `sendVoice` with
`.ogg`/OPUS audio (or another format Telegram can transcode server-side, which is
not guaranteed) — the same constraint WhatsApp has, so the same ffmpeg settings
apply unchanged, including the 20 kbps bitrate (`voip` tuning, plenty for speech,
keeps the file small). Telegram does not document a WhatsApp-style "play button only
below 512 KB" size cliff, so the number was kept identical rather than re-tuned —
one predictable cost, not a guess at a second platform's quirks.

### It needs `addons/voice` with an on-box TTS and ffmpeg with libopus

| | needed | if it is missing |
|---|---|---|
| `addons/voice` enabled + `ATLAS_VOICE_TTS_CMD` set to a working engine (text on stdin → audio on stdout, e.g. a wrapper around edge-tts, piper, kokoro) | speech | `/api/voice/speak` answers `503`/`404` → **text**, `ttsErrors` |
| `ffmpeg` on `PATH` **with `libopus`** | re-encoding to OGG/Opus | ffmpeg not found, or failing → **text**, `ffmpegErrors` |
| Telegram accepts the `sendVoice` call | delivery | refused → **text**, `sendErrors` (Telegram's status and text in the log) |

The browser's own speech synthesis — the voice addon's zero-install default — is no
use here. **Every** failure ends in the ordinary text message, **once**: there is no
retry loop, and the operator always gets the answer. `voiceFallbacks` counts every
time that happened.

### Two length limits — and how they relate to `ATLAS_VOICE_MAX_SPOKEN_CHARS`

| | default | env | what it does |
|---|---|---|---|
| per TTS call | **700** | `TELEGRAM_MAX_SPOKEN_CHARS` | the text is cut at paragraph, then sentence, then (one endless sentence) word boundaries into pieces of at most this many characters; each is read separately and the clips are joined into one voice note |
| whole reply | **3000** (≈ 3 min) | `TELEGRAM_MAX_VOICE_CHARS` | above this **nothing is read aloud**: the text goes out as a normal message, `mode:"text"`, with the reason in `voiceError`. A phone chat does not need a ten-minute monologue |

⚠️ **`TELEGRAM_MAX_SPOKEN_CHARS` and the voice addon's `ATLAS_VOICE_MAX_SPOKEN_CHARS`
(default 700) belong together.** `/api/voice/speak` **silently cuts** any longer
text at that limit — no error — so a reply would just stop mid-sentence. The bridge
therefore never sends more than its own limit per call. The addon does not read the
voice addon's setting: if you raise `ATLAS_VOICE_MAX_SPOKEN_CHARS`, raise this one to
match (fewer, longer pieces); **never set this one higher** than the voice addon's.
(Values under 50 are ignored — a runaway number of TTS calls is never what anyone
meant.)

Timeouts: `TELEGRAM_TTS_TIMEOUT_MS` (30 s per piece; the voice route kills its
engine after `ATLAS_VOICE_TTS_TIMEOUT_MS`, 20 s, so this stays **above** it and the
route's precise error wins), `TELEGRAM_FFMPEG_TIMEOUT_MS` (60 s), and
`TELEGRAM_MEDIA_TIMEOUT_MS` (30 s) also covers the `sendVoice` upload. The pieces
are read one after the other, so a long reply takes a few seconds per piece before
it is sent.

### Temp files, status, and the agent

ffmpeg needs files: each reply gets one `mkdtemp` directory under the OS temp dir
(`TMPDIR`), removed in a `finally` — also when anything fails. Nothing goes to the
vault or the repo.

`GET /api/addons` shows `telegram.status.voiceReplies` — `synthesis` (`ready`,
`NOT AVAILABLE — <why>`, or `unknown` for the first answer after a restart),
`ffmpeg` (found on `PATH`), `maxSpokenChars`, `maxVoiceChars` — and the counters
`voiceSent`, `voiceFallbacks`, `ttsErrors`, `ffmpegErrors`, `sendErrors`. A disabled
voice addon only makes `synthesis` read `NOT AVAILABLE`. `bash addons/telegram/install.sh --check`
reports the same, plus whether ffmpeg has `libopus` (a fact only it can see).

**Telling the agent.** A session created **after** this change is briefed
(`sessionBrief()` in `api/agent.mjs`): `voice: true` sends a voice note; **mirror
the medium** by default (a `[Sprachnachricht, transkribiert] …` message gets a voice
note, a typed one gets text) unless the operator asks otherwise; short, spoken
sentences, no bullets; never voice links, long numbers, IDs or code — send those as
text; and the length cap. ⚠️ The **already running session keeps its old brief**
(it only knows text) — until it is closed and the next message spawns a fresh one,
it will not use `voice`.

## Several chats (optional)

The default setup needs only `TELEGRAM_HOME_CHAT_ID` — a single operator, one
chat. `TELEGRAM_ALLOWED_CHAT_IDS` (a comma list) adds more chats that may write to
the **same** standing session — unlike `addons/whatsapp`'s one-session-per-sender,
there is no separation between them; use it for someone you would let read and
steer the same conversation as the operator, not for a second private line (for
that, WhatsApp's pattern would need to be mirrored here too — it is not, because
nothing in this task asked for it). Every inbound marker still names the sender's
own chat id (`[Telegram from <id>]`); the session brief tells the agent that a
reply defaults to the home chat and only needs `"chat_id"` in the body to answer
someone else.

## Routing per chat (optional)

`TELEGRAM_CHAT_ROUTES` pins ONE chat id to an EXISTING dashboard session instead
of the standing session above — as if Telegram were just another channel into a
chat that already exists for another reason. The case this was built for: Jessi
writes to the SAME bot Ko does, but her messages must land in her own `kb-shop-setup`
knowledge session (her shop-setup base), not in Ko's Telegram chat.

```bash
TELEGRAM_CHAT_ROUTES=6076694713=kb-shop-setup
# several routes: TELEGRAM_CHAT_ROUTES=111=kb-one,222=kb-two:5a306058-da69-4177-8e61-cef1cd9ec0e8
```

Format: `<chat id>=<session id>[:<claude session uuid>]`, comma-separated for more
than one. The optional `:<uuid>` is a **human-readable note only** — a pointer to
the Claude session the target id was last resumed from, for whoever reads the env
later. This addon never acts on it: there is no core route that lets an addon
recreate a closed session under a chosen id from a bare Claude session uuid (checked
against `api/src/agent-local.mjs`/`agent-routes.mjs` while building this — `resumeId()`
and `revive()` both require the dashboard registry entry to already exist;
`POST /api/agents/spawn` always starts a brand-new Claude session, with no
`resume`/`sessionId` body field). Every chat id named here is automatically
allowed to write, on top of whatever `TELEGRAM_ALLOWED_CHAT_IDS`/the home chat
already says — Jessi does not also need to be added there.

**What happens to a routed message** — text, a transcribed voice note, or a
picture/video/document path, exactly the markers described above:

| the target session is… | what happens |
|---|---|
| idle | `POST /api/agents/prompt` — same rule as the standing session |
| running | `POST /api/agents/queue`, delivered at its next boundary |
| **dormant** (parked by a tmux death) | `POST /api/agents/revive` first, then delivered |
| **closed, or gone from `GET /api/agents` entirely** | **never recreated, never redirected anywhere else.** The message is stored (in the state file, per chat id) and the sender gets one plain reply saying so. It is retried, in order, nothing skipped, on the next message from that chat **and** on every long-poll tick (`poller.mjs`'s `onTick`, wired in `register.mjs`) — so it still reaches the base even if the sender never writes again |
| a `/prompt`/`/revive`/`/queue` call fails for any other reason | same as above — stored, never dropped |

This is deliberately conservative: a routed chat's base is meant to be a **durable**
thing (Jessi's shop-setup chat, not a throwaway), so a route is never silently
pointed at a freshly spawned replacement — that would be a different conversation
with no memory of the old one, under the same name. If the target needs to come
back after being fully closed, that is an operator action (resume it by hand from
its Claude session id, the way the dashboard's own "Resume" / `claude --resume`
path does), not something this addon can do through its own routes.

**Recommendation, not yet built:** core has no way to PROTECT a routed target
session from being closed/cleaned up by an operator action elsewhere (checked —
no pin/lock/keepAlive concept exists on a session anywhere in `agent-local.mjs`/
`agent-routes.mjs`/the dashboard card). Until one exists, closing a routed
session's dashboard chat by hand puts it into the "closed" row above — stored,
never lost, but not flowing again until it is manually resumed and the route
still points at the same id.

**Every message through a route carries its own footer** (unlike the standing
session's one-time brief) — the target was not created by this addon and does
not already know the reply contract:

```
(Antwort an diese Person NUR per POST http://127.0.0.1:3001/api/telegram/send mit
{"chat_id":"6076694713","text":"…"} und Bearer $DASHBOARD_BEARER_TOKEN — das
Terminal liest sie nicht. Der Bearer-Token steht in /workspace/.env. Sprachnachricht
raus → "voice":true. Kurz, Klartext.)
```

`GET /api/addons` shows `telegram.status.chatRoutes`: one row per configured route
— the masked chat id, its target session id, how many messages made it through,
the last delivery time, and how many are still waiting.

## Security model

| what | how it is protected |
|---|---|
| who may talk to the agent | `TELEGRAM_ALLOWED_CHAT_IDS` (or, when unset, just the home chat) **plus every chat id named in `TELEGRAM_CHAT_ROUTES`**, folded in automatically. Anyone else is dropped **silently** (no reply, so no sign the bridge exists) and counted (`dropped`). Telegram bots are publicly discoverable by username — without an allowlist, anyone who found the bot could inject prompts into a session with full vault access; this is the trust boundary that prevents that. |
| `POST …/send` | `DASHBOARD_BEARER_TOKEN`, constant-time — and `chat_id` must be in the allowlist (routed chat ids included), so a prompt-injected agent cannot message arbitrary chats (voice or text alike). |
| the bot token | lives in every Bot API URL (Telegram's design, not a header) — every function that builds one is careful never to pass that URL to a log line. |
| getUpdates | only ONE process on this box holds the poll — see [Long-polling, not a webhook](#long-polling-not-a-webhook). |

| files you receive | saved `0600` under a folder named by date and update id; a document's file name is reduced to letters, digits and `._-`, so it cannot climb out of that folder; only allowlisted chats get this far; the retention sweep deletes date-named folders only |

## Enable — step by step

### 1. Create a dedicated bot
Message [@BotFather](https://t.me/BotFather) on Telegram → `/newbot` → follow the
prompts (name, then a unique `@username` ending in `bot`) → BotFather gives you a
token, `123456789:AAAA...` → `TELEGRAM_BOT_TOKEN`. **Do not reuse a token any other
process already polls** — see [above](#long-polling-not-a-webhook).

### 2. Your chat id
Message your new bot **first** (Telegram requires that before a bot can write to
you) — anything, e.g. "hi". Then message [@userinfobot](https://t.me/userinfobot)
(a separate, well-known bot) to get your own numeric id → `TELEGRAM_HOME_CHAT_ID`.

### 3. Your side of the config (`.env`, never the repo)
```bash
TELEGRAM_BOT_TOKEN=123456789:AAAA...     # step 1
TELEGRAM_HOME_CHAT_ID=987654321          # step 2
```
`DASHBOARD_BEARER_TOKEN` must be set (core wants it anyway). Enable the addon —
`addons.json` `{"enabled": ["telegram"]}` or `ATLAS_ADDONS=…,telegram` — and
`scripts/serve.sh restart`.

### 4. Nothing to expose publicly
Unlike `addons/whatsapp`, there is no webhook to add to `infra/Caddyfile` and no
Cloudflare Access bypass to create — long-polling means the box only ever calls
*out* to Telegram. `bash addons/telegram/install.sh --check` tells you whether the
bot token is even reachable, which is the only "is this configured" signal there is
to check from outside a running API.

### 5. Try it
Message your bot from the chat whose id is `TELEGRAM_HOME_CHAT_ID`. The first
message spawns the session (a few seconds); the answer arrives in the same chat. In
the dashboard a new Atlas chat appears in the agent list.

### 6. If nothing comes back
`curl -s localhost:3001/api/addons | jq '.addons[] | select(.name=="telegram")'`
shows what is missing (`status.inbound`/`status.outbound` list the unset
variables) and the counters:

| signal | meaning |
|---|---|
| `status.poller.owner` is `false` everywhere | the API process never won the singleton lock — check `<AGENT_LOCAL_DIR>/telegram-poller.lock` for a stale pid from a process that is actually gone, or that `TELEGRAM_BOT_TOKEN` is set (no token, no poller at all) |
| `status.poller.lastError` set, rising `pollCount` with no messages arriving | `getUpdates` itself is failing — a bad token answers `401`; `install.sh --check`'s `getMe` probe catches that early |
| `dropped` rising | the sender's chat id is not in `TELEGRAM_ALLOWED_CHAT_IDS` (or the home chat) |
| `audioReceived` rising but `transcribed` not | see the voice-note table above: `transcribeErrors` → speech recognition (`addons/voice/install.sh --check`); `mediaErrors` → the log line has the reason (an expired setup or a network hiccup) |
| `imagesReceived` / `videosReceived` / `documentsReceived` rising but the agent never answers | `mediaErrors` → the log line has the reason (`ffmpeg`/`ffprobe` missing, a folder that cannot be written); `mediaTooLarge` → over `TELEGRAM_MAX_MEDIA_BYTES`; otherwise the session is an **old one** that does not know the `[Bild empfangen: …]` markers — close it, the next message starts a fresh one |
| `voiceFallbacks` rising | voice replies are being sent as text: `ttsErrors` → the TTS command (`addons/voice/install.sh --check`); `ffmpegErrors` → `ffmpeg` missing or without `libopus` (`addons/telegram/install.sh --check`); `sendErrors` → Telegram refused the voice send — the log line has its status and text; none of the three → the text was over `TELEGRAM_MAX_VOICE_CHARS` |
| `forwardErrors` rising | the agent routes refused — the API log has the reason; the sender gets a "can't reach the agent" message |
| all zero, no error logged | the API process holding the poller may be a different one than you restarted (check `status.poller.owner` across the fleet) |

## Turning it off

Remove `telegram` from `addons.json` / `ATLAS_ADDONS` and restart: no route, no
poller, no outbound call. The state file, the offset file, the lock file and the
agent session can be deleted by hand.

## Tests

`node --test addons/telegram/test/*.test.mjs` (also part of `cd api && npm test`).
Telegram, the transcription and speech routes, the agent routes and ffmpeg/ffprobe
are all stubbed; nothing leaves the process, no ffmpeg runs and no credential is
real.

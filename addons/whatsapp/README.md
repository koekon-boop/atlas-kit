# addons/whatsapp

Chat with the Atlas agent from **WhatsApp**: you write on your phone, a standing
Atlas knowledge session on the `atlas` vault reads it, and answers in the same chat.

```
phone ──► Meta Cloud API ──► POST /api/whatsapp/webhook ──► (verify HMAC, dedupe, allowlist)
                                                                   │
                        core: POST /api/agents/spawn | prompt | queue   (one session, reused)
                                                                   ▼
phone ◄── Meta Cloud API ◄── POST /api/whatsapp/send ◄── the agent, via curl
```

- `GET  /api/whatsapp/webhook` — Meta's verification handshake.
- `POST /api/whatsapp/webhook` — inbound messages, authenticated by Meta's HMAC signature.
- `POST /api/whatsapp/send` — `{ to?, text, voice? }`, **bearer-gated**; splits texts over 4096 characters at paragraph boundaries. This is how the agent answers — as text, or with `voice: true` as a read-aloud voice note ([Voice replies](#voice-replies)).

**Replies are pushed, not scraped.** Nothing reads the session's terminal. The session
is told at creation (see `sessionBrief()` in `api/agent.mjs`) that nobody sees its
terminal, that it must answer with a `curl` to `/api/whatsapp/send`, and to write short,
spoken-style, table-free replies in the language of the question. If it ever answers in
the terminal instead, you see nothing on the phone — the session is visible in the
dashboard's agent list, where you can look and steer it.

## What it costs

- **Meta:** the Cloud API is free for what this addon does — replies inside the
  24-hour window (below) are *service conversations*. Meta bills *template* messages
  per message; this addon never sends one. Pricing changes — check Meta's current
  page before relying on this.
- **Claude:** the session is an ordinary Atlas chat on your subscription; every
  message you send is one agent turn (and it can search the vault, so some turns are long).
- **Box:** nothing on disk except one JSON file with the session id
  (`<AGENT_LOCAL_DIR>/whatsapp.json`, default `~/.atlas-kit/whatsapp.json`); a
  small in-memory dedupe set; no dependency, no cron.
  A voice reply also needs a short-lived temp dir (removed straight after) and costs one on-box TTS run
  per ~700 characters plus a few seconds of ffmpeg CPU — nothing when you never send `voice: true`.
- **Privacy:** WhatsApp Cloud API messages pass through Meta's servers **unencrypted
  end to end** (Meta is the business-side endpoint). Do not put in it what you would
  not put in any Meta business account.
  Voice replies add one more hop: **the text is handed to your `ATLAS_VOICE_TTS_CMD`** — if that is a
  cloud engine (an edge-tts wrapper talks to Microsoft) the spoken text leaves the box that way; a
  local engine (piper, kokoro) keeps it on the box.

## What it cannot do — read this before you count on it

- **The 24-hour window.** You can only answer freely **within 24 hours after the user's
  last message**. After that, Meta rejects a free-text send (error `131047`) and the
  only way to reach out first is an **approved message template** — which this addon
  does not send. So the agent **cannot ping you unprompted** (no "your build finished"
  pushes) unless you have written within the last day. Every message you send re-opens
  the window. `GET /api/addons` shows `windowOpen` and `lastInboundAt`.
- **The free Meta test number** (what you get without a business verification) can
  message **at most 5 recipients**, which you must verify one by one in the Meta
  console. Its access token from the API Setup page **expires after ~24 hours** —
  for anything lasting, make a System User token (step 3). You cannot use the test
  number to talk to the public, and it is not for production use.
- **Text and voice notes in, text or a voice note out.** Images, documents, stickers, locations,
  reactions… get one short "can't read that yet" back and never reach the agent
  (voice notes: see below). Replies are text, or — with `voice: true` — a read-aloud voice note
  (see [Voice replies](#voice-replies)); never images or files.
- **One session for everyone on the allowlist.** Two numbers in
  `WHATSAPP_ALLOWED_FROM` share one conversation. Put in only numbers that may read
  each other's questions — normally just yours.
- The session **remembers across messages** until it is closed or its tmux dies; then
  the next message creates a fresh one (the old context is not carried over).
- Message ids are deduped **in memory** (last 1000): a Meta redelivery straight after
  an API restart can be handled twice.

## Voice notes

A voice note (or an audio file attached from the gallery — same message type, `voice: false`)
is turned into text and handed to the agent like a typed message, marked so it knows:

```
[WhatsApp from 4915…] [Sprachnachricht, transkribiert] Was steht heute an?
```

1. `GET graph.facebook.com/v21.0/<media-id>` → `url`, `mime_type`, `file_size`.
   `file_size` is checked against the limit **before anything is downloaded**.
2. `GET <url>` — with the same `Authorization: Bearer` access token (the lookaside URL answers `401`
   without it; the bridge only sends it to an `https://` URL).
3. `POST http://127.0.0.1:$API_PORT/api/voice/transcribe` with the raw bytes and the file's
   `content-type`, authenticated with `DASHBOARD_BEARER_TOKEN` — the route `addons/voice` serves. The
   bridge does not run Whisper itself and imports nothing from `addons/voice`.
4. The transcript goes through the normal forward path; the agent answers with `/api/whatsapp/send` as always.

The audio is held **in memory only** — never written to disk, the vault or the repo. It all happens
after the webhook has answered `200`, in the same one-message-at-a-time queue as text, so a
long transcription delays the message behind it. Dedupe, the sender allowlist, the signature check
and the 24-hour window apply exactly as for text.

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
| media lookup or download failed (Graph error, `401`, network) | "Ich konnte die Sprachnachricht nicht laden …" | `mediaErrors` |
| the route errored otherwise or timed out | "… nicht auswerten …" | `transcribeErrors` |

Every failure is logged with its status code and text (`[whatsapp] media lookup failed: HTTP 400: …`).
`GET /api/addons` shows `voiceNotes.transcription` — `ready`, `NOT AVAILABLE — <why>` or `unknown` (the
first answer after a restart, before the probe of the voice addon's status has come back) — and
`bash addons/whatsapp/install.sh --check` reports it too. A **restart** of the API is needed after
changing `.env`.

### Limits and timeouts

| | default | env | why |
|---|---|---|---|
| audio size | **16 MB** | `WHATSAPP_MAX_AUDIO_BYTES` | Meta's own cap for audio messages. A voice note is Opus at roughly 6 KB/s, so this is far more than anyone speaks; it only stops something absurd being downloaded into memory. ⚠️ `addons/voice` caps its upload at `ATLAS_VOICE_MAX_AUDIO_BYTES` (**12 MB**) — a clip between the two is downloaded and then refused with the "too long" hint. Raise that variable too if you want the full 16 MB. |
| Meta requests | 30 s each | `WHATSAPP_MEDIA_TIMEOUT_MS` | the lookup and the download are each one request; a voice note is a few hundred KB |
| transcription | 120 s | `WHATSAPP_TRANSCRIBE_TIMEOUT_MS` | whisper.cpp needs several seconds per minute of audio on this kind of box; the voice route kills its engine after `ATLAS_VOICE_STT_TIMEOUT_MS` (60 s), so this stays **above** that and the route's precise error wins over a blind abort |

Cost: one on-box Whisper run per voice note (~290 MB RAM for the `base` model, only while it
transcribes). No API call, no key.

## Voice replies

The way back of the voice notes above: the agent can answer as a **spoken WhatsApp voice note**
instead of text. `POST /api/whatsapp/send` takes `{ "text": "…", "to"?: "…", "voice"?: true }`.
**Without `voice` nothing changes** — the same text send, the same `{"ok":true,"sent":1,"parts":1}` answer.
With `"voice": true`:

```
text ─► chunk (≤ WHATSAPP_MAX_SPOKEN_CHARS) ─► POST /api/voice/speak  (once per chunk, in order)
     ─► ffmpeg: all clips → ONE mono OGG/Opus ─► POST graph/<phone-id>/media  (multipart, type=audio/ogg)
     ─► POST graph/<phone-id>/messages  { type: "audio", audio: { id } }
```

1. **Read aloud through the box's own route.** `POST http://127.0.0.1:$API_PORT/api/voice/speak` with the
   dashboard bearer and `{ text }`, the route `addons/voice` serves — the same loopback pattern as
   `/api/voice/transcribe`. The bridge starts no TTS itself and imports nothing from `addons/voice`. The
   answer's `content-type` is used only as the temp file's extension; ffmpeg decides by the bytes, so
   nothing assumes WAV (the voice addon labels its output `audio/wav` by default even when the engine
   emits something else — trusting the label would turn that into a hard failure).
2. **Re-encode** with `ffmpeg -c:a libopus -ac 1 -b:a 20k -application voip -f ogg`. The clips are joined by
   ffmpeg's `concat` *filter*, which decodes each first, so different formats or sample rates still
   join — **no tone and no pause between the parts; it plays like one recording.**
3. **Upload** as `multipart/form-data` (`messaging_product=whatsapp`, `type=audio/ogg`, the file) → `{ id }`.
4. **Send** `{ messaging_product, to, type: "audio", audio: { id } }`.

`to` is checked against `WHATSAPP_ALLOWED_FROM` exactly as for text. `voice` must be `true` or `false`
(anything else is a `400`: a string `"true"` must not silently turn into text).

**The answer says what went out:**

| | answer |
|---|---|
| voice note sent | `200 {"ok":true,"mode":"voice","sent":1,"parts":1,"chunks":<n>,"mediaId":"…"}` — `chunks` is how many pieces were read, `parts`/`sent` count WhatsApp messages (always 1) |
| voice failed or too long, text sent | `200 {"ok":true,"mode":"text","voiceError":"<why>","sent":…,"parts":…}` |
| voice failed **and** the text send failed | `502 {"ok":false,"mode":"text","voiceError":"…","error":"<Meta's text>","status":…}` |

### Why OGG/Opus, mono — and why 20 kbps

Checked against Meta's Cloud API documentation (audio messages and supported media types):

- WhatsApp shows a file as a real **voice message** (microphone icon, waveform, optional transcription) only
  if it is **`.ogg` with the OPUS codec** — `audio/ogg` without Opus is not accepted, and the Opus input must
  be **mono**. mp3 / m4a / aac / amr are accepted but arrive as an **audio file** (music icon, manual play).
- Audio is capped at **16 MB**, and **the play button appears only for files of 512 KB or less** — larger
  ones show a download icon. That is what fixes the bitrate: 20 kbps Opus (`voip` tuning, plenty for speech)
  is ~2.5 KB/s, so 512 KB ≈ 200 s, and the 3000-character default cap (≈ 3 min of speech) stays inside it.
  32 kbps (~128 s) would not.
- What a *phone* actually draws (waveform vs. file, play vs. download) cannot be checked from the box — the
  first live voice reply is that test.

### It needs `addons/voice` with an on-box TTS and ffmpeg with libopus

| | needed | if it is missing |
|---|---|---|
| `addons/voice` enabled + `ATLAS_VOICE_TTS_CMD` set to a working engine (text on stdin → audio on stdout, e.g. a wrapper around edge-tts, piper, kokoro) | speech | `/api/voice/speak` answers `503`/`404` → **text**, `ttsErrors` |
| `ffmpeg` on `PATH` **with `libopus`** | re-encoding to OGG/Opus | ffmpeg not found, or failing → **text**, `ffmpegErrors` |
| Meta accepts the upload and the audio message | delivery | upload or send refused → **text**, `uploadErrors` (Meta's status and text in the log) |

The browser's own speech synthesis — the voice addon's zero-install default — is no use here.
**Every** failure ends in the ordinary text message, **once**: there is no retry loop, and the operator
always gets the answer. `voiceFallbacks` counts every time that happened.
(One corner: if Meta accepted the voice note but the answer was lost on the way back, the text goes out
as well — a duplicate beats a lost reply.)

### Two length limits — and how they relate to `ATLAS_VOICE_MAX_SPOKEN_CHARS`

| | default | env | what it does |
|---|---|---|---|
| per TTS call | **700** | `WHATSAPP_MAX_SPOKEN_CHARS` | the text is cut at paragraph, then sentence, then (one endless sentence) word boundaries into pieces of at most this many characters; each is read separately and the clips are joined into one voice note |
| whole reply | **3000** (≈ 3 min) | `WHATSAPP_MAX_VOICE_CHARS` | above this **nothing is read aloud**: the text goes out as a normal message, `mode:"text"`, with the reason in `voiceError`. A phone chat does not need a ten-minute monologue |

⚠️ **`WHATSAPP_MAX_SPOKEN_CHARS` and the voice addon's `ATLAS_VOICE_MAX_SPOKEN_CHARS` (default 700)
belong together.** `/api/voice/speak` **silently cuts** any longer text at that limit — no error — so a
reply would just stop mid-sentence. The bridge therefore never sends more than its own limit per call.
The addon does not read the voice addon's setting: if you raise `ATLAS_VOICE_MAX_SPOKEN_CHARS`, raise this
one to match (fewer, longer pieces); **never set this one higher** than the voice addon's. (Values under 50
are ignored — a runaway number of TTS calls is never what anyone meant.)

Timeouts: `WHATSAPP_TTS_TIMEOUT_MS` (30 s per piece; the voice route kills its engine after
`ATLAS_VOICE_TTS_TIMEOUT_MS`, 20 s, so this stays **above** it and the route's precise error wins),
`WHATSAPP_FFMPEG_TIMEOUT_MS` (60 s), and `WHATSAPP_MEDIA_TIMEOUT_MS` (30 s) also covers the upload.
The pieces are read one after the other, so a long reply takes a few seconds per piece before it is sent.

### Temp files, status, and the agent

ffmpeg needs files: each reply gets one `mkdtemp` directory under the OS temp dir (`TMPDIR`), removed in a
`finally` — also when anything fails. Nothing goes to the vault or the repo.

`GET /api/addons` shows `voiceReplies` — `synthesis` (`ready`, `NOT AVAILABLE — <why>`, or `unknown` for
the first answer after a restart), `ffmpeg` (found on `PATH`), `maxSpokenChars`, `maxVoiceChars` — and the
counters `voiceSent`, `voiceFallbacks`, `ttsErrors`, `ffmpegErrors`, `uploadErrors` (`uploadErrors` counts
Meta refusing either the media upload or the audio message). A disabled voice addon only makes
`synthesis` read `NOT AVAILABLE — the voice addon is not enabled`. `bash addons/whatsapp/install.sh --check`
reports the same, plus whether ffmpeg has `libopus` (a fact only it can see).

**Telling the agent.** A session created **after** this change is briefed (`sessionBrief()` in
`api/agent.mjs`): `voice: true` sends a voice note; **mirror the medium** by default (a
`[Sprachnachricht, transkribiert] …` message gets a voice note, a typed one gets text) unless the
operator asks otherwise; short, spoken sentences, no bullets; never voice links, long numbers, IDs or code —
send those as text; and the length cap. ⚠️ The **already running session keeps its old brief** (it only
knows text) — until it is closed and the next message spawns a fresh one, it will not use `voice`.

## Security model

| what | how it is protected |
|---|---|
| `POST …/webhook` (public, called by Meta) | `X-Hub-Signature-256` = HMAC-SHA256 of the **raw** body with `WHATSAPP_APP_SECRET`, constant-time. **No secret set → the route refuses (503)**, it never waves a request through. |
| `GET …/webhook` (handshake) | `hub.verify_token` compared in constant time to `WHATSAPP_VERIFY_TOKEN`; an unset token never matches. |
| who may talk to the agent | `WHATSAPP_ALLOWED_FROM` only. Anyone else is dropped **silently** (no reply, so no sign the number is live) and counted. An empty list accepts nobody. |
| `POST …/send` | `DASHBOARD_BEARER_TOKEN`, constant-time — and `to` must be in the allowlist, so a prompt-injected agent cannot message arbitrary numbers (voice or text alike). |

Add to that: the webhook path is the **only** thing you expose publicly, its body is
capped at 256 KB, and it answers `200` immediately and works afterwards (Meta retries
anything slower).

## Enable — step by step

The first four steps are the Meta console (its UI moves around; the names below are
what to look for). Steps 5–9 are on your box.

### 1. Create the app
[developers.facebook.com](https://developers.facebook.com/) → **My Apps → Create App**
→ use case **Other → Business** → give it a name → on the app dashboard **Add product →
WhatsApp → Set up**. Meta creates a *test WhatsApp Business Account* with a free **test
number**. (You need a Meta business portfolio; the wizard offers to create one.)

### 2. Phone number ID, a first token and your recipient
**WhatsApp → API Setup**:
- **Phone number ID** (under *From*) → `WHATSAPP_PHONE_NUMBER_ID`. It is *not* the phone number.
- **Temporary access token** → `WHATSAPP_ACCESS_TOKEN` (valid ~24 h — good for a first test).
- Under *To*, **Manage phone number list** → add **your own** number and confirm the SMS/WhatsApp
  code. (The test number can only message numbers on this list — max 5.)

### 3. A permanent token (skip while you are only testing)
[business.facebook.com/settings](https://business.facebook.com/settings) → **Users → System users →
Add** (role *Admin*) → **Add assets** → your app, with *Manage app* → **Generate new token** →
that app, expiry **Never**, permissions `whatsapp_business_messaging` and
`whatsapp_business_management` → copy it into `WHATSAPP_ACCESS_TOKEN`. The system user must
also be assigned your WhatsApp Business Account (*Accounts → WhatsApp accounts → Add people*).

### 4. App secret
**App settings → Basic → App secret → Show** → `WHATSAPP_APP_SECRET`.
This is what signs every webhook call; without it the webhook refuses everything.

### 5. Your side of the config (`.env`, never the repo)
```bash
WHATSAPP_VERIFY_TOKEN=$(openssl rand -hex 24)   # you invent it; Meta gets the same string in step 7
WHATSAPP_APP_SECRET=…                            # step 4
WHATSAPP_ACCESS_TOKEN=…                          # step 2 / 3
WHATSAPP_PHONE_NUMBER_ID=…                       # step 2
WHATSAPP_ALLOWED_FROM=491701234567               # your number, international format, NO "+", comma list
```
Enable the addon — `addons.json` `{"enabled": ["whatsapp"]}` or `ATLAS_ADDONS=…,whatsapp` — and
`scripts/serve.sh restart`. `DASHBOARD_BEARER_TOKEN` must be set (core wants it anyway).

### 6. Let Meta reach the webhook — and only the webhook
Two things, both about exactly one path:

1. **Caddy.** `infra/Caddyfile.example` has two blocks: `handle /api/whatsapp/webhook`
   and `handle /api/whatsapp/*`. **An `infra/Caddyfile` that predates this addon does not
   have them — copy both in by hand** (webhook block first), then `scripts/serve.sh restart`.
   The webhook block does two things the other blocks do not:
   - it **rewrites `Content-Type`** to `application/octet-stream`. Core's global JSON
     parser (`api/src/server.mjs`) would otherwise consume the body before this addon
     runs, and the signature is over the raw bytes — re-serialised JSON is not
     byte-identical (Meta escapes `/` and non-ASCII). With the rewrite, the addon reads the raw
     body itself. **Without it every webhook is refused** (`500`, a log line, and
     `rawBodyMissing` in `GET /api/addons`) — it fails closed, it never trusts an
     unverifiable body.
   - it caps the body at 256 KB.

   It also injects the bearer like its neighbours — only because
   `api/test/addon-caddyfile-bearer.test.mjs` requires that of every non-GET addon route;
   the webhook route never reads `Authorization`, so on this path it is inert.
2. **Cloudflare Access.** Meta holds neither your Google login nor the bearer. In Zero Trust →
   **Access → Applications → Add → Self-hosted**, for your dashboard hostname with **path**
   `api/whatsapp/webhook` (exactly that — no wildcard), add a policy with action **Bypass**,
   include *Everyone*. A more specific path wins over the dashboard's own application, so
   **everything else, including `/api/whatsapp/send`, stays behind your login.** Check from
   outside: `curl -i https://dashboard.<your-domain>/api/whatsapp/send` must still hit the login wall.
   The tunnel needs no change if the dashboard hostname already points at Caddy
   (`infra/cloudflared-config.example.yml`).

`bash addons/whatsapp/install.sh --check` tells you which of env / enabled / Caddy blocks is
still open (it cannot see Cloudflare or Meta).

### 7. Register the webhook in Meta
**WhatsApp → Configuration → Webhook → Edit**:
- **Callback URL:** `https://dashboard.<your-domain>/api/whatsapp/webhook`
- **Verify token:** the exact `WHATSAPP_VERIFY_TOKEN`
- **Verify and save** — Meta now does the `GET` handshake, so the API must already be
  running with the addon enabled and step 6 done. A `403` there means the token does not match.
- Under **Webhook fields**, **Subscribe** to **`messages`**.

### 8. Try it
From the phone whose number is in `WHATSAPP_ALLOWED_FROM`, write to the **test number**
(shown on *API Setup*; save it as a contact). The first message spawns the session
(a few seconds); the answer arrives in the same chat. In the dashboard a new Atlas chat
appears in the agent list.

### 9. If nothing comes back
`curl -s localhost:3001/api/addons | jq '.addons[] | select(.name=="whatsapp")'` shows what is
missing (`inbound`/`outbound` list the unset variables) and the counters:

| counter | meaning |
|---|---|
| `badSignature` rising | wrong `WHATSAPP_APP_SECRET` (a different app's?) |
| `rawBodyMissing` rising | the Caddy webhook block lacks the Content-Type rewrite |
| `dropped` rising | the sender is not in `WHATSAPP_ALLOWED_FROM` (format: digits only, no `+`) |
| `audioReceived` rising but `transcribed` not | see the voice-note table above: `transcribeErrors` → speech recognition (`addons/voice/install.sh --check`); `mediaErrors` → the log line has Meta's status and text (an expired `WHATSAPP_ACCESS_TOKEN` is the usual one) |
| `voiceFallbacks` rising | voice replies are being sent as text: `ttsErrors` → the TTS command (`addons/voice/install.sh --check`); `ffmpegErrors` → `ffmpeg` missing or without `libopus` (`addons/whatsapp/install.sh --check`); `uploadErrors` → Meta refused the upload or the voice note — the log line has its status and text; none of the three → the text was over `WHATSAPP_MAX_VOICE_CHARS` |
| `forwardErrors` rising | the agent routes refused — the API log has the reason; the sender gets a "can't reach the agent" message |
| all zero | Meta is not calling: webhook not subscribed to `messages`, wrong callback URL, or Access still blocking |

Meta rejecting a send (expired token, recipient not on the test list, closed window) is
logged as `[whatsapp] Meta rejected a send: HTTP … (code …): …` and returned by `/send` as
`502` with Meta's own status and text.

## Turning it off

Remove `whatsapp` from `addons.json` / `ATLAS_ADDONS` and restart: no route, no outbound
call. Then delete the webhook in Meta's console and the Access bypass in Cloudflare — those
outlive the addon. The state file and the agent session can be deleted by hand.

## Tests

`node --test addons/whatsapp/test/*.test.mjs` (also part of `cd api && npm test`). Meta, the
transcription and speech routes, the agent routes and ffmpeg are all stubbed; nothing leaves the process,
no ffmpeg runs and no credential is real. (`install.sh --check` is exercised on a copy in a scratch tree.)

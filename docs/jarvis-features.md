# "Jarvis AI" on Instagram — feature catalog

Research input for the dashboard's **Jarvis** tab. Researched 2026-09-17.

## Method

Read-only, from the operator's logged-in Instagram session (Chrome on the Mac, driven over
`ssh mac` + AppleScript, one dedicated tab). Instagram's own web search endpoints were read
from inside that tab — no likes, follows, comments or DMs.

- Keyword searches: `#jarvisai`, `jarvis ai`, `jarvis interface`, `jarvis hud`,
  `jarvis ai assistant`, `jarvis voice assistant`, `#jarvis`, `jarvis python`,
  `jarvis desktop assistant`, `jarvis dashboard` → **152 unique posts**, captions + alt text read.
  Roughly 60 are about a Jarvis-style assistant/UI; the rest are noise (job ads, "Jarvis" as a
  name, cars, Fortnite).
- Hashtag feeds `#jarvisai`, `#jarvisui`, `#jarvisinterface`, `#jarvisassistant` (top + recent,
  mostly reels) → **83 more unique posts**; about 20 are real Jarvis-assistant builds, the rest are
  memes, a Nigerian influencer named Jarvis, and a 2018 French smart-home brand (`mysmartjarvis`).
- Deep read (every carousel slide's alt text/OCR + top comments) of the 13 most relevant posts.
- Reels are video-only: for those only caption and alt text were available, no on-screen text.
  A planned deeper pass over 8 reels did not run — the Mac went offline mid-research.
- Comments on these posts are almost entirely the keyword ("Jarvis", "Roadmap") people type
  to get a DM guide, so they describe nothing about the UI; the captions and slide text do.

"Seen" counts are the number of distinct relevant posts that show or describe the feature.

## Catalog

| # | Feature | What it does / looks like | Seen | Examples |
|---|---|---|---|---|
| 1 | **Voice in (push-to-talk / STT)** | Hold a key or a bar, speak, local STT (Whisper, Vosk) transcribes. "Your voice is the interface." | 16 | [ibraviz.ai](https://www.instagram.com/p/DbtpVG-GKO8/), [linusekenstam.ai](https://www.instagram.com/p/DcaaljsjHTA/) |
| 2 | **Voice out (TTS, calm British butler)** | Answers are read aloud; "English butler" voice, "At your service, sir." Piper / ElevenLabs / edge-tts named. | 15 | [zubair_trabzada](https://www.instagram.com/p/Dby0x56CWzY/), [aiwithsampad](https://www.instagram.com/p/DcbDOHJj0pq/) |
| 3 | **Wake word "Jarvis"** | Always-listening trigger word before a command. | 6 | [zubair_trabzada](https://www.instagram.com/p/Dby0x56CWzY/), [vision.cero](https://www.instagram.com/p/DcgxmjYCKK0/) |
| 4 | **One dark HUD screen ("the face")** | A single dark terminal-style dashboard, "one screen, no tabs": system vitals, command deck, agenda, audio I/O meter, live vault data. The prompt is literally "Build a dark terminal HUD for my OS: system vitals, command deck, schedule, audio I/O, live data from the vault". | 12 | [ibraviz.ai](https://www.instagram.com/p/DbtpVG-GKO8/) (slide 8), [lukegarvai](https://www.instagram.com/p/Db9RhB0CsGS/) |
| 5 | **System vitals (CPU/RAM/status)** | "System status" / "system vitals" panel; "SYSTEM ONLINE" banner with date/time. | 7 | [jarvis.core_ai](https://www.instagram.com/p/DdYVf2AuXa6/), [crazystormchick10](https://www.instagram.com/p/DaqV6VnOYpy/) |
| 6 | **Greeting + clock/date** | "Good evening, Boss — how can I help you today?", time-of-day greeting next to a clock. | 5 | [jarvis.core_ai](https://www.instagram.com/p/DdYVf2AuXa6/), [crazystormchick10](https://www.instagram.com/p/DaqV6VnOYpy/) |
| 7 | **Morning brief** | At 07:00 "Morning brief": inbox, calendar, AI/market news read out loud. | 8 | [ibraviz.ai](https://www.instagram.com/p/DbtpVG-GKO8/) (slide 9), [code.with.adnan](https://www.instagram.com/p/DdMQ4A7CUgz/) |
| 8 | **Calendar / schedule / agenda panel** | Reads the real calendar, books meetings by voice, "am I free tomorrow?". | 11 | [erick.killmonger](https://www.instagram.com/p/DZszPPJEREQ/), [n8nstack](https://www.instagram.com/p/DaT83lOhkz8/) |
| 9 | **To-do / priorities ("plan today")** | "Top 3 priorities land in the vault", task management, reminders. | 10 | [lukegarvai](https://www.instagram.com/p/Db9RhB0CsGS/), [growth__os](https://www.instagram.com/p/Da9uxDrRp0h/) |
| 10 | **Memory vault (notes as linked markdown)** | Obsidian vault as memory; "if it's not in the vault, it didn't happen"; search answers from your own notes; 3D "galaxy" graph of notes. | 12 | [zubair_trabzada](https://www.instagram.com/p/Dby0x56CWzY/) (slide 2), [meghana.ai](https://www.instagram.com/p/DcELwxbAaou/) |
| 11 | **Skills / agents routing ("command deck")** | "You speak, JARVIS routes the work" to the right skill/agent; multi-agent workspaces running in parallel; "AI Command Center — the whole agency runs through this". | 14 | [alassafi.ai](https://www.instagram.com/p/DdErr18k70f/), [launch.automation](https://www.instagram.com/reel/DYnQB7yvhUq/) |
| 12 | **Metrics pull** | Numbers dashboard: sales, leads, followers, spend. | 5 | [ibraviz.ai](https://www.instagram.com/p/DbtpVG-GKO8/), [lukegarvai](https://www.instagram.com/p/Db9RhB0CsGS/) |
| 13 | **News / web info** | AI news in the brief, web search, weather & web info. | 6 | [jarvis.core_ai](https://www.instagram.com/p/DdYVf2AuXa6/), [hermannndamenai](https://www.instagram.com/p/DYh-zPZlTUh/) |
| 14 | **Weather** | Weather tile/answer. | 4 | [jarvis.core_ai](https://www.instagram.com/p/DdYVf2AuXa6/), [aiwithshivang](https://www.instagram.com/reel/DaFvyuph1_V/) |
| 14b | **Live stocks / markets** | Market tile next to news and weather. | 3 | [aiwithshivang](https://www.instagram.com/reel/DaFvyuph1_V/), [ibraviz.ai](https://www.instagram.com/p/DbtpVG-GKO8/) (brief) |
| 15 | **Email triage / drafting** | Inbox prioritised, replies drafted, "EMAIL DRAFTED — ready to send". | 7 | [code.with.adnan](https://www.instagram.com/p/DdMQ4A7CUgz/), [n8nstack](https://www.instagram.com/p/DaT83lOhkz8/) |
| 16 | **Chat log / transcript** | A conversation window with the assistant's replies. | 6 | [alassafi.ai](https://www.instagram.com/p/DdErr18k70f/), [jarvis.core_ai](https://www.instagram.com/p/DdYVf2AuXa6/) |
| 17 | **Reactive orb / sphere** | Glowing orb or particle sphere as the assistant's "body" that pulses while listening/speaking; collapses to a floating orb when minimised. The most-viewed build reel (242k views) is this kind of open-source voice sphere. | 4 | [kintsugiindustries](https://www.instagram.com/reel/DbCJrT5OWNw/), [adamdesgns](https://www.instagram.com/p/Da0gc2ikTIl/) |
| 18 | **PC / app control** | Open apps & websites, desktop automation, screenshots, browser control. | 13 | [jarvis.core_ai](https://www.instagram.com/p/DdYVf2AuXa6/), [hermannndamenai](https://www.instagram.com/p/DYh-zPZlTUh/) |
| 19 | **Camera / screen vision** | Camera vision, screen reading, OCR, gesture control via OpenCV. | 6 | [techgptx.ai](https://www.instagram.com/p/Db4yA4xvMnT/), [airesearches](https://www.instagram.com/p/C4S2GfZMY8w/) |
| 20 | **Smart-home / device control** | Lights, sensors, GPIO, speakers via voice. | 7 | [technology](https://www.instagram.com/p/DRZwiVjDYt-/), [botvin.exp](https://www.instagram.com/p/DRw1CmTjPTt/) |
| 21 | **Phone / telephony** | Voice notes via Telegram, real phone calls, hotline. | 3 | [zubair_trabzada](https://www.instagram.com/p/Dby0x56CWzY/) |
| 22 | **Holographic cyan-on-black look** | Iron-Man HUD motion graphics, cyan glow, rings, hologram tables, transparent OLED. | 14 | [jan_hamernik_props](https://www.instagram.com/p/Bvz6kT0HQes/), [aicouncillor](https://www.instagram.com/p/Dbqq2lbEhln/) |
| 23 | **Local / private by default** | "No cloud, no API key, audio never leaves the machine." Framed as a feature. | 10 | [hermannndamenai](https://www.instagram.com/p/DYh-zPZlTUh/), [code.with.adnan](https://www.instagram.com/p/DdMQ4A7CUgz/) |

## Notable pattern

The dominant 2026 format (ibraviz.ai 14.7k likes, jackroberts___, lukegarvai, linusekenstam.ai,
meghana.ai, luissbroggio, agustinmedinaia — one template copied across accounts) is
**"Jarvis OS in 4 parts": Claude Code = engine, Obsidian = memory, local voice = ears + mouth,
one HUD = face.** That is almost exactly what Atlas Kit already is (Claude Code agents, the
Atlas vault, the `voice` addon with piper). The Jarvis tab is the missing "face".

Critics in the same feed (mattganzak, agentic.shokh, alassafi.ai) point out most Jarvis
dashboards "look incredible, run nothing" — a reason to wire every tile to real data.

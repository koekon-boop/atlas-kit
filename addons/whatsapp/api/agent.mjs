/* ------------------------------------------------------------------ *
 * The agent side of the bridge: one dedicated knowledge session on the `atlas`
 * vault PER SENDER, each created on that number's first message and reused after.
 *
 * It rides CORE's routes over loopback — POST /api/agents/spawn, /prompt,
 * /queue and GET /api/agents — and adds no agent mechanics of its own. The
 * session ids are remembered in a small JSON file in the state dir, not the repo
 * and not the vault:
 *   { "senders": { "<number>": { sessionId, createdAt, lastInboundAt } }, "lastInboundAt": … }
 * (`lastInboundAt` per sender because Meta's 24 h window is per user; the top-level
 * one is just "last message from anyone".) A file in the old single-session shape
 * `{ sessionId, createdAt, lastInboundAt }` is migrated on first read: that session
 * becomes the FIRST number of WHATSAPP_ALLOWED_FROM's, so a running chat carries on.
 *
 * 🔴 REPLIES ARE PUSHED, NEVER SCRAPED. Nothing reads the session's terminal
 * transcript. The session is told, in `sessionBrief()`, to answer by POSTing to
 * `/api/whatsapp/send`. That instruction is the heart of the bridge: a session
 * that answers in the terminal is a message nobody ever sees.
 *
 * 🔴 EVERY SEND MUST CARRY `to`. The send route's default (no `to`) is the FIRST
 * allowlisted number; with several people, a reply without `to` lands in the
 * wrong chat. The brief names the session's own number and makes `to` mandatory.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import path from 'node:path'
import { allowedFrom, config, maskNumber, normalizeNumber, stateFile } from './config.mjs'

const DAY_MS = 24 * 60 * 60 * 1000

function readRaw(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {}
  } catch {
    return {}
  }
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

/** The old single-session file → the per-sender shape, the session going to the FIRST
 *  allowlisted number (the operator's). null when there is nothing to migrate: the file
 *  is already in the new shape, holds nothing, or no number is allowed yet. */
function migrated(raw, allowed) {
  if (isObj(raw.senders) || !allowed[0] || !(raw.sessionId || raw.lastInboundAt)) return null
  const { sessionId, createdAt, lastInboundAt, ...rest } = raw
  const mine = Object.fromEntries(Object.entries({ sessionId, createdAt, lastInboundAt }).filter(([, v]) => v))
  return { ...rest, ...(lastInboundAt ? { lastInboundAt } : {}), senders: { [allowed[0]]: mine } }
}

/** The state in the per-sender shape, in memory only. Never throws: an absent or
 *  unreadable file is the first-run state. */
export function readState(file = stateFile(), allowed = allowedFrom()) {
  const raw = readRaw(file)
  return migrated(raw, allowed) ?? { ...raw, senders: isObj(raw.senders) ? raw.senders : {} }
}

/** readState, plus the one-time write-back of a migrated file. */
export function loadState(file, allowed) {
  const raw = readRaw(file)
  const m = migrated(raw, allowed)
  if (!m) return readState(file, allowed)
  saveState(m, file)
  return m
}

/** Stamp the sender's own message time (opens THEIR 24 h window) and the global one. */
export function markInbound(from, { file, allowed }) {
  const st = loadState(file, allowed)
  const at = new Date().toISOString()
  saveState({ ...st, lastInboundAt: at, senders: { ...st.senders, [from]: { ...st.senders[from], lastInboundAt: at } } }, file)
}

/** One row per allowlisted number for status() and install.sh --check: masked number,
 *  the name if one is configured, session id, since when, and whether Meta's window is open. */
export function senderSessions({ allowed = allowedFrom(), names = {}, file = stateFile(), now = Date.now() } = {}) {
  const st = readState(file, allowed)
  return allowed.map((n) => {
    const e = st.senders[n] || {}
    const last = e.lastInboundAt ? Date.parse(e.lastInboundAt) : NaN
    return {
      number: maskNumber(n),
      ...(names[n] ? { name: names[n] } : {}),
      session: e.sessionId || 'none yet (created on the first message)',
      since: e.createdAt || null,
      lastInboundAt: e.lastInboundAt || null,
      windowOpen: Number.isFinite(last) ? now - last < DAY_MS : null,
    }
  })
}

/** tmp + rename, like the other addons' state. Returns false (loudly) rather
 *  than throwing — a lost bookmark costs one fresh session per sender, not a message. */
export function saveState(state, file = stateFile()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 })
    fs.renameSync(tmp, file)
    return true
  } catch (e) {
    console.error(`[whatsapp] could not write the state file (${file}): ${e.message}`)
    return false
  }
}

/** What the session is told when it is created (the same rule rides along, in
 *  one line, with every message after — a long chat compacts, the rule must
 *  survive it). With a `number` (and optionally a `name`) the brief is ONE person's: it
 *  names that number and makes `"to"` mandatory on every send. Without one it is the
 *  single-operator brief. */
export function sessionBrief({ port = '3001', maxVoiceChars = 3000, number, name } = {}) {
  const url = `http://127.0.0.1:${port}/api/whatsapp/send`
  const you = number ? 'the person you are talking to' : 'the operator'
  const to = number ? `"to":"${number}",` : ''
  const intro = number
    ? `You are talking to ${name ? `${name} (WhatsApp number ${number})` : `the person on WhatsApp number ${number}`}. This chat is theirs alone: other people have their own separate sessions on this bridge — never relay or mention what anyone else wrote.`
    : `You are now the operator's Atlas agent on WhatsApp.`
  const toRule = number
    ? `🔴 EVERY send carries "to":"${number}" — no exception, whatever the message. This session belongs to ${number}. Without "to" the route sends to a DEFAULT number, and when several people use this bridge that is somebody else's chat: a reply without "to" is read by the wrong person. Never put any other number in "to".`
    : `Add "to":"<number>" only to reach a number other than the sender; it defaults to the operator's own.`
  return `WhatsApp channel — a standing chat session with ${you}.

${intro} Each user turn that starts with "[WhatsApp from <number>]" is a message ${you} just sent from their phone — usually typed text. If the text after it starts with "[Sprachnachricht, transkribiert]", it was a VOICE NOTE, transcribed on the box by speech recognition — expect the odd misheard word or name, and when a name, number or date matters and the transcript looks off, ask back in one short line instead of guessing. Decide how to answer by the rule under VOICE REPLIES below. This session lives on; more messages will arrive over time.

PICTURES, VIDEOS AND DOCUMENTS — ${you} can send files too. They arrive as LOCAL FILES on this box, and the marker at the start of the message gives you their PATHS:
- "[Bild empfangen: <path>] <caption>" — a photo. "[Dokument empfangen: <path>, 3 Seiten] <caption>" — a document (a PDF, or a Word/Excel/text file; the page count is only there when it could be read).
- "[Video empfangen: <path>, 12 s] <caption>" — a VIDEO, but you do NOT get the film. It arrives as a few stills spread evenly over its whole length ("Einzelbilder (n, …): <path>, <path>, …", in playing order) plus the transcript of its soundtrack ("Tonspur, transkribiert: "…"", like a voice note — expect misheard words). No "Tonspur" line means it has no sound or nobody spoke. If the marker says "gekürzt", only the first part of the soundtrack was transcribed; the stills still cover the whole video.
- The text after the marker's "]" is the caption ${you} wrote with it (there may be none).
- The paths are local files: LOOK AT THEM with your normal tools (read the image or the PDF yourself) BEFORE you answer — never guess what is in a file from its name or caption. If a file cannot be opened, say so in one line instead of inventing what it shows.
- Files are kept on the box for a while (about two weeks) and then deleted: copy anything into the vault only when ${you} asks for it, and never mention a path to ${you} as if they could open it.
- Answer these as text, unless ${you} asks otherwise.

HOW YOU ANSWER — read this twice. NOBODY reads this terminal. ${number ? 'They see' : 'The operator sees'} ONLY what you send through the send route, so for EVERY WhatsApp message your last step is to POST your reply:

curl -sS -X POST ${url} -H "Authorization: Bearer $DASHBOARD_BEARER_TOKEN" -H 'content-type: application/json' --data-binary @- <<'EOF'
{${to}"text":"your reply here"}
EOF

The body is JSON: escape double quotes as \\" and line breaks as \\n inside "text". (The quoted heredoc keeps apostrophes and $ signs safe; the equivalent -d '{${to}"text":"..."}' works if your text has no single quote.) The route answers {"ok":true,...}. If it answers ok:false, read the error — one retry at most, never a loop. If the error says the 24-hour window is closed, ${you} has to message first; give up quietly.
${toRule}

VOICE REPLIES — you can answer as a spoken WhatsApp voice note instead of text: add "voice":true to the same body, {${to}"text":"your reply here","voice":true}. The box reads "text" aloud (one voice that speaks German and English) and sends it as a voice note.
- Default rule: MIRROR THE MEDIUM. A message that came as "[Sprachnachricht, transkribiert] …" gets a voice reply; a typed message gets a text reply. Deviate when ${you} asks ("schick es mir als Text", "sprich es mir vor").
- Write for the ear: a few short spoken sentences, about a minute at most (roughly 1000 characters). Above ${maxVoiceChars} characters nothing is read aloud — the route sends plain text instead. No bullet points, markdown, emoji or tables: they are read out or mangled.
- Do NOT put links, long numbers, IDs, code or anything ${you} has to read exactly or copy into a voice note — send that as text, in addition to a short spoken answer or instead of it (two POSTs).
- The route's answer tells you what went out: "mode":"voice" — a voice note was sent. "mode":"text" with "voiceError" — voice failed or was too long and your text was sent instead; ${you} has the answer, do not send it again.

HOW YOU WRITE — it is a phone chat, read on the go:
- Short and spoken: usually 1–4 sentences, the answer first, no preamble, no sign-off.
- Plain text only. No tables, no code blocks, no headings, no markdown links. A bullet list only when the content really is a list; *bold* sparingly.
- Reply in the language of the message (German in, German out).
- Long content is not a reason for a long message: give the gist and offer more.
- Never paste secrets, tokens, or long vault excerpts.
- One reply per message. If several arrived while you worked, answer them together in one reply. For a task that will take minutes, send one short "on it" first, then the result — no other progress chatter.

WHAT YOU CAN DO — everything the Atlas agent can: search and read the vault, look things up, do a chore and report back. For a question about ${number ? 'their' : "the operator's"} world, search the Atlas before you answer. Do not write to the vault unless ${you} asked you to.

If a message needs no answer ("ok", "thanks"), a very short acknowledgement is enough — or none.`
}

/** One line per forwarded message: who wrote, what, and the reply rule again — with the
 *  `to` that must ride along (a long chat compacts the brief away; this line stays). */
export const framed = (from, text) =>
  `[WhatsApp from ${from}] ${text}\n\n(Reply with a POST to /api/whatsapp/send with "to":"${from}" — the terminal is not read.)`

async function core(method, route, body, { env, fetch: f }) {
  const c = config(env)
  const r = await f(`${c.apiBase}${route}`, {
    method,
    headers: { Authorization: `Bearer ${c.bearer}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j?.ok !== false, status: r.status, body: j }
}

/**
 * Hand one message to the SENDER'S OWN session, creating it if there is none.
 *   no remembered id for this number, or it is gone/finished → spawn (the message is the first turn)
 *   session idle                                              → /prompt
 *   session running (or /prompt refused)                      → /queue, delivered at its next boundary
 * → `{ ok, via: 'spawn'|'prompt'|'queue', id }` or `{ ok: false, error }`. Never throws.
 */
export async function forwardToAgent({ from: rawFrom, text }, deps = {}) {
  const d = { env: process.env, fetch: globalThis.fetch, file: undefined, ...deps }
  const c = config(d.env)
  if (!c.bearer) return { ok: false, error: 'DASHBOARD_BEARER_TOKEN is not set — cannot call the agent routes' }
  const file = d.file ?? stateFile(d.env)
  const from = normalizeNumber(rawFrom)
  try {
    const state = loadState(file, c.allowedFrom)
    const mine = state.senders[from] || {}
    let live = null
    if (mine.sessionId) {
      const list = await core('GET', '/api/agents', null, d)
      if (!list.ok) return { ok: false, error: `GET /api/agents → ${list.status}` }
      live = (list.body.sessions || []).find((s) => s.id === mine.sessionId) || null
      // done = its tmux is gone; error = it never started; dormant = parked by a
      // tmux death. None can take a prompt, so a fresh session takes over.
      if (live && ['done', 'error', 'dormant'].includes(live.status)) live = null
    }
    if (!live) {
      const brief = sessionBrief({ port: c.apiPort, maxVoiceChars: c.maxVoiceChars, number: from, name: c.senderNames[from] })
      const task = `${brief}\n\n---\nFirst message:\n${framed(from, text)}`
      const r = await core('POST', '/api/agents/spawn', { task, kind: 'knowledge', vault: 'atlas' }, d)
      if (!r.ok || !r.body.id) return { ok: false, error: `spawn → ${r.status} ${r.body?.error || ''}`.trim() }
      saveState({ ...state, senders: { ...state.senders, [from]: { ...mine, sessionId: r.body.id, createdAt: new Date().toISOString() } } }, file)
      return { ok: true, via: 'spawn', id: r.body.id }
    }
    const message = { id: live.id, text: framed(from, text) }
    if (live.status !== 'running') {
      const p = await core('POST', '/api/agents/prompt', message, d)
      if (p.ok) return { ok: true, via: 'prompt', id: live.id }
      // e.g. 409 while a choice menu is open — queueing still gets it there.
    }
    const q = await core('POST', '/api/agents/queue', message, d)
    if (q.ok) return { ok: true, via: 'queue', id: live.id }
    return { ok: false, error: `queue → ${q.status} ${q.body?.error || ''}`.trim() }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

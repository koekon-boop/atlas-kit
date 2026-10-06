/* ------------------------------------------------------------------ *
 * The agent side of the bridge: ONE standing knowledge session on the `atlas`
 * vault, created on the first message and reused after — unlike addons/whatsapp
 * (one session per sender), this bridge is the operator's single Telegram chat
 * with the Atlas agent, even when a second chat id is allowlisted alongside it.
 *
 * It rides CORE's routes over loopback — POST /api/agents/spawn, /prompt,
 * /queue and GET /api/agents — and adds no agent mechanics of its own. The
 * session id is remembered in a small JSON file in the state dir, not the repo
 * and not the vault: { sessionId, createdAt, lastInboundAt }.
 *
 * 🔴 REPLIES ARE PUSHED, NEVER SCRAPED. Nothing reads the session's terminal
 * transcript. The session is told, in `sessionBrief()`, to answer by POSTing to
 * `/api/telegram/send`. That instruction is the heart of the bridge: a session
 * that answers in the terminal is a message nobody ever sees.
 *
 * ROUTING PER CHAT (TELEGRAM_CHAT_ROUTES, see config.mjs and the README): a chat
 * id can instead be pinned to an EXISTING dashboard session that is not this
 * bridge's own — e.g. Jessi's chat always feeding her `kb-shop-setup` knowledge
 * session, as if Telegram were just another channel into that one base. This
 * addon never spawns a session for a route and never redirects one elsewhere:
 *   target idle/running  → /prompt or /queue, exactly like the standing session
 *   target dormant       → POST /api/agents/revive, then deliver
 *   target closed/unknown → there is NO core route that recreates a purged session
 *                           id resumed from a Claude session uuid (checked — see
 *                           the README), so the message is STORED (state.routes.
 *                           <chat id>.pending) and the sender is told plainly;
 *                           it is retried — in order, nothing skipped — on the
 *                           next message from that chat AND on every poller tick
 *                           (register.mjs wires inbound.flushRoutes() into
 *                           poller.mjs's onTick), so it reaches the base even if
 *                           the sender never writes again.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import path from 'node:path'
import { config, maskChatId, stateFile } from './config.mjs'

/** The state, in memory only. Never throws: an absent or unreadable file is the first-run state. */
export function readState(file = stateFile()) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {}
  } catch {
    return {}
  }
}

/** tmp + rename, like the other addons' state. Returns false (loudly) rather
 *  than throwing — a lost bookmark costs one fresh session, not a message. */
export function saveState(state, file = stateFile()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 })
    fs.renameSync(tmp, file)
    return true
  } catch (e) {
    console.error(`[telegram] could not write the state file (${file}): ${e.message}`)
    return false
  }
}

/** Stamp the last inbound message time (opens the reply window bookkeeping cares about elsewhere). */
export function markInbound(file = stateFile()) {
  saveState({ ...readState(file), lastInboundAt: new Date().toISOString() }, file)
}

/** What status() and install.sh --check show: the session id, since when, last message. */
export function sessionInfo({ file = stateFile() } = {}) {
  const st = readState(file)
  return {
    session: st.sessionId || 'none yet (created on the first message)',
    since: st.createdAt || null,
    lastInboundAt: st.lastInboundAt || null,
  }
}

/** One route's bookkeeping — never the session id (that is config, from
 *  TELEGRAM_CHAT_ROUTES, not state): how many messages made it through, when the
 *  last one did, and what is still waiting because the target was unreachable. */
function routeState(state, chatId) {
  return (state.routes && state.routes[chatId]) || { forwarded: 0, lastDeliveredAt: null, pending: [] }
}

/** `state` with one route's bookkeeping replaced — pure, so the caller decides when to persist. */
function withRoute(state, chatId, patch) {
  return { ...state, routes: { ...(state.routes || {}), [chatId]: { ...routeState(state, chatId), ...patch } } }
}

/** What status() shows per configured route: masked chat id, its target session,
 *  how many messages got through, the last delivery, and how many are still queued. */
export function routeInfo({ routes, file = stateFile() } = {}) {
  const state = readState(file)
  return Object.entries(routes).map(([chatId, route]) => {
    const rs = routeState(state, chatId)
    return {
      chat: maskChatId(chatId),
      session: route.sessionId,
      ...(route.claudeSessionId ? { claudeSession: route.claudeSessionId } : {}),
      forwarded: rs.forwarded,
      lastDeliveredAt: rs.lastDeliveredAt,
      pending: rs.pending.length,
    }
  })
}

/** What the session is told when it is created (the same rule rides along, in
 *  one line, with every message after — a long chat compacts, the rule must
 *  survive it). */
export function sessionBrief({ port = '3001', maxVoiceChars = 3000, homeChatId, otherChats = [] } = {}) {
  const url = `http://127.0.0.1:${port}/api/telegram/send`
  const several = otherChats.length > 0
  const chatIdField = several ? `"chat_id":"<the chat id from the marker, when replying to someone other than the home chat>",` : ''
  return `Telegram channel — a standing chat session with the operator.

You are now the operator's Atlas agent on Telegram${homeChatId ? ` (home chat ${homeChatId})` : ''}. Each user turn that starts with "[Telegram from <chat id>]" is a message just sent from Telegram — usually typed text. If the text after it starts with "[Sprachnachricht, transkribiert]", it was a VOICE NOTE, transcribed on the box by speech recognition — expect the odd misheard word or name, and when a name, number or date matters and the transcript looks off, ask back in one short line instead of guessing. Decide how to answer by the rule under VOICE REPLIES below. This session lives on; more messages will arrive over time.
${several ? `\nMORE THAN ONE CHAT IS ALLOWED — by default your reply goes to the HOME chat (${homeChatId}). Only add "chat_id":"<id>" (the id from that message's own "[Telegram from …]" marker) when you want to answer a DIFFERENT chat than the home one.\n` : ''}
PICTURES, VIDEOS AND DOCUMENTS — you can be sent files too. They arrive as LOCAL FILES on this box, and the marker at the start of the message gives you their PATHS:
- "[Bild empfangen: <path>] <caption>" — a photo. "[Dokument empfangen: <path>, 3 Seiten] <caption>" — a document (a PDF, or a Word/Excel/text file; the page count is only there when it could be read).
- "[Video empfangen: <path>, 12 s] <caption>" — a VIDEO, but you do NOT get the film. It arrives as a few stills spread evenly over its whole length ("Einzelbilder (n, …): <path>, <path>, …", in playing order) plus the transcript of its soundtrack ("Tonspur, transkribiert: "…"", like a voice note — expect misheard words). No "Tonspur" line means it has no sound or nobody spoke. If the marker says "gekürzt", only the first part of the soundtrack was transcribed; the stills still cover the whole video.
- The text after the marker's "]" is the caption you were sent it with (there may be none).
- The paths are local files: LOOK AT THEM with your normal tools (read the image or the PDF yourself) BEFORE you answer — never guess what is in a file from its name or caption. If a file cannot be opened, say so in one line instead of inventing what it shows.
- Files are kept on the box for a while (about two weeks) and then deleted: copy anything into the vault only when asked to, and never mention a path as if it could be opened from the phone.
- Answer these as text, unless asked otherwise.

HOW YOU ANSWER — read this twice. NOBODY reads this terminal. The operator sees ONLY what you send through the send route, so for EVERY Telegram message your last step is to POST your reply:

curl -sS -X POST ${url} -H "Authorization: Bearer $DASHBOARD_BEARER_TOKEN" -H 'content-type: application/json' --data-binary @- <<'EOF'
{${chatIdField}"text":"your reply here"}
EOF

The body is JSON: escape double quotes as \\" and line breaks as \\n inside "text". (The quoted heredoc keeps apostrophes and $ signs safe; the equivalent -d '{${chatIdField}"text":"..."}' works if your text has no single quote.) The route answers {"ok":true,...}. If it answers ok:false, read the error — one retry at most, never a loop.

VOICE REPLIES — you can answer as a spoken Telegram voice note instead of text: add "voice":true to the same body, {${chatIdField}"text":"your reply here","voice":true}. The box reads "text" aloud (one voice that speaks German and English) and sends it as a voice note.
- Default rule: MIRROR THE MEDIUM. A message that came as "[Sprachnachricht, transkribiert] …" gets a voice reply; a typed message gets a text reply. Deviate when asked ("schick es mir als Text", "sprich es mir vor").
- Write for the ear: a few short spoken sentences, about a minute at most (roughly 1000 characters). Above ${maxVoiceChars} characters nothing is read aloud — the route sends plain text instead. No bullet points, markdown, emoji or tables: they are read out or mangled.
- Do NOT put links, long numbers, IDs, code or anything that has to be read exactly or copied into a voice note — send that as text, in addition to a short spoken answer or instead of it (two POSTs).
- The route's answer tells you what went out: "mode":"voice" — a voice note was sent. "mode":"text" with "voiceError" — voice failed or was too long and your text was sent instead; the operator has the answer, do not send it again.

HOW YOU WRITE — it is a phone chat, read on the go:
- Short and spoken: usually 1–4 sentences, the answer first, no preamble, no sign-off.
- Plain text only. No tables, no code blocks, no headings, no markdown links. A bullet list only when the content really is a list; *bold* sparingly (Telegram sends plain text unless you ask the route to use Markdown, which it does not — write for a reader, not a renderer).
- Reply in the language of the message (German in, German out).
- Long content is not a reason for a long message: give the gist and offer more.
- Never paste secrets, tokens, or long vault excerpts.
- One reply per message. If several arrived while you worked, answer them together in one reply. For a task that will take minutes, send one short "on it" first, then the result — no other progress chatter.

WHAT YOU CAN DO — everything the Atlas agent can: search and read the vault, look things up, do a chore and report back. For a question about the operator's world, search the Atlas before you answer. Do not write to the vault unless asked to.

If a message needs no answer ("ok", "thanks"), a very short acknowledgement is enough — or none.`
}

/** One line per forwarded message: who wrote, what, and the reply rule again — a
 *  long chat compacts the brief away; this line stays. */
export const framed = (chatId, text) => `[Telegram from ${chatId}] ${text}\n\n(Reply with a POST to /api/telegram/send — the terminal is not read.)`

/** The equivalent line for a ROUTED chat (see "Routing per chat" below): the target
 *  session is somebody else's existing chat (e.g. a shop-setup knowledge session),
 *  not a Telegram-native session, so it does not already know the reply contract —
 *  this is appended to EVERY message that comes through a route, not just the first. */
export const framedForRoute = (chatId, text, port = '3001') =>
  `[Telegram from ${chatId}] ${text}\n\n(Antwort an diese Person NUR per POST http://127.0.0.1:${port}/api/telegram/send mit {"chat_id":"${chatId}","text":"…"} und Bearer $DASHBOARD_BEARER_TOKEN — das Terminal liest sie nicht. Der Bearer-Token steht in /workspace/.env. Sprachnachricht raus → "voice":true. Kurz, Klartext.)`

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
 * Hand one message to the ONE standing session, creating it if there is none.
 *   no remembered id, or it is gone/finished → spawn (the message is the first turn)
 *   session idle                              → /prompt
 *   session running (or /prompt refused)       → /queue, delivered at its next boundary
 * → `{ ok, via: 'spawn'|'prompt'|'queue', id }` or `{ ok: false, error }`. Never throws.
 */
export async function forwardToAgent({ chatId, text }, deps = {}) {
  const d = { env: process.env, fetch: globalThis.fetch, file: undefined, ...deps }
  const c = config(d.env)
  if (!c.bearer) return { ok: false, error: 'DASHBOARD_BEARER_TOKEN is not set — cannot call the agent routes' }
  const file = d.file ?? stateFile(d.env)
  try {
    const state = readState(file)
    let live = null
    if (state.sessionId) {
      const list = await core('GET', '/api/agents', null, d)
      if (!list.ok) return { ok: false, error: `GET /api/agents → ${list.status}` }
      live = (list.body.sessions || []).find((s) => s.id === state.sessionId) || null
      // done = its tmux is gone; error = it never started; dormant = parked by a
      // tmux death. None can take a prompt, so a fresh session takes over.
      if (live && ['done', 'error', 'dormant'].includes(live.status)) live = null
    }
    if (!live) {
      const brief = sessionBrief({ port: c.apiPort, maxVoiceChars: c.maxVoiceChars, homeChatId: c.homeChatId, otherChats: c.allowedChatIds.filter((x) => x !== c.homeChatId) })
      const task = `${brief}\n\n---\nFirst message:\n${framed(chatId, text)}`
      const r = await core('POST', '/api/agents/spawn', { task, kind: 'knowledge', vault: 'atlas' }, d)
      if (!r.ok || !r.body.id) return { ok: false, error: `spawn → ${r.status} ${r.body?.error || ''}`.trim() }
      saveState({ ...state, sessionId: r.body.id, createdAt: new Date().toISOString() }, file)
      return { ok: true, via: 'spawn', id: r.body.id }
    }
    const message = { id: live.id, text: framed(chatId, text) }
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

/**
 * One already-framed message → a ROUTE's target session. Never spawns, never
 * redirects elsewhere:
 *   not in GET /api/agents, or status 'done'/'error' → `{ ok: false }`, "closed or unknown"
 *   status 'dormant'                                 → POST /api/agents/revive, then /prompt
 *   otherwise                                         → /prompt (idle) or /queue (running),
 *                                                        exactly the standing session's rule
 * → `{ ok: true, via }` | `{ ok: false, error }`. Never throws (the caller catches).
 */
async function tryDeliverOne(sessionId, message, d) {
  const list = await core('GET', '/api/agents', null, d)
  if (!list.ok) return { ok: false, error: `GET /api/agents → ${list.status}` }
  const live = (list.body.sessions || []).find((s) => s.id === sessionId) || null
  if (!live) return { ok: false, error: 'the target session is closed or unknown' }
  if (live.status === 'done' || live.status === 'error') return { ok: false, error: `the target session is ${live.status}` }
  let status = live.status
  if (status === 'dormant') {
    const r = await core('POST', '/api/agents/revive', { id: sessionId }, d)
    if (!r.ok) return { ok: false, error: `revive → ${r.status} ${r.body?.error || ''}`.trim() }
    status = 'idle' // just launched — take a /prompt like a fresh turn, not a /queue
  }
  if (status !== 'running') {
    const p = await core('POST', '/api/agents/prompt', message, d)
    if (p.ok) return { ok: true, via: 'prompt' }
    // e.g. 409 while a choice menu is open, or the resume menu not settled yet — queueing still gets it there.
  }
  const q = await core('POST', '/api/agents/queue', message, d)
  if (q.ok) return { ok: true, via: 'queue' }
  return { ok: false, error: `queue → ${q.status} ${q.body?.error || ''}`.trim() }
}

/**
 * Deliver everything a route has waiting — its PENDING backlog, oldest first, in
 * order, nothing skipped — and stop at the first failure (the remainder stays
 * queued for the next try, never reordered, never dropped). Called both right
 * after a new message is queued (forwardToRoute) and, with nothing new to add,
 * from the poller tick (flushAllRoutes) so a stored message still gets through
 * even if the sender never writes again.
 * → `{ delivered, remaining }`. Never throws.
 */
async function flushPending(chatId, route, d) {
  const file = d.file ?? stateFile(d.env)
  const state = readState(file)
  const rs = routeState(state, chatId)
  let delivered = 0
  if (rs.pending.length) {
    const port = config(d.env).apiPort
    for (const item of rs.pending) {
      const message = { id: route.sessionId, text: framedForRoute(chatId, item.text, port) }
      const r = await tryDeliverOne(route.sessionId, message, d)
      if (!r.ok) break
      delivered++
    }
  }
  const pending = rs.pending.slice(delivered)
  const patch = { forwarded: rs.forwarded + delivered, pending }
  if (delivered) patch.lastDeliveredAt = new Date().toISOString()
  saveState(withRoute(state, chatId, patch), file)
  return { delivered, remaining: pending.length }
}

/**
 * Hand one message to a ROUTE's target — not the standing session. The message is
 * appended to the route's pending backlog first (so nothing is ever lost between
 * "queued" and "delivered"), then `flushPending` tries to clear the whole backlog
 * in order; if the target is unreachable the message simply stays queued.
 * → `{ ok: true }` when the backlog is now empty, else `{ ok: false, error, queued }`
 * (the caller tells the sender their message is stored, not lost). Never throws.
 */
export async function forwardToRoute({ chatId, text }, route, deps = {}) {
  const d = { env: process.env, fetch: globalThis.fetch, file: undefined, ...deps }
  if (!config(d.env).bearer) return { ok: false, error: 'DASHBOARD_BEARER_TOKEN is not set — cannot call the agent routes' }
  const file = d.file ?? stateFile(d.env)
  try {
    const state = readState(file)
    const rs = routeState(state, chatId)
    saveState(withRoute(state, chatId, { pending: [...rs.pending, { text, at: new Date().toISOString() }] }), file)
    const { remaining } = await flushPending(chatId, route, { ...d, file })
    if (remaining === 0) return { ok: true }
    return { ok: false, error: 'the target session is not reachable right now — message stored, will deliver once it is', queued: remaining }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

/**
 * The poller-tick retry: for every CONFIGURED route (not just ones that just wrote),
 * try to clear whatever is still pending. A route with nothing queued costs no
 * network call. One route's failure never stops the others. Never throws.
 */
export async function flushAllRoutes(routes, deps = {}) {
  const d = { env: process.env, fetch: globalThis.fetch, file: undefined, ...deps }
  const file = d.file ?? stateFile(d.env)
  for (const [chatId, route] of Object.entries(routes)) {
    if (!routeState(readState(file), chatId).pending.length) continue
    try {
      await flushPending(chatId, route, { ...d, file })
    } catch (e) {
      console.error(`[telegram] flushing the route for ${maskChatId(chatId)} failed: ${e?.message || e}`)
    }
  }
}

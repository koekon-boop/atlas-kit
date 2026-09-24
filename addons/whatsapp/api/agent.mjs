/* ------------------------------------------------------------------ *
 * The agent side of the bridge: one dedicated knowledge session on the `atlas`
 * vault, created on the first message and reused after.
 *
 * It rides CORE's routes over loopback — POST /api/agents/spawn, /prompt,
 * /queue and GET /api/agents — and adds no agent mechanics of its own. The
 * session id is remembered in a small JSON file in the state dir, not the repo
 * and not the vault.
 *
 * 🔴 REPLIES ARE PUSHED, NEVER SCRAPED. Nothing reads the session's terminal
 * transcript. The session is told, in `sessionBrief()`, to answer by POSTing to
 * `/api/whatsapp/send`. That instruction is the heart of the bridge: a session
 * that answers in the terminal is a message the operator never sees.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import path from 'node:path'
import { config, stateFile } from './config.mjs'

/** Never throws: an absent or unreadable file is the first-run state. */
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
    console.error(`[whatsapp] could not write the state file (${file}): ${e.message}`)
    return false
  }
}

/** What the session is told when it is created (the same rule rides along, in
 *  one line, with every message after — a long chat compacts, the rule must
 *  survive it). */
export function sessionBrief({ port = '3001' } = {}) {
  const url = `http://127.0.0.1:${port}/api/whatsapp/send`
  return `WhatsApp channel — a standing chat session with the operator.

You are now the operator's Atlas agent on WhatsApp. Each user turn that starts with "[WhatsApp from <number>]" is a text message the operator just typed on their phone. This session lives on; more messages will arrive over time.

HOW YOU ANSWER — read this twice. NOBODY reads this terminal. The operator sees ONLY what you send through the send route, so for EVERY WhatsApp message your last step is to POST your reply:

curl -sS -X POST ${url} -H "Authorization: Bearer $DASHBOARD_BEARER_TOKEN" -H 'content-type: application/json' --data-binary @- <<'EOF'
{"text":"your reply here"}
EOF

The body is JSON: escape double quotes as \\" and line breaks as \\n inside "text". (The quoted heredoc keeps apostrophes and $ signs safe; the equivalent -d '{"text":"..."}' works if your text has no single quote.) The route answers {"ok":true,...}. If it answers ok:false, read the error — one retry at most, never a loop. If the error says the 24-hour window is closed, the operator has to message first; give up quietly.
Add "to":"<number>" only to reach a number other than the sender; it defaults to the operator's own.

HOW YOU WRITE — it is a phone chat, read on the go:
- Short and spoken: usually 1–4 sentences, the answer first, no preamble, no sign-off.
- Plain text only. No tables, no code blocks, no headings, no markdown links. A bullet list only when the content really is a list; *bold* sparingly.
- Reply in the language of the message (German in, German out).
- Long content is not a reason for a long message: give the gist and offer more.
- Never paste secrets, tokens, or long vault excerpts.
- One reply per message. If several arrived while you worked, answer them together in one reply. For a task that will take minutes, send one short "on it" first, then the result — no other progress chatter.

WHAT YOU CAN DO — everything the Atlas agent can: search and read the vault, look things up, do a chore and report back. For a question about the operator's world, search the Atlas before you answer. Do not write to the vault unless the operator asked you to.

If a message needs no answer ("ok", "thanks"), a very short acknowledgement is enough — or none.`
}

/** One line per forwarded message: who wrote, what, and the reply rule again. */
export const framed = (from, text) =>
  `[WhatsApp from ${from}] ${text}\n\n(Reply with a POST to /api/whatsapp/send — the terminal is not read.)`

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
 * Hand one message to the WhatsApp session, creating it if there is none.
 *   no remembered id, or it is gone/finished → spawn (the message is the first turn)
 *   session idle                              → /prompt
 *   session running (or /prompt refused)      → /queue, delivered at its next boundary
 * → `{ ok, via: 'spawn'|'prompt'|'queue', id }` or `{ ok: false, error }`. Never throws.
 */
export async function forwardToAgent({ from, text }, deps = {}) {
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
      const task = `${sessionBrief({ port: c.apiPort })}\n\n---\nFirst message:\n${framed(from, text)}`
      const r = await core('POST', '/api/agents/spawn', { task, kind: 'knowledge', vault: 'atlas' }, d)
      if (!r.ok || !r.body.id) return { ok: false, error: `spawn → ${r.status} ${r.body?.error || ''}`.trim() }
      saveState({ ...state, sessionId: r.body.id, createdAt: new Date().toISOString() }, file)
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

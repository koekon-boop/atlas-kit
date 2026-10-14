/* ------------------------------------------------------------------ *
 * Detects a BROKEN login: a fresh `"error":"authentication_failed"` line in a
 * Claude Code session transcript (`~/.claude/projects/<id>/<session>.jsonl`) — the same
 * signal `claude-login-waechter.py`'s `auth_fehler_seit()` already uses on
 * this box, ported to JS.
 *
 * 🔴 ONLY COUNTS FAILURES AFTER THE LAST RENEWAL (the task's own requirement):
 * the caller passes `since = max(now - window, credentials mtime)`, so a
 * session that failed BEFORE the last successful `claude auth login` — its
 * transcript line is older than the credentials file's own mtime — can never
 * re-trigger a renewal that already happened. Without that, a slow agent
 * whose OWN turn started before the relogin but whose transcript line lands
 * after it would look like a fresh failure forever.
 *
 * Every filesystem access is injectable and every failure is swallowed (a
 * missing projects dir, an unreadable file, a malformed line) — this is a
 * signal, not infrastructure; it must never throw into the watcher.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import path from 'node:path'

const MARKER = '"error":"authentication_failed"'
const TAIL_BYTES = 400_000 // mirrors claude-login-waechter.py — plenty for the last few turns

/** Every `<projectsDir>/<project>/<session>.jsonl` path. Never throws — an absent/unreadable
 *  dir is just "no transcripts to scan". */
export function listTranscripts(projectsDir, { readdir = (p) => fs.readdirSync(p, { withFileTypes: true }) } = {}) {
  let dirs
  try {
    dirs = readdir(projectsDir).filter((d) => d.isDirectory())
  } catch {
    return []
  }
  const out = []
  for (const d of dirs) {
    let files
    try {
      files = readdir(path.join(projectsDir, d.name)).filter((f) => f.isFile?.() !== false && f.name?.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const f of files) out.push(path.join(projectsDir, d.name, f.name))
  }
  return out
}

/** The last `maxBytes` of a file, decoded as UTF-8 (replacing invalid bytes —
 *  a tail cut mid-multibyte-char is expected and harmless here). */
export function readTail(file, maxBytes = TAIL_BYTES) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    return buf.toString('utf-8')
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * The newest `authentication_failed` timestamp (ms epoch) at or after `since`,
 * across every transcript, or null. Deps are injectable for hermetic tests.
 * → number | null. Never throws.
 */
export function latestAuthFailureSince(since, { projectsDir, statFile = (p) => fs.statSync(p), readTail: tail = readTail, listTranscripts: list = listTranscripts } = {}) {
  let newest = null
  for (const file of list(projectsDir)) {
    let mtimeMs
    try {
      mtimeMs = statFile(file).mtimeMs
    } catch {
      continue
    }
    if (mtimeMs < since) continue
    let text
    try {
      text = tail(file)
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.includes(MARKER)) continue
      try {
        const rec = JSON.parse(line)
        const ts = Date.parse(rec.timestamp)
        if (Number.isFinite(ts) && ts >= since && (newest === null || ts > newest)) newest = ts
      } catch {
        /* a half-written line at the tail cut — skip it */
      }
    }
  }
  return newest
}

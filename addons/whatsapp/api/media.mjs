/* ------------------------------------------------------------------ *
 * Pictures, videos and documents in — the same road audio.mjs walks for voice
 * notes, with one difference: the agent is a Claude Code process with file access,
 * so it can LOOK at a picture or a PDF itself. Nothing is described to it; the files
 * are put on disk and their PATHS go into the message, marked like a voice note is:
 *
 *   [Bild empfangen: <path>] <caption>
 *   [Dokument empfangen: <path>, 3 Seiten] <caption>
 *   [Video empfangen: <path>, 12 s] <caption>
 *   Einzelbilder (…): <frame paths>
 *   Tonspur, transkribiert: "<transcript>"
 *
 *   receiveMedia()     Meta lookup + download (audio.mjs' fetchMedia) → a folder under
 *                      <state dir>/whatsapp-media/<YYYY-MM-DD>/<message id>/ → the marked text,
 *                      or `{ ok: false, reply }` — the short, specific answer for the sender
 *   video              ffprobe (duration, streams) → a few stills spread evenly over the whole
 *                      length (ffmpeg) → the soundtrack (ffmpeg, capped) through the same
 *                      loopback POST /api/voice/transcribe voice notes use
 *   pruneMedia()       folders older than WHATSAPP_MEDIA_KEEP_DAYS go when a new medium arrives —
 *                      no cron, and only date-named folders this module made are ever touched
 *
 * 🔴 NEVER SILENT: every failure is a reply to the sender and NOTHING reaches the agent — and the
 * half-written folder is removed. A video without a soundtrack (or a silent one) is not a failure:
 * that part of the marker is simply left out.
 * Nothing here goes to the vault or the repo. Everything takes its `fetch` / `exec` as arguments,
 * so the tests never leave the process and never run ffmpeg.
 * ------------------------------------------------------------------ */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { clip, fetchMedia, transcribe } from './audio.mjs'
import { config } from './config.mjs'
import { onPath, run } from './voice-reply.mjs'

const DAY_MS = 24 * 60 * 60 * 1000
const DAY_DIR = /^\d{4}-\d{2}-\d{2}$/

/** Message type → the counter that counts it. */
const RECEIVED = { image: 'imagesReceived', video: 'videosReceived', document: 'documentsReceived' }
export const MEDIA_TYPES = Object.keys(RECEIVED)

const mb = (bytes) => `${Math.round((bytes / 1048576) * 10) / 10} MB`
const TOO_BIG = (limit) => `Die Datei ist zu groß für mich (mehr als ${mb(limit)}) — schick eine kleinere oder beschreib es mir. / That file is too big for me (over ${mb(limit)}) — send a smaller one or describe it.`
const MEDIA_FAIL = 'Ich konnte die Datei nicht laden — versuch es gleich noch mal. / I couldn’t fetch that file — please try again.'
const SAVE_FAIL = 'Ich konnte die Datei auf der Box nicht ablegen — versuch es gleich noch mal. / I couldn’t store that file on the box — please try again.'
const NO_FFMPEG = 'Videos kann ich gerade nicht auswerten (ffmpeg fehlt auf der Box) — schick mir ein Foto oder beschreib es. / I can’t process videos right now (ffmpeg is missing on the box) — send a photo or describe it.'
const VIDEO_FAIL = 'Das Video konnte ich nicht auslesen — versuch es noch mal oder schick ein Foto. / I couldn’t read that video — please try again or send a photo.'
const VIDEO_NO_STT = 'Die Tonspur des Videos konnte ich nicht auswerten: Spracherkennung ist auf der Box gerade nicht aktiv. Schick es später noch mal oder beschreib es mir. / I couldn’t process the video’s soundtrack: speech recognition is not active on the box right now. Try again later or describe it.'
const VIDEO_STT_FAIL = 'Die Tonspur des Videos konnte ich nicht auswerten — versuch es gleich noch mal oder beschreib es mir. / I couldn’t process the video’s soundtrack — please try again or describe it.'

/* --- names and places -------------------------------------------------------------- */

const EXT = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/heic': '.heic',
  'video/mp4': '.mp4', 'video/3gpp': '.3gp', 'video/quicktime': '.mov', 'video/webm': '.webm',
  'application/pdf': '.pdf', 'text/plain': '.txt', 'text/csv': '.csv', 'application/json': '.json', 'application/zip': '.zip',
  'application/msword': '.doc', 'application/vnd.ms-excel': '.xls', 'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
}

/** A file extension from the mime type: the table, else a short subtype, else `.bin`. */
export function extFor(mime) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase()
  if (EXT[m]) return EXT[m]
  const sub = /^[a-z]+\/([a-z0-9]{1,8})$/.exec(m)?.[1]
  return sub ? `.${sub}` : '.bin'
}

/** One path segment out of anything: letters, digits, `.` `_` `-`; no separators, no leading dot. */
const segment = (s, max = 80) => String(s ?? '').normalize('NFC').replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^[._]+/, '').slice(0, max)

/** A document keeps the name it was sent under (made safe), with an extension that matches its type. */
export function documentName(filename, mime) {
  const orig = path.basename(String(filename ?? '').replace(/\\/g, '/'))
  const ext = path.extname(orig)
  const base = segment(ext ? orig.slice(0, -ext.length) : orig, 60) || 'dokument'
  return base + (/^\.[A-Za-z0-9]{1,8}$/.test(ext) ? ext.toLowerCase() : extFor(mime))
}

/** Where one message's files go: `<dir>/<YYYY-MM-DD>/<message id>`. */
export const messageDir = (dir, id, now = Date.now()) =>
  path.join(dir, new Date(now).toISOString().slice(0, 10), segment(id, 100) || crypto.randomUUID())

/** Delete the day folders older than `keepDays` (by their NAME, so nothing else in `dir` is ever
 *  touched). Never throws → the number of folders removed. */
export function pruneMedia(dir, keepDays, now = Date.now(), log = console.error) {
  const oldest = new Date(now - keepDays * DAY_MS).toISOString().slice(0, 10)
  let removed = 0
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || !DAY_DIR.test(e.name) || e.name >= oldest) continue
      fs.rmSync(path.join(dir, e.name), { recursive: true, force: true })
      removed++
    }
  } catch (e) {
    if (e?.code !== 'ENOENT') log(`[whatsapp] could not clean ${dir}: ${e?.message || e}`)
  }
  return removed
}

/** How many messages' media are on disk right now (for status() and install.sh --check). */
export function storedMedia(dir) {
  let n = 0
  try {
    for (const d of fs.readdirSync(dir, { withFileTypes: true }))
      if (d.isDirectory() && DAY_DIR.test(d.name)) n += fs.readdirSync(path.join(dir, d.name), { withFileTypes: true }).filter((e) => e.isDirectory()).length
  } catch {}
  return n
}

/** PDF page count without a dependency: the page objects an uncompressed body carries. A PDF that
 *  keeps its page tree in compressed object streams gives 0 → null, and the marker just omits it. */
export function pdfPages(bytes) {
  const n = (bytes.toString('latin1').match(/\/Type\s*\/Page(?![A-Za-z])/g) || []).length
  return n || null
}

/* --- video: ffprobe + ffmpeg ---------------------------------------------------------- */

/** ffprobe → `{ ok: true, duration, hasVideo, hasAudio }` | `{ ok: false, missing?, error }`. */
async function probe(file, { exec, timeoutMs }) {
  const r = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], { timeoutMs, captureStdout: true })
  if (r.missing) return { ok: false, missing: true, error: 'ffprobe is not installed (not on PATH)' }
  if (r.code !== 0) return { ok: false, error: `ffprobe failed${r.code === null ? '' : ` (exit ${r.code})`}: ${clip(r.stderr) || 'no output'}` }
  let j
  try {
    j = JSON.parse(r.stdout || '')
  } catch {
    return { ok: false, error: 'ffprobe answered with something that is not JSON' }
  }
  const types = (j?.streams || []).map((s) => s?.codec_type)
  const duration = Number(j?.format?.duration)
  if (!types.includes('video')) return { ok: false, error: 'no video stream in the file' }
  if (!Number.isFinite(duration) || duration <= 0) return { ok: false, error: 'the file has no usable duration' }
  return { ok: true, duration, hasAudio: types.includes('audio') }
}

/** Longest edge `px`, never upscaled, aspect kept, even dimensions. */
const scale = (px) => `scale=w='if(gt(iw,ih),min(${px},iw),-2)':h='if(gt(iw,ih),-2,min(${px},ih))'`

/**
 * `n` stills, one from the middle of each of `n` equal slices of the WHOLE video (never "every second"):
 * n = min(WHATSAPP_VIDEO_FRAMES, ceil(seconds)). A still that fails is skipped; the ones that exist are returned.
 * → `{ ok: true, frames: [path…] }` | `{ ok: false, missing?, error }` (no still at all, or ffmpeg missing).
 */
async function extractFrames(file, dir, duration, { exec, c }) {
  const n = Math.min(c.videoFrames, Math.max(1, Math.ceil(duration)))
  const frames = []
  let error = ''
  for (let i = 0; i < n; i++) {
    const out = path.join(dir, `frame-${String(i + 1).padStart(2, '0')}.jpg`)
    const at = (duration * (i + 0.5)) / n
    const r = await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', at.toFixed(3), '-i', file, '-frames:v', '1', '-vf', scale(c.videoFramePx), '-q:v', '3', out], { timeoutMs: c.ffmpegTimeoutMs })
    if (r.missing) return { ok: false, missing: true, error: 'ffmpeg is not installed (not on PATH)' }
    if (r.code === 0 && fs.existsSync(out) && fs.statSync(out).size > 0) frames.push(out)
    else error = `ffmpeg failed${r.code === null ? '' : ` (exit ${r.code})`}: ${clip(r.stderr) || 'no output'}`
  }
  return frames.length ? { ok: true, frames } : { ok: false, error }
}

/** The soundtrack, at most `c.maxVideoSeconds` of it, as 16 kHz mono WAV (what speech engines want) → `{ ok, wav }`. */
async function extractSoundtrack(file, dir, { exec, c }) {
  const out = path.join(dir, 'soundtrack.wav')
  const r = await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', file, '-vn', '-t', String(c.maxVideoSeconds), '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out], { timeoutMs: c.ffmpegTimeoutMs })
  if (r.missing) return { ok: false, missing: true, error: 'ffmpeg is not installed (not on PATH)' }
  if (r.code !== 0) return { ok: false, error: `ffmpeg failed${r.code === null ? '' : ` (exit ${r.code})`}: ${clip(r.stderr) || 'no output'}` }
  try {
    const wav = fs.readFileSync(out)
    return wav.length ? { ok: true, wav } : { ok: false, error: 'ffmpeg produced an empty soundtrack' }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  } finally {
    fs.rmSync(out, { force: true })
  }
}

/* --- the flow ------------------------------------------------------------------------------ */

export function createMedia({ env = process.env, fetch: f = globalThis.fetch, log = console.error, exec = run, counters }) {
  /**
   * One image / video / document message → `{ ok: true, text }` (what the agent reads) or
   * `{ ok: false, reply }` (what the sender is told; the agent hears nothing). Never throws.
   */
  async function receive(m, kind) {
    const c = config(env)
    const obj = m[kind]
    counters[RECEIVED[kind]]++
    const fail = (reply, why, counted = false) => {
      if (!counted) counters.mediaErrors++ // a transcription failure is already in transcribeErrors
      if (why) log(`[whatsapp] ${kind} not handled: ${why}`)
      return { ok: false, reply }
    }
    if (typeof obj?.id !== 'string' || !obj.id) return fail(MEDIA_FAIL, 'the message came without a media id')

    pruneMedia(c.mediaDir, c.mediaKeepDays, Date.now(), log)

    const got = await fetchMedia(
      obj.id,
      { what: kind, limit: c.maxMediaBytes, mimeRe: kind === 'document' ? /^(?!application\/octet-stream)[a-z]+\//i : new RegExp(`^${kind}/`, 'i'), fallbackMime: obj.mime_type || 'application/octet-stream' },
      { env, fetch: f, log },
    )
    if (!got.ok) {
      if (got.kind !== 'too-large') return fail(MEDIA_FAIL)
      counters.mediaTooLarge++
      return { ok: false, reply: TOO_BIG(c.maxMediaBytes) }
    }

    const dir = messageDir(c.mediaDir, m.id)
    const file = path.join(dir, kind === 'document' ? documentName(obj.filename, got.mime) : `${kind}${extFor(got.mime)}`)
    const cleanup = () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {} // a leftover folder is swept by retention; the sender's answer must not depend on it
    }
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      fs.writeFileSync(file, got.bytes, { mode: 0o600 })
    } catch (e) {
      cleanup()
      return fail(SAVE_FAIL, `could not write ${file}: ${e?.message || e}`)
    }

    const caption = typeof obj.caption === 'string' ? obj.caption.trim() : ''
    const tail = caption ? ` ${caption}` : ''
    if (kind === 'image') return { ok: true, text: `[Bild empfangen: ${file}]${tail}` }
    if (kind === 'document') {
      const pages = /pdf/i.test(got.mime) || /\.pdf$/i.test(file) ? pdfPages(got.bytes) : null
      return { ok: true, text: `[Dokument empfangen: ${file}${pages ? `, ${pages} ${pages === 1 ? 'Seite' : 'Seiten'}` : ''}]${tail}` }
    }

    const v = await video(file, dir, { c, tail })
    if (!v.ok) cleanup()
    return v.ok ? v : fail(v.reply, v.why, v.counted)
  }

  /** The video half of receive(): probe, stills, soundtrack → the marked text. */
  async function video(file, dir, { c, tail }) {
    const d = { exec, c }
    const p = await probe(file, { exec, timeoutMs: c.ffmpegTimeoutMs })
    if (!p.ok) return { ok: false, reply: p.missing ? NO_FFMPEG : VIDEO_FAIL, why: p.error }
    const s = await extractFrames(file, dir, p.duration, d)
    if (!s.ok) return { ok: false, reply: s.missing ? NO_FFMPEG : VIDEO_FAIL, why: s.error }
    counters.framesExtracted += s.frames.length

    let spoken = ''
    if (p.hasAudio) {
      const a = await extractSoundtrack(file, dir, d)
      if (!a.ok) return { ok: false, reply: a.missing ? NO_FFMPEG : VIDEO_FAIL, why: a.error }
      const t = await transcribe(a.wav, 'audio/wav', { env, fetch: f, log })
      if (t.ok) {
        counters.transcribed++
        spoken = t.text.replace(/\s+/g, ' ').replace(/"/g, "'")
      } else if (t.kind === 'empty') counters.transcribeEmpty++ // a silent soundtrack is no error
      else {
        counters.transcribeErrors++
        return { ok: false, reply: t.kind === 'unavailable' ? VIDEO_NO_STT : VIDEO_STT_FAIL, why: `soundtrack: ${t.error}`, counted: true }
      }
    }

    const secs = Math.round(p.duration)
    const cut = p.hasAudio && p.duration > c.maxVideoSeconds ? ` — gekürzt: nur die ersten ${c.maxVideoSeconds} s der Tonspur transkribiert` : ''
    return {
      ok: true,
      text: [
        `[Video empfangen: ${file}, ${secs} s${cut}]${tail}`,
        `Einzelbilder (${s.frames.length}, gleichmäßig über die ganze Länge verteilt): ${s.frames.join(', ')}`,
        ...(spoken ? [`Tonspur, transkribiert: "${spoken}"`] : []),
      ].join('\n'),
    }
  }

  return { receive }
}

/** What status() can say synchronously about the tools video needs and what is on disk. */
export function mediaStatus(env = process.env) {
  const c = config(env)
  return {
    ffmpeg: onPath('ffmpeg'),
    ffprobe: onPath('ffprobe'),
    stored: storedMedia(c.mediaDir),
    dir: c.mediaDir,
    keepDays: c.mediaKeepDays,
    maxMediaBytes: c.maxMediaBytes,
    maxVideoSeconds: c.maxVideoSeconds,
    videoFrames: c.videoFrames,
  }
}

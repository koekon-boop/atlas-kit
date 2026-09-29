/* ------------------------------------------------------------------ *
 * addons/telegram — pictures, videos and documents (types "photo", "video",
 * "document") end to end.
 *
 * Telegram's getFile/download endpoints, the box's /api/voice/transcribe route,
 * core's agent routes and ffmpeg/ffprobe are all STUBBED: nothing leaves the
 * process, no binary runs and no credential is real. The files land in a scratch
 * dir. What this pins:
 *   · the flow: getFile → download → a folder
 *     <state dir>/telegram-media/<YYYY-MM-DD>/<update id>/ → the marked PATHS reach the agent;
 *   · a Telegram message's `caption` lives on the MESSAGE, not nested under the
 *     photo/document/video object — unlike WhatsApp;
 *   · photo picks the LARGEST of the size array; a document (PDF) keeps its name,
 *     pages, caption; a video: ffprobe, evenly spread stills, the soundtrack
 *     (capped) through the transcription route, all in the marker — and no
 *     soundtrack part when there is none or it is silent;
 *   · every failure is a short, specific reply and never a forward: too large (by
 *     file_size, BEFORE any download, or Telegram's own "file is too big"),
 *     getFile/download errors, ffmpeg missing (only video suffers), a broken
 *     video, a soundtrack that cannot be transcribed;
 *   · the retention sweep, the counters, status(), the session brief.
 * Run: node --test addons/telegram/test/media.test.mjs
 * ------------------------------------------------------------------ */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { default as registerAddon } from '../api/register.mjs'
import { createInbound } from '../api/inbound.mjs'
import { sessionBrief } from '../api/agent.mjs'
import { documentName, extFor, messageDir, pdfPages, pruneMedia, storedMedia } from '../api/media.mjs'

const express = createRequire(new URL('../../../api/src/', import.meta.url))('express')
const ctx = { name: 'telegram', express, Router: (o) => express.Router(o) }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-media-test-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const BEARER = 'dash-bearer'
const TOKEN = 'bot-token'
const CHAT = '111'
const ENV = {
  TELEGRAM_BOT_TOKEN: TOKEN,
  TELEGRAM_HOME_CHAT_ID: CHAT,
  DASHBOARD_BEARER_TOKEN: BEARER,
  API_PORT: '3001',
}
const JPG = Buffer.from('JPEG-not-really-a-picture')
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 3/Kids[3 0 R 4 0 R 5 0 R]>>endobj\n3 0 obj<</Type/Page>>endobj\n4 0 obj<</Type /Page>>endobj\n5 0 obj<</Type/Page/Parent 2 0 R>>endobj\n%%EOF')
const MP4 = Buffer.from('ftyp-not-really-a-video')
const TODAY = new Date().toISOString().slice(0, 10)

const msg = (fields) => ({ message_id: Math.floor(Math.random() * 1e6), chat: { id: Number(CHAT) }, ...fields })
const photoMsg = (fields = {}) => msg({ photo: [{ file_id: 'small', width: 90, height: 90, file_size: 1000 }, { file_id: 'M1', width: 1600, height: 1200, file_size: 50000 }], ...fields })
const docMsg = (fields = {}) => msg({ document: { file_id: 'M1', mime_type: 'application/pdf', file_size: PDF.length, file_name: 'doc.pdf' }, ...fields })
const videoMsg = (fields = {}) => msg({ video: { file_id: 'M1', mime_type: 'video/mp4', file_size: MP4.length }, ...fields })

/** One stub for Telegram (getFile + file download), the transcription route and core's agent routes. */
function makeWorld({ media, stt = { status: 200, body: { ok: true, text: 'Das ist ein "Test".\nZweite Zeile.' } } }) {
  const w = { calls: [], sent: [], core: [], stt: [], spawned: 0 }
  const reply = (status, j, { bytes } = {}) => ({
    ok: status < 400,
    status,
    headers: { get: (k) => (k.toLowerCase() === 'content-length' && bytes ? String(bytes.length) : null) },
    json: async () => j,
    text: async () => JSON.stringify(j),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
  })
  w.fetch = async (url, opts = {}) => {
    w.calls.push(url)
    const getFile = /\/getFile\?file_id=(\w+)$/.exec(url)
    if (getFile) {
      const m = media[getFile[1]]
      if (m.lookupStatus) return reply(m.lookupStatus, { ok: false, description: m.lookupError || 'Bad Request' })
      return reply(200, { ok: true, result: { file_id: getFile[1], file_path: `docs/${getFile[1]}.bin`, file_size: m.fileSize ?? m.bytes.length } })
    }
    const dl = /\/file\/bot[^/]+\/(.+)$/.exec(url)
    if (dl) {
      const id = dl[1].replace(/^docs\//, '').replace(/\.bin$/, '')
      const m = media[id]
      if (m.downloadThrows) throw new Error(m.downloadThrows)
      if (m.downloadStatus) return reply(m.downloadStatus, {})
      return reply(200, {}, { bytes: m.bytes })
    }
    if (url === 'http://127.0.0.1:3001/api/voice/transcribe') {
      w.stt.push({ auth: opts.headers?.Authorization, type: opts.headers?.['content-type'], body: opts.body })
      return reply(stt.status, stt.body, { bytes: Buffer.alloc(0) })
    }
    if (url.includes('api.telegram.org') && url.endsWith('/sendMessage')) {
      w.sent.push(JSON.parse(opts.body))
      return reply(200, { ok: true, result: { message_id: 1 } })
    }
    if (url.includes('api.telegram.org') && url.endsWith('/sendChatAction')) return reply(200, { ok: true, result: true })
    const route = url.replace('http://127.0.0.1:3001', '')
    w.core.push({ route, body: opts.body ? JSON.parse(opts.body) : undefined })
    if (route === '/api/agents') return reply(200, { sessions: [] })
    if (route === '/api/agents/spawn') return reply(200, { ok: true, id: `kb-atlas-${++w.spawned}` })
    return reply(404, {})
  }
  return w
}

/** A stand-in for ffprobe + ffmpeg: ffprobe answers with the given streams; ffmpeg writes the file it
 *  was asked for (its last argument), like the real one. `missing` = the binaries that are not installed. */
function makeExec({ duration = 12, streams = ['video', 'audio'], missing = [], failing = [] } = {}) {
  const calls = []
  const exec = async (bin, args, opts) => {
    calls.push({ bin, args, opts })
    if (missing.includes(bin)) return { code: null, stderr: `spawn ${bin} ENOENT`, missing: true }
    const kind = bin === 'ffprobe' ? 'probe' : args.includes('-vn') ? 'soundtrack' : 'frame'
    if (failing.includes(kind)) return { code: 1, stderr: 'Invalid data found when processing input' }
    if (kind === 'probe') return { code: 0, stderr: '', stdout: JSON.stringify({ streams: streams.map((codec_type) => ({ codec_type })), format: { duration: String(duration) } }) }
    const out = args[args.length - 1]
    fs.writeFileSync(out, kind === 'frame' ? 'JPEGSTILL' : 'RIFFWAV')
    return { code: 0, stderr: '' }
  }
  return Object.assign(exec, { calls, of: (kind) => calls.filter((c) => c.bin === (kind === 'probe' ? 'ffprobe' : 'ffmpeg') && (kind === 'probe' || (kind === 'soundtrack') === c.args.includes('-vn'))) })
}

function setup({ media = {}, env = {}, stt, exec = makeExec() } = {}) {
  const world = makeWorld({ media, ...(stt ? { stt } : {}) })
  const log = []
  const dir = path.join(TMP, crypto.randomUUID())
  const file = path.join(dir, 'telegram.json')
  const allEnv = { ...ENV, TELEGRAM_STATE_FILE: file, ...env }
  const inbound = createInbound({ env: allEnv, fetch: world.fetch, log: (m) => log.push(m), file, exec })
  return { world, log, inbound, exec, mediaDir: path.join(dir, 'telegram-media') }
}
const forwarded = (w) => w.core.filter((c) => c.route === '/api/agents/spawn')
const task = (w) => forwarded(w)[0].body.task.split('First message:\n')[1]
const replies = (w) => w.sent.map((s) => s.text)
const folder = (s, id) => path.join(s.mediaDir, TODAY, String(id))

/* --- photos -------------------------------------------------------------------- */

test('photo with a caption: largest resolution is fetched, saved under <state dir>/telegram-media/<day>/<update id>/, caption is on the MESSAGE not the photo object', async () => {
  const s = setup({ media: { M1: { bytes: JPG } } })
  const m = photoMsg({ caption: '  Was ist das für ein Pilz?  ' })
  await s.inbound.handleOne({ update_id: 501, message: m })
  const file = path.join(folder(s, 501), 'image.jpg')
  assert.deepEqual(fs.readFileSync(file), JPG)
  assert.equal(s.world.calls.some((u) => u.includes('file_id=small')), false, 'only the largest size is fetched')
  assert.equal(forwarded(s.world).length, 1)
  assert.equal(task(s.world).split('\n')[0], `[Telegram from 111] [Bild empfangen: ${file}] Was ist das für ein Pilz?`)
  assert.equal(s.world.sent.length, 0, 'the agent answers, not the bridge')
  assert.equal(s.exec.calls.length, 0, 'a picture needs no ffmpeg')
  const c = s.inbound.counters
  assert.deepEqual([c.imagesReceived, c.forwarded, c.mediaErrors, c.unsupported], [1, 1, 0, 0])
})

test('photo without a caption: the marker stands alone', async () => {
  const s = setup({ media: { M1: { bytes: JPG } } })
  await s.inbound.handleOne({ update_id: 502, message: photoMsg() })
  assert.equal(task(s.world).split('\n')[0], `[Telegram from 111] [Bild empfangen: ${path.join(folder(s, 502), 'image.jpg')}]`)
})

/* --- documents ------------------------------------------------------------------- */

test('document (PDF): the name it was sent under, the page count and the caption', async () => {
  const s = setup({ media: { M1: { bytes: PDF } } })
  await s.inbound.handleOne({ update_id: 503, message: docMsg({ document: { file_id: 'M1', mime_type: 'application/pdf', file_size: PDF.length, file_name: 'Rechnung Mai 2026.pdf' }, caption: 'Ist der Betrag richtig?' }) })
  const file = path.join(folder(s, 503), 'Rechnung_Mai_2026.pdf')
  assert.deepEqual(fs.readFileSync(file), PDF)
  assert.equal(task(s.world).split('\n')[0], `[Telegram from 111] [Dokument empfangen: ${file}, 3 Seiten] Ist der Betrag richtig?`)
  assert.equal(s.inbound.counters.documentsReceived, 1)
})

test('document: a non-PDF has no page count; a name cannot climb out of its folder', async () => {
  let s = setup({ media: { M1: { bytes: JPG } } })
  await s.inbound.handleOne({ update_id: 504, message: docMsg({ document: { file_id: 'M1', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', file_size: JPG.length, file_name: 'Plan.docx' } }) })
  assert.equal(task(s.world).split('\n')[0], `[Telegram from 111] [Dokument empfangen: ${path.join(folder(s, 504), 'Plan.docx')}]`)

  s = setup({ media: { M1: { bytes: PDF } } })
  await s.inbound.handleOne({ update_id: 505, message: docMsg({ document: { file_id: 'M1', mime_type: 'application/pdf', file_size: PDF.length, file_name: '../../../etc/cron.d/x.pdf' } }) })
  assert.ok(fs.existsSync(path.join(folder(s, 505), 'x.pdf')), 'only the base name survives')
  assert.equal(fs.existsSync(path.join(s.mediaDir, '..', '..', 'etc')), false)
})

test('the pure helpers: extensions, safe names, message folders, PDF pages', () => {
  assert.equal(extFor('image/jpeg'), '.jpg')
  assert.equal(extFor('video/mp4; codecs=avc1'), '.mp4')
  assert.equal(extFor('application/x-weird-long-subtype'), '.bin')
  assert.equal(extFor(''), '.bin')
  assert.equal(documentName('a b/c\\d.PDF', 'application/pdf'), 'd.pdf')
  assert.equal(documentName('.hidden', 'application/pdf'), 'hidden.pdf')
  assert.equal(documentName('report', 'text/csv'), 'report.csv')
  assert.equal(documentName('', 'application/pdf'), 'dokument.pdf')
  assert.equal(documentName('Übersicht Größe.xlsx', ''), 'Übersicht_Größe.xlsx')
  assert.equal(path.basename(messageDir('/x', '482913', Date.parse('2026-09-25T12:00:00Z'))), '482913')
  assert.equal(path.basename(path.dirname(messageDir('/x', 'a', Date.parse('2026-09-25T12:00:00Z')))), '2026-09-25')
  assert.equal(pdfPages(PDF), 3, '/Pages (the tree) is not a page')
  assert.equal(pdfPages(Buffer.from('%PDF-1.5 compressed object streams only')), null)
})

/* --- video ----------------------------------------------------------------------- */

test('video: ffprobe, evenly spread stills, the soundtrack through the transcription route → one marked message', async () => {
  const s = setup({ media: { M1: { bytes: MP4 } }, exec: makeExec({ duration: 12.4 }) })
  await s.inbound.handleOne({ update_id: 601, message: videoMsg({ caption: 'Hört sich komisch an' }) })
  const dir = folder(s, 601)

  assert.deepEqual(fs.readFileSync(path.join(dir, 'video.mp4')), MP4)
  assert.deepEqual(s.exec.calls.map((c) => c.bin), ['ffprobe', 'ffmpeg', 'ffmpeg', 'ffmpeg', 'ffmpeg', 'ffmpeg', 'ffmpeg', 'ffmpeg'])
  const frames = s.exec.of('frame')
  assert.equal(frames.length, 6)
  const starts = frames.map((c) => Number(c.args[c.args.indexOf('-ss') + 1]))
  assert.deepEqual(starts, [1.033, 3.1, 5.167, 7.233, 9.3, 11.367])
  assert.equal(frames[0].args.at(-1), path.join(dir, 'frame-01.jpg'))
  const sound = s.exec.of('soundtrack')[0].args
  assert.deepEqual(sound.slice(sound.indexOf('-t'), sound.indexOf('-t') + 2), ['-t', '120'])

  assert.equal(s.world.stt.length, 1)
  assert.equal(s.world.stt[0].auth, `Bearer ${BEARER}`)
  assert.equal(s.world.stt[0].type, 'audio/wav')
  assert.equal(fs.existsSync(path.join(dir, 'soundtrack.wav')), false)

  const list = [1, 2, 3, 4, 5, 6].map((n) => path.join(dir, `frame-0${n}.jpg`))
  assert.equal(
    task(s.world).split('\n\n(Reply')[0],
    [
      `[Telegram from 111] [Video empfangen: ${path.join(dir, 'video.mp4')}, 12 s] Hört sich komisch an`,
      `Einzelbilder (6, gleichmäßig über die ganze Länge verteilt): ${list.join(', ')}`,
      `Tonspur, transkribiert: "Das ist ein 'Test'. Zweite Zeile."`,
    ].join('\n'),
  )
  const c = s.inbound.counters
  assert.deepEqual([c.videosReceived, c.framesExtracted, c.transcribed, c.forwarded, c.mediaErrors], [1, 6, 1, 1, 0])
  assert.equal(s.world.sent.length, 0)
})

test('video without a soundtrack: no transcription, no soundtrack line, no error', async () => {
  const s = setup({ media: { M1: { bytes: MP4 } }, exec: makeExec({ duration: 5, streams: ['video'] }) })
  await s.inbound.handleOne({ update_id: 602, message: videoMsg() })
  assert.equal(s.exec.of('soundtrack').length, 0)
  assert.equal(s.world.stt.length, 0)
  assert.doesNotMatch(task(s.world), /Tonspur/)
  assert.equal(s.inbound.counters.forwarded, 1)
  assert.equal(s.inbound.counters.mediaErrors, 0)
})

test('video with a silent soundtrack (empty transcript): the soundtrack part is left out, no error', async () => {
  for (const stt of [{ status: 200, body: { ok: true, text: '   ' } }, { status: 503, body: { ok: false, error: 'the STT command produced no transcript' } }]) {
    const s = setup({ media: { M1: { bytes: MP4 } }, stt })
    await s.inbound.handleOne({ update_id: 603, message: videoMsg() })
    assert.equal(s.world.stt.length, 1)
    assert.doesNotMatch(task(s.world), /Tonspur/)
    assert.deepEqual([s.inbound.counters.transcribeEmpty, s.inbound.counters.transcribeErrors, s.inbound.counters.mediaErrors, s.inbound.counters.forwarded], [1, 0, 0, 1])
  }
})

test('video longer than TELEGRAM_MAX_VIDEO_SECONDS: accepted, stills over the whole length, soundtrack cut at the limit — and the marker says so', async () => {
  const s = setup({ media: { M1: { bytes: MP4 } }, exec: makeExec({ duration: 340 }), env: { TELEGRAM_MAX_VIDEO_SECONDS: '90' } })
  await s.inbound.handleOne({ update_id: 604, message: videoMsg() })
  const sound = s.exec.of('soundtrack')[0].args
  assert.equal(sound[sound.indexOf('-t') + 1], '90')
  assert.match(task(s.world).split('\n')[0], /video\.mp4, 340 s — gekürzt: nur die ersten 90 s der Tonspur transkribiert\]/)
})

/* --- failures: specific reply, no forward -------------------------------------------- */

test('file_size over TELEGRAM_MAX_MEDIA_BYTES (default 20 MB) → a hint, no download, mediaTooLarge, nothing on disk', async () => {
  for (const [label, m] of [['photo', photoMsg()], ['document', docMsg()], ['video', videoMsg()]]) {
    const s = setup({ media: { M1: { bytes: JPG, fileSize: 20 * 1024 * 1024 + 1 }, small: { bytes: JPG, fileSize: 1 } } })
    await s.inbound.handleOne({ update_id: 700, message: m })
    assert.equal(s.world.calls.some((u) => u.includes('/file/bot')), false, `${label}: nothing was downloaded`)
    assert.match(replies(s.world)[0], /zu groß für mich \(mehr als 20 MB\)/)
    assert.equal(forwarded(s.world).length, 0)
    assert.equal(s.exec.calls.length, 0)
    assert.equal(storedMedia(s.mediaDir), 0)
    assert.equal(s.inbound.counters.mediaTooLarge, 1)
  }
})

test("Telegram's own \"file is too big\" (over its 20 MB getFile cap) is treated the same as an over-limit file_size", async () => {
  const s = setup({ media: { M1: { bytes: JPG, lookupStatus: 400, lookupError: 'Bad Request: file is too big' } } })
  await s.inbound.handleOne({ update_id: 701, message: docMsg() })
  assert.match(replies(s.world)[0], /zu groß/)
  assert.equal(s.inbound.counters.mediaTooLarge, 1)
  assert.equal(forwarded(s.world).length, 0)
})

test("the limit is configurable, and Telegram's file_size is only a claim — the downloaded bytes are checked too", async () => {
  const s = setup({ env: { TELEGRAM_MAX_MEDIA_BYTES: '10' }, media: { M1: { bytes: JPG, fileSize: 5 } } })
  await s.inbound.handleOne({ update_id: 702, message: photoMsg() })
  assert.equal(s.world.calls.some((u) => u.includes('/file/bot')), true, 'file_size said 5: the download starts')
  assert.equal(forwarded(s.world).length, 0, '…but the real bytes are over 10')
  assert.match(replies(s.world)[0], /zu groß/)
})

test('getFile error, failed download, no media id → "konnte die Datei nicht laden", mediaErrors, no forward', async () => {
  const cases = [
    [{ M1: { bytes: JPG, lookupStatus: 400, lookupError: 'Bad Request' } }, photoMsg()],
    [{ M1: { bytes: JPG, downloadStatus: 404 } }, docMsg()],
    [{ M1: { bytes: JPG, downloadThrows: 'socket hang up' } }, docMsg()],
    [{}, msg({ video: {} })],
  ]
  for (const [media, m] of cases) {
    const s = setup({ media })
    await s.inbound.handleOne({ update_id: 703, message: m })
    assert.match(replies(s.world)[0], /nicht laden/)
    assert.equal(forwarded(s.world).length, 0)
    assert.equal(s.inbound.counters.mediaErrors, 1)
    assert.equal(storedMedia(s.mediaDir), 0)
  }
})

test('ffmpeg missing: photo and document still work, only the video answers with a hint (and leaves nothing behind)', async () => {
  const exec = makeExec({ missing: ['ffmpeg', 'ffprobe'] })
  const s = setup({ exec, media: { M1: { bytes: MP4 }, M2: { bytes: JPG }, M3: { bytes: PDF } } })
  await s.inbound.handleOne({ update_id: 800, message: videoMsg({ video: { file_id: 'M1', mime_type: 'video/mp4', file_size: MP4.length } }) })
  await s.inbound.handleOne({ update_id: 801, message: { message_id: 2, chat: { id: Number(CHAT) }, photo: [{ file_id: 'M2', width: 100, height: 100, file_size: JPG.length }] } })
  await s.inbound.handleOne({ update_id: 802, message: docMsg({ document: { file_id: 'M3', mime_type: 'application/pdf', file_size: PDF.length, file_name: 'a.pdf' } }) })
  assert.equal(s.world.sent.length, 1)
  assert.match(replies(s.world)[0], /Videos kann ich gerade nicht auswerten \(ffmpeg fehlt/)
  assert.equal(forwarded(s.world).length, 2, 'the picture and the document went through')
  assert.equal(fs.existsSync(folder(s, 800)), false, 'the half-handled video folder is gone')
  assert.deepEqual([s.inbound.counters.videosReceived, s.inbound.counters.imagesReceived, s.inbound.counters.documentsReceived, s.inbound.counters.mediaErrors, s.inbound.counters.forwarded], [1, 1, 1, 1, 2])
})

test('a video ffprobe cannot read, no picture stream, a broken duration, or stills that all fail → "nicht auslesen", no forward, folder removed', async () => {
  const cases = [
    makeExec({ failing: ['probe'] }),
    makeExec({ streams: ['audio'] }),
    makeExec({ duration: 'N/A' }),
    makeExec({ failing: ['frame'] }),
    makeExec({ failing: ['soundtrack'] }),
  ]
  for (const exec of cases) {
    const s = setup({ exec, media: { M1: { bytes: MP4 } } })
    await s.inbound.handleOne({ update_id: 900, message: videoMsg() })
    assert.match(replies(s.world)[0], /Video konnte ich nicht auslesen/)
    assert.equal(forwarded(s.world).length, 0)
    assert.equal(s.inbound.counters.mediaErrors, 1)
    assert.equal(fs.existsSync(folder(s, 900)), false)
  }
})

test('the soundtrack cannot be transcribed (voice addon off / STT broken) → its own hint, no forward, folder removed', async () => {
  for (const [stt, reply] of [
    [{ status: 503, body: { ok: false, error: 'no ATLAS_VOICE_STT_CMD' } }, /Tonspur des Videos konnte ich nicht auswerten: Spracherkennung ist auf der Box gerade nicht aktiv/],
    [{ status: 404, body: {} }, /Spracherkennung ist auf der Box gerade nicht aktiv/],
    [{ status: 500, body: { error: 'x' } }, /Tonspur des Videos konnte ich nicht auswerten — versuch/],
  ]) {
    const s = setup({ stt, media: { M1: { bytes: MP4 } } })
    await s.inbound.handleOne({ update_id: 901, message: videoMsg() })
    assert.match(replies(s.world)[0], reply)
    assert.equal(forwarded(s.world).length, 0)
    assert.equal(fs.existsSync(folder(s, 901)), false)
    assert.equal(s.inbound.counters.transcribeErrors, 1)
    assert.equal(s.inbound.counters.mediaErrors, 0)
  }
})

/* --- retention ----------------------------------------------------------------------- */

test('retention: a new medium sweeps the day folders older than TELEGRAM_MEDIA_KEEP_DAYS (14) — and only those', async () => {
  const s = setup({ media: { M1: { bytes: JPG } } })
  const day = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10)
  for (const [d, id] of [[day(15), 'old'], [day(40), 'older'], [day(14), 'edge'], [day(3), 'recent']]) {
    fs.mkdirSync(path.join(s.mediaDir, d, id), { recursive: true })
    fs.writeFileSync(path.join(s.mediaDir, d, id, 'image.jpg'), 'x')
  }
  fs.mkdirSync(path.join(s.mediaDir, 'notes-of-the-operator'), { recursive: true })
  assert.equal(storedMedia(s.mediaDir), 4)
  await s.inbound.handleOne({ update_id: 999, message: photoMsg() })
  assert.equal(fs.existsSync(path.join(s.mediaDir, day(15))), false)
  assert.equal(fs.existsSync(path.join(s.mediaDir, day(40))), false)
  assert.ok(fs.existsSync(path.join(s.mediaDir, day(14), 'edge')))
  assert.ok(fs.existsSync(path.join(s.mediaDir, day(3), 'recent')))
  assert.ok(fs.existsSync(path.join(s.mediaDir, 'notes-of-the-operator')), 'a folder that is not a date is never touched')
  assert.equal(storedMedia(s.mediaDir), 3)
})

test('retention is configurable, and pruneMedia is total (no folder yet, unreadable → 0, never a throw)', () => {
  const dir = path.join(TMP, `prune-${crypto.randomUUID()}`)
  assert.equal(pruneMedia(dir, 14, Date.now(), () => {}), 0)
  fs.mkdirSync(path.join(dir, '2026-09-20', 'a'), { recursive: true })
  fs.mkdirSync(path.join(dir, '2026-09-24', 'b'), { recursive: true })
  const now = Date.parse('2026-09-25T10:00:00Z')
  assert.equal(pruneMedia(dir, 3, now), 1)
  assert.deepEqual(fs.readdirSync(dir), ['2026-09-24'])
})

/* --- what did NOT change ----------------------------------------------------------------- */

test('sticker / location / contact stay UNSUPPORTED; text and voice notes are untouched', async () => {
  const s = setup({ media: { M1: { bytes: JPG } } })
  await s.inbound.handleOne({ update_id: 1, message: msg({ sticker: { file_id: 's1' } }) })
  await s.inbound.handleOne({ update_id: 2, message: msg({ location: { latitude: 1, longitude: 2 } }) })
  await s.inbound.handleOne({ update_id: 3, message: msg({ contact: { phone_number: '1', first_name: 'x' } }) })
  await s.inbound.handleOne({ update_id: 4, message: msg({ text: 'hallo' }) })
  assert.equal(replies(s.world).length, 3)
  for (const r of replies(s.world)) assert.match(r, /noch nicht lesen/)
  assert.equal(s.inbound.counters.unsupported, 3)
  assert.equal(forwarded(s.world).length, 1)
  assert.match(task(s.world), /\] hallo/)
  assert.equal(storedMedia(s.mediaDir), 0)
})

test('several files arrive in order', async () => {
  const s = setup({ media: { M1: { bytes: JPG }, M2: { bytes: PDF } } })
  await s.inbound.handleOne({ update_id: 1, message: photoMsg({ caption: 'erst' }) })
  await s.inbound.handleOne({ update_id: 2, message: docMsg({ document: { file_id: 'M2', mime_type: 'application/pdf', file_size: PDF.length, file_name: 'zweitens.pdf' } }) })
  await s.inbound.handleOne({ update_id: 3, message: msg({ text: 'drittens' }) })
  const tasks = forwarded(s.world).map((c) => c.body.task)
  assert.equal(tasks.length, 3)
  assert.match(tasks[0], /Bild empfangen.*erst/)
  assert.match(tasks[1], /Dokument empfangen.*zweitens\.pdf/)
  assert.match(tasks[2], /drittens/)
})

/* --- the agent's brief, status() ------------------------------------------------------------ */

test('the session brief explains the markers: paths are local files, look at them first; a video is stills + a transcript', () => {
  const b = sessionBrief()
  assert.match(b, /\[Bild empfangen: <path>\]/)
  assert.match(b, /\[Dokument empfangen: <path>, 3 Seiten\]/)
  assert.match(b, /\[Video empfangen: <path>, 12 s\]/)
  assert.match(b, /Einzelbilder/)
  assert.match(b, /Tonspur, transkribiert/)
  assert.match(b, /gekürzt/)
  assert.match(b, /LOCAL FILES/)
  assert.match(b, /LOOK AT THEM with your normal tools/)
  assert.match(b, /do NOT get the film/)
})

test('status() carries media: the tools, what is stored, the limits — and the new counters', async () => {
  const dir = path.join(TMP, `status-${crypto.randomUUID()}`)
  fs.mkdirSync(path.join(dir, 'telegram-media', TODAY, 'm1'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'telegram-media', TODAY, 'm2'), { recursive: true })
  const real = globalThis.fetch
  globalThis.fetch = async () => ({ json: async () => ({ addons: [] }) })
  const keep = { ...process.env }
  fs.writeFileSync(path.join(dir, 'telegram-poller.lock'), JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }))
  Object.assign(process.env, ENV, { TELEGRAM_STATE_FILE: path.join(dir, 'telegram.json'), TELEGRAM_MAX_VIDEO_SECONDS: '45' })
  try {
    const st = registerAddon(ctx).status()
    assert.equal(typeof st.media.ffmpeg, 'boolean')
    assert.equal(typeof st.media.ffprobe, 'boolean')
    assert.equal(st.media.stored, 2)
    assert.equal(st.media.dir, path.join(dir, 'telegram-media'))
    assert.deepEqual([st.media.keepDays, st.media.maxMediaBytes, st.media.maxVideoSeconds, st.media.videoFrames], [14, 20 * 1024 * 1024, 45, 6])
    for (const k of ['imagesReceived', 'videosReceived', 'documentsReceived', 'framesExtracted', 'mediaTooLarge', 'mediaErrors']) assert.equal(st.counters[k], 0, k)
  } finally {
    globalThis.fetch = real
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]
    Object.assign(process.env, keep)
  }
})

/* --- install.sh --check ------------------------------------------------------------------------- */

/** Run a COPY of install.sh (with the addon's api/ next to it, like a real tree) in a scratch tree, PATH = only what we hand it. */
function check({ tools = {}, api = true, env = {} }) {
  const root = path.join(TMP, `root-${crypto.randomUUID()}`)
  const bin = path.join(root, 'bin')
  fs.mkdirSync(path.join(root, 'addons', 'telegram'), { recursive: true })
  fs.mkdirSync(bin)
  const here = new URL('..', import.meta.url).pathname
  fs.copyFileSync(path.join(here, 'install.sh'), path.join(root, 'addons', 'telegram', 'install.sh'))
  if (api) fs.cpSync(path.join(here, 'api'), path.join(root, 'addons', 'telegram', 'api'), { recursive: true })
  for (const t of ['bash', 'grep', 'dirname']) fs.symlinkSync(spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf-8' }).stdout.trim(), path.join(bin, t))
  fs.symlinkSync(process.execPath, path.join(bin, 'node'))
  for (const [name, body] of Object.entries(tools)) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  const r = spawnSync(path.join(bin, 'bash'), [path.join(root, 'addons', 'telegram', 'install.sh'), '--check'], {
    encoding: 'utf-8',
    env: { PATH: bin, HOME: root, API_PORT: '1', ATLAS_ADDONS: '', ...env },
    timeout: 30000,
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}
const OPUS_FFMPEG = 'echo " A....D libopus              libopus Opus (codec opus)"'

test('install.sh --check: ffmpeg without ffprobe → a gap that names incoming videos (pictures and documents are not blamed)', () => {
  const r = check({ tools: { ffmpeg: OPUS_FFMPEG } })
  assert.equal(r.code, 2)
  assert.match(r.err, /TODO: incoming videos need ffprobe on PATH/)
  assert.match(r.err, /pictures and documents work/)
})

test('install.sh --check: ffmpeg + ffprobe → no video gap; and what is stored, where, for how long', () => {
  const dir = path.join(TMP, `check-${crypto.randomUUID()}`)
  fs.mkdirSync(path.join(dir, 'telegram-media', TODAY, 'm1'), { recursive: true })
  const r = check({ tools: { ffmpeg: OPUS_FFMPEG, ffprobe: 'exit 0' }, env: { TELEGRAM_STATE_FILE: path.join(dir, 'telegram.json'), TELEGRAM_MEDIA_KEEP_DAYS: '7', TELEGRAM_MAX_VIDEO_SECONDS: '60' } })
  assert.doesNotMatch(r.err, /ffprobe/)
  assert.match(r.out, /incoming videos: ffmpeg and ffprobe found/)
  assert.match(r.out, new RegExp(`incoming media: 1 message\\(s\\) stored in ${path.join(dir, 'telegram-media')} \\(deleted after 7 days, at most 20 MB each; videos: 6 stills, soundtrack up to 60 s\\)`))
})

test("install.sh --check: without the addon's api/ next to it the media line is skipped quietly", () => {
  const r = check({ tools: { ffmpeg: OPUS_FFMPEG, ffprobe: 'exit 0' }, api: false })
  assert.doesNotMatch(r.out + r.err, /incoming media/)
  assert.doesNotMatch(r.err, /could not read the media status/)
})

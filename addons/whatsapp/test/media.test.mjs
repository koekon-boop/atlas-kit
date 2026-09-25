/* ------------------------------------------------------------------ *
 * addons/whatsapp — pictures, videos and documents (types "image", "video",
 * "document") end to end.
 *
 * Meta's media endpoints, the box's /api/voice/transcribe route, core's agent routes
 * and ffmpeg/ffprobe are all STUBBED: nothing leaves the process, no binary runs and
 * no credential is real. The files land in a scratch dir. What this pins:
 *   · the flow: lookup → download (BOTH with the bearer) → a folder
 *     <state dir>/whatsapp-media/<YYYY-MM-DD>/<message id>/ → the marked PATHS reach the agent;
 *   · image with and without caption; a document (PDF) with its name, pages and caption;
 *   · a video: ffprobe, evenly spread stills, the soundtrack (capped) through the transcription
 *     route, all in the marker — and no soundtrack part when there is none or it is silent;
 *   · every failure is a short, specific reply and never a forward: too large (by file_size,
 *     BEFORE any download), Graph/download errors, ffmpeg missing (only video suffers),
 *     a broken video, a soundtrack that cannot be transcribed;
 *   · the retention sweep, the counters, status(), the session brief.
 * Run: node --test addons/whatsapp/test/media.test.mjs
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
const ctx = { name: 'whatsapp', express, Router: (o) => express.Router(o) }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-media-test-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const BEARER = 'dash-bearer'
const TOKEN = 'a-token'
const FROM = '4915112345678'
const ENV = {
  WHATSAPP_VERIFY_TOKEN: 'v-token',
  WHATSAPP_APP_SECRET: 'app-secret',
  WHATSAPP_ACCESS_TOKEN: TOKEN,
  WHATSAPP_PHONE_NUMBER_ID: '555',
  WHATSAPP_ALLOWED_FROM: FROM,
  DASHBOARD_BEARER_TOKEN: BEARER,
  API_PORT: '3001',
}
const JPG = Buffer.from('JPEG-not-really-a-picture')
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 3/Kids[3 0 R 4 0 R 5 0 R]>>endobj\n3 0 obj<</Type/Page>>endobj\n4 0 obj<</Type /Page>>endobj\n5 0 obj<</Type/Page/Parent 2 0 R>>endobj\n%%EOF')
const MP4 = Buffer.from('ftyp-not-really-a-video')
const TODAY = new Date().toISOString().slice(0, 10)

const msg = (type, id, obj, mediaId = 'M1') => ({ id, from: FROM, type, [type]: { id: mediaId, ...obj } })
const payload = (messages) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages } }] }] })

/** One stub for Meta (Graph + lookaside), the transcription route and core's agent routes.
 *  `media` maps a media id to what Meta would answer for it. */
function makeWorld({ media, stt = { status: 200, body: { ok: true, text: 'Das ist ein "Test".\nZweite Zeile.' } } }) {
  const w = { calls: [], sent: [], core: [], stt: [], auth: {}, spawned: 0 }
  const reply = (status, j, { headers = {}, bytes } = {}) => ({
    ok: status < 400,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => j,
    text: async () => JSON.stringify(j),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
  })
  w.fetch = async (url, opts = {}) => {
    w.calls.push(url)
    const graph = /^https:\/\/graph\.facebook\.com\/v21\.0\/(M\w+)$/.exec(url)
    if (graph) {
      w.auth.lookup = opts.headers?.Authorization
      const m = media[graph[1]]
      if (m.lookupStatus) return reply(m.lookupStatus, { error: { message: 'Unsupported get request', code: 100 } })
      return reply(200, { url: `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${graph[1]}`, mime_type: m.mime, file_size: m.fileSize ?? m.bytes.length })
    }
    const look = /mid=(M\w+)$/.exec(url)
    if (look) {
      w.auth.download = opts.headers?.Authorization
      const m = media[look[1]]
      if (m.downloadThrows) throw new Error(m.downloadThrows)
      if (m.downloadStatus) return reply(m.downloadStatus, { error: { message: 'Invalid OAuth access token' } })
      return reply(200, {}, { bytes: m.bytes, headers: { 'content-type': m.downloadType ?? m.mime } })
    }
    if (url === 'http://127.0.0.1:3001/api/voice/transcribe') {
      w.stt.push({ auth: opts.headers?.Authorization, type: opts.headers?.['content-type'], body: opts.body })
      return reply(stt.status, stt.body, { bytes: Buffer.alloc(0) })
    }
    if (url.startsWith('https://graph.facebook.com/v21.0/555/messages')) {
      w.sent.push(JSON.parse(opts.body))
      return reply(200, { messages: [{ id: 'wamid.x' }] })
    }
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
  const file = path.join(dir, 'whatsapp.json')
  const allEnv = { ...ENV, WHATSAPP_STATE_FILE: file, ...env }
  const inbound = createInbound({ env: allEnv, fetch: world.fetch, log: (m) => log.push(m), file, exec })
  return { world, log, inbound, exec, mediaDir: path.join(dir, 'whatsapp-media') }
}
const forwarded = (w) => w.core.filter((c) => c.route === '/api/agents/spawn')
const task = (w) => forwarded(w)[0].body.task.split('First message:\n')[1]
const replies = (w) => w.sent.map((s) => s.text.body)
const folder = (s, id) => path.join(s.mediaDir, TODAY, id)

/* --- images -------------------------------------------------------------------- */

test('image with a caption: saved under <state dir>/whatsapp-media/<day>/<message id>/, the marker carries the path and the caption', async () => {
  const s = setup({ media: { M1: { bytes: JPG, mime: 'image/jpeg' } } })
  await s.inbound.process(payload([msg('image', 'wamid.IMG1', { mime_type: 'image/jpeg', caption: '  Was ist das für ein Pilz?  ' })]))
  const file = path.join(folder(s, 'wamid.IMG1'), 'image.jpg')
  assert.deepEqual(fs.readFileSync(file), JPG)
  assert.equal(s.world.auth.lookup, `Bearer ${TOKEN}`)
  assert.equal(s.world.auth.download, `Bearer ${TOKEN}`, 'the lookaside URL 401s without the token')
  assert.equal(forwarded(s.world).length, 1)
  assert.equal(task(s.world).split('\n')[0], `[WhatsApp from ${FROM}] [Bild empfangen: ${file}] Was ist das für ein Pilz?`)
  assert.equal(s.world.sent.length, 0, 'the agent answers, not the bridge')
  assert.equal(s.exec.calls.length, 0, 'a picture needs no ffmpeg')
  const c = s.inbound.counters
  assert.deepEqual([c.imagesReceived, c.forwarded, c.mediaErrors, c.unsupported], [1, 1, 0, 0])
})

test('image without a caption: the marker stands alone; png and webp get their own extension', async () => {
  for (const [mime, ext] of [['image/png', '.png'], ['image/webp', '.webp']]) {
    const s = setup({ media: { M1: { bytes: JPG, mime } } })
    await s.inbound.process(payload([msg('image', 'i1', { mime_type: mime })]))
    assert.equal(task(s.world).split('\n')[0], `[WhatsApp from ${FROM}] [Bild empfangen: ${path.join(folder(s, 'i1'), `image${ext}`)}]`)
  }
})

/* --- documents ------------------------------------------------------------------- */

test('document (PDF): the name it was sent under, the page count and the caption', async () => {
  const s = setup({ media: { M1: { bytes: PDF, mime: 'application/pdf' } } })
  await s.inbound.process(payload([msg('document', 'd1', { mime_type: 'application/pdf', filename: 'Rechnung Mai 2026.pdf', caption: 'Ist der Betrag richtig?' })]))
  const file = path.join(folder(s, 'd1'), 'Rechnung_Mai_2026.pdf')
  assert.deepEqual(fs.readFileSync(file), PDF)
  assert.equal(task(s.world).split('\n')[0], `[WhatsApp from ${FROM}] [Dokument empfangen: ${file}, 3 Seiten] Ist der Betrag richtig?`)
  assert.equal(s.inbound.counters.documentsReceived, 1)
})

test('document: a non-PDF has no page count; a file with no name gets one from its type; a name cannot climb out of its folder', async () => {
  let s = setup({ media: { M1: { bytes: JPG, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', downloadType: 'application/octet-stream' } } })
  await s.inbound.process(payload([msg('document', 'd1', { filename: 'Plan.docx' })]))
  assert.equal(task(s.world).split('\n')[0], `[WhatsApp from ${FROM}] [Dokument empfangen: ${path.join(folder(s, 'd1'), 'Plan.docx')}]`)

  s = setup({ media: { M1: { bytes: PDF, mime: 'application/pdf' } } })
  await s.inbound.process(payload([msg('document', 'd2', {}), msg('document', 'd3', { filename: '../../../etc/cron.d/x.pdf' })]))
  assert.ok(fs.existsSync(path.join(folder(s, 'd2'), 'dokument.pdf')))
  assert.ok(fs.existsSync(path.join(folder(s, 'd3'), 'x.pdf')), 'only the base name survives')
  assert.equal(fs.existsSync(path.join(s.mediaDir, '..', '..', 'etc')), false)
})

test('the pure helpers: extensions, safe names, message folders, PDF pages', () => {
  assert.equal(extFor('image/jpeg'), '.jpg')
  assert.equal(extFor('video/mp4; codecs=avc1'), '.mp4')
  assert.equal(extFor('image/heic'), '.heic')
  assert.equal(extFor('application/x-weird-long-subtype'), '.bin')
  assert.equal(extFor(''), '.bin')
  assert.equal(documentName('a b/c\\d.PDF', 'application/pdf'), 'd.pdf')
  assert.equal(documentName('.hidden', 'application/pdf'), 'hidden.pdf')
  assert.equal(documentName('report', 'text/csv'), 'report.csv')
  assert.equal(documentName('', 'application/pdf'), 'dokument.pdf')
  assert.equal(documentName('Übersicht Größe.xlsx', ''), 'Übersicht_Größe.xlsx')
  assert.equal(path.basename(messageDir('/x', 'wamid.HBg/M==', Date.parse('2026-09-25T12:00:00Z'))), 'wamid.HBg_M_')
  assert.equal(path.basename(path.dirname(messageDir('/x', 'a', Date.parse('2026-09-25T12:00:00Z')))), '2026-09-25')
  assert.equal(pdfPages(PDF), 3, '/Pages (the tree) is not a page')
  assert.equal(pdfPages(Buffer.from('%PDF-1.5 compressed object streams only')), null)
})

/* --- video ----------------------------------------------------------------------- */

test('video: ffprobe, evenly spread stills, the soundtrack through the transcription route → one marked message', async () => {
  const s = setup({ media: { M1: { bytes: MP4, mime: 'video/mp4' } }, exec: makeExec({ duration: 12.4 }) })
  await s.inbound.process(payload([msg('video', 'v1', { mime_type: 'video/mp4', caption: 'Hört sich komisch an' })]))
  const dir = folder(s, 'v1')

  // downloaded and kept
  assert.deepEqual(fs.readFileSync(path.join(dir, 'video.mp4')), MP4)

  // ffprobe first, then 6 stills, then the soundtrack
  assert.deepEqual(s.exec.calls.map((c) => c.bin), ['ffprobe', 'ffmpeg', 'ffmpeg', 'ffmpeg', 'ffmpeg', 'ffmpeg', 'ffmpeg', 'ffmpeg'])
  assert.equal(s.exec.calls[0].opts.captureStdout, true)
  const frames = s.exec.of('frame')
  assert.equal(frames.length, 6)
  const starts = frames.map((c) => Number(c.args[c.args.indexOf('-ss') + 1]))
  assert.deepEqual(starts, [1.033, 3.1, 5.167, 7.233, 9.3, 11.367], 'the middle of six equal slices of the WHOLE video, not the first second')
  assert.match(frames[0].args[frames[0].args.indexOf('-vf') + 1], /min\(1024,iw\).*min\(1024,ih\)/, 'longest edge 1024, never upscaled')
  assert.equal(frames[0].args.at(-1), path.join(dir, 'frame-01.jpg'))
  for (const c of s.exec.calls) assert.equal(c.opts.timeoutMs, 60000)
  const sound = s.exec.of('soundtrack')[0].args
  assert.deepEqual(sound.slice(sound.indexOf('-t'), sound.indexOf('-t') + 2), ['-t', '120'])
  assert.ok(sound.includes('16000') && sound.includes('pcm_s16le'))

  // the transcription route got the WAV, with the bearer
  assert.equal(s.world.stt.length, 1)
  assert.equal(s.world.stt[0].auth, `Bearer ${BEARER}`)
  assert.equal(s.world.stt[0].type, 'audio/wav')
  assert.equal(Buffer.from(s.world.stt[0].body).toString(), 'RIFFWAV')
  assert.equal(fs.existsSync(path.join(dir, 'soundtrack.wav')), false, 'the scratch WAV does not stay')

  // what the agent reads
  const list = [1, 2, 3, 4, 5, 6].map((n) => path.join(dir, `frame-0${n}.jpg`))
  assert.equal(
    task(s.world).split('\n\n(Reply')[0],
    [
      `[WhatsApp from ${FROM}] [Video empfangen: ${path.join(dir, 'video.mp4')}, 12 s] Hört sich komisch an`,
      `Einzelbilder (6, gleichmäßig über die ganze Länge verteilt): ${list.join(', ')}`,
      `Tonspur, transkribiert: "Das ist ein 'Test'. Zweite Zeile."`,
    ].join('\n'),
  )
  assert.deepEqual(list.map((f) => fs.existsSync(f)), Array(6).fill(true))
  const c = s.inbound.counters
  assert.deepEqual([c.videosReceived, c.framesExtracted, c.transcribed, c.forwarded, c.mediaErrors], [1, 6, 1, 1, 0])
  assert.equal(s.world.sent.length, 0)
})

test('video: the number of stills is configurable, and a short video gets one per second at most', async () => {
  let s = setup({ media: { M1: { bytes: MP4, mime: 'video/mp4' } }, exec: makeExec({ duration: 3 }) })
  await s.inbound.process(payload([msg('video', 'v1', {})]))
  assert.equal(s.exec.of('frame').length, 3, 'a 3 s clip does not get 6 near-identical stills')

  s = setup({ media: { M1: { bytes: MP4, mime: 'video/mp4' } }, exec: makeExec({ duration: 0.4 }) })
  await s.inbound.process(payload([msg('video', 'v1', {})]))
  assert.equal(s.exec.of('frame').length, 1)

  s = setup({ media: { M1: { bytes: MP4, mime: 'video/mp4' } }, exec: makeExec({ duration: 90 }), env: { WHATSAPP_VIDEO_FRAMES: '2', WHATSAPP_VIDEO_FRAME_PX: '640' } })
  await s.inbound.process(payload([msg('video', 'v1', {})]))
  const frames = s.exec.of('frame')
  assert.equal(frames.length, 2)
  assert.match(frames[0].args[frames[0].args.indexOf('-vf') + 1], /min\(640,iw\)/)
  assert.match(task(s.world), /Einzelbilder \(2,/)
})

test('video without a soundtrack: no transcription, no soundtrack line, no error', async () => {
  const s = setup({ media: { M1: { bytes: MP4, mime: 'video/mp4' } }, exec: makeExec({ duration: 5, streams: ['video'] }) })
  await s.inbound.process(payload([msg('video', 'v1', {})]))
  assert.equal(s.exec.of('soundtrack').length, 0, 'no audio extraction for a film with no audio')
  assert.equal(s.world.stt.length, 0)
  assert.equal(s.world.sent.length, 0)
  assert.doesNotMatch(task(s.world), /Tonspur/)
  assert.match(task(s.world), /^\[WhatsApp from \d+\] \[Video empfangen: .*video\.mp4, 5 s\]\nEinzelbilder \(5,/)
  assert.equal(s.inbound.counters.forwarded, 1)
  assert.equal(s.inbound.counters.mediaErrors, 0)
})

test('video with a silent soundtrack (empty transcript): the soundtrack part is left out, no error', async () => {
  for (const stt of [{ status: 200, body: { ok: true, text: '   ' } }, { status: 503, body: { ok: false, error: 'the STT command produced no transcript' } }]) {
    const s = setup({ media: { M1: { bytes: MP4, mime: 'video/mp4' } }, stt })
    await s.inbound.process(payload([msg('video', 'v1', {})]))
    assert.equal(s.world.stt.length, 1)
    assert.doesNotMatch(task(s.world), /Tonspur/)
    assert.equal(s.world.sent.length, 0)
    assert.deepEqual([s.inbound.counters.transcribeEmpty, s.inbound.counters.transcribeErrors, s.inbound.counters.mediaErrors, s.inbound.counters.forwarded], [1, 0, 0, 1])
  }
})

test('video longer than WHATSAPP_MAX_VIDEO_SECONDS: accepted, stills over the whole length, soundtrack cut at the limit — and the marker says so', async () => {
  const s = setup({ media: { M1: { bytes: MP4, mime: 'video/mp4' } }, exec: makeExec({ duration: 340 }), env: { WHATSAPP_MAX_VIDEO_SECONDS: '90' } })
  await s.inbound.process(payload([msg('video', 'v1', {})]))
  const sound = s.exec.of('soundtrack')[0].args
  assert.equal(sound[sound.indexOf('-t') + 1], '90')
  const starts = s.exec.of('frame').map((c) => Number(c.args[c.args.indexOf('-ss') + 1]))
  assert.ok(starts.at(-1) > 300, 'the last still is from the end of the video, not from the first 90 s')
  assert.match(task(s.world).split('\n')[0], /video\.mp4, 340 s — gekürzt: nur die ersten 90 s der Tonspur transkribiert\]/)
  assert.equal(s.inbound.counters.forwarded, 1)
})

/* --- failures: specific reply, no forward -------------------------------------------- */

test('file_size over WHATSAPP_MAX_MEDIA_BYTES (default 25 MB) → a hint, no download, mediaTooLarge, nothing on disk', async () => {
  for (const [type, extra] of [['image', {}], ['document', {}], ['video', {}]]) {
    const s = setup({ media: { M1: { bytes: JPG, mime: 'x/y', fileSize: 25 * 1024 * 1024 + 1 } } })
    await s.inbound.process(payload([msg(type, 'b1', extra)]))
    assert.equal(s.world.calls.some((u) => u.includes('lookaside')), false, `${type}: nothing was downloaded`)
    assert.equal(s.world.sent.length, 1)
    assert.match(replies(s.world)[0], /zu groß für mich \(mehr als 25 MB\)/)
    assert.equal(s.world.sent[0].to, FROM)
    assert.equal(forwarded(s.world).length, 0)
    assert.equal(s.exec.calls.length, 0)
    assert.equal(storedMedia(s.mediaDir), 0)
    assert.equal(s.inbound.counters.mediaTooLarge, 1)
    assert.equal(s.inbound.counters.mediaErrors, 0, 'too big is not a fault')
  }
})

test('the limit is configurable, and Meta\'s file_size is only a claim — the downloaded bytes are checked too', async () => {
  const s = setup({ env: { WHATSAPP_MAX_MEDIA_BYTES: '10' }, media: { M1: { bytes: JPG, mime: 'image/jpeg', fileSize: 5 } } })
  await s.inbound.process(payload([msg('image', 'b1', {})]))
  assert.equal(s.world.calls.some((u) => u.includes('lookaside')), true, 'file_size said 5: the download starts')
  assert.equal(forwarded(s.world).length, 0, '…but the 25 real bytes are over 10')
  assert.match(replies(s.world)[0], /zu groß/)
  assert.equal(s.inbound.counters.mediaTooLarge, 1)
  assert.equal(storedMedia(s.mediaDir), 0)
})

test('Graph error, failed download, no media id → "konnte die Datei nicht laden", mediaErrors, status + text in the log, no forward', async () => {
  const cases = [
    [{ M1: { bytes: JPG, mime: 'image/jpeg', lookupStatus: 400 } }, msg('image', 'e1', {}), /400.*Unsupported get request/],
    [{ M1: { bytes: JPG, mime: 'image/jpeg', downloadStatus: 401 } }, msg('image', 'e2', {}), /401.*Invalid OAuth/],
    [{ M1: { bytes: JPG, mime: 'image/jpeg', downloadThrows: 'socket hang up' } }, msg('document', 'e3', {}), /socket hang up/],
    [{}, { id: 'e4', from: FROM, type: 'video', video: {} }, /without a media id/],
  ]
  for (const [media, m, logged] of cases) {
    const s = setup({ media })
    await s.inbound.process(payload([m]))
    assert.match(replies(s.world)[0], /nicht laden/)
    assert.equal(s.world.sent.length, 1)
    assert.equal(forwarded(s.world).length, 0)
    assert.equal(s.inbound.counters.mediaErrors, 1)
    assert.ok(s.log.some((l) => logged.test(l)), String(logged))
    assert.equal(storedMedia(s.mediaDir), 0)
  }
})

test('ffmpeg missing: picture and document still work, only the video answers with a hint (and leaves nothing behind)', async () => {
  const exec = makeExec({ missing: ['ffmpeg', 'ffprobe'] })
  const s = setup({ exec, media: { M1: { bytes: MP4, mime: 'video/mp4' }, M2: { bytes: JPG, mime: 'image/jpeg' }, M3: { bytes: PDF, mime: 'application/pdf' } } })
  await s.inbound.process(payload([msg('video', 'v1', {}, 'M1'), msg('image', 'i1', {}, 'M2'), msg('document', 'd1', { filename: 'a.pdf' }, 'M3')]))
  assert.equal(s.world.sent.length, 1)
  assert.match(replies(s.world)[0], /Videos kann ich gerade nicht auswerten \(ffmpeg fehlt/)
  assert.equal(forwarded(s.world).length, 2, 'the picture and the document went through')
  const tasks = forwarded(s.world).map((c) => c.body.task)
  assert.match(tasks[0], /\[Bild empfangen: /)
  assert.match(tasks[1], /\[Dokument empfangen: .*a\.pdf, 3 Seiten\]/)
  assert.equal(fs.existsSync(folder(s, 'v1')), false, 'the half-handled video folder is gone')
  assert.deepEqual([s.inbound.counters.videosReceived, s.inbound.counters.imagesReceived, s.inbound.counters.documentsReceived, s.inbound.counters.mediaErrors, s.inbound.counters.forwarded], [1, 1, 1, 1, 2])
})

test('only ffprobe missing (or only ffmpeg): the same hint, no forward', async () => {
  for (const missing of [['ffprobe'], ['ffmpeg']]) {
    const s = setup({ exec: makeExec({ missing }), media: { M1: { bytes: MP4, mime: 'video/mp4' } } })
    await s.inbound.process(payload([msg('video', 'v1', {})]))
    assert.match(replies(s.world)[0], /ffmpeg fehlt/)
    assert.equal(forwarded(s.world).length, 0)
    assert.equal(s.inbound.counters.mediaErrors, 1)
  }
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
    const s = setup({ exec, media: { M1: { bytes: MP4, mime: 'video/mp4' } } })
    await s.inbound.process(payload([msg('video', 'v1', {})]))
    assert.match(replies(s.world)[0], /Video konnte ich nicht auslesen/)
    assert.equal(forwarded(s.world).length, 0)
    assert.equal(s.inbound.counters.mediaErrors, 1)
    assert.equal(fs.existsSync(folder(s, 'v1')), false)
    assert.ok(s.log.some((l) => /video not handled/.test(l)))
  }
})

test('one still failing is not the end: the ones that exist are used', async () => {
  const exec = makeExec()
  const inner = exec
  let n = 0
  const flaky = async (bin, args, opts) => (bin === 'ffmpeg' && !args.includes('-vn') && ++n === 2 ? { code: 1, stderr: 'seek failed' } : inner(bin, args, opts))
  const s = setup({ exec: flaky, media: { M1: { bytes: MP4, mime: 'video/mp4' } } })
  await s.inbound.process(payload([msg('video', 'v1', {})]))
  assert.match(task(s.world), /Einzelbilder \(5,/)
  assert.equal(s.inbound.counters.framesExtracted, 5)
})

test('the soundtrack cannot be transcribed (voice addon off / STT broken) → its own hint, no forward, folder removed', async () => {
  for (const [stt, reply] of [
    [{ status: 503, body: { ok: false, error: 'no ATLAS_VOICE_STT_CMD' } }, /Tonspur des Videos konnte ich nicht auswerten: Spracherkennung ist auf der Box gerade nicht aktiv/],
    [{ status: 404, body: {} }, /Spracherkennung ist auf der Box gerade nicht aktiv/],
    [{ status: 500, body: { error: 'x' } }, /Tonspur des Videos konnte ich nicht auswerten — versuch/],
  ]) {
    const s = setup({ stt, media: { M1: { bytes: MP4, mime: 'video/mp4' } } })
    await s.inbound.process(payload([msg('video', 'v1', {})]))
    assert.equal(s.world.sent.length, 1)
    assert.match(replies(s.world)[0], reply)
    assert.equal(replies(s.world)[0].includes('ATLAS_VOICE_STT_CMD'), false, 'the route\'s error text stays in the log')
    assert.equal(forwarded(s.world).length, 0)
    assert.equal(fs.existsSync(folder(s, 'v1')), false)
    assert.equal(s.inbound.counters.transcribeErrors, 1)
    assert.equal(s.inbound.counters.mediaErrors, 0, 'counted once, as a transcription error')
  }
})

test('the folder cannot be written → "nicht ablegen", mediaErrors, no forward', async () => {
  const s = setup({ media: { M1: { bytes: JPG, mime: 'image/jpeg' } } })
  fs.mkdirSync(path.dirname(s.mediaDir), { recursive: true })
  fs.writeFileSync(s.mediaDir, 'a file where the media folder should be')
  await s.inbound.process(payload([msg('image', 'w1', {})]))
  assert.match(replies(s.world)[0], /nicht ablegen/)
  assert.equal(forwarded(s.world).length, 0)
  assert.equal(s.inbound.counters.mediaErrors, 1)
})

/* --- retention ----------------------------------------------------------------------- */

test('retention: a new medium sweeps the day folders older than WHATSAPP_MEDIA_KEEP_DAYS (14) — and only those', async () => {
  const s = setup({ media: { M1: { bytes: JPG, mime: 'image/jpeg' } } })
  const day = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10)
  for (const [d, id] of [[day(15), 'old'], [day(40), 'older'], [day(14), 'edge'], [day(3), 'recent']]) {
    fs.mkdirSync(path.join(s.mediaDir, d, id), { recursive: true })
    fs.writeFileSync(path.join(s.mediaDir, d, id, 'image.jpg'), 'x')
  }
  fs.mkdirSync(path.join(s.mediaDir, 'notes-of-the-operator'), { recursive: true })
  fs.writeFileSync(path.join(s.mediaDir, 'loose-file.txt'), 'x')
  assert.equal(storedMedia(s.mediaDir), 4)

  await s.inbound.process(payload([msg('image', 'new1', {})]))
  assert.equal(fs.existsSync(path.join(s.mediaDir, day(15))), false)
  assert.equal(fs.existsSync(path.join(s.mediaDir, day(40))), false)
  assert.ok(fs.existsSync(path.join(s.mediaDir, day(14), 'edge')), 'exactly 14 days old is still kept')
  assert.ok(fs.existsSync(path.join(s.mediaDir, day(3), 'recent')))
  assert.ok(fs.existsSync(folder(s, 'new1')), 'the new one is there')
  assert.ok(fs.existsSync(path.join(s.mediaDir, 'notes-of-the-operator')), 'a folder that is not a date is never touched')
  assert.ok(fs.existsSync(path.join(s.mediaDir, 'loose-file.txt')))
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
  assert.equal(pruneMedia(path.join(dir, '2026-09-24', 'b', 'nope'), 1, now, () => {}), 0)
  const logged = []
  fs.writeFileSync(path.join(dir, 'afile'), 'x')
  assert.equal(pruneMedia(path.join(dir, 'afile'), 1, now, (m) => logged.push(m)), 0)
  assert.equal(logged.length, 1, 'ENOTDIR is logged, not thrown')
})

/* --- what did NOT change ----------------------------------------------------------------- */

test('sticker / location / contacts stay UNSUPPORTED; text and voice notes are untouched', async () => {
  const s = setup({ media: { M1: { bytes: JPG, mime: 'image/webp' } } })
  await s.inbound.process(payload([
    msg('sticker', 's1', {}),
    { id: 'l1', from: FROM, type: 'location', location: { latitude: 1, longitude: 2 } },
    { id: 'c1', from: FROM, type: 'contacts', contacts: [] },
    { id: 't1', from: FROM, type: 'text', text: { body: 'hallo' } },
  ]))
  assert.equal(replies(s.world).length, 3)
  for (const r of replies(s.world)) assert.match(r, /noch nicht lesen/)
  assert.equal(s.world.calls.some((u) => u.includes('M1') || u.includes('lookaside')), false)
  assert.equal(s.inbound.counters.unsupported, 3)
  assert.equal(forwarded(s.world).length, 1)
  assert.match(task(s.world), /\] hallo/)
  assert.equal(storedMedia(s.mediaDir), 0)
})

test('dedupe and the allowlist apply: a redelivered picture is handled once, a stranger\'s is dropped before any media call', async () => {
  const s = setup({ media: { M1: { bytes: JPG, mime: 'image/jpeg' } } })
  await s.inbound.process(payload([msg('image', 'dup', {})]))
  await s.inbound.process(payload([msg('image', 'dup', {})]))
  assert.equal(forwarded(s.world).length, 1)
  assert.equal(s.inbound.counters.duplicates, 1)
  assert.equal(s.inbound.counters.imagesReceived, 1)
  const before = s.world.calls.length
  await s.inbound.process(payload([{ ...msg('image', 'x1', {}), from: '4999000111' }]))
  assert.equal(s.world.calls.length, before)
  assert.equal(s.inbound.counters.dropped, 1)
  assert.equal(s.inbound.counters.imagesReceived, 1)
})

test('several files arrive in order, one at a time', async () => {
  const s = setup({ media: { M1: { bytes: JPG, mime: 'image/jpeg' }, M2: { bytes: PDF, mime: 'application/pdf' } } })
  await s.inbound.process(payload([msg('image', 'a', { caption: 'erst' }), msg('document', 'b', { filename: 'zweitens.pdf' }, 'M2'), { id: 't', from: FROM, type: 'text', text: { body: 'drittens' } }]))
  const tasks = forwarded(s.world).map((c) => c.body.task)
  assert.equal(tasks.length, 3)
  assert.match(tasks[0], /Bild empfangen.*erst/)
  assert.match(tasks[1], /Dokument empfangen.*zweitens\.pdf/)
  assert.match(tasks[2], /drittens/)
})

/* --- the agent's brief, status() ------------------------------------------------------------ */

test('the session brief explains the markers: paths are local files, look at them first; a video is stills + a transcript', () => {
  for (const b of [sessionBrief(), sessionBrief({ number: FROM, name: 'Ko' })]) {
    assert.match(b, /\[Bild empfangen: <path>\]/)
    assert.match(b, /\[Dokument empfangen: <path>, 3 Seiten\]/)
    assert.match(b, /\[Video empfangen: <path>, 12 s\]/)
    assert.match(b, /Einzelbilder/)
    assert.match(b, /Tonspur, transkribiert/)
    assert.match(b, /gekürzt/)
    assert.match(b, /LOCAL FILES/)
    assert.match(b, /LOOK AT THEM with your normal tools/)
    assert.match(b, /do NOT get the film/)
    assert.ok(b.includes('[Sprachnachricht, transkribiert]'), 'the voice-note paragraph is still there')
  }
})

test('status() carries media: the tools, what is stored, the limits — and the new counters', async () => {
  const dir = path.join(TMP, `status-${crypto.randomUUID()}`)
  fs.mkdirSync(path.join(dir, 'whatsapp-media', TODAY, 'm1'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'whatsapp-media', TODAY, 'm2'), { recursive: true })
  const real = globalThis.fetch
  globalThis.fetch = async () => ({ json: async () => ({ addons: [] }) })
  const keep = { ...process.env }
  Object.assign(process.env, ENV, { WHATSAPP_STATE_FILE: path.join(dir, 'whatsapp.json'), WHATSAPP_MAX_VIDEO_SECONDS: '45' })
  try {
    const st = registerAddon(ctx).status()
    assert.equal(typeof st.media.ffmpeg, 'boolean')
    assert.equal(typeof st.media.ffprobe, 'boolean')
    assert.equal(st.media.stored, 2)
    assert.equal(st.media.dir, path.join(dir, 'whatsapp-media'))
    assert.deepEqual([st.media.keepDays, st.media.maxMediaBytes, st.media.maxVideoSeconds, st.media.videoFrames], [14, 25 * 1024 * 1024, 45, 6])
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
  fs.mkdirSync(path.join(root, 'addons', 'whatsapp'), { recursive: true })
  fs.mkdirSync(bin)
  const here = new URL('..', import.meta.url).pathname
  fs.copyFileSync(path.join(here, 'install.sh'), path.join(root, 'addons', 'whatsapp', 'install.sh'))
  if (api) fs.cpSync(path.join(here, 'api'), path.join(root, 'addons', 'whatsapp', 'api'), { recursive: true })
  for (const t of ['bash', 'grep', 'dirname']) fs.symlinkSync(spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf-8' }).stdout.trim(), path.join(bin, t))
  fs.symlinkSync(process.execPath, path.join(bin, 'node'))
  for (const [name, body] of Object.entries(tools)) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  const r = spawnSync(path.join(bin, 'bash'), [path.join(root, 'addons', 'whatsapp', 'install.sh'), '--check'], {
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

test('install.sh --check: no ffmpeg at all → the existing gap now also says what a video gets', () => {
  const r = check({})
  assert.match(r.err, /voice replies need ffmpeg \(with libopus\) on PATH/)
  assert.match(r.err, /Incoming videos need it too \(plus ffprobe\)/)
})

test('install.sh --check: ffmpeg + ffprobe → no video gap; and what is stored, where, for how long', () => {
  const dir = path.join(TMP, `check-${crypto.randomUUID()}`)
  fs.mkdirSync(path.join(dir, 'whatsapp-media', TODAY, 'm1'), { recursive: true })
  const r = check({ tools: { ffmpeg: OPUS_FFMPEG, ffprobe: 'exit 0' }, env: { WHATSAPP_STATE_FILE: path.join(dir, 'whatsapp.json'), WHATSAPP_MEDIA_KEEP_DAYS: '7', WHATSAPP_MAX_VIDEO_SECONDS: '60' } })
  assert.doesNotMatch(r.err, /ffprobe/)
  assert.match(r.out, /incoming videos: ffmpeg and ffprobe found/)
  assert.match(r.out, new RegExp(`incoming media: 1 message\\(s\\) stored in ${path.join(dir, 'whatsapp-media')} \\(deleted after 7 days, at most 25 MB each; videos: 6 stills, soundtrack up to 60 s\\)`))
})

test('install.sh --check: without the addon\'s api/ next to it the media line is skipped quietly', () => {
  const r = check({ tools: { ffmpeg: OPUS_FFMPEG, ffprobe: 'exit 0' }, api: false })
  assert.doesNotMatch(r.out + r.err, /incoming media/)
  assert.doesNotMatch(r.err, /could not read the media status/)
})

/* ------------------------------------------------------------------ *
 * The quick-capture surface: a second entry point on the SPA bundle, routed
 * at /capture, that opens straight into one field and files a to-do through
 * the EXISTING create path.
 *
 * WHY THIS READS THE SOURCE instead of rendering — same reason as
 * MicField.test.mjs / TabBar.test.mjs: the web suite runs on `node --test`
 * through type-stripping, with no JSX transform and no DOM, so these .tsx
 * components cannot be executed here. What's asserted is therefore structural:
 * main.tsx routes the URL, QuickCapture reuses createTask (no bespoke fetch /
 * auth), it takes dictation via MicField, it prefills from the URL without
 * auto-submitting, and a failed POST returns before the field is cleared.
 * Run: node --test web/src/components/QuickCapture.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(dir, '..', '..')
const main = fs.readFileSync(path.join(dir, '..', 'main.tsx'), 'utf-8')
const src = fs.readFileSync(path.join(dir, 'QuickCapture.tsx'), 'utf-8')
const api = fs.readFileSync(path.join(dir, '..', 'lib', 'api.ts'), 'utf-8')

test('main.tsx routes /capture (and ?view=capture) to QuickCapture, everything else to AppShell', () => {
  assert.match(main, /import \{ QuickCapture \} from '\.\/components\/QuickCapture'/)
  assert.match(main, /\/\^\\\/capture\\\/\?\$\/\.test\(location\.pathname\)/, 'matches the /capture path')
  assert.match(main, /get\('view'\) === 'capture'/, 'also honours ?view=capture')
  assert.match(main, /render\(isCapture \? <QuickCapture \/> : <AppShell \/>/)
})

test('QuickCapture files through the shared createTask helper — no second write path, no auth here', () => {
  assert.match(src, /import \{ createTask \} from '\.\.\/lib\/api'/)
  assert.match(src, /createTask\(title, undefined, undefined, undefined, VAULT, SOURCE\)/)
  assert.ok(!src.includes('fetch('), 'no bespoke fetch — it goes through createTask')
  assert.ok(!/[Aa]uthorization/.test(src), 'no bearer/auth logic in the page (Caddy injects it server-side)')
  assert.match(src, /const VAULT = 'atlas'/, 'files into the typed Atlas vault')
})

test('the input is a MicField, so dictation lands in the field for review (never auto-sends)', () => {
  assert.match(src, /import \{ MicField \} from '\.\/MicField'/)
  assert.match(src, /<MicField value=\{text\} onChange=\{update\}>/)
  // Dictation feeds `onChange={update}` — the field's own setter — so a transcript
  // lands in the field. The write only ever happens in the submit handler.
  assert.equal((src.match(/createTask\(/g) || []).length, 1, 'createTask is invoked in exactly one place')
  assert.ok(
    src.indexOf('createTask(') > src.indexOf('const submit ='),
    'the createTask call sits inside the submit handler',
  )
})

test('prefill comes from ?text= / ?title= and is NOT auto-submitted', () => {
  assert.match(src, /new URLSearchParams\(location\.search\)/)
  assert.match(src, /p\.get\('text'\) \?\? p\.get\('title'\)/)
  assert.match(src, /useState\(prefill\)/, 'the field starts populated from the URL')
  // The mount effects only focus / swap the manifest — neither writes a task.
  const effects = src.slice(src.indexOf('  useEffect('), src.indexOf('const update'))
  assert.ok(!effects.includes('createTask'), 'no mount effect files a task')
  assert.ok(!/\bsubmit\(/.test(effects), 'no mount effect invokes the submit handler')
})

test('a failed POST keeps the typed text — the error branch returns before the field is cleared', () => {
  const body = src.slice(src.indexOf('const submit ='), src.indexOf('return (\n'))
  const errIdx = body.indexOf('if (!r.ok)')
  const clearIdx = body.indexOf("setText('')")
  assert.ok(errIdx !== -1 && clearIdx !== -1)
  assert.ok(errIdx < clearIdx, 'the failure check comes before the clear')
  const errBranch = body.slice(errIdx, clearIdx)
  assert.match(errBranch, /setError\(/, 'the failure is shown')
  assert.match(errBranch, /\breturn\b/, 'and the handler returns before clearing')
})

test('pinning /capture lands on the capture screen — its own manifest, swapped in while mounted', () => {
  assert.match(src, /link\?\.setAttribute\('href', CAPTURE_MANIFEST\)/)
  assert.match(src, /const CAPTURE_MANIFEST = '\/capture\.webmanifest'/)
  const manifest = JSON.parse(fs.readFileSync(path.join(webRoot, 'public', 'capture.webmanifest'), 'utf-8'))
  assert.equal(manifest.start_url, '/capture')
  assert.equal(manifest.display, 'standalone')
})

test('createTask carries an optional `source` through to POST /api/tasks/new', () => {
  assert.match(api, /vault\?: string,\n\s*source\?: string,\n\s*\): Promise</)
  assert.match(api, /source: source \|\| undefined,/)
})

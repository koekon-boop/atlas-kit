/* ------------------------------------------------------------------ *
 * The Jarvis tab wiring (JarvisCenter.tsx + jarvis/Reactor.tsx).
 *
 * Read as SOURCE, like TabBar.test.mjs: the web suite runs on `node --test`
 * with no JSX transform and no DOM, so the .tsx cannot execute here. The pure
 * decisions are in lib/jarvis.test.mjs; this file pins the promises the
 * component makes that are easy to lose in a refactor:
 *   · it is a top-level tab routed by AppShell, like News;
 *   · addon-backed parts are RUNTIME-gated (voice, weather, news-ingest) and
 *     their loaders never call an addon route while the gate is shut;
 *   · the brain is the existing knowledge-chat API, not a new endpoint;
 *   · voice REUSES the shared paths (useDictation, speak.ts, nextSpeech);
 *   · the playback analyser is only CREATED from a gesture (engage), and the
 *     animation frame only reads the existing one — creating it off-gesture
 *     would route the shared <audio> through a suspended context and silence it;
 *   · the idle reactor does not run an animation loop (the dashboard runs on a TV).
 * Run: node --test web/src/components/JarvisCenter.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const read = (...p) => fs.readFileSync(path.join(dir, ...p), 'utf-8')
const tabBar = read('TabBar.tsx')
const appShell = read('AppShell.tsx')
const jarvis = read('JarvisCenter.tsx')
const reactor = read('jarvis', 'Reactor.tsx')

test('Jarvis is a fourth top-level tab with its own page component', () => {
  assert.match(tabBar, /export type TabId = 'command' \| 'atlas' \| 'news' \| 'jarvis'/)
  assert.match(tabBar, /\{\s*id:\s*'jarvis',\s*label:\s*'Jarvis',\s*short:\s*'Jarvis'\s*\}/)
  assert.match(appShell, /import \{ JarvisCenter \} from '\.\/JarvisCenter'/)
  assert.match(appShell, /<JarvisCenter \/>/)
})

test('addon-backed parts are gated at runtime and never fetched while off', () => {
  assert.match(jarvis, /weatherOn \? fetchWeather\(\) : Promise\.resolve\(null\)/)
  assert.match(jarvis, /newsOn \? fetchNews\(10\) : Promise\.resolve\(null\)/)
  assert.match(jarvis, /addons\.enabled\('voice'\)/)
})

test('the brain is the existing knowledge-chat API over the Atlas', () => {
  assert.match(jarvis, /spawnAgent\(\{ task: jarvisTask\(t\), kind: 'knowledge', vault: VAULT/)
  assert.match(jarvis, /queueAgent\(/)
  assert.match(jarvis, /promptAgent\(/)
  assert.match(jarvis, /fetchAgentHistory\(/)
})

test('voice reuses the shared paths instead of a second implementation', () => {
  assert.match(jarvis, /useDictation\(/)
  assert.match(jarvis, /sayAloud\(/)
  assert.match(jarvis, /nextSpeech\(/)
  assert.ok(!/new SpeechSynthesisUtterance|fetch\(`\$\{API_BASE\}\/voice/.test(jarvis), 'no private TTS path')
})

test('the playback analyser is created only from a gesture', () => {
  const engage = jarvis.slice(jarvis.indexOf('const engage = () =>'), jarvis.indexOf('const say = '))
  assert.match(engage, /speechAnalyser\(\)/)
  const level = jarvis.slice(jarvis.indexOf('const level = () =>'), jarvis.indexOf('const mode: ReactorMode'))
  assert.match(level, /currentSpeechAnalyser\(\)/)
  assert.ok(!/[^t]speechAnalyser\(\)/.test(level.replace('currentSpeechAnalyser()', '')), 'the frame-time path never creates one')
})

test('the idle reactor draws one frame and stops', () => {
  assert.match(reactor, /if \(mode !== 'idle'\) raf = requestAnimationFrame\(frame\)/)
  assert.match(reactor, /prefers-reduced-motion: reduce/)
})

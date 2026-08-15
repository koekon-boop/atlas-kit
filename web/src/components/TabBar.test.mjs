/* ------------------------------------------------------------------ *
 * The News tab wiring: the news-ingest addon's card moved off the Home tab
 * onto its own top-level tab, alongside Home and Atlas.
 *
 * WHY THIS READS THE SOURCE instead of rendering — same reason as
 * MicField.test.mjs: the web suite runs on `node --test` through
 * type-stripping, with no JSX transform and no DOM, so these .tsx components
 * cannot be executed here. What's asserted is therefore structural: the tab
 * is registered, AppShell routes it to its own page, the News card itself
 * still owns the runtime addon gate (GET /api/addons), and the Home tab no
 * longer mounts it.
 * Run: node --test web/src/components/TabBar.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const tabBar = fs.readFileSync(path.join(dir, 'TabBar.tsx'), 'utf-8')
const appShell = fs.readFileSync(path.join(dir, 'AppShell.tsx'), 'utf-8')
const commandCenter = fs.readFileSync(path.join(dir, 'CommandCenter.tsx'), 'utf-8')
const newsCenter = fs.readFileSync(path.join(dir, 'NewsCenter.tsx'), 'utf-8')
const newsCard = fs.readFileSync(path.join(dir, 'cards', 'News.tsx'), 'utf-8')

test('News is a third top-level tab, alongside Home and Atlas', () => {
  assert.match(tabBar, /export type TabId = 'command' \| 'atlas' \| 'news'/)
  assert.match(tabBar, /\{\s*id:\s*'news',\s*label:\s*'News',\s*short:\s*'News'\s*\}/)
  // Registered after Home and Atlas, not ahead of them.
  const order = ['command', 'atlas', 'news'].map((id) => tabBar.indexOf(`id: '${id}'`))
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'tabs stay in Home, Atlas, News order')
})

test('AppShell routes the news tab to its own page component', () => {
  assert.match(appShell, /import \{ NewsCenter \} from '\.\/NewsCenter'/)
  assert.match(
    appShell,
    /active === 'command'\s*\?\s*<CommandCenter \/>\s*:\s*active === 'atlas'\s*\?\s*<AtlasCenter \/>\s*:\s*<NewsCenter \/>/,
  )
})

test('the News card no longer mounts on the Home tab', () => {
  assert.ok(!commandCenter.includes("from './cards/News'"), 'CommandCenter no longer imports the News card')
  assert.ok(!commandCenter.includes('<News '), 'CommandCenter no longer renders the News card')
})

test('NewsCenter mounts the News card as its sole content, with a note reader for its rows', () => {
  assert.match(newsCenter, /import \{ News \} from '\.\/cards\/News'/)
  assert.match(newsCenter, /<News className="col-span-12" onOpenWiki=\{openPath\} \/>/)
  assert.ok(newsCenter.includes('<NoteReader'), 'headlines still open through the shared reader, like the other tabs')
})

test('the News card keeps its own runtime addon gate — unchanged by the move', () => {
  assert.ok(newsCard.includes("addons.enabled('news-ingest')"), 'still asks GET /api/addons whether THIS box runs it')
  assert.match(newsCard, /if \(!enabled\) return null/, 'still renders nothing when the addon is not enabled')
})

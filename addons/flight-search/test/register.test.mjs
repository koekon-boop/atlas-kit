/* ------------------------------------------------------------------ *
 * Guards the CONTRACT WITH CORE (docs/ADDONS.md), which is the part a reviewer
 * of the flight logic will not think to check:
 *
 *   · `register()` must not throw — on this box there is no DUFFEL_API_TOKEN,
 *     and an optional addon that fails to load costs the operator the dashboard
 *   · it must register ONLY the hooks it uses: no routes (so no bearer gate and
 *     no Caddyfile block to forget), no cron, no search leg, no evidence leg,
 *     no scorecard tiles
 *   · the tool must be box-local — NOT in core's `KNOWLEDGE_TOOLS`, the fixed
 *     audited set the remote connector serves
 *   · the addon must add no npm dependency of its own
 *   · and the schema has to be one a real McpServer accepts, or the tool is
 *     "registered" only in the sense that nothing threw at boot
 * Run: node --test addons/flight-search/test/register.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ADDON_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const REPO_ROOT = path.resolve(ADDON_DIR, '..', '..')
const register = (await import('../api/register.mjs')).default

/* The box this was written on has no token, so the tests inherit that state on
 * purpose — every assertion below is about the UNCONFIGURED addon, which is the
 * one an operator first meets. */
const savedToken = process.env.DUFFEL_API_TOKEN
delete process.env.DUFFEL_API_TOKEN
process.on('exit', () => { if (savedToken !== undefined) process.env.DUFFEL_API_TOKEN = savedToken })

test('register() returns ONLY the hooks this addon uses', () => {
  const m = register({ name: 'flight-search', dir: ADDON_DIR, repoRoot: REPO_ROOT })
  assert.deepEqual(Object.keys(m).filter((k) => m[k] != null).sort(), ['description', 'mcpTools', 'status'])
  // Named explicitly: each of these would be a new obligation on core.
  for (const hook of ['routes', 'cron', 'searchLeg', 'evidenceLeg', 'scorecardStats']) assert.equal(m[hook], undefined, `${hook} must not be registered`)
  assert.match(m.description, /Duffel/)
  assert.match(m.description, /inert without one/)
})

test('register() does not throw, and costs nothing, without a token', () => {
  const m = register({ name: 'flight-search', dir: ADDON_DIR, repoRoot: REPO_ROOT })
  const s = m.status()
  assert.equal(s.ready, false)
  assert.deepEqual(s.sources, [{ name: 'duffel', label: 'Duffel (api.duffel.com)', configured: false, reason: 'DUFFEL_API_TOKEN is not set' }])
  assert.match(s.howToEnable, /DUFFEL_API_TOKEN=duffel_test_/)
  assert.equal(s.tool, 'search_flights')
  // Registering twice is what a second MCP surface in the same process does.
  assert.doesNotThrow(() => register({ name: 'flight-search', dir: ADDON_DIR, repoRoot: REPO_ROOT }))
})

test('status() reports readiness without ever printing the token', () => {
  process.env.DUFFEL_API_TOKEN = 'duffel_test_THIS_IS_SECRET'
  try {
    const s = register({ name: 'flight-search', dir: ADDON_DIR, repoRoot: REPO_ROOT }).status()
    assert.equal(s.ready, true)
    assert.equal(s.sources[0].mode, 'test')
    assert.equal(s.howToEnable, undefined) // nothing to tell an operator who is done
    assert.ok(!JSON.stringify(s).includes('THIS_IS_SECRET'))
  } finally {
    delete process.env.DUFFEL_API_TOKEN
  }
})

test('the tool answers rather than throwing when there is nothing to search with', async () => {
  const [tool] = register({ name: 'flight-search', dir: ADDON_DIR, repoRoot: REPO_ROOT }).mcpTools
  assert.equal(tool.name, 'search_flights')
  const r = await tool.handler({ origin: 'BER', destination: 'HND', departureDate: '2026-10-15' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /no flight source is configured/)
  assert.match(r.howToEnable, /app\.duffel\.com\/join/)
  // Even a request that is nonsense comes back as an answer, not an exception.
  assert.equal((await tool.handler({})).ok, false)
  assert.equal((await tool.handler()).ok, false)
})

test('the tool description tells a model what it costs and what it will not do', () => {
  const [tool] = register({ name: 'flight-search', dir: ADDON_DIR, repoRoot: REPO_ROOT }).mcpTools
  assert.match(tool.description, /PARETO FRONT/)
  assert.match(tool.description, /maxAdapterCalls/)
  assert.match(tool.description, /does NOT book/i)
  assert.match(tool.description, /expand a Star Alliance preference/)
})

test('THE SCHEMA IS ONE A REAL McpServer ACCEPTS — a bad one is skipped silently at boot', async () => {
  // Core catches a registerTool that throws and logs it, so a malformed schema
  // would cost the tool without costing the process: nothing else would notice.
  const req = createRequire(path.join(REPO_ROOT, 'api', 'src', 'addons.mjs'))
  let McpServer
  try {
    McpServer = (await import(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/server/mcp.js')).href)).McpServer
  } catch {
    assert.fail('the MCP SDK is not installed in api/node_modules — run `npm ci` in api/ (CI does)')
  }
  const server = new McpServer({ name: 'test', version: '0' })
  const [tool] = register({ name: 'flight-search', dir: ADDON_DIR, repoRoot: REPO_ROOT }).mcpTools
  assert.doesNotThrow(() => server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, async () => ({ content: [] })))
})

test('BOX-LOCAL: the tool is not in core\'s remote knowledge surface', () => {
  const tools = fs.readFileSync(path.join(REPO_ROOT, 'api', 'src', 'mcp', 'tools.mjs'), 'utf-8')
  const knowledge = /KNOWLEDGE_TOOLS = new Set\(\[([^\]]*)\]/.exec(tools)
  assert.ok(knowledge, 'KNOWLEDGE_TOOLS could not be found in api/src/mcp/tools.mjs')
  assert.ok(!knowledge[1].includes('search_flights'), 'search_flights was added to the audited remote surface — that is a deliberate change, not an addon side effect')
})

test('the addon adds no npm dependency of its own', () => {
  for (const f of ['package.json', 'package-lock.json', 'node_modules']) assert.equal(fs.existsSync(path.join(ADDON_DIR, f)), false, `addons/flight-search/${f} must not exist`)
  // Every import in api/ is a node builtin or a relative path inside the addon.
  const files = fs.readdirSync(path.join(ADDON_DIR, 'api'), { recursive: true }).filter((f) => String(f).endsWith('.mjs'))
  for (const f of files) {
    const src = fs.readFileSync(path.join(ADDON_DIR, 'api', String(f)), 'utf-8')
    for (const [, spec] of src.matchAll(/^import .*? from '([^']+)'/gm)) {
      assert.ok(spec.startsWith('node:') || spec.startsWith('.'), `api/${f} imports "${spec}" — an addon may only import node builtins and its own files`)
    }
  }
})

test('the addon is documented the way docs/ADDONS.md asks — honestly, including the limits', () => {
  const readme = fs.readFileSync(path.join(ADDON_DIR, 'README.md'), 'utf-8')
  for (const must of ['What it cannot do', 'What it costs', 'ATLAS_ADDONS', 'scripts/serve.sh restart', 'DUFFEL_API_TOKEN']) {
    assert.ok(readme.includes(must), `README.md is missing "${must}"`)
  }
  // The addon is listed in the shipped catalog, which is step 6 of the checklist.
  const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'ADDONS.md'), 'utf-8')
  assert.ok(doc.includes('flight-search'), 'docs/ADDONS.md does not list this addon in its catalog')
})

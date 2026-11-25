/* ------------------------------------------------------------------ *
 * A LEAN knowledge chat (`lean: true` on POST /api/agents/spawn) — the start
 * context addons/telegram's PAID fallback session needs, and nothing more.
 *
 * Measured on the box (claude 2.1.332, Atlas vault as cwd, first-turn usage):
 *   plain Atlas chat (control MCP, default tools, skills, memory) ≈ 67k tokens
 *   + its ~39k-character opening prompt (preambles + retrieved evidence)
 *   lean (read-only MCP, 8 built-in tools, no skills, no memory)  ≈ 12k tokens
 *
 * Pinned here:
 *   1. the lean template's flags — and that `--tools=` cannot swallow the prompt
 *   2. a lean chat RESUMES lean (never with the orchestrator's control tools)
 *   3. without `lean`, every launch line is exactly what it was
 *   4. the route validates `lean` (boolean, knowledge only)
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-lean-chat-'))
process.env.AGENT_LOCAL_DIR = STATE_DIR
process.env.AGENT_LOCAL_RECONCILE = '0'
process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-lean-chat-ws-'))

const local = await import('../src/agent-local.mjs')
const { knowledgeLaunch, launchCommand, LEAN_KNOWLEDGE_LAUNCH_CMD, LEAN_RESUME_CMD, KNOWLEDGE_LAUNCH_CMD, ATLAS_CONTROL_LAUNCH_CMD } = local

const TOOLS = '--tools=Bash,Read,Grep,Glob,Edit,Write,WebFetch,WebSearch'

test('the lean launch: read-only MCP, eight tools, no skills, no auto-memory', () => {
  const launch = knowledgeLaunch({ id: 'kb-lean', sid: 'sid-1', vaultKey: 'atlas', model: 'opus', effort: 'xhigh', prompt: 'P', lean: true })
  assert.match(launch, /CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 env /)
  assert.match(launch, /\/api\/src\/mcp\/dev\.mcp\.json --strict-mcp-config/)
  assert.doesNotMatch(launch, /control\.mcp\.json/, 'never the orchestrator tools')
  assert.doesNotMatch(launch, /ATLAS_SESSION=/)
  assert.ok(launch.includes('--disable-slash-commands'))
  assert.ok(launch.includes(TOOLS))
  assert.match(launch, /--session-id 'sid-1'/)
  // `--tools` is variadic: written with a space, it would take the prompt for a
  // tool name ("…was read as a value of --tools, not as a prompt"). The `=`
  // form ends the list, and the prompt is a separate, later argument.
  assert.doesNotMatch(LEAN_KNOWLEDGE_LAUNCH_CMD, /--tools\s/)
  assert.match(launch, new RegExp(`${TOOLS} --dangerously-skip-permissions "\\$ATLAS_PROMPT"$`))
})

test('a lean chat resumes lean', () => {
  const resume = launchCommand(LEAN_RESUME_CMD, { model: 'opus', effort: 'xhigh', sid: 'sid-1' })
  assert.match(resume, /CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 env /)
  assert.ok(resume.includes('dev.mcp.json --strict-mcp-config --disable-slash-commands'))
  assert.ok(resume.includes(TOOLS))
  assert.match(resume, /--resume 'sid-1'$/)
  assert.doesNotMatch(resume, /control\.mcp\.json/)
  // …and launchResume picks it from the persisted flag, ahead of the vault rule.
  const src = fs.readFileSync(new URL('../src/agent-local.mjs', import.meta.url), 'utf-8')
  assert.match(src, /const tmpl = s\.lean \? LEAN_RESUME_CMD : s\.vault === 'atlas' \? ATLAS_CONTROL_RESUME_CMD : RESUME_CMD/)
  assert.match(src, /\.\.\.\(lean \? \{ lean: true \} : \{\}\),\n\s+status: 'running'/, 'the flag is persisted on the session record')
})

test('without `lean`, the knowledge launch lines are unchanged', () => {
  const atlas = knowledgeLaunch({ id: 'kb-a', sid: 's', vaultKey: 'atlas', model: 'm', effort: 'xhigh', prompt: 'P' })
  const work = knowledgeLaunch({ id: 'kb-w', sid: 's', vaultKey: 'work', model: 'm', effort: 'xhigh', prompt: 'P' })
  const tail = (tmpl) => launchCommand(tmpl, { atlasSession: 'kb-a', model: 'm', effort: 'xhigh', sid: 's' }).replace('{task}', '"$ATLAS_PROMPT"')
  assert.ok(atlas.endsWith(tail(ATLAS_CONTROL_LAUNCH_CMD)))
  assert.ok(work.endsWith(tail(KNOWLEDGE_LAUNCH_CMD).replace("'kb-a'", "'kb-w'")))
  for (const l of [atlas, work]) {
    assert.doesNotMatch(l, /--disable-slash-commands|--tools=|DISABLE_AUTO_MEMORY/)
  }
})

test('the route: `lean` is a boolean, for knowledge chats only, and drops the standing preamble', async () => {
  const { agentRouter } = await import('../src/agent-routes.mjs')
  const layer = agentRouter((_r, _s, next) => next()).stack.find((l) => l.route?.path === '/api/agents/spawn')
  const handle = layer.route.stack.at(-1).handle
  const call = (body) =>
    new Promise((resolve) => {
      handle({ body, method: 'POST', headers: {} }, {
        status(code) { this._code = code; return this },
        json(payload) { resolve({ status: this._code ?? 200, body: payload }) },
      }, () => {})
    })
  const notBool = await call({ task: 't', kind: 'knowledge', lean: 'yes' })
  assert.equal(notBool.status, 400)
  assert.match(notBool.body.error, /"lean" must be true or false/)
  const dev = await call({ task: 't', repo: 'demo', lean: true })
  assert.equal(dev.status, 400)
  assert.match(dev.body.error, /"lean" is for knowledge chats only/)
  // A valid lean chat clears every check and stops at the box-local executor
  // gate (this hermetic run has no repo allowlist) — past validation.
  const ok = await call({ task: 't', kind: 'knowledge', vault: 'atlas', lean: true })
  assert.doesNotMatch(String(ok.body.error || ''), /lean/)
  // No standing preamble and no evidence for a lean chat — the caller's task is the brief.
  const routes = fs.readFileSync(new URL('../src/agent-routes.mjs', import.meta.url), 'utf-8')
  assert.match(routes, /const preamble = lean \? undefined : /)
  const src = fs.readFileSync(new URL('../src/agent-local.mjs', import.meta.url), 'utf-8')
  assert.match(src, /const context = lean \? '' : await chatEvidence\(/)
  assert.equal(local.knowledgePrompt({ id: 'kb-x', question: 'BRIEF', preamble: undefined, context: '' }), 'BRIEF')
})

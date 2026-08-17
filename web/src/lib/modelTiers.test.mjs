/* ------------------------------------------------------------------ *
 * Tests for the spawn form's model options under a provider profile
 * (modelTiers.ts).
 *
 * The defect these pin: with `DeepSeek (OpenRouter)` picked, the model dropdown
 * still read "Opus / Sonnet" — so the form never said what would actually run,
 * and the provider selection read as having no effect at all. It HAS an effect
 * (the tier alias resolves through the profile's ANTHROPIC_DEFAULT_<TIER>_MODEL),
 * which is why the fix is the label, plus not offering a tier the profile does
 * not map — the spawn route refuses that combination with a 400.
 *
 * Two invariants beyond the labels:
 *   - NO PROFILE ⇒ byte-identical to before: the full list, unlabelled, Fable
 *     included. Zero profiles must stay zero change.
 *   - The form is never left on a selection the server would refuse.
 *
 * Runs the real TS module via node's native type-stripping (no build, no
 * node_modules): modelTiers.ts imports only a type.
 * Run: node --test web/src/lib/modelTiers.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { modelOptions, keepModel, modelTitle } from './modelTiers.ts'

// This form's own tiers, in its own order — what AgentList passes.
const DEV = ['fable', 'opus', 'sonnet']
// A fork of the kit offers Haiku as a third spawn model; the helper must follow
// the form it is given rather than a hardcoded pair.
const FORK = ['fable', 'opus', 'sonnet', 'haiku']

const ALL = {
  name: 'deepseek-openrouter',
  label: 'DeepSeek (OpenRouter)',
  tiers: { opus: 'deepseek/deepseek-v4-pro', sonnet: 'deepseek/deepseek-v4-flash', haiku: 'deepseek/deepseek-v4-flash' },
}
const PARTIAL = { name: 'sonnet-only', label: 'Sonnet only', tiers: { sonnet: 'some/cheap-model' } }
const NO_TIERS = { name: 'bare', label: 'Bare backend', tiers: {} }

test('NO PROVIDER: exactly the list the form has always shown', () => {
  assert.deepEqual(modelOptions(DEV), [
    { value: 'fable', label: 'Fable' },
    { value: 'opus', label: 'Opus' },
    { value: 'sonnet', label: 'Sonnet' },
  ])
  assert.deepEqual(modelOptions(DEV, null), modelOptions(DEV))
})

test('a profile mapping every tier LABELS each with the model it maps to', () => {
  assert.deepEqual(modelOptions(DEV, ALL), [
    { value: 'opus', label: 'Opus → deepseek/deepseek-v4-pro' },
    { value: 'sonnet', label: 'Sonnet → deepseek/deepseek-v4-flash' },
  ])
  // Fable is gone under any profile: there is no ANTHROPIC_DEFAULT_FABLE_MODEL,
  // so the alias would reach the gateway as the literal model name `fable`.
  assert.ok(!modelOptions(DEV, ALL).some((o) => o.value === 'fable'))
})

test('a partial profile offers ONLY what it maps — an unmapped tier 400s at spawn', () => {
  assert.deepEqual(modelOptions(DEV, PARTIAL), [{ value: 'sonnet', label: 'Sonnet → some/cheap-model' }])
})

test('a fork that offers Haiku gains it when — and only when — the profile maps it', () => {
  assert.deepEqual(
    modelOptions(FORK, ALL).map((o) => o.value),
    ['opus', 'sonnet', 'haiku'],
  )
  assert.deepEqual(
    modelOptions(FORK, PARTIAL).map((o) => o.value),
    ['sonnet'],
  )
})

test('a profile with NO tier vars degrades to plain labels, never to an empty picker', () => {
  // Nothing is known about the mapping, so nothing is claimed about it — but the
  // spawn still works (the route keeps its default opus/sonnet set for exactly
  // this profile), so the options must stay.
  assert.deepEqual(modelOptions(DEV, NO_TIERS), [
    { value: 'opus', label: 'Opus' },
    { value: 'sonnet', label: 'Sonnet' },
  ])
  // Same degrade when a profile maps only tiers THIS form does not offer:
  // hiding everything would leave an unusable empty select.
  const haikuOnly = { name: 'h', label: 'Haiku only', tiers: { haiku: 'x/y' } }
  assert.deepEqual(modelOptions(DEV, haikuOnly), [
    { value: 'opus', label: 'Opus' },
    { value: 'sonnet', label: 'Sonnet' },
  ])
})

test('a missing `tiers` key (an older API on a mixed deploy) reads as no tiers', () => {
  assert.deepEqual(modelOptions(DEV, { name: 'old', label: 'Old' }), [
    { value: 'opus', label: 'Opus' },
    { value: 'sonnet', label: 'Sonnet' },
  ])
})

test('switching provider never leaves the form on a combination the server refuses', () => {
  // Fable + any profile: moves to this form's default.
  assert.equal(keepModel('fable', modelOptions(DEV, ALL), 'sonnet'), 'sonnet')
  // An already-mapped pick is kept — switching backend must not reset a choice.
  assert.equal(keepModel('opus', modelOptions(DEV, ALL), 'sonnet'), 'opus')
  // The default itself unmapped → the first tier the profile DOES map.
  assert.equal(keepModel('opus', modelOptions(DEV, { name: 'o', label: 'O', tiers: { opus: 'a/b' } }), 'sonnet'), 'opus')
  assert.equal(keepModel('fable', modelOptions(DEV, PARTIAL), 'opus'), 'sonnet')
  // …and switching back to Anthropic restores the full list, Fable included.
  assert.equal(keepModel('fable', modelOptions(DEV), 'sonnet'), 'fable')
})

test('the tooltip stops claiming 1M context for someone else’s backend', () => {
  assert.match(modelTitle(), /1M-context/)
  assert.doesNotMatch(modelTitle(ALL), /1M/)
  assert.match(modelTitle(ALL), /DeepSeek \(OpenRouter\)/)
  // Each form names what it spawns — a dev agent, or a knowledge/Atlas chat.
  assert.match(modelTitle(null, 'chat'), /for this chat/)
  assert.match(modelTitle(ALL, 'chat'), /for this chat/)
  // This fork's own wording: Haiku is the one tier with no 1M-context variant.
  assert.match(modelTitle(), /except Haiku/)
})

/* --- this fork's Haiku tier ------------------------------------------------ *
 * The tests above prove the HELPER follows the list it is given. These prove
 * the two forms actually give it a list with `haiku` in it — the half a clean
 * textual merge of an upstream that has no Haiku tier silently drops, since
 * upstream rewrote the literal <option> elements into a .map over module consts
 * of its own (DEV_TIERS / CHAT_TIERS).
 *
 * Read from source rather than imported for the same reason TabBar.test.mjs
 * does it: the web suite runs on node's type-stripping, with no JSX transform,
 * so a .tsx card cannot be executed here.
 * --------------------------------------------------------------------------- */
const cards = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'components', 'cards')
/** The tier array a card declares, as real strings — the input its dropdown maps. */
const tiersIn = (file, name) => {
  const src = fs.readFileSync(path.join(cards, `${file}.tsx`), 'utf-8')
  const m = src.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`))
  assert.ok(m, `${file}.tsx no longer declares ${name}`)
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
}

for (const [file, name, fallback] of [
  ['AgentList', 'DEV_TIERS', 'sonnet'],
  ['KnowledgeAgents', 'CHAT_TIERS', 'opus'],
]) {
  test(`${file}: Haiku is offered with no profile, and with a profile that maps it`, () => {
    const tiers = tiersIn(file, name)
    assert.ok(tiers.includes('haiku'), `${name} lost this fork's haiku tier`)
    // No provider: the full unlabelled list, Haiku included — today's dropdown.
    assert.deepEqual(modelOptions(tiers).map((o) => o.value), ['fable', 'opus', 'sonnet', 'haiku'])
    // A profile mapping ANTHROPIC_DEFAULT_HAIKU_MODEL offers it, labelled.
    assert.deepEqual(modelOptions(tiers, ALL).map((o) => o.value), ['opus', 'sonnet', 'haiku'])
    assert.equal(modelOptions(tiers, ALL).at(-1).label, 'Haiku → deepseek/deepseek-v4-flash')
    // A profile that does NOT map haiku must not offer it (the spawn route 400s).
    assert.deepEqual(modelOptions(tiers, PARTIAL).map((o) => o.value), ['sonnet'])
    // …and the form is never left sitting on a tier that profile refuses.
    assert.equal(keepModel('haiku', modelOptions(tiers, PARTIAL), fallback), 'sonnet')
    assert.equal(keepModel('haiku', modelOptions(tiers, ALL), fallback), 'haiku')
  })
}

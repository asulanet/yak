import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'url'

import {
  advanceFallback,
  buildFallbackChain,
  describeDegradation,
  pickDefaultPreset,
  pickDomainPreset,
  resolveTaskModel,
} from '../../yak/plugins/planning-files/model-routing.js'

const WORKFLOW = {
  model_presets: {
    'fixer':          { subagent_type: 'fixer',     provider: 'openai',    model: 'gpt-5.4-mini',      variant: 'low' },
    'sonnet-impl':    { subagent_type: 'fixer',     provider: 'anthropic', model: 'claude-sonnet-4-5', variant: 'medium' },
    'opus-impl':      { subagent_type: 'fixer',     provider: 'anthropic', model: 'claude-opus-4-7',   variant: 'max' },
    'coder-hi':       { subagent_type: 'fixer',     provider: 'openai',    model: 'gpt-5.4',           variant: 'high' },
    'fixer-mid':      { subagent_type: 'fixer',     provider: 'anthropic', model: 'claude-sonnet-4-5', variant: 'low' },
    'oracle':         { subagent_type: 'oracle',    provider: 'openai',    model: 'gpt-5.4',           variant: 'xhigh' },
    'opus-review':    { subagent_type: 'oracle',    provider: 'anthropic', model: 'claude-opus-4-7',   variant: 'max' },
    'opus-critic':    { subagent_type: 'oracle',    provider: 'anthropic', model: 'claude-opus-4-7',   variant: 'max' },
    'orchestrator':   { subagent_type: 'orchestrator', provider: 'anthropic', model: 'claude-opus-4-7', variant: 'max' },
    'designer':       { subagent_type: 'designer',  provider: 'google',    model: 'gemini-3.1-pro-preview', variant: 'high' },
  },
  model_routes: {
    implementer: { low: 'fixer', medium: 'sonnet-impl', high: 'opus-impl' },
    reviewer:    { low: 'orchestrator', medium: 'oracle', high: 'opus-review' },
    critic:      { low: 'opus-critic', medium: 'opus-critic', high: 'opus-critic' },
    designer:    { low: 'designer', medium: 'designer', high: 'designer' },
    fixer:       { low: 'fixer', medium: 'fixer-mid', high: 'coder-hi' },
  },
  domain_routes: {
    graphql: 'coder-hi',
    'plan-critic': 'opus-critic',
    ui: 'designer',
    refactor: 'sonnet-impl',
  },
  model_fallbacks: {
    'opus-impl':   ['opus-impl', 'sonnet-impl', 'coder-hi', 'fixer-mid', 'fixer'],
    'opus-review': ['opus-review', 'oracle', 'orchestrator'],
    'opus-critic': ['opus-critic', 'opus-review', 'oracle'],
    'oracle':      ['oracle', 'orchestrator'],
    'sonnet-impl': ['sonnet-impl', 'coder-hi', 'fixer-mid', 'fixer'],
    'coder-hi':    ['coder-hi', 'sonnet-impl', 'fixer-mid', 'fixer'],
    'fixer-mid':   ['fixer-mid', 'fixer'],
    'fixer':       ['fixer', 'fixer-mid'],
    'designer':    ['designer', 'orchestrator'],
  },
}

test('model_override wins over complexity and domain', () => {
  const plan = resolveTaskModel({
    task: {
      role_hint: 'implementer',
      complexity: 'low',
      domain_hint: 'graphql',
      model_override: { provider: 'anthropic', model: 'claude-opus-4-7', variant: 'max' },
    },
    workflow: WORKFLOW,
  })
  assert.equal(plan.source, 'override')
  assert.equal(plan.primary.provider, 'anthropic')
  assert.equal(plan.primary.model, 'claude-opus-4-7')
  assert.equal(plan.primary.variant, 'max')
  assert.equal(plan.chain.length, 1)
})

test('domain_hint beats complexity default', () => {
  const plan = resolveTaskModel({
    task: { role_hint: 'implementer', complexity: 'low', domain_hint: 'graphql' },
    workflow: WORKFLOW,
  })
  assert.equal(plan.source, 'domain')
  assert.equal(plan.primary.presetName, 'coder-hi')
  assert.equal(plan.primary.model, 'gpt-5.4')
  assert.ok(plan.chain.length > 1)
})

test('default routing resolves by role and complexity', () => {
  const plan = resolveTaskModel({
    task: { role_hint: 'implementer', complexity: 'high' },
    workflow: WORKFLOW,
  })
  assert.equal(plan.source, 'default')
  assert.equal(plan.primary.presetName, 'opus-impl')
  assert.equal(plan.primary.variant, 'max')
})

test('oracle medium uses gpt-5.4 xhigh', () => {
  const plan = resolveTaskModel({
    task: { role_hint: 'reviewer', complexity: 'medium' },
    workflow: WORKFLOW,
  })
  assert.equal(plan.primary.presetName, 'oracle')
  assert.equal(plan.primary.variant, 'xhigh')
})

test('unknown role falls back to implementer defaults', () => {
  const plan = resolveTaskModel({
    task: { role_hint: 'weird-role', complexity: 'medium' },
    workflow: WORKFLOW,
  })
  assert.equal(plan.source, 'default')
  assert.equal(plan.primary.presetName, 'sonnet-impl')
})

test('unresolved when presets missing', () => {
  const plan = resolveTaskModel({
    task: { role_hint: 'implementer', complexity: 'medium' },
    workflow: { model_routes: WORKFLOW.model_routes, model_presets: {} },
  })
  assert.equal(plan.unresolved, true)
  assert.equal(plan.primary, null)
})

test('advanceFallback walks the chain and reports exhaustion', () => {
  const plan = resolveTaskModel({
    task: { role_hint: 'implementer', complexity: 'high' },
    workflow: WORKFLOW,
  })
  const step1 = advanceFallback(plan, { failedPresetName: 'opus-impl', reason: 'rate_limit' })
  assert.equal(step1.exhausted, false)
  assert.equal(step1.next.presetName, 'sonnet-impl')
  assert.equal(step1.degradedFrom.presetName, 'opus-impl')

  const step2 = advanceFallback(plan, { failedPresetName: 'sonnet-impl', reason: 'rate_limit' })
  assert.equal(step2.next.presetName, 'coder-hi')

  const lastStep = advanceFallback(plan, { failedPresetName: 'fixer', reason: 'rate_limit' })
  assert.equal(lastStep.exhausted, true)
  assert.equal(lastStep.next, null)
})

test('buildFallbackChain dedupes and guarantees primary first', () => {
  const chain = buildFallbackChain('fixer-mid', WORKFLOW)
  assert.deepEqual(chain, ['fixer-mid', 'fixer'])

  const chainImp = buildFallbackChain('opus-impl', WORKFLOW)
  assert.equal(chainImp[0], 'opus-impl')
  assert.ok(chainImp.includes('fixer'))
})

test('pickDefaultPreset and pickDomainPreset are stable', () => {
  assert.equal(pickDefaultPreset('reviewer', 'medium', WORKFLOW), 'oracle')
  assert.equal(pickDomainPreset('plan-critic', WORKFLOW), 'opus-critic')
  assert.equal(pickDomainPreset('unknown', WORKFLOW), null)
})

test('describeDegradation reports transitions with reason', () => {
  const from = { presetName: 'opus-impl', provider: 'anthropic', model: 'claude-opus-4-7', variant: 'max' }
  const to = { presetName: 'sonnet-impl', provider: 'anthropic', model: 'claude-sonnet-4-5', variant: 'medium' }
  const description = describeDegradation({ degradedFrom: from, effective: to, reason: 'rate_limit' })
  assert.equal(description.from.preset, 'opus-impl')
  assert.equal(description.to.preset, 'sonnet-impl')
  assert.equal(description.reason, 'rate_limit')

  const same = describeDegradation({ degradedFrom: from, effective: from, reason: 'rate_limit' })
  assert.equal(same, null)
})

test('aliases collapse trivial and critical into 3-level complexity', () => {
  const trivialPlan = resolveTaskModel({ task: { role_hint: 'implementer', complexity: 'trivial' }, workflow: WORKFLOW })
  const lowPlan = resolveTaskModel({ task: { role_hint: 'implementer', complexity: 'low' }, workflow: WORKFLOW })
  const criticalPlan = resolveTaskModel({ task: { role_hint: 'implementer', complexity: 'critical' }, workflow: WORKFLOW })
  const highPlan = resolveTaskModel({ task: { role_hint: 'implementer', complexity: 'high' }, workflow: WORKFLOW })
  assert.equal(trivialPlan.primary.presetName, lowPlan.primary.presetName)
  assert.equal(criticalPlan.primary.presetName, highPlan.primary.presetName)
})

test('task-contract template is machine-parseable and loads cleanly', async () => {
  const fs = await import('fs')
  const path = await import('path')
  const { readMarkdownFrontmatter } = await import('../../yak/plugins/planning-files/session-store.js')
  const tmplPath = fileURLToPath(new URL('../../yak/plugins/planning-files/templates/task-contract.md', import.meta.url))
  const content = fs.readFileSync(tmplPath, 'utf8')
  const tmpFile = path.resolve('/tmp', `yak-task-contract-${process.pid}.md`)
  fs.writeFileSync(tmpFile, content)
  const parsed = readMarkdownFrontmatter(tmpFile)
  fs.unlinkSync(tmpFile)
  assert.equal(parsed.frontmatter.role_hint, 'implementer')
  assert.equal(parsed.frontmatter.complexity, 'medium')
  assert.deepEqual(parsed.frontmatter.expected_paths, [])
  assert.deepEqual(parsed.frontmatter.acceptance_criteria, [])
  assert.ok(Array.isArray(parsed.frontmatter.escalation_rules))
})

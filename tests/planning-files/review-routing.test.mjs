import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertRequiredAcceptanceCommandsReran,
  buildPlanCriticPrompt,
  buildReviewPacket,
  choosePlanCriticTarget,
  getEscalationReason,
  getReviewRoute,
} from '../../yak/plugins/planning-files/review-routing.js'

test('getReviewRoute maps low complexity to orchestrator', () => {
  assert.deepEqual(getReviewRoute('low'), { type: 'orchestrator' })
})

test('getReviewRoute maps medium and high complexity with presets', () => {
  assert.deepEqual(getReviewRoute('medium'), { type: 'council', preset: 'medium-review' })
  assert.deepEqual(getReviewRoute('medium', { medium: 'custom-medium' }), {
    type: 'council',
    preset: 'custom-medium',
  })
  assert.deepEqual(getReviewRoute('high'), { type: 'oracle', preset: 'oracle-high-review' })
  assert.deepEqual(getReviewRoute('high', { high: 'custom-high' }), {
    type: 'oracle',
    preset: 'custom-high',
  })
})

test('buildReviewPacket preserves review inputs', () => {
  const packet = buildReviewPacket({
    taskSpecPath: '/tmp/task.md',
    planReferences: ['plan-a'],
    report: { status: 'ok' },
    changedFiles: ['src/index.js'],
    diffSummary: '1 file changed',
    verificationOutput: 'tests pass',
    taskPathRules: { allowed: ['src'] },
    revisionBinding: 'rev-1',
  })

  assert.deepEqual(packet, {
    taskSpecPath: '/tmp/task.md',
    planReferences: ['plan-a'],
    report: { status: 'ok' },
    changedFiles: ['src/index.js'],
    diffSummary: '1 file changed',
    verificationOutput: 'tests pass',
    taskPathRules: { allowed: ['src'] },
    revisionBinding: 'rev-1',
    repoAgentsPath: null,
    expectedPathSpread: null,
    degradationSummary: [],
    workflowChecklist: [
      'phase compliance',
      'approved snapshot compliance',
      'drift escalation compliance',
      'acceptance criteria compliance',
      'repo AGENTS.md compliance',
      'actual vs expected path spread legitimacy',
    ],
  })
})

test('getEscalationReason allows known escalation reasons', () => {
  for (const reason of [
    'permission_blocked',
    'unsafe_solution',
    'ambiguity',
    'repeated_failure',
    'loop_detected',
    'broadening_scope',
  ]) {
    assert.equal(getEscalationReason(reason), reason)
  }
})

test('getEscalationReason rejects unknown reasons', () => {
  assert.throws(() => getEscalationReason('unknown'), /Unknown escalation reason:/)
})

test('assertRequiredAcceptanceCommandsReran enforces reruns before acceptance', () => {
  assert.equal(
    assertRequiredAcceptanceCommandsReran(['npm test', 'npm lint'], ['npm lint', 'npm test']),
    true,
  )
  assert.throws(
    () => assertRequiredAcceptanceCommandsReran(['npm test', 'npm lint'], ['npm test']),
    /Required acceptance commands not rerun: npm lint/,
  )
})

test('plan critic prefers different provider when available', () => {
  const chosen = choosePlanCriticTarget({
    orchestratorProvider: 'openai',
    candidates: [
      { provider: 'openai', model: 'gpt-5', capabilityScore: 90 },
      { provider: 'anthropic', model: 'claude-4', capabilityScore: 88 },
    ],
  })

  assert.equal(chosen.provider, 'anthropic')
})

test('plan critic pulls candidates from workflow when available', () => {
  const chosen = choosePlanCriticTarget({
    orchestratorProvider: 'openai',
    candidates: [],
    workflow: {
      model_presets: {
        'opus-critic': { provider: 'anthropic', model: 'claude-opus-4-7', variant: 'max' },
        'oracle':      { provider: 'openai',    model: 'gpt-5.4',         variant: 'xhigh' },
      },
      model_routes: {
        critic: { low: 'opus-critic', medium: 'opus-critic', high: 'opus-critic' },
      },
    },
  })

  assert.equal(chosen.provider, 'anthropic')
  assert.equal(chosen.model, 'claude-opus-4-7')
  assert.equal(chosen.variant, 'max')
})

test('plan critic falls back to strongest available model when no alternate provider exists', () => {
  const chosen = choosePlanCriticTarget({
    orchestratorProvider: 'openai',
    candidates: [
      { provider: 'openai', model: 'gpt-5-mini', capabilityScore: 40 },
      { provider: 'openai', model: 'gpt-5', capabilityScore: 95 },
    ],
  })

  assert.equal(chosen.model, 'gpt-5')
})

test('plan critic prompt records original plan authorship', () => {
  const prompt = buildPlanCriticPrompt({
    planProvider: 'openai',
    planModel: 'gpt-5.4',
    criticProvider: 'anthropic',
    criticModel: 'claude-sonnet',
  })

  assert.match(prompt, /plan was developed by openai\/gpt-5\.4 model/i)
  assert.match(prompt, /reviewing it independently using anthropic\/claude-sonnet/i)
})

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertNoGlobs,
  normalizeAllowedPaths,
  parseTaskFrontmatter,
  validateTaskSpecSchema,
} from '../../yak/plugins/planning-files/task-policy.js'

test('normalizeAllowedPaths resolves relative entries', () => {
  assert.deepEqual(
    normalizeAllowedPaths('/repo/root', ['a', './b/c']),
    ['/repo/root/a', '/repo/root/b/c'],
  )
})

test('assertNoGlobs rejects glob patterns', () => {
  assert.doesNotThrow(() => assertNoGlobs(['plain/path', 'src/file.js']))
  assert.throws(() => assertNoGlobs(['src/*.js']), /Globs not supported in task path policy:/)
  assert.throws(() => assertNoGlobs(['src/fi?e.js']), /Globs not supported in task path policy:/)
})

test('validateTaskSpecSchema accepts required task spec fields', () => {
  assert.doesNotThrow(() =>
    validateTaskSpecSchema({
      task_id: 'task-1',
      plan_revision: 'rev-a',
      approved_revision: 'rev-b',
      expected_paths: ['src'],
      protected_paths: ['dist'],
      allowed_ephemeral_paths: ['.tmp/out'],
      allowed_shell_command_forms: ['node test.mjs'],
      required_for_acceptance: ['tests pass'],
    }),
  )
})

test('validateTaskSpecSchema rejects missing required fields', () => {
  assert.throws(
    () => validateTaskSpecSchema({ task_id: 'task-1' }),
    /Missing required task spec field: plan_revision/,
  )
})

test('validateTaskSpecSchema rejects non-array task spec fields', () => {
  assert.throws(
    () =>
      validateTaskSpecSchema({
        task_id: 'task-1',
        plan_revision: 'rev-a',
        approved_revision: 'rev-b',
        expected_paths: 'src',
        protected_paths: [],
        allowed_ephemeral_paths: [],
        allowed_shell_command_forms: [],
        required_for_acceptance: [],
      }),
    /Task spec field must be an array: expected_paths/,
  )
})

test('parseTaskFrontmatter validates schema before parsing', () => {
  assert.throws(
    () => parseTaskFrontmatter({ task_id: 'task-1' }),
    /Missing required task spec field: plan_revision/,
  )
})

test('parseTaskFrontmatter supports expected and protected paths', () => {
  const parsed = parseTaskFrontmatter({
    task_id: 'task-1',
    plan_revision: 1,
    approved_revision: 1,
    expected_paths: ['src'],
    protected_paths: ['src/private'],
    allowed_ephemeral_paths: ['tmp'],
    allowed_shell_command_forms: ['npm test'],
    required_for_acceptance: ['pass'],
    test_strategy: 'e2e',
  })

  assert.deepEqual(parsed.expectedPaths, ['src'])
  assert.deepEqual(parsed.protectedPaths, ['src/private'])
  assert.equal(parsed.testStrategy, 'e2e')
})

test('parseTaskFrontmatter surfaces routing fields', () => {
  const parsed = parseTaskFrontmatter({
    task_id: 'task-2',
    plan_revision: 1,
    approved_revision: 1,
    expected_paths: ['src'],
    protected_paths: ['src/private'],
    allowed_ephemeral_paths: [],
    allowed_shell_command_forms: ['npm test'],
    required_for_acceptance: ['pass'],
    complexity: 'high',
    role_hint: 'reviewer',
    domain_hint: 'plan-critic',
    model_override: { provider: 'anthropic', model: 'claude-opus-4-7', variant: 'max' },
    effective_model: { preset: 'opus-critic', provider: 'anthropic', model: 'claude-opus-4-7', variant: 'max' },
    degraded_from: { preset: 'opus-review', provider: 'anthropic', model: 'claude-opus-4-7', variant: 'high', reason: 'rate_limit' },
  })

  assert.equal(parsed.complexity, 'high')
  assert.equal(parsed.roleHint, 'reviewer')
  assert.equal(parsed.domainHint, 'plan-critic')
  assert.equal(parsed.modelOverride.model, 'claude-opus-4-7')
  assert.equal(parsed.effectiveModel.preset, 'opus-critic')
  assert.equal(parsed.degradedFrom.reason, 'rate_limit')
})

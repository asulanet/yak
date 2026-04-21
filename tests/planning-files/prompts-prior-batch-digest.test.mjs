import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PHASE1_DIGEST_MAX_CHARS,
  buildPhaseSystemPrompt,
} from '../../yak/plugins/planning-files/prompts.js'

const baseArgs = {
  phase: 'phase1_discovery',
  subphase: 'scope_draft',
  stage: 'planning',
  slug: 'demo',
  projectDir: '.agents/yak/projects/demo',
  activeTasks: [],
  openQuestions: [],
}

test('phase1 prompt is unchanged when current_batch is undefined (legacy project)', () => {
  const withoutBatch = buildPhaseSystemPrompt({ ...baseArgs })
  const withBatch1 = buildPhaseSystemPrompt({ ...baseArgs, currentBatch: 1, batchSummary: '# Batches\n\n## Batch 0\n' })
  // current_batch=1 is "first batch", no prior batches to surface — digest omitted.
  assert.doesNotMatch(withoutBatch, /Prior batches/)
  assert.doesNotMatch(withBatch1, /Prior batches/)
  assert.equal(withoutBatch, withBatch1, 'legacy + explicit-batch-1 produce identical phase1 prompt')
})

test('phase1 prompt prepends digest when current_batch > 1', () => {
  const summary = '# Batches\n\n## Batch 1 — migration complete\n\n- Outcome: yak extracted into standalone repo\n'
  const rendered = buildPhaseSystemPrompt({ ...baseArgs, currentBatch: 2, batchSummary: summary })
  assert.match(rendered, /## Prior batches on this project/)
  assert.match(rendered, /Batch 1 — migration complete/)
  assert.match(rendered, /Findings tagged \[B1\]\/\[B2\]/)
})

test('phase1 prompt shows fallback when batchSummary missing', () => {
  const rendered = buildPhaseSystemPrompt({ ...baseArgs, currentBatch: 2, batchSummary: null })
  assert.match(rendered, /no batch-summary.md available/)
})

test('phase1 prompt shows fallback when batchSummary is empty string', () => {
  const rendered = buildPhaseSystemPrompt({ ...baseArgs, currentBatch: 3, batchSummary: '   \n' })
  assert.match(rendered, /no batch-summary.md available/)
})

test('phase1 prompt truncates long digest with pointer to full file', () => {
  const huge = '# Batches\n\n' + '## Batch N — filler\n'.repeat(1000)
  const rendered = buildPhaseSystemPrompt({ ...baseArgs, currentBatch: 10, batchSummary: huge })
  assert.match(rendered, /older batches omitted/)
  // Truncated content is present but not the full huge summary
  assert.ok(rendered.length < huge.length + 1000, 'prompt bounded by PHASE1_DIGEST_MAX_CHARS')
  assert.ok(PHASE1_DIGEST_MAX_CHARS > 0)
})

test('[B<N>] tag rule appears in phase1 + phase2 + phase3 prompts', () => {
  const p1 = buildPhaseSystemPrompt({ ...baseArgs })
  const p2 = buildPhaseSystemPrompt({ ...baseArgs, phase: 'phase2_tasks' })
  const p3 = buildPhaseSystemPrompt({ ...baseArgs, phase: 'phase3_execution' })
  for (const [label, rendered] of [['phase1', p1], ['phase2', p2], ['phase3', p3]]) {
    assert.match(rendered, /\[B<current_batch>\]/, `${label} prompt should describe the [B<N>] tag rule`)
  }
})

test('[B<N>] tag rule does NOT appear in exploration phase0', () => {
  const p0 = buildPhaseSystemPrompt({ ...baseArgs, stage: 'exploration', phase: 'phase0_exploration' })
  assert.doesNotMatch(p0, /\[B<current_batch>\]/)
})

test('phase2 + phase3 prompts are unaffected by currentBatch argument', () => {
  const baseline2 = buildPhaseSystemPrompt({ ...baseArgs, phase: 'phase2_tasks' })
  const withBatch2 = buildPhaseSystemPrompt({ ...baseArgs, phase: 'phase2_tasks', currentBatch: 3, batchSummary: 'foo' })
  assert.equal(baseline2, withBatch2, 'phase2 rendering stable across batch args')

  const baseline3 = buildPhaseSystemPrompt({ ...baseArgs, phase: 'phase3_execution' })
  const withBatch3 = buildPhaseSystemPrompt({ ...baseArgs, phase: 'phase3_execution', currentBatch: 3, batchSummary: 'foo' })
  assert.equal(baseline3, withBatch3, 'phase3 rendering stable across batch args')
})

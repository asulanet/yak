import test from 'node:test'
import assert from 'node:assert/strict'

import {
  NEW_BATCH_TRIGGER_PATTERN,
  NEW_BATCH_AUTODETECT_CLAUSE,
  YAK_ACTIVATION_PATTERN,
  YAK_DEACTIVATION_PATTERN,
} from '../../yak/plugins/planning-files/prompts.js'

test('NEW_BATCH_TRIGGER_PATTERN matches explicit new-batch trigger phrases', () => {
  const positives = [
    '/yak new',
    '/yak new-batch',
    '/yak newbatch',
    'new yak',
    'next yak batch',
    'Please /yak new',
    'We should probably /yak new-batch now.',
    'Okay new yak then.',
    'Let us do next yak batch.',
  ]
  for (const phrase of positives) {
    assert.equal(NEW_BATCH_TRIGGER_PATTERN.test(phrase), true, `expected match: ${JSON.stringify(phrase)}`)
  }
})

test('NEW_BATCH_TRIGGER_PATTERN does NOT match bare "new batch"', () => {
  // Bare "new batch" is too generic for a global message transform hook — the
  // phrase could appear in unrelated user prose about batch processing.
  const negatives = [
    'new batch',
    'I want a new batch of cookies',
    'Create a new batch job in the queue',
  ]
  for (const phrase of negatives) {
    assert.equal(NEW_BATCH_TRIGGER_PATTERN.test(phrase), false, `expected no match: ${JSON.stringify(phrase)}`)
  }
})

test('NEW_BATCH_TRIGGER_PATTERN is case-insensitive', () => {
  for (const phrase of ['/YAK NEW', 'New Yak', 'NEXT YAK BATCH']) {
    assert.equal(NEW_BATCH_TRIGGER_PATTERN.test(phrase), true, `expected case-insensitive match: ${JSON.stringify(phrase)}`)
  }
})

test('NEW_BATCH_TRIGGER_PATTERN does not collide with /yak activation or /unyak deactivation', () => {
  assert.equal(NEW_BATCH_TRIGGER_PATTERN.test('/yak'), false, 'plain /yak activation is NOT a new-batch trigger')
  assert.equal(NEW_BATCH_TRIGGER_PATTERN.test('yak it'), false, 'yak it activation is NOT a new-batch trigger')
  assert.equal(NEW_BATCH_TRIGGER_PATTERN.test('unyak'), false, 'unyak deactivation is NOT a new-batch trigger')
  // And conversely the existing patterns don't accidentally match new-batch phrases.
  assert.equal(YAK_ACTIVATION_PATTERN.test('next yak batch'), false, 'activation pattern does not match new-batch trigger')
  assert.equal(YAK_DEACTIVATION_PATTERN.test('/yak new'), false, 'deactivation pattern does not match new-batch trigger')
})

test('NEW_BATCH_AUTODETECT_CLAUSE instructs orchestrator on gate-safe Question shape', () => {
  // The clause tells the orchestrator to offer new-batch via mcp_Question but
  // use keywords that do NOT collide with detectGateRequest's gate patterns.
  // Verify the clause references the non-gate-colliding vocabulary.
  assert.match(NEW_BATCH_AUTODETECT_CLAUSE, /mcp_Question/)
  assert.match(NEW_BATCH_AUTODETECT_CLAUSE, /Start batch/)
  assert.match(NEW_BATCH_AUTODETECT_CLAUSE, /Keep adding to current batch/)
  assert.match(NEW_BATCH_AUTODETECT_CLAUSE, /avoid\s+"?execution"?/i)
})

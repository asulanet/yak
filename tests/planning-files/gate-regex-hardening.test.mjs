import test from 'node:test'
import assert from 'node:assert/strict'

import { detectGateApproval, detectGateRequest } from '../../yak/plugins/planning-files/question-findings.js'

function q({ header = '', text = '' }) {
  return {
    text,
    questions: header ? [{ header }] : [],
  }
}

test('detectGateRequest: phase2 wins when BOTH phase2 and execution keywords appear', () => {
  // Historical bug repro: a Question asking for phase2 approval whose body
  // mentions "authorize execution" in description prose was routed to the
  // execution gate, auto-approving execution of a stale task set.
  const candidate = q({
    header: 'Phase 2 Approval',
    text: 'Lock the task graph and authorize execution later?',
  })
  const result = detectGateRequest(candidate)
  assert.deepEqual(result, { gate: 'phase2', subphase: 'phase2_approval' })
})

test('detectGateRequest: returns null for new-batch confirmation Questions', () => {
  const candidate = q({
    header: 'New topic detected',
    text: 'This looks unrelated to the current batch. Start batch 2, or keep adding to the current batch?',
  })
  assert.equal(detectGateRequest(candidate), null)
})

test('detectGateRequest: returns null for new-batch trigger Questions', () => {
  const candidate = q({
    header: 'New batch',
    text: 'User typed /yak new. Proceed with new-batch transition?',
  })
  assert.equal(detectGateRequest(candidate), null)
})

test('detectGateRequest: returns null for incomplete-task policy Questions', () => {
  const candidate = q({
    header: 'Incomplete tasks detected',
    text: 'Batch has tasks in non-terminal states. Abandon, carry, or cancel tasks?',
  })
  assert.equal(detectGateRequest(candidate), null)
})

test('detectGateRequest: true execution gate Questions still route to execution', () => {
  const candidate = q({
    header: 'Execution Authorization',
    text: 'Authorize execution of the approved task set?',
  })
  const result = detectGateRequest(candidate)
  assert.deepEqual(result, { gate: 'execution', subphase: 'execution_authorization' })
})

test('detectGateRequest: phase2 without execution keyword still routes to phase2', () => {
  const candidate = q({
    header: 'Task Graph Approval',
    text: 'Approve DAG at revision 3?',
  })
  const result = detectGateRequest(candidate)
  assert.deepEqual(result, { gate: 'phase2', subphase: 'phase2_approval' })
})

test('detectGateRequest: phase1 positive cases still work', () => {
  const candidate = q({
    header: 'Phase 1 Scope Approval',
    text: 'Approve the design before we draft the task graph?',
  })
  const result = detectGateRequest(candidate)
  assert.deepEqual(result, { gate: 'phase1', subphase: 'phase1_approval' })
})

test('detectGateRequest: returns null for unrelated Questions', () => {
  const candidate = q({
    header: 'What color for the button?',
    text: 'Blue or green?',
  })
  assert.equal(detectGateRequest(candidate), null)
})

test('detectGateApproval: affirmative answer to phase2 Question with "authorize execution" prose does NOT approve execution', () => {
  // End-to-end repro of the historical bug: user answers "Approve" to a
  // phase2 Question whose body mentions "authorize execution". Pre-hardening
  // this auto-approved the execution gate. Post-hardening the gate detected
  // is phase2, which is correct.
  const candidate = q({
    header: 'Phase 2 Approval',
    text: 'Approve DAG revision 4. Next step after lock will be a separate Question for execution authorization.',
  })
  const approval = detectGateApproval(candidate, [['Approve — lock task graph']])
  assert.equal(approval.gate, 'phase2')
  assert.notEqual(approval.gate, 'execution')
})

test('detectGateApproval: non-affirmative answer returns null', () => {
  const candidate = q({ header: 'Phase 2 Approval', text: 'Approve DAG?' })
  const result = detectGateApproval(candidate, [['Revisions needed']])
  assert.equal(result, null)
})

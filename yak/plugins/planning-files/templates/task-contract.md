---
task_id: {{TASK_ID}}
plan_revision: 1
approved_revision: null
stage: draft
role_hint: implementer
complexity: medium
domain_hint: null
model_override: null
effective_model: null
degraded_from: null
depends_on: []
expected_paths: []
protected_paths: []
allowed_ephemeral_paths: []
allowed_shell_command_forms: []
required_for_acceptance: []
inputs: []
outputs: []
acceptance_criteria: []
escalation_rules: ["stop on plan drift", "stop when required path outside expected range", "stop when required tool outside allowed shell forms"]
test_strategy: unspecified
---

# {{TASK_ID}} — {{TASK_TITLE}}

## Goal

{{TASK_GOAL}}

## Inputs

- files, APIs, assumptions, dependency tasks

## Outputs

- concrete changed artifacts, observable behavior

## Expected paths

- soft guidance only; actual spread is reviewed at acceptance

## Protected paths

- hard deny; never touched by this task

## Allowed shell command forms

- exact command prefixes permitted for this task

## Acceptance criteria

- measurable, binary-verifiable checks

## Escalation rules

- stop on plan drift, missing prerequisite, unclear contract, blocked tool/path, required extra task

## Ripple notes

- downstream tasks affected if this contract changes

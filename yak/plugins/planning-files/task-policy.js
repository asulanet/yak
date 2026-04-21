import path from 'path'

function normalizeAllowedPaths(repoRoot, paths) {
  return (paths || []).map((item) => path.resolve(repoRoot, item))
}

function assertRequiredField(frontmatter, key) {
  if (frontmatter[key] == null || frontmatter[key] === '') {
    throw new Error(`Missing required task spec field: ${key}`)
  }
}

function assertArrayField(frontmatter, key) {
  assertRequiredField(frontmatter, key)
  if (!Array.isArray(frontmatter[key])) {
    throw new Error(`Task spec field must be an array: ${key}`)
  }
}

function validateTaskSpecSchema(frontmatter) {
  // task_id shape is NOT enforced by the schema validator — it's a normative
  // convention for generators + CLI, enforced at the entry points (record-
  // task-stage.mjs --task arg parser, carry/clone code added later). The
  // canonical TASK_ID_PATTERN is exported from session-store.js for callers
  // that want explicit validation via isValidTaskId. This keeps parseTask-
  // Frontmatter tolerant of legacy fixtures and hand-crafted task files.
  assertRequiredField(frontmatter, 'task_id')
  assertRequiredField(frontmatter, 'plan_revision')
  assertRequiredField(frontmatter, 'approved_revision')
  assertArrayField(frontmatter, frontmatter.expected_paths ? 'expected_paths' : 'allowed_paths')
  assertArrayField(frontmatter, frontmatter.protected_paths ? 'protected_paths' : 'forbidden_paths')
  assertArrayField(frontmatter, 'allowed_ephemeral_paths')
  assertArrayField(frontmatter, 'allowed_shell_command_forms')
  assertArrayField(frontmatter, 'required_for_acceptance')
  return frontmatter
}

function parseTaskFrontmatter(frontmatter) {
  validateTaskSpecSchema(frontmatter)
  const expectedPaths = frontmatter.expected_paths || frontmatter.allowed_paths || []
  const protectedPaths = frontmatter.protected_paths || frontmatter.forbidden_paths || []
  assertNoGlobs(expectedPaths)
  assertNoGlobs(protectedPaths)
  assertNoGlobs(frontmatter.allowed_ephemeral_paths)
  return {
    taskID: frontmatter.task_id,
    planRevision: frontmatter.plan_revision,
    approvedRevision: frontmatter.approved_revision,
    expectedPaths,
    protectedPaths,
    allowedEphemeralPaths: frontmatter.allowed_ephemeral_paths || [],
    allowedShellCommands: frontmatter.allowed_shell_command_forms || [],
    requiredForAcceptance: frontmatter.required_for_acceptance || [],
    inputs: frontmatter.inputs || [],
    outputs: frontmatter.outputs || [],
    acceptanceCriteria: frontmatter.acceptance_criteria || [],
    dependsOn: frontmatter.depends_on || [],
    escalationRules: frontmatter.escalation_rules || [],
    testStrategy: frontmatter.test_strategy || 'unspecified',
    complexity: frontmatter.complexity || null,
    roleHint: frontmatter.role_hint || null,
    domainHint: frontmatter.domain_hint || null,
    modelOverride: frontmatter.model_override || null,
    effectiveModel: frontmatter.effective_model || null,
    degradedFrom: frontmatter.degraded_from || null,
  }
}

function assertNoGlobs(paths) {
  for (const item of paths || []) {
    if (/[*?[]/.test(item)) {
      throw new Error(`Globs not supported in task path policy: ${item}`)
    }
  }
}

export {
  normalizeAllowedPaths,
  validateTaskSpecSchema,
  parseTaskFrontmatter,
  assertNoGlobs,
}

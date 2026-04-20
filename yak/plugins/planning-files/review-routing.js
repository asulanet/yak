function getReviewRoute(complexity, presets = {}) {
  if (complexity === 'low') return { type: 'orchestrator' }
  if (complexity === 'medium') return { type: 'council', preset: presets.medium || 'medium-review' }
  if (complexity === 'high') return { type: 'oracle', preset: presets.high || 'oracle-high-review' }
  throw new Error(`Unknown review complexity: ${complexity}`)
}

function assertRequiredAcceptanceCommandsReran(requiredForAcceptance = [], rerunCommands = []) {
  const required = new Set(requiredForAcceptance)
  const rerun = new Set(rerunCommands)
  const missing = [...required].filter((command) => !rerun.has(command))

  if (missing.length > 0) {
    throw new Error(`Required acceptance commands not rerun: ${missing.join(', ')}`)
  }

  return true
}

function buildReviewPacket(input) {
  return {
    taskSpecPath: input.taskSpecPath,
    planReferences: input.planReferences,
    report: input.report,
    changedFiles: input.changedFiles,
    diffSummary: input.diffSummary,
    verificationOutput: input.verificationOutput,
    taskPathRules: input.taskPathRules,
    revisionBinding: input.revisionBinding,
    repoAgentsPath: input.repoAgentsPath || null,
    expectedPathSpread: input.expectedPathSpread || null,
    degradationSummary: input.degradationEvents || [],
    workflowChecklist: input.workflowChecklist || [
      'phase compliance',
      'approved snapshot compliance',
      'drift escalation compliance',
      'acceptance criteria compliance',
      'repo AGENTS.md compliance',
      'actual vs expected path spread legitimacy',
    ],
  }
}

function getEscalationReason(reason) {
  const allowed = new Set([
    'permission_blocked',
    'unsafe_solution',
    'ambiguity',
    'repeated_failure',
    'loop_detected',
    'broadening_scope',
  ])
  if (!allowed.has(reason)) throw new Error(`Unknown escalation reason: ${reason}`)
  return reason
}

function choosePlanCriticTarget({ orchestratorProvider, candidates = [], workflow = null }) {
  const fromWorkflow = workflow ? collectCriticsFromWorkflow(workflow) : []
  const merged = dedupeCandidates([...candidates, ...fromWorkflow])
  const sorted = [...merged].sort((left, right) => Number(right?.capabilityScore || 0) - Number(left?.capabilityScore || 0))
  return sorted.find((candidate) => candidate?.provider && candidate.provider !== orchestratorProvider) || sorted[0] || null
}

function dedupeCandidates(list) {
  const seen = new Set()
  const out = []
  for (const entry of list) {
    if (!entry) continue
    const key = `${entry.provider || ''}/${entry.model || ''}/${entry.variant || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out
}

function collectCriticsFromWorkflow(workflow) {
  if (!workflow) return []
  const presets = workflow.model_presets || {}
  const criticRoutes = (workflow.model_routes && workflow.model_routes.critic) || {}
  const names = [criticRoutes.high, criticRoutes.medium, criticRoutes.low].filter(Boolean)
  return names.map((name) => {
    const entry = presets[name]
    if (!entry) return null
    return {
      presetName: name,
      provider: entry.provider,
      model: entry.model,
      variant: entry.variant,
      capabilityScore: Number.POSITIVE_INFINITY,
    }
  }).filter(Boolean)
}

function buildPlanCriticPrompt({ planProvider, planModel, criticProvider, criticModel }) {
  const authorship = planProvider ? `${planProvider}${planModel ? `/${planModel}` : ''}` : 'another provider'
  const critic = criticProvider ? `${criticProvider}${criticModel ? `/${criticModel}` : ''}` : 'best-available model'
  return [
    `The plan was developed by ${authorship} model.`,
    `You are reviewing it independently using ${critic}.`,
    'Review for scope gaps, incompatibilities, missing risks, weak assumptions, and better alternatives. Do not assume prior approval means correctness.',
  ].join(' ')
}

export {
  getReviewRoute,
  assertRequiredAcceptanceCommandsReran,
  buildReviewPacket,
  buildPlanCriticPrompt,
  choosePlanCriticTarget,
  getEscalationReason,
}

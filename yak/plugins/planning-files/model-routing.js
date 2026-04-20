const COMPLEXITY_ALIASES = { trivial: 'low', low: 'low', medium: 'medium', high: 'high', critical: 'high' }
const VALID_ROLES = new Set(['implementer', 'reviewer', 'critic', 'explorer', 'librarian', 'designer', 'fixer'])

export function normalizeComplexity(value) {
  const key = String(value || '').toLowerCase().trim()
  return COMPLEXITY_ALIASES[key] || 'medium'
}

export function normalizeRole(value) {
  const key = String(value || '').toLowerCase().trim()
  return VALID_ROLES.has(key) ? key : 'implementer'
}

export function normalizeDomain(value) {
  const key = String(value || '').toLowerCase().trim()
  return key || null
}

function presetToModel(presetName, workflow) {
  const presets = (workflow && workflow.model_presets) || {}
  const entry = presets[presetName]
  if (!entry) return null
  return {
    presetName,
    subagentType: entry.subagent_type || entry.subagentType || null,
    provider: entry.provider || null,
    model: entry.model || null,
    variant: entry.variant || null,
  }
}

function normalizeOverride(rawOverride) {
  if (!rawOverride || typeof rawOverride !== 'object') return null
  const provider = rawOverride.provider || rawOverride.providerID || rawOverride.providerId || null
  const model = rawOverride.model || rawOverride.modelID || rawOverride.modelId || null
  if (!provider || !model) return null
  return {
    presetName: rawOverride.preset || rawOverride.presetName || null,
    subagentType: rawOverride.subagent_type || rawOverride.subagentType || null,
    provider,
    model,
    variant: rawOverride.variant || null,
    isOverride: true,
  }
}

export function pickDefaultPreset(role, complexity, workflow) {
  const roleKey = normalizeRole(role)
  const complexityKey = normalizeComplexity(complexity)
  const routes = (workflow && workflow.model_routes) || {}
  const roleRoutes = routes[roleKey] || {}
  return roleRoutes[complexityKey] || roleRoutes.medium || roleRoutes.low || null
}

export function pickDomainPreset(domain, workflow) {
  const domainKey = normalizeDomain(domain)
  if (!domainKey) return null
  const domainRoutes = (workflow && workflow.domain_routes) || {}
  return domainRoutes[domainKey] || null
}

export function buildFallbackChain(presetName, workflow) {
  if (!presetName) return []
  const fallbacks = (workflow && workflow.model_fallbacks) || {}
  const explicit = Array.isArray(fallbacks[presetName]) ? fallbacks[presetName] : null
  if (explicit && explicit.length > 0) {
    const seen = new Set()
    const deduped = []
    for (const name of explicit) {
      if (!name || seen.has(name)) continue
      seen.add(name)
      deduped.push(name)
    }
    if (!deduped.includes(presetName)) deduped.unshift(presetName)
    return deduped
  }
  return [presetName]
}

export function resolveTaskModel({ task = {}, workflow = {} }) {
  const override = normalizeOverride(task.model_override)
  if (override) {
    return {
      source: 'override',
      primary: override,
      chain: [override],
      reason: null,
      unresolved: false,
    }
  }

  const domainPreset = pickDomainPreset(task.domain_hint, workflow)
  if (domainPreset) {
    const chain = buildFallbackChain(domainPreset, workflow).map((name) => presetToModel(name, workflow)).filter(Boolean)
    if (chain.length > 0) {
      return {
        source: 'domain',
        primary: chain[0],
        chain,
        reason: null,
        unresolved: false,
      }
    }
  }

  const defaultPreset = pickDefaultPreset(task.role_hint, task.complexity, workflow)
  if (defaultPreset) {
    const chain = buildFallbackChain(defaultPreset, workflow).map((name) => presetToModel(name, workflow)).filter(Boolean)
    if (chain.length > 0) {
      return {
        source: 'default',
        primary: chain[0],
        chain,
        reason: null,
        unresolved: false,
      }
    }
  }

  return {
    source: null,
    primary: null,
    chain: [],
    reason: 'no-matching-preset',
    unresolved: true,
  }
}

export function advanceFallback(plan, { failedPresetName, reason }) {
  if (!plan || !Array.isArray(plan.chain) || plan.chain.length === 0) {
    return { next: null, exhausted: true, degradedFrom: null, reason: reason || 'no-chain' }
  }
  const currentIndex = plan.chain.findIndex((entry) => entry.presetName === failedPresetName)
  const fromIndex = currentIndex === -1 ? 0 : currentIndex + 1
  const next = plan.chain[fromIndex] || null
  return {
    next,
    exhausted: !next,
    degradedFrom: plan.chain[0] || null,
    reason: reason || 'unavailable',
  }
}

export function describeDegradation({ degradedFrom, effective, reason }) {
  if (!degradedFrom || !effective) return null
  if (degradedFrom.presetName === effective.presetName) return null
  return {
    from: {
      preset: degradedFrom.presetName,
      provider: degradedFrom.provider,
      model: degradedFrom.model,
      variant: degradedFrom.variant,
    },
    to: {
      preset: effective.presetName,
      provider: effective.provider,
      model: effective.model,
      variant: effective.variant,
    },
    reason: reason || 'unknown',
  }
}

export { presetToModel }

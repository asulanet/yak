// Phase-aware system prompt builder for Yak.
// Exports a single composed block per phase plus trigger regexes.

const PHASE0_TEMPLATE = `[YAK] Lightweight exploration mode for project "{{SLUG}}" ({{PROJECT_DIR}}). No Yak workflow restrictions active — behave like a normal session.

If the user requests substantial work (multi-step features, refactors, architectural changes, or debugging with unclear root cause), proactively offer: "Want me to yak this to formalize scope?". Saying yes is not enough to transition — the user must use a trigger phrase.

Activation triggers (user-typed, case-insensitive): "yak it", "yak this", "yak this project", "yak the project", "yak project", "let's yak", "/yak". When the user types one, the runtime switches the project to phase1_discovery and planning constraints apply from the next turn.`

const PHASE1_TEMPLATE = `[YAK] STRICT MODE — phase1_discovery / {{SUBPHASE}} for project "{{SLUG}}". Planning only — NO code changes. The tool layer will hard-block repo mutations.

Required first actions this turn: read {{PROJECT_DIR}}/project.md and {{PROJECT_DIR}}/context.md. Refine scope. Document constraints, assumptions, decisions into context.md and findings.md. Identify tasks. Use the question tool to request Phase 1 approval once scope stabilizes. Do NOT self-approve gates — the user approves via question-tool reply.

Active tasks: {{ACTIVE_TASKS}}. Open questions: {{OPEN_QUESTIONS}}.

Deactivation triggers (returns to lightweight exploration): "unyak", "stop yak", "/unyak".`

const PHASE2_TEMPLATE = `[YAK] STRICT MODE — phase2_tasks / {{SUBPHASE}} for project "{{SLUG}}". Task DAG editing only — NO code changes. Edit {{PROJECT_DIR}}/tasks/*.md and {{PROJECT_DIR}}/tasks.md. Use the question tool to request Phase 2 approval once the DAG is ready.

Active tasks: {{ACTIVE_TASKS}}.

Deactivation triggers: "unyak", "stop yak", "/unyak".`

const PHASE3_TEMPLATE = `[YAK] EXECUTION MODE — phase3_execution / {{SUBPHASE}} / stage={{STAGE}} for project "{{SLUG}}". Execute only tasks listed in {{PROJECT_DIR}}/execution-snapshot.md. New ideas → {{PROJECT_DIR}}/backlog.md, not the snapshot. If scope drifts materially, reopen Phase 1 or 2 instead of editing the snapshot.

Active tasks: {{ACTIVE_TASKS}}.

Never mutate planning artifacts via shell rewrites, python heredocs, or ad-hoc scripts.`

function describeList(items) {
  const arr = Array.isArray(items) ? items.filter((item) => item !== null && item !== undefined && String(item).length > 0) : []
  return arr.length === 0 ? 'none' : arr.join(', ')
}

function renderTemplate(template, replacements) {
  return Object.entries(replacements).reduce(
    (acc, [key, value]) => acc.replaceAll(`{{${key}}}`, String(value ?? '')),
    template,
  )
}

// Exploration detection is stage-driven so that a project.md with an explicit
// stage (e.g. stage: implementing) but no phase field is not accidentally
// treated as Phase 0 just because the default phase is phase0_exploration.
export function isExplorationPhase({ stage } = {}) {
  return stage === 'exploration'
}

export function buildPhaseSystemPrompt({ phase, subphase, stage, slug, projectDir, activeTasks, openQuestions, recordScriptPath } = {}) {
  const replacements = {
    SLUG: slug || 'unknown',
    PROJECT_DIR: projectDir || '.agents/yak/projects/unknown',
    SUBPHASE: subphase || 'unknown',
    STAGE: stage || 'unknown',
    ACTIVE_TASKS: describeList(activeTasks),
    OPEN_QUESTIONS: describeList(openQuestions),
    RECORD_SCRIPT: recordScriptPath || 'yak/scripts/record-task-stage.mjs',
  }
  if (isExplorationPhase({ stage })) return renderTemplate(PHASE0_TEMPLATE, replacements)
  if (phase === 'phase1_discovery') return renderTemplate(PHASE1_TEMPLATE, replacements)
  if (phase === 'phase2_tasks') return renderTemplate(PHASE2_TEMPLATE, replacements)
  if (phase === 'phase3_execution') return renderTemplate(PHASE3_TEMPLATE, replacements)
  return renderTemplate(PHASE0_TEMPLATE, replacements)
}

// Activation: "/yak", "yak it", "yak this [project]", "yak the project", "yak project", "let's yak", "lets yak"
export const YAK_ACTIVATION_PATTERN = /\/yak\b|\byak\s+(?:it|this(?:\s+project)?|the\s+project|project)\b|\blet'?s\s+yak\b/i

// Deactivation: "/unyak", "unyak", "stop yak", "exit yak"
export const YAK_DEACTIVATION_PATTERN = /\/unyak\b|\bunyak\b|\bstop\s+yak\b|\bexit\s+yak\b/i

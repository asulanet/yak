// Phase-aware system prompt builder for Yak.
// Exports a single composed block per phase plus trigger regexes.

// [B<N>] tag rule visible to orchestrator + fixer in every strict-mode phase.
// Ensures findings added during Batch N are origin-traceable when a later
// batch opens and the Phase 1 prompt surfaces a prior-batch digest.
const BATCH_TAG_RULE = 'When adding entries to findings.md in a project with current_batch > 1, prefix each entry with "[B<current_batch>]" (e.g. [B2]) so origin is traceable when future batches open.'

const PHASE0_TEMPLATE = `[YAK] Lightweight exploration mode for project "{{SLUG}}" ({{PROJECT_DIR}}). No Yak workflow restrictions active — behave like a normal session.

If the user requests substantial work (multi-step features, refactors, architectural changes, or debugging with unclear root cause), proactively offer: "Want me to yak this to formalize scope?". Saying yes is not enough to transition — the user must use a trigger phrase.

Activation triggers (user-typed, case-insensitive): "yak it", "yak this", "yak this project", "yak the project", "yak project", "let's yak", "/yak". When the user types one, the runtime switches the project to phase1_discovery and planning constraints apply from the next turn.`

const PHASE1_TEMPLATE = `[YAK] STRICT MODE — phase1_discovery / {{SUBPHASE}} for project "{{SLUG}}". Planning only — NO code changes. The tool layer will hard-block repo mutations.

Required first actions this turn: read {{PROJECT_DIR}}/project.md and {{PROJECT_DIR}}/context.md. Refine scope. Document constraints, assumptions, decisions into context.md and findings.md. Identify tasks. Use the question tool to request Phase 1 approval once scope stabilizes. Do NOT self-approve gates — the user approves via question-tool reply.

Active tasks: {{ACTIVE_TASKS}}. Open questions: {{OPEN_QUESTIONS}}.

${BATCH_TAG_RULE}

Deactivation triggers (returns to lightweight exploration): "unyak", "stop yak", "/unyak".`

const PHASE2_TEMPLATE = `[YAK] STRICT MODE — phase2_tasks / {{SUBPHASE}} for project "{{SLUG}}". Task DAG editing only — NO code changes. Edit {{PROJECT_DIR}}/tasks/*.md and {{PROJECT_DIR}}/tasks.md. Use the question tool to request Phase 2 approval once the DAG is ready.

Active tasks: {{ACTIVE_TASKS}}.

${BATCH_TAG_RULE}

Deactivation triggers: "unyak", "stop yak", "/unyak".`

const PHASE3_TEMPLATE = `[YAK] EXECUTION MODE — phase3_execution / {{SUBPHASE}} / stage={{STAGE}} for project "{{SLUG}}". Execute only tasks listed in {{PROJECT_DIR}}/execution-snapshot.md. New ideas → {{PROJECT_DIR}}/backlog.md, not the snapshot. If scope drifts materially, reopen Phase 1 or 2 instead of editing the snapshot.

Active tasks: {{ACTIVE_TASKS}}.

${BATCH_TAG_RULE}

Never mutate planning artifacts via shell rewrites, python heredocs, or ad-hoc scripts.`

// Max length of the batch-summary digest prepended to phase1 prompts. Long
// summaries are truncated with a pointer to the full file; the ceiling keeps
// phase1 prompt rendering bounded on projects with many prior batches.
export const PHASE1_DIGEST_MAX_CHARS = Number(process.env.YAK_PHASE1_DIGEST_MAX || 2000)

function renderPriorBatchDigest({ currentBatch, batchSummary }) {
  if (!currentBatch || currentBatch <= 1) return ''
  const summary = typeof batchSummary === 'string' ? batchSummary : ''
  const header = `## Prior batches on this project\n\n`
  const reminder = `\nFindings tagged [B1]/[B2]/... are prior-batch discoveries. Treat prior work as done unless the user references it.\n`
  if (!summary || !summary.trim()) {
    return `${header}(no batch-summary.md available — prior batches exist but no summary was recorded)\n${reminder}\n`
  }
  if (summary.length > PHASE1_DIGEST_MAX_CHARS) {
    const truncated = summary.slice(0, PHASE1_DIGEST_MAX_CHARS)
    return `${header}${truncated}\n\n…older batches omitted — read batch-summary.md for full history.\n${reminder}\n`
  }
  return `${header}${summary.trim()}\n${reminder}\n`
}

function describeList(items) {
  const arr = Array.isArray(items) ? items.filter((item) => item !== null && item !== undefined && String(item).length > 0) : []
  return arr.length === 0 ? 'none' : arr.join(', ')
}

function hasActiveTasks(activeTasks) {
  return Array.isArray(activeTasks) && activeTasks.some((item) => item !== null && item !== undefined && String(item).length > 0)
}

function isClosedBatchExecutionBoundary({ phase, subphase, stage, activeTasks } = {}) {
  const noActiveTasks = !hasActiveTasks(activeTasks)
  return (phase === 'phase3_execution' && subphase === 'execution_complete' && noActiveTasks) || (stage === 'completed' && noActiveTasks)
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

export function buildPhaseSystemPrompt({ phase, subphase, stage, slug, projectDir, activeTasks, openQuestions, recordScriptPath, currentBatch, batchSummary } = {}) {
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
  if (phase === 'phase1_discovery') {
    const digest = renderPriorBatchDigest({ currentBatch, batchSummary })
    const rendered = renderTemplate(PHASE1_TEMPLATE, replacements)
    return digest ? `${digest}\n${rendered}` : rendered
  }
  if (phase === 'phase2_tasks') return renderTemplate(PHASE2_TEMPLATE, replacements)
  if (phase === 'phase3_execution') {
    const rendered = renderTemplate(PHASE3_TEMPLATE, replacements)
    if (!isClosedBatchExecutionBoundary({ phase, subphase, stage, activeTasks })) return rendered
    const nextBatch = Number(currentBatch) > 0 ? Number(currentBatch) + 1 : 2
    return `${rendered}\n${renderTemplate(NEW_BATCH_AUTODETECT_CLAUSE, { NEXT_BATCH: nextBatch })}`
  }
  return renderTemplate(PHASE0_TEMPLATE, replacements)
}

// Activation: "/yak", "yak it", "yak this [project]", "yak the project", "yak project", "let's yak", "lets yak"
export const YAK_ACTIVATION_PATTERN = /\/yak\b|\byak\s+(?:it|this(?:\s+project)?|the\s+project|project)\b|\blet'?s\s+yak\b/i

// Deactivation: "/unyak", "unyak", "stop yak", "exit yak"
export const YAK_DEACTIVATION_PATTERN = /\/unyak\b|\bunyak\b|\bstop\s+yak\b|\bexit\s+yak\b/i

// New-batch triggers for the multi-batch workflow. Explicit phrases only —
// bare "new batch" is deliberately NOT included because the global message
// transform hook would misfire on unrelated prose in user messages. See T010
// contract acceptance for the rationale.
export const NEW_BATCH_TRIGGER_PATTERN = /\/yak\s+new(?:-?batch)?\b|\bnew\s+yak\b|\bnext\s+yak\s+batch\b/i

// System-prompt clause appended at the end of phase3 execution mode when the
// project is in a batch-boundary state (execution_complete or stage=completed
// with no active tasks). The clause instructs the orchestrator to proactively
// offer a new-batch transition via `mcp_Question` when the user introduces
// unrelated scope. Question header/body MUST avoid phase-gate keywords
// ("execution", "authorize execution", "phase 2") so auto-approval does not
// fire on the user's answer — the question-findings.js detectGateRequest is
// hardened to skip Questions mentioning "new batch" / "start batch N" /
// abandon/carry/cancel+tasks, which this clause relies on.
export const NEW_BATCH_AUTODETECT_CLAUSE = [
  '',
  '## New-batch detection',
  '',
  'Prior batch completed. If the user introduces scope that does not reference the current batch, offer a new-batch transition via `mcp_Question` before treating the request as new work inside the finished batch. Use keywords that do NOT trigger phase-gate regex (avoid "execution", "authorize", "phase 2"). Example Question:',
  '',
  '- Header: "New topic detected"',
  '- Question: "This looks unrelated to the current batch. Start batch {{NEXT_BATCH}}, or keep adding to the current batch?"',
  '- Options: "Start batch {{NEXT_BATCH}}" / "Keep adding to current batch"',
  '',
].join('\n')

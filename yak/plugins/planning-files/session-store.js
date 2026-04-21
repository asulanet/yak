import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { acquireJsonLock, isStale, readJson, releaseJsonLock, writeJsonAtomic } from './locks.js'
import { parseTaskFrontmatter } from './task-policy.js'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))

export const PROJECTS_DIR = path.join('.agents', 'yak', 'projects')
export const ACTIVE_PROJECT_POINTER_FILE = path.join('.agents', 'yak', 'active-project.json')

// Canonical task-ID validator.
//
// Accepts two shapes:
//   - legacy bare:    T<digits>          (convention: three digits, e.g. T001)
//   - batch-prefixed: B<digits>-T<digits> (convention: B<N>-T###, e.g. B2-T001)
//
// The batch prefix is introduced alongside the multi-batch workflow feature.
// Legacy (bare) IDs stay valid forever so Batch 1 tasks do not need a
// retroactive rename when the feature ships. The `T###` (three-digit) form
// is the convention for generators and tooling; the regex accepts one-or-more
// digits so test fixtures and edge cases keep working without inventing a
// parallel validator.
//
// All modules that parse, validate, write, or read task IDs MUST consume
// these exports rather than defining their own regex. See:
//   - task-policy.js parseTaskFrontmatter
//   - scripts/record-task-stage.mjs --task arg parser
//   - future carry/clone logic in startNewBatch
export const TASK_ID_PATTERN = /^(?:B\d+-)?T\d+$/
export function isValidTaskId(id) { return typeof id === 'string' && TASK_ID_PATTERN.test(id) }

// Batch-metadata fields.
//
// These are lazy-persisted: `withProjectDefaults` surfaces them in memory for
// every project (so runtime code can read current_batch without branching),
// but `migrateProjectFrontmatter` deliberately does NOT write them to disk
// for legacy projects that lack the fields. They first land on disk when the
// multi-batch lifecycle engine (T009's startNewBatch) commits a real
// transition. This guarantees byte-identical round-trips for legacy projects
// that upgrade past this schema change without ever running new-batch.
export const BATCH_FRONTMATTER_FIELDS = Object.freeze(['current_batch', 'batches_completed', 'batch_started_at'])

export const DEFAULT_PROJECT_FRONTMATTER = {
  project_slug: null,
  project_dir: null,
  stage: 'exploration',
  phase: 'phase0_exploration',
  subphase: 'idle',
  phase1_revision: 1,
  phase1_approved_revision: null,
  phase2_revision: 0,
  phase2_approved_revision: null,
  execution_snapshot_revision: null,
  plan_revision: 1,
  approved_revision: null,
  approved_by: null,
  approved_at: null,
  approved_task_ids: [],
  draft_task_ids: [],
  blocked_task_ids: [],
  active_tasks: [],
  open_questions: [],
  research_mode: 'brief',
  critic_status: 'not_offered',
  execution_authorized: false,
  last_gate_question_id: null,
  change_impact_level: 'local',
  current_batch: 1,
  batches_completed: [],
  batch_started_at: null,
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : []
}

// When a legacy / partial project.md declares a stage but no phase, infer a
// sensible phase from the stage so migrations from pre-Phase-0 projects keep
// working. Only kicks in when the phase field is missing from the input.
function derivePhaseFromStage(stage) {
  if (!stage) return null
  if (stage === 'exploration') return 'phase0_exploration'
  if (stage === 'implementing' || stage === 'validating' || stage === 'completed') return 'phase3_execution'
  // 'planning', 'awaiting_approval', 'quarantined', or any other legacy value
  return 'phase1_discovery'
}

function deriveSubphaseFromPhase(phase) {
  if (!phase) return null
  if (phase === 'phase0_exploration') return 'idle'
  if (phase === 'phase1_discovery') return 'discovery'
  if (phase === 'phase2_tasks') return 'task_graph_draft'
  if (phase === 'phase3_execution') return 'dispatch'
  return null
}

export function withProjectDefaults(frontmatter = {}) {
  const input = frontmatter || {}
  const derivedPhase = input.phase || derivePhaseFromStage(input.stage) || DEFAULT_PROJECT_FRONTMATTER.phase
  const derivedSubphase = input.subphase || deriveSubphaseFromPhase(derivedPhase) || DEFAULT_PROJECT_FRONTMATTER.subphase
  return {
    ...DEFAULT_PROJECT_FRONTMATTER,
    ...input,
    phase: derivedPhase,
    subphase: derivedSubphase,
    approved_task_ids: normalizeArray(input.approved_task_ids),
    draft_task_ids: normalizeArray(input.draft_task_ids),
    blocked_task_ids: normalizeArray(input.blocked_task_ids),
    active_tasks: normalizeArray(input.active_tasks),
    open_questions: normalizeArray(input.open_questions),
    batches_completed: normalizeArray(input.batches_completed),
  }
}

// Fields that are runtime-defaulted but not persisted-on-migrate unless the
// input already had them. Keeps legacy projects byte-identical on disk when
// they first encounter the batch-aware schema, per the lazy-persistence
// contract documented on BATCH_FRONTMATTER_FIELDS.
const LAZY_PERSIST_FIELDS = new Set(BATCH_FRONTMATTER_FIELDS)

export function migrateProjectFrontmatter({ projectDir } = {}) {
  if (!projectDir) return { migrated: false, addedKeys: [], preservedKeys: [] }
  const projectPath = path.join(projectDir, 'project.md')
  if (!fs.existsSync(projectPath)) return { migrated: false, addedKeys: [], preservedKeys: [] }

  const { frontmatter, body } = readMarkdownFrontmatter(projectPath)
  const current = frontmatter || {}
  const next = withProjectDefaults(current)
  const schemaKeys = new Set(Object.keys(DEFAULT_PROJECT_FRONTMATTER))
  const persistedKeys = Object.keys(DEFAULT_PROJECT_FRONTMATTER).filter((key) => !LAZY_PERSIST_FIELDS.has(key) || (key in current))
  const addedKeys = persistedKeys.filter((key) => !(key in current))
  const preservedKeys = Object.keys(current).filter((key) => !schemaKeys.has(key))
  const persistent = {}
  for (const key of persistedKeys) persistent[key] = next[key]
  for (const key of preservedKeys) persistent[key] = current[key]
  const currentBytes = fs.readFileSync(projectPath, 'utf8')
  const nextYaml = Object.entries(persistent).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')
  const nextBytes = `---\n${nextYaml}\n---\n${body}`

  if (currentBytes === nextBytes) return { migrated: false, addedKeys: [], preservedKeys }

  writeMarkdownFrontmatter(projectPath, persistent, body)
  return { migrated: true, addedKeys, preservedKeys }
}

function renderTemplate(template = '', replacements = {}) {
  return Object.entries(replacements).reduce((content, [key, value]) => content.replaceAll(`{{${key}}}`, value), template)
}

function parseTemplateFrontmatter(template = '') {
  const match = String(template || '').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) throw new Error('Task contract template missing frontmatter block')
  const frontmatter = {}
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue
    const index = line.indexOf(':')
    if (index === -1) continue
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    try { frontmatter[key] = JSON.parse(value) } catch { frontmatter[key] = value }
  }
  return { frontmatter, body: match[2] }
}

function toJson(value) { return JSON.stringify(value) }

export function stampTaskContract({ projectDir, taskId, roleHint, complexity, domainHint, modelOverride, expectedPaths, protectedPaths, allowedEphemeralPaths, allowedShellCommandForms, requiredForAcceptance, inputs, outputs, acceptanceCriteria, dependsOn, escalationRules, testStrategy, title, goal, overwrite = false }) {
  const taskPath = path.join(projectDir, 'tasks', `${taskId}.md`)
  if (!overwrite && fs.existsSync(taskPath)) throw new Error(`Task contract already exists: ${taskId}`)
  const templatePath = path.join(moduleDir, 'templates', 'task-contract.md')
  const template = fs.readFileSync(templatePath, 'utf8')
  const { frontmatter: defaults, body } = parseTemplateFrontmatter(template)
  const frontmatter = Object.fromEntries(Object.entries({
    ...defaults,
    task_id: taskId,
    plan_revision: defaults.plan_revision ?? 1,
    approved_revision: defaults.plan_revision ?? 1,
    role_hint: roleHint,
    complexity,
    domain_hint: domainHint,
    model_override: modelOverride,
    expected_paths: expectedPaths,
    protected_paths: protectedPaths,
    allowed_ephemeral_paths: allowedEphemeralPaths,
    allowed_shell_command_forms: allowedShellCommandForms,
    required_for_acceptance: requiredForAcceptance,
    inputs,
    outputs,
    acceptance_criteria: acceptanceCriteria,
    depends_on: dependsOn,
    escalation_rules: escalationRules,
    test_strategy: testStrategy,
  }).filter(([, value]) => value !== undefined))
  const rendered = renderTemplate(body, { TASK_ID: taskId, TASK_TITLE: title || taskId, TASK_GOAL: goal || '' })
  parseTaskFrontmatter(frontmatter)
  writeMarkdown(taskPath, `---\n${Object.entries(frontmatter).map(([key, value]) => `${key}: ${toJson(value)}`).join('\n')}\n---\n\n${rendered}`)
  return { taskPath, frontmatter, body: rendered }
}

export function ensureDir(dirPath) { fs.mkdirSync(dirPath, { recursive: true }) }
export function getProjectsRoot(repoRoot) { return path.join(repoRoot, PROJECTS_DIR) }
export function getActiveProjectPointerPath(repoRoot) { return path.join(repoRoot, ACTIVE_PROJECT_POINTER_FILE) }
export function sanitizeProjectSlug(slug) { return String(slug || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project' }
export function getDefaultProjectSlug(repoRoot) { return sanitizeProjectSlug(path.basename(repoRoot)) }
export function getProjectDir(repoRoot, projectSlug) { return path.join(getProjectsRoot(repoRoot), sanitizeProjectSlug(projectSlug)) }
export function listProjects(repoRoot) { const root = getProjectsRoot(repoRoot); if (!fs.existsSync(root)) return []; return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) }
export function projectExists(repoRoot, projectSlug) { return fs.existsSync(getProjectDir(repoRoot, projectSlug)) }
export function readActiveProjectSlug(repoRoot) { const pointerPath = getActiveProjectPointerPath(repoRoot); if (!fs.existsSync(pointerPath)) return null; try { const data = JSON.parse(fs.readFileSync(pointerPath, 'utf8')); return sanitizeProjectSlug(data?.projectSlug) } catch { return null } }
export function writeActiveProjectSlug(repoRoot, projectSlug) { const pointerPath = getActiveProjectPointerPath(repoRoot); ensureDir(path.dirname(pointerPath)); writeJsonAtomic(pointerPath, { projectSlug: sanitizeProjectSlug(projectSlug) }) }
export function clearActiveProjectSlug(repoRoot) { const pointerPath = getActiveProjectPointerPath(repoRoot); if (fs.existsSync(pointerPath)) fs.unlinkSync(pointerPath) }

export function appendProgress(progressPath, lines) { fs.appendFileSync(progressPath, `\n${lines.join('\n')}\n`) }
export function writeMarkdown(filePath, content) { const tempPath = `${filePath}.tmp-${process.pid}`; fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(tempPath, content); fs.renameSync(tempPath, filePath) }

export const VALID_TASK_STAGES = new Set(['draft', 'ready', 'approved', 'dispatched', 'reported', 'validating', 'done', 'blocked', 'rework_required', 'rejected'])

function rewriteTaskStageBlock(content, nextStage) {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) throw new Error('Task file missing frontmatter block')
  const lines = match[1].split(/\r?\n/)
  const stageLine = `stage: ${nextStage}`
  const stageIndex = lines.findIndex((line) => /^\s*stage\s*:/.test(line))
  if (stageIndex === -1) lines.splice(1, 0, stageLine)
  else lines[stageIndex] = stageLine
  return content.replace(/^---\n[\s\S]*?\n---/, `---\n${lines.join('\n')}\n---`)
}

function splitSummaryRow(line) {
  const trimmed = String(line || '').trim()
  if (!trimmed.startsWith('|')) return null
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '')
  return inner.split('|').map((cell) => cell.trim())
}

function updateTasksSummaryStatus(tasksPath, taskId, nextStage) {
  if (!fs.existsSync(tasksPath)) return false
  const content = fs.readFileSync(tasksPath, 'utf8')
  const lines = content.split(/\r?\n/)
  let headerIndex = -1
  let idColumn = -1
  let statusColumn = -1
  for (let index = 0; index < lines.length; index += 1) {
    const cells = splitSummaryRow(lines[index])
    if (!cells) continue
    const lowered = cells.map((cell) => cell.toLowerCase())
    const idCol = lowered.findIndex((header) => header === 'id' || header === 'task_id')
    const statusCol = lowered.findIndex((header) => header === 'status' || header === 'stage')
    if (idCol !== -1 && statusCol !== -1) {
      headerIndex = index
      idColumn = idCol
      statusColumn = statusCol
      break
    }
  }
  if (headerIndex === -1) return false
  for (let index = headerIndex + 2; index < lines.length; index += 1) {
    const cells = splitSummaryRow(lines[index])
    if (!cells) break
    if ((cells[idColumn] || '').toLowerCase() !== String(taskId).toLowerCase()) continue
    if ((cells[statusColumn] || '') === nextStage) return false
    cells[statusColumn] = nextStage
    lines[index] = `| ${cells.join(' | ')} |`
    writeMarkdown(tasksPath, lines.join('\n'))
    return true
  }
  return false
}

export function recordTaskStage({ projectDir, taskId, stage, note, now } = {}) {
  if (!projectDir || !taskId || !stage) throw new Error('recordTaskStage requires projectDir, taskId, stage')
  if (!VALID_TASK_STAGES.has(stage)) throw new Error(`recordTaskStage rejects unknown stage: ${stage}`)
  const taskPath = path.join(projectDir, 'tasks', `${String(taskId)}.md`)
  if (!fs.existsSync(taskPath)) throw new Error(`Task file missing: ${taskId}`)

  const { frontmatter: currentFrontmatter } = readMarkdownFrontmatter(taskPath)
  const previousStage = currentFrontmatter.stage || null
  const stageChanged = previousStage !== stage
  const shouldLog = stageChanged || Boolean(note)

  if (stageChanged) {
    const currentContent = fs.readFileSync(taskPath, 'utf8')
    writeMarkdown(taskPath, rewriteTaskStageBlock(currentContent, stage))
  }

  const progressPath = path.join(projectDir, 'progress.md')
  if (shouldLog) {
    const stamp = new Date(now ?? Date.now()).toISOString()
    const suffix = note ? `: ${note}` : ''
    const previousLabel = previousStage || 'none'
    appendProgress(progressPath, [`- ${stamp} Task ${taskId} stage ${previousLabel} -> ${stage}${suffix}`])
  }

  const tasksPath = path.join(projectDir, 'tasks.md')
  const updatedSummary = stageChanged ? updateTasksSummaryStatus(tasksPath, taskId, stage) : false

  return {
    taskPath,
    previousStage,
    stage,
    stageChanged,
    appendedProgress: shouldLog,
    updatedSummary,
    progressPath: shouldLog ? progressPath : null,
    tasksPath: fs.existsSync(tasksPath) ? tasksPath : null,
  }
}

function parseFrontmatterValue(value) { const trimmed = value.trim(); if (trimmed === 'null') return null; if (trimmed === 'true') return true; if (trimmed === 'false') return false; if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed); if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) { try { return JSON.parse(trimmed) } catch { return trimmed } } if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1); return trimmed }
export function readMarkdownFrontmatter(filePath) { const content = fs.readFileSync(filePath, 'utf8'); const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/); if (!match) return { frontmatter: {}, body: content }; const frontmatter = {}; for (const line of match[1].split(/\r?\n/)) { if (!line.trim()) continue; const index = line.indexOf(':'); if (index === -1) continue; const key = line.slice(0, index).trim(); const value = line.slice(index + 1); frontmatter[key] = parseFrontmatterValue(value) } return { frontmatter, body: match[2] } }
export function writeMarkdownFrontmatter(filePath, frontmatter, body = '') { const yaml = Object.entries(frontmatter).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n'); writeMarkdown(filePath, `---\n${yaml}\n---\n${body}`) }
export function updateMarkdownFrontmatter(filePath, updater) { const current = readMarkdownFrontmatter(filePath); const next = updater(current) || current; writeMarkdownFrontmatter(filePath, next.frontmatter, next.body); return next }

export function summarizeDegradations({ projectDir }) {
  if (!projectDir) return []
  const tasksDir = path.join(projectDir, 'tasks')
  if (!fs.existsSync(tasksDir)) return []
  return fs.readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => {
      const taskPath = path.join(tasksDir, entry.name)
      const { frontmatter } = readMarkdownFrontmatter(taskPath)
      const degraded = frontmatter?.degraded_from
      if (!degraded) return null
      return {
        task_id: frontmatter.task_id || entry.name.replace(/\.md$/, ''),
        from: degraded.presetName || degraded.preset || degraded.model || degraded.provider || null,
        to: frontmatter.effective_model?.presetName || frontmatter.effective_model?.preset || frontmatter.effective_model?.model || frontmatter.effective_model?.provider || null,
        reason: degraded.reason || null,
      }
    })
    .filter(Boolean)
}

export function writeReviewsDegradationSection({ projectDir, events }) {
  const reviewsPath = path.join(projectDir, 'reviews.md')
  const existing = fs.existsSync(reviewsPath) ? fs.readFileSync(reviewsPath, 'utf8') : ''
  const heading = '## Degradation Events'
  const normalizedEvents = Array.isArray(events) ? events : []
  const sectionBody = [heading, '', '| task_id | from | to | reason |', '| --- | --- | --- | --- |', ...normalizedEvents.map((event) => `| ${event.task_id || ''} | ${event.from || ''} | ${event.to || ''} | ${event.reason || ''} |`), ''].join('\n')
  if (!existing && normalizedEvents.length === 0) return { changed: false, reviewsPath }
  const pattern = /\n## Degradation Events\n[\s\S]*?(?=\n## |$)/
  const next = existing.match(pattern)
    ? existing.replace(pattern, `\n${sectionBody}`)
    : `${existing.replace(/\s*$/, '')}\n\n${sectionBody}`
  if (next === existing) return { changed: false, reviewsPath }
  writeMarkdown(reviewsPath, next)
  return { changed: true, reviewsPath }
}

export function isApprovedRevisionValid(frontmatter) { return frontmatter.approved_revision != null && frontmatter.approved_revision === frontmatter.plan_revision }
export function hasUnresolvedTaskStates(taskStates = []) { return taskStates.some((state) => state === 'rejected' || state === 'blocked') }
export function canEnterValidatingSession(taskStates = [], hasReviewArtifact = false) { return hasReviewArtifact && !hasUnresolvedTaskStates(taskStates) }
export function canEnterCompletedSession(taskStates = [], hasReviewArtifact = false) { return hasReviewArtifact && !hasUnresolvedTaskStates(taskStates) && taskStates.every((state) => state === 'completed' || state === 'done') }

function parseMarkdownTableRows(content) { const lines = content.split(/\r?\n/); const tableStart = lines.findIndex((line) => /^\|/.test(line.trim())); if (tableStart === -1 || tableStart + 1 >= lines.length) return []; const rows = [lines[tableStart].trim().slice(1, -1).split('|').map((cell) => cell.trim())]; for (let i = tableStart + 2; i < lines.length; i++) { const line = lines[i].trim(); if (!line || !/^\|/.test(line)) break; rows.push(line.slice(1, -1).split('|').map((cell) => cell.trim())) } return rows }
export function readTaskRows(taskFilePath) { if (!fs.existsSync(taskFilePath)) return []; const rows = parseMarkdownTableRows(fs.readFileSync(taskFilePath, 'utf8')); if (rows.length === 0) return []; const headers = rows[0].map((header) => header.toLowerCase()); return rows.slice(1).map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] || '']))) }
export function readReviewRows(reviewFilePath) { if (!fs.existsSync(reviewFilePath)) return []; const rows = parseMarkdownTableRows(fs.readFileSync(reviewFilePath, 'utf8')); if (rows.length === 0) return []; const headers = rows[0].map((header) => header.toLowerCase()); return rows.slice(1).map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] || '']))) }

export function setProjectStage(filePath, stage) { return updateMarkdownFrontmatter(filePath, ({ frontmatter, body }) => ({ frontmatter: { ...frontmatter, stage }, body })) }
export function recordTaskModelOutcome(filePath, { effective, degradedFrom, reason }) {
  return updateMarkdownFrontmatter(filePath, ({ frontmatter, body }) => ({
    frontmatter: {
      ...frontmatter,
      effective_model: effective
        ? { preset: effective.presetName || null, provider: effective.provider || null, model: effective.model || null, variant: effective.variant || null }
        : null,
      degraded_from: degradedFrom
        ? { preset: degradedFrom.presetName || null, provider: degradedFrom.provider || null, model: degradedFrom.model || null, variant: degradedFrom.variant || null, reason: reason || 'unknown' }
        : null,
    },
    body,
  }))
}
export function setProjectPhase(filePath, { phase, subphase, stage }) {
  return updateMarkdownFrontmatter(filePath, ({ frontmatter, body }) => ({
    frontmatter: {
      ...withProjectDefaults(frontmatter),
      ...(stage ? { stage } : {}),
      ...(phase ? { phase } : {}),
      ...(subphase ? { subphase } : {}),
    },
    body,
  }))
}
export function resetTaskPlanApproval(filePath, reason) { return updateMarkdownFrontmatter(filePath, ({ frontmatter, body }) => ({ frontmatter: { ...frontmatter, plan_revision: Number(frontmatter.plan_revision || 0) + 1, approved_revision: null, approved_by: null, approved_at: null, stage: 'awaiting_approval', approval_reset_reason: reason || frontmatter.approval_reset_reason || null }, body })) }
export function reopenProjectPhase(filePath, { phase, subphase, reason, impactLevel = 'local' }) {
  return updateMarkdownFrontmatter(filePath, ({ frontmatter, body }) => {
    const current = withProjectDefaults(frontmatter)
    const next = {
      ...current,
      stage: 'planning',
      phase: phase || current.phase,
      subphase: subphase || current.subphase,
      execution_authorized: false,
      last_gate_question_id: null,
      change_impact_level: impactLevel,
      approval_reset_reason: reason || current.approval_reset_reason || null,
    }

    if (next.phase === 'phase1_discovery') {
      next.phase1_revision = Number(current.phase1_revision || 0) + 1
      next.phase1_approved_revision = null
      next.phase2_approved_revision = null
    }

    if (next.phase === 'phase2_tasks' || next.phase === 'phase1_discovery') {
      next.phase2_revision = Math.max(Number(current.phase2_revision || 0), 1)
      next.phase2_approved_revision = null
      next.execution_snapshot_revision = null
    }

    return { frontmatter: next, body }
  })
}

export function recordGateApproval(filePath, { gate, requestID, approvedBy = 'question-tool', approvedAt = new Date().toISOString() }) {
  return updateMarkdownFrontmatter(filePath, ({ frontmatter, body }) => {
    const current = withProjectDefaults(frontmatter)
    const next = {
      ...current,
      approved_by: approvedBy,
      approved_at: approvedAt,
      last_gate_question_id: requestID || current.last_gate_question_id,
    }

    if (gate === 'phase1') {
      next.phase1_approved_revision = current.phase1_revision
      next.phase = 'phase2_tasks'
      next.subphase = 'task_graph_draft'
      next.stage = 'planning'
      next.change_impact_level = 'local'
      return { frontmatter: next, body }
    }

    if (gate === 'phase2') {
      next.phase2_approved_revision = current.phase2_revision
      next.phase = 'phase3_execution'
      next.subphase = 'execution_authorization'
      next.stage = 'awaiting_approval'
      next.execution_authorized = false
      next.change_impact_level = 'local'
      return { frontmatter: next, body }
    }

    if (gate === 'execution') {
      next.phase = 'phase3_execution'
      next.subphase = 'dispatch'
      next.stage = 'implementing'
      next.execution_authorized = true
      next.execution_snapshot_revision = Number(current.execution_snapshot_revision || 0) + 1
      next.change_impact_level = 'local'
      return { frontmatter: next, body }
    }

    return { frontmatter: next, body }
  })
}

export const PROJECT_ARTIFACT_NAMES = ['project', 'context', 'backlog', 'findings', 'progress', 'tasks', 'reviews', 'execution-snapshot']

export function hasCanonicalProjectArtifacts(repoRoot, projectSlug) {
  const projectDir = getProjectDir(repoRoot, projectSlug)
  return PROJECT_ARTIFACT_NAMES.every((artifactName) => fs.existsSync(path.join(projectDir, `${artifactName}.md`)))
    && ['tasks', 'reviews'].every((dirName) => fs.existsSync(path.join(projectDir, dirName)))
}

function writeProjectArtifacts({ rootDir, projectSlug, templates, overwrite }) {
  const projectDir = getProjectDir(rootDir, projectSlug)
  ensureDir(path.join(projectDir, 'tasks'))
  ensureDir(path.join(projectDir, 'reviews'))
  const replacements = { REPO_ROOT: rootDir, ACTIVE_PROJECT_SLUG: sanitizeProjectSlug(projectSlug), PROJECT_DIR: path.relative(rootDir, projectDir) }
  for (const artifactName of PROJECT_ARTIFACT_NAMES) {
    const artifactPath = path.join(projectDir, `${artifactName}.md`)
    if (!overwrite && fs.existsSync(artifactPath)) continue
    writeMarkdown(artifactPath, renderTemplate(templates[artifactName], replacements))
  }
  return { projectDir }
}

export function bootstrapProjectArtifacts({ rootDir, projectSlug, templates }) {
  return writeProjectArtifacts({ rootDir, projectSlug, templates, overwrite: true })
}

export function ensureProjectArtifacts({ rootDir, projectSlug, templates }) {
  return writeProjectArtifacts({ rootDir, projectSlug, templates, overwrite: false })
}

export function writeTaskFile(taskPath, frontmatter, body = '') { const payload = { task_id: frontmatter.task_id, plan_revision: frontmatter.plan_revision, approved_revision: frontmatter.approved_revision, ...frontmatter }; const yaml = Object.entries(payload).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n'); writeMarkdown(taskPath, `---\n${yaml}\n---\n\n${body}`) }
export function writeReviewFile(reviewPath, frontmatter, body = '') { const payload = { task_id: frontmatter.task_id, plan_revision: frontmatter.plan_revision, approved_revision: frontmatter.approved_revision, ...frontmatter }; writeTaskFile(reviewPath, payload, body) }
export function writeLease(filePath, data) { writeJsonAtomic(filePath, data) }
export function readProjectState(projectPath) {
  const payload = readMarkdownFrontmatter(projectPath)
  return { ...payload, frontmatter: withProjectDefaults(payload.frontmatter) }
}
export function getProjectFilePath(projectDir, filename) { return path.join(projectDir, filename) }
export function readTaskPlan(taskPlanPath) { return readMarkdownFrontmatter(taskPlanPath) }
export function getExecutionSnapshotPath(projectDir) { return path.join(projectDir, 'execution-snapshot.md') }
export function writeExecutionSnapshot(projectDir, snapshot = {}, body = '') {
  const payload = {
    snapshot_revision: snapshot.snapshot_revision ?? snapshot.execution_snapshot_revision ?? null,
    phase2_approved_revision: snapshot.phase2_approved_revision ?? null,
    approved_task_ids: normalizeArray(snapshot.approved_task_ids),
    deferred_task_ids: normalizeArray(snapshot.deferred_task_ids),
    blocked_task_ids: normalizeArray(snapshot.blocked_task_ids),
    created_at: snapshot.created_at || new Date().toISOString(),
    authorized_by_question_id: snapshot.authorized_by_question_id || null,
  }
  writeMarkdownFrontmatter(getExecutionSnapshotPath(projectDir), payload, body)
}

function readFreshMarkdown(filePath) { const stat = fs.statSync(filePath); const payload = readMarkdownFrontmatter(filePath); return { filePath, mtimeMs: stat.mtimeMs, size: stat.size, ...payload } }

export function refreshProjectContext({ repoRoot, projectDir }) {
  const resolvedProjectDir = path.resolve(projectDir || '')
  const projectPath = path.join(resolvedProjectDir, 'project.md')
  const contextPath = path.join(resolvedProjectDir, 'context.md')
  const tasksPath = path.join(resolvedProjectDir, 'tasks.md')
  for (const requiredPath of [projectPath, contextPath, tasksPath]) { if (!fs.existsSync(requiredPath)) throw new Error(`Required project context file missing: ${path.basename(requiredPath)}`) }
  const freshProject = readFreshMarkdown(projectPath)
  const project = { ...freshProject, frontmatter: withProjectDefaults(freshProject.frontmatter) }
  const context = readFreshMarkdown(contextPath)
  const tasks = readFreshMarkdown(tasksPath)
  const activeTaskIDs = Array.isArray(project.frontmatter.active_tasks) ? project.frontmatter.active_tasks : []
  if (activeTaskIDs.length === 0) throw new Error('Required project context missing active_tasks for claim path')
  const activeTasks = activeTaskIDs.map((taskID) => {
    const taskPath = path.join(resolvedProjectDir, 'tasks', `${taskID}.md`)
    if (!fs.existsSync(taskPath)) throw new Error(`Required active task file missing: ${path.basename(taskPath)}`)
    return readFreshMarkdown(taskPath)
  })
  return { repoRoot: repoRoot ? path.resolve(repoRoot) : null, projectDir: resolvedProjectDir, files: { project, context, tasks, activeTasks }, freshness: { project: { mtimeMs: project.mtimeMs, size: project.size }, context: { mtimeMs: context.mtimeMs, size: context.size }, tasks: { mtimeMs: tasks.mtimeMs, size: tasks.size }, activeTasks: activeTasks.map((file) => ({ filePath: file.filePath, mtimeMs: file.mtimeMs, size: file.size })) } }
}

export function recoverProjectState({ repoRoot, projectDir }) {
  const projectPath = path.join(projectDir, 'project.md')
  const { frontmatter, body } = readMarkdownFrontmatter(projectPath)
  if (frontmatter.stage !== 'quarantined') {
    writeActiveProjectSlug(repoRoot, path.basename(projectDir))
    return { changed: false, projectPath }
  }

  const nextFrontmatter = {
    ...frontmatter,
    stage: 'planning',
    quarantine_reason: null,
  }
  writeMarkdownFrontmatter(projectPath, nextFrontmatter, body)
  writeActiveProjectSlug(repoRoot, path.basename(projectDir))
  return { changed: true, projectPath }
}

// ============================================================================
// Multi-batch workflow lifecycle (T009)
//
// A "batch" is one full Phase 1→3 cycle inside a Yak project. Multiple batches
// can live in the same workspace; shared memory (findings, context, progress,
// backlog 'later') carries across them while batch-scoped artifacts (tasks/,
// tasks.md, execution-snapshot.md, reviews, backlog done/dropped) archive into
// `<project>/batches/<N>/` when a new batch opens.
//
// The transition uses a journaled-commit pattern with three phases:
//
//   prepared   → lock held, staging copy complete, journal written; no user-
//                visible mutations yet. Crash here: rollback from staging.
//   committing → moves + frontmatter writes in progress; dst paths populated
//                incrementally. Crash here: rollback (staging is authoritative
//                pre-transition state, rollback is idempotent).
//   committed  → all writes complete and durable. Crash during cleanup:
//                finalize (delete staging + journal + lock).
//
// Cleanup order on success is STRICT: staging → journal → lock. That ordering
// is what makes the "no-journal-but-lock" crash window deterministically
// recoverable: if we see a lock without a journal, writes are already durable
// and we only need to release the lock.
//
// Stale-lock recovery: if the lock exists but its heartbeat is older than
// STALE_TRANSITION_LOCK_MS and no journal is present, recovery reclaims the
// lock and continues.
// ============================================================================

const TRANSITION_LOCK_BASENAME = '.batch-transition.lock'
const TRANSITION_JOURNAL_BASENAME = '.batch-transition-journal.json'
const TRANSITION_STAGING_BASENAME = '.batch-transition-staging'
export const STALE_TRANSITION_LOCK_MS = 60 * 1000

export class IncompleteTasksError extends Error {
  constructor(tasks) {
    const ids = tasks.map((task) => task.task_id || '?').join(', ')
    super(`Incomplete tasks at batch boundary: ${ids}`)
    this.name = 'IncompleteTasksError'
    this.incompleteTasks = tasks
  }
}

export class BatchCancelledError extends Error {
  constructor() {
    super('Batch transition cancelled by policy')
    this.name = 'BatchCancelledError'
  }
}

class BatchTransitionInProgressError extends Error {
  constructor(status) {
    super(`batch transition in progress${status ? ` (status=${status})` : ''}; call recovery first`)
    this.name = 'BatchTransitionInProgressError'
    this.journalStatus = status || null
  }
}

function transitionPaths(projectDir) {
  return {
    projectPath: path.join(projectDir, 'project.md'),
    tasksDir: path.join(projectDir, 'tasks'),
    tasksFile: path.join(projectDir, 'tasks.md'),
    snapshotFile: path.join(projectDir, 'execution-snapshot.md'),
    reviewsFile: path.join(projectDir, 'reviews.md'),
    reviewsDir: path.join(projectDir, 'reviews'),
    backlogFile: path.join(projectDir, 'backlog.md'),
    progressFile: path.join(projectDir, 'progress.md'),
    summaryFile: path.join(projectDir, 'batch-summary.md'),
    summaryTemplate: path.join(moduleDir, 'templates', 'batch-summary.md'),
    lockFile: path.join(projectDir, TRANSITION_LOCK_BASENAME),
    journalFile: path.join(projectDir, TRANSITION_JOURNAL_BASENAME),
    stagingDir: path.join(projectDir, TRANSITION_STAGING_BASENAME),
  }
}

function batchDir(projectDir, batch) {
  return path.join(projectDir, 'batches', String(batch))
}

function listIncompleteTasks(tasksDir) {
  if (!fs.existsSync(tasksDir)) return []
  const out = []
  for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const taskPath = path.join(tasksDir, entry.name)
    const { frontmatter } = readMarkdownFrontmatter(taskPath)
    const stage = frontmatter.stage || null
    if (stage && stage !== 'done' && stage !== 'rejected') {
      out.push({ task_id: frontmatter.task_id || entry.name.replace(/\.md$/, ''), stage, path: taskPath })
    }
  }
  return out
}

function computePlannedMoves(paths, closingBatch) {
  const moves = []
  const target = batchDir('', closingBatch) // relative
  if (fs.existsSync(paths.tasksDir)) {
    for (const entry of fs.readdirSync(paths.tasksDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        moves.push({
          src: path.join('tasks', entry.name),
          dst: path.join(target, 'tasks', entry.name),
          kind: 'file',
        })
      }
    }
  }
  for (const [baseName, relName] of [
    ['tasksFile', 'tasks.md'],
    ['snapshotFile', 'execution-snapshot.md'],
    ['reviewsFile', 'reviews.md'],
  ]) {
    if (fs.existsSync(paths[baseName])) {
      moves.push({ src: relName, dst: path.join(target, relName), kind: 'file' })
    }
  }
  if (fs.existsSync(paths.reviewsDir) && fs.statSync(paths.reviewsDir).isDirectory()) {
    moves.push({ src: 'reviews', dst: path.join(target, 'reviews'), kind: 'dir' })
  }
  return moves
}

function computePlannedResets(current, closingBatch) {
  return {
    current_batch: closingBatch + 1,
    batches_completed: [...normalizeArray(current.batches_completed), closingBatch],
    batch_started_at: new Date().toISOString(),
    active_tasks: [],
    completed_task_ids: [],
    draft_task_ids: [],
    blocked_task_ids: [],
    approved_task_ids: [],
    open_questions: [],
    execution_snapshot_revision: null,
    approved_revision: null,
    approved_by: null,
    approved_at: null,
    last_gate_question_id: null,
    approval_reset_reason: null,
    execution_authorized: false,
    critic_status: 'not_offered',
    phase: 'phase1_discovery',
    subphase: 'scope_draft',
    stage: 'planning',
    phase1_revision: 1,
    phase2_revision: 1,
    plan_revision: 1,
    phase1_approved_revision: null,
    phase2_approved_revision: null,
  }
}

export function planTransition({ projectDir, summary, incompleteTaskPolicy } = {}) {
  if (!projectDir) throw new Error('planTransition requires projectDir')
  const paths = transitionPaths(projectDir)
  if (!fs.existsSync(paths.projectPath)) throw new Error(`planTransition: project.md missing at ${paths.projectPath}`)
  const { frontmatter } = readMarkdownFrontmatter(paths.projectPath)
  const current = withProjectDefaults(frontmatter)
  const closingBatch = current.current_batch || 1
  const newBatch = closingBatch + 1
  return {
    closing_batch: closingBatch,
    new_batch: newBatch,
    summary: summary || null,
    policy: incompleteTaskPolicy ?? null,
    incomplete_tasks: listIncompleteTasks(paths.tasksDir),
    planned_moves: computePlannedMoves(paths, closingBatch),
    planned_resets: computePlannedResets(current, closingBatch),
    journal_path: paths.journalFile,
    staging_dir: paths.stagingDir,
    batch_dir: batchDir(projectDir, closingBatch),
  }
}

function copyIntoStaging(projectDir, stagingDir, relativePath) {
  const src = path.join(projectDir, relativePath)
  if (!fs.existsSync(src)) return false
  const dst = path.join(stagingDir, relativePath)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  const stat = fs.statSync(src)
  if (stat.isDirectory()) {
    fs.cpSync(src, dst, { recursive: true, force: true })
  } else {
    fs.copyFileSync(src, dst)
  }
  return true
}

function stageCurrentState(projectDir, plan, paths) {
  fs.mkdirSync(plan.staging_dir, { recursive: true })
  // Stage everything that the commit could touch, so rollback can fully
  // restore even if commit started writing.
  const candidates = [
    'project.md',
    'tasks',
    'tasks.md',
    'execution-snapshot.md',
    'reviews.md',
    'reviews',
    'backlog.md',
    'progress.md',
    'batch-summary.md',
  ]
  for (const rel of candidates) {
    copyIntoStaging(projectDir, plan.staging_dir, rel)
  }
}

function writeJournal(journalPath, payload) {
  writeJsonAtomic(journalPath, payload)
}

function readJournal(journalPath) {
  if (!fs.existsSync(journalPath)) return null
  try { return JSON.parse(fs.readFileSync(journalPath, 'utf8')) } catch { return null }
}

function moveIntoBatch(projectDir, move) {
  const srcAbs = path.join(projectDir, move.src)
  const dstAbs = path.join(projectDir, move.dst)
  fs.mkdirSync(path.dirname(dstAbs), { recursive: true })
  if (!fs.existsSync(srcAbs)) return false
  fs.renameSync(srcAbs, dstAbs)
  return true
}

function splitBacklogForArchive(projectDir, paths, closingBatch) {
  // Keep 'now' + 'later' live; move 'done' + 'dropped' to archive. The
  // backlog.md template uses ## Now, ## Later, ## Blocked, ## Dropped.
  // Sections are identified by the `## ` headings.
  if (!fs.existsSync(paths.backlogFile)) return
  const content = fs.readFileSync(paths.backlogFile, 'utf8')
  const match = content.match(/^(---\n[\s\S]*?\n---\n)([\s\S]*)$/)
  const header = match ? match[1] : ''
  const body = match ? match[2] : content

  const sections = {}
  let currentName = null
  const preamble = []
  for (const line of body.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+)$/)
    if (heading) {
      currentName = heading[1].trim().toLowerCase().split(/\s+/)[0]
      sections[currentName] = [line]
      continue
    }
    if (currentName == null) preamble.push(line)
    else sections[currentName].push(line)
  }

  const liveNames = ['now', 'later', 'blocked']
  const archivedNames = ['done', 'dropped']
  const liveBody = [
    ...preamble,
    ...liveNames.flatMap((name) => sections[name] || []),
  ].join('\n')
  const archivedBody = archivedNames.flatMap((name) => sections[name] || []).join('\n').trim()

  const liveFile = `${header}${liveBody.replace(/\n+$/, '')}\n`
  writeMarkdown(paths.backlogFile, liveFile)

  if (archivedBody) {
    const archivePath = path.join(batchDir(projectDir, closingBatch), 'backlog-archived.md')
    fs.mkdirSync(path.dirname(archivePath), { recursive: true })
    writeMarkdown(archivePath, `${header}${archivedBody}\n`)
  }
}

function rotateProgressFile(paths, closingBatch) {
  if (!fs.existsSync(paths.progressFile)) return
  const content = fs.readFileSync(paths.progressFile, 'utf8')
  const match = content.match(/^(---\n[\s\S]*?\n---\n)([\s\S]*)$/)
  const header = match ? match[1] : ''
  const body = (match ? match[2] : content).replace(/^\s+|\s+$/g, '')
  const openMarker = `<!-- batch ${closingBatch} archive -->`
  const closeMarker = `<!-- end batch ${closingBatch} -->`
  const wrapped = `${header}\n${openMarker}\n${body}\n${closeMarker}\n`
  writeMarkdown(paths.progressFile, wrapped)
}

function appendBatchSummary(paths, closingBatch, summary) {
  if (!fs.existsSync(paths.summaryFile)) {
    // Render from template if available; otherwise create a minimal stub.
    if (fs.existsSync(paths.summaryTemplate)) {
      const tmpl = fs.readFileSync(paths.summaryTemplate, 'utf8')
      const slug = path.basename(path.dirname(paths.summaryFile))
      writeMarkdown(paths.summaryFile, renderTemplate(tmpl, { ACTIVE_PROJECT_SLUG: slug }))
    } else {
      writeMarkdown(paths.summaryFile, `---\nschema_version: 1\n---\n\n# Batches\n`)
    }
  }
  const entry = [
    ``,
    `## Batch ${closingBatch}${summary ? ` — ${summary.split(/\r?\n/)[0]}` : ''}`,
    ``,
    `- Closed: ${new Date().toISOString()}`,
    summary ? `- Summary: ${summary}` : `- Summary: (none provided)`,
    ``,
  ].join('\n')
  fs.appendFileSync(paths.summaryFile, entry)
}

export function startNewBatch({ projectDir, summary, incompleteTaskPolicy } = {}) {
  if (!projectDir) throw new Error('startNewBatch requires projectDir')
  const paths = transitionPaths(projectDir)

  // Step a: plan (pure).
  const plan = planTransition({ projectDir, summary, incompleteTaskPolicy })

  // Incomplete-task gate: T009 throws if policy is unset. T012 extends.
  if (plan.incomplete_tasks.length > 0 && !incompleteTaskPolicy) {
    throw new IncompleteTasksError(plan.incomplete_tasks)
  }
  if (incompleteTaskPolicy === 'cancel') {
    throw new BatchCancelledError()
  }

  // Leftover-transition guard.
  const existingJournal = readJournal(paths.journalFile)
  if (existingJournal) throw new BatchTransitionInProgressError(existingJournal.status)

  const lockAlreadyExists = fs.existsSync(paths.lockFile)
  if (lockAlreadyExists) {
    throw new BatchTransitionInProgressError('lock-held-without-journal')
  }

  // Step b: acquire lock.
  acquireJsonLock(paths.lockFile, {
    kind: 'batch_transition',
    project_dir: projectDir,
    closing_batch: plan.closing_batch,
    new_batch: plan.new_batch,
    pid: process.pid,
    last_heartbeat_time: new Date().toISOString(),
    stale_after_ms: STALE_TRANSITION_LOCK_MS,
  })

  try {
    if (fs.existsSync(plan.batch_dir)) {
      throw new Error(`batch ${plan.closing_batch} already archived at ${plan.batch_dir}`)
    }

    // Step c: stage pre-state.
    if (fs.existsSync(plan.staging_dir)) fs.rmSync(plan.staging_dir, { recursive: true, force: true })
    stageCurrentState(projectDir, plan, paths)

    // Step d: write journal status='prepared'.
    writeJournal(paths.journalFile, {
      status: 'prepared',
      closing_batch: plan.closing_batch,
      new_batch: plan.new_batch,
      summary: plan.summary,
      policy: plan.policy,
      planned_moves: plan.planned_moves,
      planned_resets: plan.planned_resets,
      staging_dir: plan.staging_dir,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })

    // Step e: update journal to 'committing' and perform mutations.
    writeJournal(paths.journalFile, {
      ...readJournal(paths.journalFile),
      status: 'committing',
      updated_at: new Date().toISOString(),
    })

    // Moves.
    for (const move of plan.planned_moves) {
      moveIntoBatch(projectDir, move)
    }

    // Incomplete-task policy handling. Runs AFTER moves so the archived files
    // are what we mutate (abandon) or clone from (carry). Policy='cancel' is
    // already handled above via BatchCancelledError before any mutation.
    if (incompleteTaskPolicy === 'abandon' && plan.incomplete_tasks.length > 0) {
      for (const task of plan.incomplete_tasks) {
        const archivedPath = path.join(batchDir(projectDir, plan.closing_batch), 'tasks', path.basename(task.path))
        if (!fs.existsSync(archivedPath)) continue
        const content = fs.readFileSync(archivedPath, 'utf8')
        fs.writeFileSync(archivedPath, rewriteTaskStageBlock(content, 'abandoned'))
      }
    }

    if (incompleteTaskPolicy === 'carry' && plan.incomplete_tasks.length > 0) {
      fs.mkdirSync(paths.tasksDir, { recursive: true })
      let carryCounter = 0
      for (const task of plan.incomplete_tasks) {
        carryCounter += 1
        const newBatch = plan.new_batch
        const newId = `B${newBatch}-T${String(carryCounter).padStart(3, '0')}`
        const archivedPath = path.join(batchDir(projectDir, plan.closing_batch), 'tasks', path.basename(task.path))
        if (!fs.existsSync(archivedPath)) continue
        const { frontmatter: archived, body: archivedBody } = readMarkdownFrontmatter(archivedPath)
        const clonedFrontmatter = {
          ...archived,
          task_id: newId,
          stage: 'draft',
          // depends_on preserved VERBATIM per T012 contract — runtime does not
          // consume dep edges today, so rewriting is YAGNI. Downstream tooling
          // sees original batch IDs, which remain valid within archived batch
          // references but won't exist in live tasks/ until separately carried.
          depends_on: archived.depends_on,
        }
        const rippleNote = `\n\n## Carry origin\n\n- Original task_id: ${archived.task_id || task.task_id}\n- Original batch: ${plan.closing_batch}\n- Original stage at carry: ${task.stage}\n`
        const clonedBody = (archivedBody || '') + rippleNote
        const newPath = path.join(paths.tasksDir, `${newId}.md`)
        writeMarkdownFrontmatter(newPath, clonedFrontmatter, clonedBody)
      }
    }

    // Backlog split.
    splitBacklogForArchive(projectDir, paths, plan.closing_batch)

    // Progress rotation.
    rotateProgressFile(paths, plan.closing_batch)

    // Batch summary append.
    appendBatchSummary(paths, plan.closing_batch, plan.summary)

    // Project.md frontmatter resets (this is where batch fields first land
    // on disk per T008's lazy-persistence contract).
    updateMarkdownFrontmatter(paths.projectPath, ({ frontmatter, body }) => {
      const nextFrontmatter = { ...frontmatter, ...plan.planned_resets }
      return { frontmatter: nextFrontmatter, body }
    })

    // Step f: update journal to 'committed' (durability point).
    writeJournal(paths.journalFile, {
      ...readJournal(paths.journalFile),
      status: 'committed',
      updated_at: new Date().toISOString(),
    })

    // Step g: cleanup order is strict: staging → journal → lock.
    fs.rmSync(plan.staging_dir, { recursive: true, force: true })
    fs.unlinkSync(paths.journalFile)
    releaseJsonLock(paths.lockFile)

    return {
      closing_batch: plan.closing_batch,
      new_batch: plan.new_batch,
      planned_moves: plan.planned_moves,
    }
  } catch (err) {
    // Release the lock best-effort so recovery can re-acquire. Journal +
    // staging remain for recoverInterruptedBatchTransition to inspect.
    try { releaseJsonLock(paths.lockFile) } catch {}
    throw err
  }
}

function restoreFromStaging(projectDir, stagingDir) {
  if (!fs.existsSync(stagingDir)) return
  for (const entry of fs.readdirSync(stagingDir, { withFileTypes: true })) {
    const src = path.join(stagingDir, entry.name)
    const dst = path.join(projectDir, entry.name)
    if (entry.isDirectory()) {
      // Remove current dst then copy back.
      if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true })
      fs.cpSync(src, dst, { recursive: true, force: true })
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dst)
    }
  }
}

export function recoverInterruptedBatchTransition({ projectDir } = {}) {
  if (!projectDir) return { recovered: false, reason: 'no-project-dir' }
  const paths = transitionPaths(projectDir)
  const journal = readJournal(paths.journalFile)
  const lockExists = fs.existsSync(paths.lockFile)

  if (!journal && !lockExists) return { recovered: false, reason: 'no-transition-in-flight' }

  if (!journal && lockExists) {
    // No-journal-but-lock: cleanup ran past journal deletion. If the lock is
    // stale, reclaim it; otherwise leave alone (could be a live holder).
    const lockRaw = readJson(paths.lockFile)
    const lastHeartbeat = lockRaw?.last_heartbeat_time || null
    if (isStale(lastHeartbeat, STALE_TRANSITION_LOCK_MS)) {
      releaseJsonLock(paths.lockFile)
      return { recovered: true, action: 'stale-lock-reclaimed', status: null }
    }
    return { recovered: false, reason: 'live-lock-no-journal' }
  }

  const status = journal.status || 'prepared'
  const stagingDir = journal.staging_dir || paths.stagingDir

  if (status === 'committed') {
    // Finalize: delete staging if present, delete journal, release lock.
    if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true })
    if (fs.existsSync(paths.journalFile)) fs.unlinkSync(paths.journalFile)
    if (lockExists) releaseJsonLock(paths.lockFile)
    return { recovered: true, action: 'finalize', status }
  }

  // status === 'prepared' or 'committing': roll back from staging.
  restoreFromStaging(projectDir, stagingDir)
  // Remove any partially-created batch dir.
  const partialBatchDir = batchDir(projectDir, journal.closing_batch || 0)
  if (fs.existsSync(partialBatchDir)) fs.rmSync(partialBatchDir, { recursive: true, force: true })
  if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true })
  if (fs.existsSync(paths.journalFile)) fs.unlinkSync(paths.journalFile)
  if (lockExists) releaseJsonLock(paths.lockFile)
  return { recovered: true, action: 'rollback', status }
}

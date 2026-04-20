import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { writeJsonAtomic } from './locks.js'
import { parseTaskFrontmatter } from './task-policy.js'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))

export const PROJECTS_DIR = path.join('.agents', 'yak', 'projects')
export const ACTIVE_PROJECT_POINTER_FILE = path.join('.agents', 'yak', 'active-project.json')
export const DEFAULT_PROJECT_FRONTMATTER = {
  project_slug: null,
  project_dir: null,
  stage: 'planning',
  phase: 'phase1_discovery',
  subphase: 'discovery',
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
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : []
}

export function withProjectDefaults(frontmatter = {}) {
  return {
    ...DEFAULT_PROJECT_FRONTMATTER,
    ...frontmatter,
    approved_task_ids: normalizeArray(frontmatter.approved_task_ids),
    draft_task_ids: normalizeArray(frontmatter.draft_task_ids),
    blocked_task_ids: normalizeArray(frontmatter.blocked_task_ids),
    active_tasks: normalizeArray(frontmatter.active_tasks),
    open_questions: normalizeArray(frontmatter.open_questions),
  }
}

export function migrateProjectFrontmatter({ projectDir } = {}) {
  if (!projectDir) return { migrated: false, addedKeys: [], preservedKeys: [] }
  const projectPath = path.join(projectDir, 'project.md')
  if (!fs.existsSync(projectPath)) return { migrated: false, addedKeys: [], preservedKeys: [] }

  const { frontmatter, body } = readMarkdownFrontmatter(projectPath)
  const current = frontmatter || {}
  const next = withProjectDefaults(current)
  const schemaKeys = new Set(Object.keys(DEFAULT_PROJECT_FRONTMATTER))
  const addedKeys = Object.keys(DEFAULT_PROJECT_FRONTMATTER).filter((key) => !(key in current))
  const preservedKeys = Object.keys(current).filter((key) => !schemaKeys.has(key))
  const currentBytes = fs.readFileSync(projectPath, 'utf8')
  const nextYaml = Object.entries(next).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')
  const nextBytes = `---\n${nextYaml}\n---\n${body}`

  if (currentBytes === nextBytes) return { migrated: false, addedKeys: [], preservedKeys }

  writeMarkdownFrontmatter(projectPath, next, body)
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

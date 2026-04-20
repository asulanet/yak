import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'

import { findNearestGitRoot, ensureInsideRoot } from './planning-files/root-resolution.js'
import { buildRepoWriteLeaseMetadata, getStaleAfterMs } from './planning-files/locks.js'
import { appendProgress, bootstrapProjectArtifacts, ensureProjectArtifacts, getDefaultProjectSlug, getExecutionSnapshotPath, getProjectDir, getProjectFilePath, hasCanonicalProjectArtifacts, listProjects, migrateProjectFrontmatter, projectExists, readActiveProjectSlug, readProjectState, readTaskPlan, recordGateApproval, recordTaskModelOutcome, recordTaskStage, recoverProjectState, refreshProjectContext, sanitizeProjectSlug, setProjectPhase, stampTaskContract, summarizeDegradations, updateMarkdownFrontmatter, withProjectDefaults, writeActiveProjectSlug, writeExecutionSnapshot, writeLease, writeReviewsDegradationSection } from './planning-files/session-store.js'
import { assertApplyPatchAllowedForOrchestrator, assertApplyPatchAllowedForWorker, assertOrchestratorControlMkdirAllowed, assertOrchestratorControlWriteAllowed, assertPlanningWriteAllowed, assertScopedToolAllowed, assertTaskShellAllowed, assertTaskWriteAllowed, extractCandidatePaths, extractScopedToolTargets, hasForbiddenShellSyntax, isBlockedOrchestratorShellCommand, isAllowedReadonlyShell, isAllowedTestRunnerCommand, isDeniedPlanningTool, isMutatingTool, isPlanningStage, isOpenStage } from './planning-files/policy.js'
import { clearQuestionRequest, recordQuestionResolution, rememberQuestionRequest } from './planning-files/persistence.js'
import { detectGateApproval, detectGateRequest, extractTextFromParts, looksLikeFreeformQuestion } from './planning-files/question-findings.js'
import { advanceFallback, describeDegradation, resolveTaskModel } from './planning-files/model-routing.js'
import { buildPlanCriticPrompt, choosePlanCriticTarget } from './planning-files/review-routing.js'
import { normalizeAllowedPaths, parseTaskFrontmatter } from './planning-files/task-policy.js'
import { parseJsonc } from '../vendor/jsonc-parser.js'

function readJsonFile(filePath, fallback = {}) { if (!fs.existsSync(filePath)) return fallback; return JSON.parse(fs.readFileSync(filePath, 'utf8')) }
function readJsoncFile(filePath, fallback = {}) { if (!fs.existsSync(filePath)) return fallback; return parseJsonc(fs.readFileSync(filePath, 'utf8'), filePath) }
function getConfigRoot() { if (process.env.OPENCODE_CONFIG_DIR) return path.resolve(process.env.OPENCODE_CONFIG_DIR); if (process.env.XDG_CONFIG_HOME) return path.join(path.resolve(process.env.XDG_CONFIG_HOME), 'opencode'); return path.join(os.homedir(), '.config', 'opencode') }
function getModuleDir() { return path.dirname(fileURLToPath(import.meta.url)) }
function mergeConfig(base, override) { if (Array.isArray(base) && Array.isArray(override)) return override; if (base && typeof base === 'object' && override && typeof override === 'object' && !Array.isArray(base) && !Array.isArray(override)) { const result = { ...base }; for (const [key, value] of Object.entries(override)) result[key] = key in base ? mergeConfig(base[key], value) : value; return result } return override ?? base }
function readWorkflowShape(config) { return config && typeof config === 'object' ? (config.workflow || config.planning || {}) : {} }
function loadTemplates(baseDir) {
  const projectTemplateNames = ['project','context','backlog','findings','progress','tasks','reviews','execution-snapshot']
  const projectTemplates = Object.fromEntries(projectTemplateNames.map((name) => [name, fs.readFileSync(path.join(baseDir, 'planning-files', 'templates', `${name}.md`), 'utf8')]))
  projectTemplates.taskContract = fs.readFileSync(path.join(baseDir, 'planning-files', 'templates', 'task-contract.md'), 'utf8')
  return projectTemplates
}
function normalizeTaskID(value) { return typeof value === 'string' && value.trim() ? value.trim() : null }
const PROJECT_GATE_FIELDS = new Set(['stage', 'phase', 'subphase', 'phase1_revision', 'phase1_approved_revision', 'phase2_revision', 'phase2_approved_revision', 'execution_snapshot_revision', 'approved_revision', 'approved_by', 'approved_at', 'execution_authorized', 'last_gate_question_id', 'change_impact_level'])

function parseFrontmatterFromContent(content = '') {
  const match = String(content || '').match(/^---\n([\s\S]*?)\n---\n?/)
  if (!match) return {}
  return Object.fromEntries(match[1].split(/\r?\n/).filter(Boolean).map((line) => {
    const index = line.indexOf(':')
    if (index === -1) return null
    const key = line.slice(0, index).trim()
    const raw = line.slice(index + 1).trim()
    try {
      return [key, JSON.parse(raw)]
    } catch {
      return [key, raw]
    }
  }).filter(Boolean))
}

function extractGateFieldSubset(frontmatter = {}) {
  return Object.fromEntries([...PROJECT_GATE_FIELDS].map((key) => [key, frontmatter[key] ?? null]))
}

function assertPlanningProjectGateFieldsUnchanged(projectFilePath, args = {}) {
  const current = withProjectDefaults(readProjectState(projectFilePath).frontmatter)
  const currentSubset = extractGateFieldSubset(current)
  if (typeof args.content === 'string' || typeof args.text === 'string') {
    const nextFrontmatter = withProjectDefaults(parseFrontmatterFromContent(args.content || args.text || ''))
    const nextSubset = extractGateFieldSubset(nextFrontmatter)
    if (JSON.stringify(currentSubset) !== JSON.stringify(nextSubset)) {
      throw new Error('Planning mode denies direct gate-field edits in project.md; use question-tool approval flow')
    }
  }
  const editSignal = `${args.oldString || ''}\n${args.newString || ''}`
  if ([...PROJECT_GATE_FIELDS].some((key) => editSignal.includes(`${key}:`))) {
    throw new Error('Planning mode denies direct gate-field edits in project.md; use question-tool approval flow')
  }
}
function extractTaskBindingFromArgs(args = {}) {
  const direct = normalizeTaskID(args.taskID || args.taskId || args.task_id)
  if (direct) return direct
  for (const source of [args.prompt, args.description]) {
    if (typeof source !== 'string') continue
    const match = source.match(/(?:task[_\s-]*id\s*[:=]\s*|\b)(T[\w.-]+)/i)
    if (match?.[1]) return match[1]
  }
  return null
}

function resolveGatePhase(gate, currentPhase) {
  if (gate === 'phase2') return 'phase2_tasks'
  if (gate === 'execution') return 'phase3_execution'
  return currentPhase || 'phase1_discovery'
}

function isObviousMutatingShellCommand(command = '') {
  return /(^|[;&|])\s*(touch|rm|mv|cp|mkdir|rmdir|chmod|chown|truncate|tee)\b/i.test(command) || />\s*[^\s]/.test(command) || /\b(sudo\s+)?(npm|pnpm|yarn|bun|node|python|pytest|vitest|jest|mocha|tap)\b/.test(command) && /\b(install|add|remove|uninstall|publish|deploy|build|clean)\b/i.test(command)
}

export const PlanningFilesPlugin = async ({ directory }) => {
  const configRoot = getConfigRoot(); const configPath = path.join(configRoot, 'yak.jsonc'); const repoRoot = findNearestGitRoot(directory || process.cwd())
  const globalConfig = readJsoncFile(configPath, {}); const legacyGlobalPath = path.join(configRoot, 'oh-my-opencode-slim.json'); const legacyGlobalConfig = readJsonFile(legacyGlobalPath, {})
  const projectConfigPath = repoRoot ? [path.join(repoRoot, '.opencode', 'yak.jsonc')].find((candidate) => fs.existsSync(candidate)) : null
  const projectConfig = projectConfigPath ? (projectConfigPath.endsWith('.jsonc') ? readJsoncFile(projectConfigPath, {}) : readJsonFile(projectConfigPath, {})) : {}
  const legacyProjectConfigPath = repoRoot ? [path.join(repoRoot, '.opencode', 'oh-my-opencode-slim.jsonc'), path.join(repoRoot, '.opencode', 'oh-my-opencode-slim.json')].find((candidate) => fs.existsSync(candidate)) : null
  const legacyProjectConfig = legacyProjectConfigPath ? (legacyProjectConfigPath.endsWith('.jsonc') ? readJsoncFile(legacyProjectConfigPath, {}) : readJsonFile(legacyProjectConfigPath, {})) : {}
  const planning = mergeConfig(BUILTIN_WORKFLOW.workflow, readWorkflowShape(legacyGlobalConfig)); Object.assign(planning, mergeConfig(planning, readWorkflowShape(legacyProjectConfig))); Object.assign(planning, mergeConfig(planning, readWorkflowShape(globalConfig))); Object.assign(planning, mergeConfig(planning, readWorkflowShape(projectConfig)))
  const pluginDir = getModuleDir(); const templates = loadTemplates(pluginDir); const runtimeSessions = new Map(); const staleAfterMs = getStaleAfterMs(planning, 5 * 60 * 1000)
  const recordTaskStageScriptPath = path.resolve(pluginDir, '..', 'scripts', 'record-task-stage.mjs')
  function planningRootFor(rootDir) { return path.join(rootDir, planning.root || '.agents/yak/projects') }
  function projectRoot() { return planningRootFor(repoRoot) }
  function ensureProject(slug) { const projectSlug = sanitizeProjectSlug(slug); const projectDir = ensureProjectArtifacts({ rootDir: repoRoot, projectSlug, templates }).projectDir; writeActiveProjectSlug(repoRoot, projectSlug); writeLease(path.join(projectRoot(), 'repo-write-lease.json'), buildRepoWriteLeaseMetadata({ sessionID: projectSlug, ownerID: `orchestrator-${process.pid}`, leaseID: `lease-${projectSlug}`, repoRoot, staleAfterMs })); return { projectSlug, projectDir } }
  function bootstrapProject(slug) { const projectSlug = sanitizeProjectSlug(slug); const projectDir = bootstrapProjectArtifacts({ rootDir: repoRoot, projectSlug, templates }).projectDir; writeActiveProjectSlug(repoRoot, projectSlug); writeLease(path.join(projectRoot(), 'repo-write-lease.json'), buildRepoWriteLeaseMetadata({ sessionID: projectSlug, ownerID: `orchestrator-${process.pid}`, leaseID: `lease-${projectSlug}`, repoRoot, staleAfterMs })); return { projectSlug, projectDir } }
  function bindProject(opencodeSessionID, projectSlug, options = {}) {
    const projectDir = getProjectDir(repoRoot, projectSlug)
    const existing = runtimeSessions.get(opencodeSessionID)
    runtimeSessions.set(opencodeSessionID, {
      opencode_session_id: opencodeSessionID,
      active_project_slug: sanitizeProjectSlug(projectSlug),
      project_dir: projectDir,
      repo_root: repoRoot,
      role: options.role || 'orchestrator',
      bound_task_id: normalizeTaskID(options.boundTaskID) || existing?.bound_task_id || null,
      pending_child_task_ids: existing?.pending_child_task_ids || [],
      pending_questions: existing?.pending_questions || new Map(),
      processed_freeform_questions: existing?.processed_freeform_questions || new Set(),
    })
    return runtimeSessions.get(opencodeSessionID)
  }
  function normalizeLegacyProjectStage(projectFilePath) {
    const { frontmatter } = readProjectState(projectFilePath)
    if (frontmatter.stage !== 'quarantined') return frontmatter
    recoverProjectState({ repoRoot, projectDir: path.dirname(projectFilePath) })
    return readProjectState(projectFilePath).frontmatter
  }
  function bootstrapRuntimeSession(opencodeSessionID) { if (!repoRoot) return null; const existing = runtimeSessions.get(opencodeSessionID); if (existing) return existing; const projects = listProjects(repoRoot); const defaultSlug = getDefaultProjectSlug(repoRoot); if (projects.length === 0) { const created = bootstrapProject(defaultSlug); migrateProjectFrontmatter({ projectDir: created.projectDir }); return bindProject(opencodeSessionID, created.projectSlug) } if (projects.length === 1) { const slug = projects[0]; if (!hasCanonicalProjectArtifacts(repoRoot, slug)) ensureProject(slug); writeActiveProjectSlug(repoRoot, slug); const projectDir = getProjectDir(repoRoot, slug); migrateProjectFrontmatter({ projectDir }); const projectFilePath = getProjectFilePath(projectDir, 'project.md'); normalizeLegacyProjectStage(projectFilePath); return bindProject(opencodeSessionID, slug) } const activeSlug = readActiveProjectSlug(repoRoot); if (activeSlug && projectExists(repoRoot, activeSlug)) { if (!hasCanonicalProjectArtifacts(repoRoot, activeSlug)) ensureProject(activeSlug); const projectDir = getProjectDir(repoRoot, activeSlug); migrateProjectFrontmatter({ projectDir }); const projectFilePath = getProjectFilePath(projectDir, 'project.md'); normalizeLegacyProjectStage(projectFilePath); return bindProject(opencodeSessionID, activeSlug) } throw new Error('Multiple projects exist; explicit project selection required') }
  function inheritRuntimeSession(opencodeSessionID, parentSessionID, childInfo = {}) {
    const parent = runtimeSessions.get(parentSessionID)
    if (!parent) return null
    const boundTaskID = normalizeTaskID(childInfo.taskID || childInfo.taskId || childInfo.task_id) || parent.pending_child_task_ids.shift() || parent.bound_task_id || null
    return bindProject(opencodeSessionID, parent.active_project_slug, { role: 'worker', boundTaskID })
  }
  function rememberPendingTaskBinding(runtimeSession, args = {}) {
    const taskID = extractTaskBindingFromArgs(args)
    if (!taskID) return
    runtimeSession.pending_child_task_ids.push(taskID)
  }
  function loadActiveTaskPolicy(projectDir, frontmatter, runtimeSession) {
    const activeTasks = Array.isArray(frontmatter.active_tasks) ? frontmatter.active_tasks : []
    const taskID = runtimeSession?.bound_task_id || activeTasks[0]
    if (!taskID) throw new Error('Implementation mode requires a bound task; reopen execution approval before dispatching workers')
    const snapshotPath = getExecutionSnapshotPath(projectDir)
    if (fs.existsSync(snapshotPath)) {
      const snapshot = readTaskPlan(snapshotPath).frontmatter || {}
      const approvedTaskIDs = Array.isArray(snapshot.approved_task_ids) ? snapshot.approved_task_ids : []
      if (approvedTaskIDs.length > 0 && !approvedTaskIDs.includes(taskID)) {
        throw new Error(`Task ${taskID} not approved in execution snapshot`)
      }
    }
    const taskPath = path.join(projectDir, 'tasks', `${taskID}.md`)
    const { frontmatter: taskFrontmatter } = readTaskPlan(taskPath)
    const parsed = parseTaskFrontmatter(taskFrontmatter)
    return {
      ...parsed,
      taskPath,
      writeRoots: [repoRoot, ...normalizeAllowedPaths(repoRoot, parsed.allowedEphemeralPaths)],
      protectedPaths: normalizeAllowedPaths(repoRoot, [...parsed.protectedPaths, path.relative(repoRoot, projectDir), '.agents']),
      expectedPaths: normalizeAllowedPaths(repoRoot, parsed.expectedPaths),
      allowedEphemeralPaths: normalizeAllowedPaths(repoRoot, parsed.allowedEphemeralPaths),
    }
  }
  function refreshProjectContextForSession(sessionID) { const runtimeSession = runtimeSessions.get(sessionID) || bootstrapRuntimeSession(sessionID); if (!runtimeSession) return null; return refreshProjectContext({ repoRoot, projectDir: runtimeSession.project_dir }) }
  function readTaskFrontmatterSafely(projectDir, taskID) {
    if (!projectDir || !taskID) return null
    const taskPath = path.join(projectDir, 'tasks', `${taskID}.md`)
    if (!fs.existsSync(taskPath)) return null
    try {
      const { frontmatter } = readTaskPlan(taskPath)
      return frontmatter || null
    } catch {
      return null
    }
  }
  function resolveTaskModelForSession(sessionID, explicitTaskID) {
    const runtimeSession = runtimeSessions.get(sessionID) || bootstrapRuntimeSession(sessionID)
    if (!runtimeSession) return null
    const projectFilePath = getProjectFilePath(runtimeSession.project_dir, 'project.md')
    const { frontmatter } = readProjectState(projectFilePath)
    const taskID = explicitTaskID || runtimeSession.bound_task_id || (Array.isArray(frontmatter.active_tasks) ? frontmatter.active_tasks[0] : null)
    const taskFrontmatter = readTaskFrontmatterSafely(runtimeSession.project_dir, taskID) || {}
    const plan = resolveTaskModel({ task: taskFrontmatter, workflow: planning })
    return { taskID, plan, projectDir: runtimeSession.project_dir }
  }
  function getDispatchPlanForSession(sessionID, explicitTaskID) {
    const context = resolveTaskModelForSession(sessionID, explicitTaskID)
    if (!context) return null
    const effective = context.plan?.primary || null
    return {
      taskID: context.taskID,
      effective,
      degradedFrom: context.plan?.chain?.[0] || null,
      chain: context.plan?.chain || [],
      unresolved: Boolean(context.plan?.unresolved),
    }
  }
  function recordTaskModelDispatchForSession(sessionID, { taskID, effective, degradedFrom, reason } = {}) {
    const runtimeSession = runtimeSessions.get(sessionID) || bootstrapRuntimeSession(sessionID)
    if (!runtimeSession) return null
    const finalTaskID = taskID || runtimeSession.bound_task_id
    if (!finalTaskID) return null
    const taskPath = path.join(runtimeSession.project_dir, 'tasks', `${finalTaskID}.md`)
    if (!fs.existsSync(taskPath)) return null
    const current = readTaskPlan(taskPath).frontmatter || {}
    const nextEffective = effective ? { preset: effective.presetName || null, provider: effective.provider || null, model: effective.model || null, variant: effective.variant || null } : null
    const nextDegradedFrom = degradedFrom ? { preset: degradedFrom.presetName || null, provider: degradedFrom.provider || null, model: degradedFrom.model || null, variant: degradedFrom.variant || null, reason: reason || 'unknown' } : null
    const currentEffective = current.effective_model || null
    const currentDegraded = current.degraded_from || null
    const shouldWrite = JSON.stringify(currentEffective) !== JSON.stringify(nextEffective) || JSON.stringify(currentDegraded) !== JSON.stringify(nextDegradedFrom)
    if (shouldWrite) recordTaskModelOutcome(taskPath, { effective, degradedFrom, reason })
    const description = describeDegradation({ degradedFrom, effective, reason })
    const progressKey = `${finalTaskID}:${description?.from.preset || description?.from.provider || ''}->${description?.to.preset || description?.to.provider || ''}:${description?.reason || reason || ''}`
    if (description && runtimeSession.last_model_progress_key !== progressKey) {
      const progressPath = getProjectFilePath(runtimeSession.project_dir, 'progress.md')
      const stamp = new Date().toISOString()
      const line = `- ${stamp} Task ${finalTaskID} model degraded from ${description.from.preset || description.from.provider + '/' + description.from.model} to ${description.to.preset || description.to.provider + '/' + description.to.model} (reason: ${description.reason})`
      try {
        fs.appendFileSync(progressPath, `\n${line}\n`)
        runtimeSession.last_model_progress_key = progressKey
      } catch {}
    }
    if (degradedFrom) refreshDegradationSummaryForSession(sessionID)
    return { taskID: finalTaskID, effective, degradedFrom, reason }
  }
  function refreshDegradationSummaryForSession(sessionID) {
    const runtimeSession = runtimeSessions.get(sessionID) || bootstrapRuntimeSession(sessionID)
    if (!runtimeSession) return { changed: false, reviewsPath: null, events: [] }
    const events = summarizeDegradations({ projectDir: runtimeSession.project_dir })
    const result = writeReviewsDegradationSection({ projectDir: runtimeSession.project_dir, events })
    return { ...result, events }
  }
  function advanceTaskModelForSession(sessionID, { taskID, failedPresetName, reason }) {
    const context = resolveTaskModelForSession(sessionID, taskID)
    if (!context || !context.plan || context.plan.unresolved) return { next: null, exhausted: true, degradedFrom: null, reason: reason || 'unresolved', taskID: context?.taskID || taskID || null }
    const outcome = advanceFallback(context.plan, { failedPresetName, reason })
    if (outcome.next) {
      recordTaskModelDispatchForSession(sessionID, {
        taskID: context.taskID,
        effective: outcome.next,
        degradedFrom: outcome.degradedFrom,
        reason,
      })
    }
    return { ...outcome, taskID: context.taskID }
  }
  function offerPlanCriticForSession(sessionID, options = {}) {
    const runtimeSession = runtimeSessions.get(sessionID) || bootstrapRuntimeSession(sessionID)
    if (!runtimeSession) return { available: false, target: null, prompt: null, reason: 'no_session' }
    const projectFilePath = getProjectFilePath(runtimeSession.project_dir, 'project.md')
    const { frontmatter } = readProjectState(projectFilePath)
    const forced = Boolean(options.force)
    if (!forced && !(frontmatter.phase === 'phase1_discovery' && frontmatter.subphase === 'critic_offer')) {
      return { available: false, target: null, prompt: null, reason: 'not_at_phase1_critic_offer' }
    }
    const target = choosePlanCriticTarget({ orchestratorProvider: options.orchestratorProvider || 'openai', candidates: [], workflow: planning })
    if (!target) return { available: false, target: null, prompt: null, reason: 'no_critic_target' }
    const planProvider = options.planProvider || frontmatter.plan_provider || frontmatter.effective_provider || frontmatter.authoring_provider || null
    const planModel = options.planModel || frontmatter.plan_model || frontmatter.effective_model?.model || null
    return { available: true, target, prompt: buildPlanCriticPrompt({ planProvider, planModel, criticProvider: target.provider, criticModel: target.model }), reason: 'offered' }
  }
  function recordTaskStageForSession(sessionID, { taskID, stage, note } = {}) {
    const runtimeSession = runtimeSessions.get(sessionID) || bootstrapRuntimeSession(sessionID)
    if (!runtimeSession) return null
    const finalTaskID = taskID || runtimeSession.bound_task_id
    if (!finalTaskID) throw new Error('recordTaskStageForSession requires taskID or bound task')
    return recordTaskStage({ projectDir: runtimeSession.project_dir, taskId: finalTaskID, stage, note })
  }
  function recordPlanCriticResultForSession(sessionID, { verdict, summary, target } = {}) {
    const runtimeSession = runtimeSessions.get(sessionID) || bootstrapRuntimeSession(sessionID)
    if (!runtimeSession) return null
    const projectFilePath = getProjectFilePath(runtimeSession.project_dir, 'project.md')
    const nextTarget = target || choosePlanCriticTarget({ orchestratorProvider: 'openai', candidates: [], workflow: planning })
    updateMarkdownFrontmatter(projectFilePath, ({ frontmatter, body }) => ({ frontmatter: { ...withProjectDefaults(frontmatter), critic_status: verdict || 'recorded' }, body }))
    const stamp = new Date().toISOString()
    const line = `- ${stamp} Plan critic ${verdict || 'recorded'}${nextTarget?.provider ? ` via ${nextTarget.provider}/${nextTarget.model || ''}` : ''}${summary ? `: ${summary}` : ''}`
    try { appendProgress(getProjectFilePath(runtimeSession.project_dir, 'progress.md'), [line]) } catch {}
    return { verdict: verdict || 'recorded', summary: summary || null, target: nextTarget || null }
  }
  function skipPlanCriticForSession(sessionID, { reason } = {}) {
    const runtimeSession = runtimeSessions.get(sessionID) || bootstrapRuntimeSession(sessionID)
    if (!runtimeSession) return null
    const projectFilePath = getProjectFilePath(runtimeSession.project_dir, 'project.md')
    updateMarkdownFrontmatter(projectFilePath, ({ frontmatter, body }) => ({ frontmatter: { ...withProjectDefaults(frontmatter), critic_status: 'skipped' }, body }))
    const stamp = new Date().toISOString()
    const line = `- ${stamp} Plan critic skipped${reason ? `: ${reason}` : ''}`
    try { appendProgress(getProjectFilePath(runtimeSession.project_dir, 'progress.md'), [line]) } catch {}
    return { skipped: true, reason: reason || null }
  }
  return { offerPlanCriticForSession, recordPlanCriticResultForSession, skipPlanCriticForSession, recordTaskStageForSession, refreshDegradationSummaryForSession, event: async ({ event }) => {
    if (!planning.enabled || !repoRoot) return; const opencodeSessionID = event.properties?.sessionID || event.properties?.info?.id || event.properties?.id
    if (event.type === 'session.created') { if (!opencodeSessionID) return; const parentID = event.properties?.info?.parentID; if (parentID && inheritRuntimeSession(opencodeSessionID, parentID, event.properties?.info || {})) return; bootstrapRuntimeSession(opencodeSessionID); return }
    if (event.type === 'session.deleted') { if (!opencodeSessionID) return; runtimeSessions.delete(opencodeSessionID); return }
    if (event.type === 'question.asked') {
      const runtimeSession = runtimeSessions.get(opencodeSessionID) || bootstrapRuntimeSession(opencodeSessionID)
      if (!runtimeSession || runtimeSession.role !== 'orchestrator') return
      const candidate = rememberQuestionRequest(runtimeSession, event.properties || {})
      if (!candidate) return
      const projectFilePath = getProjectFilePath(runtimeSession.project_dir, 'project.md')
      const { frontmatter } = readProjectState(projectFilePath)
      const gateRequest = detectGateRequest(candidate, frontmatter)
      if (gateRequest) {
        setProjectPhase(projectFilePath, {
          phase: resolveGatePhase(gateRequest.gate, frontmatter.phase),
          subphase: gateRequest.subphase,
          stage: 'awaiting_approval',
        })
      }
      return
    }
    if (event.type === 'question.replied') {
      const runtimeSession = runtimeSessions.get(opencodeSessionID) || bootstrapRuntimeSession(opencodeSessionID)
      if (!runtimeSession || runtimeSession.role !== 'orchestrator') return
      const candidate = runtimeSession.pending_questions.get(event.properties?.requestID)
      if (!candidate) return
      const projectFilePath = getProjectFilePath(runtimeSession.project_dir, 'project.md')
      const { frontmatter } = readProjectState(projectFilePath)
      const gateApproval = detectGateApproval(candidate, event.properties?.answers || [], frontmatter)
      if (gateApproval) {
        const next = recordGateApproval(projectFilePath, { gate: gateApproval.gate, requestID: event.properties?.requestID })
        if (gateApproval.gate === 'execution') {
          const approvedTaskIDs = next.frontmatter.approved_task_ids.length ? next.frontmatter.approved_task_ids : next.frontmatter.active_tasks
          writeExecutionSnapshot(runtimeSession.project_dir, {
            snapshot_revision: next.frontmatter.execution_snapshot_revision,
            phase2_approved_revision: next.frontmatter.phase2_approved_revision,
            approved_task_ids: approvedTaskIDs,
            blocked_task_ids: next.frontmatter.blocked_task_ids,
            authorized_by_question_id: event.properties?.requestID,
          }, approvedTaskIDs.map((taskID) => `- ${taskID}`).join('\n'))
        }
      }
      recordQuestionResolution({ projectDir: runtimeSession.project_dir, candidate, answers: event.properties?.answers || [] })
      clearQuestionRequest(runtimeSession, event.properties?.requestID)
      return
    }
    if (event.type === 'question.rejected') { const runtimeSession = runtimeSessions.get(opencodeSessionID) || bootstrapRuntimeSession(opencodeSessionID); if (!runtimeSession || runtimeSession.role !== 'orchestrator') return; clearQuestionRequest(runtimeSession, event.properties?.requestID); return }
  }, refreshProjectContextForSession, resolveTaskModelForSession, getDispatchPlanForSession, stampTaskContract, recordTaskModelDispatchForSession, advanceTaskModelForSession, 'permission.ask': async (input, output) => {
    if (!planning.enabled || !repoRoot) return
    const runtimeSession = runtimeSessions.get(input.sessionID) || bootstrapRuntimeSession(input.sessionID)
    if (!runtimeSession) return
    const permissionArgs = { ...(input.args || {}), ...(input.command ? { command: input.command } : {}) }
    if (runtimeSession.role === 'orchestrator' && (input.tool === 'bash' || input.tool === 'shell')) {
      const command = permissionArgs.command || ''
      if (isBlockedOrchestratorShellCommand(command)) output.status = 'deny'
    }
  }, 'tool.execute.before': async (input, output) => {
    if (!planning.enabled || !repoRoot) return
    const args = { ...(input.args || {}), ...(output.args || {}) }
    const runtimeSession = runtimeSessions.get(input.sessionID) || bootstrapRuntimeSession(input.sessionID)
    if (!runtimeSession) return
    const projectFilePath = getProjectFilePath(runtimeSession.project_dir, 'project.md')
    const { frontmatter } = readProjectState(projectFilePath)
    const stage = frontmatter.stage || 'planning'
    if (runtimeSession.role === 'orchestrator' && (input.tool === 'task' || input.tool === 'background_task')) rememberPendingTaskBinding(runtimeSession, args)
    if (isPlanningStage(stage) && ['write', 'edit'].includes(input.tool)) {
      for (const candidatePath of extractCandidatePaths(args)) {
        if (path.basename(candidatePath) === 'project.md' || path.resolve(candidatePath) === path.resolve(projectFilePath)) {
          assertPlanningProjectGateFieldsUnchanged(projectFilePath, args)
        }
      }
    }
    if (runtimeSession.role === 'orchestrator') {
      if (input.tool === 'bash' || input.tool === 'shell') {
        const command = args.command || ''
        if (isBlockedOrchestratorShellCommand(command)) throw new Error('Planning mode denies mutating or unknown shell forms')
        return
      }
      if (['write', 'edit', 'lsp_rename', 'ast_grep_replace'].includes(input.tool)) {
        for (const candidatePath of extractCandidatePaths(args)) {
          assertOrchestratorControlWriteAllowed({ repoRoot, projectDir: runtimeSession.project_dir, filePath: candidatePath, toolName: input.tool })
          if (isPlanningStage(stage) && (path.basename(candidatePath) === 'project.md' || path.resolve(candidatePath) === path.resolve(projectFilePath)) && ['write', 'edit'].includes(input.tool)) {
            assertPlanningProjectGateFieldsUnchanged(projectFilePath, args)
          }
        }
        return
      }
      if (input.tool === 'mkdir') {
        for (const candidatePath of extractCandidatePaths(args)) assertOrchestratorControlMkdirAllowed({ repoRoot, projectDir: runtimeSession.project_dir, dirPath: candidatePath })
        return
      }
      if (input.tool === 'apply_patch') {
        const patchText = args.patchText || args.patch || args.content || args.text || ''
        assertApplyPatchAllowedForOrchestrator({ repoRoot, projectDir: runtimeSession.project_dir, patchText })
        return
      }
      if (input.tool === 'rm') {
        for (const candidatePath of extractCandidatePaths(args)) assertOrchestratorControlWriteAllowed({ repoRoot, projectDir: runtimeSession.project_dir, filePath: candidatePath, toolName: input.tool })
        return
      }
    }
    if (isPlanningStage(stage)) {
      if (input.tool === 'bash' || input.tool === 'shell') {
        const command = args.command || ''
        if (hasForbiddenShellSyntax(command) || (!(isAllowedTestRunnerCommand(command) || isAllowedReadonlyShell(command, planning.readonly_shell_allowlist || [])) || isObviousMutatingShellCommand(command))) throw new Error('Planning mode denies mutating or unknown shell forms')
        return
      }
      if (isDeniedPlanningTool(input.tool)) throw new Error(`Planning mode denies tool: ${input.tool}`)
      if (input.tool === 'mkdir') {
        const [targetPath] = extractCandidatePaths(args)
        if (!targetPath) throw new Error('Planning mode mkdir requires explicit target path')
        const resolved = ensureInsideRoot(repoRoot, targetPath)
        const relative = path.relative(runtimeSession.project_dir, resolved)
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Planning mode mkdir limited to active project dir')
        return
      }
      if (['write', 'edit'].includes(input.tool)) {
        for (const candidatePath of extractCandidatePaths(args)) {
          const resolved = assertPlanningWriteAllowed({ repoRoot, projectDir: runtimeSession.project_dir, filePath: candidatePath })
        }
        return
      }
      if (isMutatingTool(input.tool)) throw new Error(`Planning mode denies mutating tool: ${input.tool}`)
      return
    }
    if (!isOpenStage(stage)) {
      if (isMutatingTool(input.tool)) throw new Error(`Stage ${stage} denies mutating tool: ${input.tool}`)
      return
    }
    const taskPolicy = loadActiveTaskPolicy(runtimeSession.project_dir, frontmatter, runtimeSession); if (input.tool === 'bash' || input.tool === 'shell') { const command = args.command || ''; assertTaskShellAllowed(command, taskPolicy.allowedShellCommands); return } if (['write', 'edit'].includes(input.tool)) { if (runtimeSession.role !== 'worker') { for (const candidatePath of extractCandidatePaths(args)) assertOrchestratorControlWriteAllowed({ repoRoot, projectDir: runtimeSession.project_dir, filePath: candidatePath, toolName: input.tool }); return } for (const candidatePath of extractCandidatePaths(args)) assertTaskWriteAllowed({ repoRoot, allowedPaths: taskPolicy.writeRoots, forbiddenPaths: taskPolicy.protectedPaths, filePath: candidatePath }); return } if (input.tool === 'mkdir') { if (runtimeSession.role !== 'worker') { for (const candidatePath of extractCandidatePaths(args)) assertOrchestratorControlMkdirAllowed({ repoRoot, projectDir: runtimeSession.project_dir, dirPath: candidatePath }); return } for (const candidatePath of extractCandidatePaths(args)) assertTaskWriteAllowed({ repoRoot, allowedPaths: taskPolicy.writeRoots, forbiddenPaths: taskPolicy.protectedPaths, filePath: candidatePath }); return } if (input.tool === 'apply_patch') { const patchText = args.patchText || args.patch || args.content || args.text || ''; if (runtimeSession.role !== 'worker') { assertApplyPatchAllowedForOrchestrator({ repoRoot, projectDir: runtimeSession.project_dir, patchText }); return } assertApplyPatchAllowedForWorker({ repoRoot, allowedPaths: taskPolicy.writeRoots, forbiddenPaths: taskPolicy.protectedPaths, patchText }); return } if (input.tool === 'rm') { if (runtimeSession.role !== 'worker') throw new Error('Implementation mode denies rm for orchestrator sessions'); for (const candidatePath of extractCandidatePaths(args)) assertTaskWriteAllowed({ repoRoot, allowedPaths: taskPolicy.writeRoots, forbiddenPaths: taskPolicy.protectedPaths, filePath: candidatePath }); return } if (input.tool === 'lsp_rename') { if (runtimeSession.role !== 'worker') throw new Error('Implementation mode denies lsp_rename for orchestrator sessions outside Yak control files'); const filePath = args.filePath || args.path; if (!filePath) throw new Error('lsp_rename requires explicit filePath'); assertTaskWriteAllowed({ repoRoot, allowedPaths: taskPolicy.writeRoots, forbiddenPaths: taskPolicy.protectedPaths, filePath: path.resolve(repoRoot, filePath) }); return } if (input.tool === 'ast_grep_replace') { if (runtimeSession.role !== 'worker') throw new Error('Implementation mode denies ast_grep_replace for orchestrator sessions outside Yak control files'); assertScopedToolAllowed({ repoRoot, allowedPaths: taskPolicy.writeRoots, forbiddenPaths: taskPolicy.protectedPaths, targets: extractScopedToolTargets(args), toolName: 'ast_grep_replace' }); return }
  }, 'experimental.chat.messages.transform': async (_input, output) => {
    if (!planning.enabled || !repoRoot) return
    const messages = Array.isArray(output.messages) ? output.messages : []
    if (messages.length < 2) return
    const latestUserIndex = [...messages].map((entry, index) => ({ entry, index })).reverse().find(({ entry }) => entry?.info?.role === 'user')?.index
    if (latestUserIndex == null || latestUserIndex <= 0) return
    const latestUser = messages[latestUserIndex]
    const runtimeSession = runtimeSessions.get(latestUser?.info?.sessionID) || bootstrapRuntimeSession(latestUser?.info?.sessionID)
    if (!runtimeSession || runtimeSession.role !== 'orchestrator') return
    const previousAssistant = [...messages.slice(0, latestUserIndex)].reverse().find((entry) => entry?.info?.role === 'assistant' && entry?.info?.sessionID === latestUser?.info?.sessionID)
    if (!previousAssistant) return
    const assistantText = extractTextFromParts(previousAssistant.parts)
    const answerText = extractTextFromParts(latestUser.parts)
    if (!looksLikeFreeformQuestion(assistantText) || !answerText) return
    const fingerprint = `${previousAssistant.info?.id || 'assistant'}:${latestUser.info?.id || 'user'}`
    if (runtimeSession.processed_freeform_questions.has(fingerprint)) return
    recordQuestionResolution({ projectDir: runtimeSession.project_dir, candidate: { requestID: fingerprint, text: assistantText, shortText: assistantText.length > 160 ? `${assistantText.slice(0, 157)}...` : assistantText }, answers: [[answerText]] })
    runtimeSession.processed_freeform_questions.add(fingerprint)
  }, 'experimental.chat.system.transform': async (input, output) => {
    if (!planning.enabled || !repoRoot || !input.sessionID) return
    const runtimeSession = runtimeSessions.get(input.sessionID)
    if (!runtimeSession) return
    const { frontmatter } = readProjectState(getProjectFilePath(runtimeSession.project_dir, 'project.md'))
    const chapterMap = ['scope', 'constraints', 'findings', 'decisions', 'task-dag', 'execution', 'reviews']
    output.system.push(`Yak navigator: end meaningful replies with compact phase summary. Current: ${frontmatter.phase}/${frontmatter.subphase}. Active tasks: ${(frontmatter.active_tasks || []).join(', ') || 'none'}. Open questions: ${(frontmatter.open_questions || []).join(', ') || 'none'}. Other plan chapters: ${chapterMap.join(', ')}.`)
    if (fs.existsSync(path.join(repoRoot, 'AGENTS.md'))) {
      output.system.push('Yak rule: read and follow repo-local AGENTS.md. Lower-level subagents inherit those restrictions unless task explicitly widens scope.')
    }
    if (runtimeSession.role === 'worker' && runtimeSession.bound_task_id) {
      output.system.push(`Yak worker binding: you are executing only task ${runtimeSession.bound_task_id}. Stay within approved task intent. If plan drift appears, stop and escalate.`)
    }
    output.system.push(`Yak task state: record every task stage transition with \`node ${recordTaskStageScriptPath} --task <T###> --stage <draft|ready|approved|dispatched|reported|validating|done|blocked|rework_required|rejected> [--note "<text>"]\`. Never mutate planning artifacts via shell rewrites, python, heredocs, or ad-hoc scripts.`)
    const targetTaskID = runtimeSession.bound_task_id || (Array.isArray(frontmatter.active_tasks) ? frontmatter.active_tasks[0] : null)
    if (targetTaskID) {
      const taskFrontmatter = readTaskFrontmatterSafely(runtimeSession.project_dir, targetTaskID)
      if (taskFrontmatter) {
        const plan = resolveTaskModel({ task: taskFrontmatter, workflow: planning })
        if (plan.primary) {
          const effective = plan.primary
          const chainSummary = plan.chain.map((entry) => entry.presetName || `${entry.provider}/${entry.model}`).join(' -> ')
          const sourceLabel = plan.source === 'override' ? 'override' : plan.source === 'domain' ? `domain=${taskFrontmatter.domain_hint}` : `default=${taskFrontmatter.role_hint || 'implementer'}/${taskFrontmatter.complexity || 'medium'}`
          output.system.push(`Yak model routing: task ${targetTaskID} resolved via ${sourceLabel} to preset ${effective.presetName || 'n/a'} (${effective.provider || '?'}/${effective.model || '?'}${effective.variant ? `:${effective.variant}` : ''}). Dispatch via subagent_type='${effective.subagentType || 'inherit'}'. Fallback chain: ${chainSummary}. On provider/model/variant unavailability, re-dispatch with next chain entry and record degradation.`)
        } else if (plan.unresolved) {
          output.system.push(`Yak model routing: task ${targetTaskID} unresolved (${plan.reason || 'no preset'}). Stop and ask user before dispatch.`)
        }
      }
    }
    if (!runtimeSession.pending_questions?.size) return
    output.system.push('Yak reminder: unresolved user question pending. Persist reusable answer into findings/context/progress before making status or next-step claims.')
  } }
}

const BUILTIN_WORKFLOW = {
  workflow: {
    enabled: true,
    root: '.agents/yak/projects',
    heartbeat_interval_ms: 5000,
    stale_after_ms: 30000,
    enforce_stage_gates: true,
    readonly_shell_allowlist: ['ls', 'find', 'rg', 'grep', 'cat', 'sed -n', 'git status', 'git diff --name-only'],
    task_complexity_routes: { low: 'orchestrator', medium: 'council:medium-review', high: 'oracle' },
    review_presets: { medium: 'medium-review', high: 'oracle-high-review' },
    session_naming: 'timestamp-slug-random6',
    repo_write_lease: true,
    model_presets: {
      'fixer':          { subagent_type: 'fixer',        provider: 'openai',    model: 'gpt-5.4-mini',           variant: 'low' },
      'fixer-mid':      { subagent_type: 'fixer',        provider: 'anthropic', model: 'claude-sonnet-4-5',      variant: 'low' },
      'fixer-hi':       { subagent_type: 'fixer',        provider: 'openai',    model: 'gpt-5.4',                variant: 'high' },
      'coder-hi':       { subagent_type: 'fixer',        provider: 'openai',    model: 'gpt-5.4',                variant: 'high' },
      'sonnet-impl':    { subagent_type: 'fixer',        provider: 'anthropic', model: 'claude-sonnet-4-5',      variant: 'medium' },
      'opus-impl':      { subagent_type: 'fixer',        provider: 'anthropic', model: 'claude-opus-4-7',        variant: 'max' },
      'orchestrator':   { subagent_type: 'orchestrator', provider: 'anthropic', model: 'claude-opus-4-7',        variant: 'max' },
      'oracle':         { subagent_type: 'oracle',       provider: 'openai',    model: 'gpt-5.4',                variant: 'xhigh' },
      'opus-review':    { subagent_type: 'oracle',       provider: 'anthropic', model: 'claude-opus-4-7',        variant: 'max' },
      'opus-critic':    { subagent_type: 'oracle',       provider: 'anthropic', model: 'claude-opus-4-7',        variant: 'max' },
      'explorer':       { subagent_type: 'explorer',     provider: 'openai',    model: 'gpt-5.4-mini',           variant: 'low' },
      'explorer-mid':   { subagent_type: 'explorer',     provider: 'openai',    model: 'gpt-5.4-mini',           variant: 'medium' },
      'explorer-hi':    { subagent_type: 'explorer',     provider: 'openai',    model: 'gpt-5.4',                variant: 'high' },
      'librarian':      { subagent_type: 'librarian',    provider: 'openai',    model: 'gpt-5.4-mini',           variant: 'low' },
      'librarian-mid':  { subagent_type: 'librarian',    provider: 'openai',    model: 'gpt-5.4-mini',           variant: 'medium' },
      'librarian-hi':   { subagent_type: 'librarian',    provider: 'openai',    model: 'gpt-5.4',                variant: 'high' },
      'designer':       { subagent_type: 'designer',     provider: 'google',    model: 'gemini-3.1-pro-preview', variant: 'high' },
    },
    model_routes: {
      implementer: { low: 'fixer',        medium: 'sonnet-impl',  high: 'opus-impl' },
      reviewer:    { low: 'orchestrator', medium: 'oracle',       high: 'opus-review' },
      critic:      { low: 'opus-critic',  medium: 'opus-critic',  high: 'opus-critic' },
      explorer:    { low: 'explorer',     medium: 'explorer-mid', high: 'explorer-hi' },
      librarian:   { low: 'librarian',    medium: 'librarian-mid',high: 'librarian-hi' },
      designer:    { low: 'designer',     medium: 'designer',     high: 'designer' },
      fixer:       { low: 'fixer',        medium: 'fixer-mid',    high: 'fixer-hi' },
    },
    domain_routes: {
      graphql:         'coder-hi',
      api:             'coder-hi',
      sql:             'coder-hi',
      infra:           'coder-hi',
      scripts:         'coder-hi',
      'planning-review': 'opus-critic',
      'plan-critic':   'opus-critic',
      ui:              'designer',
      design:          'designer',
      'ts-code':       'sonnet-impl',
      'js-code':       'sonnet-impl',
      refactor:        'sonnet-impl',
    },
    model_fallbacks: {
      'opus-impl':     ['opus-impl', 'sonnet-impl', 'coder-hi', 'fixer-mid', 'fixer'],
      'opus-review':   ['opus-review', 'oracle', 'orchestrator'],
      'opus-critic':   ['opus-critic', 'opus-review', 'oracle'],
      'oracle':        ['oracle', 'orchestrator'],
      'orchestrator':  ['orchestrator', 'fixer-hi', 'fixer'],
      'sonnet-impl':   ['sonnet-impl', 'coder-hi', 'fixer-mid', 'fixer'],
      'coder-hi':      ['coder-hi', 'sonnet-impl', 'fixer-mid', 'fixer'],
      'fixer-hi':      ['fixer-hi', 'coder-hi', 'fixer-mid', 'fixer'],
      'fixer-mid':     ['fixer-mid', 'fixer'],
      'fixer':         ['fixer', 'fixer-mid'],
      'explorer-hi':   ['explorer-hi', 'explorer-mid', 'explorer'],
      'explorer-mid':  ['explorer-mid', 'explorer'],
      'explorer':      ['explorer', 'explorer-mid'],
      'librarian-hi':  ['librarian-hi', 'librarian-mid', 'librarian'],
      'librarian-mid': ['librarian-mid', 'librarian'],
      'librarian':     ['librarian', 'librarian-mid'],
      'designer':      ['designer', 'orchestrator'],
    },
  },
}

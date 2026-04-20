import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  canEnterCompletedSession,
  canEnterValidatingSession,
  getExecutionSnapshotPath,
  isApprovedRevisionValid,
  recordGateApproval,
  recordTaskStage,
  refreshProjectContext,
  readMarkdownFrontmatter,
  reopenProjectPhase,
  resetTaskPlanApproval,
  setProjectPhase,
  setProjectStage,
  withProjectDefaults,
  writeReviewFile,
  writeExecutionSnapshot,
  writeMarkdownFrontmatter,
  writeTaskFile,
} from '../../yak/plugins/planning-files/session-store.js'

test('read and update task plan frontmatter', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-files-'))
  const file = path.join(dir, 'task_plan.md')

  writeMarkdownFrontmatter(file, {
    plan_revision: 2,
    approved_revision: 2,
    stage: 'planning',
    approved_by: null,
    approved_at: null,
  }, 'body')

  const loaded = readMarkdownFrontmatter(file)
  assert.equal(loaded.frontmatter.plan_revision, 2)
  assert.equal(isApprovedRevisionValid(loaded.frontmatter), true)

  setProjectStage(file, 'implementing')
  assert.equal(readMarkdownFrontmatter(file).frontmatter.stage, 'implementing')

  reopenProjectPhase(file, { phase: 'phase2_tasks', subphase: 'incident_review', reason: 'unsafe edit' })
  const reopened = readMarkdownFrontmatter(file).frontmatter
  assert.equal(reopened.stage, 'planning')
  assert.equal(reopened.phase, 'phase2_tasks')
  assert.equal(reopened.subphase, 'incident_review')
  assert.equal(reopened.approval_reset_reason, 'unsafe edit')

  resetTaskPlanApproval(file, 'sensitive edit')
  const reset = readMarkdownFrontmatter(file).frontmatter
  assert.equal(reset.plan_revision, 3)
  assert.equal(reset.approved_revision, null)
  assert.equal(reset.stage, 'awaiting_approval')
  assert.equal(isApprovedRevisionValid(reset), false)
})

test('project stage helpers reject unresolved and missing review cases', () => {
  assert.equal(canEnterValidatingSession(['implemented', 'rejected'], true), false)
  assert.equal(canEnterValidatingSession(['blocked'], true), false)
  assert.equal(canEnterValidatingSession(['implemented'], false), false)

  assert.equal(canEnterCompletedSession(['done', 'done'], true), true)
  assert.equal(canEnterCompletedSession(['completed', 'rejected'], true), false)
  assert.equal(canEnterCompletedSession(['blocked'], true), false)
  assert.equal(canEnterCompletedSession(['completed'], false), false)
})

test('write task file binds task and revision fields', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-files-'))
  const file = path.join(dir, 'task.md')

  writeTaskFile(file, {
    task_id: 'task-1',
    plan_revision: 4,
    approved_revision: 3,
    stage: 'draft',
    expected_paths: ['/tmp/a'],
    protected_paths: ['/tmp/private'],
    allowed_ephemeral_paths: [],
    allowed_shell_command_forms: [],
    required_for_acceptance: [],
    test_strategy: 'e2e',
  }, 'task body')

  const loaded = readMarkdownFrontmatter(file)
  assert.equal(loaded.frontmatter.task_id, 'task-1')
  assert.equal(loaded.frontmatter.plan_revision, 4)
  assert.equal(loaded.frontmatter.approved_revision, 3)
  assert.equal(loaded.frontmatter.stage, 'draft')
  assert.equal(loaded.frontmatter.test_strategy, 'e2e')
  assert.equal(loaded.body.trim(), 'task body')
})

test('project defaults, phase helpers, and execution snapshots are persisted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-files-'))
  const projectFile = path.join(dir, 'project.md')

  writeMarkdownFrontmatter(projectFile, { project_slug: 'alpha' }, 'project body')
  const loaded = readMarkdownFrontmatter(projectFile)
  assert.equal(withProjectDefaults(loaded.frontmatter).phase, 'phase1_discovery')

  setProjectPhase(projectFile, { phase: 'phase2_tasks', subphase: 'task_graph_draft', stage: 'planning' })
  let current = readMarkdownFrontmatter(projectFile).frontmatter
  assert.equal(current.phase, 'phase2_tasks')
  assert.equal(current.subphase, 'task_graph_draft')

  recordGateApproval(projectFile, { gate: 'phase2', requestID: 'q-phase2' })
  current = readMarkdownFrontmatter(projectFile).frontmatter
  assert.equal(current.phase, 'phase3_execution')
  assert.equal(current.subphase, 'execution_authorization')
  assert.equal(current.last_gate_question_id, 'q-phase2')

  writeExecutionSnapshot(dir, {
    snapshot_revision: 2,
    phase2_approved_revision: 1,
    approved_task_ids: ['T1', 'T2'],
    authorized_by_question_id: 'q-exec',
  }, '- T1\n- T2')

  const snapshot = readMarkdownFrontmatter(getExecutionSnapshotPath(dir))
  assert.equal(snapshot.frontmatter.snapshot_revision, 2)
  assert.deepEqual(snapshot.frontmatter.approved_task_ids, ['T1', 'T2'])
  assert.equal(snapshot.frontmatter.authorized_by_question_id, 'q-exec')
})

test('refreshProjectContext reads required project files and task files fresh', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-files-'))
  const projectDir = path.join(repoRoot, '.agents', 'yak', 'projects', 'alpha')
  fs.mkdirSync(path.join(projectDir, 'tasks'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'project.md'), '---\nactive_tasks: ["T1"]\n---\nproject body')
  fs.writeFileSync(path.join(projectDir, 'context.md'), 'context body')
  fs.writeFileSync(path.join(projectDir, 'tasks.md'), 'tasks body')
  fs.writeFileSync(path.join(projectDir, 'tasks', 'T1.md'), '---\ntask_id: "T1"\n---\ntask body')

  const snapshot = refreshProjectContext({ repoRoot, projectDir })
  assert.equal(snapshot.projectDir, projectDir)
  assert.ok(snapshot.files.project)
  assert.ok(snapshot.files.context)
  assert.ok(snapshot.files.tasks)
  assert.ok(snapshot.files.activeTasks[0])
  assert.equal(snapshot.files.project.frontmatter.active_tasks[0], 'T1')
  assert.equal(snapshot.files.activeTasks[0].frontmatter.task_id, 'T1')
  assert.ok(snapshot.freshness.project.mtimeMs > 0)
})

test('refreshProjectContext fails closed when canonical file missing', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-files-'))
  const projectDir = path.join(repoRoot, '.agents', 'yak', 'projects', 'alpha')
  fs.mkdirSync(projectDir, { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'project.md'), '---\nactive_tasks: ["T1"]\n---\nproject body')
  fs.writeFileSync(path.join(projectDir, 'tasks.md'), 'tasks body')

  assert.throws(() => refreshProjectContext({ repoRoot, projectDir }), /context\.md missing|required/i)
})

test('recordTaskStage updates task frontmatter, progress log, and tasks.md summary row', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-files-'))
  fs.mkdirSync(path.join(projectDir, 'tasks'))
  fs.writeFileSync(path.join(projectDir, 'progress.md'), '# Progress\n')
  fs.writeFileSync(path.join(projectDir, 'tasks.md'), [
    '# Tasks',
    '',
    '| id | title | status |',
    '| --- | --- | --- |',
    '| T1 | first | draft |',
    '| T2 | second | draft |',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(projectDir, 'tasks', 'T1.md'), '---\ntask_id: T1\nstage: approved\n---\n\nbody\n')

  const first = recordTaskStage({ projectDir, taskId: 'T1', stage: 'reported', note: 'suite green', now: Date.parse('2026-04-20T00:00:00Z') })
  assert.equal(first.previousStage, 'approved')
  assert.equal(first.stage, 'reported')
  assert.equal(first.stageChanged, true)
  assert.equal(first.appendedProgress, true)
  assert.equal(first.updatedSummary, true)

  const taskFrontmatter = readMarkdownFrontmatter(path.join(projectDir, 'tasks', 'T1.md')).frontmatter
  assert.equal(taskFrontmatter.stage, 'reported')
  assert.equal(taskFrontmatter.task_id, 'T1')

  const progress = fs.readFileSync(path.join(projectDir, 'progress.md'), 'utf8')
  assert.match(progress, /Task T1 stage approved -> reported: suite green/)

  const tasksBody = fs.readFileSync(path.join(projectDir, 'tasks.md'), 'utf8')
  assert.match(tasksBody, /\| T1 \| first \| reported \|/)
  assert.match(tasksBody, /\| T2 \| second \| draft \|/)

  const replay = recordTaskStage({ projectDir, taskId: 'T1', stage: 'reported' })
  assert.equal(replay.stageChanged, false)
  assert.equal(replay.appendedProgress, false)
})

test('recordTaskStage rejects unknown stages and missing task files', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-files-'))
  fs.mkdirSync(path.join(projectDir, 'tasks'))
  fs.writeFileSync(path.join(projectDir, 'progress.md'), '')
  fs.writeFileSync(path.join(projectDir, 'tasks', 'T1.md'), '---\ntask_id: T1\nstage: draft\n---\n')

  assert.throws(() => recordTaskStage({ projectDir, taskId: 'T1', stage: 'not-a-stage' }), /unknown stage/)
  assert.throws(() => recordTaskStage({ projectDir, taskId: 'Tmissing', stage: 'done' }), /Task file missing/)
  assert.throws(() => recordTaskStage({ projectDir, taskId: 'T1' }), /requires projectDir, taskId, stage/)
})

test('write review file binds task and revision fields', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-files-'))
  const file = path.join(dir, 'review.md')

  writeReviewFile(file, {
    task_id: 'task-2',
    plan_revision: 8,
    approved_revision: 7,
    reviewer: 'ops',
  }, 'review body')

  const loaded = readMarkdownFrontmatter(file)
  assert.equal(loaded.frontmatter.task_id, 'task-2')
  assert.equal(loaded.frontmatter.plan_revision, 8)
  assert.equal(loaded.frontmatter.approved_revision, 7)
  assert.equal(loaded.frontmatter.reviewer, 'ops')
  assert.equal(loaded.body.trim(), 'review body')
})

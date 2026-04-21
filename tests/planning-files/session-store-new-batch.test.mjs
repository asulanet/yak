import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  BatchCancelledError,
  IncompleteTasksError,
  STALE_TRANSITION_LOCK_MS,
  planTransition,
  readMarkdownFrontmatter,
  recoverInterruptedBatchTransition,
  startNewBatch,
  withProjectDefaults,
  writeMarkdownFrontmatter,
} from '../../yak/plugins/planning-files/session-store.js'

// --------------------------------------------------------------------------
// Fixture builder: a minimal Batch-1 project ready to transition.
// --------------------------------------------------------------------------

function seedProject({ tasks = [{ id: 'T001', stage: 'done' }], includeReviewsDir = false, includeBatchFields = true } = {}) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-new-batch-'))
  const projectDir = path.join(tmpRoot, '.agents', 'yak', 'projects', 'demo')
  fs.mkdirSync(path.join(projectDir, 'tasks'), { recursive: true })
  // project.md
  const frontmatter = {
    project_slug: 'demo',
    project_dir: projectDir,
    stage: 'implementing',
    phase: 'phase3_execution',
    subphase: 'dispatch',
    phase1_revision: 1,
    phase1_approved_revision: 1,
    phase2_revision: 2,
    phase2_approved_revision: 2,
    execution_snapshot_revision: 1,
    plan_revision: 2,
    approved_revision: 2,
    approved_by: 'question-tool',
    approved_at: '2026-04-20T00:00:00.000Z',
    approved_task_ids: tasks.map((t) => t.id),
    draft_task_ids: [],
    blocked_task_ids: [],
    active_tasks: [],
    open_questions: ['Q1: carried over for demo'],
    research_mode: 'brief',
    critic_status: 'completed',
    execution_authorized: true,
    last_gate_question_id: 'que_seed',
    change_impact_level: 'local',
    completed_task_ids: tasks.filter((t) => t.stage === 'done').map((t) => t.id),
    approval_reset_reason: 'seed reset',
  }
  if (includeBatchFields) {
    frontmatter.current_batch = 1
    frontmatter.batches_completed = []
    frontmatter.batch_started_at = null
  }
  writeMarkdownFrontmatter(path.join(projectDir, 'project.md'), frontmatter, '# Project\n\n## Summary\n\ndemo\n')

  // Tasks
  for (const t of tasks) {
    fs.writeFileSync(path.join(projectDir, 'tasks', `${t.id}.md`),
      `---\ntask_id: "${t.id}"\nstage: "${t.stage}"\nplan_revision: 1\napproved_revision: 1\n---\n\n# ${t.id}\n`)
  }

  // tasks.md summary
  fs.writeFileSync(path.join(projectDir, 'tasks.md'),
    `---\nproject_slug: demo\ntask_graph_revision: 1\n---\n\n# Tasks\n\n| id | status |\n| --- | --- |\n${tasks.map((t) => `| ${t.id} | ${t.stage} |`).join('\n')}\n`)

  // execution-snapshot.md
  fs.writeFileSync(path.join(projectDir, 'execution-snapshot.md'),
    `---\nsnapshot_revision: 1\napproved_task_ids: ${JSON.stringify(tasks.map((t) => t.id))}\n---\n\nsnapshot\n`)

  // reviews.md
  fs.writeFileSync(path.join(projectDir, 'reviews.md'), '---\n---\n\n# Reviews\n')

  // reviews/ dir
  if (includeReviewsDir) {
    fs.mkdirSync(path.join(projectDir, 'reviews'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'reviews', 'note.md'), 'review note body')
  }

  // backlog.md
  fs.writeFileSync(path.join(projectDir, 'backlog.md'),
    '---\nproject_slug: demo\n---\n\n# Backlog\n\n## Now\n\n- live now\n\n## Later\n\n- pick up later\n\n## Blocked\n\n_None._\n\n## Dropped\n\n- dropped A\n- dropped B\n')

  // progress.md
  fs.writeFileSync(path.join(projectDir, 'progress.md'),
    '---\nproject_slug: demo\n---\n\n# Progress\n\n- 2026-04-20 entry 1\n- 2026-04-21 entry 2\n')

  return { tmpRoot, projectDir }
}

function cleanup(tmpRoot) {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}

// --------------------------------------------------------------------------
// planTransition is pure.
// --------------------------------------------------------------------------

test('planTransition returns the expected shape without mutating the project', () => {
  const { tmpRoot, projectDir } = seedProject()
  const snapshotBefore = JSON.stringify(fs.readdirSync(projectDir).sort())
  const plan = planTransition({ projectDir, summary: 'demo closing' })
  const snapshotAfter = JSON.stringify(fs.readdirSync(projectDir).sort())

  assert.equal(plan.closing_batch, 1)
  assert.equal(plan.new_batch, 2)
  assert.equal(plan.summary, 'demo closing')
  assert.ok(Array.isArray(plan.planned_moves), 'planned_moves is array')
  assert.ok(plan.planned_moves.length >= 3, 'at least tasks + tasks.md + snapshot + reviews.md')
  assert.ok(plan.planned_resets.current_batch === 2)
  assert.equal(snapshotBefore, snapshotAfter, 'no filesystem mutations from planTransition')
  cleanup(tmpRoot)
})

test('planTransition includes reviews/ dir in planned_moves when present', () => {
  const { tmpRoot, projectDir } = seedProject({ includeReviewsDir: true })
  const plan = planTransition({ projectDir })
  const hasReviewsDir = plan.planned_moves.some((m) => m.src === 'reviews' && m.kind === 'dir')
  assert.equal(hasReviewsDir, true, 'reviews/ dir queued for archive')
  cleanup(tmpRoot)
})

test('planTransition surfaces incomplete tasks', () => {
  const { tmpRoot, projectDir } = seedProject({ tasks: [
    { id: 'T001', stage: 'done' },
    { id: 'T002', stage: 'blocked' },
    { id: 'T003', stage: 'dispatched' },
  ] })
  const plan = planTransition({ projectDir })
  const ids = plan.incomplete_tasks.map((t) => t.task_id).sort()
  assert.deepEqual(ids, ['T002', 'T003'])
  cleanup(tmpRoot)
})

// --------------------------------------------------------------------------
// startNewBatch happy path.
// --------------------------------------------------------------------------

test('startNewBatch: happy path archives and resets correctly', () => {
  const { tmpRoot, projectDir } = seedProject({ includeReviewsDir: true })
  const result = startNewBatch({ projectDir, summary: 'migration complete' })
  assert.equal(result.closing_batch, 1)
  assert.equal(result.new_batch, 2)

  const batchDir = path.join(projectDir, 'batches', '1')
  assert.ok(fs.existsSync(path.join(batchDir, 'tasks', 'T001.md')), 'task archived')
  assert.ok(fs.existsSync(path.join(batchDir, 'tasks.md')), 'tasks.md archived')
  assert.ok(fs.existsSync(path.join(batchDir, 'execution-snapshot.md')), 'snapshot archived')
  assert.ok(fs.existsSync(path.join(batchDir, 'reviews.md')), 'reviews.md archived')
  assert.ok(fs.existsSync(path.join(batchDir, 'reviews', 'note.md')), 'reviews/ dir archived')

  // Live files reset
  assert.deepEqual(fs.readdirSync(path.join(projectDir, 'tasks')), [], 'tasks/ empty')
  assert.equal(fs.existsSync(path.join(projectDir, 'tasks.md')), false, 'tasks.md moved')
  assert.equal(fs.existsSync(path.join(projectDir, 'execution-snapshot.md')), false, 'snapshot moved')

  // Project frontmatter reset + batch fields lazily materialized
  const { frontmatter } = readMarkdownFrontmatter(path.join(projectDir, 'project.md'))
  const fm = withProjectDefaults(frontmatter)
  assert.equal(fm.current_batch, 2)
  assert.deepEqual(fm.batches_completed, [1])
  assert.ok(fm.batch_started_at, 'batch_started_at set')
  assert.deepEqual(fm.active_tasks, [])
  assert.deepEqual(fm.approved_task_ids, [])
  assert.deepEqual(fm.open_questions, [])
  assert.equal(fm.execution_authorized, false)
  assert.equal(fm.critic_status, 'not_offered')
  assert.equal(fm.approval_reset_reason, null)
  assert.equal(fm.phase, 'phase1_discovery')
  assert.equal(fm.stage, 'planning')

  // Batch summary appended
  const summary = fs.readFileSync(path.join(projectDir, 'batch-summary.md'), 'utf8')
  assert.match(summary, /## Batch 1.*migration complete/s)

  // Progress rotation marker
  const progress = fs.readFileSync(path.join(projectDir, 'progress.md'), 'utf8')
  assert.match(progress, /<!-- batch 1 archive -->/)
  assert.match(progress, /<!-- end batch 1 -->/)

  // Backlog split
  const live = fs.readFileSync(path.join(projectDir, 'backlog.md'), 'utf8')
  assert.match(live, /## Now/)
  assert.match(live, /## Later/)
  assert.match(live, /live now/)
  assert.match(live, /pick up later/)
  assert.doesNotMatch(live, /dropped A/)

  const archivedBacklog = path.join(batchDir, 'backlog-archived.md')
  assert.ok(fs.existsSync(archivedBacklog))
  assert.match(fs.readFileSync(archivedBacklog, 'utf8'), /dropped A/)

  // Journal + staging + lock all cleaned up
  assert.equal(fs.existsSync(path.join(projectDir, '.batch-transition-journal.json')), false)
  assert.equal(fs.existsSync(path.join(projectDir, '.batch-transition-staging')), false)
  assert.equal(fs.existsSync(path.join(projectDir, '.batch-transition.lock')), false)

  cleanup(tmpRoot)
})

// --------------------------------------------------------------------------
// Incomplete tasks gate.
// --------------------------------------------------------------------------

test('startNewBatch: throws IncompleteTasksError when policy unset and incomplete tasks present', () => {
  const { tmpRoot, projectDir } = seedProject({ tasks: [
    { id: 'T001', stage: 'done' },
    { id: 'T002', stage: 'blocked' },
  ] })
  assert.throws(() => startNewBatch({ projectDir, summary: 'x' }), (err) => {
    assert.equal(err instanceof IncompleteTasksError, true)
    assert.deepEqual(err.incompleteTasks.map((t) => t.task_id), ['T002'])
    return true
  })
  // No filesystem mutations
  assert.equal(fs.existsSync(path.join(projectDir, 'batches')), false, 'no batch dir created')
  assert.equal(fs.existsSync(path.join(projectDir, '.batch-transition-journal.json')), false)
  assert.equal(fs.existsSync(path.join(projectDir, '.batch-transition.lock')), false)
  cleanup(tmpRoot)
})

test('startNewBatch: policy=cancel throws BatchCancelledError with no mutations', () => {
  const { tmpRoot, projectDir } = seedProject({ tasks: [
    { id: 'T001', stage: 'done' },
    { id: 'T002', stage: 'blocked' },
  ] })
  const before = fs.readdirSync(projectDir).sort().join(',')
  assert.throws(() => startNewBatch({ projectDir, summary: 'x', incompleteTaskPolicy: 'cancel' }), BatchCancelledError)
  const after = fs.readdirSync(projectDir).sort().join(',')
  assert.equal(before, after, 'fs untouched on cancel')
  cleanup(tmpRoot)
})

// --------------------------------------------------------------------------
// Idempotency guards.
// --------------------------------------------------------------------------

test('startNewBatch: second call blocked when leftover journal present', () => {
  const { tmpRoot, projectDir } = seedProject()
  // Seed a fake journal
  fs.writeFileSync(path.join(projectDir, '.batch-transition-journal.json'), JSON.stringify({ status: 'prepared' }))
  assert.throws(() => startNewBatch({ projectDir, summary: 'x' }), /batch transition in progress|call recovery/i)
  cleanup(tmpRoot)
})

test('startNewBatch: blocked when batches/<N>/ already exists without journal', () => {
  const { tmpRoot, projectDir } = seedProject()
  fs.mkdirSync(path.join(projectDir, 'batches', '1'), { recursive: true })
  assert.throws(() => startNewBatch({ projectDir, summary: 'x' }), /already archived/)
  cleanup(tmpRoot)
})

// --------------------------------------------------------------------------
// Recovery paths.
// --------------------------------------------------------------------------

test('recoverInterruptedBatchTransition: rollback from status=prepared', () => {
  const { tmpRoot, projectDir } = seedProject()
  // Simulate a prepared-but-not-committing crash: staging copy present, journal present, originals intact.
  const stagingDir = path.join(projectDir, '.batch-transition-staging')
  fs.mkdirSync(stagingDir, { recursive: true })
  fs.copyFileSync(path.join(projectDir, 'project.md'), path.join(stagingDir, 'project.md'))
  fs.writeFileSync(path.join(projectDir, '.batch-transition-journal.json'),
    JSON.stringify({ status: 'prepared', closing_batch: 1, staging_dir: stagingDir }))
  fs.writeFileSync(path.join(projectDir, '.batch-transition.lock'),
    JSON.stringify({ kind: 'batch_transition', last_heartbeat_time: new Date().toISOString() }))

  const beforeProject = fs.readFileSync(path.join(projectDir, 'project.md'), 'utf8')
  const result = recoverInterruptedBatchTransition({ projectDir })
  assert.equal(result.recovered, true)
  assert.equal(result.action, 'rollback')
  assert.equal(fs.existsSync(path.join(projectDir, '.batch-transition-journal.json')), false)
  assert.equal(fs.existsSync(path.join(projectDir, '.batch-transition-staging')), false)
  assert.equal(fs.existsSync(path.join(projectDir, '.batch-transition.lock')), false)
  // Restored from staging
  assert.equal(fs.readFileSync(path.join(projectDir, 'project.md'), 'utf8'), beforeProject)
  cleanup(tmpRoot)
})

test('recoverInterruptedBatchTransition: finalize from status=committed', () => {
  const { tmpRoot, projectDir } = seedProject()
  const stagingDir = path.join(projectDir, '.batch-transition-staging')
  fs.mkdirSync(stagingDir, { recursive: true })
  fs.writeFileSync(path.join(projectDir, '.batch-transition-journal.json'),
    JSON.stringify({ status: 'committed', closing_batch: 1, staging_dir: stagingDir }))
  fs.writeFileSync(path.join(projectDir, '.batch-transition.lock'),
    JSON.stringify({ kind: 'batch_transition', last_heartbeat_time: new Date().toISOString() }))

  const result = recoverInterruptedBatchTransition({ projectDir })
  assert.equal(result.recovered, true)
  assert.equal(result.action, 'finalize')
  // Cleanup performed
  assert.equal(fs.existsSync(path.join(projectDir, '.batch-transition-journal.json')), false)
  assert.equal(fs.existsSync(path.join(projectDir, '.batch-transition-staging')), false)
  assert.equal(fs.existsSync(path.join(projectDir, '.batch-transition.lock')), false)
  cleanup(tmpRoot)
})

test('recoverInterruptedBatchTransition: stale-lock reclaim when no journal present', () => {
  const { tmpRoot, projectDir } = seedProject()
  const staleTime = new Date(Date.now() - STALE_TRANSITION_LOCK_MS * 2).toISOString()
  fs.writeFileSync(path.join(projectDir, '.batch-transition.lock'),
    JSON.stringify({ kind: 'batch_transition', last_heartbeat_time: staleTime }))

  const result = recoverInterruptedBatchTransition({ projectDir })
  assert.equal(result.recovered, true)
  assert.equal(result.action, 'stale-lock-reclaimed')
  assert.equal(fs.existsSync(path.join(projectDir, '.batch-transition.lock')), false)
  cleanup(tmpRoot)
})

test('recoverInterruptedBatchTransition: leaves live lock alone', () => {
  const { tmpRoot, projectDir } = seedProject()
  const freshTime = new Date().toISOString()
  fs.writeFileSync(path.join(projectDir, '.batch-transition.lock'),
    JSON.stringify({ kind: 'batch_transition', last_heartbeat_time: freshTime }))

  const result = recoverInterruptedBatchTransition({ projectDir })
  assert.equal(result.recovered, false)
  assert.equal(fs.existsSync(path.join(projectDir, '.batch-transition.lock')), true, 'fresh lock preserved')
  cleanup(tmpRoot)
})

test('recoverInterruptedBatchTransition: no-op when nothing in flight', () => {
  const { tmpRoot, projectDir } = seedProject()
  const result = recoverInterruptedBatchTransition({ projectDir })
  assert.equal(result.recovered, false)
  assert.equal(result.reason, 'no-transition-in-flight')
  cleanup(tmpRoot)
})

// --------------------------------------------------------------------------
// batch-summary.md: absent vs present.
// --------------------------------------------------------------------------

test('startNewBatch: creates batch-summary.md from template when absent', () => {
  const { tmpRoot, projectDir } = seedProject()
  assert.equal(fs.existsSync(path.join(projectDir, 'batch-summary.md')), false)
  startNewBatch({ projectDir, summary: 'first run' })
  const body = fs.readFileSync(path.join(projectDir, 'batch-summary.md'), 'utf8')
  assert.match(body, /# Batches/)
  assert.match(body, /## Batch 1.*first run/s)
  cleanup(tmpRoot)
})

test('startNewBatch: appends to existing batch-summary.md', () => {
  const { tmpRoot, projectDir } = seedProject()
  fs.writeFileSync(path.join(projectDir, 'batch-summary.md'),
    '---\nschema_version: 1\n---\n\n# Batches\n\n## Batch 0 — seeded\n\n- note\n')
  startNewBatch({ projectDir, summary: 'new cycle' })
  const body = fs.readFileSync(path.join(projectDir, 'batch-summary.md'), 'utf8')
  assert.match(body, /## Batch 0 — seeded/)
  assert.match(body, /## Batch 1.*new cycle/s)
  cleanup(tmpRoot)
})

// --------------------------------------------------------------------------
// Lazy-persistence: legacy project (no batch fields on disk) still works.
// --------------------------------------------------------------------------

test('startNewBatch: legacy project with no batch fields on disk still transitions', () => {
  const { tmpRoot, projectDir } = seedProject({ includeBatchFields: false })
  const beforeProject = fs.readFileSync(path.join(projectDir, 'project.md'), 'utf8')
  assert.doesNotMatch(beforeProject, /current_batch/, 'pre-state has no batch fields on disk')

  const result = startNewBatch({ projectDir, summary: 'legacy upgrade' })
  assert.equal(result.closing_batch, 1)
  assert.equal(result.new_batch, 2)

  const afterProject = fs.readFileSync(path.join(projectDir, 'project.md'), 'utf8')
  assert.match(afterProject, /current_batch/, 'batch fields now on disk (lazy materialized)')
  cleanup(tmpRoot)
})

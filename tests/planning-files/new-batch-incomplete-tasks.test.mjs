import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  BatchCancelledError,
  IncompleteTasksError,
  readMarkdownFrontmatter,
  startNewBatch,
  writeMarkdownFrontmatter,
} from '../../yak/plugins/planning-files/session-store.js'

// Seed a Batch-1 project with mixed-stage tasks. Keeps it minimal so we can
// focus on policy behavior rather than full lifecycle wiring.
function seedProject({ tasks }) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-incomplete-policy-'))
  const projectDir = path.join(tmpRoot, '.agents', 'yak', 'projects', 'demo')
  fs.mkdirSync(path.join(projectDir, 'tasks'), { recursive: true })

  writeMarkdownFrontmatter(path.join(projectDir, 'project.md'), {
    project_slug: 'demo',
    current_batch: 1,
    batches_completed: [],
    batch_started_at: null,
    active_tasks: [],
    approved_task_ids: tasks.map((t) => t.id),
    completed_task_ids: tasks.filter((t) => t.stage === 'done').map((t) => t.id),
    draft_task_ids: [],
    blocked_task_ids: [],
    open_questions: [],
    execution_snapshot_revision: 1,
    phase: 'phase3_execution',
    subphase: 'dispatch',
    stage: 'implementing',
    phase1_revision: 1,
    phase1_approved_revision: 1,
    phase2_revision: 2,
    phase2_approved_revision: 2,
    plan_revision: 2,
    approved_revision: 2,
    execution_authorized: true,
  }, '# Project\n')

  for (const t of tasks) {
    const frontmatter = { task_id: t.id, stage: t.stage, plan_revision: 1, approved_revision: 1 }
    if (t.depends_on) frontmatter.depends_on = t.depends_on
    writeMarkdownFrontmatter(path.join(projectDir, 'tasks', `${t.id}.md`), frontmatter, `# ${t.id}\n\n## Goal\n\ntesting body\n`)
  }

  fs.writeFileSync(path.join(projectDir, 'tasks.md'),
    `---\nproject_slug: demo\n---\n\n# Tasks\n\n| id | status |\n| --- | --- |\n${tasks.map((t) => `| ${t.id} | ${t.stage} |`).join('\n')}\n`)
  fs.writeFileSync(path.join(projectDir, 'execution-snapshot.md'), '---\n---\nsnapshot\n')
  fs.writeFileSync(path.join(projectDir, 'reviews.md'), '---\n---\n\n# Reviews\n')
  fs.writeFileSync(path.join(projectDir, 'backlog.md'), '---\n---\n\n# Backlog\n')
  fs.writeFileSync(path.join(projectDir, 'progress.md'), '---\n---\n\n# Progress\n')

  return { tmpRoot, projectDir }
}

function cleanup(tmpRoot) {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}

test('policy=cancel throws BatchCancelledError and leaves filesystem untouched', () => {
  const { tmpRoot, projectDir } = seedProject({ tasks: [
    { id: 'T001', stage: 'done' },
    { id: 'T002', stage: 'blocked' },
  ] })
  const before = fs.readdirSync(projectDir).sort().join(',')
  assert.throws(() => startNewBatch({ projectDir, summary: 'x', incompleteTaskPolicy: 'cancel' }), BatchCancelledError)
  const after = fs.readdirSync(projectDir).sort().join(',')
  assert.equal(before, after, 'no mutations on cancel')
  assert.equal(fs.existsSync(path.join(projectDir, '.batch-transition-journal.json')), false, 'no journal on cancel')
  assert.equal(fs.existsSync(path.join(projectDir, 'batches')), false, 'no batches dir on cancel')
  cleanup(tmpRoot)
})

test('policy=abandon rewrites archived task stage to "abandoned"', () => {
  const { tmpRoot, projectDir } = seedProject({ tasks: [
    { id: 'T001', stage: 'done' },
    { id: 'T002', stage: 'blocked' },
    { id: 'T003', stage: 'dispatched' },
  ] })
  startNewBatch({ projectDir, summary: 'abandon test', incompleteTaskPolicy: 'abandon' })

  const archivedT002 = readMarkdownFrontmatter(path.join(projectDir, 'batches', '1', 'tasks', 'T002.md'))
  const archivedT003 = readMarkdownFrontmatter(path.join(projectDir, 'batches', '1', 'tasks', 'T003.md'))
  const archivedT001 = readMarkdownFrontmatter(path.join(projectDir, 'batches', '1', 'tasks', 'T001.md'))
  assert.equal(archivedT002.frontmatter.stage, 'abandoned')
  assert.equal(archivedT003.frontmatter.stage, 'abandoned')
  // Completed task stage unchanged
  assert.equal(archivedT001.frontmatter.stage, 'done')
  // Live tasks dir empty
  assert.deepEqual(fs.readdirSync(path.join(projectDir, 'tasks')), [])
  cleanup(tmpRoot)
})

test('policy=carry clones incomplete tasks to live tasks/ with new B<N+1>-T### IDs', () => {
  const { tmpRoot, projectDir } = seedProject({ tasks: [
    { id: 'T001', stage: 'done' },
    { id: 'T002', stage: 'blocked', depends_on: ['T001'] },
    { id: 'T003', stage: 'dispatched', depends_on: ['T002', 'T001'] },
  ] })
  startNewBatch({ projectDir, summary: 'carry test', incompleteTaskPolicy: 'carry' })

  // Archived originals preserve stage (not rewritten to abandoned)
  const archivedT002 = readMarkdownFrontmatter(path.join(projectDir, 'batches', '1', 'tasks', 'T002.md'))
  const archivedT003 = readMarkdownFrontmatter(path.join(projectDir, 'batches', '1', 'tasks', 'T003.md'))
  assert.equal(archivedT002.frontmatter.stage, 'blocked', 'original stage preserved in archive')
  assert.equal(archivedT003.frontmatter.stage, 'dispatched', 'original stage preserved in archive')

  // New clones exist in live tasks/ with B2-T### IDs
  const liveIds = fs.readdirSync(path.join(projectDir, 'tasks')).sort()
  assert.deepEqual(liveIds, ['B2-T001.md', 'B2-T002.md'])

  const clone1 = readMarkdownFrontmatter(path.join(projectDir, 'tasks', 'B2-T001.md'))
  const clone2 = readMarkdownFrontmatter(path.join(projectDir, 'tasks', 'B2-T002.md'))
  assert.equal(clone1.frontmatter.task_id, 'B2-T001')
  assert.equal(clone1.frontmatter.stage, 'draft')
  assert.equal(clone2.frontmatter.task_id, 'B2-T002')
  assert.equal(clone2.frontmatter.stage, 'draft')

  // depends_on preserved VERBATIM (T012 YAGNI: no rewrite)
  assert.deepEqual(clone1.frontmatter.depends_on, ['T001'], 'clone 1 depends_on preserved')
  assert.deepEqual(clone2.frontmatter.depends_on, ['T002', 'T001'], 'clone 2 depends_on preserved')

  // Ripple note added to body
  assert.match(clone1.body, /Carry origin/)
  assert.match(clone1.body, /Original task_id:\s*T002/)
  assert.match(clone2.body, /Original task_id:\s*T003/)
  cleanup(tmpRoot)
})

test('policy=carry preserves depends_on bytes exactly (no rewrite)', () => {
  const { tmpRoot, projectDir } = seedProject({ tasks: [
    { id: 'T001', stage: 'blocked', depends_on: ['T042', 'B99-T007'] },
  ] })
  startNewBatch({ projectDir, summary: 'carry bytes test', incompleteTaskPolicy: 'carry' })

  const clone = readMarkdownFrontmatter(path.join(projectDir, 'tasks', 'B2-T001.md'))
  assert.deepEqual(clone.frontmatter.depends_on, ['T042', 'B99-T007'], 'depends_on bytes preserved even for non-existent dep targets')
  cleanup(tmpRoot)
})

test('IncompleteTasksError is thrown when policy is unset and incomplete tasks exist', () => {
  const { tmpRoot, projectDir } = seedProject({ tasks: [
    { id: 'T001', stage: 'done' },
    { id: 'T002', stage: 'blocked' },
  ] })
  try {
    startNewBatch({ projectDir, summary: 'should not get here' })
    assert.fail('expected IncompleteTasksError')
  } catch (err) {
    assert.equal(err instanceof IncompleteTasksError, true)
    assert.equal(Array.isArray(err.incompleteTasks), true)
    const ids = err.incompleteTasks.map((t) => t.task_id)
    assert.deepEqual(ids, ['T002'])
  }
  cleanup(tmpRoot)
})

test('no incomplete tasks: policy value is ignored (happy path works for any policy)', () => {
  const { tmpRoot, projectDir } = seedProject({ tasks: [
    { id: 'T001', stage: 'done' },
    { id: 'T002', stage: 'rejected' },
  ] })
  // All tasks in terminal states {done, rejected} — no policy needed
  startNewBatch({ projectDir, summary: 'clean close', incompleteTaskPolicy: 'abandon' })
  assert.ok(fs.existsSync(path.join(projectDir, 'batches', '1', 'tasks', 'T001.md')))
  cleanup(tmpRoot)
})

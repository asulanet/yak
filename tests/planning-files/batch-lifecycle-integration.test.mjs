import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  readMarkdownFrontmatter,
  startNewBatch,
  writeMarkdownFrontmatter,
} from '../../yak/plugins/planning-files/session-store.js'
import { buildPhaseSystemPrompt as buildPrompt } from '../../yak/plugins/planning-files/prompts.js'

// End-to-end integration test covering the critical cross-module path:
// seed project → startNewBatch → phase1 prompt digest appears.
//
// Concurrency, crash-recovery, and legacy-project scenarios are covered by
// the unit tests in session-store-new-batch.test.mjs; this test focuses on
// the cross-module stitching that those unit tests don't exercise.

function seed() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-integration-'))
  const projectDir = path.join(tmpRoot, '.agents', 'yak', 'projects', 'demo')
  fs.mkdirSync(path.join(projectDir, 'tasks'), { recursive: true })
  fs.writeFileSync(path.join(tmpRoot, '.agents', 'yak', 'active-project.json'), JSON.stringify({ projectSlug: 'demo' }))

  writeMarkdownFrontmatter(path.join(projectDir, 'project.md'), {
    project_slug: 'demo',
    current_batch: 1,
    batches_completed: [],
    batch_started_at: null,
    active_tasks: [],
    approved_task_ids: ['T001'],
    completed_task_ids: ['T001'],
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

  writeMarkdownFrontmatter(path.join(projectDir, 'tasks', 'T001.md'),
    { task_id: 'T001', stage: 'done', plan_revision: 1, approved_revision: 1 }, '# T001\n')
  fs.writeFileSync(path.join(projectDir, 'tasks.md'), '---\n---\n# Tasks\n\n| id | status |\n| --- | --- |\n| T001 | done |\n')
  fs.writeFileSync(path.join(projectDir, 'execution-snapshot.md'), '---\napproved_task_ids: ["T001"]\n---\n')
  fs.writeFileSync(path.join(projectDir, 'reviews.md'), '---\n---\n\n# Reviews\n')
  fs.writeFileSync(path.join(projectDir, 'backlog.md'),
    '---\nproject_slug: demo\n---\n\n# Backlog\n\n## Now\n\n- now item\n\n## Later\n\n- later item\n\n## Dropped\n\n- dropped item\n')
  fs.writeFileSync(path.join(projectDir, 'progress.md'), '---\n---\n\n# Progress\n\n- 2026-04-21 batch 1 complete\n')
  return { tmpRoot, projectDir }
}

function cleanup(tmpRoot) { fs.rmSync(tmpRoot, { recursive: true, force: true }) }

test('integration: full batch 1 → batch 2 transition with phase1 digest surfaced', () => {
  const { tmpRoot, projectDir } = seed()
  const activeProjectPath = path.join(tmpRoot, '.agents', 'yak', 'active-project.json')
  const activeProjectBefore = fs.readFileSync(activeProjectPath, 'utf8')

  // Execute transition
  const result = startNewBatch({ projectDir, summary: 'batch 1 complete — integration test' })
  assert.equal(result.closing_batch, 1)
  assert.equal(result.new_batch, 2)

  // Archive layout correct
  const batchDir = path.join(projectDir, 'batches', '1')
  assert.ok(fs.existsSync(path.join(batchDir, 'tasks', 'T001.md')))
  assert.ok(fs.existsSync(path.join(batchDir, 'tasks.md')))
  assert.ok(fs.existsSync(path.join(batchDir, 'execution-snapshot.md')))
  assert.ok(fs.existsSync(path.join(batchDir, 'reviews.md')))
  assert.ok(fs.existsSync(path.join(batchDir, 'backlog-archived.md')))
  const archivedBacklog = fs.readFileSync(path.join(batchDir, 'backlog-archived.md'), 'utf8')
  assert.match(archivedBacklog, /dropped item/)

  // Live state reset
  const { frontmatter } = readMarkdownFrontmatter(path.join(projectDir, 'project.md'))
  assert.equal(frontmatter.current_batch, 2)
  assert.deepEqual(frontmatter.batches_completed, [1])
  assert.equal(frontmatter.phase, 'phase1_discovery')

  // Phase1 digest appears when current_batch=2
  const summary = fs.readFileSync(path.join(projectDir, 'batch-summary.md'), 'utf8')
  const phase1Prompt = buildPrompt({
    phase: 'phase1_discovery',
    subphase: 'scope_draft',
    stage: 'planning',
    slug: 'demo',
    projectDir: '.agents/yak/projects/demo',
    activeTasks: [],
    openQuestions: [],
    currentBatch: 2,
    batchSummary: summary,
  })
  assert.match(phase1Prompt, /Prior batches on this project/)
  assert.match(phase1Prompt, /batch 1 complete — integration test/)

  // active-project.json preserved: next bootstrap still binds same slug
  const activeProjectAfter = fs.readFileSync(activeProjectPath, 'utf8')
  assert.equal(activeProjectBefore, activeProjectAfter, 'active-project.json unchanged across transition')

  // Journal + staging + lock all cleaned up
  assert.equal(fs.existsSync(path.join(projectDir, '.batch-transition-journal.json')), false)
  assert.equal(fs.existsSync(path.join(projectDir, '.batch-transition-staging')), false)
  assert.equal(fs.existsSync(path.join(projectDir, '.batch-transition.lock')), false)

  cleanup(tmpRoot)
})

test('integration: phase1 digest NOT prepended for legacy project (no batch fields)', () => {
  // Verify the lazy-persistence contract holds at the prompt layer too.
  const prompt = buildPrompt({
    phase: 'phase1_discovery',
    subphase: 'scope_draft',
    stage: 'planning',
    slug: 'demo',
    projectDir: '.agents/yak/projects/demo',
    activeTasks: [],
    openQuestions: [],
    // currentBatch: undefined deliberately
  })
  assert.doesNotMatch(prompt, /Prior batches on this project/)
})

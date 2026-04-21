import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

import { writeMarkdownFrontmatter } from '../../yak/plugins/planning-files/session-store.js'

const thisDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(thisDir, '..', '..')
const cliPath = path.join(repoRoot, 'yak', 'scripts', 'start-new-batch.mjs')

function seedTestRepo({ includeIncomplete = false } = {}) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-cli-batch-'))
  // Seed an empty git repo so findNearestGitRoot picks this up as repoRoot.
  fs.mkdirSync(path.join(tmpRoot, '.git'), { recursive: true })
  const projectDir = path.join(tmpRoot, '.agents', 'yak', 'projects', 'demo')
  fs.mkdirSync(path.join(projectDir, 'tasks'), { recursive: true })
  fs.writeFileSync(path.join(tmpRoot, '.agents', 'yak', 'active-project.json'), JSON.stringify({ projectSlug: 'demo' }))

  const tasks = [{ id: 'T001', stage: 'done' }]
  if (includeIncomplete) tasks.push({ id: 'T002', stage: 'blocked' })

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
    writeMarkdownFrontmatter(path.join(projectDir, 'tasks', `${t.id}.md`),
      { task_id: t.id, stage: t.stage, plan_revision: 1, approved_revision: 1 }, `# ${t.id}\n`)
  }
  fs.writeFileSync(path.join(projectDir, 'tasks.md'), '---\n---\n# Tasks\n')
  fs.writeFileSync(path.join(projectDir, 'execution-snapshot.md'), '---\n---\n')
  fs.writeFileSync(path.join(projectDir, 'reviews.md'), '---\n---\n')
  fs.writeFileSync(path.join(projectDir, 'backlog.md'), '---\n---\n# Backlog\n')
  fs.writeFileSync(path.join(projectDir, 'progress.md'), '---\n---\n# Progress\n')

  return { tmpRoot, projectDir }
}

function runCli(args, { repoRootOverride } = {}) {
  const env = { ...process.env }
  return spawnSync('node', [cliPath, '--repo-root', repoRootOverride || repoRoot, ...args], {
    encoding: 'utf8',
    env,
  })
}

function cleanup(tmpRoot) { fs.rmSync(tmpRoot, { recursive: true, force: true }) }

test('--help prints usage and exits 0', () => {
  const result = runCli(['--help'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /Usage: start-new-batch/)
  assert.match(result.stdout, /--summary/)
  assert.match(result.stdout, /--policy/)
  assert.match(result.stdout, /--dry-run/)
  assert.match(result.stdout, /--recover/)
})

test('missing --summary fails with non-zero exit', () => {
  const { tmpRoot } = seedTestRepo()
  const result = runCli(['--project', 'demo'], { repoRootOverride: tmpRoot })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /--summary.*required/)
  cleanup(tmpRoot)
})

test('invalid --policy fails with non-zero exit', () => {
  const result = runCli(['--summary', 'x', '--policy', 'bogus'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /invalid --policy/)
})

test('--dry-run produces no file changes', () => {
  const { tmpRoot, projectDir } = seedTestRepo()
  const snapshotBefore = fs.readdirSync(projectDir).sort().join(',')
  const result = runCli(['--project', 'demo', '--dry-run'], { repoRootOverride: tmpRoot })
  const snapshotAfter = fs.readdirSync(projectDir).sort().join(',')
  assert.equal(result.status, 0, `dry-run failed: ${result.stderr}`)
  assert.match(result.stdout, /dry-run/)
  assert.match(result.stdout, /Planned moves/)
  assert.match(result.stdout, /"prepared"/)
  assert.equal(snapshotBefore, snapshotAfter, 'no mutations during dry-run')
  cleanup(tmpRoot)
})

test('--dry-run warns about leftover journal', () => {
  const { tmpRoot, projectDir } = seedTestRepo()
  fs.writeFileSync(path.join(projectDir, '.batch-transition-journal.json'),
    JSON.stringify({ status: 'prepared' }))
  const result = runCli(['--project', 'demo', '--dry-run'], { repoRootOverride: tmpRoot })
  assert.match(result.stderr, /leftover batch transition journal/)
  cleanup(tmpRoot)
})

test('real run happy path: archives to batches/1/', () => {
  const { tmpRoot, projectDir } = seedTestRepo()
  const result = runCli(['--project', 'demo', '--summary', 'cli happy path'], { repoRootOverride: tmpRoot })
  assert.equal(result.status, 0, `real run failed: ${result.stderr}`)
  assert.match(result.stdout, /"status": "ok"/)
  assert.ok(fs.existsSync(path.join(projectDir, 'batches', '1', 'tasks', 'T001.md')))
  cleanup(tmpRoot)
})

test('IncompleteTasksError without --policy: non-zero exit + actionable message', () => {
  const { tmpRoot } = seedTestRepo({ includeIncomplete: true })
  const result = runCli(['--project', 'demo', '--summary', 'needs policy'], { repoRootOverride: tmpRoot })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Incomplete tasks/)
  assert.match(result.stderr, /abandon\|carry\|cancel/)
  assert.match(result.stderr, /T002\(blocked\)/)
  cleanup(tmpRoot)
})

test('--recover is no-op when no transition in flight; exit 0', () => {
  const { tmpRoot } = seedTestRepo()
  const result = runCli(['--project', 'demo', '--recover'], { repoRootOverride: tmpRoot })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /no-transition-in-flight/)
  cleanup(tmpRoot)
})

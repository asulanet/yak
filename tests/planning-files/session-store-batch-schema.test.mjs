import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

import {
  BATCH_FRONTMATTER_FIELDS,
  DEFAULT_PROJECT_FRONTMATTER,
  TASK_ID_PATTERN,
  isValidTaskId,
  migrateProjectFrontmatter,
  readMarkdownFrontmatter,
  withProjectDefaults,
  writeMarkdownFrontmatter,
} from '../../yak/plugins/planning-files/session-store.js'

import { parseTaskFrontmatter } from '../../yak/plugins/planning-files/task-policy.js'

const thisDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(thisDir, '..', '..')

test('TASK_ID_PATTERN accepts legacy bare T### format', () => {
  for (const id of ['T001', 'T042', 'T999']) {
    assert.equal(TASK_ID_PATTERN.test(id), true, `expected ${id} to match`)
    assert.equal(isValidTaskId(id), true, `isValidTaskId(${id})`)
  }
})

test('TASK_ID_PATTERN accepts prefixed B<N>-T### format', () => {
  for (const id of ['B1-T001', 'B2-T042', 'B10-T999', 'B99-T000']) {
    assert.equal(TASK_ID_PATTERN.test(id), true, `expected ${id} to match`)
    assert.equal(isValidTaskId(id), true, `isValidTaskId(${id})`)
  }
})

test('TASK_ID_PATTERN rejects malformed inputs', () => {
  // The regex accepts one-or-more digits after T so legacy test fixtures keep
  // working; `T###` three-digit form is the generator convention, not the
  // validator's minimum. The rejections below catch structural violations of
  // the <prefix?><T><digits> shape itself.
  const invalid = [
    'BT001',      // prefix missing dash + batch number
    'B-T001',     // batch number missing
    'B2T001',     // prefix missing dash
    'b2-T001',    // lowercase prefix
    'T',          // no digits
    'foo',
    '',
    ' T001',
    'T001 ',
    'T01X',       // trailing non-digit
  ]
  for (const id of invalid) {
    assert.equal(TASK_ID_PATTERN.test(id), false, `expected ${JSON.stringify(id)} to be rejected`)
    assert.equal(isValidTaskId(id), false, `isValidTaskId(${JSON.stringify(id)})`)
  }
})

test('isValidTaskId rejects non-string inputs', () => {
  for (const id of [null, undefined, 123, [], {}, true]) {
    assert.equal(isValidTaskId(id), false, `isValidTaskId(${JSON.stringify(id)})`)
  }
})

test('parseTaskFrontmatter accepts legacy and prefixed task_id', () => {
  const baseFrontmatter = {
    plan_revision: 1,
    approved_revision: 1,
    expected_paths: ['a.txt'],
    protected_paths: ['.git'],
    allowed_ephemeral_paths: [],
    allowed_shell_command_forms: [],
    required_for_acceptance: [],
  }
  const legacy = parseTaskFrontmatter({ ...baseFrontmatter, task_id: 'T001' })
  assert.equal(legacy.taskID, 'T001')
  const prefixed = parseTaskFrontmatter({ ...baseFrontmatter, task_id: 'B2-T007' })
  assert.equal(prefixed.taskID, 'B2-T007')
})

test('withProjectDefaults surfaces batch fields in memory for legacy input', () => {
  const result = withProjectDefaults({})
  assert.equal(result.current_batch, 1, 'default current_batch=1')
  assert.deepEqual(result.batches_completed, [], 'default batches_completed=[]')
  assert.equal(result.batch_started_at, null, 'default batch_started_at=null')
})

test('withProjectDefaults preserves explicitly-set batch fields', () => {
  const input = {
    current_batch: 3,
    batches_completed: [1, 2],
    batch_started_at: '2026-04-21T00:00:00.000Z',
  }
  const result = withProjectDefaults(input)
  assert.equal(result.current_batch, 3)
  assert.deepEqual(result.batches_completed, [1, 2])
  assert.equal(result.batch_started_at, '2026-04-21T00:00:00.000Z')
})

test('BATCH_FRONTMATTER_FIELDS enumerates the lazy-persist set', () => {
  assert.ok(BATCH_FRONTMATTER_FIELDS.includes('current_batch'))
  assert.ok(BATCH_FRONTMATTER_FIELDS.includes('batches_completed'))
  assert.ok(BATCH_FRONTMATTER_FIELDS.includes('batch_started_at'))
  assert.equal(BATCH_FRONTMATTER_FIELDS.length, 3)
})

test('DEFAULT_PROJECT_FRONTMATTER includes batch fields', () => {
  assert.equal(DEFAULT_PROJECT_FRONTMATTER.current_batch, 1)
  assert.deepEqual(DEFAULT_PROJECT_FRONTMATTER.batches_completed, [])
  assert.equal(DEFAULT_PROJECT_FRONTMATTER.batch_started_at, null)
})

test('migrateProjectFrontmatter: legacy project.md (no batch fields) is byte-identical after round-trip', () => {
  // Build a legacy-shaped project.md that predates the batch schema. Fields
  // are the pre-batch set exactly; no current_batch / batches_completed /
  // batch_started_at on disk.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-batch-schema-'))
  const projectDir = path.join(tmpRoot, '.agents', 'yak', 'projects', 'legacy')
  fs.mkdirSync(projectDir, { recursive: true })
  const projectPath = path.join(projectDir, 'project.md')
  const legacyFrontmatter = [
    'project_slug: "legacy"',
    'project_dir: "' + projectDir + '"',
    'stage: "implementing"',
    'phase: "phase3_execution"',
    'subphase: "dispatch"',
    'phase1_revision: 1',
    'phase1_approved_revision: 1',
    'phase2_revision: 2',
    'phase2_approved_revision: 2',
    'execution_snapshot_revision: 1',
    'plan_revision: 2',
    'approved_revision: 2',
    'approved_by: "question-tool"',
    'approved_at: "2026-04-20T00:00:00.000Z"',
    'approved_task_ids: ["T001"]',
    'draft_task_ids: []',
    'blocked_task_ids: []',
    'active_tasks: []',
    'open_questions: []',
    'research_mode: "brief"',
    'critic_status: "not_offered"',
    'execution_authorized: true',
    'last_gate_question_id: "que_x"',
    'change_impact_level: "local"',
  ].join('\n')
  const legacyContent = `---\n${legacyFrontmatter}\n---\n# Project\n`
  fs.writeFileSync(projectPath, legacyContent)

  const before = fs.readFileSync(projectPath, 'utf8')
  const result = migrateProjectFrontmatter({ projectDir })
  const after = fs.readFileSync(projectPath, 'utf8')

  assert.equal(before, after, 'legacy project.md bytes must be identical after migrate')
  assert.equal(result.migrated, false, 'migrate should be a no-op for legacy-shaped project')

  // Clean up.
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

test('migrateProjectFrontmatter: project with batch fields persists them', () => {
  // Opposite direction: a project.md that already has batch fields on disk
  // (e.g. bootstrapped from the new template) should persist them on migrate.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-batch-schema-'))
  const projectDir = path.join(tmpRoot, '.agents', 'yak', 'projects', 'new')
  fs.mkdirSync(projectDir, { recursive: true })
  const projectPath = path.join(projectDir, 'project.md')
  writeMarkdownFrontmatter(projectPath, {
    ...DEFAULT_PROJECT_FRONTMATTER,
    project_slug: 'new',
    project_dir: projectDir,
    current_batch: 2,
    batches_completed: [1],
  }, '# Project\n')

  migrateProjectFrontmatter({ projectDir })
  const { frontmatter } = readMarkdownFrontmatter(projectPath)
  assert.equal(frontmatter.current_batch, 2, 'current_batch persisted')
  assert.deepEqual(frontmatter.batches_completed, [1], 'batches_completed persisted')

  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

test('canonical TASK_ID_PATTERN is the sole ID regex literal in planning-files sources', () => {
  // Guard against silent duplication: scan all .js/.mjs under yak/plugins and
  // yak/scripts and ensure no regex literal of shape /T\d+/ or /B\d+-T\d+/
  // appears outside session-store.js.
  const scanDirs = [
    path.join(repoRoot, 'yak', 'plugins'),
    path.join(repoRoot, 'yak', 'scripts'),
  ]
  const canonicalFile = path.join(repoRoot, 'yak', 'plugins', 'planning-files', 'session-store.js')
  const problematic = /\/\^?\(?\??:?B?\\d\+?-?\??T?\\d\{\d\}/
  const tSingle = /\/\^?T\\d\{\d\}\$?\/|\/\^?T\\d\+\$?\//
  function walk(dir) {
    const out = []
    if (!fs.existsSync(dir)) return out
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) out.push(...walk(p))
      else if (entry.isFile() && /\.(mjs|js)$/.test(entry.name)) out.push(p)
    }
    return out
  }
  const files = scanDirs.flatMap(walk)
  const offenders = []
  for (const file of files) {
    if (path.resolve(file) === path.resolve(canonicalFile)) continue
    const content = fs.readFileSync(file, 'utf8')
    if (problematic.test(content) || tSingle.test(content)) {
      offenders.push(file)
    }
  }
  assert.deepEqual(offenders, [], `duplicate task-ID regex in: ${offenders.join(', ')}`)
})

test('record-task-stage CLI rejects malformed task IDs', () => {
  const cliPath = path.join(repoRoot, 'yak', 'scripts', 'record-task-stage.mjs')
  const result = spawnSync('node', [cliPath, '--task', 'BT001', '--stage', 'draft'], {
    encoding: 'utf8',
    cwd: repoRoot,
  })
  assert.notEqual(result.status, 0, 'CLI must exit non-zero for invalid task ID')
  assert.match(result.stderr || result.stdout || '', /canonical pattern|must match/, 'error mentions canonical pattern')
})

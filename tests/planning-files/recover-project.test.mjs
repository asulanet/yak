import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

import { readMarkdownFrontmatter } from '../../yak/plugins/planning-files/session-store.js'
import { writeActiveProjectSlug } from '../../yak/plugins/planning-files/session-store.js'

const script = fileURLToPath(new URL('../../yak/scripts/recover-project.mjs', import.meta.url))

function makeRepo() { const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-recover-')); execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' }); return repoRoot }

function writeProject(repoRoot, slug, stage, activeTasks = []) {
  const projectDir = path.join(repoRoot, '.agents', 'yak', 'projects', slug)
  fs.mkdirSync(path.join(projectDir, 'tasks'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'project.md'), `---\nstage: ${stage}\nactive_tasks: ${JSON.stringify(activeTasks)}\n---\n`)
  return projectDir
}

function writeLegacyProject(repoRoot, slug, stage, body = 'User notes\n') {
  const projectDir = path.join(repoRoot, '.agents', 'yak', 'projects', slug)
  fs.mkdirSync(path.join(projectDir, 'tasks'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'project.md'), `---\nstage: ${stage}\n---\n${body}`)
  return projectDir
}

test('recovery normalizes legacy quarantined project to planning', () => {
  const repoRoot = makeRepo()
  const projectDir = writeProject(repoRoot, 'alpha', 'quarantined', [])

  const output = execFileSync('node', [script], { cwd: repoRoot, encoding: 'utf8' })
  const restored = readMarkdownFrontmatter(path.join(projectDir, 'project.md')).frontmatter
  assert.equal(restored.stage, 'planning')
  assert.equal(fs.existsSync(path.join(projectDir, 'tasks', 'T000-recovery.md')), false)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repoRoot, '.agents', 'yak', 'active-project.json'), 'utf8')), { projectSlug: 'alpha' })
  assert.match(output, /"changed": true/)
})

test('recovery migrates legacy quarantined project without losing body', () => {
  const repoRoot = makeRepo()
  const body = 'User notes\nKeep this text.\n'
  const projectDir = writeLegacyProject(repoRoot, 'alpha', 'quarantined', body)

  execFileSync('node', [script], { cwd: repoRoot, encoding: 'utf8' })
  const { frontmatter, body: recoveredBody } = readMarkdownFrontmatter(path.join(projectDir, 'project.md'))
  assert.equal(frontmatter.stage, 'planning')
  assert.equal(frontmatter.phase, 'phase1_discovery')
  assert.equal(frontmatter.project_slug, null)
  assert.equal(recoveredBody, body)
})

test('recovery rerun is idempotent', () => {
  const repoRoot = makeRepo()
  writeProject(repoRoot, 'alpha', 'planning', [])

  const first = execFileSync('node', [script], { cwd: repoRoot, encoding: 'utf8' })
  const second = execFileSync('node', [script], { cwd: repoRoot, encoding: 'utf8' })
  assert.match(first, /"changed": false/)
  assert.match(second, /"changed": false/)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repoRoot, '.agents', 'yak', 'active-project.json'), 'utf8')), { projectSlug: 'alpha' })
})

test('recovery rerun stays idempotent after migration', () => {
  const repoRoot = makeRepo()
  const projectDir = writeLegacyProject(repoRoot, 'alpha', 'quarantined', 'Body stays.\n')

  const first = execFileSync('node', [script], { cwd: repoRoot, encoding: 'utf8' })
  const second = execFileSync('node', [script], { cwd: repoRoot, encoding: 'utf8' })
  const { frontmatter, body } = readMarkdownFrontmatter(path.join(projectDir, 'project.md'))
  assert.match(first, /"changed": true/)
  assert.match(second, /"changed": false/)
  assert.equal(frontmatter.stage, 'planning')
  assert.equal(frontmatter.phase, 'phase1_discovery')
  assert.equal(body, 'Body stays.\n')
})

test('recovery shim does not clobber active implementing project', () => {
  const repoRoot = makeRepo()
  const projectDir = writeProject(repoRoot, 'alpha', 'implementing', ['T123'])

  const output = execFileSync('node', [script], { cwd: repoRoot, encoding: 'utf8' })
  const restored = readMarkdownFrontmatter(path.join(projectDir, 'project.md')).frontmatter
  assert.equal(restored.stage, 'implementing')
  assert.deepEqual(restored.active_tasks, ['T123'])
  assert.match(output, /"changed": false/)
})

test('multi-project recovery requires explicit slug', () => {
  const repoRoot = makeRepo()
  writeProject(repoRoot, 'alpha', 'planning', [])
  writeProject(repoRoot, 'beta', 'planning', [])

  assert.throws(() => execFileSync('node', [script], { cwd: repoRoot, encoding: 'utf8' }), /multiple projects exist; pass --project <slug>/)
  const output = execFileSync('node', [script, '--project', 'beta'], { cwd: repoRoot, encoding: 'utf8' })
  assert.match(output, /"projectSlug": "beta"/)
})

test('multi-project recovery uses active pointer when present', () => {
  const repoRoot = makeRepo()
  writeProject(repoRoot, 'alpha', 'planning', [])
  writeProject(repoRoot, 'beta', 'planning', [])
  writeActiveProjectSlug(repoRoot, 'beta')

  const output = execFileSync('node', [script], { cwd: repoRoot, encoding: 'utf8' })
  assert.match(output, /"projectSlug": "beta"/)
})

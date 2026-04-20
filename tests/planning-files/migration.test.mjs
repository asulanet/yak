import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { migrateProjectFrontmatter, readMarkdownFrontmatter } from '../../yak/plugins/planning-files/session-store.js'

test('legacy project frontmatter upgrades to full schema', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-migration-'))
  const projectDir = path.join(repoRoot, '.agents', 'yak', 'projects', 'alpha')
  fs.mkdirSync(projectDir, { recursive: true })
  const projectPath = path.join(projectDir, 'project.md')
  fs.writeFileSync(projectPath, '---\nproject_slug: "alpha"\nstage: "planning"\n---\nlegacy body\n')

  const result = migrateProjectFrontmatter({ projectDir })
  const { frontmatter, body } = readMarkdownFrontmatter(projectPath)

  assert.equal(result.migrated, true)
  assert.equal(frontmatter.phase, 'phase1_discovery')
  assert.equal(frontmatter.subphase, 'discovery')
  assert.equal(frontmatter.execution_authorized, false)
  assert.equal(body, 'legacy body\n')
})

test('migration is idempotent', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-migration-'))
  const projectDir = path.join(repoRoot, '.agents', 'yak', 'projects', 'alpha')
  fs.mkdirSync(projectDir, { recursive: true })
  const projectPath = path.join(projectDir, 'project.md')
  fs.writeFileSync(projectPath, '---\nproject_slug: "alpha"\n---\nbody\n')

  const first = migrateProjectFrontmatter({ projectDir })
  const firstBytes = fs.readFileSync(projectPath, 'utf8')
  const second = migrateProjectFrontmatter({ projectDir })
  const secondBytes = fs.readFileSync(projectPath, 'utf8')

  assert.equal(first.migrated, true)
  assert.equal(second.migrated, false)
  assert.equal(firstBytes, secondBytes)
})

test('unknown passthrough keys are preserved and body stays untouched', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-migration-'))
  const projectDir = path.join(repoRoot, '.agents', 'yak', 'projects', 'alpha')
  fs.mkdirSync(projectDir, { recursive: true })
  const projectPath = path.join(projectDir, 'project.md')
  const body = 'line 1\n---\nline 2\n'
  fs.writeFileSync(projectPath, `---\nproject_slug: "alpha"\ncustom_flag: true\nowner: "me"\n---\n${body}`)

  const result = migrateProjectFrontmatter({ projectDir })
  const loaded = readMarkdownFrontmatter(projectPath)

  assert.equal(result.migrated, true)
  assert.deepEqual(result.preservedKeys.sort(), ['custom_flag', 'owner'])
  assert.equal(loaded.frontmatter.custom_flag, true)
  assert.equal(loaded.frontmatter.owner, 'me')
  assert.equal(loaded.body, body)
})

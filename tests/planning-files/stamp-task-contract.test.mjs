import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { readMarkdownFrontmatter, stampTaskContract } from '../../yak/plugins/planning-files/session-store.js'

function makeProjectDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-stamp-'))
  const projectDir = path.join(root, '.agents', 'yak', 'projects', 'alpha')
  fs.mkdirSync(path.join(projectDir, 'tasks'), { recursive: true })
  return projectDir
}

test('stampTaskContract writes valid task contract', () => {
  const projectDir = makeProjectDir()
  const result = stampTaskContract({
    projectDir,
    taskId: 'T006',
    roleHint: 'implementer',
    complexity: 'medium',
    domainHint: 'planning-files',
    expectedPaths: ['yak/plugins/planning-files.js'],
    protectedPaths: ['.agents/yak/projects/alpha/tasks/T006.md'],
    allowedEphemeralPaths: [],
    allowedShellCommandForms: ['node --test'],
    requiredForAcceptance: ['tests/planning-files/stamp-task-contract.test.mjs'],
    inputs: ['template', 'values'],
    outputs: ['tasks/T006.md'],
    acceptanceCriteria: ['writes contract'],
    dependsOn: ['T003'],
    escalationRules: ['stop on drift'],
    testStrategy: 'unit',
    title: 'Task contract stamping helper',
    goal: 'Create canonical task contract files.',
  })

  const loaded = readMarkdownFrontmatter(result.taskPath)
  assert.equal(loaded.frontmatter.task_id, 'T006')
  assert.equal(loaded.frontmatter.role_hint, 'implementer')
  assert.deepEqual(loaded.frontmatter.required_for_acceptance, ['tests/planning-files/stamp-task-contract.test.mjs'])
  assert.match(loaded.body, /# T006 — Task contract stamping helper/)
  assert.match(loaded.body, /Create canonical task contract files\./)
})

test('stampTaskContract resolves template relative to module dir', () => {
  const projectDir = makeProjectDir()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-cwd-'))
  const originalCwd = process.cwd()
  process.chdir(cwd)

  try {
    const result = stampTaskContract({
      projectDir,
      taskId: 'T010',
      expectedPaths: [],
      protectedPaths: [],
      allowedEphemeralPaths: [],
      allowedShellCommandForms: ['node --test'],
      requiredForAcceptance: [],
      title: 'Portable template lookup',
      goal: 'Works from any cwd.',
    })

    const loaded = readMarkdownFrontmatter(result.taskPath)
    assert.equal(loaded.frontmatter.task_id, 'T010')
    assert.match(loaded.body, /# T010 — Portable template lookup/)
  } finally {
    process.chdir(originalCwd)
  }
})

test('stampTaskContract rejects invalid frontmatter inputs', () => {
  const projectDir = makeProjectDir()
  assert.throws(() => stampTaskContract({
    projectDir,
    taskId: 'T007',
    expectedPaths: [],
    protectedPaths: [],
    allowedEphemeralPaths: [],
    allowedShellCommandForms: [],
    requiredForAcceptance: 'nope',
    title: 'Bad',
    goal: 'Bad input',
  }), /Task spec field must be an array: required_for_acceptance/)
})

test('stampTaskContract refuses overwrite without flag', () => {
  const projectDir = makeProjectDir()
  stampTaskContract({ projectDir, taskId: 'T008', expectedPaths: [], protectedPaths: [], allowedEphemeralPaths: [], allowedShellCommandForms: [], title: 'First', goal: 'First', requiredForAcceptance: [] })
  assert.throws(() => stampTaskContract({ projectDir, taskId: 'T008', expectedPaths: [], protectedPaths: [], allowedEphemeralPaths: [], allowedShellCommandForms: [], title: 'Second', goal: 'Second', requiredForAcceptance: [] }), /already exists/i)
})

test('stampTaskContract overwrites when requested', () => {
  const projectDir = makeProjectDir()
  stampTaskContract({ projectDir, taskId: 'T009', expectedPaths: [], protectedPaths: [], allowedEphemeralPaths: [], allowedShellCommandForms: [], title: 'First', goal: 'First', requiredForAcceptance: [] })
  stampTaskContract({ projectDir, taskId: 'T009', expectedPaths: [], protectedPaths: [], allowedEphemeralPaths: [], allowedShellCommandForms: [], title: 'Second', goal: 'Second', requiredForAcceptance: [], overwrite: true })
  const loaded = readMarkdownFrontmatter(path.join(projectDir, 'tasks', 'T009.md'))
  assert.match(loaded.body, /# T009 — Second/)
})

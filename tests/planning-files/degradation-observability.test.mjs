import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  summarizeDegradations,
  writeMarkdownFrontmatter,
  writeReviewsDegradationSection,
} from '../../yak/plugins/planning-files/session-store.js'
import { buildReviewPacket } from '../../yak/plugins/planning-files/review-routing.js'

test('summarizeDegradations returns empty list when no events', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-files-'))
  fs.mkdirSync(path.join(projectDir, 'tasks'), { recursive: true })

  assert.deepEqual(summarizeDegradations({ projectDir }), [])
})

test('summarizeDegradations returns one entry per degraded task', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-files-'))
  const tasksDir = path.join(projectDir, 'tasks')
  fs.mkdirSync(tasksDir, { recursive: true })

  writeMarkdownFrontmatter(path.join(tasksDir, 'T1.md'), {
    task_id: 'T1',
    degraded_from: { presetName: 'gpt-5-mini', reason: 'quota' },
    effective_model: { presetName: 'gpt-5' },
  }, 'body')
  writeMarkdownFrontmatter(path.join(tasksDir, 'T2.md'), {
    task_id: 'T2',
  }, 'body')

  assert.deepEqual(summarizeDegradations({ projectDir }), [
    { task_id: 'T1', from: 'gpt-5-mini', to: 'gpt-5', reason: 'quota' },
  ])
})

test('writeReviewsDegradationSection is idempotent', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-files-'))
  const reviewsPath = path.join(projectDir, 'reviews.md')
  fs.writeFileSync(reviewsPath, '# Reviews\n')

  const events = [{ task_id: 'T1', from: 'a', to: 'b', reason: 'quota' }]
  writeReviewsDegradationSection({ projectDir, events })
  const first = fs.readFileSync(reviewsPath, 'utf8')
  writeReviewsDegradationSection({ projectDir, events })
  const second = fs.readFileSync(reviewsPath, 'utf8')

  assert.equal(first, second)
})

test('buildReviewPacket carries degradationSummary through', () => {
  const packet = buildReviewPacket({
    taskSpecPath: '/tmp/task.md',
    planReferences: [],
    report: {},
    changedFiles: [],
    diffSummary: '',
    verificationOutput: '',
    taskPathRules: {},
    revisionBinding: 'rev-1',
    degradationEvents: [{ task_id: 'T1', from: 'a', to: 'b', reason: 'quota' }],
  })

  assert.deepEqual(packet.degradationSummary, [{ task_id: 'T1', from: 'a', to: 'b', reason: 'quota' }])
})

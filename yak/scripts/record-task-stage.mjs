#!/usr/bin/env node
import path from 'path'
import { findNearestGitRoot } from '../plugins/planning-files/root-resolution.js'
import { getProjectDir, listProjects, projectExists, readActiveProjectSlug, recordTaskStage, sanitizeProjectSlug } from '../plugins/planning-files/session-store.js'

function parseArgs(argv) {
  const positional = []
  let taskId = null
  let stage = null
  let note = null
  let projectSlug = null
  let repoArg = null
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--task' || arg === '-t') { taskId = argv[++i] || null; continue }
    if (arg === '--stage' || arg === '-s') { stage = argv[++i] || null; continue }
    if (arg === '--note' || arg === '-n') { note = argv[++i] || null; continue }
    if (arg === '--project' || arg === '-p') { projectSlug = argv[++i] || null; continue }
    if (arg === '--repo-root' || arg === '--repo') { repoArg = argv[++i] || null; continue }
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: record-task-stage --task <T###> --stage <stage> [--note "<text>"] [--project <slug>] [--repo-root <path>]')
      process.exit(0)
    }
    positional.push(arg)
  }
  return { taskId, stage, note, projectSlug, repoArg: repoArg || positional[0] || null }
}

function resolveProjectDir({ repoRoot, projectSlug }) {
  const projects = listProjects(repoRoot)
  if (projects.length === 0) throw new Error(`record-task-stage: no projects under ${path.join(repoRoot, '.agents', 'yak', 'projects')}`)
  let targetSlug = projectSlug ? sanitizeProjectSlug(projectSlug) : null
  if (!targetSlug) {
    if (projects.length === 1) targetSlug = projects[0]
    else {
      const activeSlug = readActiveProjectSlug(repoRoot)
      if (activeSlug && projectExists(repoRoot, activeSlug)) targetSlug = activeSlug
      else throw new Error('record-task-stage: multiple projects exist; pass --project <slug>')
    }
  }
  if (!projectExists(repoRoot, targetSlug)) throw new Error(`record-task-stage: project not found: ${targetSlug}`)
  return { projectSlug: targetSlug, projectDir: getProjectDir(repoRoot, targetSlug) }
}

const { taskId, stage, note, projectSlug, repoArg } = parseArgs(process.argv.slice(2))
if (!taskId) throw new Error('record-task-stage: --task <T###> required')
if (!stage) throw new Error('record-task-stage: --stage <stage> required')

const cwd = process.cwd()
const repoRoot = repoArg ? path.resolve(repoArg) : (findNearestGitRoot(cwd) || cwd)
const { projectSlug: resolvedSlug, projectDir } = resolveProjectDir({ repoRoot, projectSlug })
const result = recordTaskStage({ projectDir, taskId, stage, note })
console.log(JSON.stringify({ repoRoot, projectSlug: resolvedSlug, ...result }, null, 2))

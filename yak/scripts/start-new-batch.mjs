#!/usr/bin/env node
// Yak CLI: start-new-batch
//
// Thin renderer over T009's planTransition() for dry-run; delegates to
// startNewBatch() for real runs. Does NOT re-compute the transition plan
// locally — single source of truth is the planner export.
//
// Usage:
//   node yak/scripts/start-new-batch.mjs --summary "<text>"
//   node yak/scripts/start-new-batch.mjs --summary "<text>" --policy carry
//   node yak/scripts/start-new-batch.mjs --dry-run
//   node yak/scripts/start-new-batch.mjs --recover
//   node yak/scripts/start-new-batch.mjs --help
import path from 'path'
import fs from 'fs'
import { findNearestGitRoot } from '../plugins/planning-files/root-resolution.js'
import {
  BatchCancelledError,
  IncompleteTasksError,
  getProjectDir,
  listProjects,
  planTransition,
  projectExists,
  readActiveProjectSlug,
  recoverInterruptedBatchTransition,
  sanitizeProjectSlug,
  startNewBatch,
} from '../plugins/planning-files/session-store.js'

const ACCEPTED_POLICIES = new Set(['abandon', 'carry', 'cancel'])

function printHelp() {
  console.log(`Usage: start-new-batch [flags]

Flags:
  --summary "<text>"   Required for real runs. 1-5 line summary of closing batch.
  --policy <name>      Optional. One of: abandon | carry | cancel.
                       Required when prior batch has incomplete (non-done/non-rejected) tasks.
  --dry-run            Plan the transition without mutating anything. Prints the plan,
                       including planned moves (tasks/, tasks.md, execution-snapshot.md,
                       reviews/, reviews.md) and the journal payload that would be written.
  --recover            Detect and recover from a leftover interrupted transition.
                       Idempotent; safe to run when nothing is in flight.
  --project <slug>     Optional. Defaults to the workspace's active project.
  --repo-root <path>   Optional. Defaults to the nearest git root from CWD.
  --help, -h           Show this help.

Examples:
  # Dry-run the plan for the current project:
  node yak/scripts/start-new-batch.mjs --dry-run

  # Real run, carrying any incomplete tasks:
  node yak/scripts/start-new-batch.mjs --summary "Migration complete" --policy carry

  # Real run, abandoning incomplete tasks:
  node yak/scripts/start-new-batch.mjs --summary "Shipped batch 1" --policy abandon

  # Recover from a crashed transition:
  node yak/scripts/start-new-batch.mjs --recover
`)
}

function parseArgs(argv) {
  const opts = { summary: null, policy: null, dryRun: false, recover: false, projectSlug: null, repoArg: null, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--summary') { opts.summary = argv[++i] || null; continue }
    if (arg === '--policy') { opts.policy = argv[++i] || null; continue }
    if (arg === '--dry-run') { opts.dryRun = true; continue }
    if (arg === '--recover') { opts.recover = true; continue }
    if (arg === '--project' || arg === '-p') { opts.projectSlug = argv[++i] || null; continue }
    if (arg === '--repo-root' || arg === '--repo') { opts.repoArg = argv[++i] || null; continue }
    if (arg === '--help' || arg === '-h') { opts.help = true; continue }
  }
  return opts
}

function resolveProjectDir({ repoRoot, projectSlug }) {
  const projects = listProjects(repoRoot)
  if (projects.length === 0) throw new Error(`start-new-batch: no projects under ${path.join(repoRoot, '.agents', 'yak', 'projects')}`)
  let targetSlug = projectSlug ? sanitizeProjectSlug(projectSlug) : null
  if (!targetSlug) {
    if (projects.length === 1) targetSlug = projects[0]
    else {
      const activeSlug = readActiveProjectSlug(repoRoot)
      if (activeSlug && projectExists(repoRoot, activeSlug)) targetSlug = activeSlug
      else throw new Error('start-new-batch: multiple projects exist; pass --project <slug>')
    }
  }
  if (!projectExists(repoRoot, targetSlug)) throw new Error(`start-new-batch: project not found: ${targetSlug}`)
  return { projectSlug: targetSlug, projectDir: getProjectDir(repoRoot, targetSlug) }
}

function formatDryRun(plan, projectDir) {
  const lines = []
  lines.push(`# Batch transition plan (dry-run)`)
  lines.push(``)
  lines.push(`- Closing batch: ${plan.closing_batch}`)
  lines.push(`- Opening batch: ${plan.new_batch}`)
  lines.push(`- Policy: ${plan.policy || '(not set — will throw on incomplete tasks)'}`)
  lines.push(``)
  lines.push(`## Planned moves (${plan.planned_moves.length})`)
  for (const move of plan.planned_moves) {
    lines.push(`- ${move.src} → ${move.dst} (${move.kind})`)
  }
  lines.push(``)
  lines.push(`## Planned frontmatter resets`)
  for (const [k, v] of Object.entries(plan.planned_resets)) {
    lines.push(`- ${k}: ${JSON.stringify(v)}`)
  }
  lines.push(``)
  lines.push(`## Incomplete tasks (${plan.incomplete_tasks.length})`)
  if (plan.incomplete_tasks.length === 0) {
    lines.push(`(none)`)
  } else {
    for (const t of plan.incomplete_tasks) {
      lines.push(`- ${t.task_id} (stage=${t.stage})`)
    }
  }
  lines.push(``)
  lines.push(`## Journal + staging`)
  lines.push(`- Journal path: ${plan.journal_path}`)
  lines.push(`- Staging dir: ${plan.staging_dir}`)
  lines.push(`- Journal status at commit start: "prepared"`)
  lines.push(``)
  lines.push(`(dry-run — no filesystem mutations performed)`)
  return lines.join('\n')
}

function checkLeftoverJournal(projectDir) {
  const journalPath = path.join(projectDir, '.batch-transition-journal.json')
  if (!fs.existsSync(journalPath)) return null
  try { return JSON.parse(fs.readFileSync(journalPath, 'utf8')) } catch { return { status: 'unreadable' } }
}

const opts = parseArgs(process.argv.slice(2))
if (opts.help) { printHelp(); process.exit(0) }
if (opts.policy && !ACCEPTED_POLICIES.has(opts.policy)) {
  console.error(`start-new-batch: invalid --policy "${opts.policy}". Accepted: ${[...ACCEPTED_POLICIES].join(' | ')}`)
  process.exit(1)
}
if (!opts.dryRun && !opts.recover && !opts.summary) {
  console.error('start-new-batch: --summary "<text>" is required unless --dry-run or --recover is passed.')
  process.exit(1)
}

const cwd = process.cwd()
const repoRoot = opts.repoArg ? path.resolve(opts.repoArg) : (findNearestGitRoot(cwd) || cwd)
const { projectDir } = resolveProjectDir({ repoRoot, projectSlug: opts.projectSlug })

if (opts.recover) {
  const result = recoverInterruptedBatchTransition({ projectDir })
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.recovered || result.reason === 'no-transition-in-flight' ? 0 : 1)
}

const leftover = checkLeftoverJournal(projectDir)

if (opts.dryRun) {
  if (leftover) {
    console.error(`WARNING: leftover batch transition journal present (status=${leftover.status || 'unknown'}). Run --recover first; otherwise the real-run will be blocked.`)
  }
  const plan = planTransition({ projectDir, summary: opts.summary, incompleteTaskPolicy: opts.policy })
  console.log(formatDryRun(plan, projectDir))
  process.exit(0)
}

try {
  const result = startNewBatch({ projectDir, summary: opts.summary, incompleteTaskPolicy: opts.policy })
  console.log(JSON.stringify({ status: 'ok', ...result }, null, 2))
  process.exit(0)
} catch (err) {
  if (err instanceof IncompleteTasksError) {
    console.error(`Incomplete tasks at batch boundary. Re-run with --policy <abandon|carry|cancel>.`)
    console.error(`Affected: ${err.incompleteTasks.map((t) => `${t.task_id}(${t.stage})`).join(', ')}`)
    process.exit(1)
  }
  if (err instanceof BatchCancelledError) {
    console.error(`Batch transition cancelled.`)
    process.exit(1)
  }
  console.error(`start-new-batch: ${err.message}`)
  process.exit(1)
}

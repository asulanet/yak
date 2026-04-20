import path from 'path'
import { findNearestGitRoot } from '../plugins/planning-files/root-resolution.js'
import { listProjects, migrateProjectFrontmatter, projectExists, readActiveProjectSlug, recoverProjectState, sanitizeProjectSlug, getProjectDir } from '../plugins/planning-files/session-store.js'

function parseArgs(argv) {
  const positional = []
  let projectSlug = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--project' || arg === '-p') { projectSlug = argv[++i] || null; continue }
    positional.push(arg)
  }
  return { repoArg: positional[0] || null, projectSlug: projectSlug || positional[1] || null }
}

const { repoArg, projectSlug } = parseArgs(process.argv.slice(2))
const cwd = process.cwd()
const repoRoot = repoArg ? path.resolve(repoArg) : findNearestGitRoot(cwd)
if (!repoRoot) throw new Error('recover-project: no git repo found; pass repo path')

const projects = listProjects(repoRoot)
if (projects.length === 0) throw new Error(`recover-project: no projects under ${path.join(repoRoot, '.agents', 'yak', 'projects')}`)

let targetSlug = projectSlug ? sanitizeProjectSlug(projectSlug) : null
if (!targetSlug) {
  if (projects.length === 1) targetSlug = projects[0]
  else {
    const activeSlug = readActiveProjectSlug(repoRoot)
    if (activeSlug && projectExists(repoRoot, activeSlug)) targetSlug = activeSlug
    else throw new Error(`recover-project: multiple projects exist; pass --project <slug>`)
  }
}
if (!projectExists(repoRoot, targetSlug)) throw new Error(`recover-project: project not found: ${targetSlug}`)

const projectDir = getProjectDir(repoRoot, targetSlug)
const result = recoverProjectState({ repoRoot, projectDir })
migrateProjectFrontmatter({ projectDir })
console.log(JSON.stringify({ repoRoot, projectSlug: targetSlug, ...result }, null, 2))

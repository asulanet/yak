import fs from 'fs'
import path from 'path'

export function normalizePath(input) {
  if (!input || typeof input !== 'string') return null
  return path.resolve(input)
}

export function resolveRealPath(input) {
  return fs.realpathSync.native(normalizePath(input))
}

export function resolvePathWithinRoot(rootDir, candidatePath) {
  const root = resolveRealPath(rootDir)
  const absoluteCandidate = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(root, candidatePath)

  if (fs.existsSync(absoluteCandidate)) {
    return resolveRealPath(absoluteCandidate)
  }

  const missingSegments = []
  let current = absoluteCandidate

  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) break
    missingSegments.unshift(path.basename(current))
    current = parent
  }

  const resolvedBase = fs.existsSync(current) ? resolveRealPath(current) : absoluteCandidate
  return missingSegments.length > 0 ? path.join(resolvedBase, ...missingSegments) : resolvedBase
}

export function findNearestGitRoot(startDir) {
  const start = resolveRealPath(startDir)
  let current = start

  while (true) {
    const gitPath = path.join(current, '.git')
    if (fs.existsSync(gitPath)) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  return null
}

export function assertInsideRoot(rootDir, candidatePath) {
  try {
    const root = resolveRealPath(rootDir)
    const candidate = resolvePathWithinRoot(root, candidatePath)
    const relative = path.relative(root, candidate)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  } catch {
    return false
  }
}

export function ensureInsideRoot(rootDir, candidatePath) {
  const root = resolveRealPath(rootDir)
  const candidate = resolvePathWithinRoot(root, candidatePath)
  const relative = path.relative(root, candidate)
  if (!(relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)))) {
    throw new Error(`Path escapes repo root: ${candidatePath}`)
  }
  return candidate
}

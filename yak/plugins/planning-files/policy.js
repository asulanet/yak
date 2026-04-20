import path from 'path'

import { ensureInsideRoot } from './root-resolution.js'

const PLANNING_STAGES = new Set(['planning', 'awaiting_approval'])
const OPEN_STAGES = new Set(['implementing', 'validating'])
const EXPLORATION_STAGES = new Set(['exploration'])
const PLANNING_DENIED_TOOLS = new Set(['rm', 'ast_grep_replace', 'lsp_rename'])
const KNOWN_MUTATING_TOOLS = new Set([
  'write',
  'edit',
  'apply_patch',
  'mkdir',
  'rm',
  'ast_grep_replace',
  'lsp_rename',
  'bash',
  'shell',
])
const FILE_ARG_KEYS = ['path', 'filePath', 'oldPath', 'newPath']
const YAK_CONTROL_FILES = new Set(['project.md', 'context.md', 'backlog.md', 'findings.md', 'progress.md', 'tasks.md', 'reviews.md', 'execution-snapshot.md'])

export function isPlanningStage(stage) {
  return PLANNING_STAGES.has(stage)
}

export function isOpenStage(stage) {
  return OPEN_STAGES.has(stage)
}

export function isExplorationStage(stage) {
  return EXPLORATION_STAGES.has(stage)
}

export function isDeniedPlanningTool(toolName) {
  return PLANNING_DENIED_TOOLS.has(toolName)
}

export function isMutatingTool(toolName) {
  return KNOWN_MUTATING_TOOLS.has(toolName)
}

export function isAllowedReadonlyShell(command, allowlist = []) {
  const normalized = String(command || '').trim()
  return isAllowedReadonlyGhCommand(normalized) || allowlist.some((allowed) => normalized === allowed || normalized.startsWith(`${allowed} `))
}

function isAllowedReadonlyGhCommand(command) {
  const normalized = String(command || '').trim()
  if (!normalized.startsWith('gh ')) return false

  if (/^gh\s+pr\s+view(?:\s|$)/.test(normalized)) return true
  if (/^gh\s+repo\s+view(?:\s|$)/.test(normalized)) return true

  if (!/^gh\s+api\s+graphql(?:\s|$)/.test(normalized)) return false
  if (/\b(--method|-X)\s*(POST|PUT|PATCH|DELETE)\b/i.test(normalized)) return false
  if (/(?:^|\s)--input(?:=|\s|$)/.test(normalized)) return false
  if (/(?:^|\s)(?:-f|-F|--field|--raw-field)\s+\S+=@/.test(normalized)) return false
  if (/(?:^|\s)(?:--field|--raw-field)=\S+=@/.test(normalized)) return false
  if (!/(?:^|\s)(?:-f|-F|--field|--raw-field)\s+query=/.test(normalized)) return false
  if (/\bmutation\b/i.test(normalized)) return false
  return true
}

export function hasForbiddenShellSyntax(command) {
  return isBlacklistedShellCommand(command)
}

export function isReadonlyToolRequest(toolName, args = {}, allowlist = []) {
  if (!toolName) return false
  if (toolName === 'bash' || toolName === 'shell') {
    const command = typeof args.command === 'string' ? args.command : ''
    if (!command || hasForbiddenShellSyntax(command)) return false
    return isAllowedReadonlyShell(command, allowlist) || isAllowedTestRunnerCommand(command)
  }
  return !isMutatingTool(toolName)
}

function stripQuotedSegments(command) {
  let result = ''
  let quote = null
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    const previous = index > 0 ? command[index - 1] : ''
    if (!quote) {
      if (char === '\'' || char === '"') {
        quote = char
        result += ' '
        continue
      }
      result += char
      continue
    }

    if (char === quote && (quote === '\'' || previous !== '\\')) {
      quote = null
      result += ' '
      continue
    }

    result += ' '
  }
  return result
}

export function isBlacklistedShellCommand(command) {
  const normalized = String(command || '').trim()
  const syntaxChecked = stripQuotedSegments(normalized)
  return [
    /\$\(/.test(syntaxChecked),
    /`/.test(syntaxChecked),
    /&&|\|\||;/.test(syntaxChecked),
    /[\r\n]/.test(syntaxChecked),
    /(?<!\|)\|(?!\|)/.test(syntaxChecked),
    /<\(/.test(syntaxChecked),
    />\(/.test(syntaxChecked),
    /(^|\s)(>|>>|<)(\s|$)/.test(syntaxChecked),
    /<<-?/.test(syntaxChecked),
    /(^|\s)(tee|sponge)\b/.test(normalized),
    /\bdd\s+of=/.test(normalized),
    /(^|\s)find\s+.*-delete\b/.test(normalized),
    /(^|\s)(install|cp|mv|rm|mkdir|touch|ln|truncate|chmod|chown)\b/.test(normalized),
    /(^|\s)sed\s+-n\b.*\d*w\s+\S/.test(normalized),
    /(^|\s)(sed\s+-i|perl\s+-pi|ruby\s+-pi|awk\s+-i\s+inplace)\b/.test(normalized),
    /(^|\s)(sh\s+-c|bash\s+-c|bash\s+-lc|zsh\s+-c|xargs\s+sh\s+-c)\b/.test(normalized),
    /(^|\s)(python\s+-c|python3\s+-c|node\s+-e|perl\s+-e|ruby\s+-e|php\s+-r)\b/.test(normalized),
    /(^|\s)git\s+diff\b.*--output=/.test(normalized),
    /(^|\s)rg\b.*--pre\b/.test(normalized),
    /(^|\s)kubectl\s+(apply|edit|patch|delete)\b/.test(normalized),
    /(^|\s)helm\s+(install|upgrade|uninstall)\b/.test(normalized),
    /(^|\s)terraform\s+(apply|destroy|import|taint|state\b)/.test(normalized),
    /(^|\s)(npm|pnpm|yarn)\s+(install|add|remove|update|publish)\b/.test(normalized),
    /(^|\s)pip\s+install\b/.test(normalized),
    /(^|\s)gem\s+install\b/.test(normalized),
    /(^|\s)find\s+.*-exec\s/.test(normalized),
  ].some(Boolean)
}

function matchesAny(command, patterns) {
  return patterns.some((pattern) => pattern.test(command))
}

export function isBlockedOrchestratorShellCommand(command) {
  const normalized = String(command || '').trim()
  if (!normalized) return false
  const syntaxChecked = stripQuotedSegments(normalized)
  if (matchesAny(syntaxChecked, [/\|\s*(?:sh|bash|zsh)(?:\s|$)/])) return true

  return matchesAny(normalized, [
    /(^|\s)git\s+push\b/,
    /(^|\s)(npm|pnpm|yarn|bun)\s+(install|add|remove|update|publish)\b/,
    /(^|\s)pip\s+install\b/,
    /(^|\s)gem\s+install\b/,
    /(^|\s)terraform\s+(apply|destroy|import|taint|state\b)/,
    /(^|\s)kubectl\s+(apply|edit|patch|delete)\b/,
    /(^|\s)helm\s+(install|upgrade|uninstall)\b/,
    /(^|\s)gh\s+(pr\s+(comment|review|merge|create|edit|close|reopen)|issue\s+(comment|edit|close|reopen)|release\s+(create|edit|delete))\b/,
    /(^|\s)gh\s+api\b(?!\s+graphql)(?=.*(?:^|\s)(?:-f|-F|--field|--raw-field)(?:\s|=))/i,
    /(^|\s)gh\s+api\b(?=.*(?:\b(?:--method|-X)\s*(POST|PUT|PATCH|DELETE)\b|\b--method=(POST|PUT|PATCH|DELETE)\b|\s-X(?:POST|PUT|PATCH|DELETE)\b))/i,
    /(^|\s)gh\s+api\b(?=.*\bmutation\b)/i,
  ])
}

export function isAllowedTestRunnerCommand(command) {
  const normalized = String(command || '').trim()
  return [
    'pnpm test',
    'pnpm vitest',
    'pnpm jest',
    'npm test',
    'yarn test',
    'npx vitest',
    'npx jest',
  ].some((allowed) => normalized === allowed || normalized.startsWith(`${allowed} `)) || /^pnpm\stest:[^\s]+(?:\s|$)/.test(normalized)
}

export function extractCandidatePaths(args = {}) {
  return FILE_ARG_KEYS
    .map((key) => args[key])
    .filter((value) => typeof value === 'string' && value.trim())
}

export function extractScopedToolTargets(args = {}) {
  const values = []
  for (const key of ['path', 'filePath']) {
    if (typeof args[key] === 'string' && args[key].trim()) values.push(args[key])
  }
  for (const key of ['paths', 'globs']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) values.push(value)
    if (Array.isArray(value)) values.push(...value.filter((item) => typeof item === 'string' && item.trim()))
  }
  return values
}

function normalizePatchPath(value) {
  if (!value || typeof value !== 'string') return null
  const trimmed = value.trim().replace(/^a\//, '').replace(/^b\//, '')
  if (!trimmed || trimmed === '/dev/null') return null
  return trimmed
}

export function parseApplyPatchPaths(patchText) {
  const text = String(patchText || '')
  const paths = []
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const fileMatch = line.match(/^\*\*\*\s+(Add|Update|Delete) File:\s*(.*)$/)
    if (fileMatch) {
      const [, , rest] = fileMatch
      const nextPath = normalizePatchPath(rest)
      if (nextPath) paths.push(nextPath)
      continue
    }

    const moveMatch = line.match(/^\*\*\*\s+Move to:\s*(.*)$/)
    if (!moveMatch) continue
    const movedPath = normalizePatchPath(moveMatch[1])
    if (movedPath) paths.push(movedPath)
  }

  const renameFrom = text.match(/^rename from\s+(.+)$/m)
  const renameTo = text.match(/^rename to\s+(.+)$/m)
  if (renameFrom?.[1]) paths.push(normalizePatchPath(renameFrom[1]))
  if (renameTo?.[1]) paths.push(normalizePatchPath(renameTo[1]))
  return paths.filter(Boolean)
}

function pathMatchesRoot(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath)
  return rootPath === candidatePath || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function isProtectedRepoRelativePath(relativePath) {
  const normalized = String(relativePath || '').split(path.sep).join('/').replace(/^\.\//, '')
  if (!normalized) return false
  if (normalized === '.git' || normalized.startsWith('.git/') || normalized.includes('/.git/')) return true
  const baseName = path.basename(normalized)
  if (baseName === '.env' || baseName.startsWith('.env')) return true
  if (normalized === '.env' || normalized.startsWith('.env/') || normalized.startsWith('.env.')) return true
  if (normalized.includes('/.env/')) return true
  return normalized.includes('/.env.')
}

export function isYakControlPath(projectDir, filePath) {
  const relative = path.relative(path.resolve(projectDir), path.resolve(filePath))
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false
  const normalized = relative.split(path.sep).join('/')
  if (YAK_CONTROL_FILES.has(normalized)) return true
  return normalized.startsWith('tasks/') || normalized.startsWith('reviews/')
}

export function assertApplyPatchAllowedForWorker({ repoRoot, allowedPaths, forbiddenPaths = [], patchText }) {
  const paths = parseApplyPatchPaths(patchText)
  if (paths.length === 0) throw new Error('apply_patch parse failed: no touched paths found')
  for (const filePath of paths) {
    assertTaskWriteAllowed({ repoRoot, allowedPaths, forbiddenPaths, filePath: path.resolve(repoRoot, filePath) })
  }
}

export function assertApplyPatchAllowedForOrchestrator({ repoRoot, projectDir, patchText }) {
  const paths = parseApplyPatchPaths(patchText)
  if (paths.length === 0) throw new Error('apply_patch parse failed: no touched paths found')
  for (const filePath of paths) {
    if (filePath.includes('..')) throw new Error(`apply_patch escapes repo root: ${filePath}`)
    const resolved = path.resolve(projectDir, filePath)
    const relative = path.relative(path.resolve(repoRoot), resolved)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`apply_patch escapes repo root: ${filePath}`)
    if (isProtectedRepoRelativePath(relative)) throw new Error(`Orchestrator apply_patch blocked protected path: ${filePath}`)
  }
}

export function assertOrchestratorControlWriteAllowed({ repoRoot, filePath, toolName }) {
  const resolved = ensureInsideRoot(repoRoot, filePath)
  const relative = path.relative(path.resolve(repoRoot), resolved)
  if (isProtectedRepoRelativePath(relative)) throw new Error(`Orchestrator ${toolName} blocked protected path: ${filePath}`)
  return resolved
}

export function assertOrchestratorControlMkdirAllowed({ repoRoot, dirPath }) {
  const resolved = ensureInsideRoot(repoRoot, dirPath)
  const relative = path.relative(path.resolve(repoRoot), resolved)
  if (isProtectedRepoRelativePath(relative)) throw new Error(`Orchestrator mkdir blocked protected path: ${dirPath}`)
  return resolved
}

export function assertPlanningWriteAllowed({ repoRoot, projectDir, filePath }) {
  const resolved = ensureInsideRoot(repoRoot, filePath)
  const resolvedProjectDir = ensureInsideRoot(repoRoot, projectDir)
  if (!resolved.endsWith('.md')) throw new Error(`Planning writes limited to markdown: ${filePath}`)
  if (!pathMatchesRoot(resolvedProjectDir, resolved)) throw new Error(`Planning write outside active project dir: ${filePath}`)
  return resolved
}

export function assertTaskWriteAllowed({ repoRoot, allowedPaths, forbiddenPaths = [], filePath }) {
  const resolved = ensureInsideRoot(repoRoot, filePath)
  const relative = path.relative(path.resolve(repoRoot), resolved)
  if (isProtectedRepoRelativePath(relative)) throw new Error(`Task write touches protected path: ${filePath}`)
  const normalizedAllowedPaths = (allowedPaths || []).map((item) => ensureInsideRoot(repoRoot, path.resolve(repoRoot, item)))
  const normalizedForbiddenPaths = (forbiddenPaths || []).map((item) => ensureInsideRoot(repoRoot, path.resolve(repoRoot, item)))

  const forbiddenMatch = normalizedForbiddenPaths.some((forbiddenPath) => pathMatchesRoot(forbiddenPath, resolved))
  if (forbiddenMatch) throw new Error(`Task write touches forbidden path: ${filePath}`)

  const matched = normalizedAllowedPaths.some((allowedPath) => pathMatchesRoot(allowedPath, resolved))
  if (!matched) throw new Error(`Task write outside allowed paths: ${filePath}`)
  return resolved
}

export function assertScopedToolAllowed({ repoRoot, allowedPaths, forbiddenPaths = [], targets, toolName }) {
  if (!Array.isArray(targets) || targets.length === 0) throw new Error(`${toolName} requires explicit path or glob scope`)
  for (const target of targets) {
    assertTaskWriteAllowed({ repoRoot, allowedPaths, forbiddenPaths, filePath: path.resolve(repoRoot, target) })
  }
  return true
}

function isAllowedTaskShell(command, allowlist = []) {
  const normalized = String(command || '').trim()
  if (!allowlist.length) return false
  return allowlist.some((allowed) => normalized === allowed || normalized.startsWith(`${allowed} `))
}

export function assertTaskShellAllowed(command, allowedCommands = []) {
  const normalized = String(command || '').trim()
  if (hasForbiddenShellSyntax(command)) {
    throw new Error(`Task shell command uses forbidden syntax: ${command}`)
  }
  if (!isAllowedTaskShell(command, allowedCommands)) {
    throw new Error(`Task shell command not in approved forms: ${command}`)
  }
  return normalized
}

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  assertPlanningWriteAllowed,
  assertApplyPatchAllowedForOrchestrator,
  assertApplyPatchAllowedForWorker,
  assertOrchestratorControlMkdirAllowed,
  assertOrchestratorControlWriteAllowed,
  assertScopedToolAllowed,
  assertTaskShellAllowed,
  assertTaskWriteAllowed,
  extractCandidatePaths,
  extractScopedToolTargets,
  hasForbiddenShellSyntax,
  isBlockedOrchestratorShellCommand,
  isBlacklistedShellCommand,
  isAllowedReadonlyShell,
  isAllowedTestRunnerCommand,
  isMutatingTool,
  isOpenStage,
} from '../../yak/plugins/planning-files/policy.js'

test('extractCandidatePaths returns known file args only', () => {
  assert.deepEqual(
    extractCandidatePaths({ path: 'a', filePath: 'b', oldPath: '', newPath: 'c', other: 'x' }),
    ['a', 'b', 'c'],
  )
})

test('extractScopedToolTargets returns scoped path inputs', () => {
  assert.deepEqual(
    extractScopedToolTargets({ path: 'src', filePath: 'file.js', paths: ['a', ''], globs: ['*.ts'] }),
    ['src', 'file.js', 'a', '*.ts'],
  )
})

test('planning write limited to markdown inside project dir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-root-'))
  const projectDir = path.join(root, '.agents', 'yak', 'projects', 'p1')
  fs.mkdirSync(projectDir, { recursive: true })
  const note = path.join(projectDir, 'project.md')
  const nonMarkdown = path.join(root, 'src.js')
  fs.writeFileSync(note, '# x')
  fs.writeFileSync(nonMarkdown, 'x')

  assert.equal(assertPlanningWriteAllowed({ repoRoot: root, projectDir, filePath: note }), fs.realpathSync.native(note))
  assert.throws(() => assertPlanningWriteAllowed({ repoRoot: root, projectDir, filePath: nonMarkdown }), /Planning writes limited to markdown:/)
})

test('task write respects allowed and forbidden paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-root-'))
  const realRoot = fs.realpathSync.native(root)
  const allowed = path.join(root, 'src')
  const forbidden = path.join(root, 'src', 'private')
  const ok = path.join(root, 'src', 'ok.js')
  const newFile = path.join(root, 'src', 'new.js')
  const bad = path.join(root, 'src', 'private', 'secret.js')
  fs.mkdirSync(path.dirname(ok), { recursive: true })
  fs.mkdirSync(path.dirname(bad), { recursive: true })
  fs.writeFileSync(ok, 'x')
  fs.writeFileSync(bad, 'x')

  assert.equal(assertTaskWriteAllowed({ repoRoot: root, allowedPaths: [allowed], forbiddenPaths: [forbidden], filePath: ok }), fs.realpathSync.native(ok))
  assert.equal(assertTaskWriteAllowed({ repoRoot: root, allowedPaths: [allowed], forbiddenPaths: [forbidden], filePath: newFile }), path.join(realRoot, 'src', 'new.js'))
  assert.throws(() => assertTaskWriteAllowed({ repoRoot: root, allowedPaths: [allowed], forbiddenPaths: [forbidden], filePath: bad }), /Task write touches forbidden path:/)
})

test('task write hard-blocks git and env paths even with broad scope', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-root-'))
  const envRc = path.join(root, '.envrc')
  const gitConfig = path.join(root, '.git', 'config')
  fs.mkdirSync(path.dirname(gitConfig), { recursive: true })
  fs.writeFileSync(envRc, 'export X=1')
  fs.writeFileSync(gitConfig, '[core]')

  assert.throws(() => assertTaskWriteAllowed({ repoRoot: root, allowedPaths: [root], forbiddenPaths: [], filePath: envRc }), /env|secret|protected/i)
  assert.throws(() => assertTaskWriteAllowed({ repoRoot: root, allowedPaths: [root], forbiddenPaths: [], filePath: gitConfig }), /git|protected/i)
})

test('single pipe is blacklisted and double pipe stays blocked', () => {
  assert.equal(hasForbiddenShellSyntax('cat AGENTS.md | sh'), true)
  assert.equal(hasForbiddenShellSyntax('ls | python'), true)
  assert.equal(hasForbiddenShellSyntax('npm test | sh'), true)
  assert.equal(hasForbiddenShellSyntax('echo foo | bash'), true)
  assert.equal(hasForbiddenShellSyntax('a || b'), true)
  assert.equal(hasForbiddenShellSyntax("gh api graphql -f query='query { viewer { login } }' --jq '{ totalCount: .data | length, unresolved: [.data[] | select(.ok == true)] }'"), false)
})

test('process substitution is blacklisted', () => {
  assert.equal(hasForbiddenShellSyntax('cat <(touch blocked.txt)'), true)
  assert.equal(hasForbiddenShellSyntax('grep foo <(echo hi)'), true)
  assert.equal(hasForbiddenShellSyntax('npm test <(touch blocked.txt)'), true)
  assert.equal(hasForbiddenShellSyntax('diff >(echo hi) foo'), true)
})

test('shell policy helpers enforce blacklist syntax and generic allow', () => {
  assert.equal(isAllowedReadonlyShell('rg foo .', ['rg', 'ls']), true)
  assert.equal(isMutatingTool('write'), true)
  assert.equal(isOpenStage('completed'), false)
  assert.equal(hasForbiddenShellSyntax('ls > out.txt'), true)
  assert.equal(isBlacklistedShellCommand('pnpm build > out.txt'), true)
  assert.equal(isBlacklistedShellCommand('python -c "open(\'x\',\'w\')"'), true)
  assert.equal(isBlacklistedShellCommand("python - <<'PY'\nprint('x')\nPY"), true)
  assert.equal(isBlacklistedShellCommand("python -<<'PY'\nprint('x')\nPY"), true)
  assert.equal(isAllowedTestRunnerCommand('pnpm test:ui -- ClerkAuthProvider.jest.tsx'), true)
  assert.equal(isAllowedTestRunnerCommand('npm test -- auth.spec.ts'), true)
  assert.equal(isAllowedTestRunnerCommand('pnpm build'), false)
  assert.equal(assertTaskShellAllowed('npm test -- auth.spec.ts', ['npm test']), 'npm test -- auth.spec.ts')
  assert.equal(assertTaskShellAllowed('pnpm test:ui -- ClerkAuthProvider.jest.tsx', ['pnpm test:ui']), 'pnpm test:ui -- ClerkAuthProvider.jest.tsx')
  assert.throws(() => assertTaskShellAllowed('go test ./...', []), /Task shell command not in approved forms:/)
  assert.throws(() => assertTaskShellAllowed('cargo test', ['npm test']), /Task shell command not in approved forms:/)
  assert.throws(() => assertTaskShellAllowed('my-custom-alias foo', []), /Task shell command not in approved forms:/)
  assert.throws(() => assertTaskShellAllowed('pnpm build > out.txt', []), /Task shell command uses forbidden syntax:/)
  assert.throws(() => assertTaskShellAllowed('python -c "open(\'x\',\'w\')"', []), /Task shell command uses forbidden syntax:/)
  assert.throws(() => assertTaskShellAllowed('kubectl apply -f x.yaml', []), /Task shell command uses forbidden syntax:/)
  assert.throws(() => assertTaskShellAllowed('terraform apply', []), /Task shell command uses forbidden syntax:/)
  assert.throws(() => assertTaskShellAllowed('pnpm install', []), /Task shell command uses forbidden syntax:/)
  assert.throws(() => assertTaskShellAllowed('sed -i s/a/b/ file.txt', []), /Task shell command uses forbidden syntax:/)
  assert.throws(() => assertTaskShellAllowed("python - <<'PY'\nprint('x')\nPY", []), /Task shell command uses forbidden syntax:/)
  assert.throws(() => assertTaskShellAllowed("python -<<'PY'\nprint('x')\nPY", []), /Task shell command uses forbidden syntax:/)
})

test('planning-stage readonly gh fetch commands are allowed while mutating gh forms stay blocked', () => {
  const planningAllowlist = ['ls', 'find', 'rg', 'grep', 'cat', 'sed -n', 'git status', 'git diff --name-only']

  assert.equal(isAllowedReadonlyShell('gh pr view --json number,url,title,headRefName', planningAllowlist), true)
  assert.equal(isAllowedReadonlyShell("gh repo view --json nameWithOwner --jq '.nameWithOwner'", planningAllowlist), true)
  assert.equal(
    isAllowedReadonlyShell("gh api graphql -f query='query { repository(owner: \"octo\", name: \"hello-world\") { nameWithOwner } }'", planningAllowlist),
    true,
  )
  assert.equal(
    isAllowedReadonlyShell("gh api graphql -f query='query { viewer { login } }' --jq '{ totalCount: .data | length, unresolved: [.data[] | select(.ok == true)] }'", planningAllowlist),
    true,
  )

  assert.equal(isAllowedReadonlyShell('gh pr comment 123 --body hello', planningAllowlist), false)
  assert.equal(isAllowedReadonlyShell("gh api graphql -f query='mutation { addComment(input: {subjectId: \"x\", body: \"hi\"}) { clientMutationId } }'", planningAllowlist), false)
  assert.equal(isAllowedReadonlyShell("gh api graphql -f query='query { viewer { login } }' -F leak=@AGENTS.md", planningAllowlist), false)
  assert.equal(isAllowedReadonlyShell("gh api graphql -f query='query { viewer { login } }' --field=leak=@AGENTS.md", planningAllowlist), false)
  assert.equal(isAllowedReadonlyShell("gh api graphql -f query='query { viewer { login } }' --raw-field=leak=@AGENTS.md", planningAllowlist), false)
  assert.equal(isAllowedReadonlyShell("gh api graphql -f query='query { viewer { login } }' --input body.json", planningAllowlist), false)
  assert.equal(isAllowedReadonlyShell("gh api graphql -f query='query { viewer { login } }' --input=body.json", planningAllowlist), false)
})

test('planning shell gate allows test runner commands in any stage and denies unrelated commands', () => {
  assert.equal(isAllowedTestRunnerCommand('pnpm test:ui -- ClerkAuthProvider.jest.tsx'), true)
  assert.equal(isAllowedTestRunnerCommand('pnpm build'), false)
})

test('orchestrator shell policy is default-allow with targeted blocklist only', () => {
  assert.equal(isBlockedOrchestratorShellCommand("python3 -c 'import json; print(json.dumps({\"ok\": True}))'"), false)
  assert.equal(isBlockedOrchestratorShellCommand("REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner') && gh api graphql -F owner=\"${REPO%/*}\" -F repo=\"${REPO#*/}\" -f query='query { viewer { login } }'"), false)
  assert.equal(isBlockedOrchestratorShellCommand('pnpm install'), true)
  assert.equal(isBlockedOrchestratorShellCommand('gh pr comment 123 --body hello'), true)
  assert.equal(isBlockedOrchestratorShellCommand('gh api repos/o/r/issues -f title=x -f body=y'), true)
  assert.equal(isBlockedOrchestratorShellCommand('git push origin HEAD'), true)
})

test('orchestrator file policy allows repo edits but blocks git and env paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-root-'))
  const projectDir = path.join(root, '.agents', 'yak', 'projects', 'p1')
  const srcFile = path.join(root, 'src', 'ok.js')
  const envFile = path.join(root, '.env')
  const envRcFile = path.join(root, '.envrc')
  const gitFile = path.join(root, '.git', 'config')
  fs.mkdirSync(path.dirname(srcFile), { recursive: true })
  fs.mkdirSync(path.dirname(gitFile), { recursive: true })
  fs.writeFileSync(srcFile, 'x')
  fs.writeFileSync(envFile, 'SECRET=1')
  fs.writeFileSync(envRcFile, 'export X=1')
  fs.writeFileSync(gitFile, '[core]')

  assert.equal(assertOrchestratorControlWriteAllowed({ repoRoot: root, projectDir, filePath: srcFile, toolName: 'write' }), fs.realpathSync.native(srcFile))
  assert.throws(() => assertOrchestratorControlWriteAllowed({ repoRoot: root, projectDir, filePath: envFile, toolName: 'write' }), /env|secret|protected/i)
  assert.throws(() => assertOrchestratorControlWriteAllowed({ repoRoot: root, projectDir, filePath: envRcFile, toolName: 'write' }), /env|secret|protected/i)
  assert.throws(() => assertOrchestratorControlWriteAllowed({ repoRoot: root, projectDir, filePath: gitFile, toolName: 'write' }), /git|protected/i)
  assert.doesNotThrow(() => assertOrchestratorControlMkdirAllowed({ repoRoot: root, projectDir, dirPath: path.join(root, 'tmp') }))
  assert.throws(() => assertOrchestratorControlMkdirAllowed({ repoRoot: root, projectDir, dirPath: path.join(root, '.git', 'hooks') }), /git|protected/i)
})

test('apply_patch path parsing and scope validation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-root-'))
  const projectDir = path.join(root, '.agents', 'yak', 'projects', 'p1')
  const allowed = path.join(root, 'src')
  const forbidden = path.join(root, 'src', 'private')
  fs.mkdirSync(path.join(projectDir, 'tasks'), { recursive: true })
  fs.mkdirSync(path.join(projectDir, 'reviews'), { recursive: true })
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(path.join(root, 'src', 'private'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'ok.js'), 'x')
  fs.writeFileSync(path.join(root, 'src', 'private', 'secret.js'), 'x')
  fs.writeFileSync(path.join(projectDir, 'project.md'), 'x')
  fs.writeFileSync(path.join(projectDir, 'tasks', 'T1.md'), 'x')

  assert.doesNotThrow(() => assertApplyPatchAllowedForOrchestrator({ repoRoot: root, projectDir, patchText: '*** Begin Patch\n*** Update File: project.md\n+hi\n*** End Patch' }))
  assert.throws(() => assertApplyPatchAllowedForOrchestrator({ repoRoot: root, projectDir, patchText: '*** Begin Patch\n*** Update File: ../../src/ok.js\n+hi\n*** End Patch' }), /apply_patch parse failed|limited to Yak project control files|escapes repo root/)

  assert.doesNotThrow(() => assertApplyPatchAllowedForWorker({ repoRoot: root, projectDir, allowedPaths: [allowed], forbiddenPaths: [forbidden], patchText: '*** Begin Patch\n*** Update File: src/ok.js\n+hi\n*** End Patch' }))
  assert.throws(() => assertApplyPatchAllowedForWorker({ repoRoot: root, projectDir, allowedPaths: [allowed], forbiddenPaths: [forbidden], patchText: '*** Begin Patch\n*** Update File: src/private/secret.js\n+hi\n*** End Patch' }), /Task write touches forbidden path:|Task write outside allowed paths:/)
  assert.throws(() => assertApplyPatchAllowedForWorker({ repoRoot: root, projectDir, allowedPaths: [allowed], forbiddenPaths: [forbidden], patchText: '*** Begin Patch\n*** Update File: src/ok.js\n*** Move to: src/private/moved.js\n@@\n-x\n+y\n*** End Patch' }), /Task write touches forbidden path:|Task write outside allowed paths:/)
})

test('scoped tool helper respects allowed and forbidden paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-root-'))
  const allowed = path.join(root, 'src')
  const forbidden = path.join(root, 'src', 'private')
  fs.mkdirSync(path.join(root, 'src', 'private'), { recursive: true })
  fs.mkdirSync(path.join(root, 'src', 'private'), { recursive: true })
  assert.doesNotThrow(() => assertScopedToolAllowed({ repoRoot: root, allowedPaths: [allowed], forbiddenPaths: [forbidden], targets: [path.join(root, 'src', 'ok.ts')], toolName: 'ast_grep_replace' }))
  assert.throws(() => assertScopedToolAllowed({ repoRoot: root, allowedPaths: [allowed], forbiddenPaths: [forbidden], targets: [path.join(root, 'src', 'private', 'secret.ts')], toolName: 'ast_grep_replace' }), /Task write touches forbidden path:/)
  assert.throws(() => assertScopedToolAllowed({ repoRoot: root, allowedPaths: [allowed], forbiddenPaths: [forbidden], targets: [], toolName: 'ast_grep_replace' }), /requires explicit path or glob scope/)
})

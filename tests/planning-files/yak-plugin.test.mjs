import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'

import { YakPlugin as PlanningFilesPlugin } from '../../plugins/yak.js'
import { readMarkdownFrontmatter, writeActiveProjectSlug } from '../../yak/plugins/planning-files/session-store.js'

function makeRepo() { const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-plugin-')); execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' }); return repoRoot }
function withEnv(nextEnv, fn) { const original = { ...process.env }; Object.assign(process.env, nextEnv); return Promise.resolve(fn()).finally(() => { for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, original) }) }
function seedCanonicalProjectArtifacts(projectDir, stage = 'planning') {
  fs.mkdirSync(path.join(projectDir, 'tasks'), { recursive: true })
  fs.mkdirSync(path.join(projectDir, 'reviews'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'project.md'), `---\nstage: ${stage}\n---\n`)
  for (const fileName of ['context.md', 'backlog.md', 'findings.md', 'progress.md', 'tasks.md', 'reviews.md', 'execution-snapshot.md']) fs.writeFileSync(path.join(projectDir, fileName), `${fileName}\n`)
}

test('startup bootstraps default project folder', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-a' } } } })
    const projectRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
    const projects = fs.readdirSync(projectRoot)
    assert.ok(projects.length >= 1)
    assert.equal(projects.some((slug) => fs.existsSync(path.join(projectRoot, slug, 'project.md'))), true)
  })
})

test('child session inherits parent active project slug', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'parent' } } } })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'child', parentID: 'parent' } } } })
    const projectRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
    assert.ok(fs.readdirSync(projectRoot).length >= 1)
  })
})

test('question-tool approvals advance phase gates and freeze execution snapshot', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-gates' } } } })
    const projectRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
    const slug = fs.readdirSync(projectRoot).find((entry) => fs.statSync(path.join(projectRoot, entry)).isDirectory())
    const projectDir = path.join(projectRoot, slug)
    const projectPath = path.join(projectDir, 'project.md')
    fs.writeFileSync(projectPath, '---\nphase: "phase1_discovery"\nsubphase: "scope_draft"\nstage: "planning"\nphase1_revision: 2\nphase2_revision: 0\napproved_task_ids: []\nactive_tasks: ["T1"]\nblocked_task_ids: []\n---\n')

    await plugin.event({ event: { type: 'question.asked', properties: { id: 'phase1-q', sessionID: 'session-gates', questions: [{ header: 'Phase 1 approval', question: 'Approve Phase 1 discovery scope and continue to task creation?', options: [], multiple: false }] } } })
    await plugin.event({ event: { type: 'question.replied', properties: { sessionID: 'session-gates', requestID: 'phase1-q', answers: [['Approve']] } } })

    let project = readMarkdownFrontmatter(projectPath).frontmatter
    assert.equal(project.phase, 'phase2_tasks')
    assert.equal(project.subphase, 'task_graph_draft')
    assert.equal(project.stage, 'planning')
    assert.equal(project.phase1_approved_revision, 2)

    fs.writeFileSync(projectPath, '---\nphase: "phase2_tasks"\nsubphase: "task_review_loop"\nstage: "planning"\nphase1_revision: 2\nphase1_approved_revision: 2\nphase2_revision: 3\napproved_task_ids: ["T1","T2"]\nactive_tasks: ["T1","T2"]\nblocked_task_ids: ["T9"]\n---\n')
    await plugin.event({ event: { type: 'question.asked', properties: { id: 'phase2-q', sessionID: 'session-gates', questions: [{ header: 'Phase 2 approval', question: 'Approve Phase 2 task graph?', options: [], multiple: false }] } } })
    await plugin.event({ event: { type: 'question.replied', properties: { sessionID: 'session-gates', requestID: 'phase2-q', answers: [['Approve']] } } })

    project = readMarkdownFrontmatter(projectPath).frontmatter
    assert.equal(project.phase, 'phase3_execution')
    assert.equal(project.subphase, 'execution_authorization')
    assert.equal(project.stage, 'awaiting_approval')
    assert.equal(project.phase2_approved_revision, 3)

    await plugin.event({ event: { type: 'question.asked', properties: { id: 'exec-q', sessionID: 'session-gates', questions: [{ header: 'Execution approval', question: 'Approve and start coding?', options: [], multiple: false }] } } })
    await plugin.event({ event: { type: 'question.replied', properties: { sessionID: 'session-gates', requestID: 'exec-q', answers: [['Approve and start']] } } })

    project = readMarkdownFrontmatter(projectPath).frontmatter
    assert.equal(project.stage, 'implementing')
    assert.equal(project.subphase, 'dispatch')
    assert.equal(project.execution_authorized, true)
    assert.equal(project.execution_snapshot_revision, 1)

    const snapshot = readMarkdownFrontmatter(path.join(projectDir, 'execution-snapshot.md')).frontmatter
    assert.deepEqual(snapshot.approved_task_ids, ['T1', 'T2'])
    assert.deepEqual(snapshot.blocked_task_ids, ['T9'])
    assert.equal(snapshot.authorized_by_question_id, 'exec-q')
  })
})

test('plan critic offer resolves workflow critic route at phase1 end', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-critic' } } } })
    const projectRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
    const slug = fs.readdirSync(projectRoot).find((entry) => fs.statSync(path.join(projectRoot, entry)).isDirectory())
    const projectDir = path.join(projectRoot, slug)
    const projectPath = path.join(projectDir, 'project.md')
    fs.writeFileSync(projectPath, '---\nphase: "phase1_discovery"\nsubphase: "critic_offer"\nstage: "planning"\nplan_provider: "openai"\nplan_model: "gpt-5.4"\n---\n')

    const offer = plugin.offerPlanCriticForSession('session-critic')
    assert.equal(offer.available, true)
    assert.equal(offer.target.provider, 'anthropic')
    assert.match(offer.prompt, /plan was developed by openai\/gpt-5\.4 model/i)

    const recorded = plugin.recordPlanCriticResultForSession('session-critic', { verdict: 'accepted', summary: 'Critic ok', target: offer.target })
    assert.equal(recorded.verdict, 'accepted')
    const project = readMarkdownFrontmatter(projectPath).frontmatter
    assert.equal(project.critic_status, 'accepted')
    const progress = fs.readFileSync(path.join(projectDir, 'progress.md'), 'utf8')
    assert.match(progress, /Plan critic accepted/)
    assert.match(progress, /Critic ok/)
  })
})

test('plan critic skip path updates status and progress note', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-skip' } } } })
    const projectRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
    const slug = fs.readdirSync(projectRoot).find((entry) => fs.statSync(path.join(projectRoot, entry)).isDirectory())
    const projectDir = path.join(projectRoot, slug)
    const projectPath = path.join(projectDir, 'project.md')
    fs.writeFileSync(projectPath, '---\nphase: "phase1_discovery"\nsubphase: "critic_offer"\nstage: "planning"\ncritic_status: "offered"\n---\n')

    const skipped = plugin.skipPlanCriticForSession('session-skip', { reason: 'manual bypass' })
    assert.equal(skipped.skipped, true)
    assert.equal(skipped.reason, 'manual bypass')

    const project = readMarkdownFrontmatter(projectPath).frontmatter
    assert.equal(project.critic_status, 'skipped')

    const progress = fs.readFileSync(path.join(projectDir, 'progress.md'), 'utf8')
    assert.match(progress, /Plan critic skipped/)
    assert.match(progress, /manual bypass/)
  })
})

test('plan critic offer rejects wrong phase and reports reason', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-no-critic' } } } })
    const projectRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
    const slug = fs.readdirSync(projectRoot).find((entry) => fs.statSync(path.join(projectRoot, entry)).isDirectory())
    const projectDir = path.join(projectRoot, slug)
    fs.writeFileSync(path.join(projectDir, 'project.md'), '---\nphase: "phase2_tasks"\nsubphase: "task_graph_draft"\nstage: "planning"\n---\n')

    const offer = plugin.offerPlanCriticForSession('session-no-critic')
    assert.equal(offer.available, false)
    assert.equal(offer.reason, 'not_at_phase1_critic_offer')
  })
})

test('plan critic offer reports unavailable target when workflow has no critic route', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  fs.mkdirSync(path.join(repoRoot, '.opencode'), { recursive: true })
  fs.writeFileSync(path.join(repoRoot, '.opencode', 'yak.jsonc'), JSON.stringify({ workflow: { model_routes: { critic: { low: 'missing-critic', medium: 'missing-critic', high: 'missing-critic' } } } }))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-no-target' } } } })
    const projectRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
    const slug = fs.readdirSync(projectRoot).find((entry) => fs.statSync(path.join(projectRoot, entry)).isDirectory())
    const projectDir = path.join(projectRoot, slug)
    fs.writeFileSync(path.join(projectDir, 'project.md'), '---\nphase: "phase1_discovery"\nsubphase: "critic_offer"\nstage: "planning"\n---\n')

    const offer = plugin.offerPlanCriticForSession('session-no-target')
    assert.equal(offer.available, false)
    assert.equal(offer.reason, 'no_critic_target')
  })
})

test('full planning-files lifecycle wires critic, gates, and routing together', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-full' } } } })

    const projectRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
    const slug = fs.readdirSync(projectRoot).find((entry) => fs.statSync(path.join(projectRoot, entry)).isDirectory())
    const projectDir = path.join(projectRoot, slug)
    const projectPath = path.join(projectDir, 'project.md')

    fs.writeFileSync(projectPath, '---\nphase: "phase1_discovery"\nsubphase: "critic_offer"\nstage: "planning"\nphase1_revision: 4\nphase2_revision: 2\ncritic_status: "not_offered"\nactive_tasks: ["T007"]\napproved_task_ids: []\nblocked_task_ids: []\n---\n')

    const offer = plugin.offerPlanCriticForSession('session-full')
    assert.equal(offer.available, true)
    assert.equal(offer.target.provider, 'anthropic')
    assert.equal(offer.target.model, 'claude-opus-4-7')
    assert.equal(offer.target.presetName, 'opus-critic')
    assert.match(offer.prompt, /developed by another provider model/i)
    assert.match(offer.prompt, /anthropic\/claude-opus-4-7/i)

    const criticResult = plugin.recordPlanCriticResultForSession('session-full', { verdict: 'accepted', summary: 'scope stable', target: offer.target })
    assert.equal(criticResult.verdict, 'accepted')
    let project = readMarkdownFrontmatter(projectPath).frontmatter
    assert.equal(project.critic_status, 'accepted')
    assert.equal(project.phase, 'phase1_discovery')
    assert.equal(project.subphase, 'critic_offer')
    assert.match(fs.readFileSync(path.join(projectDir, 'progress.md'), 'utf8'), /Plan critic accepted/)

    await plugin.event({ event: { type: 'question.asked', properties: { id: 'phase1-full', sessionID: 'session-full', questions: [{ header: 'Phase 1 approval', question: 'Approve Phase 1 discovery scope and continue?', options: [], multiple: false }] } } })
    await plugin.event({ event: { type: 'question.replied', properties: { sessionID: 'session-full', requestID: 'phase1-full', answers: [['Approve']] } } })

    project = readMarkdownFrontmatter(projectPath).frontmatter
    assert.equal(project.phase, 'phase2_tasks')
    assert.equal(project.subphase, 'task_graph_draft')
    assert.equal(project.phase1_approved_revision, 4)

    const stamp = plugin.stampTaskContract({ projectDir, taskId: 'T007', roleHint: 'implementer', complexity: 'high', domainHint: 'ts-code', title: 'Full lifecycle', goal: 'Exercise strict workflow and routing', expectedPaths: ['src/full-lifecycle.ts'], protectedPaths: ['project.md'], allowedEphemeralPaths: ['tmp'], allowedShellCommandForms: ['pnpm test'], requiredForAcceptance: ['tests pass'] })
    assert.equal(stamp.frontmatter.role_hint, 'implementer')
    assert.equal(stamp.frontmatter.complexity, 'high')
    assert.equal(stamp.frontmatter.domain_hint, 'ts-code')

    fs.writeFileSync(projectPath, '---\nphase: "phase2_tasks"\nsubphase: "phase2_approval"\nstage: "planning"\nphase1_revision: 4\nphase1_approved_revision: 4\nphase2_revision: 2\ncritic_status: "accepted"\nactive_tasks: ["T007"]\napproved_task_ids: ["T007"]\nblocked_task_ids: []\n---\n')
    await plugin.event({ event: { type: 'question.asked', properties: { id: 'phase2-full', sessionID: 'session-full', questions: [{ header: 'Phase 2 approval', question: 'Approve Phase 2 task graph?', options: [], multiple: false }] } } })
    await plugin.event({ event: { type: 'question.replied', properties: { sessionID: 'session-full', requestID: 'phase2-full', answers: [['Approve']] } } })

    project = readMarkdownFrontmatter(projectPath).frontmatter
    assert.equal(project.phase, 'phase3_execution')
    assert.equal(project.subphase, 'execution_authorization')
    assert.equal(project.phase2_approved_revision, 2)

    await plugin.event({ event: { type: 'question.asked', properties: { id: 'exec-full', sessionID: 'session-full', questions: [{ header: 'Execution approval', question: 'Authorize execution and start coding?', options: [], multiple: false }] } } })
    await plugin.event({ event: { type: 'question.replied', properties: { sessionID: 'session-full', requestID: 'exec-full', answers: [['Approve']] } } })

    project = readMarkdownFrontmatter(projectPath).frontmatter
    assert.equal(project.stage, 'implementing')
    assert.equal(project.subphase, 'dispatch')
    assert.equal(project.execution_authorized, true)
    assert.equal(project.execution_snapshot_revision, 1)

    const snapshot = readMarkdownFrontmatter(path.join(projectDir, 'execution-snapshot.md')).frontmatter
    assert.deepEqual(snapshot.approved_task_ids, ['T007'])
    assert.equal(snapshot.authorized_by_question_id, 'exec-full')

    const plan = plugin.getDispatchPlanForSession('session-full', 'T007')
    assert.equal(plan.effective.presetName, 'sonnet-impl')
    assert.equal(plan.chain[0].presetName, 'sonnet-impl')
    assert.equal(plan.chain[0].provider, 'anthropic')

    const degraded = plugin.advanceTaskModelForSession('session-full', { taskID: 'T007', failedPresetName: 'sonnet-impl', reason: 'provider_unavailable' })
    assert.equal(degraded.degradedFrom.presetName, 'sonnet-impl')
    assert.equal(degraded.next.presetName, 'coder-hi')

    const taskFrontmatter = readMarkdownFrontmatter(stamp.taskPath).frontmatter
    assert.equal(taskFrontmatter.degraded_from.preset, 'sonnet-impl')
    assert.equal(taskFrontmatter.effective_model.preset, 'coder-hi')

    const reviewsPath = path.join(projectDir, 'reviews.md')
    const reviews = fs.readFileSync(reviewsPath, 'utf8')
    assert.match(reviews, /## Degradation Events/)
    assert.match(reviews, /\| T007 \| sonnet-impl \| coder-hi \| provider_unavailable \|/)

    const refreshed = plugin.refreshDegradationSummaryForSession('session-full')
    assert.equal(refreshed.changed, false)
    assert.match(fs.readFileSync(reviewsPath, 'utf8'), /\| T007 \| sonnet-impl \| coder-hi \| provider_unavailable \|/)

    const rerouted = plugin.getDispatchPlanForSession('session-full', 'T007')
    assert.equal(rerouted.effective.presetName, 'sonnet-impl')
    assert.equal(rerouted.chain[1].presetName, 'coder-hi')

    const finalProject = readMarkdownFrontmatter(projectPath).frontmatter
    assert.equal(finalProject.stage, 'implementing')
    assert.equal(finalProject.execution_authorized, true)
  })
})

test('project bootstrap recovers with existing single project', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  const projectDir = path.join(repoRoot, '.agents', 'yak', 'projects', path.basename(repoRoot))
  fs.mkdirSync(projectDir, { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'project.md'), '---\nstage: planning\n---\n')
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-r' } } } })
    assert.equal(fs.existsSync(path.join(projectDir, 'project.md')), true)
  })
})

test('default slug bootstraps missing project md in single-project repo', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  const projectDir = path.join(repoRoot, '.agents', 'yak', 'projects', path.basename(repoRoot))
  fs.mkdirSync(projectDir, { recursive: true })
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-default-missing' } } } })
    const { frontmatter } = readMarkdownFrontmatter(path.join(projectDir, 'project.md'))
    // Fresh projects bootstrap into Phase 0 exploration so the initial
    // conversation stays lightweight. User must explicitly "yak it" to move
    // into strict Phase 1 planning.
    assert.equal(frontmatter.stage, 'exploration')
    assert.equal(frontmatter.phase, 'phase0_exploration')
    assert.equal(frontmatter.subphase, 'idle')
    assert.ok(fs.existsSync(path.join(projectDir, 'context.md')))
    assert.ok(fs.existsSync(path.join(projectDir, 'tasks.md')))
  })
})

test('multi-project repo binds active pointer without error', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  const projectRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
  fs.mkdirSync(path.join(projectRoot, 'alpha'), { recursive: true })
  fs.mkdirSync(path.join(projectRoot, 'beta'), { recursive: true })
  fs.writeFileSync(path.join(projectRoot, 'alpha', 'project.md'), '---\nstage: planning\n---\n')
  fs.writeFileSync(path.join(projectRoot, 'beta', 'project.md'), '---\nstage: planning\n---\n')
  writeActiveProjectSlug(repoRoot, 'beta')
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-m' } } } })
    assert.equal(fs.existsSync(path.join(projectRoot, 'beta', 'project.md')), true)
  })
})

test('active pointer bootstraps selected incomplete slug in multi-project repo', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  const projectRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
  fs.mkdirSync(path.join(projectRoot, 'alpha'), { recursive: true })
  fs.mkdirSync(path.join(projectRoot, 'beta'), { recursive: true })
  fs.writeFileSync(path.join(projectRoot, 'alpha', 'project.md'), '---\nstage: planning\n---\n')
  writeActiveProjectSlug(repoRoot, 'beta')
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-active-missing' } } } })
    const { frontmatter } = readMarkdownFrontmatter(path.join(projectRoot, 'beta', 'project.md'))
    // Newly bootstrapped projects default to Phase 0 exploration regardless of
    // whether a sibling project has already been initialized.
    assert.equal(frontmatter.stage, 'exploration')
    assert.equal(frontmatter.phase, 'phase0_exploration')
    assert.ok(fs.existsSync(path.join(projectRoot, 'beta', 'context.md')))
    assert.ok(fs.existsSync(path.join(projectRoot, 'beta', 'tasks.md')))
  })
})

test('legacy quarantined project auto-reopens to planning on session bootstrap', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  const projectDir = path.join(repoRoot, '.agents', 'yak', 'projects', path.basename(repoRoot))
  seedCanonicalProjectArtifacts(projectDir, 'quarantined')
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-quarantine' } } } })
    const repaired = readMarkdownFrontmatter(path.join(projectDir, 'project.md')).frontmatter
    assert.equal(repaired.stage, 'planning')
  })
})

test('orchestrator planning shell uses blocklist only and does not poison project', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  const projectDir = path.join(repoRoot, '.agents', 'yak', 'projects', path.basename(repoRoot))
  seedCanonicalProjectArtifacts(projectDir, 'planning')
  fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# Asula Monorepo\n')
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'orchestrator' } } } })

    const readPermission = { status: 'allow' }
    await plugin['permission.ask']({ sessionID: 'orchestrator', tool: 'read' }, readPermission)
    assert.equal(readPermission.status, 'allow')

    await assert.doesNotReject(async () => {
      await plugin['tool.execute.before']({ sessionID: 'orchestrator', tool: 'read' }, { args: { path: path.join(repoRoot, 'AGENTS.md') } })
    })

    for (const blockedCommand of ['pnpm install', 'gh api repos/o/r/issues -f title=x -f body=y', 'git push origin HEAD']) {
      const blockedShellPermission = { status: 'allow' }
      await plugin['permission.ask']({ sessionID: 'orchestrator', tool: 'shell', args: { command: blockedCommand } }, blockedShellPermission)
      assert.equal(blockedShellPermission.status, 'deny')

      await assert.rejects(async () => {
        await plugin['tool.execute.before']({ sessionID: 'orchestrator', tool: 'shell' }, { args: { command: blockedCommand } })
      }, /blocked|denies/i)
    }

    assert.equal(readMarkdownFrontmatter(path.join(projectDir, 'project.md')).frontmatter.stage, 'planning')

    for (const allowedCommand of ['pnpm test', 'cargo test', 'git status', 'git diff --name-only', 'cat AGENTS.md', 'rg foo AGENTS.md', "python3 -c 'print(1)'", "REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner') && gh api graphql -f query='query { viewer { login } }'"]) {
      const allowedPermission = { status: 'allow' }
      await plugin['permission.ask']({ sessionID: 'orchestrator', tool: 'shell', args: { command: allowedCommand } }, allowedPermission)
      assert.equal(allowedPermission.status, 'allow')

      await assert.doesNotReject(async () => {
        await plugin['tool.execute.before']({ sessionID: 'orchestrator', tool: 'shell' }, { args: { command: allowedCommand } })
      })
    }

    for (const allowedGhCommand of [
      'gh pr view --json number,url,title,headRefName',
      "gh repo view --json nameWithOwner --jq '.nameWithOwner'",
      "gh api graphql -f query='query { viewer { login } }'",
      "gh api graphql -f query='query { viewer { login } }' --jq '{ totalCount: .data | length, unresolved: [.data[] | select(.ok == true)] }'",
    ]) {
      const allowedGhPermission = { status: 'allow' }
      await plugin['permission.ask']({ sessionID: 'orchestrator', tool: 'shell', args: { command: allowedGhCommand } }, allowedGhPermission)
      assert.equal(allowedGhPermission.status, 'allow')

      await assert.doesNotReject(async () => {
        await plugin['tool.execute.before']({ sessionID: 'orchestrator', tool: 'shell' }, { args: { command: allowedGhCommand } })
      })
    }

    const readonlyFetchPermission = { status: 'allow' }
    await plugin['permission.ask']({ sessionID: 'explorer', tool: 'webfetch', args: { url: 'https://example.com', save_binary: false } }, readonlyFetchPermission)
    assert.equal(readonlyFetchPermission.status, 'allow')

    await assert.doesNotReject(async () => {
      await plugin['tool.execute.before']({ sessionID: 'explorer', tool: 'webfetch' }, { args: { url: 'https://example.com', save_binary: false } })
    })

    const binaryFetchPermission = { status: 'allow' }
    await plugin['permission.ask']({ sessionID: 'explorer', tool: 'webfetch', args: { url: 'https://example.com/file.zip', save_binary: true } }, binaryFetchPermission)
    assert.equal(binaryFetchPermission.status, 'allow')

    await assert.doesNotReject(async () => {
      await plugin['tool.execute.before']({ sessionID: 'explorer', tool: 'webfetch' }, { args: { url: 'https://example.com/file.zip', save_binary: true } })
    })
  })
})

test('invalid active pointer in multi-project repo still errors', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  const projectRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
  fs.mkdirSync(path.join(projectRoot, 'alpha'), { recursive: true })
  fs.mkdirSync(path.join(projectRoot, 'beta'), { recursive: true })
  fs.writeFileSync(path.join(projectRoot, 'alpha', 'project.md'), '---\nstage: planning\n---\n')
  fs.writeFileSync(path.join(projectRoot, 'beta', 'project.md'), '---\nstage: planning\n---\n')
  writeActiveProjectSlug(repoRoot, 'missing')
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await assert.rejects(async () => { await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-x' } } } }) }, /Multiple projects exist; explicit project selection required/)
  })
})

test('planning mode permits test commands and denies blacklist shell forms', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const setup = async () => {
      const plugin = await PlanningFilesPlugin({ directory: repoRoot })
      await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-test' } } } })
      const projectRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
      const slug = fs.readdirSync(projectRoot).find((entry) => fs.statSync(path.join(projectRoot, entry)).isDirectory())
      const projectDir = path.join(projectRoot, slug)
      fs.writeFileSync(path.join(projectDir, 'project.md'), '---\nstage: planning\n---\n')
      return plugin
    }

    for (const allowedCommand of [
      'pnpm test:ui -- ClerkAuthProvider.jest.tsx',
      'cargo test',
      'my-custom-alias foo',
      'pnpm build > out.txt',
      'ls | python',
      "python - <<'PY'\nprint('x')\nPY",
      "python -<<'PY'\nprint('x')\nPY",
    ]) {
      await assert.doesNotReject(async () => {
        const plugin = await setup()
        await plugin['tool.execute.before']({ sessionID: 'session-test', tool: 'shell' }, { args: { command: allowedCommand } })
      })
    }

    await assert.rejects(async () => {
      const plugin = await setup()
      await plugin['tool.execute.before']({ sessionID: 'session-test', tool: 'shell' }, { args: { command: 'cat AGENTS.md | sh' } })
    }, /Planning mode denies mutating or unknown shell forms/)

    await assert.rejects(async () => {
      const plugin = await setup()
      await plugin['tool.execute.before']({ sessionID: 'session-test', tool: 'shell' }, { args: { command: 'kubectl apply -f x.yaml' } })
    }, /Planning mode denies mutating or unknown shell forms/)

    await assert.rejects(async () => {
      const plugin = await setup()
      await plugin['tool.execute.before']({ sessionID: 'session-test', tool: 'shell' }, { args: { command: 'terraform apply' } })
    }, /Planning mode denies mutating or unknown shell forms/)

    await assert.rejects(async () => {
      const plugin = await setup()
      await plugin['tool.execute.before']({ sessionID: 'session-test', tool: 'shell' }, { args: { command: 'pnpm install' } })
    }, /Planning mode denies mutating or unknown shell forms/)

    await assert.rejects(async () => {
      const plugin = await setup()
      await plugin['tool.execute.before']({ sessionID: 'session-test', tool: 'shell' }, { args: { command: 'gh pr comment 123 --body hello' } })
    }, /Planning mode denies mutating or unknown shell forms/)

  })
})

test('dispatch plan resolves stamped task and advances fallback chain', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-dispatch' } } } })
    const projectRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
    const slug = fs.readdirSync(projectRoot).find((entry) => fs.statSync(path.join(projectRoot, entry)).isDirectory())
    const projectDir = path.join(projectRoot, slug)
    const stamp = plugin.stampTaskContract({ projectDir, taskId: 'T001', roleHint: 'implementer', complexity: 'high', title: 'Dispatch', goal: 'Exercise fallback dispatch', expectedPaths: [], protectedPaths: [], allowedEphemeralPaths: [], allowedShellCommandForms: [], requiredForAcceptance: [] })

    const plan = plugin.getDispatchPlanForSession('session-dispatch', 'T001')
    assert.equal(plan.taskID, 'T001')
    assert.equal(plan.unresolved, false)
    assert.equal(plan.effective.presetName, 'opus-impl')
    assert.equal(plan.chain[0].presetName, 'opus-impl')

    const step1 = plugin.advanceTaskModelForSession('session-dispatch', { taskID: 'T001', failedPresetName: 'opus-impl', reason: 'provider_unavailable' })
    assert.equal(step1.exhausted, false)
    assert.equal(step1.next.presetName, 'sonnet-impl')
    assert.equal(step1.taskID, 'T001')
    assert.equal(step1.degradedFrom.presetName, 'opus-impl')

    const taskAfterStep1 = readMarkdownFrontmatter(stamp.taskPath).frontmatter
    assert.equal(taskAfterStep1.degraded_from.preset, 'opus-impl')
    assert.equal(taskAfterStep1.effective_model.preset, 'sonnet-impl')

    const exhausted = plugin.advanceTaskModelForSession('session-dispatch', { taskID: 'T001', failedPresetName: 'fixer', reason: 'provider_unavailable' })
    assert.equal(exhausted.exhausted, true)
    assert.equal(exhausted.next, null)
  })
})

test('planning mode allows read-only gh commands for pr-comments skill', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const setup = async () => {
      const plugin = await PlanningFilesPlugin({ directory: repoRoot })
      await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-gh' } } } })
      const projectRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
      const slug = fs.readdirSync(projectRoot).find((entry) => fs.statSync(path.join(projectRoot, entry)).isDirectory())
      const projectDir = path.join(projectRoot, slug)
      fs.writeFileSync(path.join(projectDir, 'project.md'), '---\nstage: planning\n---\n')
      return plugin
    }

    for (const command of [
      'gh pr view --json number,url,title,headRefName',
      "gh repo view --json nameWithOwner --jq '.nameWithOwner'",
      "gh api graphql -f query='query { viewer { login } }'",
      "gh api graphql -f query='query { viewer { login } }' --jq '{ totalCount: .data | length, unresolved: [.data[] | select(.ok == true)] }'",
      "REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner') && gh api graphql -F owner=\"${REPO%/*}\" -F repo=\"${REPO#*/}\" -F pr=\"1400\" -f query='query { viewer { login } }'",
    ]) {
      await assert.doesNotReject(async () => {
        const plugin = await setup()
        await plugin['tool.execute.before']({ sessionID: 'session-gh', tool: 'shell' }, { args: { command } })
      })
    }
  })
})

test('generic approve question without phase keywords does not advance a gate', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-ambig' } } } })
    const projectRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
    const slug = fs.readdirSync(projectRoot).find((entry) => fs.statSync(path.join(projectRoot, entry)).isDirectory())
    const projectDir = path.join(projectRoot, slug)
    const projectPath = path.join(projectDir, 'project.md')
    fs.writeFileSync(projectPath, '---\nphase: "phase1_discovery"\nsubphase: "scope_draft"\nstage: "planning"\nphase1_revision: 1\nactive_tasks: []\n---\n')

    await plugin.event({ event: { type: 'question.asked', properties: { id: 'ambig', sessionID: 'session-ambig', questions: [{ header: 'Postgres', question: 'Do you approve Postgres for this repo?', options: [], multiple: false }] } } })
    await plugin.event({ event: { type: 'question.replied', properties: { sessionID: 'session-ambig', requestID: 'ambig', answers: [['Approve']] } } })

    const frontmatter = readMarkdownFrontmatter(projectPath).frontmatter
    assert.equal(frontmatter.phase, 'phase1_discovery')
    assert.equal(frontmatter.subphase, 'scope_draft')
    assert.notEqual(frontmatter.phase1_approved_revision, 1)
  })
})

test('planning stage denies orchestrator gate-field edits', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-gate-edit' } } } })
    const projectRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
    const slug = fs.readdirSync(projectRoot).find((entry) => fs.statSync(path.join(projectRoot, entry)).isDirectory())
    const projectDir = path.join(projectRoot, slug)
    const projectPath = path.join(projectDir, 'project.md')
    fs.writeFileSync(projectPath, '---\nstage: planning\nphase: phase1_discovery\nsubphase: scope_draft\n---\n')

    await assert.rejects(async () => {
      await plugin['tool.execute.before']({ sessionID: 'session-gate-edit', tool: 'write' }, { args: { filePath: projectPath, content: '---\nstage: implementing\nphase: phase3_execution\nsubphase: dispatch\n---\n' } })
    }, /Planning mode denies direct gate-field edits in project.md/)

    await assert.doesNotReject(async () => {
      await plugin['tool.execute.before']({ sessionID: 'session-gate-edit', tool: 'write' }, { args: { filePath: projectPath, content: '---\nstage: planning\nphase: phase1_discovery\nsubphase: scope_draft\nsummary: "keep gate fields unchanged"\n---\n' } })
    })
  })
})

test('implementation mode scopes apply_patch by session role', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'orchestrator' } } } })
    const projectRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
    const slug = fs.readdirSync(projectRoot).find((entry) => fs.statSync(path.join(projectRoot, entry)).isDirectory())
    const projectDir = path.join(projectRoot, slug)
    const projectPath = path.join(projectDir, 'project.md')
    fs.writeFileSync(projectPath, '---\nstage: implementing\nactive_tasks: ["T1"]\n---\n')
    fs.mkdirSync(path.join(projectDir, 'tasks'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'tasks', 'T1.md'), '---\ntask_id: "T1"\nplan_revision: 1\napproved_revision: 1\nallowed_paths: ["src"]\nforbidden_paths: ["src/private"]\nallowed_ephemeral_paths: []\nallowed_shell_command_forms: []\nrequired_for_acceptance: []\n---\n')
    fs.mkdirSync(path.join(repoRoot, 'src', 'private'), { recursive: true })
    fs.writeFileSync(path.join(repoRoot, 'src', 'ok.js'), 'x')
    fs.writeFileSync(path.join(repoRoot, 'src', 'private', 'secret.js'), 'x')

    await assert.doesNotReject(async () => {
      await plugin['tool.execute.before']({ sessionID: 'orchestrator', tool: 'apply_patch' }, { args: { patchText: '*** Begin Patch\n*** Update File: project.md\n+hi\n*** End Patch' } })
    })

    await assert.doesNotReject(async () => {
      await plugin['tool.execute.before']({ sessionID: 'orchestrator', tool: 'apply_patch' }, { args: { patchText: '*** Begin Patch\n*** Add File: tasks/T2.md\n+---\n+task_id: "T2"\n+plan_revision: 1\n+approved_revision: 1\n+---\n*** End Patch' } })
    })

    await assert.doesNotReject(async () => {
      await plugin['tool.execute.before']({ sessionID: 'orchestrator', tool: 'apply_patch' }, { args: { patchText: '*** Begin Patch\n*** Update File: src/ok.js\n+hi\n*** End Patch' } })
    })

    await assert.rejects(async () => {
      await plugin['tool.execute.before']({ sessionID: 'orchestrator', tool: 'apply_patch' }, { args: { patchText: '*** Begin Patch\n*** Update File: tasks/../src/ok.js\n+hi\n*** End Patch' } })
    }, /Orchestrator apply_patch limited to Yak project control files:|apply_patch escapes repo root:/)
    
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'worker', parentID: 'orchestrator' } } } })

    await assert.doesNotReject(async () => {
      await plugin['tool.execute.before']({ sessionID: 'worker', tool: 'apply_patch' }, { args: { patch: '*** Begin Patch\n*** Update File: src/ok.js\n+hi\n*** End Patch' } })
    })

    await assert.doesNotReject(async () => {
      await plugin['tool.execute.before']({ sessionID: 'worker', tool: 'apply_patch' }, { args: { patch: '*** Begin Patch\n*** Update File: src/ok.js\n+hi\n*** End Patch' } })
    })

    await assert.doesNotReject(async () => {
      await plugin['tool.execute.before']({ sessionID: 'worker', tool: 'apply_patch' }, { args: { patchText: '*** Begin Patch\n*** Update File: src/ok.js\n+hi\n*** End Patch' } })
    })

    await assert.rejects(async () => {
      await plugin['tool.execute.before']({ sessionID: 'worker', tool: 'apply_patch' }, { args: { patch: '*** Begin Patch\n*** Update File: src/private/secret.js\n+hi\n*** End Patch' } })
    }, /Task write touches forbidden path:/)

    await assert.doesNotReject(async () => {
      await plugin['tool.execute.before']({ sessionID: 'orchestrator', tool: 'apply_patch' }, { args: { patchText: '*** Begin Patch\n*** Update File: project.md\n*** Move to: src/private/moved.js\n@@\n-x\n+y\n*** End Patch' } })
    })
  })
})

test('worker session binds exact task id instead of active_tasks[0]', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'orchestrator' } } } })
    const projectRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
    const slug = fs.readdirSync(projectRoot).find((entry) => fs.statSync(path.join(projectRoot, entry)).isDirectory())
    const projectDir = path.join(projectRoot, slug)
    fs.writeFileSync(path.join(projectDir, 'project.md'), '---\nstage: implementing\nactive_tasks: ["T1", "T2"]\n---\n')
    fs.mkdirSync(path.join(projectDir, 'tasks'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'tasks', 'T1.md'), '---\ntask_id: "T1"\nplan_revision: 1\napproved_revision: 1\nallowed_paths: ["src"]\nforbidden_paths: ["src/ok.js"]\nallowed_ephemeral_paths: []\nallowed_shell_command_forms: []\nrequired_for_acceptance: []\n---\n')
    fs.writeFileSync(path.join(projectDir, 'tasks', 'T2.md'), '---\ntask_id: "T2"\nplan_revision: 1\napproved_revision: 1\nallowed_paths: ["src"]\nforbidden_paths: ["src/private"]\nallowed_ephemeral_paths: []\nallowed_shell_command_forms: []\nrequired_for_acceptance: []\n---\n')
    fs.mkdirSync(path.join(repoRoot, 'src', 'private'), { recursive: true })
    fs.writeFileSync(path.join(repoRoot, 'src', 'ok.js'), 'x')
    fs.writeFileSync(path.join(repoRoot, 'src', 'private', 'secret.js'), 'x')

    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'worker', parentID: 'orchestrator', taskID: 'T2' } } } })

    await assert.doesNotReject(async () => {
      await plugin['tool.execute.before']({ sessionID: 'worker', tool: 'edit' }, { args: { filePath: path.join(repoRoot, 'src', 'ok.js'), oldString: 'x', newString: 'y' } })
    })

    await assert.rejects(async () => {
      await plugin['tool.execute.before']({ sessionID: 'worker', tool: 'edit' }, { args: { filePath: path.join(repoRoot, 'src', 'private', 'secret.js'), oldString: 'x', newString: 'y' } })
    }, /Task write touches forbidden path:/)
  })
})

test('execution snapshot blocks tasks outside approved frozen set', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'orchestrator' } } } })
    const projectRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
    const slug = fs.readdirSync(projectRoot).find((entry) => fs.statSync(path.join(projectRoot, entry)).isDirectory())
    const projectDir = path.join(projectRoot, slug)
    fs.writeFileSync(path.join(projectDir, 'project.md'), '---\nstage: implementing\nactive_tasks: ["T1", "T2"]\nexecution_snapshot_revision: 1\n---\n')
    fs.writeFileSync(path.join(projectDir, 'execution-snapshot.md'), '---\nsnapshot_revision: 1\napproved_task_ids: ["T1"]\n---\n')
    fs.mkdirSync(path.join(projectDir, 'tasks'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'tasks', 'T1.md'), '---\ntask_id: "T1"\nplan_revision: 1\napproved_revision: 1\nallowed_paths: ["src"]\nforbidden_paths: ["src/private"]\nallowed_ephemeral_paths: []\nallowed_shell_command_forms: ["npm test"]\nrequired_for_acceptance: []\n---\n')
    fs.writeFileSync(path.join(projectDir, 'tasks', 'T2.md'), '---\ntask_id: "T2"\nplan_revision: 1\napproved_revision: 1\nallowed_paths: ["src"]\nforbidden_paths: ["src/private"]\nallowed_ephemeral_paths: []\nallowed_shell_command_forms: ["npm test"]\nrequired_for_acceptance: []\n---\n')
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true })
    fs.writeFileSync(path.join(repoRoot, 'src', 'ok.js'), 'x')

    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'worker', parentID: 'orchestrator', taskID: 'T2' } } } })

    await assert.rejects(async () => {
      await plugin['tool.execute.before']({ sessionID: 'worker', tool: 'edit' }, { args: { filePath: path.join(repoRoot, 'src', 'ok.js'), oldString: 'x', newString: 'y' } })
    }, /Task T2 not approved in execution snapshot/)
  })
})

test('status and next-task helper path refreshes project context', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-status' } } } })
    const projectRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
    const slug = fs.readdirSync(projectRoot).find((entry) => fs.statSync(path.join(projectRoot, entry)).isDirectory())
    const projectDir = path.join(projectRoot, slug)
    fs.writeFileSync(path.join(projectDir, 'project.md'), '---\nactive_tasks: ["T1"]\nstage: implementing\n---\n')
    fs.mkdirSync(path.join(projectDir, 'tasks'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'context.md'), 'context v1')
    fs.writeFileSync(path.join(projectDir, 'tasks.md'), 'tasks v1')
    fs.writeFileSync(path.join(projectDir, 'tasks', 'T1.md'), '---\ntask_id: "T1"\n---\nbody')

    const first = plugin.refreshProjectContextForSession('session-status')
    fs.writeFileSync(path.join(projectDir, 'context.md'), 'context v2')
    const second = plugin.refreshProjectContextForSession('session-status')

    assert.equal(first.files.context.body.trim(), 'context v1')
    assert.equal(second.files.context.body.trim(), 'context v2')
    assert.notEqual(first.freshness.context.mtimeMs, second.freshness.context.mtimeMs)
  })
})

test('implementation mode allows loose orchestrator writes and broad worker repo writes', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'orchestrator' } } } })
    const projectRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
    const slug = fs.readdirSync(projectRoot).find((entry) => fs.statSync(path.join(projectRoot, entry)).isDirectory())
    const projectDir = path.join(projectRoot, slug)
    fs.writeFileSync(path.join(projectDir, 'project.md'), '---\nstage: implementing\nactive_tasks: ["T1"]\n---\n')
    fs.mkdirSync(path.join(projectDir, 'tasks'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'tasks', 'T1.md'), '---\ntask_id: "T1"\nplan_revision: 1\napproved_revision: 1\nexpected_paths: ["src"]\nprotected_paths: ["src/private"]\nallowed_ephemeral_paths: []\nallowed_shell_command_forms: []\nrequired_for_acceptance: []\n---\n')
    fs.mkdirSync(path.join(repoRoot, 'src', 'private'), { recursive: true })
    const okPath = path.join(repoRoot, 'src', 'ok.js')
    const newPath = path.join(repoRoot, 'src', 'new.js')
    const extraPath = path.join(repoRoot, 'docs', 'note.md')
    const secretPath = path.join(repoRoot, 'src', 'private', 'secret.js')
    const envPath = path.join(repoRoot, '.env')
    const contextPath = path.join(projectDir, 'context.md')
    const taskPlanPath = path.join(projectDir, 'tasks', 'T2.md')
    fs.writeFileSync(okPath, 'x')
    fs.writeFileSync(secretPath, 'x')
    fs.writeFileSync(envPath, 'SECRET=1')
    fs.mkdirSync(path.dirname(extraPath), { recursive: true })

    await assert.doesNotReject(async () => {
      await plugin['tool.execute.before']({ sessionID: 'orchestrator', tool: 'write' }, { args: { filePath: taskPlanPath, content: 'y' } })
    })

    await assert.doesNotReject(async () => {
      await plugin['tool.execute.before']({ sessionID: 'orchestrator', tool: 'edit' }, { args: { filePath: contextPath, oldString: 'Repo:', newString: 'Repository:' } })
    })

    await assert.doesNotReject(async () => {
      await plugin['tool.execute.before']({ sessionID: 'orchestrator', tool: 'edit' }, { args: { filePath: okPath, oldString: 'x', newString: 'y' } })
    })

    await assert.rejects(async () => {
      await plugin['tool.execute.before']({ sessionID: 'orchestrator', tool: 'write' }, { args: { filePath: envPath, content: 'y' } })
    }, /env|secret|protected/i)

    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'worker', parentID: 'orchestrator' } } } })

    await assert.doesNotReject(async () => {
      await plugin['tool.execute.before']({ sessionID: 'worker', tool: 'write' }, { args: { filePath: newPath, content: 'y' } })
    })

    await assert.doesNotReject(async () => {
      await plugin['tool.execute.before']({ sessionID: 'worker', tool: 'write' }, { args: { filePath: extraPath, content: 'y' } })
    })

    await assert.doesNotReject(async () => {
      await plugin['tool.execute.before']({ sessionID: 'worker', tool: 'edit' }, { args: { filePath: okPath, oldString: 'x', newString: 'y' } })
    })

    await assert.rejects(async () => {
      await plugin['tool.execute.before']({ sessionID: 'worker', tool: 'write' }, { args: { filePath: secretPath, content: 'y' } })
    }, /Task write touches forbidden path:|Task write outside allowed paths:/)

    await assert.rejects(async () => {
      await plugin['tool.execute.before']({ sessionID: 'worker', tool: 'edit' }, { args: { filePath: secretPath, oldString: 'x', newString: 'y' } })
    }, /Task write touches forbidden path:|Task write outside allowed paths:/)
  })
})

test('worker broad scope still hard-blocks env and git paths', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'orchestrator' } } } })
    const projectRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
    const slug = fs.readdirSync(projectRoot).find((entry) => fs.statSync(path.join(projectRoot, entry)).isDirectory())
    const projectDir = path.join(projectRoot, slug)
    fs.writeFileSync(path.join(projectDir, 'project.md'), '---\nstage: implementing\nactive_tasks: ["T1"]\n---\n')
    fs.mkdirSync(path.join(projectDir, 'tasks'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'tasks', 'T1.md'), '---\ntask_id: "T1"\nplan_revision: 1\napproved_revision: 1\nallowed_paths: ["."]\nforbidden_paths: []\nallowed_ephemeral_paths: []\nallowed_shell_command_forms: []\nrequired_for_acceptance: []\n---\n')
    fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true })
    fs.writeFileSync(path.join(repoRoot, '.envrc'), 'export X=1')
    fs.writeFileSync(path.join(repoRoot, '.git', 'config'), '[core]')

    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'worker', parentID: 'orchestrator' } } } })

    await assert.rejects(async () => {
      await plugin['tool.execute.before']({ sessionID: 'worker', tool: 'write' }, { args: { filePath: path.join(repoRoot, '.envrc'), content: 'x' } })
    }, /env|secret|protected/i)

    await assert.rejects(async () => {
      await plugin['tool.execute.before']({ sessionID: 'worker', tool: 'write' }, { args: { filePath: path.join(repoRoot, '.git', 'config'), content: 'x' } })
    }, /git|protected/i)
  })
})

test('completed stage no longer blocks orchestrator mutation', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-complete' } } } })
    const projectRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
    const slug = fs.readdirSync(projectRoot).find((entry) => fs.statSync(path.join(projectRoot, entry)).isDirectory())
    const projectDir = path.join(projectRoot, slug)
    fs.writeFileSync(path.join(projectDir, 'project.md'), '---\nstage: completed\nactive_tasks: ["T1"]\n---\n')

    await assert.doesNotReject(async () => {
      await plugin['tool.execute.before']({ sessionID: 'session-complete', tool: 'write' }, { args: { filePath: path.join(projectDir, 'context.md'), content: 'x' } })
    })
  })
})

test('question events capture reusable clarification into findings context and progress', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-q' } } } })
    const projectRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
    const slug = fs.readdirSync(projectRoot).find((entry) => fs.statSync(path.join(projectRoot, entry)).isDirectory())
    const projectDir = path.join(projectRoot, slug)

    await plugin.event({ event: { type: 'question.asked', properties: { id: 'req-1', sessionID: 'session-q', questions: [{ header: 'Findings rule', question: 'Should this findings-capture rule apply to every assistant question, or only clarifications with reuse value?', options: [], multiple: false }] } } })
    await plugin.event({ event: { type: 'question.replied', properties: { sessionID: 'session-q', requestID: 'req-1', answers: [['Case by case']] } } })

    const findings = fs.readFileSync(path.join(projectDir, 'findings.md'), 'utf8')
    const context = fs.readFileSync(path.join(projectDir, 'context.md'), 'utf8')
    const progress = fs.readFileSync(path.join(projectDir, 'progress.md'), 'utf8')

    assert.match(findings, /findings-capture rule apply/i)
    assert.match(findings, /Case by case/i)
    assert.match(context, /Case by case/i)
    assert.match(progress, /Captured question resolution/i)
  })
})

test('question events skip low-value preference clarifications', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-pref' } } } })
    const projectRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
    const slug = fs.readdirSync(projectRoot).find((entry) => fs.statSync(path.join(projectRoot, entry)).isDirectory())
    const projectDir = path.join(projectRoot, slug)
    const findingsPath = path.join(projectDir, 'findings.md')
    const before = fs.readFileSync(findingsPath, 'utf8')

    await plugin.event({ event: { type: 'question.asked', properties: { id: 'req-2', sessionID: 'session-pref', questions: [{ header: 'Style', question: 'Do you prefer bullets or numbers for this one response?', options: [], multiple: false }] } } })
    await plugin.event({ event: { type: 'question.replied', properties: { sessionID: 'session-pref', requestID: 'req-2', answers: [['Bullets']] } } })

    const after = fs.readFileSync(findingsPath, 'utf8')
    assert.equal(after, before)
  })
})

test('freeform assistant questions can also be captured from message history', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-freeform' } } } })
    const projectRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
    const slug = fs.readdirSync(projectRoot).find((entry) => fs.statSync(path.join(projectRoot, entry)).isDirectory())
    const projectDir = path.join(projectRoot, slug)

    await plugin['experimental.chat.messages.transform']({}, { messages: [
      {
        info: { id: 'assistant-1', sessionID: 'session-freeform', role: 'assistant' },
        parts: [{ type: 'text', text: 'Should this rule apply to all future findings captures?' }],
      },
      {
        info: { id: 'user-1', sessionID: 'session-freeform', role: 'user' },
        parts: [{ type: 'text', text: 'Yes, for future findings captures with reuse value.' }],
      },
    ] })

    const findings = fs.readFileSync(path.join(projectDir, 'findings.md'), 'utf8')
    assert.match(findings, /all future findings captures/i)
    assert.match(findings, /reuse value/i)
  })
})

test('implementation mode scopes lsp_rename and ast_grep_replace by session role', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'orchestrator' } } } })
    const projectRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
    const slug = fs.readdirSync(projectRoot).find((entry) => fs.statSync(path.join(projectRoot, entry)).isDirectory())
    const projectDir = path.join(projectRoot, slug)
    fs.writeFileSync(path.join(projectDir, 'project.md'), '---\nstage: implementing\nactive_tasks: ["T1"]\n---\n')
    fs.mkdirSync(path.join(projectDir, 'tasks'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'tasks', 'T1.md'), '---\ntask_id: "T1"\nplan_revision: 1\napproved_revision: 1\nallowed_paths: ["src"]\nforbidden_paths: ["src/private"]\nallowed_ephemeral_paths: []\nallowed_shell_command_forms: []\nrequired_for_acceptance: []\n---\n')
    fs.mkdirSync(path.join(repoRoot, 'src', 'private'), { recursive: true })
    fs.writeFileSync(path.join(repoRoot, 'src', 'ok.js'), 'x')
    fs.writeFileSync(path.join(repoRoot, 'src', 'private', 'secret.js'), 'x')

    await assert.doesNotReject(async () => {
      await plugin['tool.execute.before']({ sessionID: 'orchestrator', tool: 'lsp_rename' }, { args: { filePath: 'src/ok.js' } })
    })

    await assert.doesNotReject(async () => {
      await plugin['tool.execute.before']({ sessionID: 'orchestrator', tool: 'ast_grep_replace' }, { args: { paths: ['src'], globs: ['src/**/*.ts'] } })
    })

    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'worker', parentID: 'orchestrator' } } } })

    await assert.doesNotReject(async () => {
      await plugin['tool.execute.before']({ sessionID: 'worker', tool: 'lsp_rename' }, { args: { filePath: 'src/ok.js' } })
    })

    await assert.rejects(async () => {
      await plugin['tool.execute.before']({ sessionID: 'worker', tool: 'lsp_rename' }, { args: { filePath: 'src/private/secret.js' } })
    }, /Task write touches forbidden path:|Task write outside allowed paths:/)

    await assert.doesNotReject(async () => {
      await plugin['tool.execute.before']({ sessionID: 'worker', tool: 'ast_grep_replace' }, { args: { paths: ['src'], globs: ['src/**/*.ts'] } })
    })

    await assert.rejects(async () => {
      await plugin['tool.execute.before']({ sessionID: 'worker', tool: 'ast_grep_replace' }, { args: { paths: ['src/private/secret.ts'] } })
    }, /Task write touches forbidden path:|Task write outside allowed paths:/)
  })
})

// ---------------------------------------------------------------------------
// Phase 0 (exploration) behavior
// ---------------------------------------------------------------------------

test('phase 0 exploration is permissive: write, edit and shell work without task policy', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-explore' } } } })
    fs.writeFileSync(path.join(repoRoot, 'src.js'), 'x')

    // Write to a random repo file — would be denied in Phase 1 planning,
    // should succeed in Phase 0.
    await assert.doesNotReject(async () => {
      await plugin['tool.execute.before']({ sessionID: 'session-explore', tool: 'write' }, { args: { filePath: path.join(repoRoot, 'src.js'), content: 'y' } })
    })

    // Read-only shell still works.
    await assert.doesNotReject(async () => {
      await plugin['tool.execute.before']({ sessionID: 'session-explore', tool: 'shell' }, { args: { command: 'ls' } })
    })

    // mkdir outside the planning dir works in exploration.
    await assert.doesNotReject(async () => {
      await plugin['tool.execute.before']({ sessionID: 'session-explore', tool: 'mkdir' }, { args: { path: path.join(repoRoot, 'new-dir') } })
    })
  })
})

test('phase 0 exploration still hard-blocks protected paths and destructive shell forms', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-explore' } } } })

    await assert.rejects(async () => {
      await plugin['tool.execute.before']({ sessionID: 'session-explore', tool: 'write' }, { args: { filePath: path.join(repoRoot, '.env'), content: 'SECRET=1' } })
    }, /protected|env/i)

    await assert.rejects(async () => {
      await plugin['tool.execute.before']({ sessionID: 'session-explore', tool: 'shell' }, { args: { command: 'git push origin HEAD' } })
    }, /destructive|exploration denies/i)
  })
})

test('phase 0 apply_patch allows repo edits but blocks protected and escaping paths', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-explore' } } } })

    await assert.doesNotReject(async () => {
      await plugin['tool.execute.before']({ sessionID: 'session-explore', tool: 'apply_patch' }, { args: { patchText: '*** Begin Patch\n*** Add File: src/new.js\n+hi\n*** End Patch' } })
    })

    await assert.rejects(async () => {
      await plugin['tool.execute.before']({ sessionID: 'session-explore', tool: 'apply_patch' }, { args: { patchText: '*** Begin Patch\n*** Update File: ../escape.js\n+hi\n*** End Patch' } })
    }, /escape/i)

    await assert.rejects(async () => {
      await plugin['tool.execute.before']({ sessionID: 'session-explore', tool: 'apply_patch' }, { args: { patchText: '*** Begin Patch\n*** Update File: .env\n+hi\n*** End Patch' } })
    }, /protected|env/i)
  })
})

// ---------------------------------------------------------------------------
// "yak it" / "unyak" triggers
// ---------------------------------------------------------------------------

test('yak activation trigger transitions phase 0 exploration to phase 1 discovery', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-trigger' } } } })
    const projectRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
    const slug = fs.readdirSync(projectRoot).find((entry) => fs.statSync(path.join(projectRoot, entry)).isDirectory())
    const projectPath = path.join(projectRoot, slug, 'project.md')

    // Confirm starting state is exploration.
    assert.equal(readMarkdownFrontmatter(projectPath).frontmatter.stage, 'exploration')

    await plugin['experimental.chat.messages.transform']({}, { messages: [
      { info: { id: 'user-1', sessionID: 'session-trigger', role: 'user' }, parts: [{ type: 'text', text: 'cool, now yak this project please' }] },
    ] })

    const fm = readMarkdownFrontmatter(projectPath).frontmatter
    assert.equal(fm.phase, 'phase1_discovery')
    assert.equal(fm.subphase, 'scope_draft')
    assert.equal(fm.stage, 'planning')
    const progress = fs.readFileSync(path.join(projectRoot, slug, 'progress.md'), 'utf8')
    assert.match(progress, /Yak activated by user trigger/)
  })
})

test('yak activation trigger variants all fire once per message', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    for (const phrase of ['yak it', 'yak this', 'yak the project', 'yak project', "let's yak", '/yak']) {
      const variantRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-variant-')); execFileSync('git', ['init'], { cwd: variantRepo, stdio: 'ignore' })
      const plugin = await PlanningFilesPlugin({ directory: variantRepo })
      await plugin.event({ event: { type: 'session.created', properties: { info: { id: `variant-${phrase}` } } } })
      const projectRoot = path.join(variantRepo, '.agents', 'yak', 'projects')
      const slug = fs.readdirSync(projectRoot).find((entry) => fs.statSync(path.join(projectRoot, entry)).isDirectory())
      const projectPath = path.join(projectRoot, slug, 'project.md')

      await plugin['experimental.chat.messages.transform']({}, { messages: [
        { info: { id: `u-${phrase}`, sessionID: `variant-${phrase}`, role: 'user' }, parts: [{ type: 'text', text: `hey ${phrase}` }] },
      ] })

      const fm = readMarkdownFrontmatter(projectPath).frontmatter
      assert.equal(fm.phase, 'phase1_discovery', `phrase "${phrase}" should activate yak`)
    }
  })
})

test('yak deactivation trigger returns project to exploration', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-deact' } } } })
    const projectRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
    const slug = fs.readdirSync(projectRoot).find((entry) => fs.statSync(path.join(projectRoot, entry)).isDirectory())
    const projectPath = path.join(projectRoot, slug, 'project.md')

    // Activate first.
    await plugin['experimental.chat.messages.transform']({}, { messages: [
      { info: { id: 'u-act', sessionID: 'session-deact', role: 'user' }, parts: [{ type: 'text', text: 'yak it' }] },
    ] })
    assert.equal(readMarkdownFrontmatter(projectPath).frontmatter.phase, 'phase1_discovery')

    // Deactivate.
    await plugin['experimental.chat.messages.transform']({}, { messages: [
      { info: { id: 'u-deact', sessionID: 'session-deact', role: 'user' }, parts: [{ type: 'text', text: 'stop yak, back to browsing' }] },
    ] })
    const fm = readMarkdownFrontmatter(projectPath).frontmatter
    assert.equal(fm.phase, 'phase0_exploration')
    assert.equal(fm.stage, 'exploration')
    assert.equal(fm.subphase, 'idle')
  })
})

test('yak trigger is a no-op when project is already in strict phase', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-noop' } } } })
    const projectRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
    const slug = fs.readdirSync(projectRoot).find((entry) => fs.statSync(path.join(projectRoot, entry)).isDirectory())
    const projectPath = path.join(projectRoot, slug, 'project.md')
    fs.writeFileSync(projectPath, '---\nphase: "phase2_tasks"\nsubphase: "task_graph_draft"\nstage: "planning"\n---\n')

    await plugin['experimental.chat.messages.transform']({}, { messages: [
      { info: { id: 'u-act', sessionID: 'session-noop', role: 'user' }, parts: [{ type: 'text', text: 'yak it' }] },
    ] })

    const fm = readMarkdownFrontmatter(projectPath).frontmatter
    assert.equal(fm.phase, 'phase2_tasks')
    assert.equal(fm.subphase, 'task_graph_draft')
  })
})

test('activateYakForSession / deactivateYakForSession helpers round-trip phase', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-helper' } } } })

    const activated = plugin.activateYakForSession('session-helper', { reason: 'programmatic test' })
    assert.equal(activated.activated, true)
    assert.equal(activated.phase, 'phase1_discovery')

    // Second activation is a no-op.
    const again = plugin.activateYakForSession('session-helper')
    assert.equal(again.activated, false)
    assert.equal(again.reason, 'already_active')

    const deactivated = plugin.deactivateYakForSession('session-helper', { reason: 'cleanup' })
    assert.equal(deactivated.deactivated, true)
    assert.equal(deactivated.phase, 'phase0_exploration')
  })
})

// ---------------------------------------------------------------------------
// system.transform: bootstrap fix + directive injection at top
// ---------------------------------------------------------------------------

test('system.transform bootstraps runtime session when missing and injects Yak block at top', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })

    // Deliberately SKIP session.created. system.transform should still
    // bootstrap the runtime session lazily and inject Yak system text.
    const out = { system: ['baseline system message from core'] }
    await plugin['experimental.chat.system.transform']({ sessionID: 'fresh-session' }, out)

    assert.ok(out.system.length >= 2, 'expected at least one additional Yak system message')
    assert.match(out.system[0], /\[YAK\]/)
    // Core baseline must still be present after the Yak block.
    assert.ok(out.system.includes('baseline system message from core'))
  })
})

test('system.transform emits Phase 0 directive in exploration and strict directive after activation', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-directive' } } } })

    const phase0Out = { system: [] }
    await plugin['experimental.chat.system.transform']({ sessionID: 'session-directive' }, phase0Out)
    assert.match(phase0Out.system[0], /phase0|exploration/i)
    assert.match(phase0Out.system[0], /yak it|\/yak/i)

    // Activate Yak.
    plugin.activateYakForSession('session-directive')

    const phase1Out = { system: [] }
    await plugin['experimental.chat.system.transform']({ sessionID: 'session-directive' }, phase1Out)
    assert.match(phase1Out.system[0], /STRICT MODE/)
    assert.match(phase1Out.system[0], /phase1_discovery/)
    // Strict-only reminders should also be present now. Stage-recording instructions
    // are now orchestrator-scoped and reference the yak_task_stage tool (not node CLI).
    assert.ok(phase1Out.system.some((msg) => /yak_task_stage|auto-recorded/i.test(msg)))
    assert.ok(!phase1Out.system.some((msg) => /node\s+\S*record-task-stage\.mjs/i.test(msg)))
  })
})

test('system.transform skips strict extras in phase 0 to keep prompt lightweight', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# repo rules')
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session-light' } } } })

    const out = { system: [] }
    await plugin['experimental.chat.system.transform']({ sessionID: 'session-light' }, out)
    // Phase 0 should not push the strict-only messages.
    assert.ok(!out.system.some((msg) => /read and follow repo-local AGENTS.md/i.test(msg)))
    assert.ok(!out.system.some((msg) => /yak_task_stage|record every task stage transition|record-task-stage\.mjs/i.test(msg)))
    assert.ok(!out.system.some((msg) => /Yak navigator: end meaningful replies/i.test(msg)))
  })
})

// ---------------------------------------------------------------------------
// Dispatch-lifecycle auto-recording
// ---------------------------------------------------------------------------

function seedImplementingProject(repoRoot, taskIds = ['T1']) {
  const projectRoot = path.join(repoRoot, '.agents', 'yak', 'projects')
  const slug = fs.readdirSync(projectRoot).find((entry) => fs.statSync(path.join(projectRoot, entry)).isDirectory())
  const projectDir = path.join(projectRoot, slug)
  const activeTasksArr = JSON.stringify(taskIds)
  const approvedTasksArr = JSON.stringify(taskIds)
  fs.writeFileSync(path.join(projectDir, 'project.md'), `---\nstage: implementing\nactive_tasks: ${activeTasksArr}\nexecution_snapshot_revision: 1\n---\n`)
  fs.writeFileSync(path.join(projectDir, 'execution-snapshot.md'), `---\nsnapshot_revision: 1\napproved_task_ids: ${approvedTasksArr}\n---\n`)
  fs.mkdirSync(path.join(projectDir, 'tasks'), { recursive: true })
  for (const taskId of taskIds) {
    fs.writeFileSync(path.join(projectDir, 'tasks', `${taskId}.md`), `---\ntask_id: "${taskId}"\nstage: "approved"\nplan_revision: 1\napproved_revision: 1\nallowed_paths: ["src"]\nforbidden_paths: []\nallowed_ephemeral_paths: []\nallowed_shell_command_forms: []\nrequired_for_acceptance: []\n---\n`)
  }
  return { projectDir, slug }
}

test('orchestrator dispatching task tool auto-records dispatched stage for the bound task', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'orch' } } } })
    const { projectDir } = seedImplementingProject(repoRoot, ['T1'])

    await plugin['tool.execute.before']({ sessionID: 'orch', tool: 'task', callID: 'call-dispatch-1' }, { args: { subagent_type: 'fixer', description: 'impl T1', prompt: 'taskID: T1\nExecute the spec at tasks/T1.md' } })

    const { frontmatter } = readMarkdownFrontmatter(path.join(projectDir, 'tasks', 'T1.md'))
    assert.equal(frontmatter.stage, 'dispatched', 'expected T1 stage to auto-advance to dispatched')
    const progress = fs.readFileSync(path.join(projectDir, 'progress.md'), 'utf8')
    assert.match(progress, /Task T1 stage approved -> dispatched/)
  })
})

test('orchestrator background_task dispatch also auto-records dispatched', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'orch' } } } })
    const { projectDir } = seedImplementingProject(repoRoot, ['T2'])

    await plugin['tool.execute.before']({ sessionID: 'orch', tool: 'background_task', callID: 'call-dispatch-2' }, { args: { subagent_type: 'fixer', description: 'impl T2', prompt: 'taskID: T2\nDo stuff' } })

    const { frontmatter } = readMarkdownFrontmatter(path.join(projectDir, 'tasks', 'T2.md'))
    assert.equal(frontmatter.stage, 'dispatched')
  })
})

test('task dispatch without taskID does not record any stage', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'orch' } } } })
    const { projectDir } = seedImplementingProject(repoRoot, ['T1'])
    const before = fs.readFileSync(path.join(projectDir, 'tasks', 'T1.md'), 'utf8')

    await plugin['tool.execute.before']({ sessionID: 'orch', tool: 'task', callID: 'call-notask' }, { args: { subagent_type: 'fixer', description: 'generic exploration', prompt: 'look around the codebase' } })

    const after = fs.readFileSync(path.join(projectDir, 'tasks', 'T1.md'), 'utf8')
    assert.equal(after, before, 'unrelated task dispatch must not mutate task frontmatter')
  })
})

test('task dispatch with unknown taskID does not crash and does not record', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'orch' } } } })
    seedImplementingProject(repoRoot, ['T1'])

    // T99 doesn't exist on disk. Hook must not throw.
    await assert.doesNotReject(async () => {
      await plugin['tool.execute.before']({ sessionID: 'orch', tool: 'task', callID: 'call-ghost' }, { args: { subagent_type: 'fixer', description: 'ghost', prompt: 'taskID: T99\nGhost task' } })
    })
  })
})

test('tool.execute.after hook exists and auto-records reported on task return', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'orch' } } } })
    const { projectDir } = seedImplementingProject(repoRoot, ['T1'])
    assert.equal(typeof plugin['tool.execute.after'], 'function', 'expected tool.execute.after hook to be defined')

    await plugin['tool.execute.before']({ sessionID: 'orch', tool: 'task', callID: 'call-complete-1' }, { args: { subagent_type: 'fixer', description: 'impl T1', prompt: 'taskID: T1\nExecute the spec' } })
    // Simulate the subagent finishing and returning.
    await plugin['tool.execute.after']({ sessionID: 'orch', tool: 'task', callID: 'call-complete-1' }, { args: { subagent_type: 'fixer', prompt: 'taskID: T1\nExecute the spec' }, output: 'done' })

    const { frontmatter } = readMarkdownFrontmatter(path.join(projectDir, 'tasks', 'T1.md'))
    assert.equal(frontmatter.stage, 'reported', 'expected T1 stage to advance to reported after subagent returns')
    const progress = fs.readFileSync(path.join(projectDir, 'progress.md'), 'utf8')
    assert.match(progress, /Task T1 stage dispatched -> reported/)
  })
})

test('worker session dispatching task tool does NOT auto-record stage', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'orch' } } } })
    const { projectDir } = seedImplementingProject(repoRoot, ['T1'])
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'worker', parentID: 'orch', taskID: 'T1' } } } })
    const before = fs.readFileSync(path.join(projectDir, 'tasks', 'T1.md'), 'utf8')

    // Worker firing task tool: even with a taskID, hook must not record (only orchestrators do).
    await plugin['tool.execute.before']({ sessionID: 'worker', tool: 'task', callID: 'call-worker-1' }, { args: { subagent_type: 'fixer', description: 'nested', prompt: 'taskID: T1\nnested' } }).catch(() => {})

    const after = fs.readFileSync(path.join(projectDir, 'tasks', 'T1.md'), 'utf8')
    assert.equal(after, before, 'worker dispatch must not mutate task stage')
  })
})

// ---------------------------------------------------------------------------
// yak_task_stage MCP tool (best-effort — skips if @opencode-ai/plugin missing)
// ---------------------------------------------------------------------------

test('yak_task_stage tool records stage when called as orchestrator', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    if (!plugin.tool?.yak_task_stage) return // skip in environments without @opencode-ai/plugin resolvable
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'orch' } } } })
    const { projectDir } = seedImplementingProject(repoRoot, ['T1'])

    const result = await plugin.tool.yak_task_stage.execute({ task_id: 'T1', stage: 'done', note: 'acceptance passed' }, { sessionID: 'orch' })
    const { frontmatter } = readMarkdownFrontmatter(path.join(projectDir, 'tasks', 'T1.md'))
    assert.equal(frontmatter.stage, 'done')
    assert.ok(result && (typeof result === 'string' || typeof result.output === 'string'))
  })
})

test('yak_task_stage tool refuses to record for non-orchestrator roles', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    if (!plugin.tool?.yak_task_stage) return
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'orch' } } } })
    seedImplementingProject(repoRoot, ['T1'])
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'worker', parentID: 'orch', taskID: 'T1' } } } })

    await assert.rejects(
      async () => plugin.tool.yak_task_stage.execute({ task_id: 'T1', stage: 'done' }, { sessionID: 'worker' }),
      /orchestrator|role/i,
    )
  })
})

// ---------------------------------------------------------------------------
// System-prompt injection: role-conditional stage instructions
// ---------------------------------------------------------------------------

test('strict-phase3 worker system prompt does not instruct workers to record task stage', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'orch' } } } })
    const { projectDir } = seedImplementingProject(repoRoot, ['T1'])
    fs.writeFileSync(path.join(projectDir, 'project.md'), '---\nstage: implementing\nphase: phase3_execution\nsubphase: dispatch\nactive_tasks: ["T1"]\n---\n')
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'worker', parentID: 'orch', taskID: 'T1' } } } })

    const out = { system: [] }
    await plugin['experimental.chat.system.transform']({ sessionID: 'worker' }, out)
    const joined = out.system.join('\n')

    // Worker prompt must be silent on stage recording entirely — no "do this"
    // and no "do not do this". Mentioning it would just introduce concepts the
    // worker doesn't need to know about.
    assert.ok(!/record\s+(every\s+)?task\s+stage/i.test(joined), 'worker prompt must not mention task stage recording at all')
    assert.ok(!/record-task-stage\.mjs/i.test(joined), 'worker prompt must not reference the node CLI')
    assert.ok(!/yak_task_stage/i.test(joined), 'worker prompt must not mention the yak_task_stage tool')
    // Worker binding proper must still be present.
    assert.match(joined, /only task T1/i)
  })
})

test('strict-phase3 orchestrator system prompt references yak_task_stage tool, not node CLI', async () => {
  const repoRoot = makeRepo(); const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yak-config-'))
  await withEnv({ OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: '' }, async () => {
    const plugin = await PlanningFilesPlugin({ directory: repoRoot })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'orch' } } } })
    const { projectDir } = seedImplementingProject(repoRoot, ['T1'])
    fs.writeFileSync(path.join(projectDir, 'project.md'), '---\nstage: implementing\nphase: phase3_execution\nsubphase: dispatch\nactive_tasks: ["T1"]\n---\n')

    const out = { system: [] }
    await plugin['experimental.chat.system.transform']({ sessionID: 'orch' }, out)
    const joined = out.system.join('\n')

    assert.match(joined, /yak_task_stage/i, 'orchestrator prompt should mention the tool name')
    assert.ok(!/node\s+\S*record-task-stage\.mjs/i.test(joined), 'orchestrator prompt must not reference the node CLI')
    assert.match(joined, /auto-recorded|automatically/i, 'orchestrator prompt should clarify dispatched/reported are auto-recorded')
  })
})

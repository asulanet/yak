# Planning Files Plugin Design

**Date:** 2026-04-16
**Status:** Historical design note — partially outdated; implementation and `yak/README.md` are current authority
**Target:** `~/.config/opencode`

> **Warning:** This design document predates the move to `.agents/yak/projects/*` and predates removal of runtime `stage: quarantined` blocking. Use current code and `yak/README.md` as the source of truth for live behavior.

## Goal

Add a plugin-backed planning authority to the local `oh-my-opencode-slim` setup so each engineering session is tracked in a project-local planning filesystem, no engineering starts before plan approval, execution is split into detailed dependency-ordered tasks, and every completed task is validated through a complexity-based review chain.

## Key Decisions

- Build on existing `oh-my-opencode-slim` internals instead of replacing them.
- Use `planning-with-files` as the workflow backbone.
- Store project planning artifacts at `<git-repo-root>/.agents/artifacts/planning`.
- During planning stage, only Markdown files inside the active planning session directory may be changed.
- Planning artifacts are written only by the orchestrator.
- Chain of command is strict: user > orchestrator > every other agent.
- If an agent lacks permission, cannot find a safe solution, gets stuck in tool/cache loops, or hits unresolved ambiguity, it must escalate to the orchestrator, and the orchestrator must ask the user rather than improvising around the constraint.
- Global user-level `AGENTS.md` is the most authoritative prompt policy.
- Designer lane should use `google/gemini-3.1-pro-preview`.

## Existing Reuse Targets

The current setup already provides strong primitives that should be extended rather than reimplemented:

- project config loading from `<project>/.opencode/oh-my-opencode-slim.json[c]`
- background child-session orchestration
- multiplexer session management and subagent depth limits
- council orchestration with presets, retries, timeouts, and parallel/serial execution
- agent model and permission overrides
- plugin-level interception of some tool activity, which the new planning plugin will extend into the authoritative mutation gate for managed runtime tools

What is missing today:

- durable project-local session store
- session-to-plan-to-task linkage
- approval-state enforcement
- strict planning-stage write jail
- detailed DAG task specs for subagents
- mandatory review recording by complexity level

## Repo Root Resolution

Planning storage is anchored to the session project root, defined by this algorithm:

1. resolve the current working directory to a real path
2. walk upward to the nearest enclosing Git worktree or repository root
3. if inside a nested repository or submodule, use the nearest enclosing Git root, not an outer parent repo
4. if inside a Git worktree, use the worktree root for planning storage
5. if no Git root is found, do not enable planning mode unless an explicit fallback policy is configured

This resolved root becomes the only valid base for:

- `.agents/artifacts/planning`
- path-jail comparisons
- task allowed-path enforcement

## Backbone: Planning With Files

This design adopts the `planning-with-files` pattern as the base memory model:

- `task_plan.md` is the authoritative session plan
- `findings.md` stores research and evidence
- `progress.md` stores running execution history

This design extends that backbone with explicit task and review artifacts:

- `tasks.md` stores the session DAG summary
- `tasks/Txxx.md` stores exact subagent task specs
- `reviews.md` stores session-level review status
- `reviews/Txxx--rN.md` stores individual validation records

## Filesystem Layout

All planning state lives under the Git repository root.

```text
.agents/artifacts/planning/
  index.md
  sessions/
    <session-id>/
      task_plan.md
      findings.md
      progress.md
      tasks.md
      reviews.md
      tasks/
        T001.md
        T002.md
      reviews/
        T001--r1.md
        T001--r2.md
```

### Session Naming

Session directory name format:

```text
YYYYMMDDTHHMMSSZ--topic-slug--random6
```

Properties:

- human-readable
- lexically sortable
- collision-safe for concurrent sessions
- safe when many sessions exist over time

### Planning Root Index

`index.md` is a planning-root summary file, not an active working file.

- it may be written only by the orchestrator
- it is updated only on session create or session close
- normal planning-stage work remains restricted to Markdown files inside the active session directory

`index.md` updates must occur under a root-level file lock so concurrent orchestrators do not corrupt shared summary state.

Reserved plugin-control files under `.agents/artifacts/planning/`:

- `index.md`
- `.root.lock`
- `sessions/<session-id>/.session.lock`
- `repo-write-lease.json`

These files are runtime control artifacts, not user-authored planning content. Only the plugin/orchestrator may create or update them.

## Session Selection, Resume, and Locking

Each session owns its own directory and lock file.

Rules:

- creating a new session always generates a new `<session-id>` directory
- resuming a session requires an explicit session id or an existing lock owned by the same orchestrator context
- if multiple open sessions exist for the repo and none is explicitly selected, the plugin must ask which session to resume instead of guessing
- if a session lock is held by another live orchestrator, a second orchestrator may read that session but may not write to it
- concurrent orchestrators may create separate sessions in the same repo, but shared-root writes such as `index.md` must use a root lock

Lock file metadata must include at least:

- session id
- owner id
- process id
- hostname
- start time
- last heartbeat time

Definitions:

- same orchestrator context = same owner id and same live process lineage
- live orchestrator = process still reachable and heartbeat inside lock TTL
- stale lock = missing live process or expired heartbeat beyond TTL

Stale-lock recovery:

- a stale lock may be taken over only after writing a takeover note to `progress.md`
- takeover updates the lock metadata with the new owner and process
- if liveness cannot be determined safely, the plugin must fail closed and ask for human confirmation

Heartbeat and TTL defaults:

- heartbeat interval: 5s
- stale threshold: 30s without heartbeat
- takeover check must be performed under the root lock

This prevents two orchestrators from silently sharing one mutable planning state.

## Repo Write Lease

Multiple planning sessions may coexist in one repo, but managed implementation requires a repo-wide write lease.

Canonical storage:

- `.agents/artifacts/planning/repo-write-lease.json`

Rules:

- only one session may hold the repo write lease at a time
- only the lease holder may enter `implementing` or `validating`
- other sessions may continue read-only planning or await approval
- releasing the lease happens on completion, explicit stop, or stale-lock recovery

Acquire semantics:

- lease acquisition must be atomic via create-without-overwrite or compare-and-swap under the root lock
- the lease file records session id, owner id, process id, hostname, acquired time, and last heartbeat
- entering `implementing` is allowed only after successful atomic lease acquisition
- if acquisition fails, the session remains outside `implementing` and must wait or ask the user

Lease heartbeat and recovery:

- lease heartbeat interval defaults to 5s
- lease becomes stale after 30s without heartbeat
- stale lease takeover must occur under the root lock
- takeover rewrites `repo-write-lease.json` atomically and appends a takeover note to `progress.md`
- if stale ownership cannot be established safely, fail closed and require human confirmation

This is the default safety rule. Finer path-scoped concurrent implementation is out of scope for the initial version.

## Session State Model

The active session state is stored in `task_plan.md` frontmatter.

Example:

```md
---
session_id: 20260416T120000Z--planning-plugin--ab12cd
repo_root: /absolute/repo/path
session_dir: .agents/artifacts/planning/sessions/20260416T120000Z--planning-plugin--ab12cd
plan_revision: 3
approved_revision: null
stage: planning
approved_by: null
approved_at: null
active_tasks: []
---
```

`active_tasks` is derived convenience metadata only. Canonical task state remains in `tasks.md`.

### Stages

- `planning`
- `awaiting_approval`
- `implementing`
- `validating`
- `completed`

`validating` at the session level means final whole-session verification after all required task-level reviews are finished. It is separate from task-level `validating` status.

Transition rules:

- `planning -> awaiting_approval` when the orchestrator finishes the draft plan
- `awaiting_approval -> implementing` only after explicit user approval
- orchestrator records `approved_by` and `approved_at` at the moment of approval
- orchestrator also records `approved_revision`, which must equal current `plan_revision`
- no implementation work before `stage: implementing` and non-null approval fields
- orchestrator alone changes stage values
- a task cannot be marked done without recorded validation
- only approval-sensitive plan changes increment `plan_revision`, clear approval fields, and return the session to `awaiting_approval`

Approval-sensitive plan changes include:

- session goal or scope changes
- phase structure changes
- task addition/removal
- dependency graph changes
- complexity level changes that widen scope, change dependencies, or alter required edit boundaries
- assigned-agent changes
- allowed-path changes
- acceptance-criteria changes

Operational updates do not clear approval. Examples:

- status updates in `tasks.md`
- review summaries in `reviews.md`
- append-only logs in `progress.md`
- review files under `reviews/`

## Hard Gate Enforcement

Prompt instructions are insufficient. The enforcement must live in plugin/runtime policy.

The guarantee is scoped to managed OpenCode runtime behavior: registered tools, delegated child sessions, and plugin-mediated actions. Manual edits outside the runtime remain outside enforcement.

### Planning-Stage Write Jail

When session stage is not `implementing|validating|completed`:

- only the orchestrator may write planning Markdown
- all subagents remain read-only, including planning and research subagents
- `write`, `edit`, `apply_patch` allowed only for `*.md` files in the active session directory
- `mkdir` allowed only under the active planning directory
- `rm` denied
- `ast_grep_replace` denied
- `lsp_rename` denied
- implementation-oriented subagent dispatch denied

The only planning-root exception is orchestrator-managed maintenance of `index.md` during session create/close.

Plugin-control file exceptions are also allowed for the plugin/orchestrator runtime only:

- creating/updating `.root.lock`
- creating/updating the active session `.session.lock`
- creating/updating `repo-write-lease.json` when lease state changes

Subagents never receive write permission to these control files.

### Shell Policy

During planning stage, shell access is restricted to a read-only allowlist such as:

- `ls`
- `find`
- `rg`
- `grep`
- `cat`
- `sed -n`
- `git status`
- `git diff --name-only`

Mutating shell commands are denied until implementation starts.

Shell enforcement is argv-level, not command-name-only. During planning stage the plugin must reject:

- redirection (`>`, `>>`, `<`)
- subshells
- command chaining
- `find -exec`
- `xargs`
- `tee`
- pipes to commands that can write or mutate

If strict argv parsing is unavailable for a shell path, that shell action is denied.

### Path Jail

For every allowed planning-stage mutation:

- normalize path
- resolve symlinks
- reject traversal outside repo root
- reject non-Markdown targets
- reject targets outside active session directory

### Post-Action Audit

Defense-in-depth audit runs after every allowed mutation in planning mode and before stage transition to `awaiting_approval` or `implementing`.

The audit checks the exact allowed path set for the current stage, not just file type.

If any write lands outside the active session directory and the explicit `index.md` exception, stage transition fails.

If out-of-bounds mutation is detected at runtime, the plugin must fail closed immediately:

- abort the active action or child session if possible
- append contamination details to `progress.md`
- reopen the project in a safe planning state for re-approval
- deny or abort only the offending action/session, not the whole project forever

### Scope of Protection

This hard gate can prevent agent-side escape inside managed OpenCode execution.
It cannot prevent manual user edits made outside the runtime.

## Implementation-Stage Artifact Protection

The planning filesystem remains orchestrator-owned even after approval.

During `implementing` and `validating`:

- only the orchestrator may modify `.agents/artifacts/planning/**`
- the orchestrator may not modify non-planning repo files directly as part of managed implementation
- implementation and review agents are denied all writes under the planning root
- subagents return reports in message payloads only
- the orchestrator persists accepted outcomes into planning Markdown files

For acceptance verification reruns, the orchestrator may temporarily execute verification commands using the active task's `allowed_paths` plus `allowed_ephemeral_paths`, but may not widen them.

This preserves the mandatory task and review chain: code changes must come through a dispatched task, not direct orchestrator editing.

## Task-Scoped Write Jail

Task specs are not advisory only. The plugin enforces a per-task write boundary for implementation agents.

For each dispatched implementation task, the child session receives a runtime policy derived from `tasks/Txxx.md`:

- allowed write paths
- allowed ephemeral output paths
- forbidden paths
- allowed shell commands
- task id and session id

During task execution, mutating tools are allowed only inside the task's declared `allowed_paths`.

This applies to:

- `write`
- `edit`
- `apply_patch`
- `ast_grep_replace`
- `lsp_rename`
- mutating shell commands

If a task needs broader scope, it must be escalated and re-issued by the orchestrator with an updated task file.

The enforcement model is default-deny: any mutating capability not explicitly permitted by the active session stage and active task policy is denied, including future tools and plugin actions.

To make that guarantee real, the planning plugin must be the single mutation-policy authority for managed runtime actions. Existing partial interception points are reused as implementation hooks, but policy decisions come from one central gate.

Task-stage path enforcement uses the same normalized-path checks as planning stage:

- normalize path
- resolve symlinks
- reject traversal outside repo root
- reject writes outside task `allowed_paths`

Task-stage shell enforcement is also argv-level and deny-by-default. A shell action is allowed only when:

- the command form is explicitly permitted by task policy
- every resolved file target remains inside `allowed_paths` or declared `allowed_ephemeral_paths`
- redirection, subshells, command chaining, `xargs`, `tee`, and equivalent escape hatches are rejected unless the task policy explicitly models and constrains them

Verification and test commands that generate side effects must declare their non-source outputs up front, for example cache, coverage, temp, or build directories. Undeclared generated outputs are treated as path-jail violations.

The same `allowed_ephemeral_paths` contract applies when the orchestrator reruns `required_for_acceptance` verification.

## Chain of Command

### Orchestrator

Owns the planning session and is the only writer to the planning filesystem.

Authority order:

1. user
2. orchestrator
3. every other agent

Responsibilities:

- create session and planning files
- maintain session state
- maintain DAG and task specs
- decide when tasks are ready
- dispatch subagents with bounded specs
- validate returned work
- record review decisions

### Research / Advisory Agents

- `explorer`: read-only, planning and review evidence
- `librarian`: read-only, external docs and API evidence
- `oracle`: read-only advisor and high-review owner
- `council`: read-only medium-review engine

### Implementation Agents

- `fixer`: bounded code implementation only during implementation stage
- `designer`: bounded UI/UX implementation only during implementation stage

Implementation agents:

- cannot write planning artifacts
- cannot self-approve
- cannot widen scope
- receive exact task packets only
- must escalate instead of improvising when blocked by permissions, unresolved ambiguity, missing context, repeated failed attempts, or loop-like behavior

## Escalation Policy

When any non-orchestrator agent:

- lacks required permissions
- cannot find a safe solution inside the approved task bounds
- detects repeated failure or loop-like behavior
- encounters unresolved ambiguity that changes behavior or scope
- needs access beyond its granted paths, tools, or shell forms

it must stop, report the blockage, and return control to the orchestrator.

When the orchestrator cannot safely resolve that blockage within the approved plan and permissions, the orchestrator must ask the user for manual input or a new decision instead of bypassing the guardrails.

## Task Graph Model

`tasks.md` is the session-level DAG index.

Canonical ownership:

- `task_plan.md` is canonical for session stage, approval state, and top-level phases
- `tasks.md` is canonical for task status, dependencies, complexity, assignment, and blocked state
- `tasks/Txxx.md` is canonical for task instructions, path bounds, acceptance criteria, and verification steps
- `reviews/Txxx--rN.md` is canonical for individual review verdicts and evidence
- `reviews.md` is a summary index derived from task review files
- `progress.md` is an append-only narrative log, never the canonical task state

Each task record includes:

- task id
- title
- status
- complexity: `low|medium|high`
- dependencies
- parallel group
- assigned agent
- allowed paths
- blocked-by state
- validation route
- plan revision binding

### Task Lifecycle

- `draft`
- `ready`
- `dispatched`
- `reported`
- `validating`
- `done`

Failure states:

- `blocked`
- `rework_required`
- `rejected`

Task terminal states are `done` and `rejected`.

`rejected` means the current task record cannot proceed as planned. A rejected task blocks session completion until one of these happens:

- the task is replaced by a newly planned task
- the scope is explicitly removed by the user, which triggers a plan revision and re-approval

Rework loop:

- `rework_required -> ready` after the orchestrator updates or reaffirms the task spec
- `ready -> dispatched` on the next bounded execution attempt

If an approval-sensitive plan change occurs while tasks are in flight:

- all `dispatched`, `reported`, or task-level `validating` work becomes stale
- stale tasks are aborted if possible, otherwise their outputs are ignored
- affected tasks return to `draft` or are replaced by new task ids under the new plan revision
- implementation may not resume until the revised plan is re-approved

### Detailed Task Spec

Each `tasks/Txxx.md` file must include:

- plan revision / approved revision binding
- goal
- rationale
- preconditions
- exact files allowed to edit
- allowed ephemeral output paths
- exact files forbidden
- allowed shell command forms
- step-by-step instructions
- acceptance criteria
- verification commands, including which are `required_for_acceptance`
- required report format
- escalation rules
- explicit anti-improvisation instruction

## Dispatch Rules

A task may be dispatched only when:

- the task is either a read-only planning/research task in `planning|awaiting_approval`, or an implementation task in `implementing`
- implementation tasks require both non-null `approved_by` and `approved_at`
- dependencies are complete
- no upstream rework blocks it
- assigned agent type is defined

Parallel dispatch is allowed only when tasks are explicitly marked safe and their file domains do not conflict.

The orchestrator may not bypass this by editing code directly.

Read-only planning-stage tasks may use only advisory agents and inherit the planning-stage write jail.

## Validation Protocol

Implementation completion never means acceptance.

Task flow is always:

```text
dispatched -> reported -> validating -> done | rework_required | blocked
```

Every review receives a packet built by the orchestrator:

- task spec
- relevant plan sections
- subagent report
- changed file list
- diff summary
- verification outputs
- task path rules
- task plan revision binding

Verification trust boundary:

- implementers must run task-specified verification and include raw command outputs in their report
- low-complexity acceptance requires orchestrator rerun of every task command marked `required_for_acceptance` before marking done
- medium and high reviews may inspect reported outputs, but orchestrator still reruns every task command marked `required_for_acceptance` before final acceptance
- reviewers may not approve solely from subagent claims without attached evidence

If the reviewer or orchestrator detects that the task was under-scoped or under-classified, validation must stop and the task complexity must be promoted before acceptance.

## Complexity-Based Review Routing

### Low

Reviewer: orchestrator

Use for:

- research tasks
- simple bounded mechanical tasks
- low-risk single-file work

Checks:

- changed only allowed files
- meets acceptance criteria
- no obvious plan deviation
- required verification executed

### Medium

Reviewer: council preset `medium-review`

Use for:

- normal implementation chunks
- bounded multi-file work
- work with moderate risk of hidden deviation or correctness issues

Expected result:

- synthesized verdict on plan compliance and correctness

### High

Reviewer: oracle high-review lane

Use for:

- architecture-sensitive work
- high-risk refactors
- security/data/correctness critical work
- tasks where review failure would be expensive

Oracle may use read-only helpers during review only:

- `explorer` for code evidence
- `librarian` for specification/API evidence
- optional `council` only if the high-review preset explicitly requests it

Oracle remains the decision-maker.

### Review Verdicts

Every review ends with one of:

- `approved`
- `approved_with_notes`
- `rework_required`
- `blocked`

## Complexity Promotion Rules

Complexity is planned up front but may be promoted later.

Mandatory promotion path:

- `low -> medium` when the orchestrator sees multi-file risk, unclear correctness, or non-trivial deviation
- `medium -> high` when council finds architecture, security, data-integrity, or broad-system risk
- direct `low -> high` allowed when severe risk is discovered immediately

Promotion effects:

- task returns to `validating` or `rework_required`
- higher review lane becomes mandatory
- orchestrator updates `tasks.md`, `reviews.md`, and `progress.md`
- task cannot be closed under its old lower review level

Pure review-lane promotion by itself does not clear approval unless it also changes scope, dependencies, allowed paths, or acceptance criteria.

The orchestrator records review outcomes in:

- `reviews/Txxx--rN.md`
- `reviews.md`
- `tasks.md`
- `progress.md`

Each `reviews/Txxx--rN.md` file must carry the reviewed task id plus the task's bound plan revision so stale reviews cannot be attached to a newer plan.

## Session Close Gate

Session stage may move to `validating` only when all required tasks are resolved for the current approved revision.

Resolved means:

- task is `done`, or
- task has been intentionally removed from scope through an approved replan

Session stage may move to `completed` only when:

- all tasks are terminal
- no task remains in `rework_required`, `blocked`, or unresolved `rejected`
- every implementation task has a recorded review artifact
- final progress summary is written
- `index.md` receives the close summary entry

## Model Lanes

- orchestrator: `openai/gpt-5.4`
- explorer: fast/cheap lane
- librarian: fast/cheap lane with stronger fallback if needed
- fixer: fast/cheap primary, stronger fallback only after escalation
- designer: `google/gemini-3.1-pro-preview`
- council medium review: diverse councillors + strong master
- oracle high review: strongest model / high reasoning variant

## Configuration Additions

Project config remains in:

- `<project>/.opencode/oh-my-opencode-slim.jsonc`

Add a `planning` block with structured knobs such as:

- `enabled`
- `root`
- `enforce_stage_gates`
- `readonly_shell_allowlist`
- `task_complexity_routes`
- `review_presets`
- `session_naming`

The global user-level `AGENTS.md` remains the most authoritative prompt policy. Runtime enforcement still wins over prompt drift.

## Integration Strategy

Implement as a plugin-driven extension of the existing local slim setup.

Primary extension points:

- session-tracking plugin behavior
- tool interception for mutating commands
- background dispatch gating
- council preset routing for medium review
- oracle review workflow for high review
- project config loading for planning policy

The design intentionally avoids making project-local prompt overlays mandatory. Prompt policy can remain centered on the global user-level `AGENTS.md`, while runtime policy enforces hard gates.

## Non-Goals

- replacing slim orchestration internals wholesale
- keeping `.tmp/tasks` as the canonical task store
- allowing subagents to write planning artifacts directly
- relying on prompt instructions alone for safety

## Risks

- incomplete mutating-tool interception could leave escape paths
- overly strict shell policy may hurt useful planning-stage discovery
- incorrect task complexity tagging could under-review risky work
- project-root detection must be exact for nested repos and worktrees

## Success Criteria

- every complex session creates a unique planning session directory
- no non-planning files can be mutated during planning stage through managed runtime tools
- no implementation task launches before approval
- every implementation task has a detailed task file and dependency state
- every completed task has a recorded review result
- medium and high tasks route through the correct review lane automatically

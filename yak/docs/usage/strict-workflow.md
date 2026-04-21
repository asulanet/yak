# Strict Workflow

Four phase states. Phase 0 is permissive; Phases 1-3 are strict.

## Phase 0: exploration (default for new projects)

- New projects bootstrap with `phase: phase0_exploration`, `subphase: idle`, `stage: exploration`.
- No workflow restrictions active — the tool layer only blocks hard-protected paths (`.git`, `.env*`) and a short list of destructive shell commands (`git push`, package installs, `terraform apply`, mutating `gh` commands, etc.).
- The orchestrator is told to behave like a normal OpenCode session and to proactively offer "yak it" when the user's request is substantial (multi-step features, refactors, architectural changes, unclear-root-cause debugging).

### Entering strict mode

Users move into Phase 1 via one of these trigger phrases (case-insensitive, detected in chat messages):

- `/yak`
- `yak it`
- `yak this`
- `yak this project`
- `yak the project`
- `yak project`
- `let's yak`

On trigger, the runtime updates `project.md` frontmatter to `phase: phase1_discovery`, `subphase: scope_draft`, `stage: planning` and appends a progress line. Strict constraints apply from the next turn.

### Exiting strict mode

Users can leave strict mode via `unyak`, `stop yak`, `exit yak`, or `/unyak`. The project returns to `phase0_exploration`.

Programmatic helpers `activateYakForSession(sessionID)` and `deactivateYakForSession(sessionID)` are exposed on the plugin for scripted toggling.

## Phase 1: discovery / research / plan shaping

- Gather facts, constraints, risks, and open questions.
- Refine scope until execution is safe to decompose.
- Keep looping: discover -> update plan -> re-check gaps.
- Optional **Plan Critic** may run at phase end; user may skip it.

Plan Critic rollout states:

- offer path: `critic_status: offered`
- record path: `critic_status: <completion state>`
- skip path: `critic_status: skipped`

Exit criteria:

- scope is stable enough to decompose
- open questions are either answered or explicitly deferred
- plan is ready for task DAG creation

## Phase 2: task DAG

- Turn the approved plan into a dependency-ordered DAG.
- Each task gets an exact contract and review route.
- Review mode is either:
  - **one-by-one**: next task starts only after prior task review passes
  - **approve-all**: review batch first, then execute the approved set

Use one-by-one for tight coupling or high risk. Use approve-all only when tasks are independent and review cost is lower than serial gating.

## Phase 3: execution snapshot

- Freeze the approved task set into an execution snapshot.
- Execute only snapshot tasks.
- No new-task rule: discoveries become follow-up backlog items, not live execution scope.
- If scope changes materially, reopen an earlier phase instead of mutating the snapshot in place.

### Stage recording (dispatch-lifecycle)

Only the orchestrator records task stages. Subagents never do — their system prompt forbids it, and the `yak_task_stage` tool rejects non-orchestrator callers.

| Transition | Who | How |
|---|---|---|
| `approved -> dispatched` | runtime | auto on `task` / `background_task` tool fire |
| `dispatched -> reported` | runtime | auto on `task` / `background_task` tool return |
| every other transition | orchestrator | call the `yak_task_stage` tool with `{ task_id, stage, note? }` |

The `node yak/scripts/record-task-stage.mjs` CLI is retained for humans, CI, and migration scripts. LLM sessions (orchestrator included) should use the `yak_task_stage` tool instead.

## Task contract frontmatter

Each task file should carry machine-readable frontmatter. Real keys:

- `task_id`
- `plan_revision`
- `approved_revision`
- `stage`
- `role_hint`
- `complexity` (`low` / `medium` / `high`; map trivial -> `low`, critical -> `high`)
- `domain_hint`
- `model_override` (concrete `{ provider, model, variant }` object)
- `effective_model`
- `degraded_from`
- `depends_on`
- `expected_paths`
- `protected_paths`
- `allowed_ephemeral_paths`
- `allowed_shell_command_forms`
- `required_for_acceptance`
- `inputs`
- `outputs`
- `acceptance_criteria`
- `escalation_rules`
- `test_strategy`

### Field semantics

- `expected_paths` is a soft review signal used at review/observer time.
- `expected_paths` is not a runtime write jail.
- `protected_paths` is a hard deny.
- Hardened zones such as git, env, and global config are also hard deny.
- `allowed_ephemeral_paths` covers short-lived scratch output only.
- `allowed_shell_command_forms` constrains shell shape for the task.

## Degradation

If the preferred route is unavailable, Yak should degrade to the nearest safe fallback and mark the task/session for user visibility.

User-visible degradation data:

- task frontmatter: `degraded_from`
- progress log entry describing the fallback and impact

Degraded mode must explain:

- what route failed
- what fallback is active
- whether approval, review depth, or routing changed

## Model routing examples

Use concrete built-in entries.

- reviewer / medium -> `oracle` (`openai/gpt-5.4` `xhigh`)
- implementer / medium -> `sonnet-impl` (`anthropic/claude-sonnet-4-5` `medium`)
- implementer / high -> `opus-impl` (`anthropic/claude-opus-4-7` `max`)
- critic -> `opus-critic` (`anthropic/claude-opus-4-7` `max`)
- designer -> `designer` (`google/gemini-3.1-pro-preview` `high`)
- domain `graphql` -> `coder-hi` (`openai/gpt-5.4` `high`)
- domain `plan-critic` -> `opus-critic`

## Working on multiple things in one workspace (batches)

A workspace / Yak project is a long-lived container. You can run multiple sequential "batches" inside it — each batch is one full Phase 1→3 cycle. When a batch finishes, a new batch gets a clean Phase 1 while carrying prior findings / context / unselected backlog items.

### Flow

1. Finish current batch (execution complete, no active tasks).
2. Start next batch via one of:
   - Trigger phrase: `/yak new`, `/yak new-batch`, `new yak`, `next yak batch`.
   - CLI: `node yak/scripts/start-new-batch.mjs --summary "<closing batch recap>" [--policy abandon|carry|cancel]`.
3. If the closing batch has tasks in non-terminal states, Yak prompts for a policy:
   - `abandon` — tasks archive with stage rewritten to `abandoned`.
   - `carry` — tasks clone to the new batch as `B<N+1>-T###`; original `depends_on` preserved verbatim.
   - `cancel` — transition aborts, no mutations.
4. The new batch starts at `phase1_discovery / scope_draft`. Phase 1 prompt prepends a digest of prior batches (sourced from `batch-summary.md`) so scope discovery builds on prior work.

### What persists vs archives

| Artifact | Behavior |
|---|---|
| `findings.md`, `context.md` | carry live (tag new entries `[B<N>]`) |
| `progress.md` | rotate — old entries wrapped in `<!-- batch N archive -->` markers |
| `backlog.md` `Now` / `Later` / `Blocked` | carry live |
| `backlog.md` `Done` / `Dropped` | archive to `batches/<N>/backlog-archived.md` |
| `tasks/`, `tasks.md`, `execution-snapshot.md`, `reviews.md`, `reviews/` | archive to `batches/<N>/` |
| `batch-summary.md` | append one section per closed batch |

### Gate-regex hardening

Questions about new batches, starting batches, or incomplete-task policies (abandon/carry/cancel) do **not** auto-trigger phase gates, unlike phase approval Questions. This prevents the orchestrator from silently approving execution of the wrong task set when surfacing batch-related choices to the user.

### Crash safety

The transition is journaled. If the process dies mid-flow, the journal file `.batch-transition-journal.json` and `.batch-transition-staging/` remain. On next load (or via `start-new-batch.mjs --recover`), `recoverInterruptedBatchTransition` detects leftover state and rolls back (for `status=prepared`/`committing`) or finalizes (for `status=committed`). Stale transition locks with heartbeats older than `STALE_TRANSITION_LOCK_MS` (60s default) are auto-reclaimed.

## README alignment notes

See also:

- `yak/README.md` for runtime backbone, task-contract routing, and degradation policy
- `yak/plugins/planning-files/README.md` for plugin ownership, hard-deny policy, and strict workflow summary

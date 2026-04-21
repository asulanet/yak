# Yak

User-level workflow/runtime layer for OpenCode.

## Ownership

- Slim owns models, providers, variants, presets.
- Yak owns workflow, runtime policy, project plumbing, planning artifacts.
- User config lives at `~/.config/opencode/yak.jsonc`.
- Project config lives at `<repo>/.opencode/yak.jsonc`.

## Precedence

1. built-in Yak defaults
2. user `yak.jsonc`
3. project `yak.jsonc`
4. runtime session state

Arrays replace. Objects deep-merge. Scalars override.

## Project model

- Durable planning state lives under `<repo>/.agents/yak/projects/<project-slug>/`.
- Canonical project artifacts are markdown files with frontmatter for machine validation.
- `active_project_slug` is runtime-only per OpenCode session.
- Startup behavior:
  - zero projects: create default project from sanitized repo basename
  - one project: auto-bind it
  - multiple projects: require explicit selection before mutation
- Multiple-project limitation: one OpenCode session can act on one active project at a time.
- No `session-index.json`.
- No session-based recovery identity.

## Strict workflow backbone

- Yak tracks four phase states in `project.md` frontmatter:
  - `phase0_exploration` — lightweight default for brand-new projects; no workflow restrictions except hard-protected paths and destructive shell forms.
  - `phase1_discovery` — strict planning / research / plan shaping
  - `phase2_tasks` — strict task DAG editing
  - `phase3_execution` — frozen execution snapshot
- Users transition Phase 0 → Phase 1 via trigger phrases such as `yak it`, `yak this`, `/yak`, or via the `activateYakForSession` helper. Users can return to Phase 0 via `unyak`, `stop yak`, or `/unyak`.
- Each phase also tracks a `subphase` in `project.md` frontmatter.
- Phase movement is strict forward through approval gates, but backward reopening is allowed when new findings invalidate current scope.
- Phase approvals must come from the question tool, not loose natural-language guesses.
- Execution starts only after:
  - Phase 1 approval
  - Phase 2 approval
  - explicit execution approval
- When execution is authorized, Yak freezes the approved task set into `execution-snapshot.md`.
- New ideas discovered during execution go to draft/backlog state, not the active execution snapshot.
- Doc guide: `yak/docs/usage/strict-workflow.md`
- Task contracts carry `task_id`, revision/stage metadata, routing hints, path policy, inputs/outputs, and acceptance fields.
- Route fallback must set task-level `degraded_from` plus a visible progress log entry instead of failing silently.

## Runtime safety model

- Orchestrator policy is default-allow inside repo.
- Tool-mediated orchestrator file mutations still hard-block repo escapes plus protected paths like `.git/**` and `.env*`.
- Orchestrator shell uses a targeted denylist for critical external/remote/destructive actions instead of a syntax allowlist.
- Worker sessions remain broad across repo root except hard-protected zones (git internals, env files, global config, task protected_paths, `.agents/**`, and similar safety boundaries); `expected_paths` is a review-time signal for spread legitimacy, not a runtime jail. No Yak control-file writes.
- Stage values remain workflow state; they do not act as general orchestrator shell/file handcuffs.

## Project artifacts

Each project folder contains machine-readable markdown artifacts:

- `project.md` — canonical phase, subphase, revisions, approvals, active tasks
- `context.md` — durable constraints, assumptions, clarifications, tools
- `findings.md` — reusable research, decisions, corrections, evidence
- `backlog.md` — draft/later/blocked/dropped items
- `tasks.md` — task DAG overview and review-loop notes
- `reviews.md` — task/global review summary
- `execution-snapshot.md` — frozen approved task set for current execution run
- `tasks/*.md` — task contracts
- `reviews/*.md` — review records

## Review and policy propagation

- Repo-local `AGENTS.md` remains authoritative for repo-specific rules.
- Lower-level subagents inherit Yak workflow restrictions plus repo-local `AGENTS.md` guidance.
- Review packets should check workflow compliance, not only code quality:
  - phase compliance
  - execution snapshot compliance
  - drift escalation compliance
  - acceptance criteria compliance
  - repo `AGENTS.md` compliance
  - actual vs expected path spread legitimacy

## Portability

- No absolute laptop paths in runtime.
- Resolve config roots from `OPENCODE_CONFIG_DIR`, then `XDG_CONFIG_HOME`, then `~/.config/opencode`.
- Resolve repo paths from the active repo root.
- No repo-bound startup crash; skip project config when no repo root exists.
- Compatibility shim: `node ~/.config/opencode/yak/scripts/recover-project.mjs [repo-path] [--project <slug>]` normalizes legacy `stage: quarantined` projects back to `planning`. Normal runtime should auto-heal without manual recovery.

## Activation contract

- Canonical loader: `~/.config/opencode/plugins/yak.js`
- Yak auto-loads through local plugin discovery.
- No `opencode.json` plugin registration required for Yak startup.

## JSONC parser provenance

`yak/vendor/jsonc-parser.js` is a vendored lightweight parser shim used for Yak config parsing.
It strips JSONC comments/trailing commas before `JSON.parse` and throws a clear `Invalid JSONC` error on failure.

## Batches (multi-batch workflow)

A workspace / Yak project can host multiple sequential "batches" — each batch is one full Phase 1→3 cycle. Shared memory (findings, context, progress, backlog 'later') carries across batches; batch-scoped artifacts (`tasks/`, `tasks.md`, `execution-snapshot.md`, `reviews.md`, `reviews/`) archive into `<project>/batches/<N>/` when a new batch opens. Batch-field persistence is lazy — legacy projects without `current_batch` on disk round-trip byte-identically until the first real transition materializes them.

- **Task IDs**: Batch 1 uses bare `T###` (no retroactive rename). Batch 2+ uses `B<N>-T###` with per-batch reset numbering.
- **Trigger phrases**: `/yak new`, `/yak new-batch`, `new yak`, `next yak batch`. Bare "new batch" is deliberately NOT a trigger (too generic for a global message hook).
- **CLI**: `node yak/scripts/start-new-batch.mjs --summary "<text>" [--policy abandon|carry|cancel] [--dry-run] [--recover]`. Dry-run calls `planTransition` and renders the plan without mutations.
- **Incomplete-task policies**: if the closing batch has tasks in non-terminal states, pick one — `abandon` (archive with stage rewritten to `abandoned`), `carry` (clone into new batch as `B<N+1>-T###` with `depends_on` preserved verbatim; no rewrite — runtime doesn't consume dep edges today), or `cancel` (abort the transition, no mutations).
- **Crash safety**: the transition is journaled (`.batch-transition-journal.json`) with staging; crash mid-flow leaves the journal + staging behind, and `recoverInterruptedBatchTransition({projectDir})` rolls back or finalizes based on journal status.
- **Phase 1 digest**: when `current_batch > 1`, the phase1 system prompt prepends the contents of `batch-summary.md` (truncated past `PHASE1_DIGEST_MAX_CHARS`) so scope discovery in the new batch builds on prior work.
- **Gate-regex hardening**: Questions containing `new batch`, `start batch N`, or incomplete-task policy keywords (`abandon`/`carry`/`cancel` + `tasks`) are deliberately excluded from `detectGateRequest`. This prevents phase-gate auto-approval collisions discovered during the feature's own Phase 2.

See `yak/docs/usage/strict-workflow.md` for the user-facing flow.

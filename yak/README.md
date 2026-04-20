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

- Yak enforces three top-level phases:
  - `phase1_discovery`
  - `phase2_tasks`
  - `phase3_execution`
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

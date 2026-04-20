# Planning Files Plugin

Local planning authority plugin for OpenCode slim setup.

Owns:
- project-local planning session bootstrap
- planning/runtime mutation policy hooks
- lock and write-lease helpers
- review routing helpers
- strict phase/subphase gate enforcement
- execution snapshot freezing and task-binding helpers
- question-tool approval capture and reusable clarification persistence

Does not own:
- global user policy (`AGENTS.md`)
- slim council internals
- manual edits outside managed OpenCode runtime

Key runtime rules:
- orchestrator is default-allow inside repo
- tool-mediated orchestrator file mutations still hard-block protected paths (`.git`, `.env*`) and repo-root escapes
- orchestrator shell uses a targeted denylist for critical external/remote/destructive actions, not a general syntax allowlist
- implementation starts only after question-tool approval gates
- workers bind to exact task ids when available
- workers write broadly across repo root except hard-protected zones (git internals, env files, global config, task protected_paths, `.agents/**`, and similar safety boundaries); `expected_paths` is a review-time signal for spread legitimacy, not a runtime jail
- stages are workflow state, not orchestrator shell/file handcuffs

Strict workflow docs:
- `yak/docs/usage/strict-workflow.md`
- Phase 1: discovery/research/plan shaping, optional Plan Critic at phase end
- Plan Critic states: offered, skipped, or recorded to completion
- Phase 2: task DAG with one-by-one or approve-all review
- Phase 3: frozen execution snapshot, no new-task rule
- Task contracts should carry revision, role, path, routing, inputs/outputs, acceptance, escalation, and test fields
- Fallback routing must surface `degraded_from` plus a progress log entry to users

# Yak Role-Based Permission Model Implementation Plan

**Goal:** Make Yak permissions depend on role, stage, tool, and path scope so orchestrator can edit only Yak project files while execution workers can patch task-scoped repo files.

**Architecture:** Root session acts as orchestrator with Yak-only write authority. Child sessions inherit project binding and are treated as execution workers with task-scoped mutating permissions. Direct mutating tools use path-aware validation instead of global deny where safely implementable.

## Tasks

### Task 1: Add role binding to runtime sessions
- [ ] Determine orchestrator vs worker role from session lineage
- [ ] Store role in runtime session state

### Task 2: Enforce orchestrator Yak-only writes
- [ ] Restrict direct mutating tools for orchestrator to `.agents/yak/**` project control files only

### Task 3: Allow worker `apply_patch` with path-aware preflight
- [ ] Parse Yak apply_patch envelope
- [ ] Validate touched src/dst paths against task allow/forbid rules
- [ ] Reject whole patch if any path escapes scope

### Task 4: Add tests
- [ ] Orchestrator denied product-code apply_patch
- [ ] Worker allowed scoped apply_patch
- [ ] Worker denied escaped apply_patch

### Task 5: Verify
- [ ] Targeted tests
- [ ] Full planning-files suite

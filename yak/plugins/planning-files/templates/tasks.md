---
project_slug: {{ACTIVE_PROJECT_SLUG}}
schema_version: 1
task_graph_revision: 0
review_mode: overview
---

# Tasks

## DAG

Project scope: {{ACTIVE_PROJECT_SLUG}}

<!--
Task-ID convention (multi-batch workflow):
- Batch 1 uses bare `T###` IDs (legacy; no retroactive rename).
- Batch 2 and later use the `B<N>-T###` prefix, per-batch reset numbering.
When a new batch opens, this file archives into batches/<N>/tasks.md.
-->

| id | title | status | depends_on | unlocks | inputs | outputs | acceptance | expected_paths |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Review Notes

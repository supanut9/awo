---
id: plan-a-goal
name: Plan a goal
description: Sequence for turning a refined requirement into planned tasks
appliesTo: [{{PROJECT_KEY}}-G]
---

Sequence for `awo goal plan {{PROJECT_KEY}}-G#`, owned by `tech-lead` (preceded by
**capture-requirement**, owned by `product-manager`):

1. Read the goal's objective, definition-of-done, and scope/constraints.
2. Identify the repos in scope (must be a subset of the goal's `targets`).
3. Draft tasks, each with a single clear objective, its own `targets`, and
   any `dependsOn` ordering.
4. Write each task file under `goals/{{PROJECT_KEY}}-G#/tasks/` and populate the goal's
   `taskIds`.
5. Leave tasks in `pending` status for human review before `awo task run`
   is used (draft → approve gate).
6. Once every task reports `success` (see **ship-a-change**), hand off to
   `qa-engineer` for **verify-acceptance-criteria** before the goal is
   marked `done` (rule: `acceptance-criteria-required`). A gap found there
   re-enters via `file-bug` → back to `product-manager`.

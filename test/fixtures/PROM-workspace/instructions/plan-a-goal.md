---
id: plan-a-goal
name: Plan a goal
description: Sequence for turning a refined requirement into planned tasks
owner: tech-lead
appliesTo: [PROM-G]
summary: Plan a goal
---

Sequence for `awo goal plan PROM-G#`, owned by `tech-lead` (preceded by
**capture-requirement**, owned by `product-manager`):

1. Read the goal's objective, definition-of-done, and scope/constraints.
2. Identify the repos in scope (must be a subset of the goal's `targets`).
3. Draft tasks, each with a single clear objective, its own `targets`, and
   any `dependsOn` ordering.
4. Create each task with `awo task new --goal PROM-G# --name "…" --targets <repo>
   [--depends-on PROM-T#] [--agent <agent>]`. It allocates the next task ID,
   places the file under `tasks/`, validates `targets` against the manifest, and
   wires the goal's `taskIds`. Then fill in Objective / Steps / Done when.
   Do NOT hand-author task files or invent IDs — the command owns both.
   - **Pick the right role.** `awo agent list` shows what is installed and what is
     still in the catalog; `awo agent add <name>` installs one. Schema/data-model
     work belongs to `data-engineer`, not `software-engineer` — install it rather
     than assigning data work to an implementer.
   - **Flag thinking-heavy work.** A task's model tier follows its role, so add
     `tier: high` to a task whose work needs judgment even though the role
     normally runs low (e.g. "define the data model"). See §12.
5. Leave tasks in `todo` status for human review before `awo task run`
   is used (draft → approve gate).
6. Once every task reaches `done` (see **ship-a-change**), hand off to
   `qa-engineer` for **verify-acceptance-criteria** before the goal is
   marked `done` (rule: `acceptance-criteria-required`). A gap found there
   re-enters via `file-bug` → back to `product-manager`.

Finally, record the run (rule: `record-every-run`):
`awo log add --label <short-slug> --agent tech-lead --model <model> --started <iso-when-you-began> --summary "<what you did>" --prompt "<the ask>"`
Pass `--label` and `--started`, or the entry is named `adhoc` with a 0s duration.

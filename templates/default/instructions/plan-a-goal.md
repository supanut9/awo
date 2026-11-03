---
id: plan-a-goal
name: Plan a goal
description: Sequence for turning a refined requirement into planned tasks
owner: tech-lead
appliesTo: [{{PROJECT_KEY}}-G]
summary: Plan a goal
---

Sequence for `awo goal plan {{PROJECT_KEY}}-G#`, owned by `tech-lead` (preceded by
**capture-requirement**, owned by `product-manager`):

0. Run `awo goal plan {{PROJECT_KEY}}-G#`. It assembles the brief — objective,
   definition-of-done, the requirement's criteria, repos in scope, tasks that
   already exist, installed roles — and hands you a **plan-mode** invocation.
   Plan mode means the breakdown is proposed for a human to approve *before* any
   task file exists: explore read-only, present the plan, wait. On approval the
   same session does steps 1-5 below. `--write` skips the gate.
   Approving a plan is a permission in that session; it is **not** the
   workspace's human gate (rule: `human-approval-required`), which still applies
   to every task before `awo task run`.
1. Read the goal's objective, definition-of-done, and scope/constraints.
   **If you cannot write the breakdown without "depending on whether…" in every
   task, stop and run `chart-the-unknown` instead** — the decisions are the work
   right now, and a task list guessed on top of open questions gets rewritten.
2. Identify the repos in scope (must be a subset of the goal's `targets`).
3. Draft tasks, each with a single clear objective, its own `targets`, and
   any `dependsOn` ordering.

   **Slice vertically.** Each task should cut a narrow but *complete* path through
   every layer it touches — schema, API, UI, tests — so that finishing it leaves
   something demoable or verifiable on its own. A task that is one horizontal layer
   ("add all the endpoints", "do the UI") is only provably done once its siblings
   land, which means none of them can be measured until all of them are. Size each
   slice to fit a single fresh session; do any prefactoring first, as its own task
   ("make the change easy, then make the easy change").

   **Wide refactors are the exception.** A mechanical change whose blast radius
   fans across the codebase — renaming a column, retyping a shared symbol — cannot
   be a vertical slice, because a single edit breaks thousands of call sites and no
   slice lands green. Sequence it as **expand → migrate → contract**: first add the
   new form beside the old so nothing breaks; then migrate call sites in batches
   sized by blast radius (per package, per directory), each batch its own task
   blocked by the expand, staying green because the old form still exists; finally
   delete the old form in a task blocked by every batch. Forcing this into vertical
   slices produces tasks that cannot pass `tests-must-pass` individually.

   Set `dependsOn` to what genuinely gates a task, not to the order you happened to
   think of them — the ordering is what `awo context` uses to tell the next session
   what is actually takeable.
4. Create each task with `awo task new --goal {{PROJECT_KEY}}-G# --name "…" --targets <repo>
   [--depends-on {{PROJECT_KEY}}-T#] [--agent <agent>]`. It allocates the next task ID,
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
6. Once every task is closed for QA (see **ship-a-change**), hand off to
   `qa-engineer` for **verify-acceptance-criteria** before the goal is
   marked `done` (rule: `acceptance-criteria-required`). In-scope gaps become
   repair tasks on the goal; human-confirmed new scope re-enters through
   `file-bug` → `product-manager`.

Finally, record the run (rule: `record-every-run`):
`awo log add --label <short-slug> --agent tech-lead --model <model> --started <iso-when-you-began> --summary "<what you did>" --prompt "<the ask>"`
Pass `--label` and `--started`, or the entry is named `adhoc` with a 0s duration.

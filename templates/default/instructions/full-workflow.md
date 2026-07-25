---
id: full-workflow
name: Full workflow — idea to done
description: The canonical end-to-end sequence a goal moves through; stitches capture-requirement, plan-a-goal, and ship-a-change together
appliesTo: [{{PROJECT_KEY}}-G]
---

This is the master sequence — the other instructions are its stages, not
alternatives to it. Use this file when asked "what's our normal workflow."

## Stages

1. **Intake** — owner: `product-manager`. Instruction: `capture-requirement`.
   Raw ask → refined requirement (`{{PROJECT_KEY}}-R#`) → scoped goal (`{{PROJECT_KEY}}-G#`,
   `status: planning`).
2. **Plan** — owner: `tech-lead`. Instruction: `plan-a-goal`.
   Goal → tasks (`{{PROJECT_KEY}}-T#`), each with `targets` and `dependsOn`. Tasks wait
   `pending` for human approval before running (draft → approve gate).
   Goal moves to `status: in-progress`.
3. **Build & ship** — owners: `software-engineer` / `data-engineer` (build),
   `release-engineer` (ship), `code-reviewer` (approve). Instruction:
   `ship-a-change`. Runs **once per task**, and tasks on different repos can
   run in parallel; tasks on the same repo get isolated worktrees
   (rule: `isolate-task-worktrees`).
4. **QA gate** — owner: `qa-engineer`. Skill: `verify-acceptance-criteria`.
   Runs once **every** task under the goal reports `success` — verifies the
   goal's definition-of-done as a whole, not just per-task tests
   (rule: `acceptance-criteria-required`). Goal moves to `status: qa-review`
   while this runs.
   - **Pass** → goal moves to `status: done`.
   - **Gap found** → `file-bug` opens a new requirement, referencing the
     originating goal/task. Re-enters at **Intake**, triaged by
     `product-manager` like any other ask. The goal itself is not blocked
     indefinitely by this — scope the fix as new/follow-up work.

## Not part of this flow (run alongside, not as a gate)
- **`audit`** — reviews `logs/` for compliance periodically or on request.
  Read-only; never blocks a goal's progress through the stages above.
- **`marketing-specialist`** — for marketing-scoped goals, replaces
  `software-engineer`/`data-engineer` in stage 3 (GTM plan + tagging instead
  of code), but Intake, Plan, and the QA gate shape still apply the same way.

## Goal status progression
`planning` → `in-progress` → `qa-review` → `done` (or `blocked` at any stage
if a dependency stalls).

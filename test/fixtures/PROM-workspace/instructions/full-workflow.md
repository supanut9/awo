---
id: full-workflow
name: Full workflow — idea to done
description: The canonical end-to-end sequence a goal moves through; stitches capture-requirement, plan-a-goal, and ship-a-change together
appliesTo: [PROM-G]
summary: Full workflow — idea to done
---

This is the master sequence — the other instructions are its stages, not
alternatives to it. Use this file when asked "what's our normal workflow."

## Stages

1. **Intake** — owner: `product-manager`. Instruction: `capture-requirement`.
   Raw ask → refined requirement (`PROM-R#`) → scoped goal (`PROM-G#`,
   `status: planning`).
2. **Plan** — owner: `tech-lead`. Instruction: `plan-a-goal`.
   Goal → tasks (`PROM-T#`), each with `targets` and `dependsOn`. Tasks wait
   `todo` for human approval before running (draft → approve gate).
   Goal moves to `status: in-progress`.
3. **Build & open PR** — owners: `software-engineer` / `data-engineer` (build),
   `release-engineer` (PR maintenance), `code-reviewer` (technical assessment).
   Instruction:
   `ship-a-change`. Runs **once per task**, and tasks on different repos can
   run in parallel; tasks on the same repo get isolated worktrees
   (rule: `isolate-task-worktrees`).
4. **QA gate** — owner: `qa-engineer`. Skill: `verify-acceptance-criteria`.
   Runs once **every** task under the goal is closed for QA — verifies the
   goal's definition-of-done as a whole, not just per-task tests
   (rule: `acceptance-criteria-required`). Goal moves to `status: qa-review`
   while this runs.
   - **Pass** → goal moves to `status: done`.
   - **In-scope gap found** → `awo goal verdict <goal> --gap` creates a repair
     task inside the goal. The goal reopens and must pass goal-level QA again.
   - **New scope found** → `awo goal verdict <goal> --gap --new-scope` opens a
     new requirement, referencing the originating goal. It re-enters at
     **Intake**, triaged by `product-manager` like any other ask.
5. **Merge authority** — owner: the party configured by
   `pullRequests.mergePolicy`. AI may keep fixing the PR until all required
   checks and actionable threads are resolved. `human-only` stops at **ready
   for human approval**; `authorized-maintainer` may merge after verifying
   GitHub's required checks and reviews. AI never approves (rule:
   `human-approval-required`).

## Not part of this flow (run alongside, not as a gate)
- **`audit`** — reviews `logs/` for compliance periodically or on request.
  Read-only; never blocks a goal's progress through the stages above.
- **`marketing-specialist`** — for marketing-scoped goals, replaces
  `software-engineer`/`data-engineer` in stage 3 (GTM plan + tagging instead
  of code), but Intake, Plan, and the QA gate shape still apply the same way.

## Goal status progression
`planning` → `in-progress` → `qa-review` → `done` (or `blocked` at any stage
if a dependency stalls).

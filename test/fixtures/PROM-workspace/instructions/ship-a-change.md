---
id: ship-a-change
name: Ship a change
description: End-to-end workflow from code to a PR ready for human approval for one task
owner: software-engineer
appliesTo: [PROM-T]
summary: Ship a change
---

Sequence for delivering a task (`PROM-T#`). It has two halves with two
owners, and the brief `awo task run` prints says which half you are in. A worker
does the first half and stops; everything after the run closes is the
orchestrator's — or a worker's only when the orchestrator's instruction says so.

## Orchestrator, before the run
1. **sync-repos** — bring `repos/` current.
2. `awo task run PROM-T#` — opens the run, creates the task worktree at
   `repos/.worktrees/<repo>/PROM-T#` on `feature/PROM-T#` for each target
   (rule: `isolate-task-worktrees`), and prints the brief and the invocation to
   hand to the worker.

## Worker — inside the run
1. **Implement** the change within the task's declared `targets` only, inside
   its worktree (rule: `stay-in-scope`). Open the skills the brief lists first.
2. **run-tests** — measure every target with the line the brief gives you:
   `awo task event PROM-T# test --repo <repo> --run "<testCommand>" --baseline`
   (rules: `tests-must-pass`, `evidence-not-claims`). A target with no declared
   `testCommand` is a question for the orchestrator, not a command to invent.
3. **create-commit** — commit on the task branch (rule: `conventional-commits`).
   Commits and diffs are captured automatically; never record them as events.
4. Close the run: `awo task complete PROM-T# --outcome success --summary "…"`
   — or `--outcome failed` with what stopped you. Governed goals route a
   success to review on their own.

A worker does **not** push, open, link or merge a PR unless the orchestrator's
instruction in its brief says so.

## Orchestrator — after the run closes
1. **open-pr** — push the task branch and open the PR from it, then record the
   link with `awo pr link PROM-T# --repo <repo> --number <n>` (rule:
   `pr-requirements`) — release-engineer.
2. **resolve-pr** — run `awo pr reconcile PROM-T#` until required checks pass
   and actionable feedback is resolved — release-engineer / code-reviewer.
3. Record `awo task evidence PROM-T# --criterion <n> --kind test --ref <runId>`
   for every acceptance criterion the task serves, and check goal coverage with
   `awo goal trace <goal>` before QA sign-off.
4. Run `awo pr finalize PROM-T#`: `human-only` stops at **ready for human
   approval**; `authorized-maintainer` may merge after verifying GitHub's
   required checks and reviews. An AI never approves, enables auto-merge, or
   queues a PR (rule: `human-approval-required`). Every run is captured under
   `logs/` with the task ID.

---
id: ship-a-change
name: Ship a change
description: End-to-end workflow from code to a PR ready for human approval for one task
owner: software-engineer
appliesTo: [PROM-T]
summary: Ship a change
---

Sequence for delivering a task (`PROM-T#`):

1. **sync-repos** — bring `repos/` current before starting (software-engineer).
2. **create-task-worktree** — create/reuse an isolated worktree for this task
   on each target repo (rule: `isolate-task-worktrees`) — software-engineer.
3. **Implement** the change within the task's declared `targets` only,
   inside that worktree (rule: `stay-in-scope`) — software-engineer.
4. **run-tests** — verify every target repo passes before proceeding
   (rule: `tests-must-pass`) — software-engineer.
5. **create-commit** — record the change (rule: `conventional-commits`) —
   release-engineer.
6. **open-pr** — open the PR from the task's worktree/branch, then record the
   link with `awo pr link <task> --repo <repo> --number <n>` (rule:
   `pr-requirements`) — release-engineer.
7. **resolve-pr** — run `awo pr reconcile <task>` until required checks pass and
   actionable feedback is resolved — release-engineer / code-reviewer.
8. Record `awo task evidence` for every relevant acceptance criterion and check
   goal coverage with `awo goal trace <goal>` before QA sign-off.
9. Run `awo pr finalize <task>`: `human-only` stops at **ready for human
   approval**; `authorized-maintainer` may merge after verifying GitHub's
   required checks and reviews. An AI worker never approves, enables auto-merge,
   or queues a PR (rule: `human-approval-required`). The run is captured under
   `logs/` with the task ID.

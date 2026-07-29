---
id: ship-a-change
name: Ship a change
description: End-to-end workflow from code to a PR ready for human approval for one task
owner: software-engineer
appliesTo: [{{PROJECT_KEY}}-T]
---

Sequence for delivering a task (`{{PROJECT_KEY}}-T#`):

1. **sync-repos** — bring `repos/` current before starting (software-engineer).
2. **create-task-worktree** — create/reuse an isolated worktree for this task
   on each target repo (rule: `isolate-task-worktrees`) — software-engineer.
3. **Implement** the change within the task's declared `targets` only,
   inside that worktree (rule: `stay-in-scope`) — software-engineer.
4. **run-tests** — verify every target repo passes before proceeding
   (rule: `tests-must-pass`) — software-engineer.
5. **create-commit** — record the change (rule: `conventional-commits`) —
   release-engineer.
6. **open-pr** — open the PR from the task's worktree/branch
   (rule: `pr-requirements`) — release-engineer.
7. **resolve-pr** — iterate until required checks pass and actionable feedback
   is resolved — release-engineer / code-reviewer.
8. Request human review and stop at **ready for human approval**. An AI worker
   must not approve or merge; human/release authority owns that final action
   (rule: `human-approval-required`). The run is captured under `logs/` with
   the task ID.

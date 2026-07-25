---
id: ship-a-change
name: Ship a change
description: End-to-end workflow from code to merged PR for one task
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
7. **resolve-pr** — iterate until approved — release-engineer / code-reviewer.
8. Squash-merge, then remove the task's worktree. The run is captured under
   `logs/` with the task ID.

---
id: create-task-worktree
name: Create an isolated task worktree
description: Give a task its own git worktree + branch so concurrent tasks on the same repo never collide
requires:
  connectors: []
  rules: [isolate-task-worktrees]
summary: give a task its own isolated git worktree + branch.
---

## When to use
Before implementing any task, for each repo in that task's `targets` —
right after `sync-repos`, before touching any files.

## Steps
1. For each target repo, check whether a worktree already exists at
   `repos/.worktrees/<repo-name>/<taskId>`. If so, reuse it — do not recreate.
2. If not, create the task branch (`feature/<taskId>-<slug>`) off the
   repo's declared `ref`, then:
   `git -C repos/<repo-name> worktree add ../.worktrees/<repo-name>/<taskId> feature/<taskId>-<slug>`
3. All implementation, commits, and pushes for this task happen **inside
   that worktree path** — never in `repos/<repo-name>` directly.
4. After the task's PR merges (or the task is abandoned), remove the
   worktree: `git -C repos/<repo-name> worktree remove <path>` and prune.

## Done when
- The task has its own worktree + branch, isolated from every other task
  currently active on the same repo.

## Cleanup
Stale worktrees (merged or abandoned tasks) should be pruned periodically —
consider surfacing this in `awo doctor`.

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

## Done when
- The task has its own worktree + branch, isolated from every other task
  currently active on the same repo.

## Cleanup
Do **not** remove a worktree by hand. `awo` owns this:

```sh
awo worktree list          # every checkout, and what removing it would cost
awo worktree prune         # remove finished tasks' checkouts
```

`prune` only considers tasks that are `done` or `cancelled`, and it refuses any
checkout that is dirty or holds commits no other branch contains — which under
`goal-feature-branch` is the normal state of a task whose work has not yet been
merged into its repository's delivery branch. `awo doctor` reports the ones
waiting.

This step used to read "remove the worktree: `git … worktree remove <path>` and
prune". Nothing enforced it, and two weeks of real use left 20 checkouts and
1.5 GB on disk — including 15 commits that no other branch held, which a
remove-on-completion rule would have destroyed. An instruction is not a
lifecycle.

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
Before implementing any task, for each repo in that task's `targets`.

## Steps
1. `awo task run <taskId>` creates the worktree for every target — you do not.
   Each one is at `repos/.worktrees/<repo>/<taskId>` on branch
   `feature/<taskId>`, cut from the dependency's branch when the task has one.
   Running it again for the same task reuses the same checkout.
2. Read the path from the brief (or `awo task show <taskId>`). Never create a
   worktree or branch by hand: a hand-made path is invisible to `awo worktree`
   and to the gate, and an invented one has landed outside the gitignored
   `repos/` tree before.
3. All implementation and commits for this task happen **inside that worktree
   path** — never in `repos/<repo>` directly.

## Done when
- You are working in the worktree `awo task run` reported, isolated from every
  other task currently active on the same repo.

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

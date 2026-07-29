---
id: isolate-task-worktrees
name: Isolate concurrent tasks with git worktrees
appliesTo: [task_execution]
severity: required
summary: concurrent tasks on the same repo never share a working tree.
---

When a task's `targets` include a repo, the agent MUST NOT work directly in
the shared `repos/<name>` checkout if that repo could be touched by another
active or pending task. Use a dedicated **git worktree** for the task instead
(see the `create-task-worktree` skill), so two tasks never:

- share the same working tree or checked-out branch, or
- overwrite each other's uncommitted changes by switching branches
  underneath one another.

Never force-switch the branch in a worktree that belongs to another task.
A worktree is removed only after its task's PR has merged (or the task is
abandoned) — never while another task might still depend on it.

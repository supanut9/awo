---
id: stay-in-scope
name: Stay in scope
appliesTo: [task_execution]
severity: required
summary: only touch repos declared as a task's `targets`.
---

An agent executing a task (`PROM-T#`) MUST only read/write within the repos
listed in that task's `targets`. Do not modify, commit to, or open PRs
against any other linked repo, even if related work seems convenient there.

If a task appears to require changes outside its declared targets, stop and
flag it — update the task's `targets` (or split the work into another task)
rather than silently expanding scope.

---
id: stay-in-scope
name: Stay in scope
appliesTo: [task_execution]
severity: required
---

An agent executing a task (`{{PROJECT_KEY}}-T#`) MUST only read/write within the repos
listed in that task's `targets`. Do not modify, commit to, or open PRs
against any other linked repo, even if related work seems convenient there.

If a task appears to require changes outside its declared targets, stop and
flag it — update the task's `targets` (or split the work into another task)
rather than silently expanding scope.

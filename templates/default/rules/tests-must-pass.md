---
id: tests-must-pass
name: Tests must pass before shipping
appliesTo: [task_completion, pull_request]
severity: required
summary: a task/PR can't proceed with failing or unverified tests.
---

A task MUST NOT be marked `success`, and a PR MUST NOT be opened via
`open-pr`, until the `run-tests` skill reports a pass for every repo in the
task's `targets`. If a repo has no declared `testCommand`, flag it rather
than silently skipping verification — that is a gap to fix, not a pass.

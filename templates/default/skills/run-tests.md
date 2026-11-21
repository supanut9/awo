---
id: run-tests
name: Run tests
description: Have awo measure each target repo's declared test command; a measured pass is the only evidence
requires:
  connectors: []
  rules: [tests-must-pass, evidence-not-claims]
summary: have awo measure each target's declared test command — never run it yourself and report.
---

## When to use
After implementing a task's changes, before `create-commit` — and again after
any change that follows a failure.

## Steps
1. For each repo in the task's `targets`, take the measure line from your brief.
   It uses that repo's declared `testCommand` from `.workspace/manifest.json`:
   `awo task event <task> test --repo <repo> --run "<testCommand>" --baseline`
2. Let awo run it. It executes the command in the task's worktree, records the
   exit code, duration and counts, and `--baseline` runs it at the branch point
   so a failure can be attributed. Running the suite yourself and reporting the
   result is a claim, and the gate refuses claims (`evidence-not-claims`).
3. On a failure, read the diagnosis (`awo log tail`), fix, and measure again —
   a later passing run of the same command replaces the failure.
4. If a repo declares no `testCommand`, do not invent one and do not call it
   passed: ask the orchestrator, who declares it with
   `awo test-command <repo> "<cmd>"` (see `tests-must-pass`).

## Done when
- Every target repo has a measured pass, a measured failure you are reporting,
  or an explicit "no testCommand declared" raised with the orchestrator.

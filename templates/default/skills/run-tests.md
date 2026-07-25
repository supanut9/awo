---
id: run-tests
name: Run tests
description: Detect and run each target repo's test suite; report pass/fail
requires:
  connectors: []
  rules: [tests-must-pass]
---

## When to use
After implementing a task's changes, before `create-commit` / `open-pr`.

## Steps
1. For each repo in the task's `targets`, look up `testCommand` from that
   repo's entry in `.workspace/manifest.json`.
2. If present, run it in that repo; capture pass/fail and output.
3. If absent, do not assume "no tests" — report it as an unverified repo
   rather than a pass (see `tests-must-pass`).
4. Summarize results per repo for inclusion in the run's log.

## Done when
- Every target repo has an explicit pass, fail, or flagged-unverified result.

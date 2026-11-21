---
id: verify-acceptance-criteria
name: Verify acceptance criteria
description: Check a goal's definition-of-done as a whole, beyond individual task tests
requires:
  connectors: []
  rules: [acceptance-criteria-required]
summary: check a goal's definition-of-done as a whole.
---

## When to use
After every task under a goal is closed for QA, before the goal is marked `done`.

## Steps
1. Re-read the goal's "Definition of done" and "Scope & constraints".
2. Exercise the feature/change as a user would (exploratory check), not just
   re-run unit tests — `run-tests` already covers that layer.
3. Compare actual behavior to each criterion; note gaps.
4. Check `awo goal readiness <goal>` and attach the review with
   `awo goal verify <goal>`. Criterion evidence of `--kind test` must point at a
   measured test run of the task (`--ref <runId>`), not a sentence about one —
   prose is a claim, and the readiness check treats it as one.
5. If all criteria are met: record
   `awo goal verdict <goal> --pass --summary "<the verdict in a sentence>" --who "<human>"`.
   `--summary` is required.
6. If an in-scope gap exists: record `--gap --summary "<the gap>"`; awo creates a
   repair task on the same goal. If a human confirms new scope, use
   `--gap --new-scope --summary "…"` instead.

## Done when
- Every criterion in the goal's definition-of-done has an explicit
  pass/fail against real behavior.

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
   `awo goal verify <goal>`.
5. If all criteria are met: record `awo goal verdict <goal> --pass --who "<human>"`.
6. If an in-scope gap exists: record `--gap`; AWO creates a repair task on the
   same goal. If a human confirms new scope, use `--gap --new-scope` instead.

## Done when
- Every criterion in the goal's definition-of-done has an explicit
  pass/fail against real behavior.

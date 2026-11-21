---
id: review-logs
name: Review logs for compliance
description: Walk the requirement → goal → task → run → log chain and check rule compliance
requires:
  connectors: []
---

## When to use
Periodically, or for a specific goal/time range under audit.

## Steps
1. Start from a goal (`awo log list --task <id>`), or a date range: each day is
   `logs/<date>/runs.jsonl` (events and one row per run) and
   `logs/<date>/runs.md` (the written records).
2. Trace {{PROJECT_KEY}}-G# → its {{PROJECT_KEY}}-T#s → each task's run(s) → log detail.
3. Confirm: commits followed `conventional-commits`; no direct pushes to
   main; PRs met `pr-requirements`; `run-tests` passed before shipping;
   the goal has a `qa-engineer` sign-off before `done`.
4. Flag any break in the chain (missing log, skipped rule, unexplained gap).

## Done when
- Every shipped change in scope traces cleanly back to an approved requirement.

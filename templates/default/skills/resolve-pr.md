---
id: resolve-pr
name: Resolve PR feedback
description: Address review comments and finish according to the configured merge authority
requires:
  connectors: [github]
  rules: [conventional-commits, human-approval-required]
summary: address review feedback, then follow configured merge authority.
---

## Steps
1. Run `awo pr reconcile <task>` to fetch the PR's review comments and create
   repair tasks for newly discovered unresolved threads.
2. Address each comment with focused changes.
3. Record them via the `create-commit` skill and push.
4. Reply to threads and re-request required review.
5. Repeat until all required checks pass and every actionable thread is
   resolved or has a documented disposition.
6. Run `awo pr finalize <task>` to read `pullRequests.mergePolicy`:
   - `human-only`: stop at **ready for human approval**.
   - `authorized-maintainer`: it may squash-merge only when GitHub reports a
     clean PR with passing checks. Never submit an approval, enable auto-merge,
     or enter a merge queue.

## Done when
- All actionable threads resolved and required checks pass. The PR is either
  ready for human approval or merged by an authorised maintainer according to
  `pullRequests.mergePolicy`.

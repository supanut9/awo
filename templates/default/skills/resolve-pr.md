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
1. Fetch the PR's review comments.
2. Address each comment with focused changes.
3. Record them via the `create-commit` skill and push.
4. Reply to threads and re-request required review.
5. Repeat until all required checks pass and every actionable thread is
   resolved or has a documented disposition.
6. Read `pullRequests.mergePolicy`:
   - `human-only`: stop at **ready for human approval**.
   - `authorized-maintainer`: verify GitHub reports every required check and
     review satisfied, then merge with the repository's configured strategy.
     Never submit an approval, enable auto-merge, or enter a merge queue.

## Done when
- All actionable threads resolved and required checks pass. The PR is either
  ready for human approval or merged by an authorised maintainer according to
  `pullRequests.mergePolicy`.

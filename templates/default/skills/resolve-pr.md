---
id: resolve-pr
name: Resolve PR feedback
description: Address review comments and re-request review until approved
requires:
  connectors: [github]
  rules: [conventional-commits, human-approval-required]
---

## Steps
1. Fetch the PR's review comments.
2. Address each comment with focused changes.
3. Record them via the `create-commit` skill and push.
4. Reply to threads and re-request human review.
5. Repeat until all required checks pass and every actionable thread is
   resolved or has a documented disposition.
6. Stop at **ready for human approval**. Never submit an approval, merge,
   enable auto-merge, or enter a merge queue.

## Done when
- All actionable threads resolved, required checks pass, and a human reviewer
  has been requested. Human approval and merge happen outside this skill.

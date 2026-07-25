---
id: resolve-pr
name: Resolve PR feedback
description: Address review comments and re-request review until approved
requires:
  connectors: [github]
  rules: [conventional-commits]
---

## Steps
1. Fetch the PR's review comments.
2. Address each comment with focused changes.
3. Record them via the `create-commit` skill and push.
4. Reply to threads and re-request review.
5. Repeat until approved, then squash-merge.

## Done when
- All threads resolved, checks pass, PR approved and squash-merged.

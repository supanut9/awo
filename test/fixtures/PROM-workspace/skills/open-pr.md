---
id: open-pr
name: Open a pull request
description: Create a branch, push, and open a PR from the template
requires:
  connectors: [github]
  rules: [no-push-to-main, pr-requirements, conventional-commits, human-approval-required]
---

## Steps
1. Create/switch to a feature branch: `feature/PROM-T#-<short-slug>`.
2. Ensure commits follow `create-commit`; push the branch.
3. Open the PR (e.g. `gh pr create`) filling the template: summary,
   **Testing** section, and a linked task (`PROM-T#`).
4. Request review from a human reviewer. `code-reviewer` may provide a
   non-approving technical assessment, but does not replace human approval.

## Done when
- A PR exists that satisfies the `pr-requirements` rule and targets the
  default branch (never a direct push — see `no-push-to-main`).

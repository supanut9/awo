---
id: pr-requirements
name: Pull request requirements
appliesTo: [pull_request]
severity: required
---

Every pull request MUST include:
- A clear description of **what** changed and **why**.
- A **Testing** section describing how the change was verified.
- A linked task (`{{PROJECT_KEY}}-T#`) and any related requirement/goal.
- Passing status checks before merge.
- At least one approval from an authenticated human reviewer. AI workers may
  request review and resolve feedback but cannot approve or merge (rule:
  `human-approval-required`).

After human approval, the repository's authorised human/release process chooses
the merge strategy. AWO workers stop at a review-ready PR.

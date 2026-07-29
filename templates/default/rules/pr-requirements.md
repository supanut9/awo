---
id: pr-requirements
name: Pull request requirements
appliesTo: [pull_request]
severity: required
summary: every PR needs description, testing section, linked task.
---

Every pull request MUST include:
- A clear description of **what** changed and **why**.
- A **Testing** section describing how the change was verified.
- A linked task (`{{PROJECT_KEY}}-T#`) and any related requirement/goal.
- Passing status checks before merge.
- Every review and status check required by the target repository's branch
  protection/ruleset. AI workers may request review and resolve feedback, but
  cannot submit an approval (rule: `human-approval-required`).

`pullRequests.mergePolicy: human-only` stops at a review-ready PR. With
`authorized-maintainer`, the worker may merge only after it has verified that
the repository's required checks and reviews are satisfied.

Before PR work, run `awo pr preflight --repo <repo>`. After creating a PR, link
it to its task with `awo pr link <task> --repo <repo> --number <n>` and use
`awo pr reconcile <task>` to turn new unresolved review threads into explicit
repair tasks. Record requirement coverage with `awo task evidence` and inspect
it with `awo goal trace`; a green check alone is not criterion-level evidence.

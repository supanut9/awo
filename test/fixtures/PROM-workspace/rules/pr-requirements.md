---
id: pr-requirements
name: Pull request requirements
appliesTo: [pull_request]
severity: required
---

Every pull request MUST include:
- A clear description of **what** changed and **why**.
- A **Testing** section describing how the change was verified.
- A linked task (`PROM-T#`) and any related requirement/goal.
- Passing status checks before merge.

Merge strategy: **squash-merge only**, keeping the conventional commit subject.

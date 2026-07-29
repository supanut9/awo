---
id: pm-to-pr
name: PM requirement to human-approved PR
description: The operating playbook for turning a PM request into a validated PR with configured merge authority
owner: product-manager
appliesTo: [{{PROJECT_KEY}}-R]
---

Use this instruction when a product manager gives a feature request and the
expected outcome is a review-ready pull request.

## Operating sequence

1. **Capture the request** — `product-manager` refines the raw ask into a
   requirement with scope, non-goals, acceptance criteria, dependencies, and
   open questions. Create it with `awo req new --title "..."`, then run
   `awo req refine <requirement>`. The agent proposes its criteria with
   `awo req propose <requirement>`; an authenticated human must accept them
   using `awo req approve <requirement>` before planning starts.
2. **Make it buildable** — `tech-lead` turns the accepted requirement into a
   goal and ordered, repo-scoped tasks. Put schema/API design before dependent
   implementation and make every task's done-when criteria testable.
3. **Implement in isolation** — dispatch or hand each unblocked task to its
   owner. Work only in the task's worktree, run the declared checks, capture
   measured evidence with `awo task event <id> test --run "..."`, then send the
   task through its QA gate.
4. **Verify the feature** — `qa-engineer` checks the goal's acceptance criteria
   across tasks. A gap becomes a follow-up requirement/task; it is not hidden by
   a passing unit suite.
5. **Open and maintain the PR** — `release-engineer` commits, pushes the task
   branch, opens a PR with evidence, then repeatedly addresses actionable
   comments and failing checks. Re-request review after every meaningful push.
6. **Finish at the configured boundary** — when required checks pass and all
   actionable threads are resolved, follow `pullRequests.mergePolicy`. The
   default is **ready for human approval**. An authorised maintainer may merge
   only after confirming GitHub's required checks and reviews; AI never
   approves, enables auto-merge, or enters a merge queue.

## Definition of ready for human approval

- The PR links its requirement, goal, and task IDs and explains the change.
- Required checks are green, with measured test evidence recorded in AWO.
- Goal-level acceptance criteria passed, or any accepted gap is explicitly
  documented and owned by a follow-up requirement.
- Every actionable review comment is addressed or has a documented resolution.
- All repository-required reviews are satisfied. The AI never counts as an
  approver.

## Repository enforcement baseline

The workspace policy is not a substitute for repository permissions. Set
`pullRequests.mergePolicy` to `human-only` for company repositories that need a
colleague/release owner to merge. Set it to `authorized-maintainer` only for an
account that is intentionally allowed to merge after GitHub's required checks
and reviews pass. Never rely on an AI approval.

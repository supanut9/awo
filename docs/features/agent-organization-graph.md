---
id: AWO-F1
title: Agent organization graph
status: proposed
owners: [human, orchestrator]
repositories: [awo, awo-dashboard]
releaseOrder: [awo, awo-dashboard]
---

# Agent Organization Graph

## Problem

AWO has a work hierarchy (`Requirement -> Goal -> Tasks -> Runs`) but no
machine-readable relationship between agent roles. The current role files describe
handoffs in prose only, so neither a human nor a dashboard can see who coordinates,
reviews, or delegates work across a goal.

## Outcome

An AWO workspace can declare and validate an organization graph for its agent roles.
The local UI and hosted dashboard show the graph, its role responsibilities, and the
current workload. It is an orchestration and visibility model, not a way for an
agent to grant itself authority.

## Scope

### AWO library

- Extend agent frontmatter with optional relationships:

  ```yaml
  reportsTo: tech-lead        # one role, or omitted for a root role
  delegatesTo: [software-engineer, data-engineer]
  reviews: [software-engineer]
  ```

- Validate every referenced role exists and reject cycles in `reportsTo`.
- Add `awo agent org` for a readable tree and `awo agent org --json` for readers.
- Keep `task.agent` as the explicit task owner. The graph may explain or suggest a
  handoff, but it must never silently reassign a task.
- Extend `awo context` with the organization root roles and any invalid references.
- Publish a summary-safe `awo_agents` projection: id, name, role, tier, relations,
  and task counts. Agent markdown remains `detail: full` only.

### Hosted dashboard

- Add an **Organization** view to each workspace.
- Render roots and reporting lines as an accessible, responsive tree rather than a
  decorative static chart.
- Show each role's assigned/open task count and links to those task details.
- Show a clear empty state for workspaces published by an older AWO version that do
  not have `awo_agents` yet.

### Local AWO UI

- Add an Organization view using the same projected fields as the hosted dashboard.
- Show the currently selected task's agent and its reporting/review relationships.

## Authority Rules

- The human is outside the agent graph and retains requirement approval, QA verdict,
  and PR-approval authority.
- The orchestrator coordinates the graph but is not a worker role and cannot appear
  as a task assignee.
- `reportsTo`, `delegatesTo`, and `reviews` describe responsibility only. They do
  not grant filesystem, connector, GitHub approval, merge, or deployment rights.
- Existing `rules/`, connector grants, GitHub permissions, and
  `pullRequests.mergePolicy` remain the enforcement source of truth.

## Initial Default Graph

```text
Human
  Orchestrator
    Product Manager
    Tech Lead
      Software Engineer
      Data Engineer
    QA Engineer
    Code Reviewer
    Release Engineer
```

This is a starting visualization, not a claim that every organization uses this
reporting structure. A workspace can choose its own roots and relations.

## Non-goals

- Multi-agent chat, shared hidden context, or autonomous manager agents.
- Automatic task assignment or automatic delegation.
- Agent self-approval, self-verification, or expanded merge permissions.
- An unbounded bug-fix loop. Goal stabilization remains separately scoped and must
  be bounded by approved acceptance criteria and human acceptance.

## Acceptance Criteria

1. An existing workspace with no relationship fields remains valid and renders an
   empty organization state without migration failure.
2. `awo agent org` shows roots, reporting lines, and orphaned roles; `--json` emits
   a stable documented shape.
3. Invalid references and reporting cycles fail `awo doctor` and the command with
   actionable errors.
4. A task's explicit `agent:` remains unchanged after graph validation or display.
5. `awo publish` writes the summary projection and removes stale agent rows.
6. Both dashboards render the same relationships and task-count semantics.
7. The hosted dashboard handles a missing `awo_agents` collection without an error.
8. No graph relationship permits an agent to approve a PR, render a QA verdict, or
   merge unless existing external policy already authorizes it.
9. Tests cover validation, JSON/text rendering, publish compatibility, local UI,
   and hosted dashboard empty/populated states.

## Delivery Plan

1. **Schema review:** approve field names, relation semantics, default graph, and
   whether `reviews` is needed in v1. Do not write runtime behavior before this gate.
2. **AWO implementation:** parser, validation, CLI, context, local snapshot/UI,
   Mongo projection, and tests.
3. **AWO release:** bump the npm package, run the full suite, publish `latest`.
4. **Dashboard implementation:** read the optional projection, render the
   Organization view, and test the older-projection empty state.
5. **Dashboard release:** build, push, and deploy `awo-dashboard`.
6. **Workspace rollout:** update AWO, run `awo publish`, verify the hosted view,
   and collect human feedback before changing default template relationships.

## Human Decisions Required

- Approve the proposed field names and one-manager `reportsTo` constraint.
- Decide whether the product manager and QA engineer report to the orchestrator or
  to the tech lead in the default graph.
- Decide whether organization relationships are introduced in the default template
  immediately or only after a manual workspace trial.

## Done

This feature is done only after both repositories are released, an existing
workspace publishes the graph successfully, and a human confirms the graph improves
task delegation visibility without weakening any approval boundary.

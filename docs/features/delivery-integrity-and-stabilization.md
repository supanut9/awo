---
id: AWO-F2
title: Delivery integrity and stabilization
status: in-progress
owners: [human, orchestrator]
repositories: [awo, awo-dashboard]
releaseOrder: [awo, awo-dashboard]
dependsOn: []
---

# Delivery Integrity and Stabilization

## Problem

AWO accurately records much of the work performed, but its completion model is
not yet strong enough for real multi-repository delivery.

The `atlas-shop-awo` workspace demonstrated the gaps:

- A goal can roll up to `done` when an authored task is absent from `state.json`.
- A successful task becomes `done` unless the caller remembered `--gate`, even
  when the goal requires QA and acceptance-criteria proof.
- One repository PR commonly covers several tasks, but the model links PRs to
  individual tasks only.
- An integration gap found during later work requires manual task and requirement
  handling instead of a bounded stabilization workflow.
- Evidence requirements do not distinguish implementation work from investigation
  or verification work, creating both missing evidence and false-positive doctor
  warnings.
- Delivery metrics mix implementation outcomes with planning, research, and
  decision logs, making a high success rate misleading.
- Full-detail publication needs clear sensitivity controls before it is used as a
  broadly shared dashboard.

This is a control-plane correctness feature. It must be delivered before AWO uses
an organization chart or automation to increase delegation volume.

## Outcome

AWO can truthfully answer whether a goal is ready for human approval:

1. every authored task is represented and complete;
2. each task has evidence appropriate to its kind;
3. every acceptance criterion has passing evidence or a human-approved exception;
4. all delivery groups have their required checks and PR status recorded;
5. any discovered integration gap is either repaired within an approved bounded
   stabilization phase or promoted to a new requirement; and
6. a human, never an agent, gives the final QA and merge approvals.

The dashboard communicates readiness and blockers rather than only green task
counts.

## Implementation status

The AWO safety core is implemented on `feature/truthful-readiness`: conservative
read-time reconciliation plus `goal reconcile`, strict defaults for newly-created
goals, attached QA state, `goal readiness`, criterion exception attribution,
in-goal QA repair tasks, task-kind-aware completion checks, and automatic Git
baseline/change evidence. Legacy tasks without an explicit kind retain their old
contract to avoid turning historical investigations into false implementation
warnings.

Delivery groups, bounded stabilization records/budgets, run taxonomy, publishing
profiles, migrations, and both dashboards remain follow-on scope. This document is
therefore `in-progress`, not done.

## Scope

### 1. Authored-task reconciliation and truthful goal status

- Treat task markdown files as the canonical task inventory and `state.json` as
  mutable state over that inventory.
- Reconcile task state whenever `goal`, `context`, `doctor`, `task`, or `verify`
  reads a goal.
- A missing task-state entry is equivalent to `todo`; it can never be ignored by
  status rollup.
- Reject or repair orphaned state entries with an explicit diagnostic.
- Compute goal `done` only from the full authored inventory, never from the subset
  currently present in state.
- Make readers conservative: an inconsistent goal displays `blocked` or
  `inconsistent`, never `done`.
- Add `awo goal reconcile <goalId>` for an explicit, auditable repair and a safe
  automatic read-time overlay for older workspaces.

### 2. Required QA and criterion evidence gate

- Add goal frontmatter policy:

  ```yaml
  completionPolicy:
    qaRequired: true
    acceptanceEvidenceRequired: true
  ```

- New workspaces default to this policy. Existing workspaces retain their current
  behavior until opted in or migrated with an explicit human decision.
- For a governed goal, `awo task complete --outcome success` transitions to
  `in-review`; it cannot mark the task `done` directly.
- `awo goal verdict --pass` refuses to pass unless all authored tasks are complete,
  all required delivery-group checks are recorded, all criteria have coverage, and
  a QA run/brief is attached.
- Evidence may be `pass`, `accepted-exception`, or `not-applicable`.
  Exceptions require a human identity, timestamp, rationale, and expiry/review
  date where applicable.
- Add `awo goal readiness <goalId>` with machine-readable blockers and a concise
  human report.

### 3. Task kinds and evidence contracts

- Add explicit task kinds:

  ```yaml
  kind: implementation # implementation | investigation | verification | decision | deployment-data
  ```

- Apply evidence requirements by kind:
  - `implementation`: commit or diff, test result or visible untested reason, and
    linked delivery group when the task changes a repository.
  - `investigation`: source/query/report references, findings, and an explicit
    decision or follow-up task; no commit is required.
  - `verification`: executed checks, environment, result, and criterion links.
  - `decision`: alternatives, human decision, and downstream task/requirement.
  - `deployment-data`: environment, read-only or mutation classification,
    measured result, and rollback/reference where mutation is permitted.
- Capture Git commit SHA, diffstat, worktree, and configured test command
  automatically at task completion where available.
- Allow `--untested <reason>` only as visible evidence, not as a silent bypass.
- Make `awo doctor` evaluate the contract for the task kind and report missing
  configured test commands as planning blockers for implementation targets.

### 4. Delivery groups for one-PR-per-repository work

- Add a goal-local delivery-group record:

  ```yaml
  id: ALMO-259-server
  repository: learn-shop-online-server
  branch: feature/ALMO-259
  taskIds: [SHOP-T1, SHOP-T4, SHOP-T8]
  pullRequest:
    number: 123
    url: https://github.com/example/repo/pull/123
  ```

- A delivery group owns a repository branch, commit range, PR, CI checks, review
  status, and linked tasks/criteria.
- One task may contribute to more than one group only when it has explicit
  repository targets; the UI must show this clearly.
- Keep existing task-level worktrees for isolated work where useful, but permit a
  configured shared delivery branch without false evidence warnings.
- Add `awo delivery status <goalId>` and JSON output showing every group, PR,
  checks, review state, and remaining blockers.
- Agents may create, update, open, resolve, and repair PRs according to external
  credentials. They must never approve their own PRs. Merging remains allowed only
  when the authenticated actor already has external merge authority and workspace
  policy permits it; otherwise the dashboard states the required human action.

### 5. Bounded stabilization phase

- Add goal phase/state `stabilizing` and a `stabilization` record linked to its
  discovering run, source task, affected criteria, and delivery group.
- Add `awo goal stabilize <goalId>` to create repair tasks under a fixed scope,
  budget, and exit criteria approved by a human.
- A stabilization item can be resolved only with linked verification evidence.
- If a discovered gap exceeds the approved scope, `awo goal gap` creates a new
  requirement and links it bidirectionally; it does not silently expand the goal.
- A goal with an open stabilization item cannot become `done`.
- Dashboard views distinguish implementation, QA, and stabilization so a repair
  loop is visible rather than hidden behind completed tasks.

### 6. Honest metrics and publishing controls

- Add run taxonomy: `implementation`, `verification`, `qa`, `research`,
  `decision`, `dispatch`, and `maintenance`.
- Show delivery success, verification pass rate, and QA readiness separately from
  total activity. Do not label planning/research records as feature delivery
  success.
- Add publishing profiles: `summary-safe`, `team`, and `full`.
- Default new hosted publications to `summary-safe`: status, counts, timestamps,
  repo names, diffstats, and sanitized evidence references only.
- Require explicit opt-in for prompts, file paths, raw command output, and detailed
  run summaries. Show the active profile and sensitive-field warnings in both UIs.
- Keep local full-detail logs available to authorized workspace users.

### Hosted Dashboard

- Replace a single green goal status with a readiness panel:
  authored task coverage, QA status, criterion coverage, delivery-group checks,
  stabilization items, and the next required human action.
- Add goal tabs or sections for **Tasks**, **Delivery**, **Criteria**, **QA**, and
  **Stabilization**. Preserve multi-goal grouping rather than mixing tasks from
  every goal into one board.
- Render task kind and required/missing evidence in task details.
- Render one PR card per delivery group, with the covered tasks and criteria.
- Clearly label PR review as awaiting human approval when the actor cannot merge.
- Separate activity metrics from delivery-quality metrics.
- Render publication profile and redact fields the profile does not permit.
- Support older AWO publications with clear empty/legacy states rather than errors.

### Local AWO UI

- Use the same readiness, criterion, delivery-group, stabilization, and privacy
  projections as the hosted dashboard.
- Provide CLI deep links and copyable commands for `goal readiness`,
  `delivery status`, and `goal reconcile`.

## Authority Rules

- Human approval is required for acceptance-criterion exceptions, QA verdicts,
  stabilization scope, PR approval, and any merge unless existing external policy
  explicitly grants merge authority to the authenticated actor.
- An agent may not approve its own PR or record its own work as an independent QA
  verdict.
- A status rollup and dashboard are reporting surfaces, not authorization systems.
- External GitHub permissions and `pullRequests.mergePolicy` remain the source of
  truth for approval and merge permissions.

## Non-goals

- Automatic self-approval or self-merge.
- Unlimited autonomous bug fixing.
- Replacing GitHub or CI as the source of PR/review/check truth.
- Requiring a commit for an investigation, decision, or read-only verification.
- Retrospectively reconstructing every historical run with perfect evidence.
- Agent hierarchy, automatic delegation, or organization-chart rendering. Those
  remain AWO-F1 and should consume this feature's truthful readiness data.

## Acceptance Criteria

1. A goal with an authored task missing from `state.json` never displays or
   persists as `done`; `doctor` reports an actionable reconciliation error.
2. A governed goal cannot pass a verdict until every authored task, criterion,
   required delivery check, and QA evidence requirement is satisfied.
3. Existing non-governed workspaces remain readable; migration to the strict policy
   is explicit and documented.
4. `doctor` accepts an evidence-complete investigation with no commit and rejects
   an implementation task missing required implementation evidence.
5. A single delivery group can link multiple tasks to one repository PR, branch,
   commit range, and CI result without task-level PR warnings.
6. The system records and displays a PR as awaiting human approval when agents
   cannot merge; no command grants an agent approval rights.
7. An integration gap can open a bounded stabilization phase, create linked repair
   tasks, and prevent goal completion until verification evidence resolves it.
8. An out-of-scope gap creates a linked requirement only after the required human
   decision is recorded.
9. Dashboard and local UI show the same readiness blockers, delivery groups,
   criterion coverage, stabilization status, and publication profile.
10. Delivery metrics exclude research/decision activity from delivery success rate
    while retaining it in total activity.
11. `summary-safe` publishing omits prompts, file paths, raw output, and detailed
    summaries; full publication remains an explicit profile.
12. Tests cover state reconciliation, strict gates, task-kind contracts, delivery
    groups, stabilization, backward compatibility, publish redaction, local UI,
    and hosted dashboard legacy/populated states.

## Delivery Plan

1. **Schema review:** approve status names, goal policy defaults, task kinds,
   evidence schema, delivery-group ownership, stabilization boundary, metrics
   taxonomy, and publish profiles. Do not write runtime behavior before this gate.
2. **AWO safety core:** authored-task reconciliation, conservative rollup,
   diagnostics, strict completion policy, and criterion/QA gate.
3. **AWO evidence and delivery:** task-kind contracts, automatic Git/test capture,
   delivery groups, PR/check reconciliation, and tests.
4. **AWO stabilization:** bounded repair flow, requirement escalation, readiness
   output, metrics taxonomy, publishing profiles, migrations, and tests.
5. **AWO release:** bump the npm package, run the complete suite, publish `latest`.
6. **Dashboard implementation:** readiness-first goal views, delivery/criteria/QA/
   stabilization views, activity vs delivery metrics, privacy states, and tests.
7. **Dashboard release:** build, push, deploy, and verify a published workspace.
8. **Real-workspace rollout:** update `atlas-shop-awo`, reconcile `SHOP-G1`,
   configure delivery groups, run the final verification task, and collect human
   feedback before making strict completion mandatory everywhere.
9. **Organization graph:** resume AWO-F1 only after the dashboard displays
   trustworthy readiness and delivery ownership data.

## Human Decisions Required

- Approve whether `qaRequired` becomes the default immediately for new workspaces.
- Approve the final names and lifecycle for `in-review`, `qa-review`,
  `stabilizing`, and `inconsistent`.
- Decide whether a delivery group may span multiple repositories or is exactly one
  repository per group in v1. This proposal recommends one repository per group.
- Decide the default stabilization task/time budget and who may approve exceptions.
- Approve publish-profile defaults for local, team, and hosted dashboard use.
- Decide whether merging through AWO is enabled only for explicitly configured
  service accounts with existing merge rights, or disabled entirely in v1.

## Done

This feature is done only after both repositories are released, a real workspace
with a multi-task repository PR uses a delivery group successfully, an authored
task/state mismatch is prevented from reporting `done`, QA evidence blocks a false
pass, a bounded stabilization item is completed or escalated, and a human confirms
that approval and merge boundaries were not weakened.

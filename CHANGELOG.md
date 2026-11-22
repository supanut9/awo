# Changelog

All notable changes to AWO are documented in this file.

## [Unreleased]

## [0.8.0] - 2026-11-22

"The finish line." Grounded in a study of five real workspaces (atlas-shop,
atlas-sales-crm, atlas-auth, blender, awo-dashboard) and 4,216 mined awo
invocations from Claude Code and Codex sessions, cross-checked by independent
Claude and Codex reviews — see `awo-upgrade-plan.md`. awo already measured work
honestly; it did not yet help anyone *finish*: 112 of 129 tasks in one workspace
sat in review with zero verdicts, every "human" approval was typed by an agent,
half the criterion evidence was prose, and `log tail` showed agents the wrong run
74 times out of 75.

### Breaking / behaviour changes

- `task event --run` exits **3** when the measured command fails (`--no-fail` for 0).
  A `test` event without `--run` now measures the repo's declared `testCommand`;
  test *claims* (`--data '{"pass":n}'`) are refused, and fields awo writes itself
  (`verified`, `exitCode`, `treeId`, `diagnosis`, …) cannot be supplied.
- Under an agent runtime (Claude Code, Codex, Gemini CLI, or `AWO_AGENT`),
  `req approve` and `goal verdict` require `--delegated-by <human>` (optionally
  `--instruction "<their words>"`) and record the delegation. A human typing
  through an agent's shell can prefix `AWO_HUMAN=1`. `governance.allowDelegation:
  false` makes those gates human-terminal only. `--who` never defaults to "human".
- `req approve` only accepts a `proposed` requirement that has criteria.
- `task evidence --kind test` must bind to a passing measured test of the task
  (`--ref <runId|command>`, or omit it for the latest). Legacy prose is shown as
  `claimed`.
- `task run` refuses a body that is still the `task new` template (or empty)
  unless `--instruction` or `--allow-empty-body`; unmet dependencies are refused
  without marking the task `blocked`.
- `task new` without `--targets` is refused for implementation work.
- `awo remove` keeps cloned checkouts on disk unless `--delete-checkout`.
- `doctor` defaults to `--scope active`.
- The built-in `low` tier resolves to Claude sonnet, not haiku.
- `engines.node` is `>=20.19` (the real floor of chokidar 5 / mongodb 7).

### Security

- simple-git 3.36.0 → **4.1.0**, clearing four critical advisories (GHSA-g4wm-2vf7-vfgr,
  GHSA-858h-whjf-mvg5, GHSA-x6jw-m9v5-85vh, GHSA-v5rq-49vh-5v5c); awo passes
  goal-frontmatter branch names into git. `npm audit --omit=dev` is clean.
- Delegation quotes are kept only in the redactable prompt section; evidence
  exceptions go through the same human gate as approvals.
- Locks are released at process exit rather than mid-write, and only by their owner.

### Evidence and completion

- `--untested` only excuses a run with no measurement; failing, stale and
  needs-human results always block, and `dispatch` no longer passes it for every
  exit 0. A multi-repo task needs a passing measurement in every repo it changed.
- Receipts are keyed on tested *content* (`treeId`), so committing exactly what
  was tested no longer stales the receipt.
- Measured commands run under `bash -o pipefail`; timeouts kill the process group;
  a command ending in `|| true` is refused; exit 2/127 at both head and base is
  `not-runnable`, not evidence.
- Runner-specific counts (vitest — no more "61 tests" that were 61 files — jest,
  node:test, mocha, go, pytest) with cases and suites recorded separately.
- `test-and-code-changed` escalates only when an existing test loses an
  assertion; in QA-governed goals the hint is recorded without `needsHuman`.
- Secrets (`*_PASSWORD=`, `*_TOKEN=`, `mysql -p…`, URL credentials, known token
  formats) are redacted in every event, run record and measurement artifact.
- `task complete` defaults `--outcome` to success, adds `--failed`/`--skipped`
  and `--model` (the model that actually ran); `task event` accepts `--note`,
  `--msg`, `-m`, `--sha` and suggests the right kind.

### Lifecycle and runs

- `blocked` is no longer a dead end: the runner may start a blocked task, and
  humans may park `todo`/`queued`/`in-review` tasks as blocked with `--reason`
  and restore cancelled ones. Every move is recorded in `transitions[]` with who
  and why.
- `task run --reopen --reason` for repair rounds; `task run` on a running task
  re-prints its run instead of erroring.
- **New** `awo task resume <id>` hands an open run to a fresh worker (brief,
  worktrees, events so far, last measurement per repo) and takes ownership.
- Runs record their owner (pid, host, actor), `intendedModel` and `executedBy`;
  an unchanged brief is stored once and pointed at.
- `awo run` shares the dependency policy of `task run`.
- Archived goals are read-only until restored; `goal archive` freezes the status
  and refuses unmerged linked PRs unless `--unmerged-ok`.

### Governance and acceptance

- Criteria parsing reads every acceptance-criteria section (amendments), ignores
  sub-bullets and struck items, and keeps `AC-17` labels stable; evidence stores
  the criterion hash, and trace/readiness flag criteria edited after evidence.
- `task evidence --criterion 1,3,5` and `--criterion AC-17`.
- QA verdict history is kept on every overwrite (`qaHistory`).
- QA briefs are written to `logs/<date>/qa/<runId>.md` and linked.
- **New** `req show`, `req list --stale <days>`; `--reason`/`--why` and
  `--by`/`--who` accepted interchangeably.

### Worktrees and delivery

- Task branches are cut from the fetched remote default branch (or the goal's
  `deliveryBranch`, `baseBranches[repo]`, the repo's `baseBranch`) — never from
  whatever the shared checkout happens to have checked out. The base is recorded.
- Reused worktree paths are validated; diverged dependency branches are refused.
- Prune never deletes what git refused to remove, recognises squash-merged and
  PR-merged branches, and nulls dangling pointers; `worktree prune --deps` frees
  `node_modules`/`.next`/`dist` from idle worktrees.
- Baselines prune stale registrations first and never link the candidate's
  `node_modules` into an installing command; an installer in a task worktree gets
  a private `node_modules` instead of rewriting the shared one. awo's dependency
  link is excluded from commits even under a `node_modules/` ignore.
- Stale locks are reclaimed when their owner process is gone.
- PRs: merged state is recorded and a merged PR finishes a non-governed task;
  `pr status|reconcile --all`; one PR per repo per task; `pr link` infers
  `--repo`/`--number` and supports `--goal` (goal-branch delivery);
  `pr finalize` honours per-repo `mergePolicy` and `requiredChecks: "none" |
  [names]` and its `--dry-run` writes nothing; review feedback becomes one
  repair task per pass with bot threads skipped; a repo's `githubAccount` is
  honoured by token, without switching the global `gh` account.

### Authoring and templates

- `task new --body-file|--objective|--done-when|--criteria|--tier|--output|--origin`;
  investigation and decision tasks may have no targets. New files record
  `createdAt` and `origin` and no longer carry a stale `status:`.
- IDs are monotonic and allocated under a lock, so a deleted task's id (and its
  old branch) is never reissued.
- `goal new --policy light|standard|strict` (default `goals.defaultPolicy`).
- The worker brief separates worker from orchestrator duties and carries a
  command card, the skills to open first, an exact measured test line per target,
  the criteria the task serves, its base branch and the per-repo merge policy.
- Templates no longer name commands that do not exist or the removed log layout;
  capture-requirement, run-tests, create-task-worktree, verify-acceptance-criteria
  and ship-a-change match the CLI; connectors ship empty; `init --name`.

### Doctor, closure, upgrade

- **New** `awo goal close <G> [--dry-run]`: every blocker as an exact command,
  then archive and prune the goal's safe worktrees.
- Doctor: stable finding codes; stuck QA review, goals without evidence, empty
  planning goals, dangling worktree pointers, low disk, unwritten bodies, fast
  approvals without delegation, a workspace-root git repo, live vs abandoned
  open runs (with a legal fix), malformed task files, stale locks, stray files,
  and `--secrets`.
- Upgrade backups are timestamped; the legacy `.worktrees` migration preserves
  checkouts; collisions stop the upgrade; awo's own `.vscode/settings.json` edits
  are not drift; `--preview`.
- **New** `awo agent|skill|rule remove <name>` with reference checks.

### UI, publish, dashboard

- Local UI and the hosted dashboard handle suspended/cancelled requirements and
  archived goals; UI types come from the reader.
- Publish carries `projectionVersion`, archived state and `finishedAt`, watches
  the day-file log layout, redacts field-aware (briefs and checkout paths
  withheld by default, secrets always masked) and purges full-detail events when
  detail is reduced. `agent org` counts runtime status.
- In-major dependency updates (fs-extra, mongodb, uuid, vite, react, tailwind,
  marked, …); majors (commander, chokidar, TypeScript, preact) deferred.

### Review fixes (independent Codex + Claude review of the upgrade)

- `dispatch` accepts a run its worker already closed; `awo run` stops on a gate
  refusal (`gate-refused`) instead of moving on.
- A PR merged before a task's latest run began cannot finish that run.
- `remove --delete-checkout` counts detached-HEAD and tag commits.
- Exit 2 is "not runnable" only when no test summary was parsed (`make test`).
- A refused worktree leaves that repo without a checkout rather than falling back
  to the shared one.
- Criterion binding applies completion's receipt rules; nested conditions are part
  of a criterion's hash and the approval digest; re-attaching after a reorder never
  rewrites another labelled criterion's evidence.
- A PASS keeps the GAP it supersedes; `task complete` claims the close under the
  state lock; `goal close` and `goal archive` agree on unmerged PRs.
- Legacy migrations check every destination before moving and re-register moved
  worktrees with git.

### Fixed (stabilization, previously unreleased)

- Task completion rejects failed or stale measurements even when routed to QA;
  only the latest rerun of the same repo/command replaces an earlier result.

- Serialize state and daily log writes across processes; reserve run IDs before
  recording events, including allocations that cross midnight.
- Use governed QA/evidence readiness in goal views and archival. Preserve QA on
  duplicate evidence retries and retain prior verdicts when evidence changes.
- Pin test checkouts and comparison bases, include dirty/untracked changes, reject
  missing checkouts and invalid refs, preserve the base across rechecks, and retain
  immutable candidate/baseline measurement artifacts.
- Treat unregistered archived-task targets as historical diagnostics; preserve
  errors for active tasks. Add `doctor --scope active|all` and `--json`.
- Align package-lock version metadata and track missing init fixture placeholders.

### Added (stabilization, previously unreleased)

- `version --verbose` / `--json` with build commit, source hash and dirty-source flag.
- `verify:package` to install a packed artifact and smoke-test its CLI and template.
- Cross-process and lifecycle regression tests; documented stopped-writer rollout
  and explicit lock recovery in `docs/features/stabilization-rollout.md`.

## [0.7.1] - 2026-08-27

### Fixed

- `goal archive`, `goal list` and the `awo context` archive nudge now reconcile a
  goal's status against its task files instead of reading `state.json` raw. A real
  goal had a stored `done` while 8 of its 20 tasks were still open, because tasks
  were added after the status was last written — the raw read would have filed away
  a goal with live work in it, which is the exact thing the archive guard exists to
  prevent. The snapshot reader had always reconciled, which is why `awo context`
  and `awo goal archive` disagreed about the same goal.

## [0.7.0] - 2026-08-27

### Added

- `goals/archive/` and `awo goal archive <goal>` / `awo goal restore <goal>`,
  mirroring `requirements/archive/`. The whole goal folder moves — `goal.md`,
  `requirement.md`, `state.json`, `tasks/` and any assets — so every link inside it
  stays valid, because none of them cross the boundary.
- `awo goal list`, showing live goals by default (`--archived`, `--all`).
- `awo context` lists only live goals, counts the archived ones, and names finished
  goals still waiting to be filed. An archive you have to remember to use stays
  empty.

### Changed

- `findGoals` reads both `goals/` and `goals/archive/`, and **includes archived
  goals by default**. Hiding them would make every historical task unlocatable and
  silently break `awo log show` and the traceability chain; only the views that
  want the short list filter.
- Archiving refuses a goal that is not `done` or `cancelled` unless `--force`,
  since archiving live work hides it from the one digest a session reads.

## [0.6.0] - 2026-08-27

### Added

- `skills/chart-the-unknown` — how to plan a goal whose shape is not yet known:
  decision tasks resolved one per session, rather than a task breakdown guessed on
  top of open questions and rewritten halfway through. It adds no new artifact; the
  goal is the map, and it uses the `kind: decision` and `dependsOn` that were
  already there but had no procedure telling anyone to reach for them.
- `goal.md` now ships `## Decisions so far` (an index pointing at the task that
  holds each answer, never a second copy of it) and `## Not yet specified` (the
  questions you can tell are coming but cannot phrase sharply yet).

### Changed

- `instructions/plan-a-goal` now states the slicing bar it always assumed: cut
  vertically so each task is demoable alone, and sequence a wide refactor as
  expand → migrate → contract, because a mechanical change with a large blast
  radius cannot land green as a vertical slice. It also routes to
  `chart-the-unknown` when every draft task starts with "depending on whether".

## [0.5.0] - 2026-08-27

### Added

- External agent skills: `.workspace/agent-skills.json` declares open-ecosystem
  skills (a `SKILL.md` under `.claude/skills/`, a different runtime from awo's own
  flat-markdown skills), and `awo skill sync` installs them via the `skills` CLI.
  Declared rather than vendored, so upstream stays live and the `references/`
  directories that hold the real payload come along.
- `awo skill external` reports what is declared and whether it is actually
  installed, distinguishing a workspace install from one that exists only in
  `~/.claude/skills` and will not survive a clone or a scheduled run.
- Bundle entries: one declaration can install many skills from a single source
  (`larksuite/cli` ships 28), so a coherent capability costs one line in AGENTS.md
  rather than 28.
- A generated `agent-skills` block in AGENTS.md, and the always-on rule
  `use-declared-skills` — measured on 512 runs, a skill was named in 39 of them,
  and nothing in the workspace told anyone to look.
- `awo doctor` reports declared-but-missing, partly-installed, and user-global-only
  agent skills.

## [0.4.0] - 2026-08-18

### Added

- Truthful goal-readiness evaluation across authored tasks, acceptance-criterion evidence, QA sign-off, attribution, and human approval.
- `awo goal readiness` for a non-mutating readiness report and `awo goal reconcile` for explicit state repair.
- Dashboard readiness details that explain completion blockers instead of projecting task counts as delivery readiness.

### Changed

- Goal completion now requires reconciled task state and complete delivery evidence before transitioning to `done`.
- Template policy and generated workspace guidance now document the stricter completion contract.

[Unreleased]: https://github.com/supanut9/awo/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/supanut9/awo/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/supanut9/awo/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/supanut9/awo/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/supanut9/awo/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/supanut9/awo/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/supanut9/awo/compare/v0.3.0...v0.4.0

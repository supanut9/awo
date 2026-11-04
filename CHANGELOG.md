# Changelog

All notable changes to AWO are documented in this file.

## [Unreleased]

### Fixed

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

### Added

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

[Unreleased]: https://github.com/supanut9/awo/compare/v0.7.1...HEAD
[0.7.1]: https://github.com/supanut9/awo/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/supanut9/awo/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/supanut9/awo/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/supanut9/awo/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/supanut9/awo/compare/v0.3.0...v0.4.0

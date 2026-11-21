# awo 0.8.0 — "the finish line" upgrade plan

_Authored 2026-11-22. Base: `origin/main` @ f75881d (0.7.1 + unreleased stabilization). Branch: `feature/awo-upgrade`._

## 1. The problem in one paragraph

awo works as an **execution ledger and isolation mechanism**: 3,395 of 3,411 test events in the real
workspaces were measured by awo itself, task IDs never collided, logs never corrupted. It does **not**
yet work as a **way to finish**. In atlas-sales-crm-awo, 112 of 129 tasks sit in `in-review` and zero
goal verdicts were ever recorded; the only goals that reached `done` got there by switching QA off.
Every "human gate" was typed by an agent and most were logged as "human". Half the per-criterion
"test" evidence is free text. Agents spend 17% of their awo calls on `--help`, guess flags that do not
exist, and get pointed by awo's own hint at the wrong run 74 times out of 75. Worktrees are cut from a
stale local checkout (56% of measurements flagged `needsHuman`, mostly noise), never cleaned up after
squash merges, and filled the disk until every agent stopped. Two of four workspaces built their own
supervisor, handoff files and identity scripts outside awo. **0.8.0 closes the loop from "worker
finished" to "goal truthfully done, merged, archived and cleaned up", makes the gates honest, and
removes the CLI friction agents hit thousands of times.**

## 2. Research (what this plan is grounded in)

Seven parallel lanes, read-only, 2026-11-21/22:

| Lane | Who | Scope |
|---|---|---|
| C1 | Claude | awo library audit (src, templates, GUIDE §15, PROJECT_PLAN findings) |
| C2 | Claude | CLI friction from 4,216 mined awo invocations + 301 user messages |
| C3 | Claude | atlas-shop-awo (113 goals, 1,335 tasks, 3,931 runs, 25 MB logs) |
| C4 | Claude | atlas-sales-crm-awo (38 goals, 129 tasks, 255 runs) |
| C5 | Claude | atlas-auth-awo, blender-awo, awo-dashboard |
| X1 | Codex | independent library code review |
| X2 | Codex | independent real-usage review |

Transcript corpus: every `awo` call extracted from Claude Code + Codex sessions in the five workspaces
(`scratchpad/research/transcripts/`), with failure re-classification by C2 and X2 (most of the 363
heuristic "failures" were noise; ~70–86 were genuine CLI parse errors, ~11 genuine refusals, and one
real bug class — `log tail`).

### Convergent findings (≥2 independent lanes agree)

| # | Finding | Lanes | Key evidence |
|---|---|---|---|
| F1 | `--untested` and `dispatch` bypass failing/stale measurements | C1, X1 | `task.ts:673`, `dispatch.ts:137-143` |
| F2 | Caller `--data` can impersonate measured evidence | X1 | `task.ts:513`, `runs.ts:201` |
| F3 | Criterion "test" evidence is free text; criteria matched by position | C1, C3, C5, X1, X2 | 66% (shop) / 50% (auth) prose refs; SHOP-G109 AC-17..41 invisible |
| F4 | Human gates honour-system; audit says "human" when an agent typed it | C1, C4, C5 | 22/22 approvals + 26/26 verdicts by agents; 35 CRM approvals <60 s |
| F5 | `blocked` is a dead end; dependency gate writes `blocked`; humans cannot park | C1, C2, C3, X1 | 10–12 `blocked→running` refusals, 33 `status todo` workarounds |
| F6 | `in-review` never ends; merged PRs never move tasks; no merged state | C4, C3, X2 | 112/129 CRM tasks in review, median 15 d; 2/105 shop goals clean PRs |
| F7 | `log tail`/`log show` show the wrong / no run; hint points at it | C1, C2, X1, X2 | 355 hints, wrong run 74/75, 13 agent log-parser crashes |
| F8 | Flag guessing & required options that could be inferred | C1, C2, C5, X1, X2 | 17% `--help`; `--msg/--note/--sha/--goal/--title`; `log add --agent/--summary` |
| F9 | Worktree base = stale shared checkout HEAD, no fetch | C1, C4, X1 | 158 passing runs flagged `test-and-code-changed`; 19 manual rebases |
| F10 | Worktree sprawl; prune useless after squash merge; ENOSPC | C1, C3, C4, C5 | 117/126 dangling pointers; 3.1 GB shop; disk full Nov 20 |
| F11 | Baseline links candidate `node_modules`; `npm ci` damages shared install | C1, C4, X1, X2 | 19 baseline failures; 849 MB leftover baselines |
| F12 | `test-and-code-changed` flags normal TDD as needs-human | C2, C3, X2 | 42–58% of all test events |
| F13 | Context `--json` 228 KB–2.7 MB; NEXT wrong; stats count journal rows | C3, C4, C5, X1 | 99% "success" with 736 failing exits |
| F14 | Every command rescans the whole workspace | C1, X1 | `context` 4.3 s, `task list` 1.1 s on shop |
| F15 | Templates contradict the CLI (brief vs ship-a-change, nonexistent commands) | C1, C2, X1, X2 | `awo skill new`, `logs/index.jsonl`, `test --data '{"pass":n}'` |
| F16 | Recorded model is the intended one, not the one that ran | C3, C4 | 142/145 CRM runs say `claude:haiku`; work done by Opus/Codex |
| F17 | Secrets recorded verbatim in logs/evidence | C3, C5 | `*_PASSWORD=`, `mysql -p…` in day logs |
| F18 | Open runs have no owner/liveness; resume handled by hand | C4, C5, X1, X2 | atlas-auth supervisor script; CRM-T90 open 227 h |
| F19 | QA verdict history lost on overwrite | C3 | 13 GAP verdicts in logs, 0 in state |
| F20 | `pr finalize` unusable without CI; one PR slot per task | C2, C4, X1 | 95 `gh pr merge` vs 21 `pr finalize`; 5 overwritten PR links |
| F21 | Tasks dispatched with unwritten template bodies | C3, C4 | 22% of shop first briefs were the template |
| F22 | Brief omits skills, test command, criteria | C2, C3 | 4.9% of briefs name a skill; 23% used declared testCommand |
| F23 | Hosted dashboard + local UI schema drift; triplicated read model | C5 | suspended/cancelled/archived missing |
| F24 | Vitest count parses "Test Files N passed" | C1, C3, X2 | "61 tests" reached a PR and a Jira card |
| F25 | Destructive paths: `remove` rm -rf's clones; prune rm -rf after git refusal; legacy migration rm's `.worktrees` | X1 | `remove.ts:26`, `worktrees.ts:481`, `upgrade.ts:303` |

### Keep (explicitly protected)

Measured `task event --run` + baseline diagnosis; stale-receipt and failing-measurement rejection;
cross-process locks, atomic writes, run-ID reservation; per-task worktrees and conservative prune;
governed goals (per-task approval refused, verdict requires readiness, QA invalidated by new work);
three-way-merge upgrades; goal/requirement archive with whole-folder moves; `pr finalize` never
approves, `human-only` default, gh account guard; `awo context` text digest; `log add` as escape hatch.

## 3. Scope of 0.8.0

Grouped by lane (file ownership below). IDs reference the findings above.

### Lane A — evidence & completion integrity (F1, F2, F12, F17, F24)
- A1 `--untested` satisfies only the "no test event at all" branch; failing / stale / needs-human checks always run.
- A2 `dispatch` passes `untested` only when the run recorded no test event; a gate refusal leaves the run open.
- A3 Reserved event fields (`verified`, `exitCode`, `fingerprint`, `diagnosis`, `needsHuman`, `measured*`, `runId`, `kind`, `ts`, …) are rejected in `--data`; event envelope written last.
- A4 Needs-human check uses the effective destination (`!gate && !qaRequired`); `task complete --outcome` defaults to `success`; `--failed` / `--skipped` shorthands; non-enum outcome → "did you mean --summary?".
- A5 Multi-target tasks need a measured pass in every target that has commit/diff events (or an `--untested <why>` naming the gap).
- A6 Receipts keyed on tested **content** (tree id), so "test, then commit" no longer stales the receipt.
- A7 `task event --run` exits **3** on a measured failure (`--no-fail` keeps 0), prints the diagnosis explanation and the last lines inline, and its hint names `awo log tail --task <id>`.
- A8 Measured commands run under `bash -o pipefail`; timeouts kill the whole process group.
- A9 Runner-specific count parsing (vitest/jest/mocha/go/pytest), suites vs cases recorded separately.
- A10 `test-and-code-changed` recalibrated: flag only when an existing test file loses assertions; added tests are fine; in `qaRequired` goals the hint is recorded but `needsHuman` stays false.
- A11 Secrets redacted in every appended event (`redactDeep`).
- A12 Exit 2/127 at both HEAD and base → `not-runnable` (not evidence); trailing `|| true` / `; true` refused.
- A13 `task event <id> test` without `--run` uses the repo's declared `testCommand`.
- A14 Stored `tail` capped at ~2 KB.
- A15 Aliases on `task event`: `--note/--msg/--text/-m` → `--message`; `--sha` → commit sha; event kind validated with suggestion.
- A16 `task complete --model <m>` records the model that actually ran.
- A17 Day-file reads skip an incomplete final line and warn (not crash) on malformed lines.

### Lane B1 — lifecycle & run ownership (F5, F16, F18, F21)
- B1-1 Dependency gate refuses **without** writing state; `task run` may start a `blocked` task (attempt+1, reason cleared).
- B1-2 Humans may move `todo|queued|in-review → blocked` with a required `--reason`, and `cancelled → todo` (restore).
- B1-3 `transitions[]` audit record (from, to, actor, by, reason, runId, at) on every lifecycle move; rejection/cancel reasons persisted.
- B1-4 `task run --reopen --reason` for repair rounds (in-review → running); `task run` on a task already running in the same run is idempotent (prints the brief, exit 0).
- B1-5 `task run` refuses a body that is still the template unless `--instruction` or `--allow-empty-body`.
- B1-6 Run owner `{runId, pid, host, actor, startedAt}` recorded at run start; tasks with `targets: []` (investigation/decision) open runs without worktrees.
- B1-7 `run.start` records `intendedModel` and `executedBy` (detected runtime); `task run --model/--runtime` override.
- B1-8 Brief recorded once per task-body hash (no 3.5 MB of duplicated briefs).
- B1-9 **New** `awo task resume <id>`: re-brief a fresh worker into the open run (worktree, events so far, last measurement per repo), append `run.resume`, take ownership.
- B1-10 `awo run` (autorun) shares the dependency policy with `task run`; runnable = todo/queued/dependency-blocked; cross-goal deps read from their own goal.
- B1-11 Archived goals are read-only until restored; `goal archive` freezes `archivedStatus/archivedAt` and warns on unmerged linked PRs (`--unmerged-ok`).

### Lane B2 — governance & acceptance (F3, F4, F19)
- B2-1 Honest human gates: under an agent runtime, `req approve` and `goal verdict` require `--delegated-by <human>` (+ `--instruction "<quote>"`), recorded as delegation; `governance.allowDelegation: false` makes them human-terminal only; `--who` never defaults to the literal "human".
- B2-2 `req approve` only from `proposed`, with ≥1 criterion; shelved requirements must `resume`; criteria digest stored at approval.
- B2-3 Criteria parser: heading may carry trailing text; every "Acceptance criteria" section (amendments) is read; only top-level, un-struck items count; explicit `AC-17` labels are stable IDs.
- B2-4 `task evidence --criterion 1,3,5` and `--criterion AC-17`; evidence stores the criterion hash + label; trace/readiness flag criteria edited after evidence.
- B2-5 `--kind test` evidence binds to a **measured passing** test event of the task (by command or runId; default the latest passing one); failing or unmatched refs are refused; legacy prose shows as `claimed`.
- B2-6 QA history retained on every overwrite/delete (`qaHistory`).
- B2-7 QA briefs written to their own file, linked from the run log; stale `logs/index.jsonl` reference fixed.
- B2-8 `req show <id> [--json]`, `req list --stale <days>`; `--reason` ↔ `--why`, `--by` ↔ `--who` aliases.

### Lane C — inspection, logs, performance (F7, F8, F13, F14)
- C1 `allowExcessArguments(false)` + suggestions after error; command aliases `task start`, `task approve`, `requirement`.
- C2 `task list [goal] --goal --all --json` (live goals by default, goal column); `task show --json` with worktree/branch/base/PRs/owner/last measurement; **new** `goal show <id> [--json]`; `goal list --needs-verdict`.
- C3 `log tail` defaults to the newest run **including open ones**, skips empty runs, `--task <id>`, truncated brief; `log show <runId|taskId>` works on open runs and suggests the newest; `log list --limit --json --goal --task`.
- C4 `log add`: summary positional / `-m` / first `--note`; `--agent` defaults to `AWO_AGENT` or the detected runtime; `--title/--slug → --label`, `--status → --outcome`; `--task/--goal` link fields; off-roster agent warning.
- C5 One inventory per process (parse each task file once), `locateTask` fast path, each day file parsed once; lean, live-only `context`.
- C6 Context NEXT: nothing-live message, ignores archived tasks, ranks review backlog / goals awaiting verdict above stale runs, labels runs with no events for 24 h as stale; stats split worker runs vs journal entries, medians; `context --json` mirrors the digest, `--full` for the snapshot.
- C7 A malformed task file no longer breaks every command (collected, warned, reported by doctor); unknown `kind` warned.

### Lane D1 — worktrees & isolation (F9, F10, F11, F25)
- D1-1 Base resolution: dependency branch → goal `deliveryBranch` → goal `baseBranches[repo]` → repo `baseBranch` → `origin/HEAD`; best-effort `git fetch` first; base `{ref, sha}` returned for the run record; multiple dependency branches: descendant wins, otherwise refuse clearly.
- D1-2 Reused worktree path validated (registered, right repo, right branch) — fail closed.
- D1-3 Prune never `rm -rf`s after git refuses; detached HEAD reachability checked; active baselines leased; a branch counts as merged when the remote base contains it, `git cherry` shows patch-equivalence, or the task's PR is merged; dangling `state.worktree` pointers nulled.
- D1-4 `worktree prune --deps` strips `node_modules/.next/dist/.turbo` from idle worktrees.
- D1-5 Baseline: `git worktree prune` before add; no candidate `node_modules` link when the command installs; a symlinked `node_modules` is replaced by a private dir before an install command runs in a task worktree.
- D1-6 `awo remove` unregisters; deletes a clone only with `--delete-checkout` after safety checks.
- D1-7 Stale lock recovery (owner pid dead on the same host), exported for doctor.

### Lane D2 — PR delivery (F6, F20)
- D2-1 PR snapshots record `state/merged/mergedAt/mergeCommit`; `pr status|reconcile --all` refreshes every linked PR in live goals.
- D2-2 Merged PR → task `done` when the goal is not QA-governed; governed goals keep it in review, flagged merged (shown everywhere).
- D2-3 `pullRequests[repo]` (multi-repo tasks); `--repo` on status/reconcile/finalize/meta; `pr link` infers `--repo` (single target) and `--number` (`gh pr list --head`), `--goal` links one PR to every goal task on that repo (goal-branch strategy).
- D2-4 `pr finalize`: per-repo `mergePolicy`, per-repo `requiredChecks: "none" | [names]`, refuses unless the task is completed (in-review/done), dry-run strictly read-only.
- D2-5 `pr reconcile`: paginated threads, bot authors skipped (`pullRequests.ignoreAuthors`), one aggregated repair task per pass, thread map persisted per thread.
- D2-6 `githubAccount` honoured by injecting that account's `GH_TOKEN` into awo's own `gh` calls instead of demanding a global `gh auth switch`.

### Lane E — authoring, brief, templates (F15, F21, F22)
- E1 `task new --body-file <path|->`, `--objective`, `--done-when`, `--criteria`, `--tier`, `--output`; `targets` optional for investigation/decision kinds.
- E2 New tasks/goals record `createdAt` + `origin`; authored `status:` only when non-default.
- E3 ID allocation monotonic + locked, files created exclusively (`wx`) for req/goal/task.
- E4 `goal new --policy light|standard|strict` (default `goals.defaultPolicy`, else `strict`).
- E5 Brief rewrite: explicit worker vs orchestrator responsibilities, 6-line command card, skills to open first, exact measured test line per target, goal acceptance criteria, base branch and per-repo merge policy.
- E6 Tiering: low → sonnet by default; Claude invocation hint without `-C`, quoted paths; effort marked Codex-only.
- E7 Templates: remove nonexistent commands and stale layouts; capture-requirement refine→propose→approve; run-tests = measured flow; create-task-worktree matches `task run`; ship-a-change split; no manual commit events; empty connectors list; gitignore `.workspace/local/` and `.workspace/scratch/`; command card in AGENTS.md; fixture regenerated.
- E8 `awo init --name`.

### Lane F — doctor, closure, upgrade safety, presets (F10, F13, F18, F25)
- F1 Doctor default `--scope active`; new checks: qa-review > 7 d without verdict; governed goals with zero evidence; empty planning goals; dangling worktree pointers; disk free; placeholder bodies; fast approvals without delegation; stale locks; workspace-root repo; open runs classified live/abandoned with correct advice; malformed task files; non-goal folders under `goals/`; zero-byte stray files; `--secrets` scan.
- F2 **New** `awo goal close <G> [--dry-run]`: every blocker as an exact command list; when the policy is satisfied, archives and prunes the goal's merged, clean worktrees.
- F3 Upgrade: timestamped backups; legacy `.worktrees` preserved, not deleted; move collisions stop; awo-regenerated files excluded from drift.
- F4 **New** `awo agent|skill|rule remove <name>` with reference checks and managed-block refresh.

### Lane G — UI, publish, dashboard, dependencies (F23)
- G1 Local UI: suspended/cancelled/archived handled; no "plan" hint for shelved requirements; types shared with the reader.
- G2 Publish: `archived`, `archivedStatus`, `projectionVersion`, `finishedAt`; watcher follows `logs/<date>/`; field-aware redaction; prompts redacted by default.
- G3 `agent org` uses runtime status.
- G4 In-major dependency bumps (table §6); `engines.node` → `>=20.19` (actual floor of chokidar 5 / mongodb 7).
- G5 awo-dashboard (separate repo): matching types, shelved columns, archived goals hidden by default.

## 4. Deliberately deferred (with reason)

| Item | Why not now |
|---|---|
| Goal delivery groups / integration branches as a first-class model (X1-09, X2-07) | L; 0.8 honours `deliveryBranch/baseBranches` for worktree bases and adds `pr link --goal`, which covers shop's observed flow |
| Measurement receipt reuse across tasks, execution limits (X2-06) | L; needs dependency/environment fingerprints first |
| Release entity, dated follow-ups, obligations (C3-24, X2-09) | L; product design question — capture as a requirement |
| Spikes / research as first-class (C3-25, C4-09, X2-16) | Partial: `targets: []` + `--output` for investigation tasks; a `spike` entity waits for usage |
| Runtime fallback / supervisor / panels (C5-01, C5-12) | L; `task resume` + run ownership are the prerequisite |
| Exported schema/reader package (C5-17) | M; do after the 0.8 read-model settles |
| Major dependency bumps: commander 15, chokidar 6, simple-git 4, TypeScript 7, preact 11, @types/node 26 | Behavioural/major changes; separate release with its own verification |
| Authorization ledger for deployment-data tasks (C5-04) | M; design with the release entity |

## 5. Behaviour changes users will notice

1. `task event --run` exits 3 when the measured command fails (`--no-fail` for the old behaviour).
2. Under an agent runtime, `req approve` / `goal verdict` need `--delegated-by <human>`. Humans running awo through an agent shell can set `AWO_HUMAN=1`.
3. `req approve` requires a `proposed` requirement with criteria.
4. `task evidence --kind test` must point at a passing measured test event (or omit `--ref` to use the latest).
5. `task run` refuses an unwritten template body without `--instruction`.
6. `awo remove` keeps cloned checkouts on disk unless `--delete-checkout`.
7. Unknown extra positional arguments are an error instead of silently ignored.
8. `doctor` defaults to `--scope active`.

## 6. Locked dependency versions (verified with `npm view`, 2026-11-22)

| Package | Installed | Latest | 0.8.0 |
|---|---|---|---|
| commander | 12.1.0 | 15.1.0 | **12.1.0** (major deferred) |
| chokidar | 5.0.0 | 6.0.0 | **5.0.0** (major deferred) |
| simple-git | 3.36.0 | 4.1.0 | **3.36.0** (major deferred) |
| fs-extra | 11.3.6 | 11.4.1 | **11.4.1** |
| gray-matter | 4.0.3 | 4.0.3 | 4.0.3 |
| mongodb | 7.5.0 | 7.9.1 | **7.9.1** |
| uuid | 14.0.1 | 14.0.3 | **14.0.3** |
| typescript | 5.9.3 | 7.0.2 | **5.9.3** (major deferred) |
| @types/node | 22.20.1 | 26.6.6 | **22.x latest** (major deferred) |
| vite | 8.1.5 | 8.3.8 | **8.3.8** |
| @vitejs/plugin-react | 6.0.4 | 6.3.0 | **6.3.0** |
| tailwindcss / @tailwindcss/vite | 4.3.3 | 4.3.5 | **4.3.5** |
| react / react-dom | 19.2.8 | 19.3.1 | **19.3.1** |
| @types/react / @types/react-dom | 19.2.17 / 19.2.3 | 19.3.0 | **19.3.0** |
| marked | 18.0.7 | 18.2.1 | **18.2.1** |
| preact | 10.29.7 | 11.2.0 | **10.x latest** (major deferred) |

## 7. Parallel sub-agent execution plan

**Wave 0 (done, sequential):** foundation commit on `feature/awo-upgrade` — shared types
(`manifest.ts`: `baseBranch`, `mergePolicy`, `requiredChecks`, `governance`, `goals.defaultPolicy`;
`state.ts`: `owner`, `transitions`, `pullRequests`, PR `state/merged`, evidence `measurement/criterionHash/label`,
QA `delegation`, goal `archivedStatus`; `tasks.ts`: goal `deliveryBranch/baseBranches/pullRequestStrategy`),
helpers (`agent-env.ts`, `redact.ts`, `cli-alias.ts`), stale `src/*.js` removed, `npm test` runs with
`AWO_HUMAN=1` so agent-detection is deterministic in tests.

**Wave 1 (parallel, 9 lanes, one git worktree + branch each):**

| Lane | Branch | Owns (write) |
|---|---|---|
| A | `upgrade/a-evidence` | `src/evidence.ts` (except baseline checkout), `src/runs.ts`, `src/commands/dispatch.ts`, `runTaskEvent`/`runTaskComplete`/`runTaskRecheck` in `task.ts`; cli blocks `task event/complete/recheck` |
| B1 | `upgrade/b1-lifecycle` | `src/state.ts`, `runTaskRun`/`runTaskStatus`/`runTaskVerify` + new `task resume` in `task.ts`, `autorun.ts`, `goal-archive.ts`; cli blocks `task run/status/verify/resume`, `run`, `goal archive/restore` |
| B2 | `upgrade/b2-governance` | `intake.ts`, `traceability.ts`, `readiness.ts`, `verify.ts`, new `src/qa-history.ts`; cli blocks `req *`, `task evidence`, `goal trace/readiness/verify/verdict/reconcile` |
| C | `upgrade/c-inspection` | `log.ts`, `context.ts`, `tasks.ts`, `ui/reader.ts`, `list.ts`, new `show.ts`; cli: program config, `task list/show`, `goal show/list`, `log *`, `context`, aliases |
| D1 | `upgrade/d1-worktrees` | `worktrees.ts`, baseline region of `evidence.ts`, `remove.ts`, `file-lock.ts`; cli `worktree *`, `remove` |
| D2 | `upgrade/d2-pr` | `pr.ts`; cli `pr *` |
| E | `upgrade/e-authoring` | `plan.ts`, `composeBrief` in `task.ts`, `models.ts`, `init.ts`, `templates/default/**`, `test/fixtures/PROM-workspace/**`; cli `req new`, `goal new/plan`, `task new`, `init` |
| F | `upgrade/f-doctor` | `doctor.ts`, `upgrade.ts`, `catalog.ts`, new `goal-close.ts`; cli `doctor`, `upgrade`, `agent/skill/rule`, `goal close` |
| G | `upgrade/g-ui` | `ui/**`, `publish.ts`, `ui.ts` (command), `agent-org.ts`, `package.json` deps/engines, `package-lock.json`, repo `awo-dashboard` |

Rules for every lane: own tests in a new `test/<lane>-*.test.ts`; update existing tests only where the
lane's behaviour change requires it; no edits to `CHANGELOG.md`, `README.md`, `GUIDE.md`, version;
small, incremental edits; full `npm test` green before the lane's single commit.

**Wave 2 (sequential, integration worktree `upgrade/integration`):** merge A → B1 → B2 → C → D1 → D2
→ E → F → G, resolving conflicts (mostly `cli.ts`, `task.ts`); full suite after each merge; wire
cross-lane seams (transition audit in completion, run base from D1 into B1's state, merged-PR prune).

**Wave 3 (parallel review):** Codex review + Claude review of the integrated diff; fix confirmed
findings.

**Wave 4 (sequential):** CHANGELOG 0.8.0, README command table, GUIDE (§5–§7, §14, §15 honest gaps),
template command card mentions of new commands, a test that every `awo …` mentioned in templates exists,
version 0.8.0, `verify-template` + `verify-package`; fast-forward `feature/awo-upgrade`; build in the
main checkout (this **deploys** to the npm-linked global `awo`); read-only `awo context`/`doctor` smoke
in all four workspaces; push branch, open PR. `npm publish` only on explicit approval.

## 8. Acceptance for this upgrade

- Every finding marked in §3 has a test that fails on 0.7.1 behaviour and passes on 0.8.0.
- Full suite green; `verify-template` and `verify-package` green.
- `awo context` and `awo doctor` run read-only in atlas-shop/crm/auth/blender without crashes, faster
  than 0.7.1 on shop, and with fewer noise findings.
- No destructive path remains that deletes a registered worktree, a clone, or legacy worktrees
  without an explicit flag and safety check.

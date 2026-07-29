# awo

Scaffolds and orchestrates AI-agent development workspaces.

```sh
mkdir my-workspace && cd my-workspace
npx @supanut9/awo@latest init --key PROM
```

`init` lays down an orchestration hub — agent roles, always-on rules, invokable
skills, workflow instructions — and links to one or more working repos where the
real code lives. The workspace holds **how agents work on your code**, never the
code itself.

> **Package name:** published as **`@supanut9/awo`** — the unscoped `awo` was taken
> on npm by an unrelated 2022 placeholder. The installed **command is `awo`**, so
> only the install string differs.

## Why

Every agent project re-invents the same scaffolding: which roles exist, what they
may touch, how work is decomposed, what counts as done, and where the audit trail
lives. `awo` makes that a versioned, upgradeable template plus a small CLI that
owns the fiddly parts — ID allocation, worktree isolation, lifecycle state, and the
run log — while agents do the thinking.

It is **runtime-agnostic**: `AGENTS.md` is canonical and `CLAUDE.md`/`GEMINI.md` are
thin pointers, so Claude Code, Codex and Gemini CLI all read the same instructions.
Handoff between agents happens through **files, not shared context**, which is why a
Claude session can orchestrate Codex workers with no interop layer.

## Quick start

```sh
awo init --key SHOP                      # scaffold the workspace
awo connect ../my-api                    # link a local repo (symlink)
awo add https://github.com/me/web.git    # or clone one
awo context                              # where things stand, and what to do next

awo req new --title "FAQ on the product page"
awo req refine SHOP-R1                   # PM role writes acceptance criteria
awo req approve SHOP-R1                  # THE human gate — planning needs this
awo goal new --from SHOP-R1              # requirement -> goal
awo task new --goal SHOP-G1 --name "Read endpoint" --targets my-api --agent software-engineer

awo task run SHOP-T1                     # opens the run, creates the worktree,
                                          # prints which model should do it
awo task event SHOP-T1 test --data '{"repo":"my-api","pass":42}'
awo task complete SHOP-T1 --outcome success --gate
awo task evidence SHOP-T1 --criterion 1 --kind test --ref "npm test"
awo goal trace SHOP-G1

awo goal verify SHOP-G1                   # assemble the QA gate for a high-tier review
awo goal verdict SHOP-G1 --pass --summary "meets the definition of done"

awo run --goal SHOP-G1 --until SHOP-T3    # work the plan, stopping before the verdict
awo ui                                    # local dashboard on 127.0.0.1
```

## PM requirement to human-approved PR

`awo` is designed for the practical AI-era engineering loop: a PM supplies the
outcome; agents turn it into scoped, testable work; and GitHub branch rules
remain the final authority. The default end state is a validated pull request
**ready for human approval**. An explicitly authorised maintainer account may
merge after every repository-required check and review is satisfied.

```text
PM request -> requirement -> goal and task plan -> isolated implementation
           -> measured tests and QA -> open PR -> fix checks and review feedback
           -> ready for human approval -> human or authorised maintainer merges
```

Start a request like this:

```sh
awo req new --title "PM outcome in one sentence"
# The product-manager role refines scope, non-goals, acceptance criteria, and open questions.
awo req refine SHOP-R1
# After the criteria are written, the agent proposes them; a human accepts the work.
awo req propose SHOP-R1
awo req approve SHOP-R1 --who "PM name"
awo goal new --from SHOP-R1
# Plan repo-scoped, dependency-ordered tasks with testable done-when criteria.
awo task new --goal SHOP-G1 --name "Implement API contract" --targets api --agent software-engineer
awo task dispatch SHOP-T1
awo task event SHOP-T1 test --run "npm test" --baseline
awo task complete SHOP-T1 --outcome success --gate
awo task evidence SHOP-T1 --criterion 1 --kind test --ref "npm test"
awo goal trace SHOP-G1
awo goal verify SHOP-G1
```

For the complete generated-workspace procedure, use
`instructions/pm-to-pr.md`. `release-engineer` may open a PR and repeatedly
fix actionable comments or failed checks. It never submits an approval. By
default it stops after requesting human review; set
`pullRequests.mergePolicy` to `authorized-maintainer` only when that account is
intentionally permitted to merge after GitHub-required checks and reviews pass.

Before PR work, `awo pr preflight --repo api` verifies the existing `gh` identity
and repo access. After opening the PR, link it with `awo pr link SHOP-T1 --repo api
--number 42`; `awo pr reconcile SHOP-T1` refreshes the live PR and creates focused
repair tasks for unresolved review threads. `awo pr finalize SHOP-T1` always
reconciles first: `human-only` reports ready for a colleague, while
`authorized-maintainer` can perform only an immediate, clean squash merge. It never
submits an approval, enables auto-merge, or joins a merge queue.

Configure branch protection/rulesets to match your team. In a company repo,
require colleague approval and keep `human-only`. In a solo/maintainer repo,
GitHub can permit the authorised account to merge after its configured checks.
AWO cannot grant or revoke capabilities from an external GitHub credential.

## Commands

**Workspace**

| Command | Purpose |
|---|---|
| `awo init --key <KEY>` | Scaffold a workspace. `<KEY>` prefixes every ID and is permanent. |
| `awo context [--json]` | Compact orientation digest — run this first in a new session instead of scanning. |
| `awo doctor` | Version skew, broken links, bad targets, abandoned runs, work claimed without evidence. |
| `awo upgrade [--dry-run] [--force]` | Adopt the installed awo version: run migrations, three-way merge template changes around your edits, never overwrite them. |
| `awo resolve [file] [--theirs\|--yours]` | Show the remaining conflicts as a diff and take a side. |
| `awo rule new <id> --summary <text>` | Add an always-on rule. The AGENTS.md list regenerates itself. |
| `awo ui [--port]` | Local dashboard: board, run timeline, repos, runs, and analytics by tier/effort. |

**Repos**

| Command | Purpose |
|---|---|
| `awo add <url> [--ref]` | Clone and register a git repo. |
| `awo connect <path>` | Symlink an existing local checkout. |
| `awo list` | Linked repos and their status (present / missing / dirty). |
| `awo sync` | Reconcile `repos/` with the manifest — clones what's missing, fast-forwards clean checkouts, never touches dirty ones. |
| `awo remove <name>` | Unlink. |

**Work**

| Command | Purpose |
|---|---|
| `awo req new --title <t>` | Intake: the next `<KEY>-R#`. `--body-file` imports a ticket; `--proposed` skips refinement. |
| `awo req refine` · `propose` · `approve` · `reject` · `list` | Turn a wish into checkable criteria, then **a human accepts the terms**. `goal new` refuses anything unapproved. |
| `awo run --goal <id> [--until <task>] [--yolo]` | Work the plan in dependency order. Stops at the gate, on failure, and always on evidence needing a human. |
| `awo goal new --from <req>` | Turn a requirement into a goal, moving it in as `requirement.md`. |
| `awo goal list` · `goal trace` · `goal verify` · `goal verdict` | Progress · criterion coverage · assemble the QA gate · record its outcome. |
| `awo task new --goal <g> --name <n>` | The next `<KEY>-T#`, with `--targets`, `--depends-on`, `--agent`. |
| `awo task run <id> [--instruction <text>]` | Open a run: resolve dependencies, create the isolated worktree, resolve the model, and **record the brief the worker is given**. |
| `awo task dispatch <id>` | Open a run **and spawn** the resolved worker, blocking until it exits. |
| `awo task event <id> <kind>` | Record progress during a run. |
| `awo task evidence <id> --criterion <n> --kind <test\|manual\|exception> --ref <text>` | Trace task evidence to an acceptance criterion. |
| `awo task complete <id> --outcome <o>` | Close it. `--gate` routes success to review. |
| `awo task verify <id> [--reject]` | QA gate on one task. |
| `awo task recheck <id> --run <cmd>` | Attach real evidence to a task closed without any. Opens a new run; never rewrites the old one. |
| `awo log list` · `log show` · `log tail` · `log add` | Run history, filterable by task/agent/repo/status/tier/effort. |

**Pull requests**

| Command | Purpose |
|---|---|
| `awo pr preflight [--repo <repo>]` | Verify GitHub CLI authentication and linked-repository access. |
| `awo pr link <task> --repo <repo> --number <n>` · `pr status <task>` | Persist and refresh a task's live PR snapshot. |
| `awo pr reconcile <task>` | Create repair tasks for newly unresolved GitHub review threads. |
| `awo pr finalize <task> [--dry-run]` | Enforce merge policy; no AI approval, and merge only as an authorised maintainer. |

**Catalog and publishing**

| Command | Purpose |
|---|---|
| `awo agent add <name>` · `agent list` | Install an agent from `catalog/agents` (e.g. `data-engineer`). |
| `awo skill add <name>` · `skill list` | Install a skill from `catalog/skills`. |
| `awo publish [--dry-run]` | Push a projection to MongoDB for the hosted dashboard. Off unless credentials exist. |

## How work is organised

```
Requirement  →  Goal  →  Tasks  →  Runs → Logs
 (the ask)      (the       (executable   (what actually
                objective)  units)        happened)
```

```
requirements/<KEY>-R1.md              intake, until a goal is planned from it
goals/<KEY>-G1/goal.md                the objective and its definition of done
              /requirement.md         the ask it came from
              /tasks/<KEY>-T1.md      executable units
logs/<date>/runs.jsonl                every event + one row per run
logs/<date>/runs.md                   every run's record, one marked section each
logs/<date>/workers/                  raw worker output, when one was dispatched
```

Paths are named for **IDs, never titles** — an ID is permanent, so renaming a goal
never moves its directory.

A day of logs is **two files that grow**, not many that multiply. Every earlier
layout made the number of filesystem entries grow with the number of runs, which is
unreadable however you nest it. Per-run questions come from the data, not the tree:
`awo log list --task <KEY>-T2`, `awo log show <runId>`.

`runs.jsonl` is append-only — a line per event, written *during* the run, plus one
row per run at close. Not `.json`: a document has to be read-parse-rewritten to add
a row, so two workers finishing together would silently lose one. Worker output
stays in `workers/` because it is the spawned CLI's raw stdout — unbounded, and
interleaved nonsense if two workers shared a file.

Definitions are tracked markdown with YAML frontmatter. **State is separate**:
lifecycle status lives in a gitignored `state.json`, and each run appends to an
event stream plus a queryable index. A task's status (`todo · queued · running ·
blocked · in-review · done · cancelled`) is deliberately distinct from a run's
outcome (`success · failed · skipped`) — an item can be in review while its last
build failed.

## Two things it enforces, not just documents

**Isolation.** `awo task run` *creates* the task's `git worktree` under
`repos/.worktrees/<repo>/<taskId>` on `feature/<taskId>`, branched from the task's
dependency so a dependent task builds on its predecessor's commits, with the repo's
`node_modules` linked so tests can actually run.

**Evidence.** A task cannot close as `success` on a claim. `awo` runs the command
itself and records what happened:

```sh
awo task event SHOP-T3 test --run "npm test" --baseline
```

Exit code, duration and pass/fail counts go in the log; `--baseline` runs it again
at the branch point. Only a *measured* pass satisfies the gate — a `test` event you
typed is refused, with `--untested "<why>"` as the honest escape hatch.

This matters more than it sounds: published analysis of agent-authored test patches
found **~80% carry weak or no assertions** (existence checks, mock verification,
snapshots). "Tests passed" as prose is the weakest signal in the workflow.

**Attribution.** A failing test means the code is wrong *or* the test is wrong, and
`--baseline` decides which:

| baseline | now | diagnosis |
|---|---|---|
| fails | fails, no worse | `pre-existing` — not this task's defect |
| passes | fails | `regression` — this change broke it |
| — | fails, new tests added | `new-contract` — the acceptance criteria decide |
| passes | passes, but a test and its own code changed together | `test-and-code-changed` — **inconclusive** |

The last row cannot be settled by reading either file, so awo flags it and refuses
to let the task reach `done` without review. The tiebreak is the artefact that
predates both: the goal's acceptance criteria.

## Model tiering

Roles are all **workers**; the orchestrator is the session you talk to, not an entry
in `agents/`. A worker's tier follows the *kind of work*:

```jsonc
// .workspace/manifest.json
"models": {
  "orchestrator": { "runtime": "codex", "model": "gpt-5.6-sol" },
  "tiers": {
    "high":     { "runtime": "codex", "model": "gpt-5.6-sol",   "effort": "high" },
    "standard": { "runtime": "codex", "model": "gpt-5.6-terra", "effort": "medium" },
    "low":      { "runtime": "codex", "model": "gpt-5.6-luna",  "effort": "medium",
                  "fallback": { "runtime": "codex", "model": "gpt-5.6-terra" } }
  }
}
```

`awo task run` prints the resolved model and a ready-to-paste invocation; the run log
records tier, model, effort and attempts, so `awo log list --tier low --status failed`
answers whether a cheaper model is actually cheaper. Only `medium` and `high` effort
are selectable — `low` was removed after low-effort implementation produced defects a
high-effort review had to catch.

## Hosted dashboard

[`awo-dashboard`](https://github.com/supanut9/awo-dashboard) is a separate Next.js app
for workspaces that are **not** on your machine. A workspace opts in:

```sh
echo 'MONGO_URI=mongodb+srv://…' > .workspace/credentials/mongo.env   # gitignored
awo publish              # manual sync
awo publish --watch      # auto sync — pushes on every change, debounced
```

Local stays canonical; the push is an opt-in projection, never a mirror. `--watch` is
a separate watcher rather than a hook inside the commands, so nothing in `task run`
ever waits on the network.

Nothing needs provisioning — collections appear on first write and the indexes are
created on every publish. How much travels is your choice:

```jsonc
// .workspace/manifest.json — default is "summary"
"publish": { "detail": "full", "redact": { "prompts": false } }
```

`summary` sends statuses, counts and tier/effort only. `full` adds task bodies, the
goal's definition-of-done, the requirement behind it, and every run's record and event
stream — everything the local dashboard shows. It is opt-in because that prose
describes your code and your prompts.

## Customising it

The always-on rules, skills and agents lists in `AGENTS.md` are **generated** from
those directories, inside markers awo owns:

```
<!-- awo:generated rules -->
- `deploy-via-cloud-build` — deploys go through Cloud Build, never `gcloud run deploy`
<!-- /awo:generated -->
```

So adding a rule is dropping a file in `rules/` (or `awo rule new`) — nothing to
register. Write project conventions anywhere in `AGENTS.md` **outside** the markers:
`awo upgrade` keeps the pristine template at `.workspace/template-base/` and
three-way merges its changes around your edits. It only asks when the same lines
moved on both sides, and then `awo resolve` shows the diff and takes a side.

## Development

```sh
npm install
npm run build
npm test
npm link          # use your local build as the real `awo` command
```

## Releasing

```sh
npm version patch        # bumps, commits AND tags
git push --follow-tags
npm publish              # prepublishOnly builds, runs the suite, verifies the tarball
```

## Design

`PROJECT_PLAN.md` is the full design: locked architecture decisions (§3), workspace
anatomy (§4), the work hierarchy (§7.2), logs (§7.3), the status model (§7.4), the
local UI (§7.5), publishing (§7.6), versioning and upgrade (§11), model tiering
(§12), and session orientation (§13).

§9 is worth reading on its own: **50+ recorded findings** from actually using the
tool, each with what broke and what it taught. Most of the enforcement above exists
because something went wrong first.

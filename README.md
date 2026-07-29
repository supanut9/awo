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
awo goal new --from SHOP-R1              # requirement -> goal
awo task new --goal SHOP-G1 --name "Read endpoint" --targets my-api --agent software-engineer

awo task run SHOP-T1                     # opens the run, creates the worktree,
                                          # prints which model should do it
awo task event SHOP-T1 test --data '{"repo":"my-api","pass":42}'
awo task complete SHOP-T1 --outcome success --gate

awo goal verify SHOP-G1                   # assemble the QA gate for a high-tier review
awo goal verdict SHOP-G1 --pass --summary "meets the definition of done"

awo ui                                    # local dashboard on 127.0.0.1
```

## Commands

**Workspace**

| Command | Purpose |
|---|---|
| `awo init --key <KEY>` | Scaffold a workspace. `<KEY>` prefixes every ID and is permanent. |
| `awo context [--json]` | Compact orientation digest — run this first in a new session instead of scanning. |
| `awo doctor` | Version skew, broken links, bad targets, abandoned runs, work claimed without evidence. |
| `awo upgrade [--dry-run] [--force]` | Adopt the installed awo version: run migrations, reconcile scaffolding, never overwrite your edits. |
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
| `awo req new --title <t>` | Intake: the next `<KEY>-R#`. |
| `awo goal new --from <req>` | Turn a requirement into a goal, moving it in as `requirement.md`. |
| `awo goal list` · `goal verify` · `goal verdict` | Progress · assemble the QA gate · record its outcome. |
| `awo task new --goal <g> --name <n>` | The next `<KEY>-T#`, with `--targets`, `--depends-on`, `--agent`. |
| `awo task run <id>` | Open a run: resolve dependencies, create the isolated worktree, resolve the model. |
| `awo task dispatch <id>` | Open a run **and spawn** the resolved worker, blocking until it exits. |
| `awo task event <id> <kind>` | Record progress during a run. |
| `awo task complete <id> --outcome <o>` | Close it. `--gate` routes success to review. |
| `awo task verify <id> [--reject]` | QA gate on one task. |
| `awo log list` · `log show` · `log tail` · `log add` | Run history, filterable by task/agent/repo/status/tier/effort. |

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
logs/index.jsonl                      queryable index of every run
logs/<date>/<KEY>-T1/<time>/          one directory per run:
    record.md · events.jsonl · worker.log
logs/<date>/<KEY>-G1/<time>/brief.md  each QA gate the goal went through
```

Paths are named for **IDs, never titles** — an ID is permanent, so renaming a goal
never moves its directory. Runs shard by **day first, then by the task they belong
to**, so browsing is chronological and a day's directory holds only that day's
work. Per-task questions come from the index: `awo log list --task <KEY>-T2`.

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

**Evidence.** A task cannot close as `success` without a `test` event in its run —
or `--untested "<why>"`, which is recorded in the log. This exists because six
tasks once each "passed" and composed into a broken feature.

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

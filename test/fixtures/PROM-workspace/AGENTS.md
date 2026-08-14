# AGENTS.md — PROM workspace

> Canonical instructions for every AI agent working in this workspace.
> `CLAUDE.md` and `GEMINI.md` import this file — edit here, not there.

## Project
- **Key:** `PROM`
- **Type:** AWO orchestration workspace (multi-repo)

## Start here in a new session
Run **`awo context`** first. It prints, in ~20 lines: the project and its linked
repos, every goal with its progress, which tasks are blocked or running and why,
requirements still in intake, the last few runs, and **what to do next**.

Do not scan the tree to work this out — that costs tokens and gets it wrong. The
digest is derived fresh from the manifest, `state.json` and the run index every
time, so it cannot be stale. For the full history use `awo log list`; for one run
use `awo log show <runId>`.

## How work is organized
Work flows down a hierarchy: **Requirement → Goal → Tasks**. Each level is a
markdown file with YAML frontmatter. IDs are project-key prefixed:
`PROM-R#` (requirement), `PROM-G#` (goal), `PROM-T#` (task) —
and an ID is permanent, which is why paths are named for IDs and never for titles:

```
requirements/PROM-R1.md          intake, not yet planned
requirements/archive/PROM-R2.md  suspended, cancelled or rejected
goals/PROM-G1/goal.md            the objective and its definition of done
                    /requirement.md         the ask it came from
                    /tasks/PROM-T1.md   executable units
logs/<date>/runs.jsonl                      every event + one row per run
logs/<date>/runs.md                         every run's record, one section each
logs/<date>/workers/                        raw worker output, when dispatched
```

**See `instructions/full-workflow.md` for the canonical end-to-end sequence**
— intake → plan → build & ship (per task) → QA gate → done.

## PR control loop
Before working a pull request, run `awo pr preflight --repo <repo>`. Link it to
the implementation task with `awo pr link <task> --repo <repo> --number <n>`.
Use `awo pr reconcile <task>` after every review/check cycle; it snapshots the
live PR and creates focused repair tasks for unresolved review threads. Record
acceptance-criterion evidence with `awo task evidence` and inspect coverage with
`awo goal trace`. Finish only through `awo pr finalize <task>`: it never approves
a PR and applies the configured merge policy.

## Adding your own
Drop a file in the directory and awo picks it up — the lists below are generated
from `rules/`, `skills/` and `agents/`, so there is nothing to register:

- **a rule** (always-on policy) → `rules/<id>.md`, or `awo rule new <id>`
- **a skill** (an invokable procedure) → `skills/<id>.md`
- **a role** → `agents/<id>.md`, or `awo agent add <name>` from the catalog
- **workflow glue** → `instructions/<name>.md`
- **project conventions** → anywhere in this file OUTSIDE the generated markers.
  `awo upgrade` merges template changes around your edits; it only asks when the
  same lines changed on both sides.

Each file needs `id:` and `summary:` in its frontmatter — `summary` is the line that
appears in the generated list.

## Scaffolding primitives
- **rules/** — always-on policy you MUST follow (not invoked; ambient).
- **skills/** — invokable procedures ("how to …").
- **agents/** — roles that use skills, obey rules, and are granted connectors.
- **instructions/** — workflow glue that sequences the above for a situation.
- **connectors** — external systems (declared in `.workspace/connectors.json`).

## Always-on rules (apply to all work)
<!-- awo:generated rules -->
- `acceptance-criteria-required` — a goal needs QA sign-off, not just passing tasks, before `done`.
- `conventional-commits` — commit messages follow Conventional Commits.
- `evidence-not-claims` — never write "the suite passes"; have awo run it with `awo task event <id> test --run "<cmd>" --baseline`. Only a measured pass closes a task.
- `human-approval-required` — AI never approves a PR; merge authority follows `pullRequests.mergePolicy` and GitHub's required checks/reviews.
- `isolate-task-worktrees` — concurrent tasks on the same repo never share a working tree.
- `no-push-to-main` — never commit/push directly to `main`; use a PR.
- `pick-reasoning-effort` — match thinking budget to the work; `medium` is the default.
- `pr-requirements` — every PR needs description, testing section, linked task.
- `record-every-run` — every piece of work leaves a log entry; non-task work uses `awo log add`.
- `stay-in-scope` — only touch repos declared as a task's `targets`.
- `tests-must-pass` — a task/PR can't proceed with failing or unverified tests.
<!-- /awo:generated -->

## Choosing a role — you usually don't need to be told
Every artifact already says who owns the work. Adopt the role yourself, in this
order of precedence:

1. **A task's `agent:` frontmatter wins.** Working `PROM-T#` with
   `agent: data-engineer` means you are `data-engineer` for that task, whatever
   the instruction's default owner says.
2. **Otherwise, the instruction's `owner:` frontmatter.** Following
   `plan-a-goal` means you are `tech-lead`.
3. **Otherwise, infer from the ID type**: `PROM-R#` → `product-manager`,
   `PROM-G#` → `tech-lead`, `PROM-T#` → `software-engineer`.
4. **Only if none of those apply, ask** which role is intended — don't silently
   act as a generalist, because that is how rules get skipped.

Read that role's file in `agents/` before acting, and stay inside its
boundaries. A human naming a role explicitly always overrides the above.

## Available skills
<!-- awo:generated skills -->
- `create-commit` — stage + commit with a conventional message.
- `create-task-worktree` — give a task its own isolated git worktree + branch.
- `file-bug` — turn a QA-found gap into a new requirement.
- `open-pr` — branch, push, open a PR from the template.
- `refine-requirement` — turn a raw ask into a clear, scoped requirement.
- `resolve-pr` — address review feedback, then follow configured merge authority.
- `run-tests` — run each target repo's declared test command; report pass/fail.
- `sync-repos` — reconcile `repos/` with the manifest before starting work.
- `verify-acceptance-criteria` — check a goal's definition-of-done as a whole.
<!-- /awo:generated -->

## Agents
<!-- awo:generated agents -->
- `code-reviewer` — reviews PRs and reports readiness; it never approves.
- `product-manager` — owns intake: raw ask → refined requirement → goal.
- `qa-engineer` — verifies a goal's definition-of-done as a whole; files gaps as new requirements.
- `release-engineer` — takes a verified task through its configured PR outcome.
- `software-engineer` — writes the code for a task and verifies it via tests.
- `tech-lead` — decomposes a goal into runnable tasks.
<!-- /awo:generated -->

> This is the **default baseline** installed at init — domain-agnostic, just
> enough for the link → plan → work → ship loop to function. Anything
> project-specific (a deploy skill, a specialized agent, a new rule) is added
> later via `awo skill new`, `awo rule new`, `awo agent new`, or pulled from
> the library's catalog via `awo skill add <name>` / `awo rule add <name>`.

## Configuration is workspace-local — never in `$HOME`
Every command (`awo skill add`, `awo agent add`, `awo goal new`, `awo task run`,
…) reads and writes **only inside this workspace directory**. Nothing lands in
`~/.config/awo/`, `~/.awo/`, or any machine-global path. If an agent runtime
(Claude Code, Gemini CLI, etc.) invokes `awo`, all resulting state changes
appear here — clone this workspace on another machine and it behaves
identically.

The one exception is connector credentials (MCP tokens, API keys), which
can't be tracked in git. They live in `.workspace/credentials/` (gitignored)
— still workspace-local in **location**, just per-machine in **provisioning**.

## Working repos
Linked repos live in `repos/` (gitignored). The **manifest is the source of
truth** — `repos/` is reconstructed from it via `awo sync`. Do not assume
`repos/` contents travel with this workspace.

## Connectors
Declared in `.workspace/connectors.json`. Agents receive least-privilege access.
Credentials are per-machine and never committed.

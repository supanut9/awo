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
goals/PROM-G1/goal.md            the objective and its definition of done
                    /requirement.md         the ask it came from
                    /tasks/PROM-T1.md   executable units
logs/<date>/runs.jsonl                      every event + one row per run
logs/<date>/runs.md                         every run's record, one section each
logs/<date>/workers/                        raw worker output, when dispatched
```

**See `instructions/full-workflow.md` for the canonical end-to-end sequence**
— intake → plan → build & ship (per task) → QA gate → done.

## Scaffolding primitives
- **rules/** — always-on policy you MUST follow (not invoked; ambient).
- **skills/** — invokable procedures ("how to …").
- **agents/** — roles that use skills, obey rules, and are granted connectors.
- **instructions/** — workflow glue that sequences the above for a situation.
- **connectors** — external systems (declared in `.workspace/connectors.json`).

## Always-on rules (apply to all work)
- `conventional-commits` — commit messages follow Conventional Commits.
- `no-push-to-main` — never commit/push directly to `main`; use a PR.
- `pr-requirements` — every PR needs description, testing section, linked task.
- `human-approval-required` — AI never approves a PR; merge authority follows
  `pullRequests.mergePolicy` and GitHub's required checks/reviews.
- `stay-in-scope` — only touch repos declared as a task's `targets`.
- `isolate-task-worktrees` — concurrent tasks on the same repo never share a working tree.
- `tests-must-pass` — a task/PR can't proceed with failing or unverified tests.
- `evidence-not-claims` — never write "the suite passes"; have awo run it with
  `awo task event <id> test --run "<cmd>" --baseline`. Only a measured pass closes a task.
- `acceptance-criteria-required` — a goal needs QA sign-off, not just passing tasks, before `done`.
- `record-every-run` — every piece of work leaves a log entry; non-task work uses `awo log add`.
- `pick-reasoning-effort` — match thinking budget to the work; `medium` is the default.

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
- `refine-requirement` — turn a raw ask into a clear, scoped requirement.
- `create-commit` — stage + commit with a conventional message.
- `open-pr` — branch, push, open a PR from the template.
- `resolve-pr` — address review feedback, then follow configured merge authority.
- `sync-repos` — reconcile `repos/` with the manifest before starting work.
- `create-task-worktree` — give a task its own isolated git worktree + branch.
- `run-tests` — run each target repo's declared test command; report pass/fail.
- `verify-acceptance-criteria` — check a goal's definition-of-done as a whole.
- `file-bug` — turn a QA-found gap into a new requirement.

## Agents
- `product-manager` — owns intake: raw ask → refined requirement → goal.
- `tech-lead` — decomposes a goal into runnable tasks.
- `software-engineer` — writes the code for a task and verifies it via tests.
- `qa-engineer` — verifies a goal's definition-of-done as a whole; files gaps as new requirements.
- `release-engineer` — takes a verified task through its configured PR outcome.
- `code-reviewer` — reviews PRs and reports readiness; it never approves.

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

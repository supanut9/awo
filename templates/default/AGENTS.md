# AGENTS.md — {{PROJECT_KEY}} workspace

> Canonical instructions for every AI agent working in this workspace.
> `CLAUDE.md` and `GEMINI.md` import this file — edit here, not there.

## Project
- **Key:** `{{PROJECT_KEY}}`
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
`{{PROJECT_KEY}}-R#` (requirement), `{{PROJECT_KEY}}-G#` (goal), `{{PROJECT_KEY}}-T#` (task) —
and an ID is permanent, which is why paths are named for IDs and never for titles:

```
requirements/{{PROJECT_KEY}}-R1.md          intake, not yet planned
goals/{{PROJECT_KEY}}-G1/goal.md            the objective and its definition of done
                    /requirement.md         the ask it came from
                    /tasks/{{PROJECT_KEY}}-T1.md   executable units
logs/<date>/runs.jsonl                      every event + one row per run
logs/<date>/runs.md                         every run's record, one section each
logs/<date>/workers/                        raw worker output, when dispatched
```

**See `instructions/full-workflow.md` for the canonical end-to-end sequence**
— intake → plan → build & ship (per task) → QA gate → done.

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
<!-- /awo:generated -->

## Choosing a role — you usually don't need to be told
Every artifact already says who owns the work. Adopt the role yourself, in this
order of precedence:

1. **A task's `agent:` frontmatter wins.** Working `{{PROJECT_KEY}}-T#` with
   `agent: data-engineer` means you are `data-engineer` for that task, whatever
   the instruction's default owner says.
2. **Otherwise, the instruction's `owner:` frontmatter.** Following
   `plan-a-goal` means you are `tech-lead`.
3. **Otherwise, infer from the ID type**: `{{PROJECT_KEY}}-R#` → `product-manager`,
   `{{PROJECT_KEY}}-G#` → `tech-lead`, `{{PROJECT_KEY}}-T#` → `software-engineer`.
4. **Only if none of those apply, ask** which role is intended — don't silently
   act as a generalist, because that is how rules get skipped.

Read that role's file in `agents/` before acting, and stay inside its
boundaries. A human naming a role explicitly always overrides the above.

## Available skills
<!-- awo:generated skills -->
<!-- /awo:generated -->

## Agents
<!-- awo:generated agents -->
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

# PROM workspace

An **awo** orchestration workspace, created with `awo init --key PROM`. It does
**not** contain product code; it links to the repos that do, and holds how agents
work on them.

Start a session with **`awo context`** — it prints where things stand and what to do
next, so you don't spend tokens scanning the tree.

## Layout
- `AGENTS.md` — canonical instructions. `CLAUDE.md` / `GEMINI.md` are thin pointers to it.
- `agents/` — the roles. Each declares its skills, rules and model `tier`.
- `rules/` — always-on policy. Not invoked; ambient.
- `skills/` — invokable procedures ("how to …").
- `instructions/` — workflow glue; `full-workflow.md` is the master sequence.
- `goals/` — the work hierarchy (Requirement → Goal → Tasks), populated by the commands below.
- `catalog/` — extra agents/skills shipped but **not installed**; add one with `awo agent add <name>`.
- `repos/` — linked working repos (gitignored). Task worktrees live under `repos/.worktrees/<repo>/<taskId>/`.
- `logs/` — the audit trail (gitignored): `runs.jsonl` index, per-run `.md`, per-run `.events.jsonl`.
- `.workspace/manifest.json` — the single source of truth for repos, model policy and version.

## Common commands

| Command | Does |
|---|---|
| `awo context` | Where things stand, and the next step. Run it first. |
| `awo add <url>` / `awo connect <path>` | Link a working repo (git / local). |
| `awo sync` | Reconcile `repos/` with the manifest. |
| `awo list` / `awo doctor` | Repo status / diagnose drift and unfinished work. |
| `awo req new --title "…"` | Intake: creates `PROM-R#`. |
| `awo goal new --from PROM-R#` | Distil a requirement into a goal. |
| `awo task new --goal PROM-G# --name "…" --targets <repo>` | Add a task; allocates `PROM-T#`. |
| `awo task run PROM-T#` | Open a run: creates the worktree, prints the model to use. |
| `awo task event PROM-T# test --data '{"repo":"…","pass":42}'` | Record what ran. |
| `awo task complete PROM-T# --outcome success --gate` | Close it for review. |
| `awo goal verify PROM-G#` → `awo goal verdict … --pass\|--gap` | The QA gate, and its outcome. |
| `awo log list [--tier low] [--status failed]` | Run history. |
| `awo ui` | Local dashboard on 127.0.0.1. |

## Two rules worth knowing before you start
- **A task cannot close as `success` without a `test` event** — or `--untested "<why>"`,
  which goes in the log. Individually passing tasks are not evidence that a feature works.
- **Work happens in the task's worktree**, never in `repos/<name>` directly. `awo task run`
  creates it and tells you the path.

Nothing here reads or writes outside this directory. Connector credentials are the one
exception and live in `.workspace/credentials/` (gitignored, per-machine).

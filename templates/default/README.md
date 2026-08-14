# {{PROJECT_KEY}} workspace

An **awo** orchestration workspace, created with `awo init --key {{PROJECT_KEY}}`. It does
**not** contain product code; it links to the repos that do, and holds how agents
work on them.

Start a session with **`awo context`** — it prints where things stand and what to do
next, so you don't spend tokens scanning the tree.

## Layout
- `AGENTS.md` — canonical instructions. `CLAUDE.md` / `GEMINI.md` are thin pointers to it.
- `agents/` — the roles. Each declares its skills, rules and model `tier`.
- `rules/` — always-on policy. Not invoked; ambient.
- `skills/` — invokable procedures ("how to …").
- `instructions/` — workflow glue; `full-workflow.md` is the master sequence,
  and `pm-to-pr.md` is the PM request to human-approved PR playbook.
- `requirements/` — intake: `<KEY>-R#.md`, until a goal is planned from it.
  `requirements/archive/` holds the ones nobody intends to build now — suspended,
  cancelled or rejected. The status decides the directory, so intake stays a list
  of what is actually wanted. Ids are never reused, wherever the file sits.
- `goals/` — one directory per goal (`goals/<KEY>-G#/`), holding `goal.md`, the
  `requirement.md` it came from, and `tasks/<KEY>-T#.md`.
- `catalog/` — extra agents/skills shipped but **not installed**; add one with `awo agent add <name>`.
- `repos/` — linked working repos (gitignored). Task worktrees live under `repos/.worktrees/<repo>/<taskId>/`.
- `logs/` — the audit trail (gitignored): each day has `runs.jsonl` (events and
  completed-run rows), `runs.md` (readable records), and optional `workers/` output.
- `.workspace/manifest.json` — the single source of truth for repos, model policy and version.

## Common commands

| Command | Does |
|---|---|
| `awo context` | Where things stand, and the next step. Run it first. |
| `awo add <url>` / `awo connect <path>` | Link a working repo (git / local). |
| `awo sync` | Reconcile `repos/` with the manifest. |
| `awo list` / `awo doctor` | Repo status / diagnose drift and unfinished work. |
| `awo req new --title "…"` → `req refine` → `req propose` → `req approve` | Intake: capture and human-approve `{{PROJECT_KEY}}-R#`. |
| `awo req suspend {{PROJECT_KEY}}-R# --why "…"` / `req cancel … --why "…"` | Park it, or drop it. Both move the file to `requirements/archive/`. |
| `awo req resume {{PROJECT_KEY}}-R#` | Bring a shelved requirement back into intake, at the status it left from. |
| `awo req list [--all\|--archived]` | Intake by default; the shelved ones on request. |
| `awo goal new --from {{PROJECT_KEY}}-R#` | Distil an approved requirement into a goal. |
| `awo goal plan {{PROJECT_KEY}}-G#` | Brief the tech-lead to decompose it — in plan mode, so you approve the breakdown before any task exists. |
| `awo task new --goal {{PROJECT_KEY}}-G# --name "…" --targets <repo>` | Add a task; allocates `{{PROJECT_KEY}}-T#`. |
| `awo task run {{PROJECT_KEY}}-T#` | Open a run: creates the worktree, prints the model to use. |
| `awo task event {{PROJECT_KEY}}-T# test --data '{"repo":"…","pass":42}'` | Record what ran. |
| `awo task complete {{PROJECT_KEY}}-T# --outcome success --gate` | Close it for review. |
| `awo task evidence {{PROJECT_KEY}}-T# --criterion 1 --kind test --ref "<run or command>"` | Trace task evidence to an acceptance criterion. |
| `awo goal trace {{PROJECT_KEY}}-G#` | Show criterion coverage and any accepted exceptions. |
| `awo goal verify {{PROJECT_KEY}}-G#` → `awo goal verdict … --pass\|--gap` | The QA gate, and its outcome. |
| `awo pr preflight [--repo <repo>]` | Confirm `gh` authentication and repository access before PR work. |
| `awo pr link {{PROJECT_KEY}}-T# --repo <repo> --number <n>` | Persist the task-to-PR link and live GitHub snapshot. |
| `awo pr reconcile {{PROJECT_KEY}}-T#` | Refresh checks/reviews and create repair tasks for new review threads. |
| `awo pr finalize {{PROJECT_KEY}}-T#` | Apply `pullRequests.mergePolicy`; never approves a PR. |
| `awo log list [--tier low] [--status failed]` | Run history. |
| `awo worktree list` / `awo worktree prune` | Task checkouts on disk / remove the finished ones. |
| `awo ui` | Local dashboard on 127.0.0.1. |

## Two rules worth knowing before you start
- **A task cannot close as `success` without a `test` event** — or `--untested "<why>"`,
  which goes in the log. Individually passing tasks are not evidence that a feature works.
- **Work happens in the task's worktree**, never in `repos/<name>` directly. `awo task run`
  creates it and tells you the path.
- **AI stops at a review-ready PR.** It may open and fix a PR, but a human must
  approve it. An authorised maintainer may merge only when
  `pullRequests.mergePolicy` permits it and GitHub's requirements pass
  (`rules/human-approval-required.md`).

Nothing here reads or writes outside this directory. Connector credentials are the one
exception and live in `.workspace/credentials/` (gitignored, per-machine).

# awo — AI Workflow Orchestration Library — Project Plan

> **Name:** `awo` (locked) · **npm package:** `@supanut9/awo` (unscoped `awo` was taken — see §9 item 1) · **Distribution:** npm (`npx @supanut9/awo …`), binary is `awo`

---

## 0. Start here (for a fresh Claude Code session picking this up)

If you're reading this because you've been asked to build `awo`, stop before touching code and read this section end-to-end. The plan is long because the *design* is done; your job is implementation, and most of what could go wrong at this stage is doing too much, not too little.

**What exists already**
- This document — the complete spec.
- `PROM-workspace/` (also shipped as `PROM-workspace.zip`) — a **fully hand-built reference of what `awo init --key PROM` must produce**. Every file, every folder, every piece of frontmatter. Treat it as the acceptance criterion for `init`, not a suggestion.

**Your first and only initial target: the `init` command.**
Not the whole CLI. Not the req→goal→task pipeline. Not the log runner. Just `init`. The success condition is:

> `npx @supanut9/awo init --key PROM` in an empty directory produces a tree that matches `PROM-workspace/` **byte-for-byte** (with the project key substituted in the manifest and any templated locations).

Write an integration test that runs `init` into a temp directory and diffs against the reference. If that test passes, ship v0.0.1 and *stop*, so the tool can be tried on a real project before more surface area is committed to (§8).

**What NOT to do on the first pass**
- Do not implement `add`, `connect`, `sync`, the pipeline commands, or the log runner. They are fully specified below, but building them before `init` has been used on a real project is exactly the paper-design trap §8 was reframed to avoid.
- Do not invent new agents, skills, rules, or catalog entries. The reference workspace is the complete default set.
- Do not fetch the workspace template from a remote registry. **The template ships embedded inside the npm package** at `templates/default/` and is copied on `init` — this keeps `init` offline-friendly and version-locked (§10).
- Do not read config from `~` or any machine-global path (§3, decision 7). Ever. Every path resolves relative to the workspace.
- Do not build the UI (§7.5) or publishing (§7.6). They are fully designed and explicitly Phase 2/3. The *only* parts of the visibility work that belong in Phase 1 are the status model and event format (§7.4) and the `workspaceId` field (§5) — because those are data formats every later reader depends on, not features. Neither requires a server, a browser, or a network call.

**Which sections are most important for implementation**
- **§3** — the seven locked architecture decisions. These are non-negotiable; do not "improve" them.
- **§4** — the exact workspace anatomy `init` must produce. Cross-reference against `PROM-workspace/`; if they disagree, the zip wins (see the reconciliation note at the end of §4).
- **§5** — the manifest schema, including the `projectKey` substitution `init` must perform.
- **§10** — implementation notes: language, libraries, template-copy approach, how to locate the workspace root.

Everything else (§6–§7, §9) is context for what comes *after* `init` works.

---

## 1. Vision

A reusable library that **scaffolds and orchestrates AI-agent development environments**. Think `create-react-app` / cookiecutter, but the domain is *how agents work on your code*, not the app code itself.


Running the library `init`s a **workspace repo**: an orchestration hub that carries the agent scaffolding (instructions, rules, agents, skills, standards) and **links to one or more working repos** where the real code lives. Every new project starts from the same battle-tested setup instead of being hand-rolled.

**Value proposition:** consistency + reuse + multi-repo coordination from a single source of truth.

---

## 2. Core Concepts

| Term | What it is |
|------|-----------|
| **Library** (`awo`) | The npm package: template + generator + CLI. The thing you install. |
| **Workspace repo** | An instantiated orchestration layer. Holds AGENTS.md scaffolding + the manifest. Can live purely local, or be pushed to GitHub. Does **not** contain product code. |
| **Working repo** | An actual codebase the agents operate on. Linked into the workspace, never owned by it. |
| **Manifest** | `.workspace/manifest.json` — the **single source of truth** for what's linked and how. Everything else (clones, symlinks) is derived from it. |

Mental model: **library = template + generator**, **workspace = orchestration layer**, **working repos = the code agents act on**.

**One workspace holds exactly one project.** The two words describe the same thing from different angles — *workspace* is the tree on disk, *project* is the human concept it represents. There is no `projects/` folder and never will be: seeing many projects at once is an **aggregation concern** solved in the reader (§7.5), not a nesting concern solved in the tree. See §7.5 for why, and for the test that decides whether a new body of work is a fresh `awo init` or just another goal.

---

## 3. Architecture Decisions (locked for v1)

These are settled. Recorded here as a lightweight decision log so we don't relitigate them.

1. **Manifest is the single source of truth.** Symlinks and clones are disposable artifacts *derived* from the manifest, not tracked directly. This is what lets one model support both local and shareable workspaces.

2. **Two link types, unified by the manifest:**
   - `type: "git"` → has a URL + ref; `sync` clones/pulls into `repos/<name>`.
   - `type: "local"` → has a filesystem path; `connect` symlinks into `repos/<name>`.

3. **Working repos live *inside* the workspace** at `repos/`, which is **gitignored**. Consequence: nested git repos — harmless once ignored, noted for awareness. What travels when you push the workspace is the scaffolding + manifest only; never working-repo contents, never fragile symlinks.

4. **Frozen at init.** A workspace does not auto-pull library updates. The manifest records `libraryVersion`, and **§11 now specifies the `awo upgrade` path that door was left open for** — explicit and reviewable, never an automatic rewrite on the next `npx`. Frozen-by-default is what keeps a workspace reproducible across machines and keeps an agent from having its rules changed mid-run.

5. **`AGENTS.md` is canonical.** Other agent files (`CLAUDE.md`, `GEMINI.md`, etc.) are thin pointers that import it (e.g. `@AGENTS.md`) rather than duplicating content. Adding support for a new agent = adding one more pointer file, never re-authoring instructions.

6. **Distribution: npm package**, invoked via `npx @supanut9/awo <command>`. The `bin` entry keeps the **command** `awo` regardless of the package name, so the scope affects only the install string.

7. **Workspace-local config only — nothing in `~`.** Every read and write done by any `awo` command — whether invoked by a human, Claude Code, Gemini CLI, or any other agent — resolves paths relative to the current workspace directory (`process.cwd()` walking up to the nearest `.workspace/`), never `$HOME`, never `$XDG_CONFIG_HOME`, never a global cache. Adding a skill, defining an agent, refining a requirement, running a task — all of it lands inside the workspace tree. Consequences:
   - `git clone <workspace>` on any machine is a **complete restore**; there is no per-user setup to reproduce.
   - Two agent runtimes (Claude Code and Gemini CLI, say) working the same workspace see identical state, because `AGENTS.md` and every scaffolding file *is* the state.
   - **One narrow exception (a):** connector credentials (MCP tokens, API keys) genuinely can't be tracked in git and must be supplied per machine. They still live *inside the workspace* — under `.workspace/credentials/` — but that path is gitignored. So credentials are workspace-local in **location** (nothing in `~`) but machine-specific in **provisioning** (must be re-supplied on a fresh clone). This is the same tracked-vs-secret split already used for `repos/`, `logs/`, and task `state.json` — never a different pattern.

8. **Local is canonical; any remote is an opt-in push, never a mirror.** The workspace on disk is the only authoritative store of state. A workspace may *publish a projection* of its state to a remote service (§7.6) so a hosted dashboard can show it, but:
   - **Never dual-write.** No command writes local and remote as peers. Local write commits first; the remote copy is derived, lossy, and always allowed to lag.
   - **Never blocking.** A failed, slow, or unconfigured publish must never fail, delay, or alter a task run. Publishing goes through an outbox (§7.6) and is free to be offline for a week.
   - **Off by default.** No credentials present → no network traffic, no account, no telemetry. `init` never provisions a remote.
   - **A projection, not the files.** Statuses and counts travel; markdown bodies, prompts, and file paths do not unless explicitly enabled.

   Rationale: two sources of truth means neither is trusted. A status board that is occasionally stale is worse than no board, because its entire value is that you can believe it without cross-checking. This decision is what lets §3.1 and §3.7 survive contact with a hosted UI.

---

## 4. Workspace Anatomy

This is the actual structure produced by `awo init --key PROM` — regenerated from the simulated `PROM-workspace/` reference build, not an idealized sketch. `goals/`, `logs/`, and `repos/` are empty at init (shown here populated, to illustrate their shape once work begins).

```
PROM-workspace/
├── README.md                  # orientation: layout + common commands
├── AGENTS.md                  # canonical agent instructions (source of truth)
├── CLAUDE.md                  # thin pointer → @AGENTS.md
├── GEMINI.md                  # thin pointer → @AGENTS.md
├── .gitignore                 # ignores repos/, logs/, **/state.json, credentials
│
├── agents/                    # installed by default — 6 roles, full lifecycle
│   ├── product-manager.md     #   intake: raw ask → refined requirement → goal
│   ├── tech-lead.md           #   decomposes a goal into tasks
│   ├── software-engineer.md   #   implements a task, runs tests
│   ├── qa-engineer.md         #   verifies the goal as a whole; files gaps
│   ├── release-engineer.md    #   commits, opens PR, ships, cleans up worktree
│   └── code-reviewer.md       #   reviews PRs before merge
│
├── skills/                    # installed by default — 9 invokable procedures
│   ├── refine-requirement.md
│   ├── create-commit.md
│   ├── open-pr.md
│   ├── resolve-pr.md
│   ├── sync-repos.md
│   ├── create-task-worktree.md
│   ├── run-tests.md
│   ├── verify-acceptance-criteria.md
│   └── file-bug.md
│
├── rules/                     # installed by default — 8 always-on policies
│   ├── conventional-commits.md
│   ├── no-push-to-main.md
│   ├── pr-requirements.md
│   ├── stay-in-scope.md
│   ├── isolate-task-worktrees.md
│   ├── tests-must-pass.md
│   └── acceptance-criteria-required.md
│
├── instructions/               # installed by default — 4 sequencing files
│   ├── full-workflow.md        #   the master sequence (stages below are its steps)
│   ├── capture-requirement.md  #   stage 1: intake
│   ├── plan-a-goal.md          #   stage 2: goal → tasks
│   └── ship-a-change.md        #   stage 3: per-task build → ship
│
├── catalog/                    # shipped with the library, NOT installed by default
│   ├── agents/
│   │   ├── data-engineer.md         #   entities, DAL, migrations
│   │   ├── marketing-specialist.md  #   GTM plans, tagging
│   │   └── audit.md                 #   compliance/traceability, read-only
│   └── skills/
│       ├── define-entity-schema.md
│       ├── write-migration.md
│       ├── define-gtm-plan.md
│       ├── implement-tracking-tags.md
│       └── review-logs.md
│
├── goals/                     # empty at init; populated by `awo goal new`
│   └── PROM-G1-sso-login/     #   one folder per goal (id-prefixed)
│       ├── requirement.md    #     the ask, refined
│       ├── goal.md           #     objective + definition-of-done + scope
│       └── tasks/
│           ├── PROM-T1-….md  #       decomposed executable tasks
│           └── state.json    #       status of this goal's tasks (gitignored)
│
├── logs/                      # empty at init, GITIGNORED; populated by task runs
│   ├── runs.jsonl             #   query index — one line per run
│   └── runs/                 #   per-run detail, sharded by date
│       └── 2026-07-21/       #     one folder per day
│           ├── <runId>.md    #       one file per run (md + frontmatter), written at end
│           └── <runId>.events.jsonl  #  live progress stream, appended during the run (§7.4)
│
├── repos/                      # empty at init, GITIGNORED; populated by add/connect + sync
│   ├── frontend-app/         #   (git-type, cloned) — the shared checkout
│   ├── shared-lib/           #   (local-type, symlinked)
│   └── .worktrees/           #   per-task isolation (git worktree)
│       └── frontend-app/
│           ├── PROM-T1/      #     task's own worktree + branch
│           └── PROM-T5/      #     a concurrent task, fully isolated
│
└── .workspace/
    ├── manifest.json          # single source of truth (repos, projectKey, testCommand)
    ├── connectors.json        # declared MCP/connectors (tracked; auth kept separate)
    ├── outbox/                # GITIGNORED, Phase 3 only — unflushed remote projections (§7.6)
    └── credentials/           # GITIGNORED — per-machine tokens/keys for connectors
        ├── github.env         #   (example) supplied fresh on each machine
        └── publish.env        #   Phase 3 only — scoped publish token; absent = no publishing
```

**Reconciling with the reference build:** the `PROM-workspace.zip` simulation shared earlier in this conversation is the source of truth for this tree — if the two ever drift, regenerate this section from the zip rather than hand-editing both.

---

## 5. Manifest Schema (draft)

```jsonc
{
  "libraryVersion": "0.1.0",       // what the workspace was frozen at
  "workspaceId": "019f981d-4820-72d5-a239-18accffa5c43",  // uuid v7, generated at init, permanent
  "projectKey": "PROM",            // short, permanent project code (uppercase, 2-5 chars)
  "projectName": "Promotion Campaign 2026",   // human-readable name
  "createdAt": "2026-07-21T00:00:00Z",
  "repos": [
    {
      "name": "frontend-app",
      "type": "git",
      "url": "https://github.com/acme/frontend-app.git",
      "ref": "main",
      "testCommand": "npm test"        // used by the run-tests skill
    },
    {
      "name": "shared-lib",
      "type": "local",
      "path": "/Users/me/dev/shared-lib",   // machine-specific, reconnect on other machines
      "testCommand": "pytest"
    }
  ]
}
```

**`workspaceId` vs `projectKey` — two identities, on purpose.** `projectKey` is the *human-facing* ID prefix, and it is only guaranteed unique across **one user's** projects — two unrelated users will both pick `PROM`. `workspaceId` is the *machine* identity: a **uuid v7** generated once by `init`, never displayed, never reused. Any shared store keys on `(ownerId, workspaceId)`, never on `projectKey` (§7.6). This field costs nothing today and cannot be retrofitted cheaply once workspaces exist in the wild — so `init` writes it from v0.0.1 even though nothing reads it until Phase 3.

**Why v7 rather than v4.** v7 embeds a 48-bit millisecond timestamp in its high bits, which makes it *k-sortable*: IDs generated later sort later as plain strings. Three consequences that matter here — (a) a remote store (§7.6) gets locality instead of a uniformly-random primary key, so index writes append to the hot end of the B-tree rather than scattering across it; (b) `ORDER BY workspaceId` is effectively "oldest workspace first", so creation order survives without a join to `createdAt`; (c) a portfolio listing (§7.5) has a stable, meaningful default sort for free. It stays fully random in the low bits, so it leaks nothing beyond the creation time already published in `createdAt`. Node's `crypto.randomUUID()` only emits v4, so this needs the `uuid` package (§10).

Design notes: `git` entries fully reconstitute on a fresh clone via `sync`; `local` entries are understood to be machine-specific and are reconnected per-machine. `projectKey` is set at `init` and treated as **permanent** — it prefixes every requirement/goal/task ID, so changing it later would break existing references (Jira-key semantics). `testCommand` is optional per repo; the `run-tests` skill (§7.1) uses it and flags any target repo that omits it as unverified rather than silently passing.

---

## 6. CLI Surface

**Phase 1 — MVP (scaffolding + linking)**

| Command | Purpose |
|---------|---------|
| `awo init --key PROM` | Scaffold a workspace (sets project key; writes AGENTS.md, CLAUDE.md + GEMINI.md pointers, folders, manifest, gitignore). |
| `awo add <url> [--ref]` | Register a git working repo, then sync it. |
| `awo connect <path>` | Symlink a local repo; record as `type: local`. |
| `awo sync` | Reconcile `repos/` with the manifest: clone missing git repos, **fast-forward only** clean ones, relink local ones. Never touches a dirty or diverged checkout. |
| `awo list` | Show linked repos + status (present / missing / dirty). |
| `awo remove <name>` | Unlink a repo (remove from manifest, drop clone/symlink). |

**All commands below are Phase 1** (part of the initial build, though the plan in §8 recommends implementing them **after** `init` has been used on a real project — not before):

| Command | Purpose |
|---------|---------|
| `awo req new --title <t>` | Intake: create the next `<KEY>-R#` skeleton at `goals/<KEY>-R#.md`. |
| `awo goal new --from <req-id>` | Transform a requirement into a goal folder, **moving** the requirement in as `requirement.md`. |
| `awo task new --goal <id> --name <n>` | Create the next `<KEY>-T#` under a goal; validates `targets`/`dependsOn` and wires the goal's `taskIds`. |
| `awo goal plan <goal-id>` | Decompose a goal into tasks. |
| `awo goal list` / `show` | View goals + rolled-up task status. |
| `awo task run <task-id>` | Execute a task; writes state + a log. |
| `awo task show <task-id>` | View a task and its last run. |
| `awo log <...>` | View run history + audit trail. |
| `awo task list [--status <s>]` | List tasks with lifecycle status; `--status blocked` is the "needs me" view. |
| `awo task status <task-id> <status>` | Move a task's lifecycle state by hand (§7.4). The only way to reach `cancelled`. |
| `awo task event <task-id> <kind>` | Append a progress event to the task's open run (§7.4). |
| `awo task complete <task-id> --outcome <o>` | Close the open run: writes the log, index line, and lifecycle transition. `--gate` routes success to `in-review`. |
| `awo task verify <task-id> [--reject]` | QA gate (§7.1): approve an `in-review` task to `done`, or reject it back to `todo`. |
| `awo connector add <name>` / `list` / `remove` | Register or manage MCP/connectors in `connectors.json`. |
| `awo upgrade [--dry-run] [--to <v>] [--force]` | Bring a workspace up to the **installed** awo version: run migrations, reconcile scaffolding (§11). `--to` asserts intent — it cannot fetch another version, since the template ships in the package. |
| `awo doctor` | Diagnose: version skew (§11), missing/mislinked repos, task `targets` and `dependsOn` that don't resolve, `taskIds` drift, orphaned `state.json` entries, abandoned runs, un-transformed requirements. Read-only; exits non-zero on errors. |

**Phase 2 — visibility** (§7.4, §7.5; built only after Phase 1 has been dogfooded)

| Command | Purpose |
|---------|---------|
| `awo status [--watch]` | Terminal board: tasks by lifecycle state, live. The cheap 70% of the UI. |
| `awo ui [--port] [--root <dir>]` | Serve the local web UI on `127.0.0.1`. `--root` scans a directory of workspaces for the portfolio view. |

**Phase 3 — publish** (§7.6; only if multi-machine visibility proves to be a real need)

| Command | Purpose |
|---------|---------|
| `awo publish [--watch]` | Flush the outbox to the configured remote. `--watch` streams while runs are in flight. |
| `awo publish --token <t>` | Store a scoped publish token in `.workspace/credentials/`; enables publishing for this workspace. |
| `awo publish --off` | Drop the token and stop publishing. Local state is unaffected. |

---

## 7. Feature Modules

### 7.1 Scaffolding primitives
The scaffolding folders (`agents/`, `skills/`, `rules/`, `instructions/`) plus **connectors** are the reusable substance the library ships. They only stay coherent if each has a sharp, non-overlapping role — otherwise the workspace becomes a junk drawer.

| Primitive | What it is | Nature | Classify by asking… |
|-----------|-----------|--------|---------------------|
| **Rule** | Policy / constraint. Always-on, declarative. | Ambient — not invoked; shapes *how* all work is done. | "**must / never**?" |
| **Skill** | Reusable procedure / capability. A "how-to" you invoke. | Invoked when relevant; often carries steps or scripts. | "**how to** …?" |
| **Agent** | Actor / role. A persona owning a domain. | *Uses* skills, *obeys* rules, *granted* connectors. | "**who** does this?" |
| **Instruction** | Workflow glue. Context-specific sequencing. | Ties primitives together for one situation. | "**in this case, do** …?" |
| **Connector** | External system reached over a protocol (MCP / API). | Capability/equipment an agent calls; not authored logic. | "is it an **external system**?" |

**One-line test:** *must/never → rule · how-to → skill · who → agent · in-this-case → instruction · external system → connector.*

#### Worked example: the GitHub workflow (why it's not "one thing")
A request like "add rules about commit, PR, and PR-resolve" decomposes across primitives — this is the canonical demonstration of how they compose:

- **Rules** (the standards, always-on): commit messages follow Conventional Commits; no direct commits to `main`; every PR needs a description + testing section + linked issue; squash-merge only.
- **Skills** (the actions, invoked): `create-commit` (stage → conventional message → commit), `open-pr` (branch → push → create PR from template), `resolve-pr` (pull review comments → address → push → re-request review).
- **Agent** (optional owner): a `release-engineer` or `code-reviewer` *only* if you want a persona that owns this domain. Not required — any agent can invoke the git skills under the git rules.
- **Connector**: GitHub itself, via the GitHub MCP or `gh` CLI, which the skills call.

So "commit / PR / PR-resolve" is a **rule + skill** pair (agent optional), sitting on top of a **connector**.

#### Connectors / MCP
Connectors are declared once at the workspace level, like repos in the manifest — e.g. `.workspace/connectors.json`:
```jsonc
{
  "connectors": [
    { "name": "github",  "type": "mcp", "url": "https://…/github",  "scopes": ["repo","pr"] },
    { "name": "gcloud",  "type": "mcp", "url": "https://…/gcloud",  "scopes": ["deploy"] }
  ]
}
```
Three rules of thumb decide where an integration's concern lives:
- The **system** you talk to (GitHub, GCloud, a Google tool, any MCP server) → a **connector** entry.
- The **knowledge of how to use it** (how to deploy, how to open a PR) → a **skill** that declares the connector it requires.
- The **policy on when/whether to use it** (never deploy to prod without approval) → a **rule**.

**Least privilege:** agents are *granted* a subset of connectors, not all of them — the deploy agent gets `gcloud`, the reviewer agent doesn't. Skills list the connectors they need so `awo doctor` can warn when a required connector is missing.

**Tracked vs secret (reuses the core split):** the *declaration* of which connectors a project uses is tracked in git; the *auth/credentials* are gitignored and per-machine — the same principle as git-vs-local repos and definitions-vs-state. A fresh clone knows *what* to connect; each machine supplies its own *credentials*.

#### Default baseline vs. catalog
`awo init` installs a small, **domain-agnostic core** — just enough to make the link → work → ship loop function — not every skill a project might eventually want. Everything else ships *with the library* as a browsable, opt-in **catalog** instead of cluttering a fresh workspace. Test for "belongs in core": *is this needed regardless of what the project actually does?* Commit/PR hygiene and the core execution loop qualify; "deploy to Cloud Run" doesn't (it's noise unless the project actually has a GCloud connector).

**Installed by default at `init`:**

| Rules (7) | Skills (9) | Agents (6) | Instructions (4) |
|---|---|---|---|
| `conventional-commits` | `refine-requirement` *(new)* | `product-manager` *(new)* | `full-workflow` *(new)* |
| `no-push-to-main` | `create-commit` | `tech-lead` | `capture-requirement` |
| `pr-requirements` | `open-pr` | `software-engineer` | `plan-a-goal` |
| `stay-in-scope` | `resolve-pr` | `qa-engineer` *(new)* | `ship-a-change` |
| `isolate-task-worktrees` | `sync-repos` | `release-engineer` | |
| `tests-must-pass` | `create-task-worktree` | `code-reviewer` | |
| `acceptance-criteria-required` *(new)* | `run-tests` | | |
| | `verify-acceptance-criteria` *(new)* | | |
| | `file-bug` *(new)* | | |

- `stay-in-scope` — an agent only touches repos declared as a task's `targets`; the guardrail that matters specifically *because* this is multi-repo — without it an agent on one task could wander into an unrelated linked repo.
- `sync-repos` — an invokable wrapper around `awo sync`, so an agent can bring `repos/` current as a step, not only as a standalone CLI command.
- `tech-lead` — owns `awo goal plan` (decomposing a goal into tasks). Without an explicit owner here, the requirement→goal→task transform has no accountable actor.
- `plan-a-goal` — the goal-side counterpart to `ship-a-change`: sequencing for turning a refined requirement into planned tasks.
- `software-engineer` / `run-tests` / `tests-must-pass` — close the gap between "planned" and "shipped": something has to actually write the code and verify it before `release-engineer` ships it. **Implementing code is deliberately not a skill** — it's the intelligent work every task exists for, not a rote procedure — but *verifying* it is (`run-tests`), and *requiring* verification before shipping is policy (`tests-must-pass`). `run-tests` reads an optional per-repo `testCommand` from the manifest (§5) and flags any target repo missing one as unverified rather than silently passing.
- `isolate-task-worktrees` / `create-task-worktree` — solve a distinct multi-repo problem: two **tasks** (not two repos) targeting the *same* repo concurrently. Without isolation, `software-engineer` would work directly in the one shared `repos/<name>` checkout, so two tasks would fight over the same branch and uncommitted changes. Each task instead gets its own `git worktree` at `repos/.worktrees/<repo-name>/<taskId>`, on its own branch — full isolation without cloning the repo again per task. The worktree is created right after `sync-repos` and removed after that task's PR merges.
- `product-manager` / `refine-requirement` *(new)* — closes the intake gap: previously nothing owned `awo req new` or turning a requirement into a goal. Owns the *what/why*; hands off to `tech-lead` for the *how*.
- `qa-engineer` / `verify-acceptance-criteria` / `file-bug` / `acceptance-criteria-required` *(new)* — closes the verification gap: `software-engineer` runs *existing* automated tests, but nobody checked the goal's definition-of-done *as a whole*, or did exploratory verification. `qa-engineer` gates `done` status on the goal (not the task) level, and — notably — **feeds back into the same pipeline** rather than dead-ending: a found gap becomes a new requirement via `file-bug`, triaged by `product-manager` like any other ask.
- `full-workflow` *(new)* — the master sequence; the other three instructions are its *stages*, not alternatives to it. Intake → Plan → Build & ship (looped per task, parallel across repos) → QA gate → Done, with the QA-gap loop re-entering at Intake. Also states where `audit` (periodic, non-blocking) and `marketing-specialist` (swaps in for stage 3 on marketing-scoped goals) sit relative to this flow.

The lifecycle these six agents form: `product-manager` (intake) → `tech-lead` (decompose) → `software-engineer` (write + verify, in an isolated worktree) → `qa-engineer` (verify the goal as a whole) → `release-engineer` (ship, then clean up the worktree) → `code-reviewer` (review). Naming follows a **real-world job-title convention** deliberately — future catalog agents (below) should follow the same pattern (e.g. `devops-engineer`, not `deploy-agent`).

#### Catalog: domain/function-specific roles (not installed by default)
`product-manager` and `qa-engineer` earned a place in the default set because *every* project needs intake and verification, regardless of domain. The rest of a real org's roles — Marketing, Sales, Data, Audit — are **project-dependent**: a plain internal-tools project has no use for a Marketing agent, but a promotion-campaign project (like this one) might. These stay in the **catalog**, added per-project via `awo agent add <name>`, following the same job-title naming convention.

**`audit` — worked catalog example.** Chosen to build out fully because it's a natural consumer of everything already in the design: the `PROM-R# → PROM-G# → PROM-T#` traceability chain and the `logs/` history exist specifically so something like this can check them.

```markdown
---
id: audit
name: Audit / Compliance
role: Independently verifies that shipped work followed the declared rules, with full traceability
skills: [review-logs]                 # catalog skill — reads runs.jsonl + task/goal/requirement chain
connectors: [github]
rules: []                              # audits rule *compliance*; doesn't add new ones
---

## Responsibilities
- For a given goal or time range, walk PROM-R# → PROM-G# → PROM-T# → run →
  log and confirm every shipped change traces back to an approved requirement.
- Flag: commits that bypassed `no-push-to-main`, PRs missing required
  sections, tasks marked `success` without a passing `run-tests` result,
  goals marked `done` without `qa-engineer` sign-off.

## Boundaries
- Read-only — audits after the fact; never blocks or modifies in-flight work.
```

**Marketing, Sales, Data** — scoped but not built out here, since each depends heavily on which repos/connectors *your* project actually has:
- **`marketing-specialist`** would target content/campaign repos rather than app code, and would need a CMS or content connector instead of GCloud-style ones.
- **`sales-ops`** would need a CRM connector (e.g. HubSpot — already in your connected-tools list) rather than a code connector, and would work with campaign/lead data rather than repos at all.
- **`data-analyst`** would need a warehouse/BI connector and would likely read `logs/` for reporting rather than touch `repos/`.

Say the word if you want any of these three built out to the same depth as `audit` — the pattern (role → skills → connectors → rules → boundaries) is the same each time.


**Not installed by default (catalog, added on demand):** connector-specific skills (e.g. `deploy-gcloud-run`, `deploy-vercel`), domain-specific rules (e.g. `no-raw-sql`), specialized agents (e.g. `migration-agent`), and reusable task *templates* (e.g. `setup-env`, `run-migration` from §7.2). Adding one after init doesn't require hand-authoring from scratch:

```
awo rule new <id>              # scaffold a blank rule from template
awo skill new <id>             # scaffold a blank skill from template
awo agent new <id>              # scaffold a blank agent from template
awo skill add <catalog-name>   # pull a pre-built skill from the library's catalog
awo rule add <catalog-name>    # pull a pre-built rule from the library's catalog
```

### 7.2 Work hierarchy: Requirement → Goal → Tasks
The heart of "workflow orchestration." Work isn't authored as loose tasks; it flows down a three-level pipeline so every task is traceable back to why it exists.

```
Requirement   →   Goal   →   Tasks   →   Runs → Logs
 (what's asked)  (the objective)  (executable units)   (§7.3)

 gather &        distill into    decompose into      execute
 refine intake   an objective    concrete work       (§7.2 runner)
```

- **Requirement** — the raw ask, captured and refined during intake (optionally an agent interviews the user). Answers *what does the stakeholder want?*
- **Goal** — the structured objective distilled from a requirement: outcome + definition-of-done + scope. The "north star" for a body of work. Answers *what does success look like?*
- **Task** — a concrete, executable unit that an agent runs against target repos. Together, a goal's tasks achieve it. Answers *what exactly do we do?*

**Core principle (unchanged): separate _definition_ from _state_.** Requirement/goal/task files are the definitions (tracked, human- and agent-readable); status lives in a gitignored `state.json`; a **run** of a task produces a **log** (§7.3). A `status:` in a definition's frontmatter is the *authored starting state* only — `state.json` is authoritative once work begins, and §7.4 defines the vocabulary and who may write it. Definition format across all three levels is **markdown + YAML frontmatter** — one mental model, matching AGENTS.md / SKILL.md.

#### ID scheme — project-key prefixed
Every requirement/goal/task ID is prefixed with the workspace's `projectKey` (from the manifest) plus a type letter and a per-type counter:

- **`<KEY>-R<n>`** — requirement (e.g. `PROM-R1`)
- **`<KEY>-G<n>`** — goal (e.g. `PROM-G1`)
- **`<KEY>-T<n>`** — task (e.g. `PROM-T1`, `PROM-T2`)

This makes IDs self-describing and unique *across* projects, not just within one — so logs, branches (`feature/PROM-T12`), and commits are unambiguous when the library is reused across many projects. The type letter keeps cross-references legible (`PROM-T1` clearly sits under `PROM-G1`).

#### Layout — goal-centric nesting
Everything for one goal lives together, so an agent (or human) can be pointed at a single folder and see the requirement, the objective, and all its tasks at once. Traceability is visual, not just by ID.

```
goals/
├── PROM-G1-sso-login/
│   ├── requirement.md        # the ask, refined
│   ├── goal.md               # objective + definition-of-done + scope
│   └── tasks/
│       ├── PROM-T1-oidc-config.md
│       ├── PROM-T2-login-ui.md
│       └── state.json        # status of THIS goal's tasks (gitignored)
└── PROM-G2-.../
```

#### Requirement — `requirement.md`
```markdown
---
id: PROM-R1
title: Add SSO login
status: draft              # draft | refined | approved
source: "Jira PROJ-142 / stakeholder: Priya"
createdAt: 2026-07-21T09:00:00Z
goalId: null               # set to PROM-G1 once transformed into a goal
---

## Raw requirement
Verbatim of what was asked.

## Clarifications
Q&A gathered during intake (agent-driven interview).

## Draft acceptance criteria
- ...
```

#### Goal — `goal.md`
```markdown
---
id: PROM-G1
title: Users can sign in with company SSO
status: planning           # planning | in-progress | qa-review | blocked | done | cancelled
                           #   mostly ROLLED UP from task states — see §7.4
requirementId: PROM-R1     # traces back up
targets: [frontend-app, auth-service]   # repos in scope
taskIds: [PROM-T1, PROM-T2]             # traces down
createdAt: 2026-07-21T09:30:00Z
---

## Objective
One paragraph: the outcome we want.

## Definition of done
- Measurable success criteria.

## Scope & constraints
In scope / out of scope / non-goals / constraints.

## Task breakdown
Short rationale for how the goal splits into the tasks below.
```

#### Task — `PROM-T1-oidc-config.md`
```markdown
---
id: PROM-T1                # project-key prefixed, unique across projects
goalId: PROM-G1            # traces back up
name: Add OIDC provider config to auth-service
targets: [auth-service]    # repo names from manifest
dependsOn: []              # other task ids that must succeed first
agent: software-engineer       # optional
status: todo               # lifecycle — see §7.4 for the full vocabulary + transitions
---

## Objective
What "done" means for this unit.

## Steps
1. ...

## Done when
- ...
```

#### The pipeline (commands)
The **transform** steps are agent-driven — this is where "requirement → tasks" actually happens.

| Command | Purpose |
|---------|---------|
| `awo req new [--interactive]` | Start intake; agent interviews the user and writes `requirement.md` (draft → refined). |
| `awo goal new --from <req-id>` | **Transform** a requirement into a goal (objective, definition-of-done, scope). |
| `awo goal plan <goal-id>` | **Decompose** the goal into task files; populates `taskIds`. The core requirement→tasks transform. |
| `awo goal list` / `awo goal show <id>` | View goals + rolled-up task status. |
| `awo task run <task-id> [--input k=v]` | Execute a task (resolves `dependsOn`), writes state + a log (§7.3). |
| `awo task show <task-id>` | Print a task and its last run. |

**Traceability chain:** `PROM-R1` → `PROM-G1` (from PROM-R1) → `PROM-T1` (goalId PROM-G1) → run (`<timestamp>_PROM-T1`) → log. You can walk it in either direction from any level.

**Reusable task templates (optional refinement):** the library can still ship generic recipes (e.g. `setup-env`, `run-migration`) as templates in the scaffolding; `awo goal plan` may instantiate a task *from* a template instead of writing one from scratch. This keeps the reusable-baseline idea without turning every project task into a template.

**Open sub-questions:**
- Does `awo task run` *execute* steps itself, or hand the task to an agent to execute? (Leaning: it orchestrates ordering/state/logging; the agent does the actual work.)
- Is `awo goal plan` fully automatic, or does it draft tasks for human review/approval before they become runnable? (Leaning: draft → approve, so a human gates the decomposition.)
- ~~Do we validate `targets` against the manifest at plan/run time and fail fast if a repo is missing?~~ **Decided: yes, at run time, before any state is written** — `task run` refuses a task whose `targets` name repos absent from the manifest, and names them in the error. Validating at *plan* time too was rejected for now: a goal can legitimately be planned before its repos are linked.

### 7.3 Logs
Append-only audit trail of every run: what ran, when, with which model, against which repos, and what changed. Lives under `logs/` (gitignored). Depends on Tasks so there's something to log.

**Format decision — Markdown + YAML frontmatter for detail, JSONL for the index.**
Log detail mixes *structured, queryable* fields (model, timestamps, repos, status) with *prose* fields (the user's prompt, the agent's interpretation, the change summary). Pure JSON handles the structure but mangles prose (`\n`-escaped, unreadable raw, noisy diffs); pure Markdown reads well but can't be filtered by model or repo. Frontmatter gives both — structured YAML on top, readable prose below — and it's the **same format as task definitions**, so one mental model covers the whole system.

**Three-tier structure:**
- `logs/runs.jsonl` — the **query index**, one JSON object per line. A projection of each detail's frontmatter. Cheap to append, trivial to filter/tail, no rewrite churn. Powers `awo log list --model … --repo …`.
- `logs/runs/<YYYY-MM-DD>/<runId>.md` — the **human-readable record** of one run: frontmatter for metadata, body for the prompt/interpretation/change story. Written **once, at the end** of a run.
- `logs/runs/<YYYY-MM-DD>/<runId>.events.jsonl` — the **live progress stream** of one run, appended to *during* execution (§7.4). This is what makes progress observable; the `.md` is the retrospective narrative.

Note that a run's `status:` (`pending | running | success | failed | skipped`) is a **run outcome**, distinct from a *task's* lifecycle state. §7.4 explains why conflating the two is what previously made states like `cancelled` and `blocked` unrepresentable.

**Why one file per run, sharded by date (not one file per day):** each run gets its own file so its frontmatter stays a single clean YAML block, parallel runs never collide on the same file, and showing/archiving one run is trivial. Files are grouped into date folders only to keep any single directory small. The "browse by day" view is delivered by the index (runIds are timestamp-prefixed, so `awo log list` groups by date for free) — date-grouping lives in the *view*, not by cramming many runs into one file.

**Detail record** — `logs/runs/2026-07-21/2026-07-21T10-30-00Z_PROM-T1.md`:
```markdown
---
runId: 2026-07-21T10-30-00Z_PROM-T1
taskId: PROM-T1                   # omit / null for an ad-hoc prompt not tied to a task
agent: software-engineer
models:                           # one or more — a run may use several
  - codex-5.6
  - sonnet-5.0
status: success                   # pending | running | success | failed | skipped
startedAt: 2026-07-21T10:30:00Z
finishedAt: 2026-07-21T10:32:11Z
durationSec: 131
reposChanged:                     # which linked repos were actually touched
  - name: frontend-app
    filesChanged: 7
    insertions: 210
    deletions: 34
    commit: a1b2c3d               # optional — if the run committed
  - name: shared-lib
    filesChanged: 2
    insertions: 18
    deletions: 5
---

## User prompt
> Verbatim of what the user asked, quoted as given.

## Interpreted intent
What the agent understood the request to mean — the restated goal, assumptions
made, and scope it decided on. This is the agent's own summary of the prompt.

## Summary of changes
Prose narrative of what was done and why.

### frontend-app
- Bulleted specifics of the change in this repo.

### shared-lib
- Specifics for this repo.

## Notes / follow-ups
- Anything deferred, risks, or TODOs surfaced during the run.
```

**Index line** in `runs.jsonl` (mirrors the frontmatter, flattened for querying):
```json
{"runId":"2026-07-21T10-30-00Z_PROM-T1","taskId":"PROM-T1","agent":"software-engineer","models":["codex-5.6","sonnet-5.0"],"status":"success","startedAt":"2026-07-21T10:30:00Z","finishedAt":"2026-07-21T10:32:11Z","reposChanged":["frontend-app","shared-lib"],"detailFile":"runs/2026-07-21/2026-07-21T10-30-00Z_PROM-T1.md"}
```

**Field summary:**

| Field | Where | Purpose |
|-------|-------|---------|
| `runId` | both | Unique key linking index ↔ detail ↔ `state.json`. |
| `taskId` | both | Which task (null for ad-hoc prompts). |
| `agent` | both | Which agent ran it. |
| `models` | both | Model(s) used, e.g. `codex-5.6`, `sonnet-5.0`. List, since a run may mix models. |
| `status` | both | Outcome. |
| `startedAt` / `finishedAt` / `durationSec` | both | When + how long. |
| `reposChanged` | both (rich in detail, names in index) | Repos touched + per-repo diff stats + optional commit. |
| User prompt | detail body | Verbatim request. |
| Interpreted intent | detail body | Agent's own summary of what the prompt meant. |
| Summary of changes | detail body | Narrative + per-repo breakdown. |
| Notes / follow-ups | detail body | Deferred items, risks. |

`runId` convention: `<ISO-timestamp>_<taskId>` — sortable, unique, human-readable, and it ties the index line to its detail file and back to `state.json`'s `lastRunId`.

**Commands:**

| Command | Purpose |
|---------|---------|
| `awo log list [--task <id>] [--model <m>] [--repo <r>] [--status failed]` | List runs from the index, filterable. |
| `awo log show <runId>` | Print the detailed record for one run. |
| `awo log tail` | Follow the most recent run live — reads the `.events.jsonl` stream (§7.4). |
| `awo log add --agent <a> --summary <s>` | Record work that is **not** a task run — intake, planning, an audit pass. Writes an index line + detail with `taskId: null`. |

**Relationship recap:** `definition` (tracked, static) → `run` (produces a `runId`) → appends to `runs/<runId>.events.jsonl` *while running* → on completion updates `state.json` (lifecycle + outcome) + appends to `runs.jsonl` (queryable history) + writes `runs/<runId>.md` (readable detail).

---

### 7.4 Status model & progress events

The goal of this module is **verification speed**: being able to glance at a project and know what is happening, what needs a human, and what broke — without reading files or tailing a terminal. Everything in §7.5 and §7.6 is a *view* over the data defined here. This section is therefore the one part of the visibility work that belongs in **Phase 1**: it is cheap now, it is the API every later reader depends on, and retrofitting it means rewriting every run record ever produced.

#### Lifecycle vs. outcome — two fields, not one

The original design used one `status` per task drawn from `pending | running | success | failed | skipped`. That vocabulary describes a **run outcome**, not a **work item's lifecycle**, and the conflation has two concrete consequences: a failed task has nowhere to sit on a board (it is neither "in progress" nor "done"), and `cancelled` — a human decision, not a run result — cannot be expressed at all. Jira keeps issue status separate from build result for exactly this reason: an issue can be *In Progress* while its last build *failed*.

So tasks carry both:

```yaml
status: running                                  # LIFECYCLE — what a board shows
lastRunOutcome: failed                           # OUTCOME — result of the most recent run
lastRunId: 2026-07-21T10-30-00Z_PROM-T1          # pointer into logs (§7.3)
```

**Task lifecycle vocabulary (canonical):**

| State | Meaning |
|---|---|
| `todo` | Authored and runnable-in-principle. The default at `goal plan` time. |
| `queued` | Accepted by the runner; waiting on `dependsOn` or a concurrency slot. |
| `running` | An agent is executing it right now. Exactly one active `runId`. |
| `blocked` | Needs a human. Run failed, dependency failed, or the agent gave up. |
| `in-review` | Run succeeded; awaiting the `qa-engineer` gate (§7.1). |
| `done` | Verified complete. |
| `cancelled` | Deliberately abandoned. **Human-only** — no agent may set this. |

`blocked` earning its own state is the single most useful thing here: it is the "needs me" column, which is the entire point of the board.

**Transitions, and who may perform them:**

| From → To | Trigger | Actor |
|---|---|---|
| `todo` → `queued` → `running` | `awo task run` | runner |
| `running` → `in-review` | run succeeded, goal has a QA gate | runner |
| `running` → `done` | run succeeded, no gate | runner |
| `running` → `blocked` | run failed, or `dependsOn` unmet | runner |
| `in-review` → `done` | `verify-acceptance-criteria` passes | qa-engineer |
| `in-review` → `todo` | QA files a gap (`file-bug` → new requirement) | qa-engineer |
| `blocked` → `todo` | human unblocks and re-queues | human |
| *any* → `cancelled` | `awo task status <id> cancelled` | **human only** |

Anything not in this table is an invalid transition and the state writer rejects it. Rejecting invalid transitions is what keeps the board trustworthy when several agents are writing concurrently.

**Goal status is derived, not authored.** A goal's `status` (§7.2) rolls up from its tasks: any `running` → `in-progress`; all `done` → `done`; any `blocked` → `blocked`; all `in-review`/`done` with at least one `in-review` → `qa-review`; all `cancelled` → `cancelled`. It is stored for cheap reads but recomputed from task state, never hand-edited.

#### `state.json` schema

One file per goal, gitignored, at `goals/<goal-id>/state.json`:

```jsonc
{
  "rev": 47,                                  // optimistic-concurrency counter
  "goalId": "PROM-G1",
  "goalStatus": "in-progress",                // derived (see above)
  "updatedAt": "2026-07-21T10:32:11Z",
  "tasks": {
    "PROM-T1": {
      "status": "in-review",
      "lastRunOutcome": "success",
      "lastRunId": "2026-07-21T10-30-00Z_PROM-T1",
      "startedAt": "2026-07-21T10:30:00Z",
      "finishedAt": "2026-07-21T10:32:11Z",
      "attempts": 1,
      "worktree": "repos/.worktrees/frontend-app/PROM-T1",   // null when not isolated
      "blockedReason": null                                  // required when status is blocked
    }
  }
}
```

#### Concurrency rules (non-negotiable, because two writers will exist)

Once a UI can cancel a task while `awo task run` is mid-flight, and once two tasks under one goal run in parallel worktrees, `state.json` has multiple writers. Three rules:

1. **Single writer path.** There is exactly one `state` module that mutates `state.json`. The CLI calls it; the UI server calls the same module rather than touching files. No second implementation, ever.
2. **Atomic writes.** Write `state.json.tmp`, then `rename()`. `rename` is atomic on the same filesystem, so a reader never sees a half-written file — which matters because agents read this while runs are in flight.
3. **Optimistic concurrency.** A writer reads `rev`, mutates, and writes back `rev + 1`; if `rev` changed underneath, it re-reads and retries the *transition* (not the whole write). A stale write is rejected, never blindly merged.

#### Progress events — `<runId>.events.jsonl`

A run currently produces one record at completion, which means mid-run the only observable state is "running". A progress view needs to know *what step*, *what changed*, *did tests pass* — so the runner appends an event per meaningful step to `logs/runs/<date>/<runId>.events.jsonl`:

```jsonl
{"t":"2026-07-21T10:30:00Z","kind":"run.start","taskId":"PROM-T1","agent":"software-engineer","models":["sonnet-5.0"]}
{"t":"2026-07-21T10:30:02Z","kind":"step.start","step":1,"of":4,"label":"Create worktree"}
{"t":"2026-07-21T10:30:04Z","kind":"step.end","step":1,"ok":true}
{"t":"2026-07-21T10:30:41Z","kind":"repo.diff","repo":"auth-service","files":7,"insertions":210,"deletions":34}
{"t":"2026-07-21T10:31:02Z","kind":"test","repo":"auth-service","cmd":"npm test","pass":142,"fail":0}
{"t":"2026-07-21T10:31:50Z","kind":"note","level":"warn","msg":"shared-lib has no testCommand — unverified"}
{"t":"2026-07-21T10:32:11Z","kind":"run.end","outcome":"success"}
```

Event kinds: `run.start`, `step.start`, `step.end`, `repo.diff`, `test`, `commit`, `note`, `run.end`. Every line carries `t` and `kind`; the rest is kind-specific. Unknown kinds must be ignored by readers rather than treated as errors, so the runner can add kinds without breaking older UIs.

Design properties, mirroring the reasoning behind `runs.jsonl` (§7.3): append-only (no rewrite churn, safe under crash), one file per run (parallel runs never contend), NDJSON (tailable with `tail -f`, parseable line-by-line without a full read). This file *is* the progress bar — without it, any UI can only ever render a spinner.

---

### 7.5 `awo ui` — local progress UI

A built-in command that serves a small web UI for the current workspace. **Local-first and file-backed: it reads the workspace tree and requires no network, no account, and no database.** The workspace already *is* the store (§3.1), so the UI is a reader, not a new persistence layer.

```sh
awo ui                       # serve this workspace on 127.0.0.1:<port>
awo ui --root ~/dev/spaces   # portfolio mode: scan a directory of workspaces
```

**Built in v0.0.3 (hand-written HTML), rebuilt on Vite + React + Tailwind in v0.0.4** once it grew past one view. Recorded because the size question is the obvious objection:

- **React source, Preact runtime.** `vite.config.ts` aliases `react`/`react-dom` to `preact/compat`. Identical source (still plain React components, reusable by the Next.js site), but the bundle is **76 kB / 25 kB gzipped** instead of 248 kB / 77 kB. Nothing in the dashboard touches React internals, which is the only thing that alias breaks.
- **Nothing reaches a user's `node_modules`.** React, Vite, Tailwind, and `marked` are **devDependencies** compiled away at build time. Runtime deps are unchanged: `commander`, `fs-extra`, `simple-git`, `uuid`, `gray-matter`, `chokidar`.
- **Cost is one bundle in the tarball**: package 20.8 kB → 68.9 kB, and it is only read when someone runs `awo ui`. `init`, `add`, `task run` never touch it.
- **Output path is `dist/dashboard/`, not `dist/ui/`** — `src/ui/*.ts` compiles to `dist/ui/`, and vite's `emptyOutDir` deletes it otherwise. This was a real breakage, not a hypothetical.
- **The build restores `dist/cli.js`'s exec bit** (`chmodSync 0o755`), because `rm -rf dist` otherwise breaks an `npm link`ed `awo`.

The `WorkspaceReader` boundary is implemented as specced, so the hosted site (§7.6) reuses both the data layer and the React components.

**Serving model.** Binds `127.0.0.1` only — never `0.0.0.0`, so it is not exposed on the LAN. Static assets are **prebuilt and embedded in the npm package** at `dist/ui/`, copied by the same mechanism as `templates/default/` (§10) — so the UI is offline-capable and version-locked to the workspace's `libraryVersion`, with no CDN dependency. Live updates come from `chokidar` watching `goals/**/state.json`, `logs/runs.jsonl`, `logs/runs/**/*.events.jsonl`, and `.workspace/manifest.json`, pushed to the browser over SSE. Killing the process leaves zero residue: no daemon, no cache, nothing in `~` (§3.7).

**The reader boundary.** The UI is built against an interface, not against `fs`:

```ts
interface WorkspaceReader {
  projects(): Promise<ProjectSummary[]>          // 1 entry locally, N in portfolio mode
  goals(projectId): Promise<GoalSummary[]>
  tasks(goalId): Promise<TaskState[]>
  repos(projectId): Promise<RepoStatus[]>
  runs(filter): Promise<RunIndexEntry[]>
  runEvents(runId): AsyncIterable<RunEvent>      // live tail
}
```

`FileReader` implements it over the local tree. A future `HttpReader` implements it over a hosted API (§7.6) — same React bundle, one adapter swap, no second frontend. This boundary is the whole reason a hosted dashboard is later cheap instead of a rewrite, so it goes in from the first commit of the UI even though only one implementation exists.

**Views, in priority order** (priority = how much verification time each saves):

1. **Board** — columns are the seven lifecycle states (§7.4), swimlane per goal, card shows task ID, agent, target repos, and a last-run outcome badge. Live-updating as agents work. The `blocked` column is the one you actually look at.
2. **Run timeline** — the in-flight run rendered from its event stream: step list with durations, per-repo diffstat, test results. This is the "what is happening right now" screen. **Built**, reachable two ways: the Events tab of a task's drawer, and clicking any row in Runs.
2b. **Task drawer** — added in v0.0.4, not in the original five: clicking a card opens the task's **definition body** (markdown), its state fields, `dependsOn`, the file path it came from, one-click transitions, and tabs for its **event stream** and its **run log** (`.md`). This is what "see log, task, …" from the UI means in practice, and it is the view that made a component framework worth it.
2c. **Drag-and-drop** — dragging a card between columns POSTs a human transition. Invalid moves surface §7.4's rejection message as a toast rather than silently snapping back. Native HTML5 drag events, no drag library.
3. **Goal detail** — requirement → goal → tasks in one pane, definition-of-done as a checklist, QA verdict. The traceability chain (§7.2) made visual.
4. **Repos** — manifest entries × live git state (present / missing / dirty / branch) plus active `.worktrees/` per task. `awo list` and `awo doctor` as a panel.
5. **Log explorer** — `runs.jsonl` as a filterable table (model, repo, status, date), click through to the run's `.md`.

**Writes from the UI** are limited to lifecycle transitions a human is allowed to make (§7.4) — cancel, unblock, re-queue — and they POST to the local server, which calls the same `state` module the CLI uses (rule 1 of §7.4). The UI never writes files directly.

**`awo status --watch`** ships first: the same data as the Board, rendered in the terminal. Since the runner already emits events, this is a few hundred lines and captures most of the verification win without any web stack. Build it before the web UI, not after.

#### Multi-project — moved out of `awo ui` entirely (decided)

**`awo ui` is single-workspace. It will not grow a portfolio mode.** Multi-project monitoring becomes a **separate hosted website** for this library — Next.js on Vercel — which reads from a MongoDB connection the user supplies. That is a different product with its own auth and hosting; it is tracked in §7.6, not here.

This kills `awo ui --root`, and that is a simplification worth taking: the CLI stays a local, zero-infrastructure tool over one workspace, and everything cross-project lives in the thing that is actually good at it. The `WorkspaceReader` boundary below still matters — it is what lets the website reuse these components over HTTP instead of re-implementing them.

The options below are retained only as the reasoning behind that decision:

#### Multi-project (portfolio) view — NOT BUILT, see above

Seeing many projects at once is an **aggregation concern, not a nesting one** (§2). Three ways to get it, in increasing cost:

1. **Multi-root scan (do this one).** `awo ui --root <dir>` globs for `*/.workspace/manifest.json` and treats each hit as a project — reading its `projectKey`, `projectName`, goal states, and run index. Zero config, nothing persisted, no violation of §3.7 because the scan root is a runtime argument rather than stored global state.
2. **Hub workspace (only if the list needs to persist).** Rather than inventing config in `~`, apply the manifest model recursively: a workspace whose manifest carries a `workspaces: [...]` array of `{ key, type: "git" | "local", path | url }` entries. Same link types, same `sync` semantics, same "clone the hub = restore the portfolio" property. `local` links expose live status; `git` links expose **definitions only** — because `state.json` and `logs/` are gitignored (§3.3) — and the UI must badge them as such rather than rendering a misleadingly empty board.
3. **Published projections (§7.6).** The only honest way to see *live* status for a workspace that is not on this machine.

**Why the library stays single-project.** `projectKey` is workspace-level and permanent (§5); multi-project inside one tree demotes it to a per-project field, adds a level to every path in §4, makes `awo task run PROM-T1` ambiguous, and forces the scaffolding (`AGENTS.md`, rules, agents) to be either shared across unrelated domains or duplicated per project — which is nested workspaces with extra steps. `repos/` is also a flat namespace of checkouts, so two projects linking the same repo at different refs would collide with no layer to absorb it (worktree isolation is per-*task*). The costs are also asymmetric: single-now → hub-later is purely additive, while multi-now → collapse-later rewrites every ID and path in every workspace in existence.

**The test for "is this one project or two?"** — i.e. when to `awo init` again:

> Two bodies of work belong in **one** workspace if they share the same rules/agents **and** the same set of working repos. Differ on either → separate workspaces.

Anything else that feels like "another project" is a **goal**. The `goals/` layer already provides parallel bodies of work with independent task sets and state.

---

### 7.6 Optional publishing — remote projections

**Purpose:** let a hosted dashboard show live status for workspaces that are not on the viewing machine (a teammate's laptop, CI, a PM who will never clone the workspace). Strictly Phase 3, and strictly optional: a workspace with no publish credentials makes no network calls of any kind.

Governed entirely by decision §3.8 — local canonical, opt-in, non-blocking, projection-only, never dual-write.

#### Direction of trust: scoped token, not a user-supplied database URI

The tempting design is "each user brings their own MongoDB connection string and the dashboard reads it." **Don't.** It means the dashboard stores third-party database credentials with read *and write* access to entire clusters: one breach of the dashboard becomes a breach of every user's database, a pasted internal URI turns the server into a proxy into a private network, and schema drift becomes unfixable because every store belongs to someone else. It increases both cost and liability while still requiring the service to be operated.

Invert it — **the service owns the store; the workspace pushes with a scoped token**, the Sentry-DSN / Datadog-API-key shape:

```sh
awo publish --token awo_pk_live_xxx    # token minted by the dashboard, stored locally
```

The token is scoped to one `workspaceId`, write-only, and revocable as a single row. The service never holds customer credentials, controls its own schema and tenant isolation, and its choice of datastore stays an implementation detail users never see. *(BYO-database stays a possible enterprise escape hatch for orgs that will not send code metadata to a third party; if it is ever built, it requires a read-only, single-database user and encrypted-at-rest storage of the URI. Not the default, not in Phase 3.)*

**Config placement follows the existing tracked-vs-secret split exactly** (§3.7): the *declaration* that this workspace publishes (endpoint, redaction settings) lives in a tracked file alongside `connectors.json`; the *token* lives in `.workspace/credentials/publish.env`, gitignored, re-supplied per machine. "No credentials → no publishing" therefore falls out as the default, and a fresh `git clone` publishes nothing until someone opts in again.

#### The outbox — how publishing stays non-blocking

```
1. Run writes local state + events.  COMMITS.        ← authoritative, done
2. Same records appended to .workspace/outbox/ (gitignored).
3. A flusher drains the outbox to the API — async, retrying, allowed to fail.
```

A dead network, an expired token, or a dashboard outage degrades the *board*, never the *work*. When connectivity returns the outbox replays in order, so the remote converges rather than silently losing history. This is what makes "never blocking" (§3.8) real rather than aspirational — without it, the first outage either stalls an agent mid-task or drops runs permanently.

#### What gets published

A **projection**, keyed on `(ownerId, workspaceId)` — never on `projectKey`, which collides across users (§5):

| Collection | Contents | Retention |
|---|---|---|
| `projects` | One doc per workspace: `workspaceId`, `projectKey`, `projectName`, rolled-up counts. | Kept |
| `tasks` | Current lifecycle state per task (§7.4) — the board. | Kept |
| `runs` | The `runs.jsonl` index lines. | Kept |
| `events` | Per-step run events (§7.4). **Opt-in**, and TTL-indexed at 7–14 days. | Expired |

Event volume is what would blow a free-tier quota (Atlas M0 is 512 MB), so `events` is both opt-in and TTL'd; `tasks` and `runs` are small enough to keep indefinitely. Markdown bodies never leave the machine.

**Redaction defaults.** Published by default: statuses, timestamps, counts, diffstats, repo *names*. Published only when explicitly enabled: verbatim user prompts, agent reasoning, and file paths. Run logs describe private codebases (§7.3 carries the verbatim prompt and the agent's interpretation), and a hosted board leaking that is what would make the feature unadoptable.

**Realtime on the dashboard.** A 5-second poll is sufficient for a status board and a fraction of the complexity of change streams plus authenticated websockets. Start with polling; add streaming only if latency turns out to matter.

**Dashboard implementation note.** The dashboard implements `HttpReader` against the `WorkspaceReader` interface (§7.5) and reuses the same UI components as `awo ui`. Its own authentication and multi-tenancy are a property of that service, not of this library — the library's entire surface here is "flush an outbox to an endpoint with a token."

---

## 8. Roadmap

**Status: everything designed so far — scaffolding, linking, the req→goal→task pipeline, logs, worktrees, the default agent/skill/rule/instruction set, the catalog — is Phase 1.** Not staged, not split. The goal right now is to try the whole thing on a real project and find out what breaks, not to build it out further on paper. Phase 2 is deliberately empty until Phase 1 has been used.

**Phase 0 — Foundations**
- Name the library, reserve npm package.
- Scaffold the library repo itself (TypeScript + a CLI framework).
- Lock the manifest schema.

**Phase 1 — Try it (everything built so far)**
- `init`, `add`, `connect`, `sync`, `list`, `remove` — scaffolding + linking.
- Full workspace template: `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`, the 6 default agents, 9 skills, 8 rules, 4 instructions, the catalog.
- The `req` → `goal` → `task` pipeline, worktree isolation, and the log format.
- **The status model + progress events (§7.4)** — the lifecycle/outcome split, `blocked`/`cancelled`, `state.json` with `rev` + atomic writes, and `<runId>.events.jsonl`. In Phase 1 *not* because the UI is wanted early, but because this is the data format every later reader depends on and it cannot be retrofitted cheaply. The UI itself is Phase 2.
- **`workspaceId` written by `init` (§5).** One uuid, nothing reads it until Phase 3, impossible to add cheaply once workspaces exist in the wild.
- **Dogfood on one real project first.** Init a real workspace, link 2+ repos (one git, one local), and run at least one requirement all the way through `full-workflow` — intake → plan → build & ship → QA gate → done. Everything below in §9 is a hypothesis until this happens once for real.
- Fix what breaks. Cut what turns out to be unnecessary ceremony. Don't add anything new until this loop has actually been run.

**Phase 2 — Visibility (designed in §7.5; build order fixed, timing not)**
Unlike the rest of Phase 2, this one is *designed* rather than deferred-and-undefined — because §7.4's data format had to be settled in Phase 1 anyway. Build order, cheapest first:
1. `awo status --watch` — terminal board over `state.json` + events. Most of the verification win, none of the web stack.
2. `awo ui` — local, file-backed, `127.0.0.1`, SSE, embedded assets. Built against `WorkspaceReader` from the first commit. **Built in v0.0.3, ahead of the dogfood** at the user's direction: the UI is what makes the dogfood faster to verify, so building it first is tooling up rather than skipping a step.
3. ~~`awo ui --root <dir>`~~ — **cut.** Multi-project moved to the separate hosted site (§7.5).

Still gated on the Phase 1 dogfood: after real use you will know which of the five views (§7.5) you actually open, and you will have real event data to design against instead of guesses.

**Phase 2 — Whatever else Phase 1 shows you actually need**
Left intentionally undefined. Candidates already identified but *not committed to*: `doctor`, `upgrade`, presets, hooks, the three unscoped catalog agents (marketing/sales/data variants beyond what's built), path-scoped task targets, and the hub workspace (§7.5, option 2). None of these get built until real use of Phase 1 says they're worth it.

**Phase 3 — Publishing + hosted dashboard (§7.6)**
Only if multi-machine visibility proves to be a real need — i.e. someone who cannot run `awo ui` locally actually needs the board. Order: outbox → `awo publish --token` → dashboard implementing `HttpReader`. The dashboard is a separate product with its own auth and hosting; the library's whole surface here is flushing an outbox to an endpoint. Do not start this before Phase 2 exists, because the hosted version is only cheap once the local one has proven which views matter.

---

## 9. Open Questions — untested assumptions to watch for during Phase 1

Everything here is a design decision made on paper, not something that's been proven out by actually using the thing. Phase 1's dogfood run is what answers these — treat any "leaning toward X" below as a guess, not a commitment.

1. ~~**npm name availability**~~ — **RESOLVED, and the fallback was needed.** `awo` is **taken**: an unrelated 217-byte placeholder published 2022-04-24 by `79w <201444307@qq.com>`, no description, no repo. So the package is scoped as **`@supanut9/awo`** exactly as this item anticipated. Consequences, all small: install is `npx @supanut9/awo`, `publishConfig.access: "public"` is required for a scoped package to publish publicly, and the **command stays `awo`** because `bin` names it explicitly — so nothing in the docs about *using* the tool changes, only installing it. An npm name dispute over the placeholder is possible but slow and unreliable; not worth blocking on.
2. ~~**Task execution model**~~ — **RESOLVED as the leaning said: orchestrate-and-log.** `awo task run` does *not* execute the task's steps. It resolves `dependsOn`, validates `targets` against the manifest, moves lifecycle state to `running`, opens the run's `.events.jsonl`, and prints the task body for whoever does the work. The run stays **open**; the agent reports progress with `awo task event` and closes it with `awo task complete --outcome <success|failed|skipped>`. Consequences worth noting:
   - The CLI owns state and logs; the agent owns the work. That's the only split that keeps §7.4's "single writer path" true while letting any runtime (Claude Code, Gemini CLI, a human) be the executor.
   - It makes an abandoned run visible rather than silent: a task stuck in `running` with no `run.end` is a real, queryable condition — and one the Phase 2 board (§7.5) can surface. Cleaning those up is the same problem as item 10's abandoned worktrees.
   - `--gate` on `complete` is what keeps the QA gate real: success routes to `in-review` instead of `done`, and `awo task verify` closes it. Without the flag, success goes straight to `done` for work that needs no gate.

3. ~~**The draft → approve gate is only documented, not enforced**~~ — **partially resolved, deliberately.** `task run` now refuses to run a task that is `cancelled` or `done`, and blocks one with unmet `dependsOn`. It still does *not* require an explicit approval step before a `todo` task can run, because `todo` → `queued` → `running` is the normal path and adding an `approve` command before the pipeline has been used once would be ceremony invented on paper. If the dogfood shows tasks being run before a human meant them to be, the fix is a `status: draft` authored state that `task run` rejects — cheap to add later.
4. **`stay-in-scope` for `data-engineer` vs `software-engineer` is honor-system, not enforced.** Both can be scoped to the same repo with an unwritten agreement to stay in different layers (DAL vs feature code). If that overlap causes real conflicts, the fix is path-scoped `targets` (e.g. `frontend-app:src/migrations/**`) — not built, just noted.
5. **The `analytics` connector for `marketing-specialist` is a placeholder name/shape.** Needs to map to a real tool (GA, a tag manager, something else) before it means anything.
6. **Windows symlink support** — `local` links need testing (developer-mode / junctions). How much do we care for v1?
7. **`sync` on `local` repos** — do we ever pull, or is local purely "point at what's there"?
8. **Monorepo working repos** — can one linked repo expose multiple sub-projects, or is it always 1 repo = 1 unit?
9. **`GEMINI.md`/`CLAUDE.md` import syntax** — confirm each against current docs at build time; the pointer *pattern* holds regardless of exact syntax.
10. **Abandoned-task worktree cleanup** — `release-engineer` cleans up a worktree after merge, but nothing cleans up one from a task that's abandoned rather than merged. Convention (someone runs `awo doctor` eventually) or an explicit `awo task abandon`?
11. **Do agents reliably emit progress events (§7.4)?** The event stream is only as good as the runner's discipline in appending to it. If `awo task run` orchestrates while an agent does the work, the agent has to report step boundaries — or the stream degenerates to `run.start` / `run.end` and the progress view is a spinner again. Watch for this during the dogfood; the fallback is having the runner synthesise events from observable side effects (file changes, test invocations) rather than trusting self-reporting.
12. **Is `in-review` a real state or ceremony?** It assumes the QA gate (§7.1) is a distinct human/agent step. If in practice tasks go `running` → `done` and QA only ever runs at goal level, the state is dead weight and should be cut.
13. **Does `--watch` in the terminal make the web UI unnecessary?** Genuine possibility. If `awo status --watch` answers "what's happening / what's blocked" fully, `awo ui` is a nice-to-have and Phase 2 item 2 can be dropped. Build order (§8) is deliberately arranged so this is discoverable before the expensive part is built.
14. **Is 6 default agents + 8 rules + 9 skills the right amount of ceremony, or too much for a first real project?** This is the biggest unknown of all — everything else on this list is a specific mechanism; this one is whether the whole shape is right. Only real usage answers it.

**Implementation decisions made while building v0.0.1 (not specified above, recorded so they're not mistaken for spec):**

15. **`manifest.json`'s `projectName` defaults to the value of `projectKey`.** §5 shows `projectName` as a distinct human-readable field, but v0.0.1's CLI surface (§10) only takes `--key` — no `--name` flag exists yet. Until one is added, `init` sets `projectName` equal to `projectKey`. Revisit if/when a `--name` flag is added.
16. **The `init` acceptance test (§10) excludes `manifest.json`'s `libraryVersion`, `createdAt`, and `workspaceId` from the byte-for-byte diff**, checking only that they're well-formed (a real version string; a recent ISO timestamp). These fields are inherently per-run — `createdAt` is wall-clock time, `libraryVersion` is whatever `awo` version is actually installed, and `workspaceId` is a fresh uuid — so a frozen fixture can't byte-match them without faking the clock and the RNG. Instead the test asserts shape: a real version string, a recent ISO timestamp, and a uuid **v7** that differs from the fixture's placeholder (proving it was generated, not copied from the template) *and* whose embedded 48-bit timestamp is within a minute of now (proving it's genuinely v7 and freshly minted, not a v4 that happens to match the regex). Every other file, including every other manifest field, is still diffed exactly.

`.workspace/template.lock` (§11.2) gets the same treatment for the same reason: its `libraryVersion` and its hash of `manifest.json` are per-run, so the test asserts the *file set* matches the fixture exactly and every other hash is byte-identical. That check doubles as drift detection — edit a template file without regenerating the fixture and the suite fails, which is the intended tripwire.

**First real dogfood finding (confirms this list's premise):**

17. **An agent working in a real `init`'d workspace, finding no `add`/`connect` commands yet, improvised `git clone` for repos that already existed locally on the machine — wasting ~55MB re-cloning what was already checked out.** This is exactly the gap §10's build ordering anticipated ("1. `add`, `connect`, `list`, `remove`" comes right after `init`'s dogfood), so it was pulled forward and built. Two things worth recording:
    - `add` (git clone) and `connect` (local symlink) are now implemented per §6/§10, plus `list` and `remove`. `add`'s CLI help text explicitly points at `connect` ("already have this repo checked out locally? use `connect` instead") since that's the exact mistake observed.
    - Deliberately **not** built: auto-detecting whether a URL passed to `add` already has a local checkout somewhere on the machine, and silently using `connect` instead. That would mean scanning the filesystem outside the workspace, which cuts against §3 decision 7's workspace-local-only spirit and is fragile (which of N local checkouts would it even pick?). The chosen fix is making the correct command (`connect`) easy to reach and well-signposted, not making `awo` guess. If this keeps happening in practice, revisit.

19. **`postinstall` was the wrong hook for the embedded-template check, and was moved to `prepublishOnly`.** `scripts/verify-template.mjs` originally ran on every *consumer* install. Two problems: it can only fail loudly, never fix anything (and `init` already throws a clear "broken awo install" error at runtime if the template is missing, so the check was redundant); and a throwing postinstall breaks `npx` for users in ways that are miserable to debug remotely. It now runs at publish time, where a failure stops *you* instead of your users — and it was strengthened while moving, because the original check was near-useless there: running in the dev tree, `templates/default` always exists. It now shells out to `npm pack --dry-run --json` and asserts the required paths are actually **in the tarball**, which catches the failure mode that matters (a `files` field that silently drops `templates/`). `scripts/` was also removed from `files`, since it is no longer consumer-facing.

20. **VS Code's Git Graph extension (and its built-in git integration generally) didn't detect repos under `repos/<name>` after `connect`/`add`.** Root cause: it doesn't reliably follow symlinks (breaks `connect`) or scan nested subfolders (breaks both) when looking for repos inside one opened folder — it detects a repo reliably only when that repo is its own top-level folder. First fix: `add`/`connect`/`remove` regenerate a `<projectKey>.code-workspace` file (multi-root VS Code workspace: the workspace root + one folder entry per linked repo) as a side effect — see `src/vscode-workspace.ts`. This is a derived artifact of the manifest, exactly like `repos/` itself: gitignored (`/*.code-workspace`), never hand-edited, regenerated on every manifest-mutating command. Not generated by `init` (nothing to list yet, and it's not part of the locked reference tree that command's acceptance test diffs against).
    - **Follow-up finding: opening that multi-root workspace has its own real cost.** Several linked repos have their own `CLAUDE.md`/`AGENTS.md` for their own unrelated dev conventions. Opening all folders as workspace peers surfaces all of them to an agent at once, alongside the orchestration root's `AGENTS.md` — read as project confusion during dogfooding, not a hypothetical. Practical guidance recorded here since it isn't enforceable in code: use the workspace root alone (plain single-folder open) for agent sessions; treat the `.code-workspace` file as a git-tooling view only, opened separately when needed.
    - **Better default, installed by `init`:** `.vscode/settings.json` with `"git.autoRepositoryDetection": "subFolders"` and `"git-graph.maxDepthOfRepoSearch": 2`, so a single-folder open of the workspace root (no multi-root, no `CLAUDE.md` pollution) still lets VS Code's Source Control panel discover repos nested under `repos/`.
    - **ANSWERED (was untested above): `subFolders` does *not* follow symlinks.** It scans real subdirectories only, so every `type: "local"` repo — a symlink under `repos/` — stayed invisible on a plain folder open. Confirmed against the dogfood workspace, where all 8 repos are symlinks and none were detected.
    - **Fix: generate `git.scanRepositories`.** It takes an explicit list of paths rather than scanning, so `add`/`connect`/`remove` now write each repo's **real** location into `.vscode/settings.json` alongside regenerating the `.code-workspace`. Detection then works on a plain single-folder open, with no multi-root and no `CLAUDE.md` pollution. Template keys in that file are preserved through the merge. It does make `settings.json` diverge from the shipped template, so `awo upgrade` treats it as user-edited and leaves it alone (§11.2's third case) — correct, since it is workspace-specific derived state.
    - **Git Graph specifically may still need the multi-root file.** `git.scanRepositories` is a built-in Git extension setting; whether Git Graph honours VS Code's resulting repository list or only scans workspace folders is **not verified here**. If Git Graph still comes up empty, open the generated `<KEY>.code-workspace`, or use its "Add Repository" command.

29. **`runId` collided when the same task ran twice inside one second.** The ID was `<ISO-timestamp-to-seconds>_<taskId>`, so two runs in the same second shared it: they appended to one events file and wrote two index lines with the same key — breaking the uniqueness §7.3 depends on to link index ↔ detail ↔ `state.json`. Found by a test that ran one task three times in a row; unlikely in real use, where a run takes minutes, but trivially reachable and silently corrupting when reached. Fixed by keeping milliseconds. The lesson: **a timestamp is only an identifier at a precision finer than the fastest thing that can produce two of them.**

28. **Two full agent stages produced ZERO log entries — the audit trail only covered task runs.** Driving Codex through intake and planning (11 min / 33k tokens, then 18 min / 60k tokens) left `logs/` containing nothing but `.gitkeep`. Cause: every log write lived in `task.ts`, so only `task run`/`task event`/`task complete` could produce one, and neither stage involves a task. §7.3 *already* permitted `taskId: null` "for an ad-hoc prompt not tied to a task" — the format anticipated this and no command delivered it. This is the second time the gap surfaced: §9 item 14's agent hand-wrote a `runs.jsonl` entry typed `manual-planning` for exactly this reason, and that improvisation was recorded as a curiosity rather than read as a missing command. Fixed with `awo log add`. The lesson: **when an agent invents a workaround, the workaround is a feature request** — and a spec allowing something is not the same as a command producing it.

27. **Having to write "act as product-manager" in every prompt was pure ceremony — the artifacts already said it.** Instructions carried the owner in prose ("owned by `product-manager`") and every task carries `agent:` frontmatter, but `AGENTS.md` never told an agent to *read* either, so the role had to be restated by hand each time. Fixed by making it a rule with explicit precedence — task `agent:` beats instruction `owner:` beats ID-type inference, ask only if none apply, and a human naming a role always wins — plus machine-readable `owner:` frontmatter on the instructions. The general lesson: **if a human has to repeat something the workspace already knows, that is a missing rule, not a user error.** Worth re-checking the other prompt boilerplate ("use `awo task new`, don't hand-author files") against the same test — it is currently advice in a doc rather than a rule agents are told to follow.

25. **`awo upgrade` nearly shipped a data-loss bug, caught by one assertion.** Rebuilding `template.lock` from disk after an upgrade made a user's edits the new baseline, so a *second* upgrade would classify their customized `AGENTS.md` as unmodified and overwrite it. The only thing that caught it was asserting the upgrade was **idempotent** — run it twice and nothing further happens. Two lessons: **for anything that reconciles state against a baseline, test running it twice**, and the baseline must describe the *source of truth* (the template), never the current state (the disk). §11.2 now says this explicitly.

26. **§11.2's third case existed in the spec and not in the code.** "User-edited, template unchanged → leave it alone silently" was written down, then not implemented — so a customized file was re-flagged as a conflict on every upgrade, regenerating a `.new` file identical to the baseline the user had already diverged from. Writing the spec first did not stop the omission; running the command twice did.

24. **`doctor` found a real bug within seconds of existing — requirement IDs were being reissued.** `goal new` *moves* the requirement into the goal folder as `requirement.md`, so its ID stopped appearing in `goals/`'s listing — and `nextId` therefore handed `SHOP-R1` to the *next* requirement while `goal.md`'s `requirementId: SHOP-R1` still pointed at the first. Two different requirements, one ID, in a scheme §7.2 calls unique across projects. Fixed by also scanning each goal's `requirement.md` id and `goal.md`'s `requirementId`; regression test added. Two lessons: **an ID allocator must scan wherever IDs can hide, not just where they are created**, and a diagnostic command pays for itself immediately — this was invisible to 30 passing tests because none of them created a requirement *after* a transform.

22. **Where does a requirement live *before* it has a goal?** §4 and §7.2 both show `requirement.md` nested inside the goal folder, but a requirement exists first — intake happens before the goal is distilled. The spec never says. Implemented as `goals/<KEY>-R#.md` at the top of `goals/`, which `goal new --from` then **moves** into the goal folder as `requirement.md`. Chosen because it is what an agent did unprompted in the first dogfood, so it is at least the intuitive reading. Revisit if a `requirements/` folder turns out to read better once there are many un-transformed asks.

23. **Interpolating user text into YAML frontmatter produced unparseable files.** `awo req new --source "stakeholder: Priya"` wrote `source: stakeholder: Priya` — invalid YAML, and the workspace then failed to read its own requirement. Caught by a test on the first run. All three generators now serialize frontmatter through `gray-matter`/js-yaml instead of building strings, which fixes the whole class (titles with `:`, `#`, quotes, leading `-`). Worth remembering anywhere else the tool writes YAML: **never hand-format it**.

21. **A structural change broke both existing and brand-new workspaces — caught only by asking, not by tests.** v0.0.2 replaced the task status vocabulary with the lifecycle/outcome split (§7.4). Two failures followed, neither noticed at the time:
    - Any existing task file authored as `status: pending` **failed to load** — `task list` exited 1. An existing workspace pulling the new CLI would simply break.
    - Worse, the shipped template still *instructed* agents to author `pending`, so even a **freshly created** v0.0.2 workspace produced task files its own CLI rejected. The 22 passing tests all authored the new vocabulary, so none of them saw it.
    Fixed by translating the old vocabulary on read (`pending`→`todo`, `success`→`done`, `failed`→`blocked`, `skipped`→`cancelled`) rather than by a migration — no upgrade step, nothing to run, and old workspaces keep working. The template and the byte-for-byte fixture were corrected in lockstep, and a test now pins the legacy behavior. Three lessons, all folded into §11: **tolerate the old shape instead of migrating**; **a vocabulary lives in the prose as well as the code**, so changing one means grepping the template; and **tests that only exercise the new format cannot catch a migration break** — the fixture needs a legacy case.

---

## 10. Implementation Notes

### Language and packaging
- **TypeScript**, compiled to JS, shipped as an npm package with a `bin` entry so `npx @supanut9/awo …` works out of the box (and the local command is just `awo`).
- Target Node LTS; declare `engines.node` accordingly in `package.json`.
- Include a `postinstall` verifier that the embedded template folder is present (see below).

### Suggested libraries
- **CLI framework** — pick one and stick with it: `commander` (small, familiar), `clipanion` (typed, structured), or `oclif` (heavier, plugin-oriented). For a first version, `commander` is probably the least ceremony.
- **`simple-git`** — for all git operations (clone, pull, worktree create/remove).
- **`zod`** — for validating `.workspace/manifest.json` and `.workspace/connectors.json` at read time. Fail fast with clear messages.
- **`fs-extra`** — file/symlink work; its `copy` is what `init` uses to lay down the template.
- **`uuid`** — `v7()` for the manifest's `workspaceId` (§5). Needed because `crypto.randomUUID()` is v4-only; worth a dependency rather than hand-rolling, since v7 requires a monotonic counter to stay ordered within the same millisecond.
- **`gray-matter`** — reading YAML frontmatter from agent/skill/rule/task/goal/requirement markdown files.
- **`fast-glob`** — for enumerating scaffolding files, and for the portfolio scan in `awo ui --root` (§7.5).
- **`chokidar`** *(Phase 2)* — watching `state.json` / `runs.jsonl` / `*.events.jsonl` to drive live UI updates. Node's `fs.watch` is not consistent enough across platforms to rely on here.
- **`node:http` + SSE** *(Phase 2)* — the UI server is small enough that no framework is warranted; `EventSource` over a single SSE endpoint covers live updates without websockets.
- UI assets are **prebuilt into `dist/ui/` and shipped inside the package**, exactly like `templates/default/` (see *Template delivery* below) — same offline, version-locked reasoning. No CDN, no runtime fetch.

### Repo layout for the `awo` library itself
```
awo/
├── package.json               # bin: { "awo": "dist/cli.js" }
├── src/
│   ├── cli.ts                 # entrypoint — wires commands
│   ├── commands/
│   │   └── init.ts            # ONLY command needed for v0.0.1
│   ├── workspace.ts           # findWorkspaceRoot() — walks up for .workspace/
│   └── schema.ts              # zod schemas for manifest, connectors, frontmatter
├── templates/
│   └── default/               # <-- byte-for-byte copy of PROM-workspace/
│       │                      #     with {{PROJECT_KEY}} tokens where the key goes
│       ├── AGENTS.md
│       ├── ...
│       └── .workspace/manifest.json
├── test/
│   └── init.integration.test.ts   # runs init into a temp dir, diffs vs fixture
└── tsconfig.json
```

### Template delivery — embedded, not fetched
Ship `templates/default/` **inside the published npm tarball**. On `init`, `fs-extra.copy` it from the package's install path into the target directory. Rationale:
- Offline-friendly (works with no network).
- Version-locked (a workspace created with `awo@0.1.0` will always be created against that library's template — critical for the frozen-at-init decision in §3).
- No trust surface for template fetching.

Do a single-pass token substitution during copy for `{{PROJECT_KEY}}` (into `manifest.json`, folder/file names if any). Keep the substitution mechanism dumb — no logic beyond string replace — so the template stays inspectable.

### How commands locate the workspace root
Every command except `init` walks **up** from `process.cwd()` looking for a `.workspace/` directory (identical to how `git` finds `.git/` or `npm` finds `package.json`). This is what makes `awo skill add foo` work from anywhere inside the workspace, including three folders deep in `goals/PROM-G1-…/tasks/`, and is the mechanism that delivers the "workspace-local, never global" rule from §3 decision 7:

```ts
export function findWorkspaceRoot(from = process.cwd()): string {
  let dir = path.resolve(from);
  while (true) {
    if (fs.existsSync(path.join(dir, ".workspace"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("Not inside an awo workspace");
    dir = parent;
  }
}
```

**Never fall back to `$HOME`, `$XDG_CONFIG_HOME`, or any global cache** — see §3 decision 7. If a required file is missing, error clearly and exit non-zero. Do not "helpfully" create things in the user's home directory.

### Release procedure — every version gets a tag

```sh
npm version patch|minor|<version>   # bumps package.json, commits, tags vX.Y.Z
git push --follow-tags
npm publish                          # prepublishOnly builds + verifies the tarball
```

**Let `npm version` create the tag.** Passing `--no-git-tag-version` (as the first few releases here did) leaves the release untagged, and the tags then have to be reconstructed by walking `package.json` across history — which only works while the history is short.

Tag every version even if it never reaches npm. A workspace manifest records `libraryVersion` (§5), and §11's upgrade path keys migrations off it — so every value that can appear there must correspond to a resolvable point in history, published or not.

### Acceptance test for `init` (the v0.0.1 bar)
The single test that decides whether the first release is done:

1. Create a temp directory.
2. Run `init --key PROM` in it (invoke the compiled CLI, not the source directly — you want the real user path).
3. Recursively diff the temp directory against a checked-in fixture copy of `PROM-workspace/`.
4. Assert: zero differences.

Ship v0.0.1 when this passes. Do not add more surface area before running Phase 1's dogfood milestone (§8).

### Ordering when you do build the rest (post-dogfood)
The CLI surface in §6 is roughly ordered by dependency. If you build past `init`, do it in this order — each depends on the previous:
1. `add`, `connect`, `list`, `remove` — pure manifest editing.
2. `sync` — the first thing that touches git and the filesystem non-trivially.
3. `connector add/list/remove` — same shape as (1) but on `connectors.json`.
4. `req new` → `goal new` → `goal plan` → `task run` — the pipeline; needs everything above. **`task run` and the §7.4 state/event layer are built (v0.0.2)**; `req new` / `goal new` / `goal plan` are not, so requirement/goal/task files are still hand-authored (or agent-authored) markdown for now. That ordering inversion was deliberate: `task run` is what the state model and event stream hang off, and authoring three markdown files by hand is cheap while `plan` remains unbuilt.
5. `log list/show/tail` — reads what `task run` writes. **Built (v0.0.2)**, except that `tail` prints the current event stream rather than following it; the watch layer arrives with `awo status --watch` (§7.5), which is where file-watching belongs.
6. `doctor` — depends on everything working so it has something to diagnose.

Note that `task run` (4) is also what implements §7.4 — the state writer (atomic + `rev`), the lifecycle transition table, and the `.events.jsonl` stream. Build them together; they are not a separate later pass.

Then, only after the dogfood (§8): `awo status --watch` → `awo ui` → `awo ui --root` → outbox + `awo publish`. `upgrade`, presets, hooks — do not build.

### What to explicitly NOT infer or invent
- Do not add rules/skills/agents/instructions beyond what's in `PROM-workspace/`. The default set is finalized (§7.1).
- Do not add fields to the manifest or connector schema beyond what §5 shows. If a real need surfaces, add it to §9 as a Phase 1 finding, don't slip it in.
- Do not implement `awo agent add` / `awo skill add` from the catalog until `init` has been used on a real project — it's Phase 1 in the plan but comes after `init` (see §8's dogfood milestone).


---

## 11. Versioning & upgrade — how a workspace follows the library

**Goal:** an existing workspace can adopt a newer `awo` without being hand-repaired, the way you'd expect of any library. §3.4 froze workspaces at init and left the door open for this; this section walks through it.

**But "follows the library" means an explicit, reviewable `awo upgrade` — never an automatic rewrite on the next `npx`.** That distinction is the whole design, for three reasons:
1. **The scaffolding is a fork, not a dependency.** `init` *copies* the template (§10) and users then edit `AGENTS.md`, add rules, tune agents. Auto-updating would silently discard their edits. This is closer to dotfiles than to `npm update`.
2. **Reproducibility.** §3.4's "frozen at init" is what makes a workspace behave identically on every machine and every day. A workspace that mutates itself because someone ran a newer `npx` is not reproducible.
3. **Agents run these commands.** An auto-upgrade triggered mid-workflow by an agent invoking `awo` would change the rules an agent is operating under, mid-run.

So: `libraryVersion` in the manifest records what the workspace is frozen at, `awo upgrade` is the deliberate step that moves it, and `awo doctor` reports the skew in between.

### 11.1 Classify the change — most cost nothing

| Change type | Example | What the workspace must do |
|---|---|---|
| **CLI behavior only** | new flag, better error message, bug fix | **Nothing.** `npx @supanut9/awo@latest` and it just works. This is the majority of releases. |
| **Derived artifacts** | `repos/`, `*.code-workspace`, log layout | **Nothing.** They are regenerated from the manifest (§3.1); disposable by design. |
| **Manifest schema, additive** | adding `workspaceId` | **Auto-migrate**, or tolerate absence on read. Both are cheap. |
| **Data format, breaking** | the `pending` → `todo` vocabulary change | **Translate on read**, or a one-shot migration. See §11.5 — this is the category that actually bites. |
| **Scaffolding prose** | a reworded rule, a new default skill | **Three-way decision per file** (§11.3). Hardest, because the user may have edited it. |

The design consequence: keep changes in the top three rows wherever possible, and the upgrade machinery rarely has to run at all.

### 11.2 `.workspace/template.lock` — the file that makes upgrade possible

Written by `init`, recording a hash of every template file it laid down:

```jsonc
{
  "libraryVersion": "0.0.2",
  "files": {
    "AGENTS.md": "sha256-…",
    "rules/no-push-to-main.md": "sha256-…"
  }
}
```

Without it, `awo upgrade` cannot tell "the user customized this file" from "the template changed this file," and is forced to either clobber user work or do nothing. With it, every file falls into one of four cases:

| Case | Detection | Upgrade does |
|---|---|---|
| **Unmodified** | current hash == lock hash | Replace silently with the new version. |
| **User-edited** | current hash != lock hash, and template changed | **Never overwrite.** Write the new version alongside as `<file>.new` and list it in the report. |
| **User-edited, template unchanged** | current hash != lock hash, new hash == lock hash | Leave it alone entirely; not even reported. |
| **User-deleted** | file absent | Leave absent — deletion is a choice. Report it. |

Files the user *added* (their own rules, skills, agents) are never touched, because they aren't in the lock.

This turns an unsolvable merge into an honest short list: *"14 files updated, 3 need your attention."* It is deliberately **not** a real three-way merge — no conflict markers, no auto-resolution. A `.new` file next to yours is understandable at a glance; a botched merge in an instruction file is a silent behavior change for every agent.

**`template.lock` is tracked in git** (it describes the scaffolding, which is tracked), and rewritten by `upgrade` on success.

**Workspaces created before the lockfile existed** (anything from v0.0.1, including the first real dogfood workspace) simply have no `template.lock`. `upgrade` must not refuse them, and must not guess: with no baseline it cannot prove any file is unmodified, so it treats **every** scaffolding file as user-edited — nothing is overwritten, every changed file is written as `<file>.new`, and the report says plainly that this workspace predates the lockfile and the result is conservative. Migrations (§11.3) still run normally, since those key off `libraryVersion`, which every workspace has. After a successful upgrade a lock is written, so the next upgrade is precise.

### 11.3 Migrations

Small, **forward-only, idempotent** functions keyed by the version they upgrade *to*, run in order from the manifest's `libraryVersion` to the installed one:

```
migrations/
  0.1.0-add-workspace-id.ts       # backfill a uuid v7 if absent
  0.2.0-status-vocabulary.ts      # rewrite pending -> todo in task frontmatter
```

Rules that keep them safe:
- **Idempotent** — running twice is a no-op. Upgrades get interrupted.
- **Forward-only.** No down-migrations; rolling back means restoring the backup (§11.4).
- **Never touch user content**: `goals/` prose, `logs/`, `repos/`, `manifest.repos`, or anything in `credentials/`. A migration may rewrite a *field* it owns (a status value in frontmatter) but never a body.
- **Additive-first.** If a migration can be avoided by tolerating the old shape on read (§11.5), avoid it.

### 11.4 CLI surface and safety

| Command | Purpose |
|---------|---------|
| `awo upgrade --dry-run` | Print exactly what would change: migrations to run, files to replace, files needing attention. **Runs first by default in the docs; make this the habit.** |
| `awo upgrade` | Apply it. Refuses on a dirty git tree unless `--force`, so there's always a diff to review and a way back. |
| `awo upgrade --to <version>` | Pin the target rather than jumping to the installed version. |
| `awo doctor` | Report skew: "workspace at 0.0.1, CLI is 0.0.4, 2 migrations pending, 3 files customized." |

Before applying, `upgrade` copies the scaffolding it is about to touch into `.workspace/upgrade-backups/<from>-to-<to>/` (gitignored). Belt and braces alongside git, because a workspace may legitimately not be a git repo yet.

**When the workspace is not a git repo, the dirty-tree gate cannot apply — and `upgrade` must say so rather than skip it silently.** A guard that quietly does nothing is worse than no guard, because the user believes it ran. In that case the output states plainly that there is no diff to review and no commit to revert to, and that the backup folder is the only way back. It still proceeds: the point is to inform, not to force every workspace into git.

`upgrade` **never** touches `goals/`, `logs/`, `repos/`, or `credentials/`, and never edits `manifest.repos`. It updates `libraryVersion`, runs migrations, reconciles scaffolding, and rewrites `template.lock`.

### 11.5 The discipline that matters more than the tooling

**Prefer tolerant reads over migrations.** Concretely: accept the old shape as well as the new, treat added fields as optional on read, and ignore unknown enum values or event kinds rather than throwing (§7.4 already requires this for event kinds). Every migration you don't need is one that can't fail on someone else's machine.

The worked example is real, not hypothetical — see §9 item 21. v0.0.2 replaced the task status vocabulary and broke *both* existing workspaces and freshly-created ones. The fix that shipped was a read-time alias, not a migration, and it is strictly better: no upgrade step, no ordering, nothing to run.

### 11.6 Phasing

- **Phase 1 (now):** `init` writes `.workspace/template.lock`. Same argument as `workspaceId` (§5) — nothing reads it yet, but a workspace created without it can never be upgraded reliably, and that's unfixable after the fact.
- **Phase 1 (discipline, free):** tolerant reads on every new field and enum.
- ~~**Phase 2:**~~ **BUILT in v0.0.7**: `awo doctor` (v0.0.6) and `awo upgrade` with `--dry-run`, `--force`, and the four-case reconciliation.
- **Not planned:** auto-upgrade, down-migrations, and true three-way merge with conflict markers.

#### What `--to` can and cannot mean (decided while building)

Because the template ships **inside** the installed package (§10), the only version a given `awo` can upgrade a workspace *to* is its own. So `--to <version>` is an **assertion of intent**, not a download selector: if it disagrees with the installed version the command refuses and points at the right invocation —

```
$ awo upgrade --to 0.0.4
Cannot upgrade to 0.0.4: this awo is 0.0.6, and the template ships inside the
package (§10) — there is nothing to fetch.
Run it with that version instead:
  npx @supanut9/awo@0.0.4 upgrade
```

**Why not fetch latest by default, when `npm update`/`yarn upgrade` feel like they do?** They don't, in fact: both stay inside the semver range you declared, and yarn makes you type `--latest` to escape it. The relevant split is between *tool-defines-target* (Rails' `app:update`, which uses the installed gem — awo's model) and *command-fetches-target* (`ng update`, which downloads and executes the new package).

awo must be the former, and the reason is stronger than §10: **migrations ship inside the package**. Applying 0.0.9's migrations means *running* 0.0.9 — fetching only its template would skip them and leave state half-converted. Keeping the installed version as the target also makes the result independent of *when* it is run, keeps it working offline, and stops a background release from changing the rules an agent is mid-run under.

Since `npx @supanut9/awo upgrade` resolves latest while a globally-installed `awo upgrade` does not, the output states which version it is targeting and how to reach a newer one — otherwise "nothing to do" reads as "you are up to date" when npm has moved on. This is the same shape as any other tool where the installed binary defines the target, and it keeps §10's offline/version-locked property intact. A workspace newer than the installed awo is refused outright rather than downgraded (§11.3 is forward-only).

#### The lock records the TEMPLATE's content, not the disk's

Non-obvious and load-bearing, caught only by an idempotency assertion. After an upgrade leaves a customized file alone, it is tempting to rebuild `template.lock` from what is on disk. **That silently arms a data-loss bug:** the user's edit becomes the new baseline, so the *next* upgrade sees `current == lock`, classifies the file as unmodified, and overwrites their work.

The lock must therefore record the hash of **what this version of the template provides**. Then an unmerged edit keeps showing as `current != lock` and is left alone. `manifest.json` is the one exception — its content is per-workspace, so its baseline comes from disk, and it is excluded from file reconciliation entirely because migrations own it.

---

## 12. Model tiering — orchestrator and worker

**Goal:** spend a high-end model where judgment happens and a cheaper one where a spec is merely executed, without the workspace having to be re-taught which is which every session.

**Declarative, not executive.** §9 item 2 settled that `task run` orchestrates and logs; it does not execute. This section does not change that. awo *resolves and records* which runtime+model should do a piece of work and tells whoever is driving; it does not spawn anything. Making awo an agent runtime is a separate, much larger decision — see §12.4.

### 12.1 The two tiers

| Tier | Work | Default roles |
|---|---|---|
| `orchestrator` | Judgment: interpreting an ask, decomposing a goal, verifying a definition-of-done, reviewing a PR. A bad decision here multiplies downstream. | `product-manager`, `tech-lead`, `qa-engineer`, `code-reviewer`, `audit` |
| `worker` | Execution against a spec that already exists. The judgment was made upstream. | `software-engineer`, `data-engineer`, `release-engineer`, `marketing-specialist` |

Each agent file declares its own tier in frontmatter (`tier: orchestrator`), so the classification travels with the role rather than living in a lookup table someone has to maintain. A role absent from both the file and the built-in map defaults to `worker` — the cheaper, less-trusted option, which is the right way for a default to fail.

### 12.2 Policy lives in the manifest

```jsonc
"models": {
  "orchestrator": { "runtime": "claude", "model": "opus" },
  "worker":       { "runtime": "codex",  "model": "gpt-5-codex" },
  "byRole": { "code-reviewer": { "runtime": "claude", "model": "opus" } }
}
```

Optional in full: a workspace with no `models` key resolves to built-in defaults (`claude:opus` / `claude:sonnet`), so nothing breaks and no migration is needed.

### 12.3 Resolution order

Most specific wins:

1. the agent file's own `model:` — pins a role regardless of tier
2. `models.byRole[<agent>]`
3. `models[<tier>]`
4. the built-in fallback for that tier

`awo task run` prints the resolved pairing and a ready-to-paste invocation (`codex exec -m …`, `claude --model …`, `gemini -m …`), and writes `tier` and `model` into the run's `run.start` event. That last part is the payoff beyond convenience: the log can answer "do worker-tier runs fail more often than orchestrator-tier ones?" — which is the evidence needed before trusting a cheaper model with more.

### 12.4 What is deliberately NOT built

`awo task dispatch` — actually spawning the worker, piping its output into `task event`, closing the run on exit. It is the obvious next step and was consciously deferred, because it makes awo an agent runtime that can let a runaway worker loose in linked repos. The declarative layer is a prerequisite for it either way, so nothing is wasted by waiting.

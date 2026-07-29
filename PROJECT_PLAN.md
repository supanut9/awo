# awo — AI Workflow Orchestration Library — Project Plan

> **Name:** `awo` (locked) · **npm package:** `@supanut9/awo` (unscoped `awo` was taken — see §9 item 1) · **Distribution:** npm (`npx @supanut9/awo …`), binary is `awo`
>
> **Status (2026-07-29):** published and used. Phase 1 is complete apart from
> `connector add` (deliberately uncut — no connector has been needed). Phase 2 is
> built: `awo ui`, `awo context`, `awo doctor`, `awo upgrade`, model tiering, the QA
> gate as a command. Phase 3 has begun: `awo publish` writes a MongoDB projection and
> [`awo-dashboard`](https://github.com/supanut9/awo-dashboard) reads it.
>
> A full multi-agent dogfood has run: a requirement taken through intake, planning,
> six implementation tasks across two repos by Codex workers, and a high-tier QA gate
> that found the composed feature broken. **§9 now holds 50+ findings from real use** —
> read it before adding anything, because most of the enforcement in this design
> exists because something failed first.

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
| `awo goal verify <goal-id>` | Assemble the QA gate: definition-of-done, every task's branch/diff/test-evidence, and the **high-tier** read-only invocation to review it (§7.1). |
| `awo goal verdict <goal-id> --pass\|--gap` | Record the gate's outcome: `--pass` verifies the in-review tasks; `--gap` files the finding as a new requirement. |
| `awo task run <task-id>` | Execute a task; writes state + a log. |
| `awo task show <task-id>` | View a task and its last run. |
| `awo log <...>` | View run history + audit trail. |
| `awo task list [--status <s>]` | List tasks with lifecycle status; `--status blocked` is the "needs me" view. |
| `awo task status <task-id> <status>` | Move a task's lifecycle state by hand (§7.4). The only way to reach `cancelled`. |
| `awo task event <task-id> <kind>` | Append a progress event to the task's open run (§7.4). |
| `awo task complete <task-id> --outcome <o>` | Close the open run: writes the log, index line, and lifecycle transition. `--gate` routes success to `in-review`. |
| `awo task verify <task-id> [--reject]` | QA gate (§7.1): approve an `in-review` task to `done`, or reject it back to `todo`. |
| `awo agent add <name>` / `agent list` | Install an agent from `catalog/agents` (§7.1). |
| `awo skill add <name>` / `skill list` | Install a skill from `catalog/skills`. |
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

**Built in v0.0.25**, with one deviation from §7.6 as written: the user chose
**BYO-database** over a scoped token — the connection string is theirs, in
`.workspace/credentials/mongo.env` (gitignored, per-machine), and `awo publish`
writes four collections directly. The token model's argument still stands and is
recorded above; the caveat that matters in practice is that a URI grants far more
than "write these four collections", so it should be a least-privilege user scoped
to one database. Absent that file, publishing is off and no network call is made.

The consumer is **`awo-dashboard`** (`github.com/supanut9/awo-dashboard`): Next.js
App Router, read-only, keyed on `workspaceId`. It reuses the projection rather than
the files, and its most useful screen is the one this plan could not build locally —
success rate and average attempts **per tier and effort**, which turns §12.9's
open question into a table. Authentication and multi-tenancy are **not** built, and
its README says so plainly rather than implying otherwise.

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
6. **Analytics** — added in v0.0.28, and the one view that answers a design question rather than reporting state. Outcomes grouped by **tier / effort**: runs, success rate, **average attempts**, average and total duration, plus a count of successes that carried no test evidence. §12.9 said the tiering policy was a hypothesis and the log was where it would be settled; this is where it gets read.

   The number that matters is **attempts**, not success rate: a cheaper tier that needs three goes has given back what it saved. The view says so, and also says what it cannot distinguish — attempts count reruns of the same task, so an environmental failure inflates them exactly like a model failure. It is a prompt to go and look, not a verdict.

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

#### Manual and auto sync (built in v0.0.29)

```sh
awo publish              # manual — push the current projection
awo publish --watch      # auto — push on every change, debounced 2s
awo publish --dry-run    # what would go, without connecting
```

`--watch` is a **watcher, not a hook inside the commands**, and that placement is the
whole point of §3.8: nothing in `task run` or `task complete` waits on the network, so
a dead connection or an expired credential degrades the dashboard and never the work.
It debounces because one run writes `state.json`, an event line and an index line
within a second of each other, and it refuses to overlap itself — a slow push must not
let a burst of edits become a pile of concurrent connections. A failed push is
reported and the watcher keeps running.

#### The outbox — how publishing stays non-blocking

```
1. Run writes local state + events.  COMMITS.        ← authoritative, done
2. Same records appended to .workspace/outbox/ (gitignored).
3. A flusher drains the outbox to the API — async, retrying, allowed to fail.
```

A dead network, an expired token, or a dashboard outage degrades the *board*, never the *work*. When connectivity returns the outbox replays in order, so the remote converges rather than silently losing history. This is what makes "never blocking" (§3.8) real rather than aspirational — without it, the first outage either stalls an agent mid-task or drops runs permanently.

#### Does the user have to set anything up? No.

MongoDB creates a collection on first write, so there is nothing to provision — and
since v0.0.30 `awo publish` also **creates the indexes idempotently on every run**
(`workspaceId`+`goalId`, `workspaceId`+`status`, `workspaceId`+`runId`, `updatedAt`).
That was a genuine omission: without them every dashboard query is a collection scan,
and nobody is going to run `createIndex` by hand. Adding a connection string is the
whole setup.

#### How much detail travels — `summary` vs `full`

```jsonc
"publish": {
  "detail": "full",                                   // default: "summary"
  "redact": { "prompts": false, "filePaths": false }
}
```

- **`summary`** (default) — statuses, counts, model/tier/effort. Nothing describing the
  work leaves the machine.
- **`full`** — additionally each task's body, the goal's definition-of-done, the
  requirement behind it, and **every run's markdown record and event stream** (a fifth
  collection, `events`, one document per run). This is what a hosted dashboard needs to
  show what `awo ui` shows.

`full` is opt-in rather than the default because that prose describes private code and
private prompts. `redact.prompts` additionally strips the verbatim request from run
records even under `full`, since the prompt is the likeliest place for something the
author would not choose to put on a shared cluster.

Event streams live in their own collection deliberately: a board query should never
drag run prose along with it.

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

32. **A run that changed 8 files and committed reported `reposChanged: []`.** The index derived that field only from `repo.diff` events, but the worker reported its work as `test` and `commit` events instead — so `awo log list --repo <name>` silently missed a run that had touched that repo. Fixed to collect any event carrying a `repo`, and to fall back to the task's `targets` when a `commit` event exists but nothing named a repo. Lesson: **a derived field must accept every shape the producers actually emit**, not just the one the schema author had in mind; and the producers here are agents, who will use whichever event kind reads most naturally.

33. **Uninstallable roles silently downgrade the model tier.** The planner assigned "FAQ data model" to `software-engineer` (low tier → cheapest model) because `data-engineer` lives in `catalog/agents/` and nothing installed it — the same missing-command gap as item 14, now with a quality cost rather than a wasted download. Schema design ran on the cheapest model in the policy. Fixed with `awo agent add` / `awo skill add` (plus `list` for both), and `plan-a-goal` now tells planners to install the right role and to set `tier: high` on thinking-heavy tasks. Lesson: **a capability that exists but cannot be reached will be silently substituted for whatever is reachable** — and the substitution is invisible, because the plan still looks complete.

34. **Worktree isolation was honour-system, and an agent invented its own path.** `isolate-task-worktrees` is a rule and a skill, but nothing created the worktree, so a worker placed it at `<workspace>/.worktrees/…` instead of §4's `repos/.worktrees/…` — outside the gitignored path, so its contents could have been committed into the workspace. Isolation itself held (the shared checkout was untouched), but by luck of instruction rather than construction. `task run` now creates the worktrees, announces them in the event stream, and prints where to work; `--no-worktree` opts out loudly. Lesson: **for anything a rule requires, ask what creates it** — an unenforced convention is a coin flip that happens to have landed well.

37. **The worktree fix advertised isolation that had failed — found minutes after shipping it.** git allows a branch to be checked out in exactly one worktree. For a resumed task whose branch was already held by an earlier (stray) worktree, `worktree add` failed, the error was swallowed, and `task run` still printed `work in: repos/.worktrees/…` — a directory that did not exist. A worker told to work there would have either failed or, worse, fallen back to the shared checkout. Fixed by looking up which worktree currently holds the branch and **reusing that path** (which is also where the prior work lives, so a resumed task recovers it), and by printing `WARNING: no isolation for <repo>` when creation genuinely fails. Lesson: **a guard that reports success on failure is worse than no guard** — the previous honour-system version at least did not lie. Also: `catch {}` that swallows an error is how a safety feature becomes a decoration.

40. **Worktree isolation and sandboxed workers are incompatible unless the invocation says otherwise — the worker could edit but not commit.** A worktree's `.git` is not a directory but a pointer: `gitdir: <repo>/.git/worktrees/<name>`, which lives **outside** the workspace. A worker launched with `codex exec -s workspace-write` could therefore write source files and run the whole suite (67 suites / 1664 tests green) and then fail to create the commit, because git had to write that external gitdir. The work survived only as 9 uncommitted files. Fixed by making the printed invocation *actually runnable*: `task run` now emits `-C <worktree> --add-dir <repo-holding-.git>`. Two lessons: **isolation that the sandbox does not know about is not isolation, it is a trap**; and if a tool prints a command, the command must work as printed — a "hint" that fails is worse than no hint, because it looks authoritative.

44. **Dependent tasks got worktrees branched from `develop`, so the dependency chain silently broke.** `awo` enforced `dependsOn` for *ordering* — refusing to run a task whose dependency wasn't `done` — while cutting every worktree from the repo's current HEAD, so the dependent branch lacked its predecessor's commits. `SHOP-T3` began without `SHOP-T1`'s entity even though it had waited for it; the prompt asserting "T1 is in your history" was simply false. Only `SHOP-T2` escaped, because an agent had created its worktree from T1's commit before this code existed. Now the branch is cut from the nearest `dependsOn` branch that exists in that repo, and `task run` prints `from feature/SHOP-T1` so the base is visible rather than assumed. Cross-repo dependencies correctly get no base. Lesson: **enforcing an ordering constraint without enforcing the artefact it implies is worse than not enforcing it** — the ordering created confidence that the code relationship was handled.

45. **A fresh worktree has no `node_modules`, so `tests-must-pass` was unsatisfiable.** Isolation gave every task a clean checkout — and no installed dependencies, since they are gitignored. The worker reported "jest not found" and honestly filed the task as unverified, meaning an always-on rule quietly became unenforceable *because of* another rule. Fixed by symlinking the repo's `node_modules` into new worktrees: instant, no disk cost, and node resolves through it. Lesson: **a rule that another rule makes impossible to satisfy will be marked "unverified" forever** — check that your constraints can all hold simultaneously.

46. **The linked `node_modules` had to be writable, or the test run failed as a permission error.** Vitest writes `node_modules/.vite-temp`; with the link pointing into the repo and the sandbox granting only the git dir, the suite died on permissions rather than on a test. Granted alongside the git dir — caches and dependencies, never source, which is the distinction item 42 was about. The first task able to actually run tests was `SHOP-T5`, five tasks in.

49. **`tests-must-pass` was a rule nothing could enforce, so it was enforced.** A task could close as `success` having recorded no evidence that anything ran — which is precisely how six tasks each "passed" and composed into a broken feature (§9 item 47). `task complete --outcome success` now requires a `test` event in the run, or `--untested "<why>"`, which is recorded in the run log as `UNTESTED: …` so the exemption is visible to whoever reads it later. Failure needs no evidence: a failed run is allowed to have run nothing. `doctor` gained the cheap version of the same check — any task `done`/`in-review` whose run recorded no `commit`/`repo.diff`, or no `test`. Lessons: **an always-on rule with no checkable artefact is a wish**; and the right shape for enforcement is *demand evidence or demand a reason*, never simply block — the escape hatch is what keeps the gate honest instead of encouraging people to fake a test event.

55. **The published projection was too thin to be useful, and no indexes existed at all.** Two omissions found by asking the obvious question — "when someone adds a connection, does it just work?". Collections do appear on first write, so setup genuinely is just the connection string; but **no indexes were ever created**, meaning every dashboard query was a collection scan, and expecting a user to run `createIndex` by hand is expecting something that will not happen. Now created idempotently on each publish. Separately, the projection carried only statuses and counts, so the hosted board could show *that* a task existed but nothing about it — clicking a card did nothing, because there was nothing to show. Fixed with `publish.detail: "summary" | "full"`, where `full` adds task bodies, the goal's definition-of-done, the originating requirement, and each run's markdown record and event stream. Two design notes: event streams get **their own collection** so a board query never drags prose along with it; and where detail is absent the hosted page **says so and explains how to enable it**, because an empty page is indistinguishable from a task that did nothing — the worse failure. Lesson: **"it works" and "it is usable" are different questions, and the second is the one a user actually asks.**

54. **"Always use the latest version" and "it must build" collided, and the collision was worth resolving rather than dodging.** `typescript@7` is the native rewrite and no longer exposes the compiler API Next's build worker used, so `next build` failed outright with a working `tsc --noEmit`. The two obvious moves were to pin back to TypeScript 6 or to abandon the standing preference. The third — enabling `experimental.useTypeScriptCli` so Next shells out to `tsc` — keeps both, and is the direction Next itself points. Lessons: **a typecheck passing is not a build passing** (different toolchains, different failure); and when a standing preference meets a hard constraint, look for the configuration that satisfies both before treating it as a choice between them. Recorded in the dashboard's config with the reason, so the next person does not "clean up" the flag.

53. **The tiering evidence, once it was finally visible in one table, was not flattering to the cheap tier.** With outcomes grouped by tier/effort across the dogfood's 24 runs: `low / low` — **10 runs, 50% success, 4.1 average attempts**, against 1.0 attempts for the earlier untagged runs. That is the shape §12.9 predicted would matter — the saving handed back in retries. The honest caveat is recorded alongside it in the UI: most of those retries were *environmental* (an orphaned process, a sandbox that could not reach git, a sandbox that reached too far), not the model producing bad code, and the metric cannot tell those apart. So it is evidence worth acting on and not proof: **a number that mixes causes should be presented as a reason to look, never as a verdict** — which is also why the view names the limitation instead of leaving the reader to infer it.

52. **`awo task dispatch` closes the orchestration loop, and its design is almost entirely made of previous findings.** Blocking until the worker exits comes from item 35 (a one-shot orchestrator deferred to a turn that never came, stranding uncommitted work). Failing loudly on a missing runtime comes from item 41 (a Codex orchestrator silently became the worker). Keeping the worker's raw stdout comes from every occasion a summary was insufficient to explain what went wrong. Building argv rather than a shell string avoids the quoting bugs that already cost two restarts. Closing stdin comes from the 20 minutes lost to a worker waiting on input. And recording a dispatched success as `--untested` rather than synthesising a `test` event is item 49's rule applied to itself. The lesson is about sequencing rather than any one mechanism: **a feature deferred until its prerequisites exist arrives mostly written**, because each prerequisite was a failure that taught what the feature must not do.

51. **The QA gate was the most load-bearing step and the least supported — now it is a command.** Item 47 established that the goal-level review is what makes parallel low-tier work safe. Yet running it meant assembling everything by hand: locating each task's worktree, extracting commits and file lists, pasting the definition-of-done and acceptance criteria, choosing a model, remembering read-only, and then hand-writing the verdict into the log. Every one of those steps was a chance to do the gate badly or skip it. `awo goal verify` now assembles the brief — including flagging tasks that closed **without test evidence**, which is exactly what a reviewer should distrust first — resolves the **high** tier regardless of what the tasks used, and prints a **read-only** invocation. `awo goal verdict --pass|--gap` records it: pass verifies the in-review tasks (rolling the goal to `done` via §7.4), gap files a new requirement per `file-bug` instead of a silent fix.

    Two design points worth keeping. The command **assembles but does not execute**, consistent with §9 item 2 — the same boundary as `task run`. And read-only is enforced per runtime (`-s read-only` for codex, plan mode for claude, which is the one place plan mode is exactly right per §12.7): **a reviewer that can edit is a reviewer that fixes instead of reporting**, and a fix that arrives that way has no requirement, no task and no log entry.

50. **`/.worktrees/` at the workspace root is now gitignored.** An agent invented that path (§9 item 37) and it sat outside the ignored `repos/` tree, so an entire checkout could have been committed into the workspace. The path is no longer used, but ignoring it costs one line and the next agent may well invent it again.

48. **Low effort was removed from the library, on the evidence of item 47.** Keeping it would have meant offering a setting whose only demonstrated effect was producing work that passed locally and failed at integration. The remaining honest use — commit messages, type conversions — is not worth a tier, and `medium` covers it. Two design notes: the change **tolerates** `low` in existing policies and normalizes it to `medium` rather than erroring, because breaking a workspace to enforce a taste is the mistake §9 item 21 already taught; and the `low` **tier** still exists (it selects a cheaper *model*) — only the low *effort* is gone, which keeps the two axes independent as §12.2 requires. Caveat recorded honestly: the run varied model and effort together, so it does not prove effort alone was responsible.

47. **The tier distinction earned its keep, decisively — and this is the finding the whole exercise existed for.** Six tasks were implemented by `gpt-5.6-luna` at `effort=low`; each passed its own lint/tests and each was individually plausible. The goal-level QA gate, run by `gpt-5.6-sol` at `effort=high` and read-only, returned **GAP** and found the composed feature functionally broken:
    - the public response shape did not match what the PDP read (`{value:{items}}` vs `data.items`), so the FAQ list was **always empty** — the headline feature never worked
    - the admin UI sent `productNo` where the controller required an integer `productId`
    - **the admin BFF was unauthenticated** and attached the server-side admin key for any caller, neutralising `AuthPrivateGuard`
    - FAQ rows carried no `ContentStatus`, only `isActive`, so unpublish/republish clobbered deliberately inactive entries
    - a duplicate `ProductFaqDal` provider lacked its repository registration and would likely fail Nest DI at startup
    - no branch registered `faq` in existing PDP layouts, so the section could not appear even with correct data

    Every one of these is a *cross-branch contract* defect: invisible from inside any single task, and precisely what a low-effort worker focused on its own file set cannot see. Lessons: **parallel low-tier implementation without integration verification produces confidently broken work**; the QA gate is not ceremony but the only step that looks at the whole; and "each task passed" is not evidence that anything works. Also note what the gate *passed*: BFF-only access, fail-closed empty rendering, and sanitisation on both write and render paths — the review was discriminating, not merely harsh.

43. **Validation ran after the side effect, so a config typo left an abandoned run.** An unsupported effort in the models policy threw from `resolveModel` — which was called *after* `task run` had already moved the task to `running` and written `state.json`. A pure config mistake therefore produced an open run that `doctor` then reported as abandoned, and the task could not be re-run until someone closed it. Model resolution now happens before any state is touched, matching how `targets` validation already worked. Lesson: **order every check before the first side effect**, not merely somewhere in the function — and the tell was that a test could not perform its *second* assertion because the first failure had corrupted the state it needed. Related: reading tier entries straight from JSON skipped the parser entirely, so the effort was never validated at all; validation you can bypass by reading a field directly is not validation.

42. **The fix for item 40 caused the exact violation the rails existed to prevent.** Granting the worker `--add-dir <repo>` so it could commit handed it the whole real checkout. The next worker promptly edited `develop` directly — 5 files in a repo that had been clean — instead of the worktree it was pointed at. The rails had held all session under honour-system instructions, and were broken by a *safety feature*. Corrected to grant only `<repo>/.git`: enough to write refs and commit, not enough to touch source. Lessons, in order of importance: **a permission granted for one purpose will be used for every purpose it permits** — scope it to the narrowest path that satisfies the need; and **a fix to a safety mechanism deserves the same adversarial check as the original**, because it arrives wearing the credibility of a fix. Recovery: the agent's changes were saved as a patch before `git checkout --` restored the five files, so nothing was lost and the repo returned byte-identical to its pre-test state.

41. **Codex cannot spawn Codex, so orchestrator and worker must differ in runtime.** With `codex exec` as the orchestrator, every attempt to launch a `codex exec` worker failed to initialise its app-server client, and the orchestrator — to its credit — reported the deviation and did the work itself rather than pretending. The earlier Claude-orchestrator run had no such problem delegating to Codex. So a same-runtime chain is not currently viable on this setup, which is a constraint on multi-agent topology rather than on awo: **pick an orchestrator runtime different from the workers', or expect the orchestrator to silently become the worker.** Worth noting the failure mode is exactly the one §12 exists to prevent: the expensive coordinator quietly doing cheap work.

39. **The effort mapping was a guess, and the log could not even measure it.** `high`→high effort and `low`→low effort was written from plausible reasoning — judgment needs thinking, mechanical work does not — with no evidence, and the plausible-sounding claim "low effort saves tokens" can invert once retries are counted. Worse, `run.start` recorded tier and model but **not** effort, and the index recorded neither, so the hypothesis was unfalsifiable in its own logs. Fixed by recording `tier`, `model`, `effort` and `attempts` in the run index and adding `--tier` / `--effort` filters. Lesson: **when a design decision is a guess, the first job is not to defend it but to make it measurable** — and a knob whose effect is never recorded will be carried forever on the strength of the sentence that introduced it.

38. **`gpt-5-codex` is not available on a ChatGPT-account Codex, which made model-based tiering impossible.** The whole tier ladder assumed several models to choose between; this account has one (`gpt-5.4-mini`). The way out was already in the user's own `~/.codex/config.toml`: `model_reasoning_effort`. Tiering by **reasoning budget on a single model** — `effort: high|medium|low` — is now supported and emitted as `-c model_reasoning_effort=<effort>`, which is exactly the axis §12.7 had described as "not modelled yet". Lesson: **tiering is not inherently about model identity**; when the model set is fixed, effort is the knob, and a policy that can only express "which model" cannot serve a single-model account.

36. **`prepublishOnly` did not run the tests, and a shell `&&` chain hid a failure.** v0.0.14 was published while one test was failing: the publish command was `npm test … && npm publish`, and the chain gated on `grep` finding output rather than on the suite passing, so a red run still shipped. Two clean re-runs afterwards showed 52/52 and the failure did not reproduce — most likely disk pressure, since the machine was at 85% and a jest run had already hit a transient `ENOSPC`. Fixed by making `prepublishOnly` run `npm test`, so npm itself refuses to publish a red tree regardless of how the command was typed. Lesson: **a release gate belongs in the tool that releases, not in the sentence you happen to type** — and a flaky failure is still a failure until it is explained.

35. **A one-shot orchestrator cannot wait for its workers.** The orchestrator ended its turn with "I'll continue automatically when T2's worker reports back" — but `claude -p` exits when the turn ends, killing the child process. `SHOP-T2` was left `running` with an open run and ~8 files of uncommitted work stranded in its worktree; `doctor` correctly flagged the abandoned run. Nothing in awo can fix this — it is a property of how the orchestrator is invoked — so it belongs in the orchestrator's brief: **block synchronously on each worker; never defer to a future turn that will not exist.**

31. **The orchestrator was defaulted to plan mode, which would have broken it.** Following on from item 30, v0.0.12 set `mode: "plan"` on the orchestrator because "thinking work → plan mode" sounded right. It is incoherent: plan mode is read-only-until-approved, so an orchestrator in plan mode cannot run `task run`, write state, or spawn a worker — the actions that make it an orchestrator. It is equally wrong for a spawned worker: planning workers must *write* (`req new`, `task new`, `goal.md`), and a non-interactive worker in plan mode would emit a plan, wait for an approval that never arrives, and leave its run open — the abandoned-run state `doctor` already flags. Corrected to unset by default. Two lessons: **plan mode is a human-approval mechanism for an interactive session, not a property of a work tier**; and what thinking-heavy work actually wants is *reasoning budget*, which is a different axis and deliberately not modelled yet (§12.7).

30. **"Orchestrator" was modelled as a tier, and that was wrong.** v0.0.11 shipped `tier: orchestrator | worker` and sorted roles into the two, which quietly asserted that the PM *is* a coordinator and that a worker is cheap. Neither holds. The orchestrator is the **intermediary between the human and the work** — the session you talk to, not an entry in `agents/`; and every role is a worker whose tier depends on **what the work is**, so `data-engineer` designing a schema is high-tier while `software-engineer` applying a spec is low-tier. Corrected in v0.0.12 to `high | standard | low` with the orchestrator configured separately, plus a per-task `tier:` override for when the same role does unusually thinking-heavy work. The lesson: **naming a dimension after one of its values collapses two ideas that need to stay separate** — a tier ladder cannot double as an org chart.

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

## 12. Model tiering — one orchestrator, many workers

**Goal:** spend a high-end model where thinking happens and a cheap one where a written spec is merely executed, without re-teaching the workspace which is which every session.

### 12.1 Orchestrator is not a role

Two things that must not be conflated:

- The **orchestrator** is the intermediary between the human and the work. It is the session you talk to. It is **not** one of the roles in `agents/`, it has no tier, and it is configured once in the manifest. Workers act only when it says so.
- Every role in `agents/` is a **worker** — `product-manager` as much as `software-engineer`.

An earlier draft of this section made `orchestrator` a *tier* and sorted roles into it. That was wrong twice over: it implied the PM was a coordinator rather than a worker, and it implied "worker" meant "cheap".

### 12.2 Worker ≠ cheap. Tier follows the work

A worker's tier is a property of **the kind of work**, not of seniority:

| Tier | Kind of work | Default roles |
|---|---|---|
| `high` | Thinking: interpreting an ask, decomposing a goal, designing a data model, judging a definition-of-done, reviewing a change. Worth a strong model — and more *thinking budget*, which is a different knob from permission mode (see §12.7). | `product-manager`, `tech-lead`, `data-engineer`, `qa-engineer`, `code-reviewer`, `audit` |
| `standard` | Mixed — works from an agreed goal but still exercises some judgment. | `marketing-specialist` |
| `low` | Mechanical: implement a task that is already specified, commit, open a PR. The thinking happened upstream, so a cheap model saves tokens without losing much. | `software-engineer`, `release-engineer` |

`data-engineer` is `high` deliberately: schema and migration design has consequences that are expensive to reverse, which is thinking work regardless of the title. An unknown role defaults to `standard` — a wrong guess costs tokens at `high` and costs quality at `low`, so the middle is the safe failure.

### 12.3 A task can override its role's tier

The sharp version of "tier follows the work": the *same role* can do work of different tiers. `software-engineer` writing a one-line copy fix and `software-engineer` designing a caching layer are not the same. So a task may declare its own tier:

```yaml
# goals/<goal>/tasks/SHOP-T1-define-the-faq-data-model.md
agent: software-engineer
tier: high          # this particular work is thinking-heavy
```

### 12.4 Policy lives in the manifest

```jsonc
"models": {
  "orchestrator": { "runtime": "claude", "model": "opus" },
  "tiers": {
    "high":     { "runtime": "claude", "model": "opus" },
    "standard": { "runtime": "claude", "model": "sonnet" },
    "low":      { "runtime": "codex",  "model": "gpt-5-codex" }
  },
  "byRole": { "code-reviewer": { "runtime": "claude", "model": "opus" } }
}
```

Entirely optional: with no `models` key, built-in defaults apply (`opus` / `sonnet` / `haiku`), so no migration is needed.

**Cross-runtime is the point, and it already works.** Tier and model resolve *separately*: a task says its work is thinking-heavy, and the manifest decides what that means. Because the handoff between agents is **files, not shared context** (§3.7), the orchestrator and its workers need not be the same product — this plan's own dogfood had a Claude Opus session orchestrating `codex exec` workers. What is *not* portable is model names (`opus` exists only in Claude, `gpt-5-codex` only in Codex), which is why a choice is always a runtime+model pair.

### 12.5 Resolution order

```
tier:   task's `tier:`  >  agent's `tier:`  >  role default  >  standard
model:  agent's `model:`  >  byRole[agent]  >  tiers[tier]  >  built-in fallback
```

`awo task run` prints the resolved tier, where the tier came from, the runtime+model, and a paste-ready invocation (`codex exec -m …`, `claude --model … --permission-mode plan`, `gemini -m …`). It writes `tier`, `tierFrom` and `model` into the run's `run.start` event, so the log can later answer *"do low-tier runs fail more often?"* — the evidence needed before trusting a cheap model with more.

### 12.10 Choosing effort — the rule agents follow

Effort is **how long the model should think**, not a different level of intelligence.
Lower effort answers faster on fewer reasoning tokens; higher effort improves
completeness and accuracy on hard problems at the cost of latency and tokens.

**Only `medium` and `high` are selectable**, and `medium` is the default.

`low` was **removed on evidence** (§9 item 47), not taste: six tasks implemented at
low effort each passed their own lint and tests, and the composed feature was broken
— a response-shape mismatch that made the FAQ list always empty, an unauthenticated
admin route, and mismatched identifiers between caller and controller. Whatever low
effort saves on a task that writes code, it gives back at the review. A policy that
still says `low` is **read as `medium`** rather than rejected, so existing workspaces
keep working (§11.5).

`xhigh`/`max` are excluded for the opposite reason: they are quality-first settings
whose benefit must be measured before it justifies the latency and cost, and merely
listing them invites reaching for them by default.

| Effort | Use for |
|---|---|
| `medium` | Normal professional work, and the floor for anything that writes code — design an endpoint, implement a service, review a PR, a commit message, JSON→types |
| `high` | Interacting constraints or hidden failure cases — auth and token rotation, concurrency and caching bugs, migration planning, decisions expensive to reverse |

The decision test, shipped as the `pick-reasoning-effort` rule:

1. Would a wrong answer be easy to spot? → `medium` suffices.
2. Are there many interacting constraints? → `high`.
3. Could an error cause security, financial, production or migration damage? → `high`.
4. **Does the work have to agree with something it cannot see** — another repo's
   response shape, another task's DTO, an auth contract? → `high`, however small the
   diff. This is the one the dogfood added, and it is the one that was missed.

**Length is not difficulty.** A long but verbose prompt stays `medium`; a short
question about token revocation is `high`. And an invalid effort is now a hard error
raised *before* the run opens, so a config mistake cannot leave an abandoned run
behind (§9 item 43).

### 12.9 How do we know which effort is right? We don't yet — so the log measures it

The tier→effort mapping shipped here (`high`→high, `low`→low) is **a hypothesis, not a finding**. The reasoning is that judgment work benefits from more thinking while mechanical work executes a spec that already contains it. That may be wrong in an expensive direction: low effort on a code-writing task can produce work that needs two or three retries, costing more tokens than one high-effort run would have.

So the index records what actually ran — `tier`, `model`, `effort`, and `attempts` — and `awo log list --tier low --status failed` / `--effort high` can slice it. That makes the question answerable with the workspace's own history:

- do low-effort runs fail more often than high-effort ones?
- do they need more `attempts` to reach `done`?
- is `durationSec × attempts` actually lower at low effort?

Until enough runs exist to answer that, **the policy is a default to be measured, not a recommendation**. Anyone is free to set every tier to the same effort and let the log tell them whether the distinction earns its keep. This is the payoff of §7.3 being an append-only index rather than a pile of prose: a design guess becomes a query.

### 12.8 Quota fallback

A run can die because the primary model is *unavailable*, not because the work was
wrong: a plan hit its limit, a rate limit bit, or the CLI is not installed. Any
choice may therefore declare where to go instead:

```jsonc
"tiers": {
  "high": {
    "runtime": "claude", "model": "opus",
    "fallback": { "runtime": "codex", "model": "gpt-5-codex" }
  }
}
```

`awo task run` prints both — the primary as `hand to:` and the substitute as
`if quota:` — and `models.orchestrator` may declare one too, so a session that
runs dry knows what to become.

**Declared, not guessed.** awo does not detect exhaustion (it never spawns the
model — §12.6) and it deliberately does not invent a substitute: "the same class of
model on another runtime" and "a cheaper model on the same runtime" are very
different trades, and only the person paying can say which is acceptable. When
dispatch is eventually built, this is the field it consults on a quota error; until
then it is instruction for whoever is orchestrating.

### 12.7 Plan mode is not a tier setting

`mode` exists as an optional pass-through, but **nothing sets it by default — including the orchestrator.** An earlier draft defaulted the orchestrator to plan mode, which was incoherent:

- Plan mode is read-only-until-approved. An orchestrator in plan mode could not run `task run`, write state, or spawn a worker — precisely the actions that make it an orchestrator.
- It is no better for a spawned worker: a planning worker must *write* (`awo req new`, `awo task new`, `goal.md`), and a non-interactive worker in plan mode would emit a plan, wait for an approval that never comes, and leave its run open forever — the abandoned-run state `doctor` warns about.

Plan mode is a **human-approval mechanism for an interactive session**, not a property of a work tier. What thinking-heavy work actually wants is *more reasoning budget*. That is a separate axis from permission mode, and it **is** now modelled as `effort:` alongside `model:` — never folded into `mode:`.

```jsonc
"tiers": {
  "high": { "runtime": "codex", "model": "gpt-5.4-mini", "effort": "high" },
  "low":  { "runtime": "codex", "model": "gpt-5.4-mini", "effort": "low"  }
}
```

This turned out to be necessary rather than ornamental: a ChatGPT-account Codex exposes only `gpt-5.4-mini`, so there is no second model to tier *with*. Effort makes tiering work on a single model — same model, more thinking — and is emitted as `-c model_reasoning_effort=<effort>` (§9 item 38).

### 12.6 `awo task dispatch` — built in v0.0.27

Long deferred, because it makes awo an agent runtime and a runaway worker in a linked
repo is a bad afternoon. The prerequisites named here are now met: `task run` creates
the worktree (branched from the dependency, dependencies linked), the sandbox grant is
narrowed to `<repo>/.git`, and a task cannot close as `success` without test evidence.

```sh
awo task dispatch SHOP-T3                 # opens the run, spawns the worker, waits
awo task dispatch SHOP-T3 --dry-run       # model + command, no state touched
awo task dispatch SHOP-T3 --timeout 20 --no-complete
```

Two dogfood failures shaped it, and both are handled **by construction rather than by
instruction**:

- **It blocks until the worker exits.** §9 item 35: a one-shot orchestrator ended its
  turn saying it would "continue when the worker reports back", which killed the child
  and stranded 9 files of uncommitted work. An orchestrator cannot be trusted to wait;
  the command waits.
- **A spawn failure fails the task loudly.** §9 item 41: when a Codex orchestrator
  could not spawn a Codex worker, it quietly did the work itself — the expensive
  coordinator doing cheap work, the exact failure §12 exists to prevent. A missing
  runtime now exits 127 and blocks the task.

Also deliberate: the worker's **own stdout is kept** beside the run as
`<runId>.worker.log`, because a one-line summary cannot diagnose a worker that went
wrong; the command is built as **argv, not a shell string**, so there are no quoting
bugs and no injection through a task name; **stdin is closed**, since a worker waiting
on input it will never receive hangs forever; and a dispatched success is recorded as
`--untested "dispatched worker did not record a test event"` rather than faking
evidence the worker never produced.

`task run` remains for when you want to invoke the model yourself — dispatch is the
convenience, not the replacement.

---

## 13. Session orientation — `awo context`

**The problem:** a fresh session knows nothing. Left to itself it globs the tree,
reads AGENTS.md, several instructions, every goal folder, `state.json` and some of
`logs/` — spending tokens to reconstruct facts the workspace already knows, and
often getting them subtly wrong (a requirement still in intake is invisible on the
board; a task can be `running` with an abandoned run).

**`awo context`** prints that orientation in ~20 lines: project and version skew,
the orchestrator's model, linked repos and any that are missing, each goal with its
progress, tasks by status with blocked/running ones explained, requirements still in
intake, the last three runs with tier/effort/attempts, the success rate, and — the
most useful line — **what to do next**. `--json` gives the same data to a machine.

`AGENTS.md` now tells agents to run it first and *not* to scan.

### 13.1 Derived, never stored

A `CONTEXT.md` or `MEMORY.md` that agents maintain was the obvious alternative and
is the wrong shape here. It would be a second source of truth for state that already
lives in the manifest, `state.json` and the run index — and it would rot exactly
like a stale comment, with nothing to reveal that it had. §3.1's rule (derived
artifacts, one source of truth) applies to summaries as much as to `repos/`.

The token saving is real but comes from **not scanning**, not from caching: one
command reads the handful of files that matter. A cache would save less and cost
correctness.

What genuinely *is* durable memory already exists and is already append-only: the
run log (§7.3). "What did we try, what happened, what was deferred" is answered by
`awo log list` / `awo log show`, not by a summary someone has to remember to update.
The one thing neither covers is *why* a decision was made — that belongs in the
requirement's Clarifications or the goal's Scope, next to the work it constrains.


## 14. Workspace layout, revised (0.0.32)

The original layout (§4, §7.3) was designed before there was any real usage to
look at. One day of dogfooding produced a tree with five separate structural
problems, all of them invisible until the directory had real content in it:

1. **`logs/runs/<date>/` put everything in one flat directory.** 39 files after a
   single day, four filename variants per run (`<runId>.md`,
   `<runId>.events.jsonl`, `<runId>.worker.log`), and no way to ask "every attempt
   at SHOP-T2" without globbing a date you had to already know.
2. **Goal directories carried a slug truncated at 40 characters**, so a real title
   produced `SHOP-G1-faq-section-on-product-detail-page-with-` — cut mid-word,
   trailing hyphen. Worse, it coupled a path to a title, so editing the title
   would have stranded the directory.
3. **An unpromoted requirement had no home.** It sat in `goals/` as
   `SHOP-R2.md`, where it reads as a goal and is not one.
4. **`goal verify` wrote `logs/verify-<goalId>.md` directly**, bypassing the run
   writer: invisible to `awo log list`, and silently overwritten by the next gate
   on the same goal.
5. **Worktrees existed in two places at once** — `.worktrees/` from before the
   move and `repos/.worktrees/` after it — so a workspace upgraded across that
   change had full repo checkouts in a location nothing reads.

### 14.1 The layout

```
requirements/<KEY>-R#.md
goals/<KEY>-G#/{goal.md, requirement.md, state.json, tasks/<KEY>-T#.md}
logs/<date>/{runs.jsonl, runs.md}
logs/<date>/workers/<time>-<slot>.log
repos/.worktrees/<repo>/<taskId>
```

Two rules generate all of it:

**Paths are named for IDs, never for titles.** An ID is permanent and a title is
not, so the ID is the only thing safe to put in a path. Titles live in
frontmatter, where the CLI and both dashboards read them from.

**A run is a directory, not a filename prefix.** The runId is the directory, so
filenames inside are fixed (`record.md`, `events.jsonl`, `worker.log`) and a new
artefact is a new file rather than another suffix for every reader to parse.

**Shard by day, then by task.** 0.0.32 filed runs under their task with no date
shard, which made "every attempt at T2" an `ls` but gave up chronological browsing
and let the top of `logs/` grow one directory per task forever. 0.0.33 puts the
date back on top with the task under it: a day's directory holds only that day's
work, already grouped by task rather than interleaved by timestamp. The cost is
that one task's history now spans the days it ran on — which `awo log list --task`
answers from the index. That is what an index is for, and it never moved.

### 14.2 What did not change

The **runId string is untouched**. It is the key in `index.jsonl`, in
`state.json`, and in every already-published Mongo document, so changing it would
have meant a data migration on the hosted side too. Only the path derived from it
moved. `resolveRunFile` still reads the pre-0.0.32 locations, so a workspace that
has not upgraded shows its history rather than appearing to have lost it.

### 14.3 Findings this produced

56. **A layout is a hypothesis until it holds real content.** Every one of the
    five problems above was invisible in the fixture and obvious in the first real
    workspace. Date-sharding looked like it bounded directory size; filing by task
    actually does.
57. **`.new` conflict files were written once and then never mentioned again.**
    `AGENTS.md.new` — beside the *canonical instruction file* — sat unresolved
    through several upgrades, meaning two versions on disk and no way for an agent
    to know which one was current. `awo doctor` now reports unresolved conflicts,
    because a warning delivered once is a warning lost.
58. **Anything that writes outside the run writer becomes invisible.** The verify
    brief proved it: it was real work, on disk, and absent from every view. The
    fix is not "remember to log it" but "there is one writer".

59. **Worktree isolation only covers repos listed in `targets:`.** SHOP-T6's body
    named `repos/learn-service-ui` in prose — to say it had *no* relevant code —
    while `targets:` listed only `learn-shop-online-ui`. No worktree was created
    for the mentioned repo, so when a worker went looking there it wrote five
    files straight into the symlinked checkout on `develop`, outside any branch,
    outside the gate, and outside the log's `reposChanged`. The rail is real but
    it is keyed on the declaration: a repo an agent can *read* is a repo it can
    *write* unless something stops it. Prose is not a declaration.

60. **Two good properties can trade against each other, and the index is the
    tiebreak.** Date-sharding gives chronological browsing and bounded
    directories; task-filing gives "every attempt at this task" as one `ls`. 0.0.32
    took the second and lost the first. The resolution was not to pick harder but
    to notice that only one of them needs to be a *path* — the other is a query,
    and `logs/index.jsonl` already answers it. Structure the tree for browsing;
    leave lookup to the index.

61. **A migration test that runs every migration in one hop tests a path most
    users never take.** The 0.0.33 reshard rewrote no index pointers, and the test
    passed anyway: it started from a pre-0.0.32 workspace, so 0.0.32's rewrite ran
    *after* the code that computes the new paths and produced correct pointers by
    accident. The real workspace had run 0.0.32 in an earlier session, hit 0.0.33
    alone, and came out with all 24 `detailFile` pointers dangling. `awo log list`
    still worked — it resolves by runId — so nothing looked wrong. Migration tests
    must start from *each* shipped version, not only the oldest.


## 15. The log layout, settled (0.0.35)

Four layouts shipped in one working session, which is three too many. Worth
recording why, because the mistake was not any individual shape:

| version | shape | what broke |
|---|---|---|
| ≤0.0.31 | `logs/runs/<date>/<runId>.{md,events.jsonl,worker.log}` | 39 files in one directory after a single day; three filename variants to parse |
| 0.0.32 | `logs/<taskId>/<stamp>/` | lost chronological browsing; one top-level directory per task, forever |
| 0.0.33–34 | `logs/<date>/<slot>/<time>/` | three levels before a file; `_adhoc`, goal and task directories mixed; machine-named leaves |
| **0.0.35** | `logs/<date>/{runs.jsonl, runs.md}` | — |

What the first three share is that **the number of filesystem entries grows with
the number of runs**. A day of real work is unreadable however you nest it, so the
answer was not a better nesting but fewer entries: a day is two files that grow
internally.

```
logs/2026-07-28/runs.jsonl   every event, and one row per run. Append-only.
logs/2026-07-28/runs.md      every record, behind <!-- awo:run <runId> --> markers.
logs/2026-07-28/workers/     raw worker stdout, only when one was dispatched.
```

### 15.1 Why `.jsonl` and not `.json`

A JSON document must be read-parse-rewritten to add a row, so two workers
finishing in the same moment silently lose one of the writes. Appending a line is
atomic. Parallel workers are the normal case here, not an edge one.

### 15.2 Why no global index

`logs/index.jsonl` duplicated rows that the day files already held, and
duplication is how they drift: 0.0.33 moved every record and left all 24 pointers
dangling. `awo log list` now reads the day folders. One writer, one copy.

### 15.3 Why worker output stays out

It is the spawned CLI's raw stdout — hundreds of KB, and interleaved nonsense if
two concurrent workers shared a file. `runs.jsonl`/`runs.md` are what *awo*
recorded; a worker log is what the runtime emitted, including everything the agent
never reported. Keeping them apart is the difference between what an agent claims
and what actually happened.

### 15.4 Findings

62. **Asking the user to choose between layouts costs one message; guessing costs
    four migrations.** Each of the first three shapes was a reasonable reading of a
    one-line comment, implemented immediately. Showing four candidate trees side by
    side and asking would have reached 0.0.35 directly. When a change is
    structural and irreversible-ish, the cheap move is to render the options.
63. **A migration must describe the layout it migrates FROM, in literal paths.**
    The 0.0.33 migration called `detailFile()`; when that helper's meaning changed,
    the migration silently retargeted and stranded the index. Migrations are
    historical documents and cannot share code with the present.
64. **A spliced edit can silently delete a neighbour.** Rewriting the migration
    array by cutting from one entry to `];` removed the unrelated 0.0.2
    `workspaceId` backfill along with it. Only the test that asserted that
    migration *by name* caught it — which is the argument for naming what you
    assert rather than counting it.


## 16. Where the human belongs

The motivating question: if a human must validate everything, the agent saved
nothing. The research consensus for 2026 is that **the bottleneck moved from
generation to verification** — AI-authored PRs wait 4.6× longer for a reviewer, and
main-branch throughput fell ~7% year over year even as feature-branch throughput
rose. Reviewing every diff at human reading speed consumes the entire speedup.

The way out is not reviewing less but **reviewing a different artefact**. Defects
concentrate at specification-implementation mismatches and integration boundaries,
not inside isolated functions — which is exactly what the SHOP-G1 dogfood produced.
So human attention is spent, in order of leverage:

1. **The requirement and its definition of done** (10–20 min). Short text, highest
   consequence, and the only artefact where the human's judgment is irreplaceable.
   Given-When-Then is the shape of a test, so writing it well converts human review
   into machine checks.
2. **The seams between tasks** — `dependsOn` and the interfaces. No worker can see
   the seam it is on one side of.
3. **What counts as evidence** — once per repo, not per task.
4. **The gate verdict** — judging a curated argument with citations, not 2,000 lines
   of diff.
5. **Irreversible actions** — migrations, deploys, deletions. The trigger is
   reversibility and blast radius, not code quality.

Line-by-line reading belongs on a short list of surfaces (auth, money, migrations,
public API, data deletion), not on everything.

### 16.1 Why the evidence gate had to change first

Until 0.0.36 the gate accepted any `test` event, so it was satisfied by an agent
typing "full jest suite green". The dogfood produced 5 such events across 24 runs,
all prose, and two tasks reached `done` with a commit and no test event at all.
Every downstream gate was therefore inheriting an agent's word for it.

This is not a discipline problem. Analysis of agent-authored test patches finds
~80% carry weak or no oracle signals, and ~18% strong oracles for Codex
specifically — which is what the dogfood's workers were. A workflow that accepts
"tests passed" as a string inherits all of it.

So `awo task event <id> test --run "<cmd>"` executes the command and records exit
code, duration and parsed counts. Only that satisfies `complete --gate`.

### 16.2 Deciding whether the code or the test is wrong

`--baseline` runs the same command at the branch point, in a throwaway worktree so
the agent's uncommitted work is never touched. Four cases, three of them decided
mechanically (§16 table in README). The undecidable one — a test edited alongside
the code it covers — is flagged `test-and-code-changed` and blocked from reaching
`done`, because a test edited into agreement with the code proves nothing and
*neither file can be the tiebreak*. The acceptance criteria are, and if they do not
settle it the task belongs in `blocked` with the question.

### 16.4 Intake: the one gate that cannot be delegated

Requirements arrive two ways and both are normal — a PM already wrote one in JIRA,
or someone says "we need an FAQ on the product page" with nothing behind it.
Treating those identically is the mistake: the first is specified, the second is a
wish.

```
draft ──(PM role writes acceptance criteria)──▶ proposed ──(human)──▶ approved
                                                    └────────────────▶ rejected
```

`goal new --from` refuses anything not approved, because planning from a wish is how
one ambiguity becomes six tasks that each inherit it. `req new --proposed
--body-file <ticket>` covers the JIRA case: it skips *refinement*, never *approval*.
Only a person accepts the terms of the work.

`req propose` refuses placeholder criteria — the scaffold's own `- _…_` does not
count. Given-When-Then is encouraged because it is the shape of a test, which is how
criteria become machine-checked instead of adding to the review pile.

Every decision is recorded as a run, so the trail shows who authorised the work and
on what criteria.

### 16.5 `awo run`: scoped autonomy with one non-negotiable stop

```sh
awo run --goal SHOP-G1 --until SHOP-T3   # explicit scope
awo run --goal SHOP-G1                   # every ready task, stop at the gate
awo run --goal SHOP-G1 --yolo            # do not stop on failure either
```

It stops at the gate, on a failed task, on any dependency awaiting a verdict, and
**always** on evidence flagged `needsHuman` — `--yolo` included, because continuing
would build the next task on a result nobody has judged.

`--yolo` relaxes failure-stopping. It does not, and will not, relax the verdict: a
machine grading its own work is the single thing here that cannot be automated away.
Everything before the gate is measurable and 0.0.36 made it measured; the verdict is
judgment against acceptance criteria, which is the human's half.

`--dry-run` prints the plan and every stopping condition, so the scope is inspectable
before anything spawns.

### 16.3 Findings

65. **A gate that accepts a string is not a gate.** `tests-must-pass` looked
    enforced for four versions and was enforcing the presence of a sentence.
66. **A bare `catch` hid the baseline failing entirely.** `measureBaseline`
    returned `null` on error, so every failure came back `unknown` — the exact
    answer the mechanism exists to avoid. Second time this session that a silent
    catch hid a broken rail (§9 item 33 was the first).
67. **`.git` inside a worktree is a file, not a directory.** The baseline worktree
    was created under `<repo>/.git/`, which cannot exist in a worktree. Anything
    building paths under `.git` has to ask git where the real one is.

68. **A real gate breaks every test that took the old shortcut, and that is the
    signal it is real.** Adding the approval gate turned 14 passing tests red — all
    of them planning from a bare skeleton. If it had broken nothing it would not
    have been enforcing anything.

69. **A setting in the wrong file is indistinguishable from a setting nobody wrote.**
    `git.scanRepositories`, `git.autoRepositoryDetection` and Git Graph's search
    depth were generated into `.vscode/settings.json` and looked right for months.
    VS Code's docs: *"only resource (file, folder) settings are applied when using a
    multi-order workspace. Settings that affect the entire editor are ignored."* All
    three are window-scoped, and the generated `.code-workspace` — the only way this
    workspace is meant to be opened — carried `"settings": {}`. So Git Graph saw
    nothing, the config was correct, and nothing pointed at the mismatch. Generated
    config needs a test asserting *where* it landed, not just what it says.

70. **`regenerateCodeWorkspace` wrote `settings: {}` — it did not just miss the git
    settings, it deleted them.** Every `add`, `connect`, `remove` and `sync`
    overwrote the file with an empty settings block, so anything Git Graph or the
    user put there vanished on the next repo operation. That is why the graph
    "kept disappearing" rather than simply never working: it was being reset,
    repeatedly, by ordinary commands. Generated files must merge what they do not
    own.
71. **A rule file nobody lists is a rule nobody reads.** `evidence-not-claims`
    shipped in 0.0.36 as a required rule and was absent from `AGENTS.md`'s always-on
    list for four versions — present on disk, ambient in name only. `doctor` now
    reports any `rules/*.md` that `AGENTS.md` never mentions.


## 17. Customising a workspace without fighting the upgrade

`AGENTS.md.new` appeared on every upgrade of a workspace whose AGENTS.md had ever
been touched, and the churn had two independent causes.

### 17.1 The lists were derived data, maintained by hand

The always-on rules list is a listing of `rules/`. Hand-maintaining it produced both
possible failures within a week: `evidence-not-claims` shipped as a required rule and
was missing from the list for four versions (present on disk, ambient in name only,
finding 71), and anyone who added a rule line marked the file user-edited and earned
a conflict file forever after.

So the three lists live in blocks awo owns:

```
<!-- awo:generated rules -->
- `no-db-migrations` — write migration files, never execute them.
<!-- /awo:generated -->
```

Regenerated on init, on upgrade, on `agent add`/`skill add`, and on `rule new`, from
each file's `summary:` frontmatter. **Adding a rule is dropping a file in `rules/`** —
there is nothing to register, so there is nothing to forget.

Critically, `template.lock` hashes the content with those blocks **emptied**
(`hashForLock`). Otherwise installing one catalog agent would make AGENTS.md look
edited and reintroduce the churn through the back door.

### 17.2 Two-way comparison cannot tell an addition from a change

Upgrade compared yours against the template's. With two points, "the user added a
line" and "the template changed a line" are the same observation, so any edit meant a
conflict. Keeping the pristine rendered template at `.workspace/template-base/` adds
the third point, and `git merge-file` then resolves the common case silently: you
appended a section, the template reworded a different paragraph, nothing overlaps.

A `.new` now means what it says — **the same lines moved on both sides** — and
`awo resolve` shows the diff and takes a side, so nobody hand-diffs again.

### 17.3 Where a user adds things

| what | where | registration |
|---|---|---|
| a rule | `rules/<id>.md` or `awo rule new <id>` | none — generated |
| a skill | `skills/<id>.md` | none — generated |
| a role | `agents/<id>.md` or `awo agent add` | none — generated |
| workflow glue | `instructions/<name>.md` | referenced by name |
| project conventions | anywhere in AGENTS.md **outside** the markers | merged on upgrade |

### 17.4 Findings

72. **`git merge-file` has no `--label`, only `-L`, and it exits with the number of
    conflicts.** Passing the long form exits 129, which the handler read as "129
    conflicts" and then merged nothing — every merge silently degraded to a conflict
    file while looking like it had run. Exit codes that encode a count need their
    range bounded (`0 < code < 128`), or an error becomes data.
73. **Two of the upgrade tests asserted a conflict that the merge now resolves, and
    both were unrealistic rather than wrong.** One edited only the user's side, which
    is by definition mergeable; the other deleted `template.lock` to simulate an old
    workspace while leaving `template-base/` in place, a state no real workspace has
    been in. A test that simulates a situation has to simulate all of it.

74. **A diagnostic whose suggested fix errors out is worse than no suggestion.**
    `doctor` reported "done with no test evidence" and advised
    `awo task event <id> test` — which fails on a closed task, because there is no
    open run to append to. The advice was written from the author's memory of the
    command, never executed. It now names `awo task recheck`, which exists and works,
    and the test asserts the advice text names a runnable command rather than just
    asserting the warning appears.
75. **Evidence cannot be retro-fitted; it can only be added.** `recheck` opens a NEW
    run rather than editing the original, so the history says what happened — closed
    once without evidence, verified later. Rewriting the original would have made the
    audit trail a story instead of a record, which is the one property it has.

76. **The outcome must follow the diagnosis, not the exit code.** `recheck` treated
    any non-zero exit as "the original close was wrong" — and then blamed SHOP-T3 for
    a suite that was already red at its branch point, which the diagnosis had
    explicitly said was not its defect. A `pre-existing` failure means exactly one
    thing: this command cannot verify this task. That is a `skipped` run.
77. **The state machine caught the tool trying to launder a status.** The first fix
    was to restore the task to `done` after an inconclusive check, which failed:
    `blocked -> done` is not a legal transition for anyone. It was right to refuse.
    An unverifiable task IS blocked, and it was only `done` because it closed before
    a gate existed — so `blocked` is the honest state and the code now leaves it
    there rather than working around the table.
78. **An instruction nobody kept is an instruction nobody can be held to.** 28 of 28
    records from the first multi-agent run read "User prompt: _not recorded_". The
    flag existed, but on `task complete`, at the end, optional. Now `task run`
    *composes* the brief and records it as a `brief` event at open — so it exists
    even for an abandoned run, it is identical whether a human pastes the invocation
    or `dispatch` spawns it, and the record falls back to it when nobody passes
    `--prompt`. `--instruction` carries the orchestrator's own words into the same
    place. Making it automatic beat asking people to remember, which had a 0% hit
    rate across 28 attempts.

79. **"Run it in an empty directory" is the wrong answer for every real adoption.**
    The guard was correct for a greenfield hub and made awo unusable for the case that
    matters: a project worked on for months already HAS a hub — symlinked repos, a
    284-line CLAUDE.md holding the rules people actually follow, dozens of decision
    docs. Telling that user to start elsewhere means abandoning the material or
    maintaining two hubs. `--adopt` writes only what is missing, names every file it
    kept, and discovers the repos rather than asking for nine `connect` calls.
80. **`fs.copy` with `overwrite: false` throws on the first collision instead of
    skipping it.** Adopting has to copy file by file, or the first existing file
    aborts the run and leaves a half-scaffolded workspace. Related: the
    `gitignore` -> `.gitignore` rename then failed because the adopt path had already
    written the dotted name, which aborted the adopt *after* it had written most of
    the tree — the worst possible place to stop.


## 18. PR identity: assignee and labels

`awo pr link` recorded a PR against a task and left the PR itself anonymous — no
assignee, no labels, and no check that it even mentioned the task. On GitHub, which is
where reviewers actually are, the link did not exist.

Link now applies both, from the task:

- **labels** = the task's `labels:` (or `--label`) plus manifest `pullRequests.labels`
- **assignee** = manifest `pullRequests.assignee`, else the authenticated `gh` user —
  the only assignee awo can infer honestly

### 18.1 Existing labels only, and say what was skipped

awo never creates a label. A label is shared project vocabulary; letting each task
mint its own is how a label list becomes forty near-duplicates that nobody filters by.
So requested labels are intersected with `gh label list`, and the remainder is
reported **by name** — a label you believe was applied is worse than one you know was
not. The test asserts the unavailable label never reaches the `gh pr edit` argv, not
merely that the message was printed.

### 18.2 A metadata failure must not lose the link

The state write that records the PR happens first, and metadata application is caught
rather than thrown. Losing the task-to-PR link because a label call failed would trade
something durable for something cosmetic.

### 18.3 Findings

81. **The traceability check is worth more than the labels.** If a PR's title and body
    never mention the task, nothing on the GitHub side points back — the link exists
    only in `state.json`, which no reviewer opens. `link` and `meta` both report it.

82. **`git push --follow-tags` pushes annotated tags only, and says nothing about the
    rest.** Every release from 0.0.36 to 0.1.6 bumped with `--no-git-tag-version` and
    then ran `git tag vX` — a lightweight tag. `--follow-tags` skipped all twelve
    while the push itself succeeded, so the commits and the npm publishes were fine
    and the tags existed on one machine only. Nothing failed; the release log even
    said "pushed v0.1.6", because that line echoed a shell variable rather than
    anything git reported. Two lessons: prefer `npm version` (annotated), and never
    print a success message that the tool did not actually confirm.

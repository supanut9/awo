# {{PROJECT_KEY}} workspace

An **AWO workspace repo** — an AI workflow orchestration hub created with
`awo init --key {{PROJECT_KEY}}`. It does **not** contain product code; it links to
working repos and carries the agent scaffolding.

## Layout
- `AGENTS.md` — canonical agent instructions (source of truth). `CLAUDE.md` / `GEMINI.md` point here.
- `agents/` `skills/` `rules/` `instructions/` — reusable scaffolding primitives.
- `goals/` — work hierarchy (Requirement → Goal → Tasks); populated by `awo goal new`.
- `catalog/` — domain-specific agents/skills shipped with the library but **not installed by default** (e.g. `data-engineer`, `marketing-specialist`, `audit`). Add one with `awo agent add <name>`.
- `repos/` — linked working repos (gitignored); populated by `awo add` / `awo connect` + `awo sync`. Concurrent tasks touching the same repo get isolated `git worktree`s under `repos/.worktrees/<repo>/<taskId>/` rather than sharing one checkout.
- `logs/` — run history + audit trail (gitignored).
- `.workspace/` — `manifest.json` (repos + project key) and `connectors.json` (MCP/connectors).

## Common commands
| Command | Does |
|---|---|
| `awo add <url>` / `awo connect <path>` | Link a working repo (git / local). |
| `awo sync` | Reconcile `repos/` with the manifest. |
| `awo req new` → `awo goal new --from {{PROJECT_KEY}}-R#` → `awo goal plan {{PROJECT_KEY}}-G#` | Requirement → Goal → Tasks. |
| `awo task run {{PROJECT_KEY}}-T#` | Execute a task; writes a log. |
| `awo connector add <name>` | Register an MCP/connector. |

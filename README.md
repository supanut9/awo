# awo

Scaffolds and orchestrates AI-agent development workspaces. `npx awo init --key <KEY>`
lays down an orchestration hub — agent instructions, rules, skills — that links to one
or more working repos where the real code lives.

## Status

v0.0.1 — `init` only. See `PROJECT_PLAN.md` for the full design and roadmap.

## Usage

```sh
mkdir my-workspace && cd my-workspace
npx awo init --key PROM
```

`--key` is a short, permanent project code (2-5 uppercase letters) that prefixes every
requirement/goal/task ID created in the workspace.

## Development

```sh
npm install
npm run build
npm test
```

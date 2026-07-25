# awo

Scaffolds and orchestrates AI-agent development workspaces. `npx @supanut9/awo init --key <KEY>`
lays down an orchestration hub — agent instructions, rules, skills — that links to one
or more working repos where the real code lives.

## Status

v0.0.1 — scaffolding and repo linking (`init`, `add`, `connect`, `list`, `remove`).
Not yet published to npm. See `PROJECT_PLAN.md` for the full design and roadmap.

> **Package name:** published as **`@supanut9/awo`** — the unscoped `awo` name was
> already taken on npm by an unrelated 2022 placeholder. The installed **command is
> still `awo`**, so only the install string differs.

## Usage

```sh
mkdir my-workspace && cd my-workspace
npx @supanut9/awo init --key PROM
```

`--key` is a short, permanent project code (2-5 uppercase letters) that prefixes every
requirement/goal/task ID created in the workspace.

Then link the repos your agents will work on:

```sh
awo add https://github.com/acme/frontend-app.git   # clone a git repo into repos/
awo connect ../shared-lib                          # symlink a local checkout
awo list                                           # show linked repos + status
awo remove shared-lib                              # unlink
```

Working repos live under `repos/` and are gitignored — the manifest at
`.workspace/manifest.json` is the single source of truth, and `repos/` is rebuilt from it.

## Development

```sh
npm install
npm run build
npm test
```

## Publishing

```sh
npm login                 # interactive
npm publish               # prepublishOnly builds + verifies the embedded template
```

`publishConfig.access` is `public`, so the scoped package publishes publicly without
extra flags.

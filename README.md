# awo

Scaffolds and orchestrates AI-agent development workspaces. `npx @supanut9/awo init --key <KEY>`
lays down an orchestration hub — agent instructions, rules, skills — that links to one
or more working repos where the real code lives.

## Status

v0.0.1 — published on npm as [`@supanut9/awo`](https://www.npmjs.com/package/@supanut9/awo).
Scaffolding and repo linking (`init`, `add`, `connect`, `list`, `remove`).
See `PROJECT_PLAN.md` for the full design and roadmap.

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

## Releasing

```sh
npm version patch         # bumps package.json, commits, and creates the vX.Y.Z tag
git push --follow-tags    # pushes the commit and its tag together
npm publish               # prepublishOnly builds + verifies the embedded template
```

Let `npm version` create the tag — do **not** pass `--no-git-tag-version`, or the
release ends up untagged. `publishConfig.access` is `public`, so the scoped package
publishes publicly without extra flags.

Every version gets a tag, whether or not it reaches npm: the tag marks what the code
was at that version, which is what `libraryVersion` in a workspace manifest points at.

# credentials/ — GITIGNORED

Per-machine tokens, keys, and secrets for connectors declared in
`../connectors.json`. Never committed. Supplied fresh on each machine.

This directory exists *inside* the workspace deliberately: the
architecture decision is that **no `awo` configuration ever lives in
`~` or any machine-global path** — everything is workspace-local.
Credentials are the one thing that can't be tracked in git, so they
live here as the gitignored exception, rather than escaping the
workspace and breaking the "clone anywhere" property.

Recommended file convention: one file per connector, named after it —
e.g. `github.env`, `gcloud.json`. The `awo` CLI reads only from this
directory when a connector needs auth; it never falls back to `~`.

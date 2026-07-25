---
id: sync-repos
name: Sync linked repos
description: Reconcile repos/ with .workspace/manifest.json before starting work
requires:
  connectors: []
---

## When to use
At the start of any task, or whenever a linked repo might be stale/missing.

## Steps
1. Read `.workspace/manifest.json`.
2. For each `type: git` entry: clone into `repos/<name>` if absent, else pull
   the declared `ref`.
3. For each `type: local` entry: verify the symlink at `repos/<name>` still
   resolves; recreate it if missing.
4. Report any repo that failed to sync rather than proceeding silently.

## Done when
- Every manifest entry is present and current under `repos/`.

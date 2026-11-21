---
id: sync-repos
name: Sync linked repos
description: Reconcile repos/ with .workspace/manifest.json before starting work
requires:
  connectors: []
summary: reconcile `repos/` with the manifest before starting work.
---

## When to use
Before `awo task run`, or whenever a linked repo might be stale/missing — the
orchestrator's step. A worker already inside a task worktree does not pull in
`repos/<name>`: that checkout is shared with every other task.

## Steps
1. Read `.workspace/manifest.json`.
2. For each `type: git` entry: clone into `repos/<name>` if absent, else pull
   the declared `ref`.
3. For each `type: local` entry: verify the symlink at `repos/<name>` still
   resolves; recreate it if missing.
4. Report any repo that failed to sync rather than proceeding silently.

## Done when
- Every manifest entry is present and current under `repos/`.

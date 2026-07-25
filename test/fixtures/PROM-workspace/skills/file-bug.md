---
id: file-bug
name: File a bug as a new requirement
description: Turn a QA-found gap into a new requirement, re-entering the pipeline
requires:
  connectors: []
---

## When to use
Whenever `verify-acceptance-criteria` (or any exploratory testing) finds a
gap between expected and actual behavior.

## Steps
1. Create a new `requirement.md` (next `PROM-R#`) describing the gap as the
   "Raw requirement", with `source` noting which goal/task surfaced it.
2. Set `status: refined` if the gap is already well-understood, else `draft`.
3. Link back: reference the originating `goalId`/`taskId` in the body so the
   bug's provenance is traceable.

## Done when
- A new requirement exists that a `product-manager` can triage and turn
  into a goal like any other requirement.

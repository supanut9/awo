---
id: file-bug
name: Promote a new-scope gap to a requirement
description: Turn a human-confirmed out-of-scope QA gap into a new requirement
requires:
  connectors: []
summary: promote a human-confirmed new-scope gap to a requirement.
---

## When to use
Only after a human confirms that a QA gap is outside the approved goal scope.
In-scope gaps stay on the goal as repair tasks.

## Steps
1. Run `awo goal verdict <goal> --gap --new-scope --summary "…" --who "<human>"`,
   with `source` noting which goal/task surfaced it.
2. Set `status: refined` if the gap is already well-understood, else `draft`.
3. Link back: reference the originating `goalId`/`taskId` in the body so the
   bug's provenance is traceable.

## Done when
- A new requirement exists that a `product-manager` can triage and turn
  into a goal like any other requirement.

---
id: capture-requirement
name: Capture a requirement
description: Sequence for turning a raw ask into a scoped, plannable goal
owner: product-manager
appliesTo: [PROM-R]
summary: Capture a requirement
---

Sequence for a new ask (`awo req new`), owned by `product-manager`:

1. **refine-requirement** — `awo req refine PROM-R#` briefs you; capture the raw
   ask, clarify it, and write checkable acceptance criteria under
   "## Draft acceptance criteria". Do not edit `status:` by hand — the commands
   below own it, and there is no `refined` status.
2. **Propose** — `awo req propose PROM-R#` moves it `draft → proposed`. It refuses
   a requirement with no criteria.
3. **Human approval** — a person reads the criteria and runs
   `awo req approve PROM-R#` (or `awo req reject PROM-R# --why "…"`). An agent
   never approves on its own judgment: approving accepts the terms of the work.
4. **Goal** — only once it is approved: `awo goal new --from PROM-R#` distils it
   into a goal (objective, definition-of-done, scope/constraints). Pick the
   goal's rigour with `--policy light|standard|strict`.
5. Hand off to `tech-lead` — proceed with **plan-a-goal**.

Finally, record the run (rule: `record-every-run`):
`awo log add --label <short-slug> --agent product-manager --model <model> --started <iso-when-you-began> --summary "<what you did>" --prompt "<the ask>"`
Pass `--label` and `--started`, or the entry is named `adhoc` with a 0s duration.

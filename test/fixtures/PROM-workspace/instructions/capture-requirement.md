---
id: capture-requirement
name: Capture a requirement
description: Sequence for turning a raw ask into a scoped, plannable goal
appliesTo: [PROM-R]
---

Sequence for a new ask (`awo req new`), owned by `product-manager`:

1. **refine-requirement** — capture the raw ask, interview/clarify, draft
   acceptance criteria; move `requirement.md` `status` to `refined`.
2. `awo goal new --from PROM-R#` — distill the refined requirement into a
   goal: objective, definition-of-done, scope/constraints.
3. Hand off to `tech-lead` — proceed with **plan-a-goal**.

---
id: pick-reasoning-effort
name: Match reasoning effort to the work
appliesTo: [delegation, task_run]
severity: required
---

Reasoning effort is **how long the model should think**, not a different level of
intelligence. Lower effort answers faster and spends fewer reasoning tokens; higher
effort improves completeness and accuracy on hard problems while costing latency and
tokens. Only `low`, `medium` and `high` are selectable here.

**`medium` is the default.** Choose away from it deliberately.

| Effort | Use for | Examples |
|---|---|---|
| `low` | Transforming information you already have — no solution to discover | conventional commit message, JSON → TypeScript interface, explain a small function, repetitive CRUD from a clear pattern, extract or classify fields |
| `medium` | Normal professional work — the best default | design an endpoint, implement a service, review a PR, add validation, compare two reasonable architectures, multi-step analysis |
| `high` | Interacting constraints or hidden failure cases, where mistakes are expensive | intermittent production bugs, auth/token rotation, concurrency and caching bugs, migration planning, permissions with real business rules, decisions that are expensive to reverse |

## The decision test
1. **Would a wrong answer be easy to spot?** If yes, `low` or `medium` is enough.
2. **Are there many interacting constraints?** If yes, move toward `high`.
3. **Could an error cause security, financial, production or migration damage?** If
   yes, use `high`.

Length is not difficulty. A long prompt that is merely verbose stays `medium`; a
short question about token revocation is `high`.

## In practice
`awo task run` prints the effort resolved from the task's tier, and that is the
default you should use. Override it only with a reason you can state — and if you
do, say so in the run log so the choice can be judged later against
`awo log list --effort <e>`.

Do not reach for higher effort because a task feels important. Reach for it when the
reasoning relationships are genuinely hard, and let the log show whether it helped.

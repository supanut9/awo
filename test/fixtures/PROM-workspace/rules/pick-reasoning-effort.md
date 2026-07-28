---
id: pick-reasoning-effort
name: Match reasoning effort to the work
appliesTo: [delegation, task_run]
severity: required
---

Reasoning effort is **how long the model should think**, not a different level of
intelligence. Lower effort answers faster and spends fewer reasoning tokens; higher
effort improves completeness and accuracy on hard problems while costing latency and
tokens. **Only `medium` and `high` are selectable here.**

`low` was removed on evidence, not taste: six tasks implemented at low effort each
passed their own lint and tests, and the composed feature was broken — a response
shape mismatch that made the list always empty, an unauthenticated admin route, and
mismatched identifiers between caller and controller. Whatever low effort saves on a
task that writes code, it gives back at the review. A policy that still says `low`
is read as `medium`.

**`medium` is the default.** Choose away from it deliberately.

| Effort | Use for | Examples |
|---|---|---|
| `medium` | Normal professional work — the default, and the floor for anything that writes code | design an endpoint, implement a service, review a PR, add validation, compare two reasonable architectures, a commit message, JSON → types |
| `high` | Interacting constraints or hidden failure cases, where mistakes are expensive | intermittent production bugs, auth/token rotation, concurrency and caching bugs, migration planning, permissions with real business rules, decisions that are expensive to reverse |

## The decision test
1. **Would a wrong answer be easy to spot?** If yes, `medium` is enough.
2. **Are there many interacting constraints?** If yes, move toward `high`.
3. **Could an error cause security, financial, production or migration damage?** If
   yes, use `high`.

Length is not difficulty. A long prompt that is merely verbose stays `medium`; a
short question about token revocation is `high`.

**Crossing a boundary raises the effort.** Work that has to agree with something it
cannot see — another repo's response shape, another task's DTO, an auth contract —
is `high`, however small the diff.

## In practice
`awo task run` prints the effort resolved from the task's tier, and that is the
default you should use. Override it only with a reason you can state — and if you
do, say so in the run log so the choice can be judged later against
`awo log list --effort <e>`.

Do not reach for higher effort because a task feels important. Reach for it when the
reasoning relationships are genuinely hard, and let the log show whether it helped.

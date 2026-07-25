---
id: acceptance-criteria-required
name: Acceptance criteria required before a goal is done
appliesTo: [goal_completion]
severity: required
---

A goal MUST NOT be marked `done` on the sole basis of its tasks reporting
`success`. It requires an explicit **qa-engineer** sign-off against the
goal's own "Definition of done" (not just each task's "Done when"). If
verification finds a gap, `qa-engineer` files it as a new requirement
(`file-bug`) rather than silently accepting the goal as complete.

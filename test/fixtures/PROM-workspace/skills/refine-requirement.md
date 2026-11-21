---
id: refine-requirement
name: Refine a requirement
description: Turn a raw ask into a clear requirement via intake interview
requires:
  connectors: []
summary: turn a raw ask into a clear, scoped requirement.
---

## When to use
At the start of `awo req new` — before any goal or task exists.

## Steps
1. Capture the raw ask verbatim in `requirement.md` under "Raw requirement".
2. Interview the stakeholder (or infer from context) to fill gaps: who is
   this for, what does success look like, any hard constraints.
3. Record the Q&A under "Clarifications".
4. Draft measurable "Draft acceptance criteria", one per line — preferably as
   Given / When / Then, the shape of a test.
5. Once it is specific enough to scope a goal from, run
   `awo req propose <requirement>` (`draft → proposed`). Never edit `status:` by
   hand; a human approves with `awo req approve`.

## Done when
- A stakeholder could read the requirement and agree it's what they meant.

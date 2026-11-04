---
id: chart-the-unknown
name: Chart the unknown
description: Plan a goal whose shape is not yet known as decision tasks resolved one at a time, instead of guessing a task breakdown and discovering it was wrong halfway through
requires:
  connectors: []
  rules: [evidence-not-claims, use-declared-skills]
summary: use when a goal is too big or too foggy to break into tasks — plan the DECISIONS first, one per session, before any task that touches a repo.
---

## When to use

A goal has arrived that you cannot honestly decompose yet: too big for one session, and
wrapped in questions whose answers change the breakdown. `plan-a-goal` assumes you already
know the shape of the work. This is what you run when you do not.

The tell is trying to write a task list and finding that every task starts with "depending
on whether…". That is not a planning failure; it is the signal that the decisions are the
work right now.

## When NOT to use

- The shape is clear and only the labour is large — that is `plan-a-goal` with more tasks.
- One unknown, answerable in a session — just answer it with the `research` skill and plan.
- The question is "is this broken and why" — that is `diagnosing-bugs`.

Charting a clear goal wastes a session and produces a decision task whose answer everyone
already knew.

## The idea

Do not chart the build. Chart the **way to the point where the build is obvious**, as a
small number of questions, and resolve them one at a time. Each answer clears the ground
ahead and usually reveals the next question — which you could not have written down before.

awo already has every mechanism this needs; what it has not had is the procedure:

| you need | awo already has |
|---|---|
| the map | the **goal** — `goal.md` is the map, not a new artifact |
| a ticket whose output is a decision | `kind: decision` on a task (`awo task new --kind decision`) |
| blocking edges | `dependsOn` |
| the frontier (what is takeable now) | `awo context` — it already reports what is blocked and why |
| claiming a ticket | task status `running` |
| the record of an answer | the run log, plus the goal's Decisions-so-far index |

So this skill adds no new file type. It tells you how to use the ones that are there.

## Charting

1. **Name the destination first**, in the goal's `## Objective`: what "the way is clear"
   looks like — a spec to hand off, a decision to lock, a migration whose shape is settled.
   It fixes the scope, so everything else is judged against it. A goal being charted has a
   definition-of-done about *knowing*, not about shipping; say so plainly rather than
   writing a delivery DoD you cannot meet.

2. **Fan out breadth-first, not depth-first.** Sweep the whole space for open questions
   rather than following the first one down. Depth-first here is how you end up with a
   beautifully resolved corner of a problem you have not yet sized.

3. **Write a decision task only for a question you can state precisely now.** Create them
   with `awo task new --goal <G#> --kind decision --name "…"`, leaving `targets` empty —
   a decision touches no repo, and an empty `targets` is what says so. Then wire
   `dependsOn` in a **second pass**, once the ids exist.

   Each decision task's body is the question and, later, its answer:

   ```markdown
   ## Question
   _The one decision or investigation this resolves._

   ## Answer
   _Filled in on resolution. If it needed a live human, say who decided._
   ```

4. **Everything you cannot state precisely goes in the goal's `## Not yet specified`.** The
   test is *whether you can phrase the question sharply now, not whether you can answer it*.
   A question you can phrase but not answer is a task. A patch of "something happens around
   billing and we do not know what yet" is fog: write it loosely and leave it.

   Do not pre-slice fog into task-sized pieces. One patch may graduate into three tasks or
   none, and pre-slicing it commits you to a shape you invented rather than found.

5. **Stop.** Charting is one session's work and resolves nothing. Resolving in the same
   breath is how the first answer quietly reshapes the map nobody has read yet.

## Working through it

Take **one decision per session** — the exception is pure research, which can run in
parallel because it reads rather than decides.

1. Read the goal — the low-resolution view. Do not open every task body.
2. Take the first unblocked decision task and set it `running` before doing anything. That
   is the claim; an unclaimed task is one another session will start too.
3. Resolve it. Use `research` for anything you would otherwise answer from memory. Some
   decisions cannot be made without a live human — a preference, a commercial call, a
   risk someone must own. For those, ask and wait. Answering on the human's behalf produces
   a decision with nobody behind it, which is worse than an open question.
4. Record the answer in the task's `## Answer`, close the task, and add **one line** to the
   goal's `## Decisions so far` pointing at the task.

   Keep that section an **index, not a store**: one line per resolved decision, enough to
   judge relevance, and a pointer to the task that holds the detail. A decision restated in
   two places will disagree with itself within a fortnight.
5. Graduate whatever the answer made specifiable: new decision tasks, removed from
   `## Not yet specified` so it lives in exactly one place. If an answer reveals that a task
   sits past the destination, cancel it and leave a line under `## Out of scope` — that is a
   scoping act, not a step on the route, so it does not belong in Decisions-so-far.

## Done when

- No decision tasks remain and `## Not yet specified` is empty — the way is clear.
- The goal can now be planned normally with `plan-a-goal`, and its task breakdown follows
  from the recorded decisions rather than from a guess.
- Every decision that needed a human names the human who made it.

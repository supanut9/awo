---
id: use-declared-skills
name: Use declared skills
appliesTo: [all]
severity: required
summary: if a skill covers the step you are about to take, open it first and name it in the run — deciding it "looks straightforward" is how skills go unused.
---

A workspace's skills — awo's own in `skills/`, and the external agent skills declared in
`.workspace/agent-skills.json` — are only worth their upkeep if they are actually reached
for. So: **before starting a step a skill covers, invoke that skill.** Not "consider
whether it might help". Open it.

## Why this is a rule and not advice

Advice was tried. Measured across 512 recorded runs in the workspace this template came
from, a skill was named in **39** of them, and eight of twelve had effectively never been
used. Nothing was wrong with the procedures; nothing told anyone to look. Each session
re-derived the steps from scratch and re-hit traps that were already written down.

Re-deriving a procedure costs more than reading it, and re-deriving it is how the same
mistake ships twice.

## What "covers the step" means

Judge by the situation you are in, not by how hard the task looks. The two failure modes
are symmetrical and both are common:

- **"This is simple, I don't need the skill."** The skill exists because the last person
  thought that too. A skill's body is not the shape of the procedure — a capable model
  already knows to run tests before committing — it is the part that is *not* guessable:
  which test command this repo really uses, which git identity, which selector lies.
- **"I already know what the skill says."** Then confirming costs one read. Being wrong
  costs a re-run, and the skill will have grown since you last saw it.

Research and debugging are the two that get skipped most, because both feel like thinking
rather than procedure:

- About to answer a question from memory, from one file, or from what the code *looks*
  like it does? That is research. Use the research skill, and cite what you actually read.
  An inference from preconditions is not a finding.
- Something is broken, throwing, failing or slow? Use the debugging skill before proposing
  a fix. A fix proposed before the bug reproduces is a guess with a diff attached.

## How this is checked

Compliance is visible, which is the point:

- The run record names the skills used (`awo log show <runId>`). A run that took a step a
  skill covers and names no skill is the thing this rule catches.
- `awo skill external` lists what is declared and whether it is actually installed.
  `awo doctor` warns when a declared skill is missing, so "the skill wasn't available"
  is a reportable state rather than a silent excuse.

## Write back what you had to work out

If you follow a skill and it turns out to be missing something you had to derive yourself,
add it before the task closes — to the awo skill, or as a note in the workspace for an
external one we cannot edit. That single habit is the difference between the skills that
grew and the ones that decayed into blank checklists.

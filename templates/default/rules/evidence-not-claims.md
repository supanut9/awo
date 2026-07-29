---
id: evidence-not-claims
name: Evidence is measured, never asserted
appliesTo: [task_completion, audit]
severity: required
summary: never write "the suite passes"; have awo run it with `awo task event <id> test --run "<cmd>" --baseline`. Only a measured pass closes a task.
---

Do not write "the suite passes". Have awo run it:

```sh
awo task event <id> test --run "npm test" --baseline
```

awo executes the command in your worktree, records the exit code, duration and
pass/fail counts, and `--baseline` runs it again at the branch point so a failure
can be attributed. `awo task complete --gate` accepts **only** a measured pass;
a `test` event you typed is refused.

This exists because a claim cannot be checked, and because agent-written tests are
frequently not tests: analysis of agent-authored test patches found roughly 80%
carry weak or no assertions — existence checks, mock verification, snapshots. So
"tests passed" as prose is the weakest signal in this workflow.

## When a test fails, decide which is wrong

A failure means the code is wrong **or** the test is wrong. With `--baseline`,
three of the four cases are decided for you:

| baseline | now | meaning |
|---|---|---|
| fails | fails, no worse | pre-existing — not yours, but this command cannot verify your task either |
| passes | fails | your change broke it |
| — | fails, and you added tests | your tests state the contract; the code does not meet it *or* the tests are wrong |
| passes | passes, but you edited a test and its own code together | **inconclusive** |

The last row is the one that matters. A test edited into agreement with the code
proves nothing, so awo flags it and refuses to let the task go straight to `done`.

**The tiebreak is never the test or the code.** Both changed; either can be read to
justify the other. Use the artefact that predates both — the goal's acceptance
criteria. If those do not settle it, that is a specification gap: move the task to
`blocked` with the question, and ask. Do not guess, and do not adjust the test until
it agrees with what you wrote.

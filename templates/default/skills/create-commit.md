---
id: create-commit
name: Create a commit
description: Stage changes and commit with a Conventional Commits message
requires:
  connectors: [github]
  rules: [conventional-commits]
summary: stage + commit with a conventional message.
---

## When to use
Any time you have logically-grouped changes ready to record.

## Steps
1. Review staged vs. unstaged changes; stage only what belongs in this commit.
2. Compose the message as `<type>(<scope>): <subject>` (see the
   `conventional-commits` rule for allowed types).
3. Add a footer referencing the task: `Refs: {{PROJECT_KEY}}-T#`.
4. Commit.

## Done when
- The working tree is clean for the intended change and the message validates
  against the `conventional-commits` rule.

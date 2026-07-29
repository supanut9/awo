---
id: conventional-commits
name: Conventional Commits
appliesTo: [commit]
severity: required
summary: commit messages follow Conventional Commits.
---

Commit messages MUST follow Conventional Commits:

`<type>(<optional scope>): <subject>`

- **type** ∈ `feat` `fix` `docs` `refactor` `test` `chore` `build` `ci`.
- **subject** in the imperative mood, ≤ 72 characters, no trailing period.
- Reference the task in the footer: `Refs: {{PROJECT_KEY}}-T#`.
- Breaking changes: add `!` after type/scope and a `BREAKING CHANGE:` footer.

---
id: no-push-to-main
name: No direct pushes to main
appliesTo: [commit, push]
severity: required
summary: never commit/push directly to `main`; use a PR.
---

NEVER commit or push directly to `main` / `master`. All changes reach the
default branch through a reviewed pull request from a feature branch
(`feature/{{PROJECT_KEY}}-T#-<slug>`). Force-pushing shared branches is prohibited.

# Changelog

All notable changes to AWO are documented in this file.

## [Unreleased]

## [0.4.0] - 2026-08-18

### Added

- Truthful goal-readiness evaluation across authored tasks, acceptance-criterion evidence, QA sign-off, attribution, and human approval.
- `awo goal readiness` for a non-mutating readiness report and `awo goal reconcile` for explicit state repair.
- Dashboard readiness details that explain completion blockers instead of projecting task counts as delivery readiness.

### Changed

- Goal completion now requires reconciled task state and complete delivery evidence before transitioning to `done`.
- Template policy and generated workspace guidance now document the stricter completion contract.

[Unreleased]: https://github.com/supanut9/awo/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/supanut9/awo/compare/v0.3.0...v0.4.0

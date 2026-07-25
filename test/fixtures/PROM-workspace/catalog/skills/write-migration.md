---
id: write-migration
name: Write a database migration
description: Generate a forward (and reverse, if supported) migration for a schema change
requires:
  connectors: []
  rules: [tests-must-pass]
---

## When to use
After a schema change is defined (`define-entity-schema`), before it reaches
the data access layer.

## Steps
1. Generate the migration via the repo's migration tool/convention.
2. Write the reverse/down migration where the framework supports it.
3. Run the migration against a local/test database.
4. Run the repo's test suite (`run-tests`) to confirm nothing downstream broke.

## Done when
- Migration applies cleanly forward (and reverses cleanly, if applicable).

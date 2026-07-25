---
id: define-entity-schema
name: Define entity schema
description: Design or update a data entity's schema (fields, types, relations) independent of app feature code
requires:
  connectors: []
---

## When to use
When a task calls for a new entity or a change to an existing one's shape —
before touching migrations or the data access layer.

## Steps
1. Identify the entity and its relations to existing entities.
2. Define fields, types, constraints (required, unique, defaults).
3. Note any relations (one-to-many, many-to-many) and cascade behavior.
4. Record the schema definition in the repo's schema/models location.

## Done when
- The schema is defined and reviewed before a migration is written against it.

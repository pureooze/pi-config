# ADR-002: Local canonical storage path, permissions, and recovery

**Status:** accepted for MVP

**Date:** 2026-08-06

**Decision tasks:** KGM-1.2

## Context

The MVP is local-only and single-user, but the database will contain user and project knowledge that may be sensitive. A project-local database would fragment global knowledge and make scope isolation harder to audit. A shared global database needs strict scope filtering and a predictable private location.

The SQLite driver decision is recorded in [ADR-001](knowledge-graph-mvp-adr-001-sqlite-runtime.md).

## Decision

Use one canonical SQLite database at:

```text
~/.pi/agent/knowledge-graph/knowledge.sqlite
```

The storage root is resolved from the user’s home directory, not from the current project. An optional `PI_KNOWLEDGE_GRAPH_DIR` environment override may select an **absolute** user-process path. Project-local configuration cannot change the storage root or database filename.

The root contains:

```text
knowledge-graph/
├── knowledge.sqlite
├── backups/
├── exports/
└── config.json
```

`config.json` is optional global configuration. Backups and exports are separate from the canonical database and are never treated as additional sources of truth.

## Permission and path policy

- Create the storage, `backups`, and `exports` directories with mode `0700`.
- Create the database, backup, export, and configuration files with mode `0600`.
- Explicitly apply and verify modes after creation because the process umask may vary.
- On POSIX systems, verify that existing storage targets are owned by the current user and are not group/world accessible; fail closed rather than silently accepting an insecure existing target.
- Reject a symlink at the storage root, database path, or command-selected backup/export target. Parent-directory symlinks are resolved and checked normally.
- The environment override is read only from the process environment. A project-local config cannot redirect the database, backup, export, or config paths.
- User-selected export/backup destinations must be validated and confirmed by the command workflow; default destinations remain below the storage root.
- Do not put knowledge content, source excerpts, or database paths containing sensitive data in extension telemetry or routine logs.

Windows ACL behavior and non-POSIX ownership verification are not claimed by this ADR; the supported platform matrix must be recorded during KGM-6.8. The portable minimum remains private per-user locations with restrictive creation modes where the platform supports them.

## Migration and recovery

- The database is the canonical store. Schema migrations are ordered, forward-only, versioned, and transactional.
- Before a schema migration or destructive purge, create a uniquely named SQLite backup in `backups/` using `VACUUM INTO` and verify it by opening it and running `PRAGMA integrity_check`.
- Write backups to a new temporary file, close/verify it, apply private permissions, and atomically rename it into the backup directory. Never overwrite an existing backup.
- If integrity checking or migration fails, preserve the original database and failed artifacts, report a recoverable error, and do not auto-delete, downgrade, or replace the database.
- Recovery uses a verified backup or logical export into a separate temporary database followed by an explicit replacement operation. Automatic downgrade is not supported in the MVP.
- The extension must expose health and recovery state without printing knowledge content.

## Derived indexes

Canonical scopes, evidence, entities, aliases, claims, supersession links, and audit events are authoritative. FTS5 tables and other indexes are derived. Their schema/version is recorded separately from the canonical schema.

On open or migration, the extension will detect missing or stale derived indexes and rebuild them from canonical rows in a bounded transaction. If rebuilding fails, canonical data remains preserved and search reports a degraded/unavailable index rather than modifying canonical facts.

## Configuration trust

Global configuration is user-owned under the storage root. A project-local `.pi/knowledge-graph.json` may be considered later for safe display/retrieval preferences, but it must be parsed only when Pi reports the project trusted and it may not alter storage paths or scope identity. Untrusted project configuration is ignored.

## Consequences

- The MVP has one backup and migration story and can share global knowledge intentionally across projects.
- Scope filtering becomes a mandatory repository concern; a database connection alone never authorizes a project query.
- A single synchronous SQLite file can experience writer contention; the adapter must use bounded timeouts and normalize busy/locked failures.
- Users who need a different filesystem location can use the explicit environment override without allowing repository-controlled files to redirect storage.
- A future daemon, encrypted store, or multi-user backend can replace the adapter without changing the canonical repository API.

# ADR-001: Use Node’s built-in SQLite for the MVP

**Status:** accepted for MVP

**Date:** 2026-08-06

**Decision task:** KGM-1.1

## Context

The repository currently has no lockfile, test runner, or native database dependency. The MVP needs a local transactional store with FTS5, foreign keys, WAL-mode behavior, bounded contention handling, and a reproducible backup path. Adding a native SQLite package would introduce dependency installation, platform builds, and possible ABI/rebuild concerns before the storage design is validated.

The tested environment is:

- Pi `0.84.0`
- Node `v24.14.1`
- bundled SQLite `3.51.2`
- npm `11.11.0`

## Decision

Use Node’s built-in `node:sqlite` `DatabaseSync` API as the MVP storage driver. Keep database access behind an internal adapter so the driver can be replaced if a supported Pi/Node runtime does not provide the required behavior.

The MVP will not add a native SQLite dependency or change the package manager configuration for this decision.

Required initial connection behavior:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = <configured bounded timeout>;
```

Use parameterized statements for values. Use `VACUUM INTO` for a database-level backup only when no write transaction is active; canonical export remains a separate logical operation that excludes derived FTS tables.

## Verification

The reproducible spike is [`scripts/knowledge-graph-sqlite-spike.mjs`](../scripts/knowledge-graph-sqlite-spike.mjs). It creates and removes a temporary database and verifies:

- `node:sqlite` import and `DatabaseSync` open
- FTS5 virtual-table creation, insertion, and `MATCH` retrieval
- transaction rollback
- foreign-key violation rejection
- WAL mode and a configured busy timeout
- `VACUUM INTO` backup and reopening the backup
- two-process write contention followed by successful write recovery
- `PRAGMA integrity_check`

Command and result:

```text
$ node scripts/knowledge-graph-sqlite-spike.mjs
status: pass
node: v24.14.1
sqlite: 3.51.2
foreign keys, WAL, and busy timeout: journal=wal, timeout=1000ms
FTS5 insert and MATCH query: rows=1
transaction rollback: rows=0
VACUUM INTO backup and reopen: rows=1, fts=1
two-process write contention and recovery: rows=2
integrity check: ok
```

The command emits Node’s expected `ExperimentalWarning` for SQLite but exits successfully.

## Constraints and follow-up requirements

1. `node:sqlite` is still reported as an experimental Node feature. The initial support matrix is therefore limited to the tested Pi/Node combination until another runtime is verified.
2. `DatabaseSync` is synchronous. Repository operations must use bounded inputs, short transactions, cancellation/deadline checks around expensive work, and measured latency budgets.
3. A blocked second writer can surface through Node’s generic SQLite error code/message mapping. The storage adapter must normalize busy/locked errors for retry or user-facing failure instead of matching one raw error string.
4. `VACUUM INTO` is a file backup, not a substitute for a versioned logical export or restore validation.
5. FTS5 schema/tokenizer behavior must be covered by migration and rebuild tests before release.
6. Re-run this spike whenever the supported Node/Pi version changes. If a required check fails, stop using the built-in driver and evaluate a versioned alternative in a new ADR.

## Alternatives considered

### Native SQLite package

Not selected for the MVP because the built-in driver passed the required runtime checks and a native dependency would add installation and platform/ABI risk. Reconsider only if the built-in API fails a required behavior or performance threshold.

### Separate SQLite process or graph database

Not selected because it adds a daemon/process lifecycle, deployment, synchronization, and security surface inconsistent with the local single-user MVP.

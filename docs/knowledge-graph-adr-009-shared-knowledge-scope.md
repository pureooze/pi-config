# ADR-009: Shared knowledge scope

**Status:** accepted

**Date:** 2026-08-12

**Supersedes:** ADR-003 for knowledge visibility

## Decision

The canonical knowledge graph uses one shared `global` scope. Accepted knowledge is available from every Pi session and working directory. The current directory may still be used to locate trusted project configuration and to display context, but it is never used as a knowledge identity, storage partition, or retrieval filter.

The agent-facing search, get, and maintenance tools do not require a project or path scope. Stable IDs resolve in the shared graph. Legacy scope arguments are compatibility aliases for the shared scope and do not restore path isolation.

## Migration

Schema migration 8 moves canonical and derived rows from legacy `project:<sha256>` scopes into `global`, removes the legacy scope records, and creates the mandatory pre-migration SQLite backup. It fails closed on identifier or uniqueness collisions rather than dropping records. Snapshot restore normalizes legacy project-scoped records into the mandatory `global` scope; normal runtime access therefore remains shared.

## Consequences

- A question asked from `/home`, a repository, or a subdirectory searches the same accepted knowledge.
- Project moves, clones, and working-directory changes no longer hide previously accepted knowledge.
- The private single-user SQLite store is the access boundary; project scope isolation is intentionally not a security boundary.
- Evidence, secret scanning, bounded retrieval, auditing, correction history, and explicit deletion remain unchanged.
- Project-local configuration remains trust-gated, but it can change preferences only; it cannot partition knowledge.

This decision is intentional: the knowledge graph is personal cross-project memory, not a per-repository memory store.

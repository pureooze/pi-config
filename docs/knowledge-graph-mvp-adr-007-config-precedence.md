# ADR-007: MVP configuration precedence and validation

**Status:** accepted for MVP

**Date:** 2026-08-07

**Decision task:** KGM-2.3

## Configuration sources

The extension treats every external value as `unknown` and validates it before use. The supported MVP preferences are intentionally small:

- `defaultSearchLimit`: integer from `1` through `20`, default `8`;
- `showSourceLocators`: boolean, default `false`.

Storage paths are not project-configurable. The only storage-root override is the process environment variable `PI_KNOWLEDGE_GRAPH_DIR`, which must be an absolute path no longer than 4,096 characters.

Files:

- global config: `<storage-root>/config.json`, private mode `0600`;
- trusted project config: `<canonical-project-root>/.pi/knowledge-graph.json`;
- project config is not read at all when `ctx.isProjectTrusted()` is false.

Project config cannot set storage paths, the project identity algorithm, scope keys, or global visibility defaults. Unknown fields are ignored with a non-content warning. Invalid preference fields are ignored with a warning. Invalid JSON or a non-object root falls back to safe defaults. An invalid storage-root environment value fails closed with a typed configuration error.

## Precedence

Highest precedence wins:

```text
defaults
  < valid global config preferences
  < valid trusted project config preferences
  < valid preference environment overrides
```

`PI_KNOWLEDGE_GRAPH_DIR` independently selects the storage root and therefore also determines where the global config is read. Environment overrides are:

- `PI_KNOWLEDGE_GRAPH_DIR`
- `PI_KNOWLEDGE_GRAPH_DEFAULT_SEARCH_LIMIT`
- `PI_KNOWLEDGE_GRAPH_SHOW_SOURCE_LOCATORS` (`true`/`false` or `1`/`0`)

Invalid preference environment values preserve the lower-precedence value and emit a bounded warning. No warning contains config contents, evidence, or secret values.

## Private path preparation

`prepareStoragePaths()` is called only after session/command startup, never from the extension factory. It creates and verifies:

- storage root, backup directory, and export directory as owner-only `0700` directories;
- the canonical database as an owner-only `0600` regular file.

`ensurePrivateFile()` applies the same `0600` policy to backup/export destinations. Existing paths must be regular, owned by the current user on POSIX systems, and exactly private; symlinks and insecure modes fail closed. The helper does not open SQLite or acquire a long-lived resource.

## Implementation evidence

- [`packages/knowledge-graph/config.ts`](../packages/knowledge-graph/config.ts)
- [`tests/unit/knowledge-graph-config.test.mjs`](../tests/unit/knowledge-graph-config.test.mjs)
- `npm run typecheck` passes.
- `npm run test:unit` passes five tests covering precedence, trusted/untrusted project config, malformed values, environment overrides, directory/file modes, insecure permissions, and symlink rejection.

This ADR refines the storage and trust constraints in [ADR-002](knowledge-graph-mvp-adr-002-storage-paths.md) and [ADR-003](knowledge-graph-mvp-adr-003-scope-project-identity.md) without changing their canonical database or scope decisions.

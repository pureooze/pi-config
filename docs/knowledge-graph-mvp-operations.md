# Knowledge graph MVP operations

The knowledge graph is a local, single-user Pi extension. It stores evidence-backed claims in one private SQLite database and applies the current project scope before every read or mutation.

## Installation and runtime

This repository registers `./extensions/knowledge-graph/index.ts` in `package.json`. Install the local Pi package and restart Pi, or reload the extension with `/reload` after changing it. The supported development/runtime baseline is:

- Pi `0.84.0`;
- Node `v24.14.1` or newer;
- npm `11.11.0`;
- SQLite through Node's built-in `node:sqlite` driver.

Run the isolated validation suite with:

```bash
npm ci
npm run test:all
```

The extension does not open the database during registration. It opens it lazily at session start or when a knowledge command/tool first needs storage, and closes it idempotently at session shutdown.

## Storage, permissions, and configuration

By default the store is:

```text
~/.pi/agent/knowledge-graph/
├── knowledge.sqlite
├── backups/
├── exports/
└── config.json
```

The root, `backups`, and `exports` directories are created with mode `0700`. The database, backups, exports, and global config use mode `0600`. Existing symlinks, insecure permissions, and wrong ownership fail closed.

`PI_KNOWLEDGE_GRAPH_DIR` may select an absolute private storage root. It is process configuration, not project configuration. The supported preference overrides are:

- `PI_KNOWLEDGE_GRAPH_DEFAULT_SEARCH_LIMIT` (`1..20`);
- `PI_KNOWLEDGE_GRAPH_SHOW_SOURCE_LOCATORS` (`true`/`false` or `1`/`0`).

The optional global `config.json` supports `defaultSearchLimit` and `showSourceLocators`. A trusted project may provide `.pi/knowledge-graph.json` for those preferences only. Untrusted project configuration is ignored and cannot change storage, scope identity, or global visibility.

## Scope and visibility

Every record belongs to `global` or a canonical `project:<sha256>` scope. Search, get, proposal, review, export, forget, and purge default to the current project. Global records are visible only when explicitly requested:

- `knowledge_search` / `knowledge_get`: set `includeGlobal: true`;
- `knowledge_propose`: set `scope: "global"`;
- commands: prefix the target with `global`, or use `all` for export.

An opaque ID is not authorization. An ID copied from another project remains unavailable outside an explicitly visible scope.

## Reading knowledge

Use `knowledge_search` when prior project or user knowledge may answer a request. Results are accepted, evidence-backed claims/entities with stable claim/evidence IDs. Evidence is labeled as untrusted source data and should never be treated as instructions.

Use `knowledge_get` with a cited opaque ID to inspect a summary, evidence, history, or bounded one-hop neighbors. History is opt-in; superseded claims are excluded from current retrieval by default. Search and expansion are bounded, cancellable, and capped at 12 KiB of serialized output.

`/knowledge-status` reports the resolved project scope, trust state, database path/schema, record counts, pending proposal count, and configuration warnings without printing knowledge content.

## Proposals and review

`knowledge_propose` accepts one bounded candidate claim with one to five evidence records. It validates and normalizes the candidate, scans evidence/locators for common secrets, records Pi session/tool/branch provenance, and creates a **pending** proposal. It never accepts knowledge itself. Duplicate submissions are idempotent.

Review with:

```text
/knowledge-review
/knowledge-review <proposal-id>
/knowledge-review global <proposal-id>
```

The command requires an interactive TUI or RPC UI. It shows the candidate claim and evidence, then offers Accept, Edit, Reject, or Cancel. Editing appends corrected evidence; it never rewrites the original excerpt. A global proposal must be reviewed with the explicit `global` prefix.

Accepting a correction creates a replacement claim, links it to the prior claim, sets the prior claim's end time, marks it superseded, and retains both records and their evidence for history. Agent proposals cannot self-accept, and the MVP has no secret-scan override; redact or materially change a rejected candidate before resubmitting it.

## Export, backup, restore, and deletion

Export canonical records (not FTS indexes) to the private export directory:

```text
/knowledge-export
/knowledge-export project.json
/knowledge-export all-projects.json all
/knowledge-export global.json global
```

Exports are deterministic for an unchanged store, use simple filenames only, and are created with mode `0600`. The maintenance API also creates a verified SQLite backup in `backups/` and restores a logical snapshot only into an empty temporary store. Restore checks the snapshot schema and runs through a transaction; failed restores roll back.

Forget requires an explicit stable ID and interactive confirmation:

```text
/knowledge-forget <entity|alias|evidence|claim|proposal-id>
/knowledge-forget global <stable-id>
```

The command first shows counts of affected canonical/link/index rows. Shared evidence is retained when another claim still references it; directly forgetting referenced evidence fails closed so claim provenance is not silently broken. Forget removes only the selected scoped records and orphaned dependents, while retaining redacted audit metadata.

Purge a complete scope with:

```text
/knowledge-forget purge
/knowledge-forget global purge
```

Purge deletes that scope's entities, aliases, claims, evidence, proposals, relationship links, and derived FTS rows. The scope record and redacted audit history remain. No deletion occurs in print/JSON/non-interactive mode or when confirmation is cancelled.

Before migrations, SQLite creates a private verified backup. Migration and restore failures preserve the original database and fail without automatic downgrade or replacement.

## Modes and limitations

- TUI and RPC UI support proposal review and destructive confirmation.
- Print/JSON operation can submit a pending proposal but never waits for UI or reports acceptance.
- Search is explicit; the extension does not inject changing memory into every prompt or automatically mine sessions.
- Retrieval is lexical FTS5 plus bounded one-hop expansion; embeddings, nested model calls, cloud sync, multi-user ACLs, automatic mining, and code call-graph indexing are deferred.
- Regex secret scanning is conservative and cannot detect every sensitive value; the local SQLite file is not encrypted by the extension.

## Uninstall and data retention

Removing or disabling the extension does not delete `~/.pi/agent/knowledge-graph/`. Delete or archive that directory only after an explicit export/backup and user confirmation. Private backups and exports are user data and must be removed separately when no longer wanted.

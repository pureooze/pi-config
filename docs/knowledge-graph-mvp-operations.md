# Knowledge graph MVP operations

The knowledge graph is a local, single-user Pi extension. It stores evidence-backed claims in one private SQLite database and uses one shared knowledge scope for every read and mutation.

## Installation and runtime

The `@pureooze/pi-knowledge-graph` package exposes `./index.ts` through its Pi manifest. For local development, load `./packages/knowledge-graph/index.ts` directly and restart Pi, or reload the extension with `/reload` after changing it. The supported development/runtime baseline is:

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

The optional global `config.json` supports `defaultSearchLimit` and `showSourceLocators`. A trusted project may provide `.pi/knowledge-graph.json` for those preferences only. Untrusted project configuration is ignored and cannot change storage or knowledge visibility.

## Shared knowledge visibility

All accepted records belong to one shared `global` scope. The current working directory is used only for trusted preference loading and diagnostics; it is never used to partition, authorize, or filter knowledge. Search, get, maintenance, export, forget, and purge behave the same from `/home`, a repository, or any subdirectory.

Schema migration 8 moves legacy `project:<sha256>` records into `global` with a verified pre-migration backup. Legacy low-level scope fields may remain in snapshots and test fixtures, but runtime access is shared. See [`knowledge-graph-adr-009-shared-knowledge-scope.md`](knowledge-graph-adr-009-shared-knowledge-scope.md).

## Reading knowledge

Use `knowledge_search` first when a question concerns project facts, architecture, authentication or authorization flows, configuration, dependencies, ownership, prior decisions, preferences, or relationships. The extension adds this routing rule to each agent turn: do not begin with `read`, `grep`, `find`, `bash`, or other code/file search for those questions. If the result has insufficient evidence, then inspect the repository as a fallback. Results are accepted, evidence-backed claims/entities with stable claim/evidence IDs. Evidence is labeled as untrusted source data and should never be treated as instructions.

Search results include compact evidence citations and are sufficient for most answers. Use `knowledge_get` with a cited opaque ID only when search output needs expansion—such as an exact record lookup, evidence-level inspection, history, or bounded one-hop neighbors. Do not call it merely to confirm a complete search result. History is opt-in; superseded claims are excluded from current retrieval by default. Search and expansion are bounded, cancellable, and capped at 12 KiB of serialized output.

`/knowledge-status` reports the shared scope, config context, trust state, database path/schema, record counts, and configuration warnings without printing knowledge content.

## Autonomous agent maintenance

`knowledge_maintain` is the only agent-facing mutation tool. It lets the agent choose one bounded operation:

- `insert` creates and immediately accepts one evidence-backed claim;
- `update` requires `supersedesClaimId`, creates an accepted replacement, and retains prior history;
- `delete` forgets one visible stable ID with a required reason. It never exposes whole-scope purge.

All maintenance targets the shared scope. Insert/update use the internal normalization, reference checks, evidence limits, secret scanning, and audited transaction path. Delete uses the bounded forget service and records an agent/session/tool audit event. These operations are immediate in TUI, RPC, print, and JSON modes and do not wait for UI approval. Session branch navigation does not undo them.

There is no agent proposal/review fallback. See [`knowledge-graph-adr-008-autonomous-agent-maintenance.md`](knowledge-graph-adr-008-autonomous-agent-maintenance.md) for the policy and trade-offs.

## Export, backup, restore, and deletion

Export canonical records (not FTS indexes) to the private export directory:

```text
/knowledge-export
/knowledge-export knowledge.json
```

Legacy `current`, `global`, and `all` suffixes are accepted as compatibility aliases and all export the shared scope.

Exports are deterministic for an unchanged store, use simple filenames only, and are created with mode `0600`. The maintenance API also creates a verified SQLite backup in `backups/` and restores a logical snapshot only into an empty temporary store. Restore checks the snapshot schema and runs through a transaction; failed restores roll back.

Forget requires an explicit stable ID and interactive confirmation:

```text
/knowledge-forget <entity|alias|evidence|claim|proposal-id>
```

The command first shows counts of affected canonical/link/index rows. Shared evidence is retained when another claim still references it; directly forgetting referenced evidence fails closed so claim provenance is not silently broken. Forget removes only the selected records and orphaned dependents, while retaining redacted audit metadata.

Purge the shared knowledge base with:

```text
/knowledge-forget purge
```

Purge deletes the shared entities, aliases, claims, evidence, proposals, relationship links, and derived FTS rows. The shared scope record and redacted audit history remain. No deletion occurs through `/knowledge-forget` in print/JSON/non-interactive mode or when its confirmation is cancelled; `knowledge_maintain` is the separate explicitly autonomous exception described above.

Before migrations, SQLite creates a private verified backup. Migration and restore failures preserve the original database and fail without automatic downgrade or replacement.

## Modes and limitations

- TUI and RPC UI support explicit user export/forget confirmation; agent maintenance never waits for UI.
- Search is explicit; the extension does not inject changing memory into every prompt or automatically mine sessions. The agent may deliberately call `knowledge_maintain` for autonomous mutations.
- Retrieval is lexical FTS5 plus bounded one-hop expansion; embeddings, nested model calls, cloud sync, multi-user ACLs, automatic mining, and code call-graph indexing are deferred.
- Regex secret scanning is conservative and cannot detect every sensitive value; the local SQLite file is not encrypted by the extension.

## Uninstall and data retention

Removing or disabling the extension does not delete `~/.pi/agent/knowledge-graph/`. Delete or archive that directory only after an explicit export/backup and user confirmation. Private backups and exports are user data and must be removed separately when no longer wanted.

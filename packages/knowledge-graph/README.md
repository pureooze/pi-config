# @pureooze/pi-knowledge-graph

Local, evidence-backed knowledge search and maintenance tools for Pi.

> **Your graph data is not published with this package.** This is a code-only Pi extension. Your local SQLite database, backups, exports, configuration, sessions, and other user data remain on your machine and are not included in the npm package.

## Install

```bash
pi install npm:@pureooze/pi-knowledge-graph
```

The package exposes the Pi extension entrypoint from `index.ts` and requires Node.js `24.14.1` or newer because it uses Node's built-in `node:sqlite` driver.

## What npm publishes

The package tarball contains only:

- the extension TypeScript source files;
- `package.json` and this README; and
- the MIT `LICENSE`.

It does **not** contain or upload:

- `~/.pi/agent/knowledge-graph/knowledge.sqlite`;
- local backups, exports, or `config.json`;
- Pi session files or telemetry; or
- claims, evidence, entities, or any other records from your local graph.

The graph database is created at runtime under the user's home directory. `npm publish` operates on this package directory and does not read that database.

## Local storage and privacy

By default, the extension stores data here:

```text
~/.pi/agent/knowledge-graph/
├── knowledge.sqlite
├── backups/
├── exports/
└── config.json
```

The extension is local-only: it does not provide cloud sync or network ingestion. The current runtime uses one shared knowledge scope across projects, so accepted records can be retrieved from any working directory using the same Pi installation.

The database may contain user-provided claims and evidence. Storage directories are created with private permissions where supported, but the SQLite file is not encrypted by the extension. Secret detection is conservative and cannot detect every sensitive value. Review records before saving sensitive information.

## Tools and commands

- `knowledge_search` searches accepted shared knowledge with citations.
- `knowledge_get` expands a cited record with bounded evidence, history, or one-hop relationships.
- `knowledge_maintain` is the only agent-facing mutation tool. Validated insert, update, and single-record delete operations are immediate and audited; they do not wait for UI approval.
- `/knowledge-status` reports storage health and counts without knowledge content.
- `/knowledge-export` writes a private export.
- `/knowledge-forget` previews and confirms deletion of a record or the complete local graph.

Search and maintenance apply size limits, scope checks, private storage permissions, transactions, audit records, and conservative secret scanning. Session history and branch navigation do not undo accepted graph mutations.

Read the [operations guide](https://github.com/pureooze/pi-config/blob/main/docs/knowledge-graph-mvp-operations.md), [threat model](https://github.com/pureooze/pi-config/blob/main/docs/knowledge-graph-mvp-adr-006-threat-model-data-flow.md), and [autonomous maintenance policy](https://github.com/pureooze/pi-config/blob/main/docs/knowledge-graph-adr-008-autonomous-agent-maintenance.md) before enabling the package.

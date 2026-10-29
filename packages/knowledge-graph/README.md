# @pureooze/pi-knowledge-graph

A local, evidence-backed knowledge base for Pi. It helps Pi remember useful project facts, decisions, preferences, relationships, and other information across sessions and repositories.

## Install

```bash
pi install npm:@pureooze/pi-knowledge-graph
```

Restart Pi after installation if the extension is not available immediately.

Requirements:

- Pi `0.84.0` or newer;
- Node.js `24.14.1` or newer.

## How it works

The extension adds three tools:

- **`knowledge_search`** searches accepted knowledge and returns compact evidence citations.
- **`knowledge_get`** expands a cited record when you need its history, evidence, or relationships.
- **`knowledge_maintain`** inserts, updates, or deletes one evidence-backed record.

For questions about project facts and related information, Pi is instructed to search the knowledge base before searching files. Search results are bounded and include stable claim and evidence IDs that can be cited in an answer.

Knowledge maintenance is immediate and audited. An agent may insert or update a claim when it has appropriate evidence, or delete a specific record when there is user intent or a well-supported correction. Maintenance does not wait for a UI approval prompt, and changing session branches does not undo a mutation.

## Your data stays local

The extension does not provide cloud sync or network ingestion. By default it stores its SQLite database here:

```text
~/.pi/agent/knowledge-graph/
├── knowledge.sqlite
├── backups/
├── exports/
└── config.json
```

The database is created when the extension first needs storage. All accepted records use one shared knowledge scope for the Pi installation, so knowledge saved while working in one repository can be retrieved from another repository on the same machine.

The package does not include or access any existing graph when you install it. Your graph is created and maintained locally at runtime.

## Privacy and security

The database can contain claims, evidence excerpts, source locators, and audit metadata supplied by you, Pi, or local tools. Keep sensitive information out of the graph unless you understand the risks.

- Storage directories are created with mode `0700` and files with mode `0600` where supported.
- The SQLite database is not encrypted by this extension.
- Secret scanning is conservative and cannot detect every sensitive value.
- There is no multi-user access control; anyone who can access the local database can read it.
- The extension does not automatically mine every session. Records are added through explicit maintenance operations.

## Configuration

### Change the storage location

Set `PI_KNOWLEDGE_GRAPH_DIR` to an absolute, private directory before starting Pi:

```bash
export PI_KNOWLEDGE_GRAPH_DIR=/path/to/private/knowledge-graph
```

The directory must be owned by the current user, must not be a symlink, and must have private permissions.

### Search preferences

The default search limit is 8 results and may be changed to a value from 1 to 20. Source locators are hidden by default.

You can set environment variables:

```bash
export PI_KNOWLEDGE_GRAPH_DEFAULT_SEARCH_LIMIT=10
export PI_KNOWLEDGE_GRAPH_SHOW_SOURCE_LOCATORS=true
```

You can also put these preferences in `~/.pi/agent/knowledge-graph/config.json`:

```json
{
  "defaultSearchLimit": 10,
  "showSourceLocators": true
}
```

A trusted project may use `.pi/knowledge-graph.json` for the same two preferences. Project configuration cannot change the storage location or knowledge visibility. Environment variables take precedence over file-based preferences.

## Commands

Run these commands in Pi:

### Check storage and counts

```text
/knowledge-status
```

Shows the shared scope, database path, schema version, record counts, and configuration warnings without printing knowledge content.

### Export the knowledge base

```text
/knowledge-export
/knowledge-export my-backup.json
```

Writes a private canonical JSON export to the local `exports/` directory. Backups and exports contain your graph data; protect or delete them like the database itself.

### OKF import and export

```text
/knowledge-export --format okf
/knowledge-export --format okf my-knowledge-bundle
/knowledge-import /absolute/path/to/okf-bundle
```

[Open Knowledge Format (OKF v0.2)](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) bundles are directories of Markdown files with YAML frontmatter. JSON remains the default export. OKF does not replace SQLite or change search performance.

- **Export:** writes a new private directory (`0700`, files `0600`) under `exports/`; never overwrites an existing destination. Includes accepted entities and current accepted claims, readable relationships, source footnotes, and an `index.md`. An `x-pi-knowledge` extension preserves typed claim values, aliases, validity dates, and evidence for import. It is a current-knowledge interchange view, **not a backup**: IDs, supersession history, proposals, audit records, and claimless entities are not restored on import. Use canonical JSON/backups for archival fidelity.
- **Import:** reads a local bundle, validates it, shows counts, warnings and a truncated sample, then requires interactive confirmation. No UI, cancellation, validation failure, or changes during confirmation mean no imported records. Applying the batch is atomic and uses the existing secret scanning, evidence validation, deduplication and audited maintenance path. Reimporting the same bundle does not duplicate claims; imports do not update, supersede or delete existing claims.
- **Our exports:** the structured `x-pi-knowledge` claims are authoritative. Editing just the rendered Markdown body does not edit those claims. Unsupported extension versions fail validation. Imported evidence is attributed to the local bundle file; asserted original source kinds/locators are not promoted to trusted local evidence.
- **External bundles:** unknown concept types are accepted as generic concepts. The entire document, including unknown metadata, is preserved in `okf_content` text chunks rather than interpreted as typed graph relationships. Draft, deprecated, and stale concepts are skipped with warnings. `index.md` and `log.md` are navigation/history, not concepts. Non-Markdown assets are skipped.
- **Safety:** imported verification is untrusted; links and sources are never fetched, and executors/attesters are never run. Bundle/entry symlinks and special files are rejected. YAML aliases and custom tags are unsupported. Limits: 256 KiB per Markdown file, 16 MiB total Markdown, 1,000 concepts, 4,000 filesystem entries, 16 directory levels, and 10,000 candidate claims. Oversized exports fail rather than silently truncate. Import is user-command-only; `knowledge_maintain` remains the sole agent-facing mutation tool.

Exports contain private knowledge and local source paths. Inspect and redact bundles before sharing; exporting never uploads or commits them.

### Delete records

```text
/knowledge-forget <stable-id>
```

Previews the records affected by deleting one entity, claim, evidence record, or related item, then asks for confirmation.

To clear the shared knowledge records:

```text
/knowledge-forget purge
```

Purge is destructive and requires interactive confirmation. It removes the knowledge records and search index while retaining redacted audit metadata.

## Data lifecycle

Uninstalling or disabling the extension does not delete its database, backups, exports, or configuration. Use `/knowledge-export` or make a private backup before removing data. To remove all local files, stop Pi and delete the storage directory after confirming that you no longer need its contents.

## OpenCode integration

This package also includes a read-only MCP server for OpenCode. The server exposes `knowledge_search` and `knowledge_get` against the same shared SQLite store used by Pi.

From this repository, register it globally with:

```bash
opencode mcp add --global pi-knowledge -- node --experimental-strip-types /Users/uzair/git/pi-config/packages/knowledge-graph/mcp-server.ts
```

The server intentionally does not expose knowledge maintenance yet. Add writes only after reviewing the MCP client's permission and trust behavior.

## Limitations

- Retrieval uses lexical full-text search and bounded relationship expansion; it does not use embeddings.
- There is no cloud sync, automatic session mining, multi-user ACL, or code call-graph indexing.
- Secret detection is best-effort, not a guarantee.
- Autonomous maintenance can change the shared graph without a separate UI approval step; review the evidence and use deletion commands when records need correction.

For implementation details, see the [operations guide](https://github.com/pureooze/pi-config/blob/main/docs/knowledge-graph-mvp-operations.md), [threat model](https://github.com/pureooze/pi-config/blob/main/docs/knowledge-graph-mvp-adr-006-threat-model-data-flow.md), and [autonomous maintenance policy](https://github.com/pureooze/pi-config/blob/main/docs/knowledge-graph-adr-008-autonomous-agent-maintenance.md).

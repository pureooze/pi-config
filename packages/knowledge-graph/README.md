# @pureooze/pi-knowledge-graph

Provides local, evidence-backed knowledge search and maintenance tools for Pi.

## Install

```bash
pi install npm:@pureooze/pi-knowledge-graph
```

The extension stores knowledge in a private, local SQLite database under `~/.pi/agent/knowledge-graph/` by default. It does not provide cloud sync or network ingestion. The current runtime uses one shared knowledge scope across projects, so accepted records can be retrieved from any working directory using the same Pi installation.

`knowledge_maintain` is the only agent-facing mutation tool. Validated insert, update, and single-record delete operations are immediate and audited; they do not wait for UI approval. The extension applies size limits, scope checks, private storage permissions, and conservative secret scanning. Regex scanning cannot detect every sensitive value, and the SQLite file is not encrypted by the extension.

Read [`docs/knowledge-graph-mvp-operations.md`](https://github.com/pureooze/pi-config/blob/main/docs/knowledge-graph-mvp-operations.md) and the threat model before enabling this package.

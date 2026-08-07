# ADR-006: MVP threat model and data-flow controls

**Status:** accepted for MVP

**Date:** 2026-08-06

**Decision task:** KGM-1.7

## Security boundary and assumptions

The knowledge graph is a local, single-user Pi extension. The extension and its dependencies run with the same operating-system permissions as Pi. The MVP does not protect data from a compromised user account, root/administrator access, a malicious installed extension, or an attacker who can read the user’s private storage directory.

The MVP does provide application-level controls against accidental and model-mediated misuse:

- no network ingestion or cloud synchronization;
- one private local store with explicit global/project scopes;
- project trust gates project-local configuration but is not a data-authorization substitute;
- evidence and retrieved content are untrusted data, never executable instructions;
- accepted durable writes and destructive operations require explicit review;
- all external input is runtime-validated and bounded;
- canonical data and audit history are preserved rather than silently overwritten.

## Assets and data classes

| Asset | Sensitivity | Required handling |
|---|---|---|
| Accepted claims/entities/aliases | user/project memory | private storage, scope filtering, inspect/export/forget/purge |
| Evidence excerpts/locators | potentially sensitive source text and paths | pre-persistence secret scan, size limits, citations, no routine telemetry |
| Pending proposals | untrusted candidate knowledge | invisible to accepted retrieval, reviewable, auditable, purgeable |
| Scope/project identity | project metadata and local paths | resolve deterministically, do not expose excluded scope details |
| Audit events | provenance and operation metadata | append-only, bounded/redacted, no duplicated source content |
| Database/backups/exports | complete local knowledge | restrictive permissions, explicit destination/confirmation, recovery validation |
| Tool output/context | model-visible knowledge | bounded, cited, untrusted-data labeling, no hidden cross-scope content |
| Configuration | user preferences and possible repository-controlled input | validate as `unknown`; project config only when Pi-trusted |

## Data-flow overview

### Read path

```text
Pi tool arguments
  → strict schema/runtime validation
  → current project identity + explicit global opt-in
  → scope/status/time filter before lookup
  → parameterized FTS query
  → bounded one-hop expansion
  → deterministic ranking and citation assembly
  → UTF-8 output cap and untrusted-data labels
  → Pi model/UI/RPC client
```

No retrieved text is executed, interpreted as configuration, or used to alter tool permissions. Search and get never perform writes.

### Proposal/review path

```text
Pi model or user command
  → strict proposal schema
  → scope/reference/normalization checks
  → size and secret scan
  → transactional pending proposal + candidate rows + evidence + audit event
  → explicit TUI/RPC review
  → transactional accept/reject/correct/supersede
  → accepted retrieval indexes
```

`knowledge_propose` cannot accept a claim. A model cannot set actor, trust, status, audit fields, raw scope IDs, or database paths.

### Maintenance path

```text
User command
  → explicit target/scope and confirmation
  → preview affected canonical/derived rows
  → transactional export/forget/purge/migration operation
  → audit event and health result
```

Exports omit derived indexes. Purge removes canonical and derived content according to the preview; routine telemetry never receives the content.

### Configuration path

```text
Process environment/global config
  → runtime validation and private-path checks
Project .pi/knowledge-graph.json
  → read only when ctx.isProjectTrusted() is true
  → safe preference validation
  → cannot change database path, identity algorithm, or global-access policy
```

An untrusted project config is ignored. The extension does not override Pi’s trust decision.

## Threat/control/test matrix

Every threat below has a preventive implementation task and a planned test or validation task.

| Threat | Preventive control | Implementation task | Test/evidence task |
|---|---|---|---|
| Prompt injection in evidence, files, or retrieved text | Label source as untrusted data; never execute or follow source instructions; keep retrieval separate from system instructions | KGM-3.4, KGM-4.5 | KGM-6.4 prompt-injection fixtures; `s-prompt-injection-is-data` in the MVP corpus |
| Source/data poisoning | Agent submissions remain proposals; evidence trust is provenance, not model confidence; review before acceptance | KGM-1.4, KGM-5.2, KGM-5.4 | KGM-5.7 rejected/edited/inferred proposal tests; KGM-G5 review invariant |
| Secret or personal-data persistence | Conservative pre-persistence scanning, bounded excerpts, explicit no-raw-session-capture policy, redacted diagnostics | KGM-5.1 | KGM-5.7 secret rejection and KGM-6.4 leakage tests; `s-secret-before-persistence` |
| Cross-project data exfiltration | Canonical project identity; explicit global opt-in; scope filter before every lookup/rank/traversal/mutation | KGM-1.3, KGM-2.5, KGM-4.1 | KGM-2.7, KGM-3.5, KGM-5.7, KGM-6.4; cross-scope corpus queries |
| Guessed or copied stable IDs | Opaque IDs are not authorization; exact-ID repositories require resolved visible scope | KGM-2.5, KGM-4.3 | KGM-5.7 guessed-ID attack and KGM-6.4 exact-ID scope tests |
| SQL injection or malformed structured input | TypeBox plus runtime validation; parameterized statements; no raw query language | KGM-1.4, KGM-2.5, KGM-4.2, KGM-4.3 | KGM-5.7 malformed input and KGM-6.4 SQL-injection fixtures |
| Unsafe database/export paths or symlink attacks | User-rooted default, absolute env override only, private permissions, symlink rejection, trusted project config only | KGM-1.2, KGM-2.3 | KGM-2.3 permission/path tests and KGM-6.4 symlink/path-traversal tests |
| Oversized input/output denial of service | Hard query, excerpt, result, proposal, traversal, and output limits; reject before allocation/persistence | KGM-1.4, KGM-3.3, KGM-3.4, KGM-5.1 | KGM-5.7 malformed/oversized cases and KGM-6.4 resource-exhaustion tests |
| High-degree nodes, cycles, or unbounded traversal | One-hop MVP limit, cycle-safe traversal, result/deadline/cancellation checks | KGM-3.3 | KGM-3.5 bounded benchmark and KGM-6.4 high-degree/cycle tests |
| SQLite corruption or concurrent lost updates | Foreign keys, WAL/busy policy, integrity checks, transactions, migration backups, normalized busy errors | KGM-2.4, KGM-5.6 | KGM-2.7 integrity/rollback tests and KGM-6.3 crash/concurrency tests |
| Cancellation/deadline ignored | Thread signals/deadlines through tool/repository/traversal work; close resources at shutdown | KGM-3.3, KGM-4.1 | KGM-6.4 deadline/cancellation tests |
| Telemetry/log leakage | No content in telemetry; bounded/redacted diagnostics; purge removes derived/log copies | KGM-4.4, KGM-5.1, KGM-6.2, KGM-6.6 | KGM-5.7 and KGM-6.4 inspect telemetry/logs after secret/purge fixtures |
| Excessive agency or silent mutation | Separate propose/review; no automatic acceptance, deletion, or bulk writes; explicit destructive confirmation | KGM-1.4, KGM-5.2, KGM-5.3, KGM-5.4 | KGM-5.7 cancellation/review/acceptance tests and KGM-G5 |
| False provenance or branch confusion | Actor/session/tool/branch fields set by extension; `/tree` does not undo external graph state | KGM-5.6 | KGM-5.7 fork/resume/concurrent provenance tests |
| Project-controlled configuration abuse | Ignore untrusted project config; trusted config cannot redirect storage or widen global access | KGM-1.3, KGM-2.3 | KGM-2.3 trusted/untrusted config fixtures and KGM-6.4 path/scope tests |
| Dependency or native-binary supply-chain risk | Prefer built-in SQLite; dependency inventory and install/network/license review | KGM-1.1, KGM-6.6 | KGM-6.6 dependency/security review |
| Recovery replacing or exposing the wrong database | Verified temporary backup, integrity check, atomic rename, no automatic downgrade/replacement | KGM-1.2, KGM-2.4, KGM-6.1 | KGM-6.3 migration/crash tests and KGM-6.8 clean-checkout recovery flow |

## Security invariants

The following must remain true regardless of model, provider, or Pi mode:

1. No operation can read or mutate an excluded project scope by omitting scope, guessing an ID, or traversing a relationship.
2. No secret-like evidence is persisted before the pre-persistence scanner accepts it.
3. No agent tool call alone changes a proposal to accepted status.
4. No retrieved source text changes system instructions, tool availability, filesystem paths, or permissions.
5. No input controls database paths, SQL text, row IDs, actor/trust fields, or audit timestamps.
6. No default output exceeds the fixed byte limit or contains unrequested history/global data.
7. No cancellation or failed transaction leaves a partial accepted graph mutation.
8. No routine telemetry or error output contains knowledge excerpts, secret values, or excluded-scope content.
9. No `/tree`, fork, resume, or compaction operation falsely claims to revert an accepted external graph mutation.
10. No recovery action silently destroys the original database or downgrades its schema.

These invariants are acceptance properties, not merely documentation. Each maps to one or more tests in the matrix above.

## Residual risks

- Regex-based secret scanning cannot guarantee detection of every sensitive value; the MVP avoids automatic raw-session capture and provides explicit purge/inspection instead of claiming perfect DLP.
- The local SQLite file is not encrypted by the extension. Users needing protection from other local accounts require OS/filesystem encryption.
- Pi project trust protects configuration loading, not model behavior or repository content. Untrusted repositories still require normal Pi/container precautions.
- A malicious installed dependency or extension remains inside the user’s trust boundary.
- Global knowledge intentionally becomes available across projects only when the user explicitly requests it; users must review global proposals carefully.

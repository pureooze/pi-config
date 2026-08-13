# ADR-008: Autonomous agent maintenance

**Status:** accepted

**Date:** 2026-08-11

> Runtime visibility is the shared scope defined by [ADR-009](knowledge-graph-adr-009-shared-knowledge-scope.md); the maintenance policy does not partition writes by working directory.

## Context

The reviewed-write MVP let the agent submit pending proposals, but it could not accept or delete knowledge. The product policy is now autonomous maintenance: the Pi agent decides when a shared knowledge item should be inserted, corrected, or forgotten.

This is an explicit post-MVP change to the MVP's excessive-agency boundary. It does not make the extension an always-on memory miner: the agent must deliberately call the maintenance tool, and the extension still validates, bounds, scans, and audits every operation.

## Decision

Register one agent-facing mutation tool, `knowledge_maintain`, with three operations:

- `insert` — create one evidence-backed claim and immediately accept it;
- `update` — create and immediately accept an evidence-backed replacement for one accepted claim;
- `delete` — forget one explicitly named visible stable-ID record immediately.

There is no agent-facing `knowledge_propose` tool and no `/knowledge-review` command. The proposal service remains an internal implementation detail used to normalize, persist, and audit insert/update operations before immediate agent acceptance. It is not an approval step or an alternate agent workflow.

### Insert

`insert` accepts bounded subject, predicate, typed object, validity, evidence, and idempotency fields. It calls the internal normalization, reference, secret-scan, and transactional proposal path, then immediately accepts the newly created proposal as `actorType: "agent"`. The result includes the accepted proposal, claim, entity, and evidence IDs.

An identical existing candidate is idempotent. If it is already accepted, the tool reports `already_known`; an existing pending or rejected proposal is not silently promoted by a different call.

### Update

`update` requires `supersedesClaimId` and that ID must refer to an accepted claim in the shared knowledge graph. The prior claim is never overwritten. The tool creates a replacement proposal, accepts it as the agent, links the replacement to the prior claim, marks the prior claim superseded, sets its end time, and retains both claims and all evidence for history.

### Delete

`delete` requires one stable `targetId` and a bounded, secret-scanned `reason`. It calls the existing bounded `forget` service, not `purge`. The service previews and bounds the complete dependent-record cascade, removes canonical and derived search rows transactionally, and retains redacted audit metadata. Whole-scope purge is never exposed to the agent-maintenance tool.

Deletion is immediate and cannot be undone by Pi session branching, `/tree`, fork, or resume. Recovery is through the documented export/backup workflow.

## Shared controls

- All mutations target the shared knowledge scope; working directory and path are not accepted as knowledge identity.
- Raw scope IDs, SQL, arbitrary query languages, statuses, trust classes, actor fields, timestamps, database paths, and bulk target lists are not accepted.
- Insert/update require one to five bounded evidence records. Evidence and deletion reasons are scanned before persistence; secret-like values fail closed.
- Every accepted mutation records the agent actor type and Pi session, entry, tool-call, and branch provenance when available.
- Update is append-only supersession; it cannot silently overwrite a claim.
- Delete accepts only one stable ID and respects the existing 10,000-record affected-record bound.
- Tool execution works in TUI, RPC, print, and JSON modes without waiting for UI confirmation.
- Source excerpts remain untrusted data. Prompt instructions found in evidence do not grant permissions or change this policy.

## Consequences

The agent can keep durable knowledge current without a separate review turn, which reduces friction for stable facts and corrections. It also increases the impact of model mistakes or prompt injection. The tool therefore remains deliberately narrow, evidence-backed, append-oriented for updates, non-bulk for deletion, and fully auditable.

Autonomous maintenance is the only agent-facing mutation policy. No configuration toggle or approval fallback is provided. Disabling the knowledge-graph extension is the only way to disable these mutations; read-only search/get and explicit user maintenance commands remain separate surfaces.

## Operational budget

The MVP's 1,500-estimated-token budget remains the baseline for the original search/get surface. The full active-tool budget is raised to 4,000 estimated tokens for this post-MVP increment because `knowledge_maintain` exposes a complete structured candidate schema rather than accepting opaque model-generated JSON. The benchmark measured 2,645 estimated active-tool tokens after this change, so the revised budget passes without relaxing correctness, secret, output, or latency limits. Dynamic activation can reduce this overhead in a later measured optimization.

## Validation

The behavior is covered by:

- `extensions/knowledge-graph/agent-maintenance.ts`;
- `tests/unit/knowledge-graph-agent-maintenance.test.mjs`;
- `tests/unit/knowledge-graph-extension.test.mjs`;
- `npm run typecheck`;
- `npm run test:unit`.

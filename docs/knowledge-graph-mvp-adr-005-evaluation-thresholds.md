# ADR-005: MVP evaluation and provisional performance thresholds

**Status:** accepted for MVP

**Date:** 2026-08-06

> Historical MVP thresholds. Runtime knowledge is now intentionally shared across working directories under [`knowledge-graph-adr-009-shared-knowledge-scope.md`](knowledge-graph-adr-009-shared-knowledge-scope.md); the corpus still exercises the legacy low-level scope primitives.

**Decision task:** KGM-1.6

## Purpose

Set the quality and operational thresholds before retrieval or Pi tool implementation results are available. These thresholds apply to the deterministic corpus in [`tests/fixtures/knowledge-graph-mvp-corpus.json`](../tests/fixtures/knowledge-graph-mvp-corpus.json) and to a deterministic 10,000-claim scale fixture generated from the same schema.

The corpus validator currently establishes fixture integrity. Retrieval metrics are measured by KGM-3.5 after the storage and retrieval runner exist. A failed metric remains visible and blocks the relevant gate until remediated or this ADR is explicitly revised with evidence.

## Required correctness thresholds

| Metric | MVP threshold | Measurement rule |
|---|---:|---|
| Cross-project leakage | **0** | No search, get, neighbor, review, export, or delete operation may return or mutate an excluded project claim/entity/evidence record, including guessed exact IDs. |
| Secret-like persistence | **100% rejection** | Every secret fixture is rejected before evidence, proposal, or canonical claim persistence; no full sentinel appears in output/logs. |
| Exact/alias evidence Recall@5 | **≥90%** | Macro-average over labeled exact and alias search cases; a hit requires the expected evidence ID in the five highest-ranked results. |
| Relationship evidence Recall@5 | **≥80%** | Macro-average over labeled relationship and one-hop cases; expected relationship evidence must appear in the top five. |
| Temporal/status correctness | **100%** | Current queries exclude superseded/out-of-interval claims; explicit history/as-of queries return every labeled expected claim and no forbidden claim. |
| Labeled unanswerable handling | **100%** | Unanswerable and scope-excluded cases return `insufficientEvidence`/a stable not-found result and never fabricate an accepted claim. |
| Proposal review invariant | **100%** | Agent proposals remain pending until explicit review; no accepted inferred/untrusted claim is created by tool execution alone. |
| Determinism | **100% fixture repeatability** | Identical fixture, clock, ID, and query inputs produce identical expected ID sets, ordering tie-breaks, truncation flags, and serialized diagnostics. |

Recall is measured against evidence/claim IDs, not generated natural-language answers. A query with multiple expected IDs is a hit only for the IDs actually returned; missing evidence is not hidden by a plausible summary.

## Hard safety and boundedness limits

These are rejection limits, not targets:

- query input: maximum 512 Unicode code points;
- default results: 8;
- maximum search/get/neighbor results: 20;
- maximum evidence citations per result: 3;
- maximum output: 12 KiB UTF-8 after serialization;
- one-hop graph expansion only in the MVP;
- every traversal has a node/result limit, cycle protection, deadline, and cancellation check;
- proposal: one claim, at most five evidence records, and at most two new entities;
- evidence excerpt: maximum 4,000 code points at input and 1,000 in default output;
- no arbitrary SQL, graph query language, unbounded pagination, or bulk automatic acceptance.

## Provisional local performance budgets

These are measured on a temporary local database, excluding model/network latency and user typing. They are intentionally provisional until the implementation and scale fixture exist.

| Operation | Warm p50 | Warm p95 |
|---|---:|---:|
| Accepted FTS search | ≤50 ms | ≤200 ms |
| FTS plus bounded one-hop retrieval | ≤75 ms | ≤250 ms |
| Exact-ID summary/get | ≤25 ms | ≤150 ms |
| Validated proposal persistence | ≤100 ms | ≤500 ms |
| Session-scoped database open/health check without migration | ≤100 ms | ≤250 ms |
| Tool result serialization/truncation | ≤10 ms | ≤50 ms |

Additional budgets:

- active MVP tool descriptions and routing guidance: **≤1,500 estimated tokens**;
- extension-added startup prompt/context content: **≤500 estimated tokens** when no knowledge is explicitly requested;
- benchmark process must not use the real user database or write knowledge into telemetry.

Database size, cold-start behavior, migration time, index rebuild time, review completion time, and memory usage are reported as measurements. They are not silently converted into pass criteria after seeing results.

## Measurement protocol

1. Run on the documented baseline machine: Linux `7.1.5-200.fc44.x86_64` (`x86_64`), AMD Ryzen 5 3600X, 12 logical CPUs, 31 GiB RAM, Node `v24.14.1`, bundled SQLite `3.51.2`, Pi `0.84.0`.
2. Use an isolated temporary store and disable network access for benchmark code.
3. Seed the 35-claim corpus, then use a deterministic expansion to 10,000 claims without changing the labeled query semantics.
4. Measure at least 30 cold runs and 100 warm runs per operation with an injected monotonic clock; report p50, p95, minimum, maximum, and sample count.
5. Separate database work, tool validation, serialization, and TUI rendering when possible. Do not include model generation time.
6. Record the exact Node/Pi versions, fixture hash, scale, command, and result summary. Do not print secret-like fixture values.
7. Run correctness and leakage assertions before performance reporting so an apparently fast unsafe result cannot pass.

A different machine or supported runtime must be identified in the report. Results are not compared across hardware without labeling the environment.

## Threshold change policy

The implementation may not lower a threshold merely because it fails. A revision requires:

- the failing measurement and reproducible command;
- a reason the original threshold was invalid rather than merely inconvenient;
- an updated rationale and impact on the user workflow;
- a new ADR revision or recorded decision before the dependent gate is checked.

Safety thresholds—zero scope leakage, pre-persistence secret rejection, no unreviewed acceptance, bounded traversal, and bounded output—are not relaxed for the MVP.

**Post-MVP note (2026-08-11):** ADR-008 replaces the agent-facing proposal/review surface with an explicitly named autonomous maintenance tool using a full candidate schema. Its separate 4,000-estimated-token all-active-tool budget is documented and measured there; the original 1,500-token budget remains the baseline for the MVP search/get surface. The historical proposal-review threshold remains in this MVP ADR for reproducibility.

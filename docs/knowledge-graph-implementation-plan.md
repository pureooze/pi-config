# Pi knowledge graph implementation plan

**Status:** post-MVP roadmap

**Last reviewed:** 2026-08-06

**Research basis:** [knowledge-graph-research.md](knowledge-graph-research.md)

**Execute first:** [knowledge-graph-mvp-plan.md](knowledge-graph-mvp-plan.md)

This document preserves the broader production roadmap. The MVP plan is the authoritative execution tracker until its `KGM-G6` gate is complete; where the plans differ before that gate, the MVP plan takes precedence.

**Current write-policy note (2026-08-11):** `knowledge_maintain` is the only agent-facing mutation tool. The older proposal/review tasks below describe historical MVP work or future architecture considerations; they are not an available approval workflow.

## Goal

Build a local-first Pi extension that lets the agent accumulate, retrieve, review, correct, and forget evidence-backed knowledge across sessions without leaking knowledge across projects or flooding the model context.

The MVP is a claim-centric temporal knowledge graph for user and project memory. It is **not** initially a generic document GraphRAG pipeline, a code AST/call graph, a cloud service, or an autonomous always-on memory miner.

## How to maintain this plan

This file is the implementation tracker. Contributors and agents must update it as work is completed.

### Task status rules

- `[ ]` means not complete.
- `[x]` means complete **and its acceptance criteria have been verified**.
- Keep a blocked task unchecked and append `— BLOCKED: <reason>`.
- Optional work is marked **Optional** and does not block the phase gate unless promoted to required work.
- Do not check a phase gate until every required task in that phase is checked.
- When scope changes, edit the task and add the rationale under its Notes/Evidence line rather than checking an obsolete task.

### Evidence rules

When checking a task, append concise evidence:

```markdown
- [x] **KG-N.N — Add schema migration runner.**
  - Depends on: KG-N.M
  - Acceptance: migrations are transactional and an older fixture upgrades successfully.
  - Evidence: `extensions/knowledge-graph/storage/migrations.ts`; `npm test -- migrations` passes.
```

Acceptable evidence includes:

- changed file paths;
- exact validation commands and results;
- benchmark report paths;
- an ADR or design-review link;
- a short manual-test record where automation is not practical.

“I wrote the code” is not completion evidence. Tests must cover the acceptance criteria.

### Ordering rules

- Task IDs are stable references, not a substitute for dependencies.
- Complete a task’s `Depends on` items first.
- Tasks marked `Parallel with` may proceed concurrently after their shared dependencies.
- Each phase has a gate. Do not begin a later phase that depends on that gate.
- Security, migration, and data-deletion tests are release blockers; do not defer them merely to make the demo work.

## Proposed repository shape

This is a target layout, subject to the architecture decisions in Phase 1:

```text
extensions/knowledge-graph/
├── index.ts                    # Pi registration only
├── config.ts                   # runtime-validated global/project config
├── domain/
│   ├── types.ts
│   ├── ids.ts
│   ├── predicates.ts
│   └── validation.ts
├── storage/
│   ├── database.ts
│   ├── migrations.ts
│   ├── repository.ts
│   └── schema/
├── ingestion/
│   ├── episodes.ts
│   ├── candidates.ts
│   ├── entity-resolution.ts
│   ├── conflicts.ts
│   └── secret-scan.ts
├── retrieval/
│   ├── lexical.ts
│   ├── traversal.ts
│   ├── ranking.ts
│   └── context-pack.ts
├── pi/
│   ├── tools.ts
│   ├── hooks.ts
│   ├── commands.ts
│   └── renderers.ts
└── tests/
    ├── fixtures/
    ├── unit/
    ├── integration/
    └── pi/

docs/
├── knowledge-graph-research.md
├── knowledge-graph-implementation-plan.md
└── adr/
```

The extension entrypoint should be composition/registration code. Domain and storage logic should remain independently testable without starting Pi.

## Milestones

| Milestone | Outcome | Required phase gates |
|---|---|---|
| M0 | Architecture accepted and baseline measured | Phases 0–1 |
| M1 | Durable, auditable local graph core | Phases 2–3 |
| M2 | Safe candidate ingestion and review | Phase 4 |
| M3 | Useful retrieval independent of Pi | Phase 5 |
| M4 | Pi read-only alpha | Phase 6 |
| M5 | Pi reviewed-write beta | Phases 7–8 |
| M6 | Secure, evaluated release candidate | Phases 9–11 |
| M7 | Documented release | Phase 12 |

---

## Phase 0 — Research and repository baseline

- [x] **KG-0.1 — Research modern knowledge graphs and agent memory.**
  - Depends on: none
  - Acceptance: research covers representation, ingestion, identity, time, provenance, retrieval, evaluation, and security.
  - Evidence: [`docs/knowledge-graph-research.md`](knowledge-graph-research.md), reviewed 2026-08-06.

- [x] **KG-0.2 — Survey Pi and MCP prior art.**
  - Depends on: none
  - Acceptance: identify reusable lessons and gaps from at least one MCP graph, one Pi memory system, one temporal graph, and one code graph.
  - Evidence: prior-art table and references in [`docs/knowledge-graph-research.md`](knowledge-graph-research.md).

- [x] **KG-0.3 — Produce an ordered implementation tracker.**
  - Depends on: KG-0.1, KG-0.2
  - Acceptance: tasks have IDs, dependencies, acceptance criteria, evidence instructions, and phase gates.
  - Evidence: this document.

- [x] **KG-0.4 — Record the repository’s validation baseline.**
  - Depends on: none
  - Acceptance: document available Node/Pi versions, current startup command, type-check/test commands if any, and known pre-existing failures without modifying unrelated work.
  - Evidence: 2026-08-06 read-only baseline: Pi `0.84.0`, Node `v24.14.1`, npm `11.11.0`; no lockfile, `scripts`, or `tsconfig.json`; `pi --offline --help` exited 0 with no stderr. Existing unrelated working-tree changes were present in `AGENTS.md`, `README.md`, `package.json`, `extensions/todo-session.ts`, `extensions/subagents/*`, and `scripts/pi-auto-resume` before this work.

- [x] **Phase 0 gate — Baseline is reproducible.**
  - Depends on: KG-0.1–KG-0.4
  - Acceptance: another contributor can run the same read-only baseline and distinguish existing failures from plugin regressions.
  - Evidence: rerun `the work-with-pi skill's scripts/pi-doctor.sh`, the version/package checks in KG-0.4, and `pi --offline --help` from the repository root.

## Phase 1 — Scope and architecture decisions

These decisions prevent expensive schema and API rewrites. Complete them before building persistence.

- [ ] **KG-1.1 — Write the product-scope ADR.**
  - Depends on: Phase 0 gate
  - Acceptance: define target users, global/project/session scopes, MVP use cases, non-goals, data ownership, and success metrics.
  - Required decision: confirm that MVP is agent/project semantic memory, not generic corpus GraphRAG or code call-graph indexing.

- [ ] **KG-1.2 — Write the canonical-storage ADR.**
  - Depends on: KG-1.1
  - Acceptance: compare (a) SQLite canonical store plus exports and (b) Markdown/JSONL canonical store plus a derived index; decide recovery, portability, concurrent-write, and migration behavior.
  - Recommended default: SQLite canonical store with immutable episodes and deterministic JSONL/Markdown export.

- [ ] **KG-1.3 — Write the graph-model and ontology ADR.**
  - Depends on: KG-1.1
  - Acceptance: define entity, alias, predicate, typed literal, reified claim, evidence, scope, status, confidence, temporal interval, supersession, and audit semantics.
  - Acceptance: include a small MVP predicate vocabulary and a governed custom-predicate proposal path.

- [ ] **KG-1.4 — Write the temporal/conflict ADR.**
  - Depends on: KG-1.3
  - Acceptance: define valid time versus observation/transaction time; exclusive predicates; overlap rules; disputed claims; correction versus supersession; and “current fact” queries.

- [ ] **KG-1.5 — Write the scope/project-identity ADR.**
  - Depends on: KG-1.1
  - Acceptance: define canonical project identity across subdirectories, worktrees, symlinks, moves, and non-git directories.
  - Acceptance: exact-ID, alias, traversal, export, and maintenance operations all obey the same scope boundary.

- [ ] **KG-1.6 — Write the approval and deletion ADR.**
  - Depends on: KG-1.1, KG-1.3
  - Acceptance: define behavior for explicit “remember this,” agent inference, imported trusted docs, untrusted web content, correction, rejection, forget, and full purge.
  - Recommended default: agent extraction creates proposals; durable acceptance is user-reviewed.

- [ ] **KG-1.7 — Write the retrieval/context ADR.**
  - Depends on: KG-1.3–KG-1.5
  - Acceptance: define retrieval modes, ranking signals, graph bounds, evidence format, context budget, abstention, and automatic recall policy.
  - Required baseline: FTS-only retrieval remains available for comparison and fallback.

- [ ] **KG-1.8 — Write the Pi API ADR.**
  - Depends on: KG-1.6, KG-1.7
  - Acceptance: choose tool names/schemas, slash commands, hook usage, behavior in TUI/RPC/JSON/print modes, and dynamic tool activation.
  - Acceptance: document Pi branch semantics and external graph mutations explicitly.

- [ ] **KG-1.9 — Decide configuration and filesystem locations.**
  - Depends on: KG-1.2, KG-1.5
  - Acceptance: choose global/project config precedence, database path, export path, permissions, environment overrides, and trusted-project behavior.
  - Acceptance: defaults do not place private global knowledge inside arbitrary repositories.

- [ ] **KG-1.10 — Design review and threat-model review.**
  - Depends on: KG-1.1–KG-1.9
  - Acceptance: every research requirement is accepted, explicitly deferred, or rejected with rationale; major threats have owners and planned tests.

- [ ] **Phase 1 gate — Architecture is implementation-ready.**
  - Depends on: KG-1.1–KG-1.10
  - Acceptance: ADRs agree on IDs, scope, time, write approval, deletion, storage, and Pi surface; no unresolved decision changes the initial schema.

## Phase 2 — Extension scaffold and test harness

- [ ] **KG-2.1 — Add the extension module skeleton.**
  - Depends on: Phase 1 gate
  - Acceptance: create `extensions/knowledge-graph/` with a minimal `index.ts`; extension loads without registering unfinished behavior.

- [ ] **KG-2.2 — Register the extension in the Pi package manifest.**
  - Depends on: KG-2.1
  - Acceptance: `package.json` declares the new extension without disturbing existing extension entries.
  - Note: preserve unrelated uncommitted repository changes when implementing this task.

- [ ] **KG-2.3 — Establish strict type-checking and test commands.**
  - Depends on: KG-2.1
  - Acceptance: select the existing package manager or document the absence of one; add the minimum test/type tooling; do not introduce a second lockfile/package manager.
  - Acceptance: commands cover unit tests, integration tests, formatting/linting if configured, and an isolated Pi startup test.

- [ ] **KG-2.4 — Add runtime validation helpers.**
  - Depends on: KG-2.3
  - Parallel with: KG-2.5
  - Acceptance: external JSON/config/model output is treated as `unknown` and validated without `any`, unsafe broad casts, or non-null assertions.

- [ ] **KG-2.5 — Add test fixture builders and temporary-store helpers.**
  - Depends on: KG-2.3
  - Parallel with: KG-2.4
  - Acceptance: every test can use an isolated temporary database and deterministic clock/IDs; tests never touch the user’s real Pi knowledge store.

- [ ] **KG-2.6 — Add a read-only extension smoke test.**
  - Depends on: KG-2.1–KG-2.5
  - Acceptance: `pi --no-extensions -e ./extensions/knowledge-graph/index.ts` starts cleanly with networking disabled/unavailable.

- [ ] **Phase 2 gate — Safe development loop exists.**
  - Depends on: KG-2.1–KG-2.6
  - Acceptance: a clean checkout can run type checks, tests, and isolated Pi startup with documented commands.

## Phase 3 — Durable graph core

- [ ] **KG-3.1 — Implement domain IDs and record types.**
  - Depends on: Phase 2 gate
  - Acceptance: typed IDs and immutable input/output interfaces cover scopes, episodes, spans, entities, aliases, predicates, claims, evidence, and audit events.

- [ ] **KG-3.2 — Implement the initial schema and transactional migration runner.**
  - Depends on: KG-3.1
  - Acceptance: schema matches the ADRs; migrations are ordered, transactional, idempotent, and recorded by version.
  - Acceptance: tables and indexes enforce foreign keys and important uniqueness constraints.

- [ ] **KG-3.3 — Implement database lifecycle and concurrency policy.**
  - Depends on: KG-3.2
  - Acceptance: lazy open, WAL/busy-timeout choice, close, cancellation, and concurrent Pi-process behavior are tested.
  - Acceptance: extension factory does not create prohibited long-lived session resources.

- [ ] **KG-3.4 — Implement scope and project-identity resolution.**
  - Depends on: KG-3.1, ADR KG-1.5
  - Parallel with: KG-3.5
  - Acceptance: subdirectory/symlink/worktree/non-git fixtures resolve according to the ADR; untrusted project configuration is ignored.

- [ ] **KG-3.5 — Implement repositories for canonical records.**
  - Depends on: KG-3.2
  - Parallel with: KG-3.4
  - Acceptance: create/read/list operations are parameterized, transactional where needed, and scope-filtered.

- [ ] **KG-3.6 — Implement immutable episode and source-span capture.**
  - Depends on: KG-3.4, KG-3.5
  - Acceptance: hashes make repeated ingestion idempotent; source revisions and citable spans are retained.

- [ ] **KG-3.7 — Implement predicate registry and deterministic validation.**
  - Depends on: KG-3.1, KG-3.5
  - Acceptance: domain/range, direction, object kind, cardinality, exclusivity, and temporal rules are enforced before claim insertion.

- [ ] **KG-3.8 — Implement claim lifecycle and audit events.**
  - Depends on: KG-3.6, KG-3.7
  - Acceptance: propose, accept, reject, dispute, supersede, expire, and correct operations preserve prior state and evidence.
  - Acceptance: every mutation records actor, time, scope, session/tool-call provenance, and before/after references.

- [ ] **KG-3.9 — Implement integrity check and deterministic backup/export.**
  - Depends on: KG-3.2–KG-3.8
  - Acceptance: integrity command detects broken invariants; export is stable, excludes derived indexes, and round-trips into an empty store.

- [ ] **KG-3.10 — Add migration, crash, concurrency, and round-trip tests.**
  - Depends on: KG-3.2–KG-3.9
  - Acceptance: interrupted transactions do not partially commit; two-process fixtures respect the chosen locking policy; upgrade fixtures preserve data.

- [ ] **Phase 3 gate — Graph core is durable and recoverable.**
  - Depends on: KG-3.1–KG-3.10
  - Acceptance: canonical data survives restart, migration, export/import, concurrent access, and simulated write failure.

## Phase 4 — Candidate ingestion, identity, conflict, and review

After the Phase 3 gate, Phases 4 and 5 may proceed in parallel; Phase 6 depends on retrieval, while Phase 7 joins ingestion/review with the Pi read-only integration.

- [ ] **KG-4.1 — Define the candidate extraction schema.**
  - Depends on: Phase 3 gate
  - Acceptance: strict schema includes source spans, entity candidates, aliases, claims, polarity, temporal expressions, confidence, and explicit-versus-inferred status.

- [ ] **KG-4.2 — Implement deterministic candidate normalization.**
  - Depends on: KG-4.1
  - Acceptance: enforce length/count limits, normalize aliases/predicates/literals, reject missing evidence, and produce stable diagnostics.

- [ ] **KG-4.3 — Implement entity-resolution candidate generation.**
  - Depends on: KG-4.2
  - Acceptance: exact/alias/normalized matching returns bounded merge candidates with explainable scores; ambiguous entities are not silently merged.
  - Ordering note: this task may initially use direct indexed SQL and later adopt KG-5.1’s retrieval API.

- [ ] **KG-4.4 — Implement merge, split, and redirect operations.**
  - Depends on: KG-4.3
  - Acceptance: operations preserve provenance/audit history and do not leave dangling claims or aliases.

- [ ] **KG-4.5 — Implement temporal conflict detection.**
  - Depends on: KG-3.8, KG-4.2
  - Parallel with: KG-4.3
  - Acceptance: identify overlapping exclusive claims, possible corrections, negations, and scope/time-compatible coexistence without silently overwriting.

- [ ] **KG-4.6 — Implement secret and sensitivity scanning.**
  - Depends on: KG-4.2
  - Parallel with: KG-4.3, KG-4.5
  - Acceptance: common credentials/private keys/tokens are blocked before persistence; findings do not echo full secret values.

- [ ] **KG-4.7 — Implement the proposal queue.**
  - Depends on: KG-4.2–KG-4.6
  - Acceptance: candidates can be inspected, corrected, accepted, rejected, merged, or superseded; decisions are transactional and audited.

- [ ] **KG-4.8 — Implement optional LLM extractor behind an interface.**
  - Depends on: KG-4.1, KG-4.7
  - Acceptance: structured output is runtime-validated; model/provider/version and usage are recorded; cancellation and malformed output fall back safely.
  - Acceptance: no extractor output bypasses proposal validation.

- [ ] **KG-4.9 — Add adversarial ingestion fixtures.**
  - Depends on: KG-4.2–KG-4.8
  - Acceptance: cover prompt injection, duplicate episodes, entity collisions, relation fragmentation, false dates, contradictory claims, oversized inputs, secrets, and malformed structured output.

- [ ] **Phase 4 gate — Untrusted input cannot silently become truth.**
  - Depends on: KG-4.1–KG-4.9
  - Acceptance: all inferred/imported knowledge is traceable to evidence and review; ambiguity/conflict produces a proposal or abstention, not a destructive update.

## Phase 5 — Retrieval and context assembly

- [ ] **KG-5.1 — Implement FTS5 indexes and lexical retrieval baseline.**
  - Depends on: Phase 3 gate
  - Acceptance: search canonical labels, aliases, accepted claim text, and source spans; return explainable scores and evidence IDs.
  - Acceptance: scope/status/time filters are applied before results leave storage.

- [ ] **KG-5.2 — Implement entity lookup and alias resolution for queries.**
  - Depends on: KG-5.1
  - Acceptance: exact and ambiguous matches are represented explicitly; no cross-scope alias lookup.

- [ ] **KG-5.3 — Implement bounded graph traversal.**
  - Depends on: KG-5.2, KG-3.8
  - Acceptance: support one-hop neighborhood and shortest path with depth/node/deadline/predicate/status/time bounds and cycle safety.

- [ ] **KG-5.4 — Implement hybrid fusion/reranking without embeddings.**
  - Depends on: KG-5.1–KG-5.3
  - Acceptance: blend lexical, entity, path distance, evidence trust, status, recency, and temporal match; diagnostics expose component scores.

- [ ] **KG-5.5 — Implement citation-bearing context packs.**
  - Depends on: KG-5.4
  - Acceptance: compact output distinguishes current/historical/disputed/proposed claims and includes claim/source IDs, exact evidence snippets, scope, and query time.
  - Acceptance: configurable budget, deterministic truncation, omitted counts, and explicit abstention are tested.

- [ ] **KG-5.6 — Add retrieval diagnostics.**
  - Depends on: KG-5.4, KG-5.5
  - Acceptance: diagnostics show query interpretation, filters, seeds, traversed paths, component scores, and dropped candidates without exposing secret content.

- [ ] **KG-5.7 — Add optional embeddings interface and lexical fallback.** **Optional for MVP.**
  - Depends on: KG-5.1, KG-5.4
  - Acceptance: embedding model/version/hash are recorded; calls are cancellable and timed out; missing provider never breaks lexical/graph retrieval; indexes can be rebuilt/deleted.

- [ ] **KG-5.8 — Add deterministic retrieval evaluation fixtures.**
  - Depends on: KG-5.1–KG-5.6
  - Acceptance: fixtures cover exact lookup, aliases, multi-hop, temporal updates, contradictions, scope isolation, irrelevant high-degree nodes, and abstention.
  - Acceptance: report Recall@k, MRR/nDCG, path accuracy, context size, and latency for FTS-only versus graph-enhanced retrieval.

- [ ] **Phase 5 gate — Retrieval beats or complements the flat baseline.**
  - Depends on: KG-5.1–KG-5.6, KG-5.8
  - Acceptance: graph retrieval has a demonstrated benefit on at least one target category without unacceptable regression in exact lookup, scope safety, latency, or context size.

## Phase 6 — Pi read-only alpha

Deliver useful recall before enabling durable mutation from Pi.

- [ ] **KG-6.1 — Register `knowledge_search`.**
  - Depends on: Phase 5 gate, Phase 2 gate
  - Acceptance: strict TypeBox schema; cancellation; bounded output; citation IDs; useful error/empty state; Google-compatible enums where used.

- [ ] **KG-6.2 — Register `knowledge_get`.**
  - Depends on: KG-6.1
  - Acceptance: expand entity, claim, path, or source IDs within scope and configured bounds; arbitrary SQL/Cypher is not exposed.

- [ ] **KG-6.3 — Add compact tool rendering.**
  - Depends on: KG-6.1, KG-6.2
  - Parallel with: KG-6.4
  - Acceptance: collapsed output is concise; expanded output shows evidence/path/diagnostics; rendering handles partial/error results and narrow terminals.

- [ ] **KG-6.4 — Add `/knowledge-status` and `/knowledge-health`.**
  - Depends on: KG-6.1
  - Parallel with: KG-6.3
  - Acceptance: commands work in TUI/RPC as appropriate and degrade safely in print/JSON modes.

- [ ] **KG-6.5 — Implement session lifecycle integration.**
  - Depends on: KG-3.3, KG-6.1
  - Acceptance: resolve scope at `session_start`; open lazily; honor project trust; close idempotently at `session_shutdown`; do not start background resources in the factory.

- [ ] **KG-6.6 — Implement optional per-operation automatic recall.**
  - Depends on: KG-5.5, KG-6.5
  - Acceptance: disabled or conservative by default per ADR; snapshot is built once per outer operation and injected ephemerally through Pi’s `context` hook.
  - Acceptance: snapshot bytes remain stable during the operation; no repeated persistent custom messages or unbounded prompt growth.

- [ ] **KG-6.7 — Add Pi-mode and prompt-cache tests.**
  - Depends on: KG-6.1–KG-6.6
  - Acceptance: test TUI smoke behavior plus print, JSON, and RPC claims made by the extension; measure tool-description and automatic-context overhead.

- [ ] **KG-6.8 — Run read-only dogfood on representative Pi sessions.**
  - Depends on: KG-6.1–KG-6.7
  - Acceptance: record useful/irrelevant retrievals, tool routing failures, latency, and context cost without enabling write tools.

- [ ] **Phase 6 gate — Read-only Pi alpha is safe and useful.**
  - Depends on: KG-6.1–KG-6.8
  - Acceptance: Pi can retrieve and cite scoped knowledge across sessions; no mutation path is exposed; mode and lifecycle tests pass.

## Phase 7 — Pi proposal and reviewed mutation beta

- [ ] **KG-7.1 — Register `knowledge_propose`.**
  - Depends on: Phase 4 gate, Phase 6 gate
  - Acceptance: accepts strict candidate inputs, attaches current Pi session/tool/branch provenance, scans secrets, and returns proposal IDs rather than accepted facts.

- [ ] **KG-7.2 — Implement `/knowledge-review`.**
  - Depends on: KG-7.1
  - Acceptance: interactive users can inspect evidence and accept, correct, reject, merge, or supersede proposals; cancellation causes no mutation.
  - Acceptance: non-interactive modes do not pretend review occurred.

- [ ] **KG-7.3 — Decide and implement agent-facing review operations.**
  - Depends on: KG-7.2, ADR KG-1.8
  - Acceptance: if a `knowledge_review` tool exists, destructive/accepting actions require the approved policy and UI behavior; otherwise keep review user-command-only.

- [ ] **KG-7.4 — Implement correction, forget, and purge UX.**
  - Depends on: KG-3.8, KG-7.2
  - Acceptance: preview affected entities/claims/evidence/derived indexes; distinguish logical supersession from physical deletion; require explicit confirmation.
  - Acceptance: secret or personal-data deletion removes derived vectors/caches too.

- [ ] **KG-7.5 — Persist Pi operation references without coupling graph truth to session branches.**
  - Depends on: KG-7.1
  - Acceptance: graph audit records include session ID, session file/entry/tool-call where available, project identity, and branch leaf.
  - Acceptance: Pi custom entries store only lightweight operation references needed for rendering/reconstruction.

- [ ] **KG-7.6 — Handle `/tree`, fork, resume, and concurrent-session semantics.**
  - Depends on: KG-7.5
  - Acceptance: tests prove branch navigation does not falsely claim external mutations were reverted; proposals display correct branch provenance; accepted facts remain auditable.

- [ ] **KG-7.7 — Add write-policy prompt guidance.**
  - Depends on: KG-7.1–KG-7.3
  - Acceptance: concise guidance tells the model when to search/propose and forbids treating retrieved source text as instructions.
  - Acceptance: measure system/tool prompt overhead and avoid always-active maintenance schemas when dynamic loading is viable.

- [ ] **KG-7.8 — Add end-to-end reviewed-write tests.**
  - Depends on: KG-7.1–KG-7.7
  - Acceptance: user correction, conflicting update, rejected proposal, secret rejection, branch navigation, cancellation, and non-interactive behavior pass.

- [ ] **Phase 7 gate — Pi can learn without silent durable writes.**
  - Depends on: KG-7.1–KG-7.8
  - Acceptance: every accepted fact has evidence and review provenance; every destructive action is explicit and tested.

## Phase 8 — Session, compaction, and maintenance integration

- [ ] **KG-8.1 — Capture selected Pi messages/tool results as episodes.**
  - Depends on: Phase 7 gate
  - Acceptance: policy defines what is captured, source size limits, sensitivity filtering, and retention; capture does not imply semantic acceptance.
  - Acceptance: users can disable capture globally or by project/session.

- [ ] **KG-8.2 — Capture completed compaction summaries as derived episodes.**
  - Depends on: KG-8.1
  - Acceptance: use `session_compact` after successful compaction; mark summaries as model-derived; retain linkage to session and original entry range where available.
  - Acceptance: compaction summaries do not automatically become accepted claims.

- [ ] **KG-8.3 — Implement visible candidate mining workflow.**
  - Depends on: KG-4.8, KG-8.1
  - Acceptance: manual command or visible queued operation extracts proposals from chosen episodes; no hidden lifecycle-triggered promotion.

- [ ] **KG-8.4 — Add graph health and maintenance reports.**
  - Depends on: KG-3.9, KG-4.7, KG-5.6
  - Acceptance: report orphan evidence, duplicate entities, fragmented predicates, temporal overlap, stale proposals, outdated indexes, secret-like content, and scope anomalies.

- [ ] **KG-8.5 — Add safe repair/reindex operations.**
  - Depends on: KG-8.4
  - Acceptance: preview by default; destructive repair requires confirmation; derived indexes rebuild from canonical data; operations are cancellable and resumable.

- [ ] **KG-8.6 — Define and implement retention policy.**
  - Depends on: KG-8.1, KG-8.4
  - Acceptance: separate retention for raw episodes, rejected/stale proposals, accepted claims, audit records, and exports; accepted project/user claims are not silently aged out.

- [ ] **KG-8.7 — Test compaction and maintenance failure paths.**
  - Depends on: KG-8.1–KG-8.6
  - Acceptance: failed compaction/extraction/reindex does not corrupt canonical data or block Pi’s default compaction behavior.

- [ ] **Phase 8 gate — Long-running memory remains inspectable.**
  - Depends on: KG-8.1–KG-8.7
  - Acceptance: session-derived data is distinguishable from accepted knowledge and graph/index maintenance is safe and recoverable.

## Phase 9 — Security and privacy hardening

- [ ] **KG-9.1 — Turn the Phase 1 threat model into executable tests.**
  - Depends on: Phases 7–8 gates
  - Acceptance: each relevant threat has prevention/detection tests or a documented residual risk.

- [ ] **KG-9.2 — Test prompt-injection containment.**
  - Depends on: KG-5.5, KG-8.1
  - Acceptance: malicious instructions in files, webpages, source excerpts, claims, aliases, and recalled model text remain quoted/untrusted and do not alter extension policy.

- [ ] **KG-9.3 — Test scope and exact-ID authorization.**
  - Depends on: KG-3.4, KG-6.2
  - Acceptance: search, get, neighbor/path, review, export, delete, diagnostics, and cache lookups cannot cross scopes by guessed IDs or missing parameters.

- [ ] **KG-9.4 — Test storage and filesystem attacks.**
  - Depends on: KG-3.9, KG-7.4
  - Acceptance: parameterized SQL, malformed database handling, path traversal, symlinks, unsafe permissions, export overwrite, and import bombs are covered.

- [ ] **KG-9.5 — Test resource-exhaustion limits.**
  - Depends on: KG-5.3, KG-8.5
  - Acceptance: huge sources, high-degree nodes, cycles, oversized tool inputs, expensive searches, concurrent extraction, and cancellation respect hard bounds.

- [ ] **KG-9.6 — Review extension/dependency supply-chain risk.**
  - Depends on: final dependency set
  - Acceptance: record dependency purpose, license, install scripts, native binaries, network behavior, and update policy; remove unjustified dependencies.

- [ ] **KG-9.7 — Verify privacy operations.**
  - Depends on: KG-7.4, KG-8.6
  - Acceptance: inspect/export/correct/forget/purge are documented and tested; purging content removes derived indexes and does not leak content into telemetry/logs.

- [ ] **Phase 9 gate — Security review passes.**
  - Depends on: KG-9.1–KG-9.7
  - Acceptance: no open critical/high issue; residual risks and safe defaults are documented.

## Phase 10 — Evaluation and optimization

- [ ] **KG-10.1 — Build a Pi-specific gold evaluation set.**
  - Depends on: Phase 6 gate
  - Acceptance: include preferences, architecture decisions, prior failures, ownership/dependencies, temporal updates, corrections, cross-session synthesis, irrelevant memories, and unanswerable questions.
  - Acceptance: evidence claim/source IDs are labeled independently of generated answers.

- [ ] **KG-10.2 — Implement repeatable retrieval evaluation.**
  - Depends on: KG-5.8, KG-10.1
  - Acceptance: report Recall@k, MRR/nDCG, path accuracy, temporal accuracy, irrelevant-context rate, context size, and latency.

- [ ] **KG-10.3 — Implement answer/citation evaluation.**
  - Depends on: KG-10.1, Pi read integration
  - Acceptance: measure factual correctness, citation support, unsupported claims, update correctness, temporal reasoning, and abstention; LLM judge is not the only metric.

- [ ] **KG-10.4 — Run required baselines and ablations.**
  - Depends on: KG-10.2, KG-10.3
  - Acceptance: compare no memory, Pi/session-only, flat FTS, FTS+graph, and optional vectors; isolate temporal/provenance filters.

- [ ] **KG-10.5 — Run LongMemEval/LoCoMo-compatible experiments or a documented subset.**
  - Depends on: KG-10.2, KG-10.3
  - Acceptance: scripts/config/results are reproducible; limitations translating conversational benchmarks to coding-agent memory are stated.

- [ ] **KG-10.6 — Measure Pi operational overhead.**
  - Depends on: Phase 8 gate
  - Acceptance: startup, p50/p95 search/write, index/update time, DB growth, active tool-schema tokens, automatic context tokens, model usage, and prompt-cache effects are reported.

- [ ] **KG-10.7 — Set release thresholds.**
  - Depends on: KG-10.2–KG-10.6
  - Acceptance: define minimum retrieval/citation gains and maximum latency/context/startup regressions before viewing final results.

- [ ] **KG-10.8 — Optimize only measured bottlenecks.**
  - Depends on: KG-10.7
  - Acceptance: each optimization links to before/after evidence; do not add a graph DB, embeddings, PageRank, community summaries, daemon, or cache solely on intuition.

- [ ] **Phase 10 gate — Benefits are measured, not assumed.**
  - Depends on: KG-10.1–KG-10.8
  - Acceptance: release thresholds pass or failures have explicit remediation; FTS-only remains available when graph retrieval is not beneficial.

## Phase 11 — Reliability and release-candidate validation

- [ ] **KG-11.1 — Test clean install, reload, restart, resume, fork, and uninstall.**
  - Depends on: Phases 9–10 gates
  - Acceptance: follow Pi package conventions; `/reload` behavior is documented; uninstall does not silently delete user knowledge.

- [ ] **KG-11.2 — Test supported operating systems/runtimes.**
  - Depends on: KG-11.1
  - Acceptance: define and test the actual support matrix, including SQLite/FTS availability and path/permission differences; unsupported environments fail clearly.

- [ ] **KG-11.3 — Test schema upgrade and downgrade/recovery documentation.**
  - Depends on: KG-3.10
  - Acceptance: upgrade from every released fixture; failed migration leaves a usable backup/recovery path; downgrade limitations are explicit.

- [ ] **KG-11.4 — Run long-duration/concurrent dogfood.**
  - Depends on: KG-11.1, KG-11.2
  - Acceptance: multiple Pi sessions, compactions, project switches, graph growth, cancellation, and maintenance run without corruption or scope leakage.

- [ ] **KG-11.5 — Complete code and data-model review.**
  - Depends on: KG-11.1–KG-11.4
  - Acceptance: strict typing, bounded outputs, lifecycle cleanup, transactions, errors, migration invariants, and privacy controls reviewed against repository/Pi guidance.

- [ ] **Phase 11 gate — Release candidate is reliable.**
  - Depends on: KG-11.1–KG-11.5
  - Acceptance: full applicable validation passes with no suppressed checks; known limitations are documented.

## Phase 12 — Documentation and release

- [ ] **KG-12.1 — Write user setup and configuration documentation.**
  - Depends on: Phase 11 gate
  - Acceptance: install, paths, scopes, trust, optional providers, modes, reload/restart, and uninstall/data-retention behavior are covered without secrets.

- [ ] **KG-12.2 — Write agent/user workflow examples.**
  - Depends on: KG-12.1
  - Acceptance: search, remember/propose, review, correct, supersede, temporal query, inspect evidence, forget, export, and recover examples are included.

- [ ] **KG-12.3 — Write operator and troubleshooting documentation.**
  - Depends on: KG-8.4–KG-8.6, KG-11.3
  - Acceptance: health checks, backup/restore, migrations, reindex, lock contention, missing embeddings, corrupt stores, and privacy deletion are covered.

- [ ] **KG-12.4 — Document architecture and extension APIs.**
  - Depends on: final implementation
  - Acceptance: modules, schema, retrieval/write flows, Pi hooks, branch semantics, context budgets, and extension events are documented for maintainers.

- [ ] **KG-12.5 — Update package manifest and root README.**
  - Depends on: KG-12.1–KG-12.4
  - Acceptance: extension is listed with concise purpose and links; preserve unrelated existing documentation edits.

- [ ] **KG-12.6 — Prepare release notes and migration notes.**
  - Depends on: KG-12.5
  - Acceptance: security/privacy defaults, benchmark results, known limitations, data compatibility, and rollback/recovery are explicit.

- [ ] **KG-12.7 — Perform final validation from a clean checkout.**
  - Depends on: KG-12.1–KG-12.6
  - Acceptance: install, type-check, tests, build if any, isolated Pi startup, representative read/write/review flow, export, and uninstall all pass.

- [ ] **Phase 12 gate — Release is documented and reproducible.**
  - Depends on: KG-12.1–KG-12.7
  - Acceptance: a new reader can install, understand, validate, operate, and safely remove the plugin.

## Post-MVP increment — autonomous agent maintenance

This increment intentionally replaces the reviewed-write MVP's agent mutation surface. The user-selected policy is fully autonomous: `knowledge_maintain` is the only agent-facing mutation tool, and no approval fallback is exposed. The internal proposal service remains for normalization and auditability.

- [x] **KG-A.1 — Register autonomous `knowledge_maintain` operations.**
  - Depends on: KGM-G6
  - Acceptance: the agent can deliberately insert, append-update, or delete one scoped item through strict bounded inputs; insert/update use evidence-backed proposal normalization and deletion uses the existing bounded forget service.
  - Evidence: [`extensions/knowledge-graph/agent-maintenance.ts`](../extensions/knowledge-graph/agent-maintenance.ts), [`extensions/knowledge-graph/index.ts`](../extensions/knowledge-graph/index.ts), [`docs/knowledge-graph-adr-008-autonomous-agent-maintenance.md`](knowledge-graph-adr-008-autonomous-agent-maintenance.md).

- [x] **KG-A.2 — Preserve autonomous mutation safety and provenance.**
  - Depends on: KG-A.1
  - Acceptance: global scope remains explicit; insert/update require bounded evidence and pre-persistence secret scanning; update preserves superseded history; delete is single-target, non-purge, bounded, reasoned, transactional, and audited with agent/session/tool/branch provenance.
  - Evidence: [`extensions/knowledge-graph/deletion.ts`](../extensions/knowledge-graph/deletion.ts), [`extensions/knowledge-graph/proposal.ts`](../extensions/knowledge-graph/proposal.ts), [`tests/unit/knowledge-graph-agent-maintenance.test.mjs`](../tests/unit/knowledge-graph-agent-maintenance.test.mjs); `npm run typecheck`, `npm run test:unit`, and `npm run test:benchmark` pass with the ADR-008 active-tool budget.

- [x] **KG-A.3 — Document the autonomous policy and recovery trade-offs.**
  - Depends on: KG-A.1, KG-A.2
  - Acceptance: users can distinguish autonomous maintenance from read-only tools and explicit user commands, understand that deletion is not undone by session branching, and recover through export/backup workflows.
  - Evidence: [`docs/knowledge-graph-adr-008-autonomous-agent-maintenance.md`](knowledge-graph-adr-008-autonomous-agent-maintenance.md), [`docs/knowledge-graph-mvp-operations.md`](knowledge-graph-mvp-operations.md), [`README.md`](../README.md).

## Deferred backlog

Do not start these until Phase 10 measurements justify them and a new ADR narrows the design.

- [ ] **KG-D.1 — Community detection and corpus-level summaries.**
  - Depends on: Phase 10 gate plus demonstrated global/thematic query need.

- [ ] **KG-D.2 — Personalized PageRank or learned graph reranking.**
  - Depends on: Phase 10 gate plus multi-hop retrieval shortfall.

- [ ] **KG-D.3 — Required/local vector embedding bundle.**
  - Depends on: KG-5.7 evaluation proving benefit worth install/runtime cost.

- [ ] **KG-D.4 — Dedicated graph database or daemon.**
  - Depends on: measured SQLite traversal/concurrency limitation.

- [ ] **KG-D.5 — Deterministic code AST/call graph ingestion.**
  - Depends on: separate scope ADR and comparison with GitNexus/pi-code-graph prior art.

- [ ] **KG-D.6 — Shared multi-user/cloud synchronization and ACLs.**
  - Depends on: separate identity, authorization, encryption, conflict-resolution, and operations design.

- [ ] **KG-D.7 — Autonomous ontology evolution.**
  - Depends on: governed predicate lifecycle and evidence that manual ontology review is a bottleneck.

- [ ] **KG-D.8 — Graph visualization.**
  - Depends on: validated user need; must not delay retrieval, provenance, review, or deletion correctness.

## Definition of done for the whole project

The plugin is done for its initial release only when:

- all required Phase 0–12 gates are checked with evidence;
- accepted claims are evidence-backed, temporal, scoped, auditable, correctable, and deletable;
- inferred/untrusted content cannot silently become accepted knowledge;
- scope isolation and prompt-injection containment have executable tests;
- Pi branch/session/compaction semantics are truthful and tested;
- graph-enhanced retrieval is compared with flat FTS and meets predeclared thresholds;
- all claimed Pi modes and supported platforms are validated;
- installation, migration, backup, export, purge, and uninstall are documented;
- no production/user database or remote infrastructure was modified during testing without explicit approval.

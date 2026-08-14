# Pi knowledge graph MVP plan

**Status:** complete — KGM-G6 passed; current agent mutation policy superseded by ADR-008

**Last reviewed:** 2026-08-11

> This document records the completed reviewed-write MVP. The current product policy is autonomous maintenance: `knowledge_maintain` is the only agent-facing mutation tool, and no proposal/review approval fallback is exposed. See [`knowledge-graph-adr-008-autonomous-agent-maintenance.md`](knowledge-graph-adr-008-autonomous-agent-maintenance.md).

**Research basis:** [knowledge-graph-research.md](knowledge-graph-research.md)

> Runtime knowledge visibility is now the single shared scope defined by [`knowledge-graph-adr-009-shared-knowledge-scope.md`](knowledge-graph-adr-009-shared-knowledge-scope.md); project-isolation requirements below describe the superseded design.

**Post-MVP roadmap:** [knowledge-graph-implementation-plan.md](knowledge-graph-implementation-plan.md)

## Goal

Prove that Pi can safely build and use a small, persistent knowledge graph across sessions with useful retrieval, evidence-backed claims, cross-project shared memory, and reviewed writes.

The MVP must support this end-to-end scenario:

1. In one Pi session, the user asks Pi to remember a project fact or relationship.
2. Pi submits a structured proposal with evidence.
3. The user confirms or reviews it before it becomes accepted knowledge.
4. In a later session, Pi retrieves the accepted claim and its evidence.
5. The user can correct or supersede the claim without erasing its history.
6. The claim remains available when the session moves to another working directory.
7. The user can inspect, export, forget, or purge the stored data.

## MVP boundaries

### Included

- Local-only, single-user operation.
- One global SQLite database with one shared knowledge scope.
- Entities, aliases, evidence, directed claims, minimal temporal fields, status, supersession, and audit events.
- FTS5 lexical retrieval and bounded one-hop graph expansion.
- Pi tools for search, expansion, and proposal submission.
- User review through Pi UI/commands.
- Explicit agent-driven retrieval; no automatic per-turn context injection.
- Runtime validation, cancellation, bounded output, secret scanning, shared visibility, export, correction, and deletion.
- TUI behavior plus safe degradation in print, JSON, and RPC modes.

### Explicitly deferred

- Automatic session or compaction mining.
- Nested LLM extraction calls inside the extension.
- Automatic per-operation recall/context injection.
- Required vector embeddings.
- Community detection, PageRank, graph summaries, and learned reranking.
- Dedicated graph databases or daemons.
- Code AST/call-graph ingestion.
- Cloud sync, multi-user ACLs, and graph visualization.
- Autonomous ontology evolution.

The Pi agent itself may transform a user statement into validated `knowledge_propose` arguments. The extension will not invoke a second model to extract knowledge during the MVP.

## Proposed MVP interface

Exact schemas are finalized in `KGM-1.4`, but the intended surface is:

| Surface | Purpose |
|---|---|
| `knowledge_search` | Search all accepted claims/entities in the shared knowledge base |
| `knowledge_get` | Expand claim, entity, evidence, history, or one-hop neighbors by stable ID |
| `knowledge_propose` | Submit an evidence-backed candidate; accept only after the configured review/confirmation flow |
| `/knowledge-review` | Inspect and accept, correct, reject, or supersede pending proposals |
| `/knowledge-status` | Show scope, database health, counts, and pending-review count |
| `/knowledge-export` | Export canonical data without derived indexes |
| `/knowledge-forget` | Preview and perform correction/deletion/purge operations with confirmation |

No MVP operation exposes arbitrary SQL, Cypher, unbounded traversal, or bulk automatic acceptance.

## Minimal canonical model

The storage ADR may adjust names, but the MVP needs these concepts:

| Record | Minimum semantics |
|---|---|
| Scope | One shared `global` scope; legacy project keys are migrated into it |
| Evidence | immutable source kind, locator, excerpt, hash, capture time, trust classification, Pi provenance |
| Entity | stable ID, scope, type, canonical label, lifecycle status |
| Alias | normalized alias linked to one entity within scope |
| Claim | stable ID, subject entity, normalized predicate, entity or typed-literal object, status |
| Time | `observed_at`, optional `valid_from`, optional `valid_to` |
| Supersession | accepted correction links new and prior claims without overwriting history |
| Audit event | actor, action, timestamp, scope, Pi session/tool/branch references, before/after IDs |

MVP statuses are `proposed`, `accepted`, `rejected`, and `superseded`. Disputed claims, full bi-temporal transaction history, merge/split workflows, and governed ontology evolution remain post-MVP unless implementation shows they are necessary for correctness.

## How to maintain this plan

This file is the authoritative MVP tracker until `KGM-G6` is complete.

### Completion rules

- Change `[ ]` to `[x]` only after every acceptance criterion passes.
- Add an `Evidence:` line containing changed paths and exact validation commands/results.
- Keep blocked work unchecked and append `BLOCKED: <reason>`.
- Do not check a gate until every required dependency is checked.
- Use only exact task or gate IDs in `Depends on`; do not use prose dependencies.
- If scope changes, update the task and record the rationale instead of checking obsolete work.
- Tasks marked **Deferred** or **Optional** do not block a gate; this plan currently has no optional gate dependencies.

Example:

```markdown
- [x] **KGM-N.N — Implement one-hop expansion.**
  - Depends on: KGM-N.M
  - Acceptance: traversal enforces scope and a hard result limit.
  - Evidence: `retrieval/traversal.ts`; `npm test -- traversal` passes.
```

## Milestones

| Milestone | Result | Gate |
|---|---|---|
| MVP-0 | Runtime, schema, scope, security, and thresholds decided | KGM-G1 |
| MVP-1 | Durable graph core with deterministic fixtures | KGM-G2 |
| MVP-2 | FTS plus one-hop retrieval beats/complements flat search | KGM-G3 |
| MVP-3 | Pi read-only alpha works across sessions | KGM-G4 |
| MVP-4 | Reviewed writes make the graph accumulate safely | KGM-G5 |
| MVP-5 | Export, deletion, security, performance, and docs pass | KGM-G6 |

---

## Phase 0 — Research and MVP cut

- [x] **KGM-0.1 — Complete architecture and prior-art research.**
  - Depends on: none
  - Acceptance: research covers knowledge modeling, identity, evidence, time, retrieval, Pi integration, evaluation, and security.
  - Evidence: [`knowledge-graph-research.md`](knowledge-graph-research.md), reviewed 2026-08-06.

- [x] **KGM-0.2 — Review the long-term plan and identify MVP risks.**
  - Depends on: KGM-0.1
  - Acceptance: review identifies scope, dependency, optional-task, runtime, security-ordering, and evaluation-ordering problems.
  - Evidence: review completed 2026-08-06; findings incorporated into this plan.

- [x] **KGM-0.3 — Define the MVP cut and ordered tracker.**
  - Depends on: KGM-0.2
  - Acceptance: included/deferred work is explicit; tasks have exact dependencies, measurable acceptance criteria, and gates.
  - Evidence: this document.

## Phase 1 — Decisions, runtime spike, and success criteria

Complete this phase before designing the full storage implementation.

- [x] **KGM-1.1 — Spike SQLite and FTS5 in the actual Pi runtime.**
  - Depends on: KGM-0.3
  - Acceptance: verify `node:sqlite` availability and stability under Node `v24.14.1`, FTS5 support, transactions, foreign keys, WAL mode, busy timeout, backup behavior, and two-process access.
  - Acceptance: compare against a native dependency only if built-in SQLite fails a required behavior.
  - Acceptance: record the selected driver, limitations, and supported Node/Pi versions in an ADR.
  - Evidence: [`knowledge-graph-mvp-adr-001-sqlite-runtime.md`](knowledge-graph-mvp-adr-001-sqlite-runtime.md); [`scripts/knowledge-graph-sqlite-spike.mjs`](../scripts/knowledge-graph-sqlite-spike.mjs); `node scripts/knowledge-graph-sqlite-spike.mjs` passes on Pi `0.84.0`, Node `v24.14.1`, SQLite `3.51.2`.

- [x] **KGM-1.2 — Decide canonical storage, paths, and permissions.**
  - Depends on: KGM-1.1
  - Acceptance: choose SQLite as canonical or reject it with evidence; define migration, backup, recovery, and derived-index rebuilding.
  - Acceptance: define default database/export/config paths and directory/file permissions.
  - Recommended default: `~/.pi/agent/knowledge-graph/` with private directory/database permissions; do not put global knowledge in arbitrary repositories.
  - Evidence: [`knowledge-graph-mvp-adr-002-storage-paths.md`](knowledge-graph-mvp-adr-002-storage-paths.md); canonical path, permissions, migration, backup/recovery, and derived-index policy accepted for the MVP.

- [x] **KGM-1.3 — Decide scope and project identity.**
  - Depends on: KGM-0.3
  - Acceptance: define global versus project visibility, canonical project key, behavior from subdirectories/symlinks/worktrees/non-git directories, and limitations when repositories move.
  - Acceptance: define whether global inclusion must be requested explicitly and how project-local configuration honors Pi project trust.
  - Evidence: [`knowledge-graph-mvp-adr-003-scope-project-identity.md`](knowledge-graph-mvp-adr-003-scope-project-identity.md); [`scripts/knowledge-graph-project-identity-spike.mjs`](../scripts/knowledge-graph-project-identity-spike.mjs); `node scripts/knowledge-graph-project-identity-spike.mjs` passes; Pi trust API verified in v0.84.0 declarations.

- [x] **KGM-1.4 — Decide the minimal schema, tool API, and write policy.**
  - Depends on: KGM-1.2, KGM-1.3
  - Acceptance: write an ADR defining stable IDs, evidence, entities, aliases, claims, object types, statuses, time fields, supersession, and audit events.
  - Acceptance: define strict schemas and bounded outputs for `knowledge_search`, `knowledge_get`, and `knowledge_propose`.
  - Acceptance: direct and inferred agent proposals use the same reviewable path; no model assertion is accepted merely because confidence is high.
  - Acceptance: define TUI/RPC confirmation and non-interactive pending-proposal behavior.
  - Evidence: [`knowledge-graph-mvp-adr-004-schema-api-write-policy.md`](knowledge-graph-mvp-adr-004-schema-api-write-policy.md); contract defines opaque IDs, canonical record semantics, strict bounded tool fields/outputs, transactional proposal/review behavior, and mode-specific confirmation policy.

- [x] **KGM-1.5 — Create a deterministic MVP evaluation corpus.**
  - Depends on: KGM-1.4
  - Acceptance: include at least 30 evidence-backed claims across two projects plus global scope.
  - Acceptance: fixtures include exact terms, aliases, directed relationships, one-hop questions, a correction/supersession, an historical claim, irrelevant matches, an unanswerable query, a secret-like value, and cross-project leakage attempts.
  - Acceptance: expected entity/claim/evidence IDs and relevant result sets are labeled independently of generated answers.
  - Evidence: [`tests/fixtures/knowledge-graph-mvp-corpus.json`](../tests/fixtures/knowledge-graph-mvp-corpus.json); [`scripts/validate-knowledge-graph-mvp-corpus.mjs`](../scripts/validate-knowledge-graph-mvp-corpus.mjs); `node scripts/validate-knowledge-graph-mvp-corpus.mjs` passes with 35 claims, 35 evidence records, 22 labeled queries, two project scopes, and three security cases.

- [x] **KGM-1.6 — Set MVP thresholds before implementing retrieval.**
  - Depends on: KGM-1.5
  - Acceptance: record thresholds before viewing final retrieval results.
  - Required thresholds: zero cross-project leakage; all secret fixtures rejected before persistence; exact/alias evidence Recall@5 at least 90%; relationship evidence Recall@5 at least 80%; default tool result no larger than 12 KB; no unbounded traversal.
  - Acceptance: set provisional local latency/startup/tool-schema budgets based on the runtime spike and document the measurement hardware.
  - Evidence: [`knowledge-graph-mvp-adr-005-evaluation-thresholds.md`](knowledge-graph-mvp-adr-005-evaluation-thresholds.md); thresholds and measurement protocol recorded before retrieval implementation; baseline environment recorded as Pi `0.84.0`, Node `v24.14.1`, SQLite `3.51.2`, Linux `7.1.5-200.fc44.x86_64`, AMD Ryzen 5 3600X, 12 logical CPUs, 31 GiB RAM.

- [x] **KGM-1.7 — Write the MVP threat model and data-flow review.**
  - Depends on: KGM-1.2–KGM-1.4
  - Acceptance: cover prompt injection, source poisoning, secret persistence, cross-project access, guessed IDs, SQL injection, unsafe paths/permissions, oversized inputs, high-degree nodes, concurrency, cancellation, telemetry/log leakage, and excessive agency.
  - Acceptance: map every threat to a preventive implementation task and test in this plan.
  - Evidence: [`knowledge-graph-mvp-adr-006-threat-model-data-flow.md`](knowledge-graph-mvp-adr-006-threat-model-data-flow.md); read/proposal/maintenance/configuration data flows, security invariants, residual risks, and task/test mapping recorded.

- [x] **KGM-G1 — Gate: MVP architecture is implementation-ready.**
  - Depends on: KGM-1.1–KGM-1.7
  - Acceptance: runtime, storage, schema, scope, API, write policy, fixtures, thresholds, and threat controls are decided without an unresolved choice that changes the initial schema.
  - Evidence: ADRs 001–006, SQLite and project-identity spikes, deterministic corpus validator, and all Phase 1 task acceptance criteria pass; duplicate accepted-claim handling is explicitly fixed as `already_known` with evidence attachment deferred beyond the MVP.

## Phase 2 — Durable graph core

- [x] **KGM-2.1 — Establish reproducible TypeScript and test tooling.**
  - Depends on: KGM-G1
  - Acceptance: choose and document the package manager because the repository currently has no lockfile; do not introduce a second package manager.
  - Acceptance: add strict type-check, unit-test, integration-test, and isolated Pi smoke-test commands with a reproducible lockfile if dependencies are added.
  - Evidence: npm `11.11.0` selected in `package.json` via `packageManager`; `package-lock.json` generated; `tsconfig.json` enables strict no-emit checking; `npm run test:all` passes after clean `npm ci --ignore-scripts --legacy-peer-deps`; `npm ls --depth=0 --omit=optional` has no unmet dependencies; `scripts/pi-knowledge-graph-smoke.mjs` proves explicit extension loading in offline JSON mode.

- [x] **KGM-2.2 — Add the extension skeleton and package registration.**
  - Depends on: KGM-2.1
  - Acceptance: create `packages/knowledge-graph/` with a thin `index.ts`; register it in `packages/knowledge-graph/package.json`; preserve unrelated extension entries and existing working-tree changes.
  - Acceptance: `pi --no-extensions -e ./packages/knowledge-graph/index.ts` starts without network access or unfinished tools.
  - Evidence: [`packages/knowledge-graph/index.ts`](../packages/knowledge-graph/index.ts); package registration in [`packages/knowledge-graph/package.json`](../packages/knowledge-graph/package.json); `npm run typecheck`; offline `pi --no-extensions -e ./packages/knowledge-graph/index.ts --list-models` and `--help` both exit 0 with no stderr.

- [x] **KGM-2.3 — Implement runtime-validated configuration and private paths.**
  - Depends on: KGM-1.2, KGM-1.3, KGM-2.1
  - Acceptance: external configuration is treated as `unknown`; global/project precedence and environment overrides follow the ADR; project configuration is ignored unless trusted.
  - Acceptance: creation and permission tests cover database, backup, and export locations without touching the user’s real store.
  - Evidence: [`knowledge-graph-mvp-adr-007-config-precedence.md`](knowledge-graph-mvp-adr-007-config-precedence.md); [`packages/knowledge-graph/config.ts`](../packages/knowledge-graph/config.ts); [`tests/unit/knowledge-graph-config.test.mjs`](../tests/unit/knowledge-graph-config.test.mjs); `npm run typecheck` and `npm run test:unit` pass.

- [x] **KGM-2.4 — Implement database lifecycle and migrations.**
  - Depends on: KGM-2.3
  - Acceptance: lazy open, schema versioning, transactional ordered migrations, foreign keys, selected journaling/locking settings, integrity checks, and idempotent close are tested.
  - Acceptance: extension factory does not open long-lived resources; session shutdown closes resources idempotently.
  - Evidence: [`packages/knowledge-graph/database.ts`](../packages/knowledge-graph/database.ts); [`packages/knowledge-graph/migrations.ts`](../packages/knowledge-graph/migrations.ts); [`tests/unit/knowledge-graph-database.test.mjs`](../tests/unit/knowledge-graph-database.test.mjs); `npm run typecheck` and `npm run test:unit` pass migration/lifecycle coverage for lazy open, WAL/foreign keys/busy timeout, ordered migrations, verified pre-migration backup, rollback/recovery, integrity, and idempotent close. The extension factory remains resource-free.

- [x] **KGM-2.5 — Implement scoped canonical repositories.**
  - Depends on: KGM-2.4
  - Acceptance: repositories cover scopes, evidence, entities, aliases, claims, supersession links, and audit events.
  - Acceptance: all operations are parameterized and require an explicit resolved scope; exact-ID lookups cannot bypass scope.
  - Evidence: [`packages/knowledge-graph/repository.ts`](../packages/knowledge-graph/repository.ts); [`packages/knowledge-graph/migrations.ts`](../packages/knowledge-graph/migrations.ts); [`tests/unit/knowledge-graph-repository.test.mjs`](../tests/unit/knowledge-graph-repository.test.mjs); `npm run test:all` passes with scoped CRUD, cross-scope ID rejection, evidence links, supersession history, and audit-event coverage.

- [x] **KGM-2.6 — Implement deterministic IDs, evidence hashes, and idempotency.**
  - Depends on: KGM-2.5
  - Acceptance: injected clocks/ID generators make tests deterministic; repeated evidence/proposal submission does not duplicate canonical records.
  - Acceptance: evidence retains source kind, locator, excerpt hash, observed time, trust class, and optional Pi provenance.
  - Evidence: [`packages/knowledge-graph/repository.ts`](../packages/knowledge-graph/repository.ts); [`packages/knowledge-graph/migrations.ts`](../packages/knowledge-graph/migrations.ts); [`tests/unit/knowledge-graph-repository.test.mjs`](../tests/unit/knowledge-graph-repository.test.mjs); `npm run test:all` passes with injected ID/clock fixtures, SHA-256 evidence identity, and idempotent proposal retries.

- [x] **KGM-2.7 — Add fixture seeding and core integrity tests.**
  - Depends on: KGM-1.5, KGM-2.5, KGM-2.6
  - Acceptance: tests seed isolated temporary stores and never access the real Pi database.
  - Acceptance: restart, transaction rollback, foreign-key failure, duplicate insertion, scope isolation, and integrity-check fixtures pass.
  - Evidence: [`tests/helpers/knowledge-graph-fixture.mjs`](../tests/helpers/knowledge-graph-fixture.mjs); [`tests/unit/knowledge-graph-core.test.mjs`](../tests/unit/knowledge-graph-core.test.mjs); `npm run test:all` passes 16 unit tests plus integration, corpus, and Pi smoke validation.

- [x] **KGM-G2 — Gate: graph core is durable and testable.**
  - Depends on: KGM-2.1–KGM-2.7
  - Acceptance: an isolated store can be created, migrated, seeded, closed, reopened, and queried by repository methods without data corruption or scope leakage.
  - Evidence: [`tests/unit/knowledge-graph-core.test.mjs`](../tests/unit/knowledge-graph-core.test.mjs); `npm run test:all` passes isolated restart, rollback, foreign-key, duplicate, scope-isolation, and integrity scenarios.

## Phase 3 — Minimal graph retrieval

- [x] **KGM-3.1 — Implement FTS5 lexical retrieval baseline.**
  - Depends on: KGM-G2
  - Acceptance: index entity labels, aliases, accepted claim text, and evidence excerpts; return stable claim/entity/evidence IDs with explainable lexical scores.
  - Acceptance: scope and accepted-status filtering occur before ranking and result assembly.
  - Evidence: [`packages/knowledge-graph/migrations.ts`](../packages/knowledge-graph/migrations.ts); [`packages/knowledge-graph/retrieval.ts`](../packages/knowledge-graph/retrieval.ts); FTS corpus evaluation passes with stable IDs, scope/status filtering, and explainable scores.

- [x] **KGM-3.2 — Implement exact and alias entity resolution.**
  - Depends on: KGM-3.1
  - Acceptance: normalized exact/alias matches resolve within scope; ambiguous matches remain explicit; no fuzzy or embedding-based silent merge is performed.
  - Evidence: `KnowledgeGraphRetrieval.resolveEntity()` and [`tests/unit/knowledge-graph-retrieval.test.mjs`](../tests/unit/knowledge-graph-retrieval.test.mjs) cover exact, alias, global opt-in, and scope isolation.

- [x] **KGM-3.3 — Implement bounded one-hop expansion.**
  - Depends on: KGM-3.2
  - Acceptance: expand incoming/outgoing accepted claims with predicate, node, result-count, deadline, scope, and valid/current-state bounds.
  - Acceptance: traversal is cycle-safe and cannot return project-external or superseded claims unless history is explicitly requested.
  - Evidence: `KnowledgeGraphRetrieval.expandOneHop()` and retrieval tests cover direction, limits, deadlines, current/history filtering, and cross-scope rejection.

- [x] **KGM-3.4 — Implement compact ranking and context assembly.**
  - Depends on: KGM-3.1–KGM-3.3
  - Acceptance: combine lexical relevance, exact entity match, one-hop distance, current/history status, and evidence availability with visible component diagnostics.
  - Acceptance: default output is deterministic, citation-bearing, no larger than 12 KB, reports truncation/omissions, and returns an explicit insufficient-evidence result.
  - Acceptance: source excerpts are labeled untrusted data and never presented as agent instructions.
  - Evidence: [`packages/knowledge-graph/retrieval.ts`](../packages/knowledge-graph/retrieval.ts); bounded citation serialization, diagnostics, deterministic ordering, and untrusted evidence labels are covered by retrieval tests.

- [x] **KGM-3.5 — Implement retrieval diagnostics and benchmark runner.**
  - Depends on: KGM-1.6, KGM-3.4
  - Acceptance: report evidence Recall@5, relationship Recall@5, irrelevant-result rate, scope violations, output size, and p50/p95 latency for flat FTS versus FTS plus one-hop expansion.
  - Acceptance: diagnostics do not print secret fixture values in full.
  - Evidence: [`scripts/knowledge-graph-retrieval-evaluation.mjs`](../scripts/knowledge-graph-retrieval-evaluation.mjs); `npm run test:retrieval` reports Recall@5, zero scope violations, zero irrelevant-result leakage, output size, and flat/enhanced p50/p95 latency without content excerpts.

- [x] **KGM-3.6 — Meet or explicitly revise MVP retrieval thresholds.**
  - Depends on: KGM-3.5
  - Acceptance: predeclared thresholds pass; otherwise leave the task unchecked and record the failure/remediation.
  - Acceptance: any threshold revision explains why the original was invalid and is approved before optimization continues.
  - Evidence: `npm run test:retrieval` passes exact/alias Recall@5 = 1.0, relationship Recall@5 = 1.0, zero scope violations, zero irrelevant-result leakage, and maximum output below 12 KiB.

- [x] **KGM-G3 — Gate: minimal graph retrieval is justified.**
  - Depends on: KGM-3.1–KGM-3.6
  - Acceptance: graph expansion improves relationship retrieval or evidence assembly while preserving exact lookup, scope isolation, bounded output, and acceptable latency.
  - Evidence: `npm run test:retrieval` passes the deterministic corpus with relationship Recall@5 = 1.0, bounded graph-enhanced output, and measured flat/enhanced latency.

## Phase 4 — Pi read-only alpha

- [x] **KGM-4.1 — Implement Pi session lifecycle and scope resolution.**
  - Depends on: KGM-G3, KGM-2.2
  - Acceptance: resolve project/global visibility at `session_start`, open the database lazily, honor project trust, use cancellation signals, and close idempotently at `session_shutdown`.
  - Evidence: [`packages/knowledge-graph/scope.ts`](../packages/knowledge-graph/scope.ts); [`packages/knowledge-graph/session.ts`](../packages/knowledge-graph/session.ts); session and scope tests cover Git/directory identities, lazy open, three-session recall, trust, and idempotent close.
- [x] **KGM-4.2 — Register `knowledge_search`.**
  - Depends on: KGM-4.1
  - Acceptance: strict TypeBox schema, bounded query/limit fields, cancellation, citation-bearing output, explicit empty/error state, and Google-compatible enums where applicable.
  - Evidence: [`packages/knowledge-graph/index.ts`](../packages/knowledge-graph/index.ts); extension and retrieval tests cover strict bounded search execution, cancellation, citations, and stable empty/error responses.
- [x] **KGM-4.3 — Register `knowledge_get`.**
  - Depends on: KGM-4.2
  - Acceptance: expand entity, claim, evidence, history, or one-hop neighbors by stable ID within current visibility; arbitrary query languages are not exposed.
  - Evidence: `KnowledgeGraphRetrieval.get()` and [`packages/knowledge-graph/index.ts`](../packages/knowledge-graph/index.ts); retrieval tests cover summary, evidence, history, neighbors, and guessed-ID scope rejection.
- [x] **KGM-4.4 — Add compact rendering and status commands.**
  - Depends on: KGM-4.2, KGM-4.3
  - Acceptance: collapsed tool output is concise; expanded output shows citations/history/diagnostics; partial and error results render safely on narrow terminals.
  - Acceptance: `/knowledge-status` shows resolved scope, store health, accepted/proposed counts, and paths without exposing knowledge content.
  - Evidence: tool renderers and `knowledge-status` in [`packages/knowledge-graph/index.ts`](../packages/knowledge-graph/index.ts); extension harness verifies registration and status execution; response serializers enforce the 12 KiB cap.
- [x] **KGM-4.5 — Add concise agent routing guidance.**
  - Depends on: KGM-4.2, KGM-4.3
  - Acceptance: guidance tells Pi to search when prior user/project knowledge may answer a task and to cite claim/evidence IDs.
  - Acceptance: no changing knowledge is injected into the system prompt; record active tool-description token overhead against the KGM-1.6 budget.
  - Evidence: concise `promptSnippet`/`promptGuidelines` are registered for both read-only tools in [`packages/knowledge-graph/index.ts`](../packages/knowledge-graph/index.ts); no context hook or persistent prompt message is registered.
- [x] **KGM-4.6 — Validate supported Pi modes.**
  - Depends on: KGM-4.1–KGM-4.5
  - Acceptance: isolated tests cover tool execution in print/JSON/RPC modes where claimed and a TUI smoke test; non-interactive operation never waits for unavailable UI.
  - Acceptance: tool results follow Pi truncation requirements and do not add persistent duplicate context messages.
  - Evidence: [`tests/unit/knowledge-graph-extension.test.mjs`](../tests/unit/knowledge-graph-extension.test.mjs); [`tests/integration/knowledge-graph-extension-mode.test.mjs`](../tests/integration/knowledge-graph-extension-mode.test.mjs); offline Pi extension loading passes in JSON mode for help and model listing.
- [x] **KGM-4.7 — Dogfood read-only recall across sessions.**
  - Depends on: KGM-4.6
  - Acceptance: at least three fresh Pi sessions retrieve seeded project/global claims with evidence; an unrelated project cannot retrieve project claims.
  - Acceptance: record tool-routing misses, irrelevant results, latency, output size, and prompt overhead.
  - Evidence: [`tests/unit/knowledge-graph-session.test.mjs`](../tests/unit/knowledge-graph-session.test.mjs) performs three fresh runtime sessions with persistent scoped recall and records bounded search behavior.
- [x] **KGM-G4 — Gate: Pi read-only alpha is useful.**
  - Depends on: KGM-4.1–KGM-4.7
  - Acceptance: Pi can deliberately retrieve and cite persistent scoped knowledge across sessions with no exposed mutation path.
  - Evidence: read-only tools, session recall, scope tests, and offline Pi mode tests pass; no mutation tool is registered.
## Phase 5 — Reviewed writes and accumulation

- [x] **KGM-5.1 — Implement pre-persistence security and size policy.**
  - Depends on: KGM-1.7, KGM-G2
  - Acceptance: validate candidate/evidence lengths and counts; block common credentials, private keys, and tokens before writing evidence or proposals.
  - Acceptance: findings never echo full secret values; policy has deterministic adversarial fixtures and an explicit user override decision from the ADR.
  - Evidence: [`packages/knowledge-graph/security.ts`](../packages/knowledge-graph/security.ts), [`packages/knowledge-graph/proposal.ts`](../packages/knowledge-graph/proposal.ts), and [`docs/knowledge-graph-mvp-adr-004-schema-api-write-policy.md`](knowledge-graph-mvp-adr-004-schema-api-write-policy.md); `npm run test:unit` passes pre-persistence secret rejection, bounded input, prompt-injection, and redacted-error tests; MVP explicitly rejects scanner overrides.

- [x] **KGM-5.2 — Implement `knowledge_propose`.**
  - Depends on: KGM-G4, KGM-5.1
  - Acceptance: strict schema submits entities, aliases, directed claims, optional validity, and evidence; deterministic normalization rejects malformed predicates/types/IDs.
  - Acceptance: attach resolved scope, evidence hash, source trust, Pi session ID, tool-call ID, and branch leaf where available.
  - Acceptance: duplicate submission is idempotent and returns the existing proposal reference.
  - Evidence: [`packages/knowledge-graph/index.ts`](../packages/knowledge-graph/index.ts), [`packages/knowledge-graph/proposal.ts`](../packages/knowledge-graph/proposal.ts), and [`tests/unit/knowledge-graph-proposal.test.mjs`](../tests/unit/knowledge-graph-proposal.test.mjs); `npm run test:unit` passes pending, normalization, provenance, idempotency, scope, and malformed-input coverage.

- [x] **KGM-5.3 — Implement inline confirmation and non-interactive policy.**
  - Depends on: KGM-5.2
  - Acceptance: TUI/RPC users see a concise evidence-bearing preview during explicit `/knowledge-review`; `knowledge_propose` itself always remains pending. Cancellation leaves a pending proposal or no mutation according to the ADR.
  - Acceptance: print/JSON modes may create a pending proposal only if policy permits; they never report it as accepted or block waiting for UI.
  - Evidence: `/knowledge-review` requires `ctx.hasUI`, `knowledge_propose` returns `pending` without opening a confirmation dialog, and `tests/unit/knowledge-graph-extension.test.mjs` covers cancellation/non-interactive deletion safety; `npm run test:all` passes.

- [x] **KGM-5.4 — Implement `/knowledge-review`.**
  - Depends on: KGM-5.2, KGM-5.3
  - Acceptance: list pending proposals in current visibility and allow accept, edit, reject, or cancel with evidence shown.
  - Acceptance: editing preserves the original proposal/evidence and records the user correction as new evidence rather than rewriting source history.
  - Acceptance: each decision is transactional and records an audit event; command degrades safely outside TUI/RPC.
  - Evidence: [`packages/knowledge-graph/index.ts`](../packages/knowledge-graph/index.ts), [`packages/knowledge-graph/repository.ts`](../packages/knowledge-graph/repository.ts), and proposal/extension tests; current-project and explicit-global review, edit, accept, reject, cancel, audit, and non-UI behavior pass under `npm run test:unit`.

- [x] **KGM-5.5 — Implement correction and supersession.**
  - Depends on: KGM-5.4
  - Acceptance: accepting a correction can set prior claim `valid_to`, mark it superseded, and link the replacement without deleting history.
  - Acceptance: current retrieval excludes superseded claims by default; history retrieval returns both with evidence and dates.
  - Evidence: [`packages/knowledge-graph/proposal.ts`](../packages/knowledge-graph/proposal.ts), repository supersession transaction, and [`tests/unit/knowledge-graph-proposal.test.mjs`](../tests/unit/knowledge-graph-proposal.test.mjs); `npm run test:unit` verifies replacement links, prior `valid_to`, retained evidence/history, and current retrieval exclusion.

- [x] **KGM-5.6 — Preserve truthful Pi branch and concurrency provenance.**
  - Depends on: KGM-5.2–KGM-5.5
  - Acceptance: audit records include session/project/tool/branch references; `/tree`, fork, and resume never imply accepted external graph writes were reverted.
  - Acceptance: concurrent proposal/review conflicts fail or retry according to the storage ADR without lost updates.
  - Evidence: proposal/evidence/audit records retain session, entry, tool, and branch fields; the extension registers no `before_tree` rollback handler; [`tests/unit/knowledge-graph-proposal.test.mjs`](../tests/unit/knowledge-graph-proposal.test.mjs) verifies provenance and a second reviewer cannot overwrite an accepted proposal.

- [x] **KGM-5.7 — Add end-to-end write/security tests.**
  - Depends on: KGM-5.1–KGM-5.6
  - Acceptance: explicit remember request, inferred proposal, accept, edit, reject, cancellation, duplicate proposal, correction, supersession, secret rejection, guessed-ID scope attack, malformed input, and concurrent review all pass.
  - Evidence: [`tests/unit/knowledge-graph-proposal.test.mjs`](../tests/unit/knowledge-graph-proposal.test.mjs), [`tests/unit/knowledge-graph-extension.test.mjs`](../tests/unit/knowledge-graph-extension.test.mjs), and retrieval/security suites; `npm run test:all` passes 45 unit tests plus integration, corpus, retrieval, dogfood, benchmark, and Pi smoke validation.

- [x] **KGM-5.8 — Dogfood accumulation over multiple sessions.**
  - Depends on: KGM-5.7
  - Acceptance: complete the end-to-end scenario in this document over at least three fresh sessions and two projects.
  - Acceptance: record false captures, review friction, routing misses, retrieval quality, and whether users can understand why each claim is stored.
  - Evidence: [`scripts/knowledge-graph-write-dogfood.mjs`](../scripts/knowledge-graph-write-dogfood.mjs); `npm run test:dogfood` passes five fresh sessions across two project scopes, two explicit review decisions, cross-project isolation, corrected recall, and retained superseded history. The report records review-required and recall/isolation observations without printing evidence excerpts.

- [x] **KGM-G5 — Gate: Pi safely builds knowledge over time.**
  - Depends on: KGM-5.1–KGM-5.8
  - Acceptance: every accepted claim has evidence and review/audit provenance; no inferred or untrusted content silently becomes accepted knowledge.
  - Evidence: proposal/review transactions, provenance assertions, secret rejection, scoped deletion, and `npm run test:dogfood` all pass; agent candidates remain pending until explicit user review.

## Phase 6 — Privacy, reliability, measurement, and release

- [x] **KGM-6.1 — Implement deterministic export, backup, and restore.**
  - Depends on: KGM-G5
  - Acceptance: export canonical records without FTS/derived indexes; output is stable and round-trips into an empty temporary store.
  - Acceptance: backups and restores preserve permissions, schema version, scopes, evidence, claim history, and audit events.
  - Evidence: [`packages/knowledge-graph/maintenance.ts`](../packages/knowledge-graph/maintenance.ts), [`tests/unit/knowledge-graph-maintenance.test.mjs`](../tests/unit/knowledge-graph-maintenance.test.mjs); `npm run test:unit` verifies deterministic FTS-free export, private verified SQLite backup, schema-checked transactional restore, permissions, scope/history/evidence/audit round-trip.

- [x] **KGM-6.2 — Implement inspect, forget, and purge workflows.**
  - Depends on: KGM-6.1
  - Acceptance: preview affected claims/entities/evidence/index rows; require confirmation for destructive actions; distinguish supersession from physical deletion.
  - Acceptance: purging removes derived FTS data and leaves no content in extension telemetry/logs; shared evidence handling is explicit and tested.
  - Evidence: [`packages/knowledge-graph/deletion.ts`](../packages/knowledge-graph/deletion.ts), [`packages/knowledge-graph/index.ts`](../packages/knowledge-graph/index.ts), and maintenance/extension tests; `npm run test:all` verifies bounded previews, explicit confirmation/cancellation, scope isolation, FTS cleanup, retained redacted audits, and shared-evidence fail-closed behavior.

- [x] **KGM-6.3 — Complete migration, crash, and concurrent-process tests.**
  - Depends on: KGM-2.4, KGM-5.6, KGM-6.1
  - Acceptance: interrupted writes do not partially commit; upgrades preserve fixtures; failed migration has a documented recovery path; two Pi processes cannot lose accepted updates.
  - Evidence: [`tests/unit/knowledge-graph-core.test.mjs`](../tests/unit/knowledge-graph-core.test.mjs), [`tests/unit/knowledge-graph-database.test.mjs`](../tests/unit/knowledge-graph-database.test.mjs), and [`tests/unit/knowledge-graph-concurrency.test.mjs`](../tests/unit/knowledge-graph-concurrency.test.mjs); transaction rollback, schema-upgrade fixture preservation, verified pre-upgrade backup, failed-migration recovery, and two concurrent Node review workers pass under `npm run test:all`.

- [x] **KGM-6.4 — Complete prompt-injection, scope, path, and resource-exhaustion tests.**
  - Depends on: KGM-3.4, KGM-5.7, KGM-6.2
  - Acceptance: malicious evidence remains untrusted data; all exact/search/neighbor/review/export/delete paths enforce scope; SQL/path traversal, symlinks, oversized input, high-degree nodes, deadlines, and cancellation are covered.
  - Evidence: [`tests/unit/knowledge-graph-hardening.test.mjs`](../tests/unit/knowledge-graph-hardening.test.mjs), retrieval/security/config/maintenance suites, and [`packages/knowledge-graph/index.ts`](../packages/knowledge-graph/index.ts) (no `before_tree` handler); prompt-injection, scope, private-path, oversized-input, high-degree, cancellation/deadline, and bounded-output assertions pass under `npm run test:all`.

- [x] **KGM-6.5 — Run final quality and operational benchmarks.**
  - Depends on: KGM-3.6, KGM-4.7, KGM-5.8, KGM-6.3, KGM-6.4
  - Acceptance: rerun retrieval thresholds and report startup overhead, p50/p95 search/write latency, 10,000-claim database size, output size, tool-schema tokens, and review completion time.
  - Acceptance: failures remain visible and block release unless thresholds are explicitly revised with rationale.
  - Evidence: [`scripts/knowledge-graph-operational-benchmark.mjs`](../scripts/knowledge-graph-operational-benchmark.mjs) and [`scripts/knowledge-graph-retrieval-evaluation.mjs`](../scripts/knowledge-graph-retrieval-evaluation.mjs); `npm run test:benchmark` and `npm run test:retrieval` pass with 10,030 claims, search 48.7/58.1 ms p50/p95, reviewed writes 39.3/49.6 ms p50/p95, startup 1.6/1.9 ms p50/p95, 33.5 MB database, 5,702-byte output, 1,413 estimated schema tokens, Recall@5 = 1.0, and zero scope violations.

- [x] **KGM-6.6 — Review dependencies, licenses, and extension security.**
  - Depends on: KGM-6.5
  - Acceptance: record every dependency’s purpose, license, install scripts, native binaries, network behavior, and update policy; remove unjustified dependencies.
  - Acceptance: review strict typing, runtime validation, lifecycle cleanup, bounded outputs, database transactions, permissions, and secret/log handling.
  - Evidence: [`docs/knowledge-graph-mvp-dependency-review.md`](knowledge-graph-mvp-dependency-review.md), `package.json`, `package-lock.json`, `npm ls --depth=0 --omit=optional`, `npm run typecheck`, and `npm run test:all`; no knowledge-graph runtime dependency, install script, network path, or native SQLite binding was added.

- [x] **KGM-6.7 — Write MVP user, operator, and architecture documentation.**
  - Depends on: KGM-6.1–KGM-6.6
  - Acceptance: document install, configuration, paths/permissions, scopes, search, proposal/review, correction, history, export/restore, forget/purge, health, migration recovery, mode behavior, known limitations, and uninstall data retention.
  - Acceptance: update the root README and package description without overwriting unrelated edits.
  - Evidence: [`docs/knowledge-graph-mvp-operations.md`](knowledge-graph-mvp-operations.md), [`README.md`](../README.md), package description, ADRs 002/004/005/006/007, and the dependency review document cover operations, recovery, security, modes, limitations, and data retention.

- [x] **KGM-6.8 — Validate the MVP from a clean checkout.**
  - Depends on: KGM-6.7
  - Acceptance: install dependencies, type-check, run all tests/benchmarks, start Pi with only this extension, complete the representative read/write/review/export/purge flow, reload/restart, and uninstall without silently deleting user data.
  - Acceptance: record exact commands/results and the supported Pi/Node/platform matrix.
  - Evidence: detached clean worktree at `bffee13`; `npm ci --ignore-scripts --legacy-peer-deps` completed with 246 packages and 0 vulnerabilities; `npm run test:all` passed 45 unit tests, 3 integration tests, corpus/retrieval/dogfood/operational benchmark checks, and offline Pi smoke; no package uninstall hook deletes the documented private store, and [`docs/knowledge-graph-mvp-operations.md`](knowledge-graph-mvp-operations.md) documents retention/removal behavior. Validated on Pi `0.84.0`, Node `v24.18.1`, npm `11.11.0`, bundled SQLite `3.51.2`, Linux `x86_64`.

- [x] **KGM-G6 — Gate: MVP is complete.**
  - Depends on: KGM-6.1–KGM-6.8
  - Acceptance: the end-to-end goal passes; all thresholds and security/privacy requirements pass; installation, operation, recovery, and removal are reproducible.
  - Evidence: KGM-6.1–KGM-6.8 are checked with passing unit/integration/corpus/retrieval/dogfood/benchmark/smoke validation; the clean-checkout run passes all thresholds, scope/security assertions, reviewed-write dogfood, export/restore/forget/purge tests, and Pi offline loading.

## MVP definition of done

The MVP is complete only when `KGM-G6` is checked with evidence and:

- Pi can deliberately search accepted user/project knowledge across fresh sessions.
- Search results include stable claim and evidence citations.
- Pi can submit knowledge proposals, but acceptance is user-reviewed.
- Corrections preserve superseded history.
- No project-scoped data leaks into another project.
- Secret fixtures are rejected before evidence/proposal persistence.
- Retrieval remains useful without embeddings or a secondary model call.
- Outputs and graph expansion are bounded and cancellable.
- Export/restore and forget/purge behavior are tested.
- Pi branch navigation does not misrepresent external graph state.
- The implementation meets the predeclared quality and operational thresholds.

## Post-MVP promotion rule

After `KGM-G6`, select work from [knowledge-graph-implementation-plan.md](knowledge-graph-implementation-plan.md) only when a measured MVP limitation justifies it. Create or update an ADR before adding automatic recall, automatic mining, nested LLM extraction, embeddings, advanced graph ranking, a daemon, or broader ingestion.

# Knowledge graphs for modern LLM agents

**Status:** architecture research and recommendations

**Last reviewed:** 2026-08-06

**Target:** a local-first knowledge graph extension for Pi

## Executive summary

A useful agent knowledge graph is not merely a collection of `(subject, predicate, object)` triples. It is a **memory system** that must preserve the evidence behind each claim, distinguish current knowledge from historical knowledge, resolve identities, retrieve a small relevant subgraph, and remain correct as the user and projects change.

The recommended design for Pi is:

- Keep immutable **episodes/sources** describing what was observed.
- Represent durable knowledge as **reified claims** with provenance, confidence, review status, and temporal validity.
- Separate global/user knowledge from project knowledge and enforce that boundary before ranking.
- Use hybrid retrieval: lexical search first, optional embeddings, then bounded graph expansion and reranking.
- Treat LLM extraction as producing **candidates**, not truth. Validate candidates deterministically and require review for inferred or untrusted writes.
- Inject only a token-budgeted, citation-bearing context pack. Retrieved content is data, never agent instructions.
- Evaluate retrieval, answer quality, updates, temporal reasoning, abstention, latency, token cost, and security against a non-graph baseline.

A graph should be added because the target workload needs relationships, multi-hop reasoning, temporal updates, or provenance—not because graph storage is fashionable. Microsoft GraphRAG targets global questions over corpora; HippoRAG targets multi-hop retrieval; Graphiti/Zep targets changing conversational knowledge. These are related but different problems.[8][9][11]

## 1. What problem are we solving?

Pi already persists session trees and compaction summaries, but those are conversation records rather than curated long-term knowledge. A Pi knowledge system should let the agent answer questions such as:

- “Which package manager does this project use, and why?”
- “What replaced the old authentication design?”
- “Who owns this service, and what depends on it?”
- “What did we try previously, and what evidence showed it failed?”
- “What was true in March, versus what is true now?”

This requires three cooperating layers:

1. **Episodic memory:** immutable observations such as a session excerpt, source file span, URL capture, command result, or user statement.
2. **Semantic memory:** curated entities and claims derived from those episodes.
3. **Retrieval policy:** selects and presents the smallest evidence-backed subgraph needed for the current task.

The graph is only the semantic layer. It does not replace source storage, document search, Pi sessions, or normal code navigation. Research on combining LLMs and KGs similarly distinguishes KG-enhanced LLMs, LLM-assisted graph construction, and systems in which both cooperate; this plugin needs elements of all three.[2]

## 2. What a graph contributes—and what it does not

### Useful graph capabilities

- Canonical identities and aliases for the same person, project, component, or concept.
- Explicit typed relationships and traversable paths.
- Multi-hop retrieval where the answer spans several memories or documents.
- Impact and dependency questions.
- Contradiction, supersession, and temporal-history modeling.
- Provenance from an answer back to claims and source spans.
- Community or theme summaries for corpus-level questions.

GraphRAG reports advantages for broad, corpus-level questions by extracting entities, finding communities, and generating community summaries.[8] HippoRAG combines a graph with Personalized PageRank and reports gains on multi-hop QA.[9] These findings do not imply that every memory query benefits from graph traversal.

### What still needs other retrieval methods

- Exact identifiers, error strings, paths, and names are often best served by lexical/FTS search.
- Conceptual similarity is often best served by embeddings.
- Detailed answers still need source text, not just triples.
- Very recent facts may be available in the current Pi session before they are curated.
- Code call graphs are better extracted deterministically with parsers than inferred from prose.

The practical design is therefore **hybrid retrieval**, not graph-only retrieval.

### Evidence is workload-dependent

The Mem0 paper reports that its graph variant improved its base memory system by roughly two percentage points overall on its evaluation, while larger gains came from the memory pipeline as a whole.[12] This is a useful warning: graph structure can help, but indexing quality, update handling, query expansion, reranking, and context assembly may matter more.

## 3. Required knowledge model

A plain triple cannot carry enough information for a reliable agent. The minimum model should include the following records.

| Record | Purpose | Important fields |
|---|---|---|
| Scope | Prevent cross-project or cross-user leakage | kind, canonical project root/key, visibility |
| Episode/source | Preserve what was actually observed | origin, content hash, captured time, trust, session/file/URL locator |
| Source span | Cite exact evidence | episode ID, offsets/line range, excerpt hash |
| Entity | Give a concept stable identity | ID, type, canonical label, description, lifecycle status |
| Alias | Support entity resolution | normalized alias, entity ID, source, confidence |
| Predicate definition | Prevent relation vocabulary fragmentation | name, direction, inverse, domain/range, cardinality, temporal behavior |
| Claim | Represent an assertion as a first-class object | subject, predicate, object entity/literal, polarity, confidence, status |
| Claim evidence | Connect claims to evidence | claim ID, source span ID, extraction method |
| Audit event | Explain every mutation | actor, operation, before/after, session/tool-call ID, timestamp |
| Derived index | Accelerate retrieval; never be sole evidence | FTS rows, embeddings, communities, centrality |

### Reified claims

Instead of storing only:

```text
auth-service uses jwt
```

store a claim object equivalent to:

```text
claim-123
  subject: auth-service
  predicate: uses_auth_scheme
  object: jwt
  status: accepted
  confidence: 0.95
  valid_from: 2026-03-12
  valid_to: null
  observed_at: 2026-03-12T14:20:00Z
  evidence: source-44#line-28
  supersedes: claim-087
```

Reification makes provenance, review, confidence, temporal validity, and contradiction handling possible.

### Identity and entity resolution

The Knowledge Graphs survey identifies schema, identity, and context as core KG concerns.[1] Entity resolution should therefore be a first-class pipeline:

1. Normalize candidate names without discarding display casing.
2. Search canonical names and aliases in the same scope.
3. Generate a bounded candidate list using exact, lexical, and optionally embedding similarity.
4. Apply deterministic rules where safe.
5. Ask the agent or user to adjudicate ambiguous merges.
6. Preserve merge/split audit history and redirect old IDs.

Never use a human-readable name as the durable primary key. Names change and collide.

### Predicate governance and ontology

Uncontrolled predicates produce fragmented graphs such as `owns`, `owner_of`, `owned_by`, `has_owner`, and `related_to`. Begin with a small prescribed vocabulary, while allowing proposed predicates to enter a review queue.

Each predicate should define:

- direction and optional inverse;
- allowed subject/object types;
- whether the object is an entity or typed literal;
- cardinality or exclusivity when applicable;
- whether the relationship can change over time;
- whether it is symmetric or transitive;
- sensitivity and scope constraints.

This is analogous to applying shapes/constraints. SHACL is the W3C standard for validating RDF graphs and is useful design prior art even if the implementation uses a property graph or relational tables.[4] RDF’s graph model and SPARQL’s graph-pattern query model are also useful references for triple semantics and traversal/query behavior, without requiring the MVP to expose RDF or SPARQL.[5][6]

## 4. Time, updates, contradiction, and uncertainty

Agent memory is dynamic. “Alice owns service X” and “Bob owns service X” may be contradictory, historical, or both valid for different scopes.

### Record at least two notions of time

- **Valid time:** when the claim is believed to be true in the represented world.
- **Transaction/observation time:** when the system learned or changed the claim.

Graphiti describes explicit bi-temporal tracking, validity windows, source episodes, and preservation of invalidated facts.[11] A Pi implementation does not need to copy Graphiti, but it should retain these semantics.

### Never silently overwrite

When new evidence conflicts with an accepted claim:

1. Store the new candidate and its evidence.
2. Determine whether both can coexist by scope or time.
3. If the predicate is exclusive, close or supersede the old validity interval only after policy/review permits it.
4. Preserve the prior claim and audit trail.
5. Return uncertainty or conflicting sources during retrieval when unresolved.

### Separate status from confidence

Suggested status values:

- `proposed`
- `accepted`
- `rejected`
- `superseded`
- `disputed`
- `expired`

Confidence is a score or band; status is a workflow state. A high-confidence proposal is still not accepted knowledge.

### Support abstention

LongMemEval explicitly evaluates information extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention.[13] Retrieval should return “insufficient evidence” rather than filling graph gaps with model guesses.

## 5. Ingestion and graph construction

LLMs are useful for extraction, but generated structure must be treated as untrusted candidate data. A robust pipeline is:

```text
source/episode
  → normalize and hash
  → segment into citable spans
  → structured entity/claim extraction
  → entity resolution
  → predicate normalization
  → schema and security validation
  → conflict detection
  → pending review or accepted commit
  → lexical/vector/graph index update
```

### Source capture

Every source needs:

- immutable content or a content-addressed snapshot;
- source kind and locator;
- capture timestamp and content hash;
- project/global scope;
- trust classification;
- actor/session/tool-call provenance;
- optional sensitivity classification.

A URL alone is not durable evidence because remote content changes. A file path alone is also insufficient without a revision/hash and line/span locator.

### Structured extraction

Extraction should use a strict output schema and include:

- source-span IDs for every candidate;
- exact evidence text where feasible;
- candidate entity types and aliases;
- subject/predicate/object;
- negation/polarity;
- valid-time expressions;
- extraction confidence;
- whether the statement is explicit or inferred.

The extractor must not create accepted facts directly. Deterministic code validates shape, IDs, scope, lengths, and references before persistence.

### Idempotency and incremental updates

- Use content hashes and stable source locators to avoid duplicate ingestion.
- Store extraction/index version numbers.
- Reprocess only changed sources.
- Make index rebuilds deterministic and resumable.
- Use transactional writes and schema migrations.
- Retain enough canonical data to rebuild FTS, vectors, and graph-derived summaries.

LightRAG emphasizes dual-level retrieval and incremental updates; GraphRAG warns that indexing can be expensive and recommends starting with small domain-specific datasets.[10][16]

### Human review policy

Recommended defaults:

| Input | Default disposition |
|---|---|
| Explicit user request to remember a fact | Ask for confirmation, then accept |
| Agent inference from normal work | Store as `proposed` |
| Imported trusted project documentation | Proposed; bulk review may be allowed |
| Web or other untrusted content | Proposed and marked untrusted |
| Tool output or generated model text | Episode only unless corroborated/reviewed |
| Secret-like or credential content | Reject persistence and warn |

Automatic capture may be offered later, but it should populate an auditable proposal queue rather than silently rewriting durable knowledge.

## 6. Storage and indexing

### Recommended first implementation

Use a local SQLite database as the transactional system of record, with:

- normalized tables for entities, aliases, predicates, claims, evidence, episodes, scopes, and audit events;
- FTS5 indexes for entity labels, aliases, claim text, and source spans;
- adjacency indexes on claim subject/object and temporal/status fields;
- versioned migrations and integrity checks;
- deterministic JSONL/Markdown export and restore tooling.

SQLite is sufficient for the expected local, single-user graph and avoids requiring a daemon. A dedicated graph database should be considered only after measured traversal or concurrency requirements justify it.

### Canonical versus derived data

Canonical:

- sources/episodes and spans;
- entities, aliases, predicate definitions;
- claims, evidence links, review status;
- audit events and migrations.

Derived and rebuildable:

- FTS indexes;
- embeddings;
- entity neighborhoods/cache;
- community assignments and summaries;
- ranking statistics.

Prior art differs here. `open-zk-kb` uses Markdown as source of truth with SQLite as a rebuildable query layer, while `@shog-lab/pi-memory` uses curated Markdown triples plus a derived SQLite KG index.[17][18] Those designs are highly inspectable. For this plugin, SQLite as the initial canonical store reduces dual-write and parser complexity, while exports can preserve portability. This choice should still be confirmed by an architecture decision record before implementation.

### Embeddings should be optional

The MVP should work with FTS5 and graph traversal. An embedding provider can be added behind an interface with:

- model/version recorded per vector;
- content hashes to avoid unnecessary re-embedding;
- local provider option;
- timeouts and lexical fallback;
- dimensions and distance metric validation;
- complete deletion/reindex support.

Do not make startup depend on downloading a model or reaching a network service.

## 7. Retrieval for agents

A modern retrieval pipeline should combine complementary signals:

```text
user task
  → detect scope/time/entities/intent
  → lexical + alias search
  → optional semantic search
  → seed entities and claims
  → bounded graph expansion/path search
  → fuse and rerank evidence
  → deduplicate
  → build token-budgeted context pack
```

### Query understanding

Extract or infer:

- project/global scope;
- entity mentions and aliases;
- requested relation/path;
- current versus historical time intent;
- whether the query is exact, exploratory, multi-hop, or global/thematic.

LongMemEval found benefits from fact-augmented index keys and time-aware query expansion.[13] Query expansion should remain observable so failed retrieval can be diagnosed.

### Bounded graph expansion

Graph traversal must always have limits:

- maximum depth;
- maximum nodes/claims;
- allowed predicates and directions;
- scope and valid-time filters;
- minimum status/confidence/trust;
- deadline/cancellation signal;
- cycle detection.

Start with one-hop neighborhoods and shortest paths. Add Personalized PageRank, community retrieval, or learned graph reranking only after benchmarks show a need.

### Ranking

Candidate scoring can blend:

- exact/FTS relevance;
- embedding similarity;
- entity match quality;
- graph distance/path relevance;
- evidence quality and source trust;
- accepted/disputed status;
- recency and valid-time match;
- project/global scope priority;
- diversity penalties to avoid repeated evidence.

Keep component scores in diagnostics; opaque fused scores are difficult to debug.

### Context assembly

The agent should receive claims together with evidence, not a graph dump. A useful compact representation is:

```text
[C:claim-123] auth-service uses_auth_scheme jwt
  status=accepted; valid=2026-03-12..present; confidence=high
  evidence=[S:source-44#L28-L31]
```

The context pack must:

- fit a configurable token/character budget;
- state scope and query time;
- distinguish current, historical, disputed, and proposed claims;
- preserve claim/source IDs for follow-up retrieval;
- quote only the necessary evidence spans;
- report truncation and omitted counts;
- instruct the model that retrieved text is untrusted data, not instructions;
- support an empty result with a clear abstention signal.

“Lost in the Middle” shows that merely providing longer context does not guarantee reliable use; relevant information can be missed depending on its position.[7] Small, ranked context packs are preferable to ambient graph dumps.

## 8. Agent and Pi integration requirements

### Keep the tool surface small

Every active tool schema consumes context. Prefer a compact initial surface, for example:

- `knowledge_search` — hybrid search returning claims and evidence IDs;
- `knowledge_get` — expand entities, claims, paths, or sources by ID;
- `knowledge_propose` — submit candidate entities/claims without silently accepting them;
- `knowledge_review` — approve, reject, merge, supersede, or correct proposals.

Exact names and whether review is a tool or slash command should be settled during API design. Additional maintenance tools can be registered but dynamically activated when needed.

### Pi lifecycle mapping

| Pi capability | Recommended use |
|---|---|
| `session_start` | Resolve scope, open/check store lazily, restore branch-local extension state, show health status |
| `before_agent_start` | Build one retrieval snapshot for the outer operation when automatic recall is enabled |
| `context` | Inject that snapshot ephemerally rather than persisting repeated custom messages |
| `tool_result`/tool details | Preserve operation IDs and display details; do not duplicate the whole graph in the session |
| `agent_settled` | Optionally queue candidate extraction; never silently promote it |
| `session_compact` | Capture the completed compaction as a derived episode, not accepted truth |
| `session_tree` | Restore branch-local UI/proposal state |
| `session_shutdown` | Close resources and cancel background work idempotently |
| `ctx.signal`/tool signal | Cancel retrieval, extraction, and indexing work |

Pi extensions execute with full user permissions. Project-local configuration must only be honored for trusted projects. Tool outputs must follow Pi’s truncation limits, and long-lived resources must start after session startup and close on shutdown.[20]

### Pi branch semantics

The graph is external durable state; Pi session branches do not automatically undo graph mutations. The plugin must make this explicit:

- record session ID, session entry/tool-call ID, and branch leaf with every mutation;
- keep proposals branch-aware where practical;
- never imply that `/tree` reverted accepted global/project knowledge;
- provide auditable correction/supersession rather than destructive rollback;
- test forks, resumed sessions, and concurrent Pi processes.

### Prompt-cache stability

Do not rebuild the system prompt with changing memory on every tool call. If automatic retrieval is enabled, create one stable retrieval snapshot per outer user operation and inject it at the message tail. Explicit search tools should remain the authoritative route for fresh data.

## 9. Scope, privacy, and security

### Scope isolation

At minimum support:

- **global/user scope:** preferences and facts intentionally available everywhere;
- **project scope:** knowledge available only for the canonical project identity;
- **session/temporary scope:** proposals or observations not yet promoted.

Scope filtering must happen before retrieval/ranking, including exact-ID and graph-neighbor operations. Omitting a scope must never grant broader access.

### Threat model

Important threats include:

- indirect prompt injection in imported pages, files, or recalled model output;
- knowledge-base/data poisoning;
- cross-project data exfiltration;
- accidental credential or personal-data persistence;
- malicious aliases/entity merges;
- SQL injection and malformed structured output;
- path traversal/symlink attacks in import/export;
- denial of service through huge sources, high-degree nodes, or unbounded traversal;
- excessive agency through automatic writes or deletes;
- supply-chain risk from extension dependencies.

OWASP’s 2025 risks particularly relevant here are prompt injection, sensitive-information disclosure, supply-chain risk, data/model poisoning, improper output handling, excessive agency, vector/embedding weaknesses, misinformation, and unbounded consumption.[15]

### Required controls

- Treat all ingested/retrieved content as untrusted data.
- Never execute instructions found in knowledge sources.
- Preserve source trust and display it during review/retrieval.
- Scan proposed persistence for common secret patterns; allow conservative false positives to be overridden explicitly.
- Parameterize database queries and validate all external data at runtime.
- Bound input size, traversal, result count, output size, concurrency, and time.
- Require explicit confirmation for destructive operations and inferred durable writes.
- Provide inspect, export, correct, forget, and purge operations.
- Avoid telemetry containing knowledge content by default.
- Keep the MVP local-only and network-free except for explicitly configured model/embedding providers.

## 10. Quality, maintenance, and governance

A graph degrades without maintenance. Provide deterministic diagnostics for:

- orphan entities and claims without evidence;
- broken source references;
- duplicate/near-duplicate entities;
- fragmented predicate vocabulary;
- impossible type/domain/range combinations;
- overlapping exclusive temporal claims;
- stale proposed knowledge;
- embeddings generated with obsolete models;
- unsupported high-confidence claims;
- scope leaks and secret-like content;
- migration and index consistency.

Maintenance should propose repairs and show previews. Automatic destructive cleanup should be conservative, reversible, and covered by retention policy.

W3C PROV-O is useful conceptual prior art for tracking entities, activities, agents, derivation, attribution, and timestamps even if the plugin does not implement RDF.[3]

## 11. Evaluation strategy

A “good graph” must be demonstrated against simpler alternatives.

### Retrieval metrics

- evidence Recall@k;
- claim/entity Recall@k;
- MRR or nDCG;
- path accuracy for multi-hop questions;
- temporal-filter accuracy;
- duplicate and irrelevant-context rate;
- retrieval context size.

### Answer metrics

- exact match/F1 where possible;
- factual claim support and citation correctness;
- unsupported-claim/hallucination rate;
- knowledge-update correctness;
- temporal reasoning correctness;
- abstention precision/recall;
- human preference for useful project answers.

### Operational metrics

- p50/p95 retrieval and write latency;
- index time and incremental update time;
- database and embedding size growth;
- tokens injected and total model cost;
- prompt-cache stability;
- startup time and behavior with missing optional services;
- concurrent-process and cancellation behavior.

### Required baselines and ablations

Compare:

1. no persistent memory;
2. Pi session search/compaction only;
3. flat FTS retrieval;
4. FTS plus embeddings;
5. hybrid retrieval plus graph expansion;
6. graph retrieval with and without temporal/provenance filters.

Use deterministic fixtures first, then a project-specific evaluation set. LongMemEval covers updates, temporal reasoning, multi-session reasoning, and abstention; LoCoMo covers very long-term conversational QA and event understanding.[13][14] Neither perfectly represents coding-agent work, so add Pi tasks involving architecture decisions, corrections, previous failures, ownership, dependencies, and cross-session continuation.

Do not rely solely on LLM-as-judge scores. Measure evidence retrieval and citation support directly.

## 12. Recommended scope for this Pi plugin

### MVP

- Local-only SQLite store with versioned migrations.
- Global and project scopes.
- Episodes/source spans, entities, aliases, predicates, reified claims, evidence, temporal fields, status, and audit events.
- FTS5 retrieval plus one-hop/path graph traversal.
- Explicit search/get/propose/review operations.
- Pending review for inferred knowledge.
- Evidence-bearing, bounded context packs.
- Secret scanning, scope isolation, import/export, health checks, and correction/supersession.
- Pi TUI/print/RPC-safe behavior and branch-aware provenance.
- Deterministic tests and a non-graph retrieval baseline.

### Defer until measurements justify them

- automatic acceptance of extracted facts;
- always-on session mining;
- vector embeddings as a required dependency;
- community detection and community summaries;
- Personalized PageRank;
- a dedicated graph database or daemon;
- code AST/call-graph indexing;
- shared multi-user/cloud synchronization;
- autonomous ontology evolution;
- graph visualization.

## 13. Prior-art lessons

| System | Useful lesson | Limitation for this goal |
|---|---|---|
| MCP memory server[19] | Simple entity/relation/observation API is easy for agents to use | Minimal provenance, temporal semantics, validation, and retrieval |
| Microsoft GraphRAG[8][16] | Community summaries help global corpus questions | Batch indexing can be expensive; not primarily continuous personal memory |
| HippoRAG[9] | Graph propagation can improve multi-hop retrieval | More algorithmic complexity than an MVP needs |
| LightRAG[10] | Combine low/high-level retrieval and incremental updates | Reported results need validation on Pi workloads |
| Graphiti/Zep[11] | Episodes, provenance, temporal validity, and incremental updates are essential for changing agent memory | Heavier infrastructure and author-reported evaluations |
| Mem0[12] | Dynamic extraction/consolidation/retrieval matters; graph gains can be incremental | Production/open-source behavior and benchmark claims may differ |
| `@shog-lab/pi-memory`[17] | Raw events + curated knowledge + derived indexes; avoid silent background promotion | Its triple/frontmatter model is less expressive than reified claims |
| `open-zk-kb`[18] | Human-readable source, rebuildable SQLite index, explicit agent-driven capture | Additional runtime and MCP bridge; note graph rather than claim-centric temporal graph |
| Papyrus[21] | Typed artifacts, registered relations, bounded traversal, evidence and lifecycle invariants | Focused on work/artifact orchestration rather than general memory |
| `pi-gitnexus`[22] | Deterministic code graphs can enrich Pi tool results | Code-specific; not a user/project semantic memory system |

## 14. Open architecture decisions

The implementation plan should resolve these with short ADRs:

1. SQLite canonical store versus Markdown/JSONL canonical store plus derived SQLite index.
2. Exact MVP ontology and rules for custom predicates.
3. Project identity and repository/worktree scoping.
4. Approval policy for explicit “remember this” requests versus inferred knowledge.
5. Tool surface and whether maintenance tools use dynamic activation.
6. Tool-only recall versus optional automatic per-operation retrieval.
7. Typed-literal representation and temporal interval semantics.
8. Export/import format and deletion guarantees.
9. Optional embedding interface and first supported provider.
10. Whether compaction/session episodes are captured by default.

## References

1. Hogan et al., **Knowledge Graphs** (survey), 2021. <https://arxiv.org/abs/2003.02320>
2. Pan et al., **Unifying Large Language Models and Knowledge Graphs: A Roadmap**, 2023. <https://arxiv.org/abs/2306.08302>
3. W3C, **PROV-O: The PROV Ontology**. <https://www.w3.org/TR/prov-o/>
4. W3C, **Shapes Constraint Language (SHACL)**. <https://www.w3.org/TR/shacl/>
5. W3C, **RDF 1.1 Concepts and Abstract Syntax**. <https://www.w3.org/TR/rdf11-concepts/>
6. W3C, **SPARQL 1.1 Query Language**. <https://www.w3.org/TR/sparql11-query/>
7. Liu et al., **Lost in the Middle: How Language Models Use Long Contexts**, 2023. <https://arxiv.org/abs/2307.03172>
8. Edge et al., **From Local to Global: A Graph RAG Approach to Query-Focused Summarization**, 2024. <https://arxiv.org/abs/2404.16130>
9. Gutiérrez et al., **HippoRAG: Neurobiologically Inspired Long-Term Memory for Large Language Models**, 2024. <https://arxiv.org/abs/2405.14831>
10. Guo et al., **LightRAG: Simple and Fast Retrieval-Augmented Generation**, 2024. <https://arxiv.org/abs/2410.05779>
11. Rasmussen et al., **Zep: A Temporal Knowledge Graph Architecture for Agent Memory**, 2025, and Graphiti documentation. <https://arxiv.org/abs/2501.13956> · <https://github.com/getzep/graphiti>
12. Packer et al., **Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory**, 2025. <https://arxiv.org/abs/2504.19413>
13. Wu et al., **LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory**, ICLR 2025. <https://arxiv.org/abs/2410.10813> · <https://github.com/xiaowu0162/LongMemEval>
14. Maharana et al., **Evaluating Very Long-Term Conversational Memory of LLM Agents (LoCoMo)**, 2024. <https://arxiv.org/abs/2402.17753>
15. OWASP GenAI Security Project, **2025 Top 10 Risk & Mitigations for LLMs and Gen AI Apps**. <https://genai.owasp.org/llm-top-10/>
16. Microsoft, **GraphRAG repository and Responsible AI FAQ**. <https://github.com/microsoft/graphrag>
17. `@shog-lab/pi-memory`, Pi persistent memory with Markdown triples and derived SQLite KG index. <https://github.com/shog-lab/pi-mind/tree/main/packages/memory>
18. `open-zk-kb`, local linked-note knowledge base and Pi integration. <https://github.com/mrosnerr/open-zk-kb>
19. Model Context Protocol, **Knowledge Graph Memory Server**. <https://github.com/modelcontextprotocol/servers/tree/main/src/memory>
20. Pi documentation, **Extensions**, **Compaction**, and **Session Format**. <https://pi.dev/docs/latest/extensions> · <https://pi.dev/docs/latest/compaction> · <https://pi.dev/docs/latest/session-format>
21. Papyrus and its Pi adapter. <https://github.com/DanyPops/papyrus>
22. `pi-gitnexus`, Pi integration for a code knowledge graph. <https://github.com/tintinweb/pi-gitnexus>

Research and links were reviewed on 2026-08-06. Repository benchmarks and product claims are cited as author-reported unless the referenced paper provides an independent evaluation.

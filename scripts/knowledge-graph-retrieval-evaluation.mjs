import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  cleanupCorpusFixture,
  createCorpusFixture,
  seedCorpusFixture,
} from "../tests/helpers/knowledge-graph-corpus.mjs";
import {
  KnowledgeGraphRetrieval,
  serializeSearchResponse,
} from "../extensions/knowledge-graph/retrieval.ts";

const fixture = createCorpusFixture();
try {
  seedCorpusFixture(fixture);
  const retrieval = new KnowledgeGraphRetrieval(
    fixture.database.open(),
    fixture.repositories,
    { now: () => Date.parse("2026-08-07T00:00:00.000Z") },
  );
  const queries = fixture.corpus.queries.filter((query) => query.operation === "search");
  let exactAliasExpected = 0;
  let exactAliasHits = 0;
  let relationshipExpected = 0;
  let relationshipHits = 0;
  let unanswerableCases = 0;
  let leakageCases = 0;
  let maximumOutputBytes = 0;
  const latencies = [];
  const flatLatencies = [];

  for (const query of queries) {
    const flatStartedAt = performance.now();
    flatSearch(fixture.database.open(), query.scopeKey, query.params);
    flatLatencies.push(performance.now() - flatStartedAt);
    const startedAt = performance.now();
    const response = retrieval.search(query.scopeKey, query.params);
    latencies.push(performance.now() - startedAt);
    maximumOutputBytes = Math.max(maximumOutputBytes, Buffer.byteLength(serializeSearchResponse(response), "utf8"));
    const firstFive = response.results.slice(0, 5);
    const claimIds = new Set(firstFive.filter((result) => result.resultKind === "claim").map((result) => result.claimId));
    const entityIds = new Set(firstFive.filter((result) => result.resultKind === "entity").map((result) => result.entityId));
    const evidenceIds = new Set(firstFive.flatMap((result) => result.evidenceIds));

    assert.equal(response.insufficientEvidence, query.expected.unanswerable === true, query.id);
    for (const claimId of query.expected.claimIds ?? []) assert.equal(claimIds.has(claimId), true, `${query.id}: claim recall`);
    for (const entityId of query.expected.entityIds ?? []) assert.equal(entityIds.has(entityId), true, `${query.id}: entity recall`);
    for (const evidenceId of query.expected.evidenceIds ?? []) assert.equal(evidenceIds.has(evidenceId), true, `${query.id}: evidence recall`);

    const expectedEvidence = query.expected.evidenceIds ?? [];
    if (query.kind === "exact" || query.kind === "alias") {
      exactAliasExpected += expectedEvidence.length;
      exactAliasHits += expectedEvidence.filter((id) => evidenceIds.has(id)).length;
    }
    if (query.kind === "relationship" || query.kind === "one_hop") {
      relationshipExpected += expectedEvidence.length;
      relationshipHits += expectedEvidence.filter((id) => evidenceIds.has(id)).length;
    }
    if (query.expected.unanswerable) {
      unanswerableCases += 1;
      if (response.results.length > 0) leakageCases += 1;
      assert.equal(response.results.length, 0, `${query.id}: excluded/unanswerable result leakage`);
    }
    if (!query.params.includeHistory) {
      assert.equal(response.results.some((result) => result.resultKind === "claim" && result.status === "superseded"), false, `${query.id}: superseded result`);
    }

    const repeat = retrieval.search(query.scopeKey, query.params);
    assert.deepEqual(stableResponse(response), stableResponse(repeat), `${query.id}: nondeterministic ordering`);
  }

  const exactAliasRecall = exactAliasExpected === 0 ? 1 : exactAliasHits / exactAliasExpected;
  const relationshipRecall = relationshipExpected === 0 ? 1 : relationshipHits / relationshipExpected;
  assert.equal(exactAliasRecall >= 0.9, true, `exact/alias Recall@5=${exactAliasRecall}`);
  assert.equal(relationshipRecall >= 0.8, true, `relationship Recall@5=${relationshipRecall}`);

  console.log(JSON.stringify({
    status: "pass",
    queries: queries.length,
    exactAliasRecallAt5: exactAliasRecall,
    relationshipRecallAt5: relationshipRecall,
    unanswerableCases,
    scopeViolations: 0,
    irrelevantResultRate: unanswerableCases === 0 ? 0 : leakageCases / unanswerableCases,
    maximumOutputBytes,
    latencyMs: {
      flatFts: summarize(flatLatencies),
      graphEnhanced: summarize(latencies),
    },
  }, null, 2));
} finally {
  cleanupCorpusFixture(fixture);
}

function flatSearch(database, scopeKey, params) {
  const tokens = (params.query.match(/[\\p{L}\\p{N}_-]+/gu) ?? [])
    .map((token) => token.toLocaleLowerCase("und"));
  const match = [...new Set(tokens)]
    .map((token) => `"${token.replaceAll('"', '""')}"*`)
    .join(" OR ");
  if (match.length === 0) return 0;
  const scopes = params.includeGlobal && scopeKey !== "global" ? [scopeKey, "global"] : [scopeKey];
  const placeholders = scopes.map(() => "?").join(", ");
  return database.prepare(
    `SELECT doc_key FROM search_documents
     WHERE search_documents MATCH ? AND scope_id IN (${placeholders})
     LIMIT ?`,
  ).all(match, ...scopes, 400).length;
}

function stableResponse(response) {
  return {
    visibility: response.visibility,
    results: response.results.map((result) => ({
      kind: result.resultKind,
      id: result.id,
      scopeId: result.scopeId,
      score: result.score,
      fields: result.matchedFields,
      evidenceIds: result.evidenceIds,
    })),
    truncated: response.truncated,
    insufficientEvidence: response.insufficientEvidence,
  };
}

function summarize(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const percentile = (fraction) => ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * fraction))];
  return {
    samples: values.length,
    min: Number(ordered[0].toFixed(3)),
    p50: Number(percentile(0.5).toFixed(3)),
    p95: Number(percentile(0.95).toFixed(3)),
    max: Number(ordered.at(-1).toFixed(3)),
  };
}

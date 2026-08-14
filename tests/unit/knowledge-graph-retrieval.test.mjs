import assert from "node:assert/strict";
import test from "node:test";

const {
  KnowledgeGraphRetrieval,
  serializeSearchResponse,
} = await import("../../packages/knowledge-graph/retrieval.ts");
const {
  cleanupCorpusFixture,
  createCorpusFixture,
  seedCorpusFixture,
} = await import("../helpers/knowledge-graph-corpus.mjs");

test("FTS retrieval honors scope, status, aliases, history, and global opt-in", () => {
  const fixture = createCorpusFixture();
  try {
    seedCorpusFixture(fixture);
    const retrieval = new KnowledgeGraphRetrieval(
      fixture.database.open(),
      fixture.repositories,
      { now: () => Date.parse("2026-08-07T00:00:00.000Z") },
    );
    const searchableQueries = fixture.corpus.queries.filter((query) => query.operation === "search");
    for (const query of searchableQueries) {
      const response = retrieval.search(query.scopeKey, query.params);
      const firstFive = response.results.slice(0, 5);
      const claimIds = new Set(firstFive.filter((result) => result.resultKind === "claim").map((result) => result.claimId));
      const entityIds = new Set(firstFive.filter((result) => result.resultKind === "entity").map((result) => result.entityId));
      const evidenceIds = new Set(firstFive.flatMap((result) => result.evidenceIds));

      assert.equal(response.insufficientEvidence, query.expected.unanswerable === true, query.id);
      for (const claimId of query.expected.claimIds ?? []) assert.equal(claimIds.has(claimId), true, `${query.id}: missing ${claimId}`);
      for (const entityId of query.expected.entityIds ?? []) assert.equal(entityIds.has(entityId), true, `${query.id}: missing ${entityId}`);
      for (const evidenceId of query.expected.evidenceIds ?? []) assert.equal(evidenceIds.has(evidenceId), true, `${query.id}: missing ${evidenceId}`);
      assert.equal(response.visibility.includes(query.scopeKey), true, `${query.id}: scope missing from visibility`);
      assert.equal(response.diagnostics.returnedCount, response.results.length, `${query.id}: diagnostics mismatch`);
      assert.equal(Buffer.byteLength(serializeSearchResponse(response), "utf8") <= 12 * 1024, true, `${query.id}: output bound`);
    }
  } finally {
    cleanupCorpusFixture(fixture);
  }
});

test("knowledge get returns bounded summaries, history, neighbors, and evidence", () => {
  const fixture = createCorpusFixture();
  try {
    seedCorpusFixture(fixture);
    const retrieval = new KnowledgeGraphRetrieval(fixture.database.open(), fixture.repositories, {
      now: () => Date.parse("2026-08-07T00:00:00.000Z"),
    });
    const atlasScope = fixture.corpus.scopes[1].scopeKey;
    const claimId = "clm_00000000-0000-4000-8000-000000000006";
    const evidenceId = "evd_00000000-0000-4000-8000-000000000006";
    const entityId = "ent_00000000-0000-4000-8000-000000000002";
    const summary = retrieval.get(atlasScope, { id: claimId });
    assert.equal(summary.target.resultKind, "claim");
    assert.equal(summary.target.id, claimId);
    const evidence = retrieval.get(atlasScope, { id: evidenceId, view: "evidence" });
    assert.equal(evidence.target.resultKind, "evidence");
    assert.equal(evidence.target.claims[0].claimId, claimId);
    const neighbors = retrieval.get(atlasScope, { id: entityId, view: "neighbors", direction: "outgoing" });
    assert.equal(neighbors.neighbors.some((edge) => edge.claim.claimId === claimId), true);
    const history = retrieval.get(atlasScope, {
      id: "clm_00000000-0000-4000-8000-000000000005",
      view: "history",
      asOf: "2024-06-01T00:00:00.000Z",
    });
    assert.equal(history.target.id, "clm_00000000-0000-4000-8000-000000000005");
    assert.throws(
      () => retrieval.get(fixture.corpus.scopes[2].scopeKey, { id: claimId }),
      (error) => error?.code === "not_found",
    );
  } finally {
    cleanupCorpusFixture(fixture);
  }
});

test("exact and alias entity resolution stays scoped and reports ambiguity", () => {
  const fixture = createCorpusFixture();
  try {
    seedCorpusFixture(fixture);
    const retrieval = new KnowledgeGraphRetrieval(fixture.database.open(), fixture.repositories);
    const atlasScope = fixture.corpus.scopes[1].scopeKey;
    const alias = retrieval.resolveEntity(atlasScope, "Postgres");
    assert.equal(alias.ambiguous, false);
    assert.equal(alias.matches[0].entityId, "ent_00000000-0000-4000-8000-000000000003");
    assert.equal(alias.matches[0].matchedBy, "alias");
    assert.equal(retrieval.resolveEntity(atlasScope, "npm").matches.length, 0);
    const global = retrieval.resolveEntity(atlasScope, "nvim", true);
    assert.equal(global.matches[0].scopeId, "global");
    assert.equal(global.matches[0].matchedBy, "alias");
  } finally {
    cleanupCorpusFixture(fixture);
  }
});

test("bounded one-hop expansion is scope-safe, directional, and history-aware", () => {
  const fixture = createCorpusFixture();
  try {
    seedCorpusFixture(fixture);
    const retrieval = new KnowledgeGraphRetrieval(fixture.database.open(), fixture.repositories, {
      now: () => Date.parse("2026-08-07T00:00:00.000Z"),
    });
    const atlasScope = fixture.corpus.scopes[1].scopeKey;
    const atlasApi = "ent_00000000-0000-4000-8000-000000000002";
    const authService = "ent_00000000-0000-4000-8000-000000000007";
    const dependency = retrieval.expandOneHop(atlasScope, atlasApi, {
      direction: "outgoing",
      limit: 1,
    });
    assert.equal(dependency.edges.length, 1);
    assert.equal(dependency.edges[0].claim.claimId, "clm_00000000-0000-4000-8000-000000000006");
    assert.equal(dependency.edges[0].neighborEntityId, authService);
    assert.equal(dependency.edges[0].direction, "outgoing");

    const currentDeployment = retrieval.expandOneHop(
      atlasScope,
      "ent_00000000-0000-4000-8000-000000000001",
      { direction: "outgoing" },
    );
    assert.equal(currentDeployment.edges.some((edge) => edge.claim.claimId === "clm_00000000-0000-4000-8000-000000000005"), false);
    const deploymentHistory = retrieval.expandOneHop(
      atlasScope,
      "ent_00000000-0000-4000-8000-000000000001",
      { direction: "outgoing", includeHistory: true },
    );
    assert.equal(deploymentHistory.edges.some((edge) => edge.claim.claimId === "clm_00000000-0000-4000-8000-000000000005"), true);
    assert.throws(
      () => retrieval.expandOneHop(fixture.corpus.scopes[2].scopeKey, atlasApi),
      (error) => error?.code === "not_found",
    );
  } finally {
    cleanupCorpusFixture(fixture);
  }
});

test("FTS search validates bounds and fails closed for cancellation/deadlines", () => {
  const fixture = createCorpusFixture();
  try {
    seedCorpusFixture(fixture);
    const retrieval = new KnowledgeGraphRetrieval(fixture.database.open(), fixture.repositories);
    const scope = fixture.corpus.scopes[1].scopeKey;
    assert.throws(
      () => retrieval.search(scope, { query: "x".repeat(513) }),
      (error) => error?.code === "invalid_query",
    );
    assert.throws(
      () => retrieval.search(scope, { query: "Atlas", limit: 21 }),
      (error) => error?.code === "invalid_query",
    );
    const controller = new AbortController();
    controller.abort();
    assert.throws(
      () => retrieval.search(scope, { query: "Atlas", signal: controller.signal }),
      (error) => error?.code === "cancelled",
    );
    assert.throws(
      () => retrieval.search(scope, { query: "Atlas", deadlineMs: 1 }),
      (error) => error?.code === "deadline_exceeded",
    );
  } finally {
    cleanupCorpusFixture(fixture);
  }
});

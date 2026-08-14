import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { statSync } from "node:fs";

import {
  cleanupKnowledgeGraphFixture,
  createKnowledgeGraphFixture,
  fixtureId,
} from "../tests/helpers/knowledge-graph-fixture.mjs";

const { default: installKnowledgeGraphExtension } = await import("../packages/knowledge-graph/index.ts");
const { KnowledgeGraphDatabase } = await import("../packages/knowledge-graph/database.ts");
const { KnowledgeGraphProposalService } = await import("../packages/knowledge-graph/proposal.ts");
const { KnowledgeGraphRetrieval, serializeSearchResponse } = await import("../packages/knowledge-graph/retrieval.ts");

const SCALE = 10_000;
const COLD_SAMPLES = 30;
const WARM_SAMPLES = 100;
const fixture = createKnowledgeGraphFixture();
const startupLatencies = [];
const writeLatencies = [];
const reviewLatencies = [];
const searchLatencies = [];

function percentile(values, percentileValue) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentileValue) - 1));
  return sorted[index];
}

function summary(values) {
  return {
    samples: values.length,
    min: Math.min(...values),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
  };
}

function createToolCapture() {
  const tools = [];
  installKnowledgeGraphExtension({
    registerTool(tool) { tools.push(tool); },
    registerCommand() {},
    on() {},
  });
  return tools;
}

try {
  for (let index = 0; index < COLD_SAMPLES; index += 1) {
    const database = new KnowledgeGraphDatabase({ paths: fixture.config });
    const startedAt = performance.now();
    database.open();
    startupLatencies.push(performance.now() - startedAt);
    database.close();
  }

  const subject = fixture.repositories.createEntity("project:" + "a".repeat(64), {
    entityId: fixtureId("ent_", 100),
    label: "Benchmark Subject",
    type: "project",
    status: "accepted",
  });
  for (let index = 0; index < SCALE; index += 1) {
    const number = index + 1_000;
    const startedAt = performance.now();
    const evidence = fixture.repositories.createEvidence("project:" + "a".repeat(64), {
      evidenceId: fixtureId("evd_", number),
      sourceKind: "user_statement",
      excerpt: `Benchmark evidence value-${index}.`,
      sourceObservedAt: 1_700_000_000_000,
      trustClass: "user",
    });
    const claim = fixture.repositories.createClaim("project:" + "a".repeat(64), {
      claimId: fixtureId("clm_", number),
      subjectEntityId: subject.entityId,
      predicate: "benchmark_value",
      object: { kind: "text", value: `value-${index}` },
      status: "accepted",
    });
    fixture.repositories.attachEvidence("project:" + "a".repeat(64), {
      claimId: claim.claimId,
      evidenceId: evidence.evidenceId,
      role: "primary",
    });
    writeLatencies.push(performance.now() - startedAt);
  }

  const retrieval = new KnowledgeGraphRetrieval(fixture.database.open(), fixture.repositories);
  let sampleResponse;
  for (let index = 0; index < WARM_SAMPLES; index += 1) {
    const startedAt = performance.now();
    sampleResponse = retrieval.search("project:" + "a".repeat(64), {
      query: `value-${index % SCALE}`,
      limit: 8,
    });
    searchLatencies.push(performance.now() - startedAt);
  }
  assert.equal(sampleResponse.insufficientEvidence, false);
  assert.equal(retrieval.search("project:" + "b".repeat(64), { query: "Benchmark Subject" }).results.length, 0);

  const proposals = new KnowledgeGraphProposalService(fixture.repositories);
  for (let index = 0; index < 30; index += 1) {
    const startedAt = performance.now();
    const submission = proposals.submit("project:" + "a".repeat(64), {
      actorType: "agent",
      subject: { entityId: subject.entityId },
      predicate: "benchmark_review",
      object: { kind: "text", value: `review-${index}` },
      evidence: [{ sourceKind: "user_statement", excerpt: `Benchmark review evidence ${index}.` }],
      idempotencyKey: `benchmark-review-${index}`,
    });
    proposals.review("project:" + "a".repeat(64), submission.proposal.proposalId, "accepted", { actorType: "user" });
    reviewLatencies.push(performance.now() - startedAt);
  }

  const tools = createToolCapture();
  const schemaPayload = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    promptSnippet: tool.promptSnippet,
    promptGuidelines: tool.promptGuidelines,
    parameters: tool.parameters,
  }));
  const schemaBytes = Buffer.byteLength(JSON.stringify(schemaPayload), "utf8");
  const outputBytes = Buffer.byteLength(serializeSearchResponse(sampleResponse), "utf8");
  const measurements = {
    startup: summary(startupLatencies),
    acceptedWrite: summary(writeLatencies),
    search: summary(searchLatencies),
    reviewedWrite: summary(reviewLatencies),
    databaseBytes: statSync(fixture.config.databasePath).size,
    scaleClaims: SCALE + 30,
    maximumSearchOutputBytes: outputBytes,
    toolSchemaBytes: schemaBytes,
    estimatedToolSchemaTokens: Math.ceil(schemaBytes / 4),
  };
  const thresholds = {
    searchP50Ms: measurements.search.p50 <= 50,
    searchP95Ms: measurements.search.p95 <= 200,
    reviewedWriteP50Ms: measurements.reviewedWrite.p50 <= 100,
    reviewedWriteP95Ms: measurements.reviewedWrite.p95 <= 500,
    startupP50Ms: measurements.startup.p50 <= 100,
    startupP95Ms: measurements.startup.p95 <= 250,
    outputBytes: measurements.maximumSearchOutputBytes <= 12 * 1024,
    // The post-MVP autonomous maintenance tool deliberately adds a complete
    // candidate schema. ADR-008 raises the all-active-tool budget while the
    // original 1,500-token MVP budget remains the read/review baseline.
    toolSchemaEstimatedTokens: measurements.estimatedToolSchemaTokens <= 4_000,
  };
  console.log(JSON.stringify({
    status: Object.values(thresholds).every(Boolean) ? "pass" : "measurement_thresholds_exceeded",
    node: process.version,
    scaleClaims: measurements.scaleClaims,
    thresholds,
    measurements,
  }, null, 2));
} finally {
  cleanupKnowledgeGraphFixture(fixture);
}

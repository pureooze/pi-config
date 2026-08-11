import assert from "node:assert/strict";
import test from "node:test";

const { KnowledgeGraphMaintenance } = await import("../../extensions/knowledge-graph/maintenance.ts");
const { KnowledgeGraphProposalService } = await import("../../extensions/knowledge-graph/proposal.ts");
const { KnowledgeGraphRetrieval } = await import("../../extensions/knowledge-graph/retrieval.ts");
const {
  GLOBAL_SCOPE,
  OTHER_PROJECT_SCOPE,
  PROJECT_SCOPE,
  cleanupKnowledgeGraphFixture,
  createKnowledgeGraphFixture,
  fixtureId,
  seedKnowledgeGraphFixture,
} = await import("../helpers/knowledge-graph-fixture.mjs");

function maintenanceFor(fixture) {
  return new KnowledgeGraphMaintenance(fixture.database.open(), fixture.repositories);
}

test("export and review remain scoped, and export names cannot escape private storage", () => {
  const fixture = createKnowledgeGraphFixture();
  try {
    const seeded = seedKnowledgeGraphFixture(fixture);
    const globalEntity = fixture.repositories.createEntity(GLOBAL_SCOPE, {
      entityId: fixtureId("ent_", 950),
      label: "Global Only Fact",
      type: "concept",
      status: "accepted",
    });
    const globalClaim = fixture.repositories.createClaim(GLOBAL_SCOPE, {
      claimId: fixtureId("clm_", 950),
      subjectEntityId: globalEntity.entityId,
      predicate: "is_global",
      object: { kind: "boolean", value: true },
      status: "accepted",
    });
    const maintenance = maintenanceFor(fixture);
    const projectSnapshot = maintenance.exportSnapshot([PROJECT_SCOPE]);
    assert.deepEqual(projectSnapshot.scopes.map((scope) => scope.scopeId), [PROJECT_SCOPE]);
    assert.equal(projectSnapshot.claims.some((claim) => claim.claimId === seeded.claim.claimId), true);
    assert.equal(projectSnapshot.claims.some((claim) => claim.claimId === globalClaim.claimId), false);
    assert.throws(
      () => maintenance.writeSnapshot("../escape.json"),
      (error) => error?.code === "invalid_export_name",
    );

    const proposalService = new KnowledgeGraphProposalService(fixture.repositories);
    const submission = proposalService.submit(PROJECT_SCOPE, {
      actorType: "agent",
      subject: { entityId: seeded.entity.entityId },
      predicate: "scoped_review",
      object: { kind: "text", value: "project-only" },
      evidence: [{ sourceKind: "user_statement", excerpt: "This proposal belongs to the project." }],
    });
    assert.throws(
      () => proposalService.review(OTHER_PROJECT_SCOPE, submission.proposal.proposalId, "accepted", { actorType: "user" }),
      (error) => error?.code === "not_found",
    );
    assert.equal(fixture.repositories.getProposal(PROJECT_SCOPE, submission.proposal.proposalId)?.status, "pending");
  } finally {
    cleanupKnowledgeGraphFixture(fixture);
  }
});

test("oversized proposals are rejected before persistence and high-degree expansion stays bounded", () => {
  const fixture = createKnowledgeGraphFixture();
  try {
    const proposalService = new KnowledgeGraphProposalService(fixture.repositories);
    assert.throws(
      () => proposalService.submit(PROJECT_SCOPE, {
        actorType: "agent",
        subject: { label: "Oversized Candidate", type: "concept" },
        predicate: "has_text",
        object: { kind: "text", value: "bounded" },
        evidence: [{ sourceKind: "user_statement", excerpt: "x".repeat(4_001) }],
      }),
      (error) => error?.code === "invalid_input",
    );
    assert.equal(fixture.repositories.listProposals(PROJECT_SCOPE).length, 0);
    assert.equal(fixture.repositories.listEvidence(PROJECT_SCOPE).length, 0);

    const center = fixture.repositories.createEntity(PROJECT_SCOPE, {
      entityId: fixtureId("ent_", 960),
      label: "High Degree Center",
      type: "concept",
      status: "accepted",
    });
    for (let index = 0; index < 25; index += 1) {
      const neighbor = fixture.repositories.createEntity(PROJECT_SCOPE, {
        entityId: fixtureId("ent_", 1_000 + index),
        label: `Neighbor ${index}`,
        type: "concept",
        status: "accepted",
      });
      fixture.repositories.createClaim(PROJECT_SCOPE, {
        claimId: fixtureId("clm_", 1_000 + index),
        subjectEntityId: center.entityId,
        predicate: "connects_to",
        object: { kind: "entity", entityId: neighbor.entityId },
        status: "accepted",
      });
    }
    const retrieval = new KnowledgeGraphRetrieval(fixture.database.open(), fixture.repositories);
    const expanded = retrieval.expandOneHop(PROJECT_SCOPE, center.entityId, { direction: "outgoing", limit: 3 });
    assert.equal(expanded.edges.length, 3);
    assert.equal(expanded.truncated, true);
  } finally {
    cleanupKnowledgeGraphFixture(fixture);
  }
});

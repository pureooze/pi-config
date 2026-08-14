import assert from "node:assert/strict";
import test from "node:test";

const { KnowledgeGraphAgentMaintenanceService } = await import("../../packages/knowledge-graph/agent-maintenance.ts");
const { KnowledgeGraphRetrieval } = await import("../../packages/knowledge-graph/retrieval.ts");
const {
  FIXTURE_NOW,
  PROJECT_SCOPE,
  cleanupKnowledgeGraphFixture,
  createKnowledgeGraphFixture,
  seedKnowledgeGraphFixture,
} = await import("../helpers/knowledge-graph-fixture.mjs");

test("autonomous insert uses the proposal path and accepts one evidence-backed claim", () => {
  const fixture = createKnowledgeGraphFixture();
  try {
    const service = new KnowledgeGraphAgentMaintenanceService(fixture.database.open(), fixture.repositories);
    const input = {
      operation: "insert",
      subject: { label: "Autonomous Project Fact", type: "concept" },
      predicate: "has_value",
      object: { kind: "text", value: "durable" },
      evidence: [{ sourceKind: "user_statement", excerpt: "The autonomous project fact is durable." }],
      idempotencyKey: "autonomous-insert-v1",
    };
    const first = service.execute(PROJECT_SCOPE, input, {
      sessionId: "agent-session",
      sessionEntryId: "agent-entry",
      toolCallId: "agent-tool",
      branchLeaf: "agent-leaf",
    });

    assert.equal(first.operation, "insert");
    assert.equal(first.status, "accepted");
    assert.equal(first.durable, true);
    assert.equal(fixture.repositories.getClaim(PROJECT_SCOPE, first.claimIds[0])?.status, "accepted");
    assert.equal(fixture.repositories.listClaims(PROJECT_SCOPE, "accepted").length, 1);

    const acceptance = fixture.repositories.listAuditEvents(PROJECT_SCOPE).find(
      (event) => event.action === "acceptance",
    );
    assert.equal(acceptance?.actorType, "agent");
    assert.equal(acceptance?.toolCallId, "agent-tool");

    const retry = service.execute(PROJECT_SCOPE, input, { sessionId: "retry-session" });
    assert.equal(retry.status, "already_known");
    assert.equal(retry.durable, true);
    assert.equal(fixture.repositories.listClaims(PROJECT_SCOPE, "accepted").length, 1);
  } finally {
    cleanupKnowledgeGraphFixture(fixture);
  }
});

test("autonomous update creates a replacement and preserves superseded history", () => {
  const fixture = createKnowledgeGraphFixture();
  try {
    const subject = fixture.repositories.createEntity(PROJECT_SCOPE, {
      entityId: "ent_00000000-0000-4000-8000-000000000801",
      label: "Autonomous Subject",
      type: "project",
      status: "accepted",
    });
    const priorEvidence = fixture.repositories.createEvidence(PROJECT_SCOPE, {
      evidenceId: "evd_00000000-0000-4000-8000-000000000801",
      sourceKind: "user_statement",
      excerpt: "The autonomous subject is beta.",
      trustClass: "user",
    });
    const prior = fixture.repositories.createClaim(PROJECT_SCOPE, {
      claimId: "clm_00000000-0000-4000-8000-000000000801",
      subjectEntityId: subject.entityId,
      predicate: "release_channel",
      object: { kind: "text", value: "beta" },
      status: "accepted",
    });
    fixture.repositories.attachEvidence(PROJECT_SCOPE, {
      claimId: prior.claimId,
      evidenceId: priorEvidence.evidenceId,
      role: "primary",
    });

    const service = new KnowledgeGraphAgentMaintenanceService(fixture.database.open(), fixture.repositories);
    const result = service.execute(PROJECT_SCOPE, {
      operation: "update",
      subject: { entityId: subject.entityId },
      predicate: "release_channel",
      object: { kind: "text", value: "stable" },
      supersedesClaimId: prior.claimId,
      supersessionReason: "The release channel changed to stable.",
      evidence: [{ sourceKind: "user_statement", excerpt: "The autonomous subject is stable." }],
    }, { sessionId: "update-session", toolCallId: "update-tool" });

    assert.equal(result.operation, "update");
    assert.equal(result.status, "accepted");
    assert.equal(fixture.repositories.getClaim(PROJECT_SCOPE, prior.claimId)?.status, "superseded");
    assert.equal(fixture.repositories.getClaim(PROJECT_SCOPE, prior.claimId)?.validTo, FIXTURE_NOW);
    const replacementId = result.claimIds[0];
    assert.equal(fixture.repositories.getClaim(PROJECT_SCOPE, replacementId)?.status, "accepted");
    assert.deepEqual(
      fixture.repositories.getSupersession(PROJECT_SCOPE, prior.claimId, replacementId),
      {
        scopeId: PROJECT_SCOPE,
        priorClaimId: prior.claimId,
        replacementClaimId: replacementId,
        reason: "The release channel changed to stable.",
        createdAt: FIXTURE_NOW,
      },
    );

    const retrieval = new KnowledgeGraphRetrieval(fixture.database.open(), fixture.repositories, { now: () => FIXTURE_NOW });
    assert.equal(retrieval.search(PROJECT_SCOPE, { query: "beta" }).results.some((item) => item.id === prior.claimId), false);
    const history = retrieval.get(PROJECT_SCOPE, { id: replacementId, view: "history" });
    assert.equal(history.history.some((item) => item.id === prior.claimId), true);
    assert.equal(fixture.repositories.listAuditEvents(PROJECT_SCOPE).some(
      (event) => event.action === "supersession" && event.actorType === "agent" && event.toolCallId === "update-tool",
    ), true);
  } finally {
    cleanupKnowledgeGraphFixture(fixture);
  }
});

test("autonomous delete removes one visible target, retains audit metadata, and scans its reason", () => {
  const fixture = createKnowledgeGraphFixture();
  try {
    const seeded = seedKnowledgeGraphFixture(fixture);
    const service = new KnowledgeGraphAgentMaintenanceService(fixture.database.open(), fixture.repositories);

    assert.throws(
      () => service.execute(PROJECT_SCOPE, {
        operation: "delete",
        targetId: seeded.claim.claimId,
        reason: "remove api_key=sk_live_12345678901234567890",
      }, { sessionId: "delete-session" }),
      (error) => error?.name === "KnowledgeGraphSecurityError",
    );
    assert.equal(fixture.repositories.getClaim(PROJECT_SCOPE, seeded.claim.claimId)?.status, "accepted");

    assert.throws(
      () => service.execute("project:unknown", {
        operation: "delete",
        targetId: seeded.claim.claimId,
        reason: "Remove the copied claim from the other scope.",
      }, { sessionId: "wrong-scope-session" }),
      (error) => error?.code === "invalid_scope",
    );

    const result = service.execute(PROJECT_SCOPE, {
      operation: "delete",
      targetId: seeded.claim.claimId,
      reason: "The claim is obsolete and should no longer be retained.",
    }, { sessionId: "delete-session", toolCallId: "delete-tool" });
    assert.equal(result.status, "deleted");
    assert.equal(result.affected.claims, 1);
    assert.equal(fixture.repositories.getClaim(PROJECT_SCOPE, seeded.claim.claimId), undefined);
    const audit = fixture.repositories.getAuditEvent(PROJECT_SCOPE, result.auditEventId);
    assert.equal(audit?.action, "forget");
    assert.equal(audit?.actorType, "agent");
    assert.equal(audit?.toolCallId, "delete-tool");
    assert.match(audit?.metadataJson ?? "", /obsolete/u);
  } finally {
    cleanupKnowledgeGraphFixture(fixture);
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { resolveKnowledgeGraphConfig } = await import("../../packages/knowledge-graph/config.ts");
const { KnowledgeGraphDatabase } = await import("../../packages/knowledge-graph/database.ts");
const {
  KnowledgeGraphRepositories,
  computeCandidateFingerprint,
  computeEvidenceHash,
} = await import("../../packages/knowledge-graph/repository.ts");

const projectScope = `project:${"a".repeat(64)}`;
const otherProjectScope = `project:${"b".repeat(64)}`;
const globalScope = "global";

function id(prefix, number) {
  return `${prefix}00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-knowledge-graph-repository-test-"));
  const config = resolveKnowledgeGraphConfig({
    cwd: join(root, "project"),
    projectRoot: join(root, "project"),
    projectTrusted: false,
    env: { PI_KNOWLEDGE_GRAPH_DIR: join(root, "store") },
    homeDirectory: join(root, "home"),
  });
  const database = new KnowledgeGraphDatabase({
    paths: config,
    now: () => 1_700_000_000_000,
  });
  const repositories = new KnowledgeGraphRepositories(database.open(), {
    now: () => 1_700_000_000_000,
    ...options,
  });
  repositories.registerScope({ scopeId: globalScope, kind: "global" });
  repositories.registerScope({
    scopeId: projectScope,
    kind: "project",
    projectRoot: "/work/atlas",
    identityPath: "/work/.git",
  });
  repositories.registerScope({ scopeId: otherProjectScope, kind: "project" });
  return { root, database, repositories };
}

function cleanup(fixtureValue) {
  fixtureValue.database.close();
  rmSync(fixtureValue.root, { recursive: true, force: true });
}

test("canonical records are scoped and exact IDs cannot cross visibility boundaries", () => {
  const fixtureValue = fixture();
  try {
    const { repositories } = fixtureValue;
    const globalEntity = repositories.createEntity(globalScope, {
      entityId: id("ent_", 1),
      label: "Shared service",
      type: "service",
      status: "accepted",
    });
    const projectEntity = repositories.createEntity(projectScope, {
      entityId: id("ent_", 2),
      label: "Atlas API",
      type: "service",
      status: "accepted",
    });

    assert.equal(repositories.getEntity(projectScope, globalEntity.entityId), undefined);
    assert.deepEqual(repositories.listEntities(projectScope).map((entity) => entity.entityId), [projectEntity.entityId]);
    assert.throws(
      () => repositories.createAlias(projectScope, {
        aliasId: id("als_", 1),
        entityId: globalEntity.entityId,
        alias: "shared",
      }),
      (error) => error?.code === "not_found",
    );

    const evidence = repositories.createEvidence(projectScope, {
      evidenceId: id("evd_", 1),
      sourceKind: "user_statement",
      excerpt: "The Atlas API owns the project boundary.",
      trustClass: "user",
      actorType: "user",
    });
    assert.equal(evidence.excerptHash, computeEvidenceHash(evidence.excerpt));

    const claim = repositories.createClaim(projectScope, {
      claimId: id("clm_", 1),
      subjectEntityId: projectEntity.entityId,
      predicate: "owns",
      object: { kind: "entity", entityId: projectEntity.entityId },
      status: "accepted",
    });
    const relation = repositories.attachEvidence(projectScope, {
      claimId: claim.claimId,
      evidenceId: evidence.evidenceId,
      role: "primary",
    });
    assert.equal(relation.evidence.evidenceId, evidence.evidenceId);
    assert.equal(repositories.listClaimEvidence(projectScope, claim.claimId).length, 1);

    assert.throws(
      () => repositories.createClaim(projectScope, {
        claimId: id("clm_", 2),
        subjectEntityId: projectEntity.entityId,
        predicate: "uses",
        object: { kind: "entity", entityId: globalEntity.entityId },
      }),
      (error) => error?.code === "not_found",
    );
    assert.equal(repositories.getClaim(otherProjectScope, claim.claimId), undefined);
    assert.equal(repositories.getEvidence(otherProjectScope, evidence.evidenceId), undefined);
  } finally {
    cleanup(fixtureValue);
  }
});

test("aliases, supersession links, and audit events retain scoped history", () => {
  const fixtureValue = fixture();
  try {
    const { repositories } = fixtureValue;
    const entity = repositories.createEntity(projectScope, {
      entityId: id("ent_", 10),
      label: "Atlas",
      type: "project",
      status: "accepted",
    });
    const alias = repositories.createAlias(projectScope, {
      aliasId: id("als_", 10),
      entityId: entity.entityId,
      alias: "Atlas Project",
      status: "accepted",
    });
    assert.equal(alias.normalizedAlias, "atlas project");
    assert.throws(
      () => repositories.createAlias(projectScope, {
        aliasId: id("als_", 11),
        entityId: entity.entityId,
        alias: "atlas project",
        status: "accepted",
      }),
      (error) => error?.code === "duplicate",
    );

    const prior = repositories.createClaim(projectScope, {
      claimId: id("clm_", 10),
      subjectEntityId: entity.entityId,
      predicate: "status",
      object: { kind: "text", value: "planned" },
      status: "accepted",
      validFrom: 1_700_000_000_000,
    });
    const replacement = repositories.createClaim(projectScope, {
      claimId: id("clm_", 11),
      subjectEntityId: entity.entityId,
      predicate: "status",
      object: { kind: "text", value: "active" },
      status: "accepted",
      validFrom: 1_700_000_001_000,
    });
    const link = repositories.supersedeClaim(projectScope, {
      priorClaimId: prior.claimId,
      replacementClaimId: replacement.claimId,
      reason: "The project status changed.",
    });
    assert.equal(link.priorClaimId, prior.claimId);
    assert.equal(repositories.getClaim(projectScope, prior.claimId)?.status, "superseded");
    assert.equal(repositories.getClaim(otherProjectScope, prior.claimId), undefined);

    const audit = repositories.appendAuditEvent(projectScope, {
      auditEventId: id("aud_", 10),
      actorType: "user",
      action: "supersession",
      targetType: "claim",
      targetId: replacement.claimId,
      beforeIds: [prior.claimId],
      afterIds: [replacement.claimId],
      metadataJson: JSON.stringify({ reason: "reviewed" }),
    });
    assert.deepEqual(audit.beforeIds, [prior.claimId]);
    assert.deepEqual(audit.afterIds, [replacement.claimId]);
    assert.equal(repositories.listAuditEvents(projectScope).length, 1);
    assert.equal(repositories.getAuditEvent(otherProjectScope, audit.auditEventId), undefined);
  } finally {
    cleanup(fixtureValue);
  }
});

test("injected IDs and clocks make evidence and proposal retries deterministic", () => {
  const generatedIds = [id("ent_", 50), id("evd_", 50), id("prp_", 50)];
  const generatedKinds = [];
  const fixtureValue = fixture({
    idFactory: {
      next(kind) {
        generatedKinds.push(kind);
        const generated = generatedIds.shift();
        if (generated === undefined) throw new Error("unexpected ID allocation");
        return generated;
      },
    },
  });
  try {
    const { repositories } = fixtureValue;
    const entity = repositories.createEntity(projectScope, {
      label: "Deterministic service",
      type: "service",
      status: "accepted",
    });
    const firstEvidence = repositories.createEvidence(projectScope, {
      sourceKind: "user_statement",
      excerpt: "The deterministic service is local.",
      trustClass: "user",
    });
    const retriedEvidence = repositories.createEvidence(projectScope, {
      sourceKind: "user_statement",
      excerpt: "The deterministic service is local.",
      trustClass: "user",
    });
    assert.equal(firstEvidence.evidenceId, id("evd_", 50));
    assert.equal(retriedEvidence.evidenceId, firstEvidence.evidenceId);
    assert.equal(repositories.listEvidence(projectScope).length, 1);

    const fingerprint = computeCandidateFingerprint(JSON.stringify({
      subjectEntityId: entity.entityId,
      predicate: "deployment",
      object: { kind: "text", value: "local" },
      evidenceId: firstEvidence.evidenceId,
    }));
    const firstProposal = repositories.createProposal(projectScope, {
      candidateFingerprint: fingerprint,
      idempotencyKey: "remember-deterministic-service",
      actorType: "agent",
      sessionId: "session-1",
    });
    const retriedProposal = repositories.createProposal(projectScope, {
      candidateFingerprint: fingerprint,
      idempotencyKey: "remember-deterministic-service",
      actorType: "agent",
      sessionId: "session-2",
    });
    assert.equal(firstProposal.proposalId, id("prp_", 50));
    assert.deepEqual(retriedProposal, firstProposal);
    assert.equal(repositories.listProposals(projectScope).length, 1);
    assert.equal(firstProposal.createdAt, 1_700_000_000_000);
    assert.deepEqual(generatedKinds, ["entity", "evidence", "proposal"]);

    assert.throws(
      () => repositories.createProposal(projectScope, {
        candidateFingerprint: computeCandidateFingerprint("different candidate"),
        idempotencyKey: "remember-deterministic-service",
        actorType: "agent",
      }),
      (error) => error?.code === "idempotency_conflict",
    );
  } finally {
    cleanup(fixtureValue);
  }
});

test("repository operations require a registered, valid scope", () => {
  const fixtureValue = fixture();
  try {
    const { repositories } = fixtureValue;
    assert.throws(
      () => repositories.listEntities("not-a-scope"),
      (error) => error?.code === "invalid_scope",
    );
    const unregisteredScope = `project:${"c".repeat(64)}`;
    assert.throws(
      () => repositories.listEntities(unregisteredScope),
      (error) => error?.code === "scope_not_found",
    );
    assert.throws(
      () => repositories.registerScope({ scopeId: globalScope, kind: "project" }),
      (error) => error?.code === "invalid_scope",
    );
  } finally {
    cleanup(fixtureValue);
  }
});

console.log("knowledge-graph repository fixtures loaded");

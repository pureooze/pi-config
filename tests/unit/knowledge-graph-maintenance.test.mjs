import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const { KnowledgeGraphMaintenance } = await import("../../packages/knowledge-graph/maintenance.ts");
const { KnowledgeGraphDeletionService, KnowledgeGraphDeletionError } = await import("../../packages/knowledge-graph/deletion.ts");
const {
  GLOBAL_SCOPE,
  OTHER_PROJECT_SCOPE,
  PROJECT_SCOPE,
  cleanupKnowledgeGraphFixture,
  createEmptyKnowledgeGraphFixture,
  createKnowledgeGraphFixture,
  seedKnowledgeGraphFixture,
} = await import("../helpers/knowledge-graph-fixture.mjs");

function maintenanceFor(fixture) {
  return new KnowledgeGraphMaintenance(fixture.database.open(), fixture.repositories);
}

test("logical export is deterministic, excludes FTS, and round-trips through restore", () => {
  const fixture = createKnowledgeGraphFixture();
  const restored = createEmptyKnowledgeGraphFixture();
  try {
    const seeded = seedKnowledgeGraphFixture(fixture);
    const maintenance = maintenanceFor(fixture);
    const first = maintenance.exportSnapshot();
    const second = maintenance.exportSnapshot();
    assert.deepEqual(first, second);
    assert.equal(Object.hasOwn(first, "searchDocuments"), false);
    assert.equal(first.claims.some((claim) => claim.claimId === seeded.claim.claimId), true);

    const exportPath = maintenance.writeSnapshot("roundtrip.json", [PROJECT_SCOPE]);
    assert.equal(statSync(exportPath).mode & 0o777, 0o600);
    const projectExport = JSON.parse(readFileSync(exportPath, "utf8"));
    assert.deepEqual(projectExport.scopes.map((scope) => scope.scopeId), [PROJECT_SCOPE]);
    assert.equal(projectExport.claims.some((claim) => claim.claimId === seeded.claim.claimId), true);

    const restore = maintenanceFor(restored);
    restore.restoreSnapshot(first);
    assert.equal(restored.repositories.getClaim(GLOBAL_SCOPE, seeded.claim.claimId)?.status, "accepted");
    assert.equal(restored.repositories.getEvidence(GLOBAL_SCOPE, seeded.evidence.evidenceId)?.excerpt, seeded.evidence.excerpt);
    assert.equal(restored.database.open().prepare(
      "SELECT COUNT(*) AS count FROM search_documents WHERE scope_id = ? AND record_id = ?",
    ).get(GLOBAL_SCOPE, seeded.claim.claimId).count, 1);
    assert.throws(() => restore.restoreSnapshot(first), (error) => error?.code === "restore_not_empty");
  } finally {
    cleanupKnowledgeGraphFixture(fixture);
    cleanupKnowledgeGraphFixture(restored);
  }
});

test("database backup is private and integrity-verified", () => {
  const fixture = createKnowledgeGraphFixture();
  try {
    seedKnowledgeGraphFixture(fixture);
    const backupPath = maintenanceFor(fixture).writeBackup("verified.sqlite");
    assert.equal(statSync(backupPath).mode & 0o777, 0o600);
    const backup = new DatabaseSync(backupPath);
    try {
      assert.equal(backup.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.equal(backup.prepare("PRAGMA foreign_key_check").all().length, 0);
    } finally {
      backup.close();
    }
    assert.throws(() => maintenanceFor(fixture).writeBackup("../unsafe.sqlite"), (error) => error?.code === "invalid_export_name");
  } finally {
    cleanupKnowledgeGraphFixture(fixture);
  }
});

test("forget removes one claim and orphaned evidence while retaining audit metadata", () => {
  const fixture = createKnowledgeGraphFixture();
  try {
    const seeded = seedKnowledgeGraphFixture(fixture);
    const deletion = new KnowledgeGraphDeletionService(fixture.database.open(), fixture.repositories);
    const preview = deletion.previewForget(PROJECT_SCOPE, seeded.claim.claimId);
    assert.deepEqual(preview.counts.claims, 1);
    assert.deepEqual(preview.counts.evidence, 1);
    assert.equal(preview.counts.searchDocuments, 2);

    const result = deletion.forget(PROJECT_SCOPE, seeded.claim.claimId, { actorType: "user", sessionId: "forget-session" });
    assert.equal(result.auditEvent.action, "forget");
    assert.equal(fixture.repositories.getClaim(PROJECT_SCOPE, seeded.claim.claimId), undefined);
    assert.equal(fixture.repositories.getEvidence(PROJECT_SCOPE, seeded.evidence.evidenceId), undefined);
    assert.equal(fixture.repositories.getEntity(PROJECT_SCOPE, seeded.entity.entityId)?.label, seeded.entity.label);
    assert.equal(fixture.repositories.listAuditEvents(PROJECT_SCOPE).some((event) => event.action === "forget"), true);
    assert.equal(fixture.database.open().prepare(
      "SELECT COUNT(*) AS count FROM search_documents WHERE scope_id = ? AND (doc_key = ? OR doc_key = ?)",
    ).get(PROJECT_SCOPE, `claim:${seeded.claim.claimId}`, `evidence:${seeded.evidence.evidenceId}`).count, 0);

    assert.throws(() => deletion.previewForget(PROJECT_SCOPE, fixtureId("clm_", 999)), (error) => error?.code === "not_found");
  } finally {
    cleanupKnowledgeGraphFixture(fixture);
  }
});

test("shared evidence is retained until its final claim is forgotten", () => {
  const fixture = createKnowledgeGraphFixture();
  try {
    const firstEntity = fixture.repositories.createEntity(PROJECT_SCOPE, {
      entityId: fixtureId("ent_", 801), label: "First", type: "concept", status: "accepted",
    });
    const secondEntity = fixture.repositories.createEntity(PROJECT_SCOPE, {
      entityId: fixtureId("ent_", 802), label: "Second", type: "concept", status: "accepted",
    });
    const evidence = fixture.repositories.createEvidence(PROJECT_SCOPE, {
      evidenceId: fixtureId("evd_", 801), sourceKind: "user_statement", excerpt: "Both claims share this evidence.", trustClass: "user",
    });
    const firstClaim = fixture.repositories.createClaim(PROJECT_SCOPE, {
      claimId: fixtureId("clm_", 801), subjectEntityId: firstEntity.entityId, predicate: "has_note", object: { kind: "text", value: "one" }, status: "accepted",
    });
    const secondClaim = fixture.repositories.createClaim(PROJECT_SCOPE, {
      claimId: fixtureId("clm_", 802), subjectEntityId: secondEntity.entityId, predicate: "has_note", object: { kind: "text", value: "two" }, status: "accepted",
    });
    fixture.repositories.attachEvidence(PROJECT_SCOPE, { claimId: firstClaim.claimId, evidenceId: evidence.evidenceId, role: "primary" });
    fixture.repositories.attachEvidence(PROJECT_SCOPE, { claimId: secondClaim.claimId, evidenceId: evidence.evidenceId, role: "primary" });
    const deletion = new KnowledgeGraphDeletionService(fixture.database.open(), fixture.repositories);

    assert.equal(deletion.previewForget(PROJECT_SCOPE, firstClaim.claimId).counts.evidence, 0);
    deletion.forget(PROJECT_SCOPE, firstClaim.claimId, { actorType: "user" });
    assert.notEqual(fixture.repositories.getEvidence(PROJECT_SCOPE, evidence.evidenceId), undefined);
    assert.equal(deletion.previewForget(PROJECT_SCOPE, secondClaim.claimId).counts.evidence, 1);
    deletion.forget(PROJECT_SCOPE, secondClaim.claimId, { actorType: "user" });
    assert.equal(fixture.repositories.getEvidence(PROJECT_SCOPE, evidence.evidenceId), undefined);
  } finally {
    cleanupKnowledgeGraphFixture(fixture);
  }
});

test("legacy scoped forget/purge retain redacted audit history", () => {
  const fixture = createKnowledgeGraphFixture();
  try {
    const seeded = seedKnowledgeGraphFixture(fixture);
    const globalEntity = fixture.repositories.createEntity(GLOBAL_SCOPE, {
      entityId: fixtureId("ent_", 901), label: "Global Fact", type: "concept", status: "accepted",
    });
    const globalClaim = fixture.repositories.createClaim(GLOBAL_SCOPE, {
      claimId: fixtureId("clm_", 901), subjectEntityId: globalEntity.entityId, predicate: "is_global", object: { kind: "boolean", value: true }, status: "accepted",
    });
    const deletion = new KnowledgeGraphDeletionService(fixture.database.open(), fixture.repositories);

    assert.throws(() => deletion.previewForget(PROJECT_SCOPE, globalClaim.claimId), (error) => error?.code === "not_found");
    const result = deletion.purge(PROJECT_SCOPE, { actorType: "user", sessionId: "purge-session" });
    assert.equal(result.preview.operation, "purge");
    assert.equal(fixture.repositories.listEntities(PROJECT_SCOPE).length, 0);
    assert.equal(fixture.repositories.listClaims(PROJECT_SCOPE).length, 0);
    assert.equal(fixture.repositories.listEvidence(PROJECT_SCOPE).length, 0);
    assert.equal(fixture.repositories.getClaim(GLOBAL_SCOPE, globalClaim.claimId)?.claimId, globalClaim.claimId);
    assert.equal(fixture.repositories.getClaim(OTHER_PROJECT_SCOPE, seeded.claim.claimId), undefined);
    assert.equal(fixture.repositories.listAuditEvents(PROJECT_SCOPE).some((event) => event.action === "purge"), true);
    assert.equal(fixture.database.open().prepare(
      "SELECT COUNT(*) AS count FROM search_documents WHERE scope_id = ?",
    ).get(PROJECT_SCOPE).count, 0);
  } finally {
    cleanupKnowledgeGraphFixture(fixture);
  }
});

test("forgetting referenced evidence fails closed instead of breaking claim provenance", () => {
  const fixture = createKnowledgeGraphFixture();
  try {
    const seeded = seedKnowledgeGraphFixture(fixture);
    const deletion = new KnowledgeGraphDeletionService(fixture.database.open(), fixture.repositories);
    assert.throws(
      () => deletion.forget(PROJECT_SCOPE, seeded.evidence.evidenceId, { actorType: "user" }),
      (error) => error instanceof KnowledgeGraphDeletionError && error.code === "shared_evidence",
    );
    assert.equal(fixture.repositories.getEvidence(PROJECT_SCOPE, seeded.evidence.evidenceId)?.excerpt, seeded.evidence.excerpt);
  } finally {
    cleanupKnowledgeGraphFixture(fixture);
  }
});

function fixtureId(prefix, number) {
  return `${prefix}00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

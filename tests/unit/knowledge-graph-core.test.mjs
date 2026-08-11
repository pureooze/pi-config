import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

const { KnowledgeGraphRepositories } = await import("../../extensions/knowledge-graph/repository.ts");
const { KnowledgeGraphDatabase } = await import("../../extensions/knowledge-graph/database.ts");
const { MVP_MIGRATIONS } = await import("../../extensions/knowledge-graph/migrations.ts");
const {
  FIXTURE_NOW,
  OTHER_PROJECT_SCOPE,
  PROJECT_SCOPE,
  cleanupKnowledgeGraphFixture,
  createKnowledgeGraphFixture,
  fixtureId,
  seedKnowledgeGraphFixture,
} = await import("../helpers/knowledge-graph-fixture.mjs");

test("seeded canonical records survive restart in an isolated store", () => {
  const fixture = createKnowledgeGraphFixture();
  let reopened;
  try {
    const seeded = seedKnowledgeGraphFixture(fixture);
    assert.equal(fixture.config.databasePath.startsWith(fixture.root), true);
    assert.equal(fixture.repositories.getClaim(PROJECT_SCOPE, seeded.claim.claimId)?.status, "accepted");
    fixture.database.checkIntegrity();

    fixture.database.close();
    reopened = new KnowledgeGraphDatabase({ paths: fixture.config, now: () => FIXTURE_NOW });
    const repositories = new KnowledgeGraphRepositories(reopened.open(), { now: () => FIXTURE_NOW });

    assert.equal(repositories.getEntity(PROJECT_SCOPE, seeded.entity.entityId)?.label, "Atlas API");
    assert.equal(repositories.getAlias(PROJECT_SCOPE, seeded.alias.aliasId)?.entityId, seeded.entity.entityId);
    assert.equal(repositories.getEvidence(PROJECT_SCOPE, seeded.evidence.evidenceId)?.sourceObservedAt, FIXTURE_NOW - 1_000);
    assert.equal(repositories.getProposal(PROJECT_SCOPE, seeded.proposal.proposalId)?.status, "pending");
    assert.equal(repositories.getAuditEvent(PROJECT_SCOPE, seeded.audit.auditEventId)?.targetId, seeded.proposal.proposalId);
    assert.equal(repositories.getClaim(OTHER_PROJECT_SCOPE, seeded.claim.claimId), undefined);
    reopened.checkIntegrity();
  } finally {
    reopened?.close();
    cleanupKnowledgeGraphFixture(fixture);
  }
});

test("schema upgrades preserve canonical fixtures and leave a verified pre-upgrade backup", () => {
  const fixture = createKnowledgeGraphFixture();
  let upgraded;
  try {
    const seeded = seedKnowledgeGraphFixture(fixture);
    fixture.database.close();
    upgraded = new KnowledgeGraphDatabase({
      paths: fixture.config,
      migrations: [
        ...MVP_MIGRATIONS,
        {
          version: 8,
          name: "core_upgrade_probe",
          up(database) {
            database.exec("CREATE TABLE core_upgrade_probe (value TEXT NOT NULL)");
          },
        },
      ],
      backupPathFactory: () => join(fixture.config.backupDirectory, "core-upgrade.sqlite"),
    });
    const connection = upgraded.open();
    const repositories = new KnowledgeGraphRepositories(connection, { now: () => FIXTURE_NOW });
    assert.equal(repositories.getClaim(PROJECT_SCOPE, seeded.claim.claimId)?.status, "accepted");
    assert.equal(repositories.getEvidence(PROJECT_SCOPE, seeded.evidence.evidenceId)?.excerpt, seeded.evidence.excerpt);
    assert.equal(connection.prepare("SELECT value FROM core_upgrade_probe").get(), undefined);
    assert.equal(upgraded.lastMigrationBackupPath, join(fixture.config.backupDirectory, "core-upgrade.sqlite"));
    upgraded.checkIntegrity();
  } finally {
    upgraded?.close();
    cleanupKnowledgeGraphFixture(fixture);
  }
});

test("canonical supersession transactions roll back completely on failure", () => {
  const fixture = createKnowledgeGraphFixture();
  try {
    const seeded = seedKnowledgeGraphFixture(fixture);
    const replacement = fixture.repositories.createClaim(PROJECT_SCOPE, {
      claimId: fixtureId("clm_", 2),
      subjectEntityId: seeded.entity.entityId,
      predicate: "is.service_boundary",
      object: { kind: "boolean", value: false },
      status: "accepted",
    });
    fixture.database.open().exec(`
      CREATE TRIGGER reject_supersession_update
      BEFORE UPDATE OF status ON claims
      WHEN NEW.status = 'superseded'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic supersession failure');
      END;
    `);

    assert.throws(
      () => fixture.repositories.supersedeClaim(PROJECT_SCOPE, {
        priorClaimId: seeded.claim.claimId,
        replacementClaimId: replacement.claimId,
        reason: "synthetic rollback",
      }),
      (error) => error?.code === "storage_error",
    );
    assert.equal(fixture.repositories.getClaim(PROJECT_SCOPE, seeded.claim.claimId)?.status, "accepted");
    assert.equal(
      fixture.repositories.getSupersession(PROJECT_SCOPE, seeded.claim.claimId, replacement.claimId),
      undefined,
    );
    fixture.database.checkIntegrity();
  } finally {
    cleanupKnowledgeGraphFixture(fixture);
  }
});

test("interrupted repository transactions leave no partial canonical writes", () => {
  const fixture = createKnowledgeGraphFixture();
  try {
    const entity = fixture.repositories.createEntity(PROJECT_SCOPE, {
      entityId: fixtureId("ent_", 3),
      label: "Transactional Entity",
      type: "concept",
      status: "accepted",
    });
    assert.throws(
      () => fixture.repositories.transaction(() => {
        const evidence = fixture.repositories.createEvidence(PROJECT_SCOPE, {
          evidenceId: fixtureId("evd_", 3),
          sourceKind: "user_statement",
          excerpt: "This interrupted write must not persist.",
          trustClass: "user",
        });
        const claim = fixture.repositories.createClaim(PROJECT_SCOPE, {
          claimId: fixtureId("clm_", 3),
          subjectEntityId: entity.entityId,
          predicate: "must_rollback",
          object: { kind: "text", value: "temporary" },
          status: "accepted",
        });
        fixture.repositories.attachEvidence(PROJECT_SCOPE, {
          claimId: claim.claimId,
          evidenceId: evidence.evidenceId,
          role: "primary",
        });
        throw new Error("synthetic interrupted write");
      }),
      /synthetic interrupted write/u,
    );
    assert.equal(fixture.repositories.getClaim(PROJECT_SCOPE, fixtureId("clm_", 3)), undefined);
    assert.equal(fixture.repositories.getEvidence(PROJECT_SCOPE, fixtureId("evd_", 3)), undefined);
    assert.equal(fixture.database.open().prepare(
      "SELECT COUNT(*) AS count FROM search_documents WHERE scope_id = ? AND (doc_key = ? OR doc_key = ?)",
    ).get(PROJECT_SCOPE, `claim:${fixtureId("clm_", 3)}`, `evidence:${fixtureId("evd_", 3)}`).count, 0);
    fixture.database.checkIntegrity();
  } finally {
    cleanupKnowledgeGraphFixture(fixture);
  }
});

test("core fixtures reject duplicates, foreign-scope links, and integrity violations", () => {
  const fixture = createKnowledgeGraphFixture();
  try {
    const seeded = seedKnowledgeGraphFixture(fixture);
    assert.throws(
      () => fixture.repositories.createEntity(PROJECT_SCOPE, {
        entityId: seeded.entity.entityId,
        label: "Duplicate Atlas API",
        type: "service",
      }),
      (error) => error?.code === "duplicate",
    );

    const unattachedEvidence = fixture.repositories.createEvidence(PROJECT_SCOPE, {
      evidenceId: fixtureId("evd_", 2),
      sourceKind: "file",
      excerpt: "This evidence is intentionally unattached.",
      trustClass: "local_file",
    });
    assert.throws(
      () => fixture.database.open().prepare(
        `INSERT INTO claim_evidence(scope_id, claim_id, evidence_id, evidence_role)
         VALUES (?, ?, ?, ?)`,
      ).run(OTHER_PROJECT_SCOPE, seeded.claim.claimId, unattachedEvidence.evidenceId, "supporting"),
      /FOREIGN KEY/u,
    );
    assert.equal(fixture.repositories.listClaimEvidence(PROJECT_SCOPE, seeded.claim.claimId).length, 1);
    assert.equal(fixture.repositories.listClaims(OTHER_PROJECT_SCOPE).length, 0);
    fixture.database.checkIntegrity();
  } finally {
    cleanupKnowledgeGraphFixture(fixture);
  }
});

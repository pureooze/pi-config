import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const { resolveKnowledgeGraphConfig } = await import("../../extensions/knowledge-graph/config.ts");
const { KnowledgeGraphDatabase } = await import("../../extensions/knowledge-graph/database.ts");
const { KnowledgeGraphRepositories } = await import("../../extensions/knowledge-graph/repository.ts");
const { MVP_MIGRATIONS } = await import("../../extensions/knowledge-graph/migrations.ts");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-knowledge-graph-database-test-"));
  const config = resolveKnowledgeGraphConfig({
    cwd: join(root, "project"),
    projectRoot: join(root, "project"),
    projectTrusted: false,
    env: { PI_KNOWLEDGE_GRAPH_DIR: join(root, "store") },
    homeDirectory: join(root, "home"),
  });
  return { root, config };
}

function migration(version, name, up) {
  return { version, name, up };
}

test("database opens lazily, applies metadata migration, configures pragmas, and closes idempotently", () => {
  const { root, config } = fixture();
  try {
    const database = new KnowledgeGraphDatabase({
      paths: config,
      now: () => 1_700_000_000_000,
    });
    assert.equal(database.isOpen, false);
    assert.equal(existsSync(config.rootDirectory), false);

    const connection = database.open();
    assert.equal(database.isOpen, true);
    assert.equal(database.getSchemaVersion(), 8);
    assert.equal(connection.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    assert.equal(connection.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.equal(connection.prepare("PRAGMA busy_timeout").get().timeout, 1000);
    assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 8);
    assert.equal(connection.prepare("SELECT value FROM schema_meta WHERE key = ?").get("created_at").value, "1700000000000");

    database.close();
    database.close();
    assert.equal(database.isOpen, false);
    database.open();
    assert.equal(database.getSchemaVersion(), 8);
    database.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy project knowledge migrates into the shared scope with a verified backup", () => {
  const { root, config } = fixture();
  const projectScope = `project:${"a".repeat(64)}`;
  let legacy;
  let upgraded;
  try {
    legacy = new KnowledgeGraphDatabase({
      paths: config,
      now: () => 1_700_000_000_000,
      migrations: MVP_MIGRATIONS.slice(0, -1),
    });
    const legacyRepositories = new KnowledgeGraphRepositories(legacy.open(), { now: () => 1_700_000_000_000 });
    legacyRepositories.registerScope({ scopeId: "global", kind: "global" });
    legacyRepositories.registerScope({ scopeId: projectScope, kind: "project", projectRoot: "/work/project", identityPath: "/work/.git" });
    const entity = legacyRepositories.createEntity(projectScope, {
      entityId: "ent_00000000-0000-4000-8000-000000000001",
      label: "Shared migration service",
      type: "service",
      status: "accepted",
    });
    const evidence = legacyRepositories.createEvidence(projectScope, {
      evidenceId: "evd_00000000-0000-4000-8000-000000000001",
      sourceKind: "user_statement",
      excerpt: "The migration service is shared across working directories.",
      trustClass: "user",
    });
    const claim = legacyRepositories.createClaim(projectScope, {
      claimId: "clm_00000000-0000-4000-8000-000000000001",
      subjectEntityId: entity.entityId,
      predicate: "is_shared",
      object: { kind: "boolean", value: true },
      status: "accepted",
    });
    legacyRepositories.attachEvidence(projectScope, { claimId: claim.claimId, evidenceId: evidence.evidenceId });
    legacy.close();

    const backupPath = join(config.backupDirectory, "shared-scope-migration.sqlite");
    upgraded = new KnowledgeGraphDatabase({
      paths: config,
      now: () => 1_700_000_000_100,
      backupPathFactory: () => backupPath,
    });
    const connection = upgraded.open();
    const repositories = new KnowledgeGraphRepositories(connection, { now: () => 1_700_000_000_100 });
    assert.equal(repositories.getClaim("global", claim.claimId)?.status, "accepted");
    assert.equal(repositories.getEvidence("global", evidence.evidenceId)?.excerpt, evidence.excerpt);
    assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM scopes WHERE kind = 'project'").get().count, 0);
    assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM search_documents WHERE scope_id = 'global' AND record_id = ?").get(claim.claimId).count, 1);
    assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM search_documents WHERE scope_id <> 'global'").get().count, 0);
    assert.equal(upgraded.getSchemaVersion(), 8);
    assert.equal(upgraded.lastMigrationBackupPath, backupPath);
    const backup = new DatabaseSync(backupPath);
    assert.equal(backup.prepare("PRAGMA user_version").get().user_version, 7);
    assert.equal(backup.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    backup.close();
  } finally {
    legacy?.close();
    upgraded?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrations are ordered and create a verified pre-migration backup", () => {
  const { root, config } = fixture();
  try {
    const initial = new KnowledgeGraphDatabase({ paths: config, now: () => 1_700_000_000_000 });
    initial.open();
    initial.close();

    const migrationNine = migration(9, "add_migration_probe", (database) => {
      database.exec("CREATE TABLE migration_probe (value TEXT NOT NULL)");
      database.prepare("INSERT INTO migration_probe(value) VALUES (?)").run("version-two");
    });
    const backupPath = join(config.backupDirectory, "migration-v8-v9.sqlite");
    const upgraded = new KnowledgeGraphDatabase({
      paths: config,
      now: () => 1_700_000_000_100,
      migrations: [...MVP_MIGRATIONS, migrationNine],
      backupPathFactory: () => backupPath,
    });
    const connection = upgraded.open();
    assert.equal(upgraded.getSchemaVersion(), 9);
    assert.equal(connection.prepare("SELECT value FROM migration_probe").get().value, "version-two");
    assert.equal(upgraded.lastMigrationBackupPath, backupPath);
    assert.equal(statSync(backupPath).mode & 0o777, 0o600);

    const backup = new DatabaseSync(backupPath);
    assert.equal(backup.prepare("PRAGMA user_version").get().user_version, 8);
    assert.equal(backup.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 8);
    assert.throws(() => backup.prepare("SELECT * FROM migration_probe").all());
    backup.close();
    upgraded.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed migrations roll back and leave the original schema recoverable", () => {
  const { root, config } = fixture();
  try {
    const initial = new KnowledgeGraphDatabase({ paths: config, now: () => 1_700_000_000_000 });
    initial.open();
    initial.close();

    const failedMigration = migration(9, "failed_probe", (database) => {
      database.exec("CREATE TABLE failed_probe (value TEXT NOT NULL)");
      throw new Error("synthetic migration failure");
    });
    const failed = new KnowledgeGraphDatabase({
      paths: config,
      migrations: [...MVP_MIGRATIONS, failedMigration],
      backupPathFactory: () => join(config.backupDirectory, "failed-migration.sqlite"),
    });
    assert.throws(() => failed.open(), /synthetic migration failure/);
    assert.equal(failed.isOpen, false);

    const recovered = new KnowledgeGraphDatabase({ paths: config });
    const connection = recovered.open();
    assert.equal(recovered.getSchemaVersion(), 8);
    assert.throws(() => connection.prepare("SELECT * FROM failed_probe").all());
    recovered.checkIntegrity();
    recovered.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("foreign keys are enforced by the lifecycle connection", () => {
  const { root, config } = fixture();
  try {
    const database = new KnowledgeGraphDatabase({ paths: config });
    const connection = database.open();
    connection.exec("CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id))");
    assert.throws(() => connection.prepare("INSERT INTO child(parent_id) VALUES (?)").run(42), /FOREIGN KEY/i);
    database.checkIntegrity();
    database.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

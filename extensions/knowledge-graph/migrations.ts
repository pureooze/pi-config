import type { DatabaseSync } from "node:sqlite";

export interface MigrationContext {
  readonly now: () => number;
}

export interface KnowledgeGraphMigration {
  readonly version: number;
  readonly name: string;
  readonly up: (database: DatabaseSync, context: MigrationContext) => void;
}

export const MVP_MIGRATIONS: readonly KnowledgeGraphMigration[] = Object.freeze([
  {
    version: 1,
    name: "bootstrap_metadata",
    up(database, context) {
      database.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        );
        CREATE TABLE schema_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      const now = String(context.now());
      database
        .prepare("INSERT INTO schema_meta(key, value) VALUES (?, ?), (?, ?)")
        .run("created_at", now, "updated_at", now);
    },
  },
]);

export function getCurrentSchemaVersion(database: DatabaseSync): number {
  const pragmaVersion = readIntegerPragma(database, "user_version");
  const hasMigrationTable = tableExists(database, "schema_migrations");
  if (!hasMigrationTable) {
    if (pragmaVersion !== 0) {
      throw new Error("SQLite user_version is set but schema_migrations is missing.");
    }
    return 0;
  }

  const rows = database
    .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
    .all();
  if (rows.length === 0) {
    throw new Error("schema_migrations exists without an applied migration.");
  }

  let expectedVersion = 1;
  for (const row of rows) {
    const version = row.version;
    if (typeof version !== "number" || version !== expectedVersion) {
      throw new Error("schema_migrations contains a non-contiguous version sequence.");
    }
    if (typeof row.name !== "string" || row.name.length === 0) {
      throw new Error("schema_migrations contains an invalid migration name.");
    }
    expectedVersion += 1;
  }

  const currentVersion = expectedVersion - 1;
  if (pragmaVersion !== currentVersion) {
    throw new Error("SQLite user_version does not match schema_migrations.");
  }
  return currentVersion;
}

export function applyMigrations(
  database: DatabaseSync,
  migrations: readonly KnowledgeGraphMigration[],
  context: MigrationContext,
): number {
  validateMigrationList(migrations);
  const currentVersion = getCurrentSchemaVersion(database);
  const latestVersion = migrations.length === 0 ? 0 : migrations[migrations.length - 1].version;
  if (currentVersion > latestVersion) {
    throw new Error(`Database schema version ${currentVersion} is newer than supported version ${latestVersion}.`);
  }

  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      migration.up(database, context);
      database
        .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, context.now());
      database.exec(`PRAGMA user_version = ${migration.version}`);
      if (tableExists(database, "schema_meta")) {
        database
          .prepare("INSERT INTO schema_meta(key, value) VALUES ('updated_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(String(context.now()));
      }
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the migration failure; the connection is closed by the caller.
      }
      throw error;
    }
  }

  return getCurrentSchemaVersion(database);
}

function validateMigrationList(migrations: readonly KnowledgeGraphMigration[]): void {
  let expectedVersion = 1;
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version !== expectedVersion) {
      throw new Error("Migrations must be a contiguous sequence starting at version 1.");
    }
    if (!migration.name || !/^[a-z][a-z0-9_]{1,63}$/u.test(migration.name)) {
      throw new Error(`Invalid migration name for version ${migration.version}.`);
    }
    expectedVersion += 1;
  }
}

function tableExists(database: DatabaseSync, tableName: string): boolean {
  const row = database
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return row?.present === 1;
}

function readIntegerPragma(database: DatabaseSync, name: string): number {
  const row = database.prepare(`PRAGMA ${name}`).get();
  const value = row?.[name];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`SQLite pragma ${name} did not return a non-negative integer.`);
  }
  return value;
}

import { chmodSync, lstatSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  assertPrivateFile,
  assertPrivateDirectory,
  prepareStoragePaths,
  type StoragePaths,
} from "./config.ts";
import {
  applyMigrations,
  getCurrentSchemaVersion,
  MVP_MIGRATIONS,
  type KnowledgeGraphMigration,
} from "./migrations.ts";

const DEFAULT_BUSY_TIMEOUT_MS = 1_000;
const MAX_BUSY_TIMEOUT_MS = 10_000;

export interface KnowledgeGraphDatabaseOptions {
  readonly paths: StoragePaths;
  readonly now?: () => number;
  readonly busyTimeoutMs?: number;
  readonly migrations?: readonly KnowledgeGraphMigration[];
  readonly backupPathFactory?: (fromVersion: number, toVersion: number) => string;
}

export class KnowledgeGraphDatabaseError extends Error {
  readonly code:
    | "invalid_busy_timeout"
    | "unsupported_schema"
    | "pragma_mismatch"
    | "integrity_check_failed"
    | "foreign_key_check_failed"
    | "invalid_backup_path";

  constructor(
    code: KnowledgeGraphDatabaseError["code"],
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeGraphDatabaseError";
    this.code = code;
  }
}

export class KnowledgeGraphDatabase {
  private readonly options: Required<Pick<KnowledgeGraphDatabaseOptions, "now" | "busyTimeoutMs" | "migrations">> & KnowledgeGraphDatabaseOptions;
  private connection: DatabaseSync | undefined;
  private migrationBackupPath: string | undefined;

  constructor(options: KnowledgeGraphDatabaseOptions) {
    const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > MAX_BUSY_TIMEOUT_MS) {
      throw new KnowledgeGraphDatabaseError(
        "invalid_busy_timeout",
        `Busy timeout must be an integer from 1 through ${MAX_BUSY_TIMEOUT_MS} milliseconds.`,
      );
    }
    this.options = {
      ...options,
      now: options.now ?? Date.now,
      busyTimeoutMs,
      migrations: options.migrations ?? MVP_MIGRATIONS,
    };
  }

  get isOpen(): boolean {
    return this.connection !== undefined;
  }

  get lastMigrationBackupPath(): string | undefined {
    return this.migrationBackupPath;
  }

  open(): DatabaseSync {
    if (this.connection) return this.connection;

    prepareStoragePaths(this.options.paths);
    const database = new DatabaseSync(this.options.paths.databasePath);
    try {
      configureConnection(database, this.options.busyTimeoutMs);
      const currentVersion = getCurrentSchemaVersion(database);
      const latestVersion = getLatestVersion(this.options.migrations);
      if (currentVersion > latestVersion) {
        throw new KnowledgeGraphDatabaseError(
          "unsupported_schema",
          `Database schema version ${currentVersion} is newer than supported version ${latestVersion}.`,
        );
      }
      if (currentVersion > 0 && currentVersion < latestVersion) {
        this.migrationBackupPath = this.createMigrationBackup(database, currentVersion, latestVersion);
      }
      applyMigrations(database, this.options.migrations, { now: this.options.now });
      assertDatabaseIntegrity(database);
      this.connection = database;
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  close(): void {
    const database = this.connection;
    this.connection = undefined;
    if (database) database.close();
  }

  getSchemaVersion(): number {
    return getCurrentSchemaVersion(this.open());
  }

  checkIntegrity(): void {
    assertDatabaseIntegrity(this.open());
  }

  private createMigrationBackup(
    database: DatabaseSync,
    fromVersion: number,
    toVersion: number,
  ): string {
    const backupPath = this.options.backupPathFactory?.(fromVersion, toVersion)
      ?? join(
        this.options.paths.backupDirectory,
        `pre-migration-v${fromVersion}-to-v${toVersion}-${this.options.now()}-${randomUUID()}.sqlite`,
      );
    const absoluteBackupPath = resolve(backupPath);
    if (!isAbsolute(backupPath) || dirname(absoluteBackupPath) !== resolve(this.options.paths.backupDirectory)) {
      throw new KnowledgeGraphDatabaseError(
        "invalid_backup_path",
        "Migration backup must be an absolute path inside the private backup directory.",
      );
    }
    if (pathExists(absoluteBackupPath)) {
      throw new KnowledgeGraphDatabaseError("invalid_backup_path", "Migration backup destination already exists.");
    }

    assertPrivateDirectory(this.options.paths.backupDirectory);
    const escapedPath = absoluteBackupPath.replaceAll("'", "''");
    database.exec(`VACUUM INTO '${escapedPath}'`);
    chmodSync(absoluteBackupPath, 0o600);
    assertPrivateFile(absoluteBackupPath);
    return absoluteBackupPath;
  }
}

function configureConnection(database: DatabaseSync, busyTimeoutMs: number): void {
  database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  const foreignKeys = database.prepare("PRAGMA foreign_keys").get()?.foreign_keys;
  const journalMode = database.prepare("PRAGMA journal_mode").get()?.journal_mode;
  if (foreignKeys !== 1 || journalMode !== "wal") {
    throw new KnowledgeGraphDatabaseError(
      "pragma_mismatch",
      "SQLite did not enable the required foreign-key and WAL settings.",
    );
  }
  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  const timeout = database.prepare("PRAGMA busy_timeout").get()?.timeout;
  if (timeout !== busyTimeoutMs) {
    throw new KnowledgeGraphDatabaseError("pragma_mismatch", "SQLite did not apply the configured busy timeout.");
  }
}

function assertDatabaseIntegrity(database: DatabaseSync): void {
  const integrity = database.prepare("PRAGMA integrity_check").get()?.integrity_check;
  if (integrity !== "ok") {
    throw new KnowledgeGraphDatabaseError("integrity_check_failed", "SQLite integrity check failed.");
  }
  const foreignKeyErrors = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyErrors.length > 0) {
    throw new KnowledgeGraphDatabaseError("foreign_key_check_failed", "SQLite foreign-key check failed.");
  }
}

function getLatestVersion(migrations: readonly KnowledgeGraphMigration[]): number {
  return migrations.length === 0 ? 0 : migrations[migrations.length - 1].version;
}

function pathExists(targetPath: string): boolean {
  try {
    lstatSync(targetPath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

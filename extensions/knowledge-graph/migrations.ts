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
  {
    version: 2,
    name: "canonical_graph",
    up(database) {
      database.exec(`
        CREATE TABLE scopes (
          scope_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('global', 'project')),
          project_root TEXT,
          identity_path TEXT,
          created_at INTEGER NOT NULL CHECK (created_at >= 0),
          CHECK (
            (kind = 'global' AND scope_id = 'global' AND project_root IS NULL AND identity_path IS NULL)
            OR (kind = 'project' AND scope_id LIKE 'project:%')
          )
        ) STRICT;

        CREATE TABLE entities (
          entity_id TEXT PRIMARY KEY,
          scope_id TEXT NOT NULL,
          label TEXT NOT NULL,
          normalized_label TEXT NOT NULL,
          entity_type TEXT NOT NULL CHECK (entity_type IN (
            'person', 'project', 'repository', 'service', 'tool',
            'organization', 'location', 'preference', 'concept', 'other'
          )),
          status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected')),
          created_at INTEGER NOT NULL CHECK (created_at >= 0),
          reviewed_at INTEGER,
          proposal_id TEXT,
          UNIQUE (entity_id, scope_id),
          FOREIGN KEY (scope_id) REFERENCES scopes(scope_id)
        ) STRICT;

        CREATE TABLE aliases (
          alias_id TEXT PRIMARY KEY,
          scope_id TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          alias TEXT NOT NULL,
          normalized_alias TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected')),
          created_at INTEGER NOT NULL CHECK (created_at >= 0),
          reviewed_at INTEGER,
          proposal_id TEXT,
          UNIQUE (alias_id, scope_id),
          FOREIGN KEY (scope_id) REFERENCES scopes(scope_id),
          FOREIGN KEY (entity_id, scope_id) REFERENCES entities(entity_id, scope_id)
        ) STRICT;

        CREATE TABLE evidence (
          evidence_id TEXT PRIMARY KEY,
          scope_id TEXT NOT NULL,
          source_kind TEXT NOT NULL CHECK (source_kind IN (
            'user_statement', 'pi_session', 'file', 'command', 'url', 'other'
          )),
          locator TEXT,
          excerpt TEXT NOT NULL,
          excerpt_hash TEXT NOT NULL CHECK (length(excerpt_hash) = 64),
          captured_at INTEGER NOT NULL CHECK (captured_at >= 0),
          source_observed_at INTEGER,
          trust_class TEXT NOT NULL CHECK (trust_class IN (
            'user', 'agent', 'local_file', 'local_command', 'external', 'unknown'
          )),
          session_id TEXT,
          session_entry_id TEXT,
          tool_call_id TEXT,
          branch_leaf TEXT,
          actor_type TEXT CHECK (actor_type IS NULL OR actor_type IN ('user', 'agent', 'system')),
          UNIQUE (evidence_id, scope_id),
          FOREIGN KEY (scope_id) REFERENCES scopes(scope_id)
        ) STRICT;

        CREATE TABLE claims (
          claim_id TEXT PRIMARY KEY,
          scope_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected', 'superseded')),
          subject_entity_id TEXT NOT NULL,
          predicate TEXT NOT NULL CHECK (length(predicate) BETWEEN 1 AND 64),
          object_kind TEXT NOT NULL CHECK (object_kind IN ('entity', 'text', 'number', 'boolean', 'date', 'url')),
          object_entity_id TEXT,
          object_text TEXT,
          object_number REAL,
          object_boolean INTEGER CHECK (object_boolean IS NULL OR object_boolean IN (0, 1)),
          object_date TEXT,
          object_url TEXT,
          observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
          valid_from INTEGER,
          valid_to INTEGER,
          created_at INTEGER NOT NULL CHECK (created_at >= 0),
          reviewed_at INTEGER,
          proposal_id TEXT,
          UNIQUE (claim_id, scope_id),
          CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from),
          CHECK (
            (object_kind = 'entity' AND object_entity_id IS NOT NULL AND object_text IS NULL AND object_number IS NULL AND object_boolean IS NULL AND object_date IS NULL AND object_url IS NULL)
            OR (object_kind = 'text' AND object_entity_id IS NULL AND object_text IS NOT NULL AND object_number IS NULL AND object_boolean IS NULL AND object_date IS NULL AND object_url IS NULL)
            OR (object_kind = 'number' AND object_entity_id IS NULL AND object_text IS NULL AND object_number IS NOT NULL AND object_boolean IS NULL AND object_date IS NULL AND object_url IS NULL)
            OR (object_kind = 'boolean' AND object_entity_id IS NULL AND object_text IS NULL AND object_number IS NULL AND object_boolean IS NOT NULL AND object_date IS NULL AND object_url IS NULL)
            OR (object_kind = 'date' AND object_entity_id IS NULL AND object_text IS NULL AND object_number IS NULL AND object_boolean IS NULL AND object_date IS NOT NULL AND object_url IS NULL)
            OR (object_kind = 'url' AND object_entity_id IS NULL AND object_text IS NULL AND object_number IS NULL AND object_boolean IS NULL AND object_date IS NULL AND object_url IS NOT NULL)
          ),
          FOREIGN KEY (scope_id) REFERENCES scopes(scope_id),
          FOREIGN KEY (subject_entity_id, scope_id) REFERENCES entities(entity_id, scope_id),
          FOREIGN KEY (object_entity_id, scope_id) REFERENCES entities(entity_id, scope_id)
        ) STRICT;

        CREATE TABLE claim_evidence (
          scope_id TEXT NOT NULL,
          claim_id TEXT NOT NULL,
          evidence_id TEXT NOT NULL,
          evidence_role TEXT NOT NULL CHECK (evidence_role IN ('primary', 'supporting')),
          PRIMARY KEY (claim_id, evidence_id),
          FOREIGN KEY (scope_id) REFERENCES scopes(scope_id),
          FOREIGN KEY (claim_id, scope_id) REFERENCES claims(claim_id, scope_id),
          FOREIGN KEY (evidence_id, scope_id) REFERENCES evidence(evidence_id, scope_id)
        ) STRICT;

        CREATE TABLE claim_supersession (
          scope_id TEXT NOT NULL,
          prior_claim_id TEXT NOT NULL,
          replacement_claim_id TEXT NOT NULL,
          reason TEXT,
          created_at INTEGER NOT NULL CHECK (created_at >= 0),
          PRIMARY KEY (prior_claim_id, replacement_claim_id),
          CHECK (prior_claim_id <> replacement_claim_id),
          FOREIGN KEY (scope_id) REFERENCES scopes(scope_id),
          FOREIGN KEY (prior_claim_id, scope_id) REFERENCES claims(claim_id, scope_id),
          FOREIGN KEY (replacement_claim_id, scope_id) REFERENCES claims(claim_id, scope_id)
        ) STRICT;

        CREATE TABLE audit_events (
          audit_event_id TEXT PRIMARY KEY,
          scope_id TEXT NOT NULL,
          actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
          action TEXT NOT NULL CHECK (action IN (
            'proposal_created', 'proposal_reviewed', 'acceptance', 'rejection',
            'correction', 'supersession', 'export', 'forget', 'purge',
            'migration', 'recovery'
          )),
          target_type TEXT NOT NULL CHECK (target_type IN (
            'scope', 'entity', 'alias', 'evidence', 'claim', 'proposal', 'audit_event', 'system'
          )),
          target_id TEXT,
          occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
          session_id TEXT,
          session_entry_id TEXT,
          tool_call_id TEXT,
          branch_leaf TEXT,
          before_ids_json TEXT NOT NULL DEFAULT '[]',
          after_ids_json TEXT NOT NULL DEFAULT '[]',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY (scope_id) REFERENCES scopes(scope_id)
        ) STRICT;

        CREATE INDEX entities_scope_label_idx ON entities(scope_id, normalized_label);
        CREATE INDEX aliases_scope_label_idx ON aliases(scope_id, normalized_alias);
        CREATE UNIQUE INDEX aliases_accepted_scope_label_idx
          ON aliases(scope_id, normalized_alias)
          WHERE status = 'accepted';
        CREATE INDEX evidence_scope_idx ON evidence(scope_id, captured_at);
        CREATE INDEX claims_scope_status_idx ON claims(scope_id, status, observed_at);
        CREATE INDEX claims_scope_subject_idx ON claims(scope_id, subject_entity_id);
        CREATE INDEX claims_scope_predicate_idx ON claims(scope_id, predicate);
        CREATE INDEX claim_evidence_scope_claim_idx ON claim_evidence(scope_id, claim_id);
        CREATE INDEX claim_supersession_scope_prior_idx ON claim_supersession(scope_id, prior_claim_id);
        CREATE INDEX audit_events_scope_time_idx ON audit_events(scope_id, occurred_at);
      `);
    },
  },
  {
    version: 3,
    name: "idempotency_and_proposals",
    up(database) {
      database.exec(`
        CREATE TABLE proposals (
          proposal_id TEXT PRIMARY KEY,
          scope_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
          candidate_fingerprint TEXT NOT NULL CHECK (length(candidate_fingerprint) = 64),
          idempotency_key TEXT,
          actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
          created_at INTEGER NOT NULL CHECK (created_at >= 0),
          reviewed_at INTEGER,
          session_id TEXT,
          session_entry_id TEXT,
          tool_call_id TEXT,
          branch_leaf TEXT,
          UNIQUE (proposal_id, scope_id),
          FOREIGN KEY (scope_id) REFERENCES scopes(scope_id)
        ) STRICT;

        CREATE UNIQUE INDEX evidence_identity_idx
          ON evidence(scope_id, excerpt_hash, source_kind, COALESCE(locator, ''), trust_class);
        CREATE UNIQUE INDEX proposals_scope_fingerprint_idx
          ON proposals(scope_id, candidate_fingerprint);
        CREATE UNIQUE INDEX proposals_scope_idempotency_idx
          ON proposals(scope_id, idempotency_key)
          WHERE idempotency_key IS NOT NULL;
        CREATE INDEX proposals_scope_status_idx ON proposals(scope_id, status, created_at);
      `);
    },
  },
  {
    version: 4,
    name: "fts_search_index",
    up(database) {
      database.exec(`
        CREATE VIRTUAL TABLE search_documents USING fts5(
          doc_key UNINDEXED,
          scope_id UNINDEXED,
          record_kind UNINDEXED,
          record_id UNINDEXED,
          text,
          tokenize = 'unicode61'
        );

        INSERT INTO search_documents(doc_key, scope_id, record_kind, record_id, text)
        SELECT 'entity:' || entity_id, scope_id, 'entity', entity_id, label
        FROM entities;
        INSERT INTO search_documents(doc_key, scope_id, record_kind, record_id, text)
        SELECT 'alias:' || alias_id, scope_id, 'alias', entity_id, alias
        FROM aliases;
        INSERT INTO search_documents(doc_key, scope_id, record_kind, record_id, text)
        SELECT 'evidence:' || evidence_id, scope_id, 'evidence', evidence_id,
               COALESCE(locator, '') || ' ' || excerpt
        FROM evidence;
        INSERT INTO search_documents(doc_key, scope_id, record_kind, record_id, text)
        SELECT
          'claim:' || c.claim_id,
          c.scope_id,
          'claim',
          c.claim_id,
          c.predicate || ' ' || COALESCE(subject.label, '') || ' ' ||
          CASE c.object_kind
            WHEN 'entity' THEN COALESCE(object_entity.label, '')
            WHEN 'text' THEN COALESCE(c.object_text, '')
            WHEN 'number' THEN CAST(c.object_number AS TEXT)
            WHEN 'boolean' THEN CASE c.object_boolean WHEN 1 THEN 'true' ELSE 'false' END
            WHEN 'date' THEN COALESCE(c.object_date, '')
            WHEN 'url' THEN COALESCE(c.object_url, '')
            ELSE ''
          END
        FROM claims AS c
        JOIN entities AS subject
          ON subject.entity_id = c.subject_entity_id AND subject.scope_id = c.scope_id
        LEFT JOIN entities AS object_entity
          ON object_entity.entity_id = c.object_entity_id AND object_entity.scope_id = c.scope_id;

        CREATE TRIGGER search_entities_insert AFTER INSERT ON entities BEGIN
          INSERT INTO search_documents(doc_key, scope_id, record_kind, record_id, text)
          VALUES ('entity:' || NEW.entity_id, NEW.scope_id, 'entity', NEW.entity_id, NEW.label);
        END;
        CREATE TRIGGER search_entities_delete AFTER DELETE ON entities BEGIN
          DELETE FROM search_documents WHERE doc_key = 'entity:' || OLD.entity_id;
        END;
        CREATE TRIGGER search_entities_update AFTER UPDATE OF label ON entities BEGIN
          DELETE FROM search_documents WHERE doc_key = 'entity:' || OLD.entity_id;
          INSERT INTO search_documents(doc_key, scope_id, record_kind, record_id, text)
          VALUES ('entity:' || NEW.entity_id, NEW.scope_id, 'entity', NEW.entity_id, NEW.label);
        END;

        CREATE TRIGGER search_aliases_insert AFTER INSERT ON aliases BEGIN
          INSERT INTO search_documents(doc_key, scope_id, record_kind, record_id, text)
          VALUES ('alias:' || NEW.alias_id, NEW.scope_id, 'alias', NEW.entity_id, NEW.alias);
        END;
        CREATE TRIGGER search_aliases_delete AFTER DELETE ON aliases BEGIN
          DELETE FROM search_documents WHERE doc_key = 'alias:' || OLD.alias_id;
        END;
        CREATE TRIGGER search_aliases_update AFTER UPDATE OF alias ON aliases BEGIN
          DELETE FROM search_documents WHERE doc_key = 'alias:' || OLD.alias_id;
          INSERT INTO search_documents(doc_key, scope_id, record_kind, record_id, text)
          VALUES ('alias:' || NEW.alias_id, NEW.scope_id, 'alias', NEW.entity_id, NEW.alias);
        END;

        CREATE TRIGGER search_evidence_insert AFTER INSERT ON evidence BEGIN
          INSERT INTO search_documents(doc_key, scope_id, record_kind, record_id, text)
          VALUES ('evidence:' || NEW.evidence_id, NEW.scope_id, 'evidence', NEW.evidence_id, COALESCE(NEW.locator, '') || ' ' || NEW.excerpt);
        END;
        CREATE TRIGGER search_evidence_delete AFTER DELETE ON evidence BEGIN
          DELETE FROM search_documents WHERE doc_key = 'evidence:' || OLD.evidence_id;
        END;
        CREATE TRIGGER search_evidence_update AFTER UPDATE OF locator, excerpt ON evidence BEGIN
          DELETE FROM search_documents WHERE doc_key = 'evidence:' || OLD.evidence_id;
          INSERT INTO search_documents(doc_key, scope_id, record_kind, record_id, text)
          VALUES ('evidence:' || NEW.evidence_id, NEW.scope_id, 'evidence', NEW.evidence_id, COALESCE(NEW.locator, '') || ' ' || NEW.excerpt);
        END;

        CREATE TRIGGER search_claims_insert AFTER INSERT ON claims BEGIN
          INSERT INTO search_documents(doc_key, scope_id, record_kind, record_id, text)
          VALUES (
            'claim:' || NEW.claim_id,
            NEW.scope_id,
            'claim',
            NEW.claim_id,
            NEW.predicate || ' ' ||
            COALESCE((SELECT label FROM entities WHERE entity_id = NEW.subject_entity_id AND scope_id = NEW.scope_id), '') || ' ' ||
            CASE NEW.object_kind
              WHEN 'entity' THEN COALESCE((SELECT label FROM entities WHERE entity_id = NEW.object_entity_id AND scope_id = NEW.scope_id), '')
              WHEN 'text' THEN COALESCE(NEW.object_text, '')
              WHEN 'number' THEN CAST(NEW.object_number AS TEXT)
              WHEN 'boolean' THEN CASE NEW.object_boolean WHEN 1 THEN 'true' ELSE 'false' END
              WHEN 'date' THEN COALESCE(NEW.object_date, '')
              WHEN 'url' THEN COALESCE(NEW.object_url, '')
              ELSE ''
            END
          );
        END;
        CREATE TRIGGER search_claims_delete AFTER DELETE ON claims BEGIN
          DELETE FROM search_documents WHERE doc_key = 'claim:' || OLD.claim_id;
        END;
        CREATE TRIGGER search_claims_update AFTER UPDATE OF predicate, object_kind, object_entity_id, object_text, object_number, object_boolean, object_date, object_url ON claims BEGIN
          DELETE FROM search_documents WHERE doc_key = 'claim:' || OLD.claim_id;
          INSERT INTO search_documents(doc_key, scope_id, record_kind, record_id, text)
          VALUES (
            'claim:' || NEW.claim_id,
            NEW.scope_id,
            'claim',
            NEW.claim_id,
            NEW.predicate || ' ' ||
            COALESCE((SELECT label FROM entities WHERE entity_id = NEW.subject_entity_id AND scope_id = NEW.scope_id), '') || ' ' ||
            CASE NEW.object_kind
              WHEN 'entity' THEN COALESCE((SELECT label FROM entities WHERE entity_id = NEW.object_entity_id AND scope_id = NEW.scope_id), '')
              WHEN 'text' THEN COALESCE(NEW.object_text, '')
              WHEN 'number' THEN CAST(NEW.object_number AS TEXT)
              WHEN 'boolean' THEN CASE NEW.object_boolean WHEN 1 THEN 'true' ELSE 'false' END
              WHEN 'date' THEN COALESCE(NEW.object_date, '')
              WHEN 'url' THEN COALESCE(NEW.object_url, '')
              ELSE ''
            END
          );
        END;
      `);
    },
  },
  {
    version: 5,
    name: "proposal_candidates",
    up(database) {
      database.exec(`
        CREATE TABLE proposal_claims (
          scope_id TEXT NOT NULL,
          proposal_id TEXT NOT NULL,
          claim_id TEXT NOT NULL,
          PRIMARY KEY (proposal_id, claim_id),
          FOREIGN KEY (scope_id) REFERENCES scopes(scope_id),
          FOREIGN KEY (proposal_id, scope_id) REFERENCES proposals(proposal_id, scope_id),
          FOREIGN KEY (claim_id, scope_id) REFERENCES claims(claim_id, scope_id)
        ) STRICT;

        CREATE TABLE proposal_evidence (
          scope_id TEXT NOT NULL,
          proposal_id TEXT NOT NULL,
          evidence_id TEXT NOT NULL,
          PRIMARY KEY (proposal_id, evidence_id),
          FOREIGN KEY (scope_id) REFERENCES scopes(scope_id),
          FOREIGN KEY (proposal_id, scope_id) REFERENCES proposals(proposal_id, scope_id),
          FOREIGN KEY (evidence_id, scope_id) REFERENCES evidence(evidence_id, scope_id)
        ) STRICT;

        CREATE INDEX proposal_claims_scope_idx ON proposal_claims(scope_id, proposal_id);
        CREATE INDEX proposal_evidence_scope_idx ON proposal_evidence(scope_id, proposal_id);
      `);
    },
  },
  {
    version: 6,
    name: "proposal_corrections",
    up(database) {
      database.exec(`
        CREATE TABLE proposal_supersession (
          scope_id TEXT NOT NULL,
          proposal_id TEXT NOT NULL,
          prior_claim_id TEXT NOT NULL,
          reason TEXT,
          PRIMARY KEY (scope_id, proposal_id),
          FOREIGN KEY (scope_id) REFERENCES scopes(scope_id),
          FOREIGN KEY (proposal_id, scope_id) REFERENCES proposals(proposal_id, scope_id),
          FOREIGN KEY (prior_claim_id, scope_id) REFERENCES claims(claim_id, scope_id)
        ) STRICT;

        CREATE INDEX proposal_supersession_scope_prior_idx
          ON proposal_supersession(scope_id, prior_claim_id);
      `);
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

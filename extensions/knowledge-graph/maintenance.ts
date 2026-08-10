import { chmodSync, lstatSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  assertPrivateFile,
  ensurePrivateDirectory,
  type StoragePaths,
} from "./config.ts";
import {
  KnowledgeGraphRepositories,
  type AliasRecord,
  type AuditEventRecord,
  type ClaimRecord,
  type EntityRecord,
  type EvidenceRecord,
  type ProposalRecord,
  type ScopeRecord,
  type SupersessionLinkRecord,
} from "./repository.ts";

export interface ProposalClaimLink {
  readonly scopeId: string;
  readonly proposalId: string;
  readonly claimId: string;
}

export interface ProposalEvidenceLink {
  readonly scopeId: string;
  readonly proposalId: string;
  readonly evidenceId: string;
}

export interface ProposalSupersessionLink {
  readonly scopeId: string;
  readonly proposalId: string;
  readonly priorClaimId: string;
  readonly reason: string | undefined;
}

export interface ClaimEvidenceLink {
  readonly scopeId: string;
  readonly claimId: string;
  readonly evidenceId: string;
  readonly role: "primary" | "supporting";
}

export interface KnowledgeGraphSnapshot {
  readonly formatVersion: 1;
  readonly schemaVersion: number;
  readonly scopes: readonly ScopeRecord[];
  readonly entities: readonly EntityRecord[];
  readonly aliases: readonly AliasRecord[];
  readonly evidence: readonly EvidenceRecord[];
  readonly claims: readonly ClaimRecord[];
  readonly proposals: readonly ProposalRecord[];
  readonly claimEvidence: readonly ClaimEvidenceLink[];
  readonly claimSupersession: readonly SupersessionLinkRecord[];
  readonly proposalClaims: readonly ProposalClaimLink[];
  readonly proposalEvidence: readonly ProposalEvidenceLink[];
  readonly proposalSupersession: readonly ProposalSupersessionLink[];
  readonly auditEvents: readonly AuditEventRecord[];
}

export class KnowledgeGraphMaintenanceError extends Error {
  readonly code:
    | "invalid_scope"
    | "invalid_snapshot"
    | "invalid_export_name"
    | "export_exists"
    | "restore_not_empty"
    | "storage_error";

  constructor(code: KnowledgeGraphMaintenanceError["code"], message: string) {
    super(message);
    this.name = "KnowledgeGraphMaintenanceError";
    this.code = code;
  }
}

export class KnowledgeGraphMaintenance {
  private readonly database: DatabaseSync;
  private readonly repositories: KnowledgeGraphRepositories;

  constructor(database: DatabaseSync, repositories: KnowledgeGraphRepositories) {
    this.database = database;
    this.repositories = repositories;
  }

  exportSnapshot(scopeIds?: readonly string[]): KnowledgeGraphSnapshot {
    const scopes = this.selectScopes(scopeIds);
    const selected = new Set(scopes.map((scope) => scope.scopeId));
    const entities: EntityRecord[] = [];
    const aliases: AliasRecord[] = [];
    const evidence: EvidenceRecord[] = [];
    const claims: ClaimRecord[] = [];
    const proposals: ProposalRecord[] = [];
    const auditEvents: AuditEventRecord[] = [];
    const claimEvidence: ClaimEvidenceLink[] = [];
    const claimSupersession: SupersessionLinkRecord[] = [];
    const proposalClaims: ProposalClaimLink[] = [];
    const proposalEvidence: ProposalEvidenceLink[] = [];
    const proposalSupersession: ProposalSupersessionLink[] = [];

    for (const scope of scopes) {
      entities.push(...this.repositories.listEntities(scope.scopeId));
      aliases.push(...this.repositories.listAliases(scope.scopeId));
      evidence.push(...this.repositories.listEvidence(scope.scopeId));
      const scopeClaims = this.repositories.listClaims(scope.scopeId);
      claims.push(...scopeClaims);
      proposals.push(...this.repositories.listProposals(scope.scopeId));
      auditEvents.push(...this.repositories.listAuditEvents(scope.scopeId));
      for (const claim of scopeClaims) {
        for (const link of this.repositories.listClaimEvidence(scope.scopeId, claim.claimId)) {
          claimEvidence.push({ scopeId: scope.scopeId, claimId: link.claimId, evidenceId: link.evidenceId, role: link.role });
        }
      }
      for (const claim of scopeClaims) {
        const links = this.queryRows(
          `SELECT scope_id, prior_claim_id, replacement_claim_id, reason, created_at
           FROM claim_supersession WHERE scope_id = ? AND (prior_claim_id = ? OR replacement_claim_id = ?)
           ORDER BY created_at, prior_claim_id, replacement_claim_id`,
          [scope.scopeId, claim.claimId, claim.claimId],
        );
        for (const row of links) {
          const link = {
            scopeId: stringValue(row.scope_id),
            priorClaimId: stringValue(row.prior_claim_id),
            replacementClaimId: stringValue(row.replacement_claim_id),
            reason: optionalString(row.reason),
            createdAt: numberValue(row.created_at),
          } satisfies SupersessionLinkRecord;
          if (!claimSupersession.some((existing) => existing.scopeId === link.scopeId && existing.priorClaimId === link.priorClaimId && existing.replacementClaimId === link.replacementClaimId)) {
            claimSupersession.push(link);
          }
        }
      }
      for (const proposal of this.repositories.listProposals(scope.scopeId)) {
        const candidates = this.repositories.getProposalCandidates(scope.scopeId, proposal.proposalId);
        for (const claim of candidates.claims) proposalClaims.push({ scopeId: scope.scopeId, proposalId: proposal.proposalId, claimId: claim.claimId });
        for (const candidateEvidence of this.queryRows(
          `SELECT scope_id, proposal_id, evidence_id FROM proposal_evidence WHERE scope_id = ? AND proposal_id = ? ORDER BY evidence_id`,
          [scope.scopeId, proposal.proposalId],
        )) {
          proposalEvidence.push({ scopeId: scope.scopeId, proposalId: proposal.proposalId, evidenceId: stringValue(candidateEvidence.evidence_id) });
        }
        const correction = this.repositories.getProposalSupersession(scope.scopeId, proposal.proposalId);
        if (correction) proposalSupersession.push(correction);
      }
    }

    // All arrays are sorted explicitly so exports are byte-stable for the same store.
    entities.sort(byScopeAndId("entityId"));
    aliases.sort(byScopeAndId("aliasId"));
    evidence.sort(byScopeAndId("evidenceId"));
    claims.sort(byScopeAndId("claimId"));
    proposals.sort(byScopeAndId("proposalId"));
    auditEvents.sort(byScopeAndId("auditEventId"));
    claimEvidence.sort(compareLinks);
    claimSupersession.sort(compareLinks);
    proposalClaims.sort(compareLinks);
    proposalEvidence.sort(compareLinks);
    proposalSupersession.sort(compareLinks);

    return {
      formatVersion: 1,
      schemaVersion: this.schemaVersion(),
      scopes,
      entities: entities.filter((record) => selected.has(record.scopeId)),
      aliases: aliases.filter((record) => selected.has(record.scopeId)),
      evidence: evidence.filter((record) => selected.has(record.scopeId)),
      claims: claims.filter((record) => selected.has(record.scopeId)),
      proposals: proposals.filter((record) => selected.has(record.scopeId)),
      claimEvidence,
      claimSupersession,
      proposalClaims,
      proposalEvidence,
      proposalSupersession,
      auditEvents,
    };
  }

  writeSnapshot(filename: string, scopeIds?: readonly string[]): string {
    const safeName = validateExportName(filename);
    const paths = this.storagePaths();
    ensurePrivateDirectory(paths.exportDirectory);
    const target = resolve(paths.exportDirectory, safeName);
    if (dirname(target) !== resolve(paths.exportDirectory) || basename(target) !== safeName || pathExists(target)) {
      throw new KnowledgeGraphMaintenanceError(pathExists(target) ? "export_exists" : "invalid_export_name", "Export destination is invalid or already exists.");
    }
    const snapshot = this.exportSnapshot(scopeIds);
    writeFileSync(target, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(target, 0o600);
    assertPrivateFile(target);
    return target;
  }

  restoreSnapshot(snapshot: unknown): void {
    assertSnapshot(snapshot);
    if (this.hasCanonicalRows()) {
      throw new KnowledgeGraphMaintenanceError("restore_not_empty", "Restore requires an empty canonical knowledge-graph store.");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const scope of snapshot.scopes) {
        this.database.prepare(
          `INSERT INTO scopes(scope_id, kind, project_root, identity_path, created_at) VALUES (?, ?, ?, ?, ?)`,
        ).run(scope.scopeId, scope.kind, scope.projectRoot ?? null, scope.identityPath ?? null, scope.createdAt);
      }
      for (const proposal of snapshot.proposals) {
        this.database.prepare(
          `INSERT INTO proposals(
             proposal_id, scope_id, status, candidate_fingerprint, idempotency_key, actor_type,
             created_at, reviewed_at, session_id, session_entry_id, tool_call_id, branch_leaf
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          proposal.proposalId, proposal.scopeId, proposal.status, proposal.candidateFingerprint,
          proposal.idempotencyKey ?? null, proposal.actorType, proposal.createdAt, proposal.reviewedAt ?? null,
          proposal.sessionId ?? null, proposal.sessionEntryId ?? null, proposal.toolCallId ?? null, proposal.branchLeaf ?? null,
        );
      }
      for (const entity of snapshot.entities) {
        this.database.prepare(
          `INSERT INTO entities(entity_id, scope_id, label, normalized_label, entity_type, status, created_at, reviewed_at, proposal_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(entity.entityId, entity.scopeId, entity.label, entity.normalizedLabel, entity.type, entity.status, entity.createdAt, entity.reviewedAt ?? null, entity.proposalId ?? null);
      }
      for (const alias of snapshot.aliases) {
        this.database.prepare(
          `INSERT INTO aliases(alias_id, scope_id, entity_id, alias, normalized_alias, status, created_at, reviewed_at, proposal_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(alias.aliasId, alias.scopeId, alias.entityId, alias.alias, alias.normalizedAlias, alias.status, alias.createdAt, alias.reviewedAt ?? null, alias.proposalId ?? null);
      }
      for (const item of snapshot.evidence) {
        this.database.prepare(
          `INSERT INTO evidence(
             evidence_id, scope_id, source_kind, locator, excerpt, excerpt_hash, captured_at, source_observed_at,
             trust_class, session_id, session_entry_id, tool_call_id, branch_leaf, actor_type
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          item.evidenceId, item.scopeId, item.sourceKind, item.locator ?? null, item.excerpt, item.excerptHash,
          item.capturedAt, item.sourceObservedAt ?? null, item.trustClass, item.sessionId ?? null,
          item.sessionEntryId ?? null, item.toolCallId ?? null, item.branchLeaf ?? null, item.actorType ?? null,
        );
      }
      for (const claim of snapshot.claims) {
        this.database.prepare(
          `INSERT INTO claims(
             claim_id, scope_id, status, subject_entity_id, predicate, object_kind, object_entity_id, object_text,
             object_number, object_boolean, object_date, object_url, observed_at, valid_from, valid_to, created_at, reviewed_at, proposal_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          claim.claimId, claim.scopeId, claim.status, claim.subjectEntityId, claim.predicate, claim.object.kind,
          claim.object.kind === "entity" ? claim.object.entityId : null,
          claim.object.kind === "text" ? claim.object.value : null,
          claim.object.kind === "number" ? claim.object.value : null,
          claim.object.kind === "boolean" ? (claim.object.value ? 1 : 0) : null,
          claim.object.kind === "date" ? claim.object.value : null,
          claim.object.kind === "url" ? claim.object.value : null,
          claim.observedAt, claim.validFrom ?? null, claim.validTo ?? null, claim.createdAt, claim.reviewedAt ?? null, claim.proposalId ?? null,
        );
      }
      for (const link of snapshot.claimEvidence) {
        this.database.prepare(`INSERT INTO claim_evidence(scope_id, claim_id, evidence_id, evidence_role) VALUES (?, ?, ?, ?)`).run(link.scopeId, link.claimId, link.evidenceId, link.role);
      }
      for (const link of snapshot.claimSupersession) {
        this.database.prepare(`INSERT INTO claim_supersession(scope_id, prior_claim_id, replacement_claim_id, reason, created_at) VALUES (?, ?, ?, ?, ?)`).run(link.scopeId, link.priorClaimId, link.replacementClaimId, link.reason ?? null, link.createdAt);
      }
      for (const link of snapshot.proposalClaims) {
        this.database.prepare(`INSERT INTO proposal_claims(scope_id, proposal_id, claim_id) VALUES (?, ?, ?)`).run(link.scopeId, link.proposalId, link.claimId);
      }
      for (const link of snapshot.proposalEvidence) {
        this.database.prepare(`INSERT INTO proposal_evidence(scope_id, proposal_id, evidence_id) VALUES (?, ?, ?)`).run(link.scopeId, link.proposalId, link.evidenceId);
      }
      for (const link of snapshot.proposalSupersession) {
        this.database.prepare(`INSERT INTO proposal_supersession(scope_id, proposal_id, prior_claim_id, reason) VALUES (?, ?, ?, ?)`).run(link.scopeId, link.proposalId, link.priorClaimId, link.reason ?? null);
      }
      for (const event of snapshot.auditEvents) {
        this.database.prepare(
          `INSERT INTO audit_events(
             audit_event_id, scope_id, actor_type, action, target_type, target_id, occurred_at,
             session_id, session_entry_id, tool_call_id, branch_leaf, before_ids_json, after_ids_json, metadata_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          event.auditEventId, event.scopeId, event.actorType, event.action, event.targetType, event.targetId ?? null,
          event.occurredAt, event.sessionId ?? null, event.sessionEntryId ?? null, event.toolCallId ?? null,
          event.branchLeaf ?? null, JSON.stringify(event.beforeIds), JSON.stringify(event.afterIds), event.metadataJson,
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve original failure */ }
      if (error instanceof KnowledgeGraphMaintenanceError) throw error;
      throw new KnowledgeGraphMaintenanceError("storage_error", "Knowledge-graph restore failed and was rolled back.");
    }
  }

  private selectScopes(scopeIds?: readonly string[]): readonly ScopeRecord[] {
    const scopes = this.repositories.listScopes();
    if (scopeIds === undefined) return scopes;
    const requested = new Set(scopeIds);
    if (requested.size !== scopeIds.length || scopeIds.some((scopeId) => !scopes.some((scope) => scope.scopeId === scopeId))) {
      throw new KnowledgeGraphMaintenanceError("invalid_scope", "Export scope is not registered.");
    }
    return scopes.filter((scope) => requested.has(scope.scopeId));
  }

  private queryRows(sql: string, parameters: readonly (string | number | null)[]): readonly Record<string, unknown>[] {
    return this.database.prepare(sql).all(...parameters).filter(isRecord);
  }

  private schemaVersion(): number {
    const row = this.database.prepare("PRAGMA user_version").get();
    if (!isRecord(row) || typeof row.user_version !== "number") throw new KnowledgeGraphMaintenanceError("storage_error", "Schema version could not be read.");
    return row.user_version;
  }

  private hasCanonicalRows(): boolean {
    const tables = ["scopes", "entities", "aliases", "evidence", "claims", "proposals", "audit_events"];
    return tables.some((table) => {
      const row = this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
      return isRecord(row) && typeof row.count === "number" && row.count > 0;
    });
  }

  private storagePaths(): StoragePaths {
    // The database file is the canonical path; maintenance callers provide a database opened from these paths.
    // The parent/export sibling is derived only from the actual database parent and never from user content.
    const row = this.database.prepare("PRAGMA database_list").all().find(isRecord);
    const filename = row?.file;
    if (typeof filename !== "string" || !isAbsolute(filename)) throw new KnowledgeGraphMaintenanceError("storage_error", "Database path could not be resolved.");
    const rootDirectory = dirname(filename);
    return {
      rootDirectory,
      databasePath: filename,
      backupDirectory: join(rootDirectory, "backups"),
      exportDirectory: join(rootDirectory, "exports"),
      globalConfigPath: join(rootDirectory, "config.json"),
    };
  }
}

function validateExportName(filename: string): string {
  if (typeof filename !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}\.json$/u.test(filename) || filename.includes("..")) {
    throw new KnowledgeGraphMaintenanceError("invalid_export_name", "Export filename must be a simple private JSON filename.");
  }
  return filename;
}

function pathExists(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() || stat.isSymbolicLink() || stat.isDirectory();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function byScopeAndId<T extends { readonly scopeId: string }>(key: keyof T) {
  return (left: T, right: T): number => left.scopeId.localeCompare(right.scopeId) || String(left[key]).localeCompare(String(right[key]));
}

function compareLinks(left: { readonly scopeId: string; readonly proposalId?: string; readonly claimId?: string; readonly evidenceId?: string; readonly priorClaimId?: string }, right: { readonly scopeId: string; readonly proposalId?: string; readonly claimId?: string; readonly evidenceId?: string; readonly priorClaimId?: string }): number {
  return [left.scopeId, left.proposalId ?? "", left.claimId ?? left.priorClaimId ?? "", left.evidenceId ?? ""].join("\u0000").localeCompare([right.scopeId, right.proposalId ?? "", right.claimId ?? right.priorClaimId ?? "", right.evidenceId ?? ""].join("\u0000"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new KnowledgeGraphMaintenanceError("storage_error", "Export row contains invalid text.");
  return value;
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : stringValue(value);
}

function numberValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new KnowledgeGraphMaintenanceError("storage_error", "Export row contains invalid time.");
  return value;
}

function assertSnapshot(value: unknown): asserts value is KnowledgeGraphSnapshot {
  if (!isRecord(value) || value.formatVersion !== 1 || typeof value.schemaVersion !== "number" || !Number.isInteger(value.schemaVersion)) {
    throw new KnowledgeGraphMaintenanceError("invalid_snapshot", "Snapshot format or schema version is invalid.");
  }
  const arrayFields = ["scopes", "entities", "aliases", "evidence", "claims", "proposals", "claimEvidence", "claimSupersession", "proposalClaims", "proposalEvidence", "proposalSupersession", "auditEvents"] as const;
  for (const field of arrayFields) {
    if (!Array.isArray(value[field])) throw new KnowledgeGraphMaintenanceError("invalid_snapshot", `Snapshot field ${field} must be an array.`);
  }
}

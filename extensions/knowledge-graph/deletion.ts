import type { DatabaseSync } from "node:sqlite";
import {
  KnowledgeGraphRepositories,
  type ActorType,
  type AuditEventRecord,
  validateScopeId,
} from "./repository.ts";
import { assertNoSecrets } from "./security.ts";

const UUID_SUFFIX = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const MAX_AFFECTED_RECORDS = 10_000;
const MAX_REASON_LENGTH = 2_048;
const QUERY_CHUNK_SIZE = 500;
const PREVIEW_SAMPLE_SIZE = 8;

type DeletionTargetKind = "entity" | "alias" | "evidence" | "claim" | "proposal";
type DeletableTable =
  | "claim_supersession"
  | "proposal_supersession"
  | "claim_evidence"
  | "proposal_claims"
  | "proposal_evidence"
  | "claims"
  | "aliases"
  | "entities"
  | "evidence"
  | "proposals";

type Row = Record<string, unknown>;

interface DeletionSet {
  readonly entityIds: Set<string>;
  readonly aliasIds: Set<string>;
  readonly evidenceIds: Set<string>;
  readonly claimIds: Set<string>;
  readonly proposalIds: Set<string>;
}

interface DeletionWork extends DeletionSet {
  readonly rootEntityIds: Set<string>;
  readonly candidateEntityIds: Set<string>;
  readonly candidateAliasIds: Set<string>;
  readonly explicitAliasIds: Set<string>;
}

export interface KnowledgeGraphMaintenanceProvenance {
  readonly actorType: ActorType;
  readonly sessionId?: string;
  readonly sessionEntryId?: string;
  readonly toolCallId?: string;
  readonly branchLeaf?: string;
  readonly reason?: string;
}

export interface KnowledgeGraphDeletionCounts {
  readonly entities: number;
  readonly aliases: number;
  readonly evidence: number;
  readonly claims: number;
  readonly proposals: number;
  readonly searchDocuments: number;
  readonly claimEvidenceLinks: number;
  readonly claimSupersessionLinks: number;
  readonly proposalClaimLinks: number;
  readonly proposalEvidenceLinks: number;
  readonly proposalSupersessionLinks: number;
}

export interface KnowledgeGraphDeletionPreview {
  readonly operation: "forget" | "purge";
  readonly scopeId: string;
  readonly targetKind?: DeletionTargetKind;
  readonly targetId?: string;
  readonly counts: KnowledgeGraphDeletionCounts;
  readonly sampleIds: {
    readonly entities: readonly string[];
    readonly aliases: readonly string[];
    readonly evidence: readonly string[];
    readonly claims: readonly string[];
    readonly proposals: readonly string[];
  };
}

export interface KnowledgeGraphDeletionResult {
  readonly preview: KnowledgeGraphDeletionPreview;
  readonly auditEvent: AuditEventRecord;
}

export class KnowledgeGraphDeletionError extends Error {
  readonly code:
    | "invalid_scope"
    | "invalid_target"
    | "not_found"
    | "shared_evidence"
    | "too_many_rows";

  constructor(
    code: KnowledgeGraphDeletionError["code"],
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeGraphDeletionError";
    this.code = code;
  }
}

export class KnowledgeGraphDeletionService {
  private readonly database: DatabaseSync;
  private readonly repositories: KnowledgeGraphRepositories;

  constructor(database: DatabaseSync, repositories: KnowledgeGraphRepositories) {
    this.database = database;
    this.repositories = repositories;
  }

  previewForget(scopeId: string, targetId: string): KnowledgeGraphDeletionPreview {
    const validScopeId = this.requireScope(scopeId);
    const targetKind = classifyTarget(targetId);
    const work = this.buildForgetSet(validScopeId, targetKind, targetId);
    return this.makePreview("forget", validScopeId, work, targetKind, targetId);
  }

  forget(
    scopeId: string,
    targetId: string,
    provenance: KnowledgeGraphMaintenanceProvenance,
  ): KnowledgeGraphDeletionResult {
    const validScopeId = this.requireScope(scopeId);
    const targetKind = classifyTarget(targetId);
    const reason = normalizeReason(provenance.reason);
    return this.repositories.transaction(() => {
      const work = this.buildForgetSet(validScopeId, targetKind, targetId);
      const preview = this.makePreview("forget", validScopeId, work, targetKind, targetId);
      this.deleteSet(validScopeId, work);
      const auditEvent = this.repositories.appendAuditEvent(validScopeId, {
        actorType: provenance.actorType,
        sessionId: provenance.sessionId,
        sessionEntryId: provenance.sessionEntryId,
        toolCallId: provenance.toolCallId,
        branchLeaf: provenance.branchLeaf,
        action: "forget",
        targetType: targetKind,
        targetId,
        beforeIds: [targetId, ...this.previewIds(work)].slice(0, 32),
        metadataJson: deletionMetadata(preview, reason),
      });
      return { preview, auditEvent };
    });
  }

  previewPurge(scopeId: string): KnowledgeGraphDeletionPreview {
    const validScopeId = this.requireScope(scopeId);
    const work = this.buildPurgeSet(validScopeId);
    return this.makePreview("purge", validScopeId, work);
  }

  purge(
    scopeId: string,
    provenance: KnowledgeGraphMaintenanceProvenance,
  ): KnowledgeGraphDeletionResult {
    const validScopeId = this.requireScope(scopeId);
    const reason = normalizeReason(provenance.reason);
    return this.repositories.transaction(() => {
      const work = this.buildPurgeSet(validScopeId);
      const preview = this.makePreview("purge", validScopeId, work);
      this.deleteSet(validScopeId, work);
      const auditEvent = this.repositories.appendAuditEvent(validScopeId, {
        actorType: provenance.actorType,
        sessionId: provenance.sessionId,
        sessionEntryId: provenance.sessionEntryId,
        toolCallId: provenance.toolCallId,
        branchLeaf: provenance.branchLeaf,
        action: "purge",
        targetType: "scope",
        targetId: validScopeId,
        metadataJson: deletionMetadata(preview, reason, { auditEventsRetained: true }),
      });
      return { preview, auditEvent };
    });
  }

  private requireScope(scopeId: string): string {
    let validScopeId: string;
    try {
      validScopeId = validateScopeId(scopeId);
    } catch {
      throw new KnowledgeGraphDeletionError("invalid_scope", "The requested knowledge scope is invalid.");
    }
    if (!this.repositories.getScope(validScopeId)) {
      throw new KnowledgeGraphDeletionError("invalid_scope", "The requested knowledge scope is not registered.");
    }
    return validScopeId;
  }

  private buildForgetSet(scopeId: string, targetKind: DeletionTargetKind, targetId: string): DeletionWork {
    const work = createDeletionWork();
    switch (targetKind) {
      case "entity": {
        if (!this.repositories.getEntity(scopeId, targetId)) this.notFound();
        work.rootEntityIds.add(targetId);
        work.entityIds.add(targetId);
        break;
      }
      case "alias": {
        if (!this.repositories.getAlias(scopeId, targetId)) this.notFound();
        work.aliasIds.add(targetId);
        work.explicitAliasIds.add(targetId);
        break;
      }
      case "evidence": {
        if (!this.repositories.getEvidence(scopeId, targetId)) this.notFound();
        if (this.evidenceReferenceCount(scopeId, targetId) > 0) {
          throw new KnowledgeGraphDeletionError(
            "shared_evidence",
            "Evidence is still referenced; forget its claims or proposal first so shared evidence is not removed accidentally.",
          );
        }
        work.evidenceIds.add(targetId);
        break;
      }
      case "claim": {
        if (!this.repositories.getClaim(scopeId, targetId)) this.notFound();
        work.claimIds.add(targetId);
        break;
      }
      case "proposal": {
        if (!this.repositories.getProposal(scopeId, targetId)) this.notFound();
        work.proposalIds.add(targetId);
        break;
      }
    }

    this.expandWork(scopeId, work);
    this.pruneSharedEvidence(scopeId, work);
    this.pruneCandidateEntities(scopeId, work);
    this.addAliasesForDeletedEntities(scopeId, work);
    this.enforceAffectedLimit(work);
    return work;
  }

  private buildPurgeSet(scopeId: string): DeletionWork {
    const work = createDeletionWork();
    for (const entity of this.repositories.listEntities(scopeId)) {
      work.entityIds.add(entity.entityId);
    }
    for (const alias of this.repositories.listAliases(scopeId)) {
      work.aliasIds.add(alias.aliasId);
    }
    for (const evidence of this.repositories.listEvidence(scopeId)) {
      work.evidenceIds.add(evidence.evidenceId);
    }
    for (const claim of this.repositories.listClaims(scopeId)) {
      work.claimIds.add(claim.claimId);
    }
    for (const proposal of this.repositories.listProposals(scopeId)) {
      work.proposalIds.add(proposal.proposalId);
    }
    this.enforceAffectedLimit(work);
    return work;
  }

  private expandWork(scopeId: string, work: DeletionWork): void {
    let previousSize = -1;
    while (previousSize !== deletionSetSize(work)) {
      previousSize = deletionSetSize(work);

      for (const row of this.rowsIn(scopeId, "claims", "subject_entity_id", work.rootEntityIds, "claim_id, proposal_id")) {
        addRowString(work.claimIds, row, "claim_id");
        addOptionalRowString(work.proposalIds, row, "proposal_id");
      }
      for (const row of this.rowsIn(scopeId, "claims", "object_entity_id", work.rootEntityIds, "claim_id, proposal_id")) {
        addRowString(work.claimIds, row, "claim_id");
        addOptionalRowString(work.proposalIds, row, "proposal_id");
      }
      for (const row of this.rowsIn(scopeId, "claims", "claim_id", work.claimIds, "proposal_id")) {
        addOptionalRowString(work.proposalIds, row, "proposal_id");
      }
      for (const row of this.rowsIn(scopeId, "entities", "entity_id", new Set([...work.entityIds, ...work.candidateEntityIds]), "entity_id, proposal_id")) {
        addOptionalRowString(work.proposalIds, row, "proposal_id");
      }
      for (const row of this.rowsIn(scopeId, "aliases", "alias_id", work.aliasIds, "proposal_id")) {
        addOptionalRowString(work.proposalIds, row, "proposal_id");
      }

      for (const row of this.rowsIn(scopeId, "proposals", "proposal_id", work.proposalIds, "proposal_id")) {
        addRowString(work.proposalIds, row, "proposal_id");
      }
      for (const row of this.rowsIn(scopeId, "entities", "proposal_id", work.proposalIds, "entity_id")) {
        addRowString(work.candidateEntityIds, row, "entity_id");
      }
      for (const row of this.rowsIn(scopeId, "aliases", "proposal_id", work.proposalIds, "alias_id")) {
        addRowString(work.candidateAliasIds, row, "alias_id");
      }
      for (const row of this.rowsIn(scopeId, "claims", "proposal_id", work.proposalIds, "claim_id")) {
        addRowString(work.claimIds, row, "claim_id");
      }
      for (const row of this.rowsIn(scopeId, "proposal_evidence", "proposal_id", work.proposalIds, "evidence_id")) {
        addRowString(work.evidenceIds, row, "evidence_id");
      }
      for (const row of this.rowsIn(scopeId, "claim_evidence", "claim_id", work.claimIds, "evidence_id")) {
        addRowString(work.evidenceIds, row, "evidence_id");
      }
    }

    for (const entityId of work.candidateEntityIds) {
      const aliases = this.rowsIn(scopeId, "aliases", "entity_id", new Set([entityId]), "alias_id");
      for (const row of aliases) addRowString(work.candidateAliasIds, row, "alias_id");
    }
    for (const aliasId of work.candidateAliasIds) work.aliasIds.add(aliasId);
    for (const entityId of work.candidateEntityIds) {
      if (this.hasClaimOutsideSet(scopeId, entityId, work.claimIds)) continue;
      work.entityIds.add(entityId);
    }
  }

  private pruneSharedEvidence(scopeId: string, work: DeletionWork): void {
    for (const evidenceId of [...work.evidenceIds]) {
      const claimReferences = this.queryRows(
        `SELECT claim_id FROM claim_evidence WHERE scope_id = ? AND evidence_id = ?`,
        [scopeId, evidenceId],
      );
      const proposalReferences = this.queryRows(
        `SELECT proposal_id FROM proposal_evidence WHERE scope_id = ? AND evidence_id = ?`,
        [scopeId, evidenceId],
      );
      const referencedOutsideDeletion = claimReferences.some((row) => !work.claimIds.has(requiredString(row, "claim_id"))) ||
        proposalReferences.some((row) => !work.proposalIds.has(requiredString(row, "proposal_id")));
      if (referencedOutsideDeletion) work.evidenceIds.delete(evidenceId);
    }
  }

  private pruneCandidateEntities(scopeId: string, work: DeletionWork): void {
    for (const entityId of work.candidateEntityIds) {
      if (!this.hasClaimOutsideSet(scopeId, entityId, work.claimIds)) work.entityIds.add(entityId);
    }
    for (const aliasId of [...work.aliasIds]) {
      if (work.candidateAliasIds.has(aliasId)) {
        const alias = this.repositories.getAlias(scopeId, aliasId);
        if (alias && !work.entityIds.has(alias.entityId) && !work.explicitAliasIds.has(aliasId)) work.aliasIds.delete(aliasId);
      }
    }
  }

  private addAliasesForDeletedEntities(scopeId: string, work: DeletionWork): void {
    for (const row of this.rowsIn(scopeId, "aliases", "entity_id", work.entityIds, "alias_id")) {
      addRowString(work.aliasIds, row, "alias_id");
    }
  }

  private hasClaimOutsideSet(scopeId: string, entityId: string, claimIds: Set<string>): boolean {
    const rows = this.queryRows(
      `SELECT claim_id FROM claims
       WHERE scope_id = ? AND (subject_entity_id = ? OR object_entity_id = ?)`,
      [scopeId, entityId, entityId],
    );
    return rows.some((row) => !claimIds.has(requiredString(row, "claim_id")));
  }

  private evidenceReferenceCount(scopeId: string, evidenceId: string): number {
    const claimCount = this.queryRows(
      `SELECT claim_id FROM claim_evidence WHERE scope_id = ? AND evidence_id = ?`,
      [scopeId, evidenceId],
    ).length;
    const proposalCount = this.queryRows(
      `SELECT proposal_id FROM proposal_evidence WHERE scope_id = ? AND evidence_id = ?`,
      [scopeId, evidenceId],
    ).length;
    return claimCount + proposalCount;
  }

  private makePreview(
    operation: "forget" | "purge",
    scopeId: string,
    work: DeletionSet,
    targetKind?: DeletionTargetKind,
    targetId?: string,
  ): KnowledgeGraphDeletionPreview {
    return {
      operation,
      scopeId,
      targetKind,
      targetId,
      counts: {
        entities: work.entityIds.size,
        aliases: work.aliasIds.size,
        evidence: work.evidenceIds.size,
        claims: work.claimIds.size,
        proposals: work.proposalIds.size,
        searchDocuments: this.countSearchDocuments(scopeId, work),
        claimEvidenceLinks: this.countLinkMatches(scopeId, "claim_evidence", "claim_id", work.claimIds, "evidence_id", work.evidenceIds),
        claimSupersessionLinks: this.countLinkMatches(scopeId, "claim_supersession", "prior_claim_id", work.claimIds, "replacement_claim_id", work.claimIds),
        proposalClaimLinks: this.countLinkMatches(scopeId, "proposal_claims", "proposal_id", work.proposalIds, "claim_id", work.claimIds),
        proposalEvidenceLinks: this.countLinkMatches(scopeId, "proposal_evidence", "proposal_id", work.proposalIds, "evidence_id", work.evidenceIds),
        proposalSupersessionLinks: this.countLinkMatches(scopeId, "proposal_supersession", "proposal_id", work.proposalIds, "prior_claim_id", work.claimIds),
      },
      sampleIds: {
        entities: sampleIds(work.entityIds),
        aliases: sampleIds(work.aliasIds),
        evidence: sampleIds(work.evidenceIds),
        claims: sampleIds(work.claimIds),
        proposals: sampleIds(work.proposalIds),
      },
    };
  }

  private countSearchDocuments(scopeId: string, work: DeletionSet): number {
    const keys = [
      ...[...work.entityIds].map((id) => `entity:${id}`),
      ...[...work.aliasIds].map((id) => `alias:${id}`),
      ...[...work.evidenceIds].map((id) => `evidence:${id}`),
      ...[...work.claimIds].map((id) => `claim:${id}`),
    ];
    return this.countByKeys(scopeId, "search_documents", "doc_key", keys);
  }

  private countLinkMatches(
    scopeId: string,
    table: "claim_evidence" | "claim_supersession" | "proposal_claims" | "proposal_evidence" | "proposal_supersession",
    firstColumn: string,
    firstIds: Set<string>,
    secondColumn: string,
    secondIds: Set<string>,
  ): number {
    const rows = this.queryRows(`SELECT ${firstColumn}, ${secondColumn} FROM ${table} WHERE scope_id = ?`, [scopeId]);
    return rows.filter((row) => firstIds.has(requiredString(row, firstColumn)) || secondIds.has(requiredString(row, secondColumn))).length;
  }

  private countByKeys(scopeId: string, table: "search_documents", column: string, keys: readonly string[]): number {
    if (keys.length === 0) return 0;
    let count = 0;
    for (const chunk of chunks(keys)) {
      const placeholders = chunk.map(() => "?").join(", ");
      const row = this.queryRows(
        `SELECT COUNT(*) AS count FROM ${table} WHERE scope_id = ? AND ${column} IN (${placeholders})`,
        [scopeId, ...chunk],
      )[0];
      if (row && typeof row.count === "number") count += row.count;
    }
    return count;
  }

  private deleteSet(scopeId: string, work: DeletionSet): void {
    this.deleteByColumn(scopeId, "claim_supersession", "prior_claim_id", work.claimIds);
    this.deleteByColumn(scopeId, "claim_supersession", "replacement_claim_id", work.claimIds);
    this.deleteByColumn(scopeId, "proposal_supersession", "proposal_id", work.proposalIds);
    this.deleteByColumn(scopeId, "proposal_supersession", "prior_claim_id", work.claimIds);
    this.deleteByColumn(scopeId, "claim_evidence", "claim_id", work.claimIds);
    this.deleteByColumn(scopeId, "claim_evidence", "evidence_id", work.evidenceIds);
    this.deleteByColumn(scopeId, "proposal_claims", "proposal_id", work.proposalIds);
    this.deleteByColumn(scopeId, "proposal_claims", "claim_id", work.claimIds);
    this.deleteByColumn(scopeId, "proposal_evidence", "proposal_id", work.proposalIds);
    this.deleteByColumn(scopeId, "proposal_evidence", "evidence_id", work.evidenceIds);
    this.deleteByColumn(scopeId, "claims", "claim_id", work.claimIds);
    this.deleteByColumn(scopeId, "aliases", "alias_id", work.aliasIds);
    this.deleteByColumn(scopeId, "entities", "entity_id", work.entityIds);
    this.deleteByColumn(scopeId, "evidence", "evidence_id", work.evidenceIds);
    this.deleteByColumn(scopeId, "proposals", "proposal_id", work.proposalIds);
  }

  private deleteByColumn(scopeId: string, table: DeletableTable, column: string, ids: Set<string>): void {
    for (const chunk of chunks([...ids])) {
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      this.database.prepare(
        `DELETE FROM ${table} WHERE scope_id = ? AND ${column} IN (${placeholders})`,
      ).run(scopeId, ...chunk);
    }
  }

  private rowsIn(
    scopeId: string,
    table: "claims" | "entities" | "aliases" | "proposals" | "proposal_evidence" | "claim_evidence",
    column: string,
    ids: Set<string>,
    selectedColumns: string,
  ): Row[] {
    const rows: Row[] = [];
    for (const chunk of chunks([...ids])) {
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      rows.push(...this.queryRows(
        `SELECT ${selectedColumns} FROM ${table} WHERE scope_id = ? AND ${column} IN (${placeholders})`,
        [scopeId, ...chunk],
      ));
    }
    return rows;
  }

  private queryRows(sql: string, parameters: readonly (string | number | null)[]): Row[] {
    return this.database.prepare(sql).all(...parameters).filter(isRow);
  }

  private previewIds(work: DeletionSet): string[] {
    return [
      ...sampleIds(work.entityIds),
      ...sampleIds(work.aliasIds),
      ...sampleIds(work.evidenceIds),
      ...sampleIds(work.claimIds),
      ...sampleIds(work.proposalIds),
    ].slice(0, 32);
  }

  private enforceAffectedLimit(work: DeletionSet): void {
    const total = work.entityIds.size + work.aliasIds.size + work.evidenceIds.size + work.claimIds.size + work.proposalIds.size;
    if (total > MAX_AFFECTED_RECORDS) {
      throw new KnowledgeGraphDeletionError(
        "too_many_rows",
        `The operation would affect more than ${MAX_AFFECTED_RECORDS} canonical records; use a narrower target.`,
      );
    }
  }

  private notFound(): never {
    throw new KnowledgeGraphDeletionError("not_found", "The requested knowledge record is not visible in this scope.");
  }
}

function deletionMetadata(
  preview: KnowledgeGraphDeletionPreview,
  reason: string | undefined,
  additional: Record<string, boolean> = {},
): string {
  return JSON.stringify({
    counts: preview.counts,
    ...additional,
    ...(reason === undefined ? {} : { reason }),
  });
}

function normalizeReason(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || [...value].length > MAX_REASON_LENGTH) {
    throw new KnowledgeGraphDeletionError("invalid_target", "Deletion reason must be a bounded non-empty string.");
  }
  assertNoSecrets([{ field: "reason", text: value }]);
  return value;
}

function createDeletionWork(): DeletionWork {
  return {
    entityIds: new Set(),
    aliasIds: new Set(),
    evidenceIds: new Set(),
    claimIds: new Set(),
    proposalIds: new Set(),
    rootEntityIds: new Set(),
    candidateEntityIds: new Set(),
    candidateAliasIds: new Set(),
    explicitAliasIds: new Set(),
  };
}

function classifyTarget(value: unknown): DeletionTargetKind {
  if (typeof value !== "string" || value.length > 64) {
    throw new KnowledgeGraphDeletionError("invalid_target", "A stable entity, alias, evidence, claim, or proposal ID is required.");
  }
  const patterns: readonly [DeletionTargetKind, RegExp][] = [
    ["entity", new RegExp(`^ent_${UUID_SUFFIX}$`, "u")],
    ["alias", new RegExp(`^als_${UUID_SUFFIX}$`, "u")],
    ["evidence", new RegExp(`^evd_${UUID_SUFFIX}$`, "u")],
    ["claim", new RegExp(`^clm_${UUID_SUFFIX}$`, "u")],
    ["proposal", new RegExp(`^prp_${UUID_SUFFIX}$`, "u")],
  ];
  const match = patterns.find(([, pattern]) => pattern.test(value));
  if (!match) {
    throw new KnowledgeGraphDeletionError("invalid_target", "A stable entity, alias, evidence, claim, or proposal ID is required.");
  }
  return match[0];
}

function deletionSetSize(work: DeletionSet): number {
  return work.entityIds.size + work.aliasIds.size + work.evidenceIds.size + work.claimIds.size + work.proposalIds.size;
}

function addRowString(target: Set<string>, row: Row, key: string): void {
  const value = row[key];
  if (typeof value === "string") target.add(value);
}

function addOptionalRowString(target: Set<string>, row: Row, key: string): void {
  const value = row[key];
  if (typeof value === "string") target.add(value);
}

function requiredString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Knowledge-graph deletion query returned invalid ${key}.`);
  return value;
}

function sampleIds(ids: Set<string>): readonly string[] {
  return [...ids].sort().slice(0, PREVIEW_SAMPLE_SIZE);
}

function chunks(values: readonly string[]): readonly (readonly string[])[] {
  const result: (readonly string[])[] = [];
  for (let index = 0; index < values.length; index += QUERY_CHUNK_SIZE) {
    result.push(values.slice(index, index + QUERY_CHUNK_SIZE));
  }
  return result;
}

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

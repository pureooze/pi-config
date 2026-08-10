import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type ScopeId = string;
export type ScopeKind = "global" | "project";
export type EntityType =
  | "person"
  | "project"
  | "repository"
  | "service"
  | "tool"
  | "organization"
  | "location"
  | "preference"
  | "concept"
  | "other";
export type EntityStatus = "proposed" | "accepted" | "rejected";
export type ClaimStatus = "proposed" | "accepted" | "rejected" | "superseded";
export type EvidenceRole = "primary" | "supporting";
export type SourceKind = "user_statement" | "pi_session" | "file" | "command" | "url" | "other";
export type TrustClass = "user" | "agent" | "local_file" | "local_command" | "external" | "unknown";
export type ActorType = "user" | "agent" | "system";
export type AuditAction =
  | "proposal_created"
  | "proposal_reviewed"
  | "acceptance"
  | "rejection"
  | "correction"
  | "supersession"
  | "export"
  | "forget"
  | "purge"
  | "migration"
  | "recovery";
export type AuditTargetType =
  | "scope"
  | "entity"
  | "alias"
  | "evidence"
  | "claim"
  | "proposal"
  | "audit_event"
  | "system";
export type ProposalStatus = "pending" | "accepted" | "rejected" | "cancelled";
export type StableIdKind = "entity" | "alias" | "evidence" | "claim" | "proposal" | "audit_event";

export interface KnowledgeGraphIdFactory {
  next(kind: StableIdKind): string;
}

export interface ScopeRecord {
  readonly scopeId: string;
  readonly kind: ScopeKind;
  readonly projectRoot: string | undefined;
  readonly identityPath: string | undefined;
  readonly createdAt: number;
}

export interface RegisterScopeInput {
  readonly scopeId: string;
  readonly kind: ScopeKind;
  readonly projectRoot?: string;
  readonly identityPath?: string;
}

export interface CreateEntityInput {
  readonly entityId?: string;
  readonly label: string;
  readonly type: EntityType;
  readonly status?: EntityStatus;
  readonly proposalId?: string;
}

export interface EntityRecord {
  readonly entityId: string;
  readonly scopeId: string;
  readonly label: string;
  readonly normalizedLabel: string;
  readonly type: EntityType;
  readonly status: EntityStatus;
  readonly createdAt: number;
  readonly reviewedAt: number | undefined;
  readonly proposalId: string | undefined;
}

export interface CreateAliasInput {
  readonly aliasId?: string;
  readonly entityId: string;
  readonly alias: string;
  readonly status?: EntityStatus;
  readonly proposalId?: string;
}

export interface AliasRecord {
  readonly aliasId: string;
  readonly scopeId: string;
  readonly entityId: string;
  readonly alias: string;
  readonly normalizedAlias: string;
  readonly status: EntityStatus;
  readonly createdAt: number;
  readonly reviewedAt: number | undefined;
  readonly proposalId: string | undefined;
}

export interface EvidenceProvenance {
  readonly sessionId?: string;
  readonly sessionEntryId?: string;
  readonly toolCallId?: string;
  readonly branchLeaf?: string;
  readonly actorType?: ActorType;
}

export interface CreateEvidenceInput extends EvidenceProvenance {
  readonly evidenceId?: string;
  readonly sourceKind: SourceKind;
  readonly locator?: string;
  readonly excerpt: string;
  readonly sourceObservedAt?: number;
  readonly trustClass: TrustClass;
}

export interface EvidenceRecord extends EvidenceProvenance {
  readonly evidenceId: string;
  readonly scopeId: string;
  readonly sourceKind: SourceKind;
  readonly locator: string | undefined;
  readonly excerpt: string;
  readonly excerptHash: string;
  readonly capturedAt: number;
  readonly sourceObservedAt: number | undefined;
  readonly trustClass: TrustClass;
}

export type ClaimObject =
  | { readonly kind: "entity"; readonly entityId: string }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "date"; readonly value: string }
  | { readonly kind: "url"; readonly value: string };

export interface CreateClaimInput {
  readonly claimId?: string;
  readonly subjectEntityId: string;
  readonly predicate: string;
  readonly object: ClaimObject;
  readonly status?: ClaimStatus;
  readonly observedAt?: number;
  readonly validFrom?: number;
  readonly validTo?: number;
  readonly proposalId?: string;
}

export interface ClaimRecord {
  readonly claimId: string;
  readonly scopeId: string;
  readonly status: ClaimStatus;
  readonly subjectEntityId: string;
  readonly predicate: string;
  readonly object: ClaimObject;
  readonly observedAt: number;
  readonly validFrom: number | undefined;
  readonly validTo: number | undefined;
  readonly createdAt: number;
  readonly reviewedAt: number | undefined;
  readonly proposalId: string | undefined;
}

export interface AttachEvidenceInput {
  readonly claimId: string;
  readonly evidenceId: string;
  readonly role?: EvidenceRole;
}

export interface ClaimEvidenceRecord {
  readonly claimId: string;
  readonly evidenceId: string;
  readonly scopeId: string;
  readonly role: EvidenceRole;
  readonly evidence: EvidenceRecord;
}

export interface SupersedeClaimInput {
  readonly priorClaimId: string;
  readonly replacementClaimId: string;
  readonly reason?: string;
}

export interface SupersessionLinkRecord {
  readonly scopeId: string;
  readonly priorClaimId: string;
  readonly replacementClaimId: string;
  readonly reason: string | undefined;
  readonly createdAt: number;
}

export interface AppendAuditEventInput {
  readonly auditEventId?: string;
  readonly actorType: ActorType;
  readonly action: AuditAction;
  readonly targetType: AuditTargetType;
  readonly targetId?: string;
  readonly sessionId?: string;
  readonly sessionEntryId?: string;
  readonly toolCallId?: string;
  readonly branchLeaf?: string;
  readonly beforeIds?: readonly string[];
  readonly afterIds?: readonly string[];
  readonly metadataJson?: string;
}

export interface AuditEventRecord extends EvidenceProvenance {
  readonly auditEventId: string;
  readonly scopeId: string;
  readonly actorType: ActorType;
  readonly action: AuditAction;
  readonly targetType: AuditTargetType;
  readonly targetId: string | undefined;
  readonly occurredAt: number;
  readonly beforeIds: readonly string[];
  readonly afterIds: readonly string[];
  readonly metadataJson: string;
}

export interface CreateProposalInput extends EvidenceProvenance {
  readonly proposalId?: string;
  readonly candidateFingerprint: string;
  readonly idempotencyKey?: string;
  readonly actorType: ActorType;
}

export interface LinkProposalSupersessionInput {
  readonly priorClaimId: string;
  readonly reason?: string;
}

export interface ProposalRecord extends EvidenceProvenance {
  readonly proposalId: string;
  readonly scopeId: string;
  readonly status: ProposalStatus;
  readonly candidateFingerprint: string;
  readonly idempotencyKey: string | undefined;
  readonly actorType: ActorType;
  readonly createdAt: number;
  readonly reviewedAt: number | undefined;
}

export interface ProposalSupersessionRecord {
  readonly scopeId: string;
  readonly proposalId: string;
  readonly priorClaimId: string;
  readonly reason: string | undefined;
}

export interface ProposalIdentityLookup {
  readonly candidateFingerprint?: string;
  readonly idempotencyKey?: string;
}

export interface ProposalCandidateRecords {
  readonly entities: readonly EntityRecord[];
  readonly aliases: readonly AliasRecord[];
  readonly claims: readonly ClaimRecord[];
  readonly evidence: readonly EvidenceRecord[];
}

export interface ReviewProposalInput {
  readonly decision: "accepted" | "rejected" | "cancelled";
  readonly actorType: ActorType;
  readonly sessionId?: string;
  readonly sessionEntryId?: string;
  readonly toolCallId?: string;
  readonly branchLeaf?: string;
}

export interface KnowledgeGraphRepositoriesOptions {
  readonly now?: () => number;
  readonly idFactory?: KnowledgeGraphIdFactory;
}

export type RepositoryErrorCode =
  | "invalid_input"
  | "invalid_scope"
  | "scope_not_found"
  | "scope_conflict"
  | "idempotency_conflict"
  | "not_found"
  | "duplicate"
  | "storage_error"
  | "corrupt_row";

export class KnowledgeGraphRepositoryError extends Error {
  readonly code: RepositoryErrorCode;

  constructor(code: RepositoryErrorCode, message: string) {
    super(message);
    this.name = "KnowledgeGraphRepositoryError";
    this.code = code;
  }
}

type SqlValue = string | number | null;
type Row = Record<string, unknown>;

const UUID_SUFFIX = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const SCOPE_ID_PATTERN = /^global$|^project:[0-9a-f]{64}$/u;
const PREDICATE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/u;
const MAX_LABEL_LENGTH = 256;
const MAX_LOCATOR_LENGTH = 2_048;
const MAX_EXCERPT_LENGTH = 4_000;
const MAX_TEXT_OBJECT_LENGTH = 2_048;
const MAX_URL_LENGTH = 1_024;
const MAX_PROVENANCE_LENGTH = 512;
const MAX_REASON_LENGTH = 2_048;
const MAX_METADATA_LENGTH = 8_192;
const MAX_AUDIT_REFERENCE_COUNT = 32;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export function computeEvidenceHash(excerpt: string): string {
  return createHash("sha256").update(excerpt, "utf8").digest("hex");
}

export function computeCandidateFingerprint(normalizedCandidate: string): string {
  if (typeof normalizedCandidate !== "string" || normalizedCandidate.length === 0) {
    throw repositoryError("invalid_input", "A candidate fingerprint input must be non-empty.");
  }
  return createHash("sha256").update(normalizedCandidate, "utf8").digest("hex");
}

function stableIdPrefix(kind: StableIdKind): string {
  switch (kind) {
    case "entity": return "ent_";
    case "alias": return "als_";
    case "evidence": return "evd_";
    case "claim": return "clm_";
    case "proposal": return "prp_";
    case "audit_event": return "aud_";
  }
}

export class KnowledgeGraphRepositories {
  private readonly database: DatabaseSync;
  private readonly now: () => number;
  private readonly idFactory: KnowledgeGraphIdFactory;

  constructor(
    database: DatabaseSync,
    options: KnowledgeGraphRepositoriesOptions = {},
  ) {
    this.database = database;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? { next: (kind) => `${stableIdPrefix(kind)}${randomUUID()}` };
  }

  registerScope(input: RegisterScopeInput): ScopeRecord {
    const scopeId = validateScopeId(input.scopeId);
    validateScopeKind(scopeId, input.kind);
    const projectRoot = optionalText(input.projectRoot, "projectRoot", MAX_PROVENANCE_LENGTH);
    const identityPath = optionalText(input.identityPath, "identityPath", MAX_PROVENANCE_LENGTH);

    if (input.kind === "global" && (projectRoot !== undefined || identityPath !== undefined)) {
      throw repositoryError("invalid_input", "Global scope metadata must be omitted.");
    }

    const existing = this.getScope(scopeId);
    if (existing) {
      if (existing.kind !== input.kind ||
        (projectRoot !== undefined && existing.projectRoot !== projectRoot) ||
        (identityPath !== undefined && existing.identityPath !== identityPath)) {
        throw repositoryError("scope_conflict", "Scope metadata conflicts with the registered scope.");
      }
      return existing;
    }

    this.run(
      `INSERT INTO scopes(scope_id, kind, project_root, identity_path, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [scopeId, input.kind, projectRoot ?? null, identityPath ?? null, this.timestamp()],
    );
    return this.requireScopeRecord(scopeId);
  }

  getScope(scopeId: string): ScopeRecord | undefined {
    const validScopeId = validateScopeId(scopeId);
    const row = this.getRow(
      `SELECT scope_id, kind, project_root, identity_path, created_at
       FROM scopes
       WHERE scope_id = ?`,
      [validScopeId],
    );
    return row ? mapScope(row) : undefined;
  }

  listScopes(): ScopeRecord[] {
    return this.getRows(
      `SELECT scope_id, kind, project_root, identity_path, created_at
       FROM scopes
       ORDER BY scope_id`,
      [],
    ).map(mapScope);
  }

  createEntity(scopeId: string, input: CreateEntityInput): EntityRecord {
    const validScopeId = this.requireScope(scopeId);
    const entityId = this.resolveId(input.entityId, "entity", "ent_", "entityId");
    const label = requiredText(input.label, "label", MAX_LABEL_LENGTH);
    const normalizedLabel = normalizeLookupText(label, "label");
    const type = validateEntityType(input.type);
    const status = validateEntityStatus(input.status ?? "proposed");
    const proposalId = optionalId(input.proposalId, "prp_", "proposalId");

    this.run(
      `INSERT INTO entities(
         entity_id, scope_id, label, normalized_label, entity_type, status,
         created_at, reviewed_at, proposal_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [entityId, validScopeId, label, normalizedLabel, type, status, this.timestamp(), null, proposalId ?? null],
    );
    return this.requireEntityRecord(validScopeId, entityId);
  }

  getEntity(scopeId: string, entityId: string): EntityRecord | undefined {
    const validScopeId = validateScopeId(scopeId);
    const validEntityId = validateId(entityId, "ent_", "entityId");
    const row = this.getRow(
      `SELECT entity_id, scope_id, label, normalized_label, entity_type, status,
              created_at, reviewed_at, proposal_id
       FROM entities
       WHERE scope_id = ? AND entity_id = ?`,
      [validScopeId, validEntityId],
    );
    return row ? mapEntity(row) : undefined;
  }

  listEntities(scopeId: string, status?: EntityStatus): EntityRecord[] {
    const validScopeId = this.requireScope(scopeId);
    const validStatus = status === undefined ? undefined : validateEntityStatus(status);
    const rows = validStatus === undefined
      ? this.getRows(
        `SELECT entity_id, scope_id, label, normalized_label, entity_type, status,
                created_at, reviewed_at, proposal_id
         FROM entities
         WHERE scope_id = ?
         ORDER BY entity_id`,
        [validScopeId],
      )
      : this.getRows(
        `SELECT entity_id, scope_id, label, normalized_label, entity_type, status,
                created_at, reviewed_at, proposal_id
         FROM entities
         WHERE scope_id = ? AND status = ?
         ORDER BY entity_id`,
        [validScopeId, validStatus],
      );
    return rows.map(mapEntity);
  }

  createAlias(scopeId: string, input: CreateAliasInput): AliasRecord {
    const validScopeId = this.requireScope(scopeId);
    const aliasId = this.resolveId(input.aliasId, "alias", "als_", "aliasId");
    const entityId = validateId(input.entityId, "ent_", "entityId");
    const alias = requiredText(input.alias, "alias", MAX_LABEL_LENGTH);
    const normalizedAlias = normalizeLookupText(alias, "alias");
    const status = validateEntityStatus(input.status ?? "proposed");
    const proposalId = optionalId(input.proposalId, "prp_", "proposalId");

    if (!this.getEntity(validScopeId, entityId)) {
      throw repositoryError("not_found", "Entity does not exist in the requested scope.");
    }
    if (status === "accepted" && this.hasAcceptedAlias(validScopeId, normalizedAlias)) {
      throw repositoryError("duplicate", "An accepted alias already exists in the requested scope.");
    }

    this.run(
      `INSERT INTO aliases(
         alias_id, scope_id, entity_id, alias, normalized_alias, status,
         created_at, reviewed_at, proposal_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [aliasId, validScopeId, entityId, alias, normalizedAlias, status, this.timestamp(), null, proposalId ?? null],
    );
    return this.requireAliasRecord(validScopeId, aliasId);
  }

  getAlias(scopeId: string, aliasId: string): AliasRecord | undefined {
    const validScopeId = validateScopeId(scopeId);
    const validAliasId = validateId(aliasId, "als_", "aliasId");
    const row = this.getRow(
      `SELECT alias_id, scope_id, entity_id, alias, normalized_alias, status,
              created_at, reviewed_at, proposal_id
       FROM aliases
       WHERE scope_id = ? AND alias_id = ?`,
      [validScopeId, validAliasId],
    );
    return row ? mapAlias(row) : undefined;
  }

  listAliases(scopeId: string, status?: EntityStatus): AliasRecord[] {
    const validScopeId = this.requireScope(scopeId);
    const validStatus = status === undefined ? undefined : validateEntityStatus(status);
    const rows = validStatus === undefined
      ? this.getRows(
        `SELECT alias_id, scope_id, entity_id, alias, normalized_alias, status,
                created_at, reviewed_at, proposal_id
         FROM aliases
         WHERE scope_id = ?
         ORDER BY alias_id`,
        [validScopeId],
      )
      : this.getRows(
        `SELECT alias_id, scope_id, entity_id, alias, normalized_alias, status,
                created_at, reviewed_at, proposal_id
         FROM aliases
         WHERE scope_id = ? AND status = ?
         ORDER BY alias_id`,
        [validScopeId, validStatus],
      );
    return rows.map(mapAlias);
  }

  createEvidence(scopeId: string, input: CreateEvidenceInput): EvidenceRecord {
    const validScopeId = this.requireScope(scopeId);
    const sourceKind = validateSourceKind(input.sourceKind);
    const locator = optionalText(input.locator, "locator", MAX_LOCATOR_LENGTH);
    const excerpt = requiredText(input.excerpt, "excerpt", MAX_EXCERPT_LENGTH);
    const sourceObservedAt = optionalTimestamp(input.sourceObservedAt, "sourceObservedAt");
    const trustClass = validateTrustClass(input.trustClass);
    const sessionId = optionalText(input.sessionId, "sessionId", MAX_PROVENANCE_LENGTH);
    const sessionEntryId = optionalText(input.sessionEntryId, "sessionEntryId", MAX_PROVENANCE_LENGTH);
    const toolCallId = optionalText(input.toolCallId, "toolCallId", MAX_PROVENANCE_LENGTH);
    const branchLeaf = optionalText(input.branchLeaf, "branchLeaf", MAX_PROVENANCE_LENGTH);
    const actorType = input.actorType === undefined ? undefined : validateActorType(input.actorType);
    const excerptHash = computeEvidenceHash(excerpt);
    const existing = this.findEvidenceByIdentity(validScopeId, excerptHash, sourceKind, locator, trustClass);
    if (existing) return existing;

    const evidenceId = this.resolveId(input.evidenceId, "evidence", "evd_", "evidenceId");
    const capturedAt = this.timestamp();
    try {
      this.run(
        `INSERT INTO evidence(
           evidence_id, scope_id, source_kind, locator, excerpt, excerpt_hash,
           captured_at, source_observed_at, trust_class, session_id, session_entry_id,
           tool_call_id, branch_leaf, actor_type
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          evidenceId,
          validScopeId,
          sourceKind,
          locator ?? null,
          excerpt,
          excerptHash,
          capturedAt,
          sourceObservedAt ?? null,
          trustClass,
          sessionId ?? null,
          sessionEntryId ?? null,
          toolCallId ?? null,
          branchLeaf ?? null,
          actorType ?? null,
        ],
      );
    } catch (error) {
      if (error instanceof KnowledgeGraphRepositoryError && error.code === "duplicate") {
        const concurrent = this.findEvidenceByIdentity(validScopeId, excerptHash, sourceKind, locator, trustClass);
        if (concurrent) return concurrent;
      }
      throw error;
    }
    return this.requireEvidenceRecord(validScopeId, evidenceId);
  }

  getEvidence(scopeId: string, evidenceId: string): EvidenceRecord | undefined {
    const validScopeId = validateScopeId(scopeId);
    const validEvidenceId = validateId(evidenceId, "evd_", "evidenceId");
    const row = this.getRow(
      `SELECT evidence_id, scope_id, source_kind, locator, excerpt, excerpt_hash,
              captured_at, source_observed_at, trust_class, session_id, session_entry_id,
              tool_call_id, branch_leaf, actor_type
       FROM evidence
       WHERE scope_id = ? AND evidence_id = ?`,
      [validScopeId, validEvidenceId],
    );
    return row ? mapEvidence(row) : undefined;
  }

  listEvidence(scopeId: string): EvidenceRecord[] {
    const validScopeId = this.requireScope(scopeId);
    return this.getRows(
      `SELECT evidence_id, scope_id, source_kind, locator, excerpt, excerpt_hash,
              captured_at, source_observed_at, trust_class, session_id, session_entry_id,
              tool_call_id, branch_leaf, actor_type
       FROM evidence
       WHERE scope_id = ?
       ORDER BY evidence_id`,
      [validScopeId],
    ).map(mapEvidence);
  }

  createClaim(scopeId: string, input: CreateClaimInput): ClaimRecord {
    const validScopeId = this.requireScope(scopeId);
    const claimId = this.resolveId(input.claimId, "claim", "clm_", "claimId");
    const subjectEntityId = validateId(input.subjectEntityId, "ent_", "subjectEntityId");
    if (!this.getEntity(validScopeId, subjectEntityId)) {
      throw repositoryError("not_found", "Subject entity does not exist in the requested scope.");
    }

    const predicate = validatePredicate(input.predicate);
    const object = normalizeClaimObject(input.object);
    if (object.kind === "entity" && !this.getEntity(validScopeId, object.entityId)) {
      throw repositoryError("not_found", "Object entity does not exist in the requested scope.");
    }
    const status = validateClaimStatus(input.status ?? "proposed");
    const validFrom = optionalTimestamp(input.validFrom, "validFrom");
    const validTo = optionalTimestamp(input.validTo, "validTo");
    if (validFrom !== undefined && validTo !== undefined && validTo <= validFrom) {
      throw repositoryError("invalid_input", "validTo must be later than validFrom.");
    }
    const proposalId = optionalId(input.proposalId, "prp_", "proposalId");
    const observedAt = input.observedAt === undefined
      ? this.timestamp()
      : validateTimestamp(input.observedAt, "observedAt");
    const createdAt = this.timestamp();

    this.run(
      `INSERT INTO claims(
         claim_id, scope_id, status, subject_entity_id, predicate, object_kind,
         object_entity_id, object_text, object_number, object_boolean, object_date,
         object_url, observed_at, valid_from, valid_to, created_at, reviewed_at, proposal_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        claimId,
        validScopeId,
        status,
        subjectEntityId,
        predicate,
        object.kind,
        object.kind === "entity" ? object.entityId : null,
        object.kind === "text" ? object.value : null,
        object.kind === "number" ? object.value : null,
        object.kind === "boolean" ? (object.value ? 1 : 0) : null,
        object.kind === "date" ? object.value : null,
        object.kind === "url" ? object.value : null,
        observedAt,
        validFrom ?? null,
        validTo ?? null,
        createdAt,
        null,
        proposalId ?? null,
      ],
    );
    return this.requireClaimRecord(validScopeId, claimId);
  }

  getClaim(scopeId: string, claimId: string): ClaimRecord | undefined {
    const validScopeId = validateScopeId(scopeId);
    const validClaimId = validateId(claimId, "clm_", "claimId");
    const row = this.getRow(claimSelectSql + " WHERE scope_id = ? AND claim_id = ?", [validScopeId, validClaimId]);
    return row ? mapClaim(row) : undefined;
  }

  listClaims(scopeId: string, status?: ClaimStatus): ClaimRecord[] {
    const validScopeId = this.requireScope(scopeId);
    const validStatus = status === undefined ? undefined : validateClaimStatus(status);
    const rows = validStatus === undefined
      ? this.getRows(claimSelectSql + " WHERE scope_id = ? ORDER BY claim_id", [validScopeId])
      : this.getRows(claimSelectSql + " WHERE scope_id = ? AND status = ? ORDER BY claim_id", [validScopeId, validStatus]);
    return rows.map(mapClaim);
  }

  attachEvidence(scopeId: string, input: AttachEvidenceInput): ClaimEvidenceRecord {
    const validScopeId = this.requireScope(scopeId);
    const claimId = validateId(input.claimId, "clm_", "claimId");
    const evidenceId = validateId(input.evidenceId, "evd_", "evidenceId");
    const role = validateEvidenceRole(input.role ?? "supporting");
    if (!this.getClaim(validScopeId, claimId)) {
      throw repositoryError("not_found", "Claim does not exist in the requested scope.");
    }
    if (!this.getEvidence(validScopeId, evidenceId)) {
      throw repositoryError("not_found", "Evidence does not exist in the requested scope.");
    }

    this.run(
      `INSERT INTO claim_evidence(scope_id, claim_id, evidence_id, evidence_role)
       VALUES (?, ?, ?, ?)`,
      [validScopeId, claimId, evidenceId, role],
    );
    return this.requireClaimEvidenceRecord(validScopeId, claimId, evidenceId);
  }

  listClaimEvidence(scopeId: string, claimId: string): ClaimEvidenceRecord[] {
    const validScopeId = this.requireScope(scopeId);
    const validClaimId = validateId(claimId, "clm_", "claimId");
    if (!this.getClaim(validScopeId, validClaimId)) {
      throw repositoryError("not_found", "Claim does not exist in the requested scope.");
    }
    return this.getRows(
      `SELECT ce.claim_id, ce.evidence_id, ce.scope_id, ce.evidence_role,
              e.evidence_id AS e_evidence_id, e.scope_id AS e_scope_id,
              e.source_kind, e.locator, e.excerpt, e.excerpt_hash,
              e.captured_at, e.source_observed_at, e.trust_class,
              e.session_id, e.session_entry_id, e.tool_call_id, e.branch_leaf,
              e.actor_type
       FROM claim_evidence AS ce
       JOIN evidence AS e
         ON e.evidence_id = ce.evidence_id AND e.scope_id = ce.scope_id
       WHERE ce.scope_id = ? AND ce.claim_id = ?
       ORDER BY ce.evidence_id`,
      [validScopeId, validClaimId],
    ).map(mapClaimEvidence);
  }

  supersedeClaim(scopeId: string, input: SupersedeClaimInput): SupersessionLinkRecord {
    const validScopeId = this.requireScope(scopeId);
    const priorClaimId = validateId(input.priorClaimId, "clm_", "priorClaimId");
    const replacementClaimId = validateId(input.replacementClaimId, "clm_", "replacementClaimId");
    if (priorClaimId === replacementClaimId) {
      throw repositoryError("invalid_input", "A claim cannot supersede itself.");
    }
    const priorClaim = this.getClaim(validScopeId, priorClaimId);
    const replacementClaim = this.getClaim(validScopeId, replacementClaimId);
    if (!priorClaim || !replacementClaim) {
      throw repositoryError("not_found", "Both claims must exist in the requested scope.");
    }
    if (priorClaim.status === "superseded") {
      throw repositoryError("invalid_input", "The prior claim is already superseded.");
    }
    const reason = optionalText(input.reason, "reason", MAX_REASON_LENGTH);
    const createdAt = this.timestamp();

    this.withTransaction(() => {
      this.run(
        `INSERT INTO claim_supersession(
           scope_id, prior_claim_id, replacement_claim_id, reason, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
        [validScopeId, priorClaimId, replacementClaimId, reason ?? null, createdAt],
      );
      this.run(
        `UPDATE claims
         SET status = 'superseded', reviewed_at = ?
         WHERE scope_id = ? AND claim_id = ?`,
        [createdAt, validScopeId, priorClaimId],
      );
    });

    return this.requireSupersessionRecord(validScopeId, priorClaimId, replacementClaimId);
  }

  getSupersession(
    scopeId: string,
    priorClaimId: string,
    replacementClaimId: string,
  ): SupersessionLinkRecord | undefined {
    const validScopeId = validateScopeId(scopeId);
    const validPriorClaimId = validateId(priorClaimId, "clm_", "priorClaimId");
    const validReplacementClaimId = validateId(replacementClaimId, "clm_", "replacementClaimId");
    const row = this.getRow(
      `SELECT scope_id, prior_claim_id, replacement_claim_id, reason, created_at
       FROM claim_supersession
       WHERE scope_id = ? AND prior_claim_id = ? AND replacement_claim_id = ?`,
      [validScopeId, validPriorClaimId, validReplacementClaimId],
    );
    return row ? mapSupersession(row) : undefined;
  }

  createProposal(scopeId: string, input: CreateProposalInput): ProposalRecord {
    const validScopeId = this.requireScope(scopeId);
    const candidateFingerprint = validateFingerprint(input.candidateFingerprint, "candidateFingerprint");
    const idempotencyKey = optionalText(input.idempotencyKey, "idempotencyKey", MAX_IDEMPOTENCY_KEY_LENGTH);
    const actorType = validateActorType(input.actorType);
    const sessionId = optionalText(input.sessionId, "sessionId", MAX_PROVENANCE_LENGTH);
    const sessionEntryId = optionalText(input.sessionEntryId, "sessionEntryId", MAX_PROVENANCE_LENGTH);
    const toolCallId = optionalText(input.toolCallId, "toolCallId", MAX_PROVENANCE_LENGTH);
    const branchLeaf = optionalText(input.branchLeaf, "branchLeaf", MAX_PROVENANCE_LENGTH);

    const existingByKey = idempotencyKey === undefined
      ? undefined
      : this.findProposalByIdempotencyKey(validScopeId, idempotencyKey);
    if (existingByKey) {
      if (existingByKey.candidateFingerprint !== candidateFingerprint) {
        throw repositoryError("idempotency_conflict", "The idempotency key was already used for another proposal.");
      }
      return existingByKey;
    }
    const existingByFingerprint = this.findProposalByFingerprint(validScopeId, candidateFingerprint);
    if (existingByFingerprint) return existingByFingerprint;

    const proposalId = this.resolveId(input.proposalId, "proposal", "prp_", "proposalId");
    const createdAt = this.timestamp();
    try {
      this.run(
        `INSERT INTO proposals(
           proposal_id, scope_id, status, candidate_fingerprint, idempotency_key,
           actor_type, created_at, reviewed_at, session_id, session_entry_id,
           tool_call_id, branch_leaf
         ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          proposalId,
          validScopeId,
          candidateFingerprint,
          idempotencyKey ?? null,
          actorType,
          createdAt,
          null,
          sessionId ?? null,
          sessionEntryId ?? null,
          toolCallId ?? null,
          branchLeaf ?? null,
        ],
      );
    } catch (error) {
      if (error instanceof KnowledgeGraphRepositoryError && error.code === "duplicate") {
        const concurrentByKey = idempotencyKey === undefined
          ? undefined
          : this.findProposalByIdempotencyKey(validScopeId, idempotencyKey);
        if (concurrentByKey) {
          if (concurrentByKey.candidateFingerprint !== candidateFingerprint) {
            throw repositoryError("idempotency_conflict", "The idempotency key was already used for another proposal.");
          }
          return concurrentByKey;
        }
        const concurrentByFingerprint = this.findProposalByFingerprint(validScopeId, candidateFingerprint);
        if (concurrentByFingerprint) return concurrentByFingerprint;
      }
      throw error;
    }
    return this.requireProposalRecord(validScopeId, proposalId);
  }

  getProposal(scopeId: string, proposalId: string): ProposalRecord | undefined {
    const validScopeId = validateScopeId(scopeId);
    const validProposalId = validateId(proposalId, "prp_", "proposalId");
    const row = this.getRow(proposalSelectSql + " WHERE scope_id = ? AND proposal_id = ?", [validScopeId, validProposalId]);
    return row ? mapProposal(row) : undefined;
  }

  listProposals(scopeId: string, status?: ProposalStatus): ProposalRecord[] {
    const validScopeId = this.requireScope(scopeId);
    const validStatus = status === undefined ? undefined : validateProposalStatus(status);
    const rows = validStatus === undefined
      ? this.getRows(proposalSelectSql + " WHERE scope_id = ? ORDER BY proposal_id", [validScopeId])
      : this.getRows(proposalSelectSql + " WHERE scope_id = ? AND status = ? ORDER BY proposal_id", [validScopeId, validStatus]);
    return rows.map(mapProposal);
  }

  findProposal(scopeId: string, lookup: ProposalIdentityLookup): ProposalRecord | undefined {
    const validScopeId = this.requireScope(scopeId);
    const candidateFingerprint = lookup.candidateFingerprint === undefined
      ? undefined
      : validateFingerprint(lookup.candidateFingerprint, "candidateFingerprint");
    const idempotencyKey = lookup.idempotencyKey === undefined
      ? undefined
      : requiredText(lookup.idempotencyKey, "idempotencyKey", MAX_IDEMPOTENCY_KEY_LENGTH);
    if (candidateFingerprint === undefined && idempotencyKey === undefined) {
      throw repositoryError("invalid_input", "A proposal fingerprint or idempotency key is required.");
    }
    if (idempotencyKey !== undefined) {
      const byKey = this.findProposalByIdempotencyKey(validScopeId, idempotencyKey);
      if (byKey) {
        if (candidateFingerprint !== undefined && byKey.candidateFingerprint !== candidateFingerprint) {
          throw repositoryError("idempotency_conflict", "The idempotency key was already used for another proposal.");
        }
        return byKey;
      }
    }
    return candidateFingerprint === undefined
      ? undefined
      : this.findProposalByFingerprint(validScopeId, candidateFingerprint);
  }

  getProposalCandidates(scopeId: string, proposalId: string): ProposalCandidateRecords {
    const validScopeId = this.requireScope(scopeId);
    const validProposalId = validateId(proposalId, "prp_", "proposalId");
    if (!this.getProposal(validScopeId, validProposalId)) {
      throw repositoryError("not_found", "Proposal does not exist in the requested scope.");
    }
    return {
      entities: this.getRows(
        `SELECT entity_id, scope_id, label, normalized_label, entity_type, status,
                created_at, reviewed_at, proposal_id
         FROM entities WHERE scope_id = ? AND proposal_id = ? ORDER BY entity_id`,
        [validScopeId, validProposalId],
      ).map(mapEntity),
      aliases: this.getRows(
        `SELECT alias_id, scope_id, entity_id, alias, normalized_alias, status,
                created_at, reviewed_at, proposal_id
         FROM aliases WHERE scope_id = ? AND proposal_id = ? ORDER BY alias_id`,
        [validScopeId, validProposalId],
      ).map(mapAlias),
      claims: this.getRows(claimSelectSql + " WHERE scope_id = ? AND proposal_id = ? ORDER BY claim_id", [validScopeId, validProposalId]).map(mapClaim),
      evidence: this.getRows(
        `SELECT e.evidence_id, e.scope_id, e.source_kind, e.locator, e.excerpt, e.excerpt_hash,
                e.captured_at, e.source_observed_at, e.trust_class, e.session_id,
                e.session_entry_id, e.tool_call_id, e.branch_leaf, e.actor_type
         FROM proposal_evidence AS pe
         JOIN evidence AS e ON e.scope_id = pe.scope_id AND e.evidence_id = pe.evidence_id
         WHERE pe.scope_id = ? AND pe.proposal_id = ? ORDER BY e.evidence_id`,
        [validScopeId, validProposalId],
      ).map(mapEvidence),
    };
  }

  linkProposalClaim(scopeId: string, proposalId: string, claimId: string): void {
    const validScopeId = this.requireScope(scopeId);
    const validProposalId = validateId(proposalId, "prp_", "proposalId");
    const validClaimId = validateId(claimId, "clm_", "claimId");
    if (!this.getProposal(validScopeId, validProposalId) || !this.getClaim(validScopeId, validClaimId)) {
      throw repositoryError("not_found", "Proposal and claim must exist in the requested scope.");
    }
    this.run(
      `INSERT INTO proposal_claims(scope_id, proposal_id, claim_id) VALUES (?, ?, ?)`,
      [validScopeId, validProposalId, validClaimId],
    );
  }

  linkProposalEvidence(scopeId: string, proposalId: string, evidenceId: string): void {
    const validScopeId = this.requireScope(scopeId);
    const validProposalId = validateId(proposalId, "prp_", "proposalId");
    const validEvidenceId = validateId(evidenceId, "evd_", "evidenceId");
    if (!this.getProposal(validScopeId, validProposalId) || !this.getEvidence(validScopeId, validEvidenceId)) {
      throw repositoryError("not_found", "Proposal and evidence must exist in the requested scope.");
    }
    this.run(
      `INSERT INTO proposal_evidence(scope_id, proposal_id, evidence_id) VALUES (?, ?, ?)`,
      [validScopeId, validProposalId, validEvidenceId],
    );
  }

  linkProposalSupersession(scopeId: string, proposalId: string, input: LinkProposalSupersessionInput): ProposalSupersessionRecord {
    const validScopeId = this.requireScope(scopeId);
    const validProposalId = validateId(proposalId, "prp_", "proposalId");
    const priorClaimId = validateId(input.priorClaimId, "clm_", "priorClaimId");
    const reason = optionalText(input.reason, "reason", MAX_REASON_LENGTH);
    if (!this.getProposal(validScopeId, validProposalId)) {
      throw repositoryError("not_found", "Proposal does not exist in the requested scope.");
    }
    const priorClaim = this.getClaim(validScopeId, priorClaimId);
    if (!priorClaim) throw repositoryError("not_found", "Prior claim does not exist in the requested scope.");
    if (priorClaim.status !== "accepted") {
      throw repositoryError("invalid_input", "Only an accepted claim can be corrected by supersession.");
    }
    this.run(
      `INSERT INTO proposal_supersession(scope_id, proposal_id, prior_claim_id, reason)
       VALUES (?, ?, ?, ?)`,
      [validScopeId, validProposalId, priorClaimId, reason ?? null],
    );
    return this.requireProposalSupersession(validScopeId, validProposalId);
  }

  getProposalSupersession(scopeId: string, proposalId: string): ProposalSupersessionRecord | undefined {
    const validScopeId = validateScopeId(scopeId);
    const validProposalId = validateId(proposalId, "prp_", "proposalId");
    const row = this.getRow(
      `SELECT scope_id, proposal_id, prior_claim_id, reason
       FROM proposal_supersession WHERE scope_id = ? AND proposal_id = ?`,
      [validScopeId, validProposalId],
    );
    return row ? mapProposalSupersession(row) : undefined;
  }

  reviewProposal(scopeId: string, proposalId: string, input: ReviewProposalInput): ProposalRecord {
    const validScopeId = this.requireScope(scopeId);
    const validProposalId = validateId(proposalId, "prp_", "proposalId");
    const proposal = this.getProposal(validScopeId, validProposalId);
    if (!proposal) throw repositoryError("not_found", "Proposal does not exist in the requested scope.");
    if (proposal.status !== "pending") throw repositoryError("invalid_input", "Only pending proposals can be reviewed.");
    const decision = input.decision;
    if (decision !== "accepted" && decision !== "rejected" && decision !== "cancelled") {
      throw repositoryError("invalid_input", "Proposal review decision is invalid.");
    }
    const actorType = validateActorType(input.actorType);
    const sessionId = optionalText(input.sessionId, "sessionId", MAX_PROVENANCE_LENGTH);
    const sessionEntryId = optionalText(input.sessionEntryId, "sessionEntryId", MAX_PROVENANCE_LENGTH);
    const toolCallId = optionalText(input.toolCallId, "toolCallId", MAX_PROVENANCE_LENGTH);
    const branchLeaf = optionalText(input.branchLeaf, "branchLeaf", MAX_PROVENANCE_LENGTH);
    const reviewedAt = this.timestamp();
    const candidateStatus = decision === "accepted" ? "accepted" : "rejected";

    this.withTransaction(() => {
      const updated = this.runChanges(
        `UPDATE proposals SET status = ?, reviewed_at = ?
         WHERE scope_id = ? AND proposal_id = ? AND status = 'pending'`,
        [decision, reviewedAt, validScopeId, validProposalId],
      );
      if (updated !== 1) throw repositoryError("invalid_input", "Proposal review lost a concurrent update.");
      this.run(
        `UPDATE entities SET status = ?, reviewed_at = ?
         WHERE scope_id = ? AND proposal_id = ?`,
        [candidateStatus, reviewedAt, validScopeId, validProposalId],
      );
      this.run(
        `UPDATE aliases SET status = ?, reviewed_at = ?
         WHERE scope_id = ? AND proposal_id = ?`,
        [candidateStatus, reviewedAt, validScopeId, validProposalId],
      );
      this.run(
        `UPDATE claims SET status = ?, reviewed_at = ?
         WHERE scope_id = ? AND proposal_id = ?`,
        [candidateStatus, reviewedAt, validScopeId, validProposalId],
      );
      const correction = decision === "accepted"
        ? this.getProposalSupersession(validScopeId, validProposalId)
        : undefined;
      if (correction) {
        const replacement = this.getRows(
          `SELECT claim_id FROM claims WHERE scope_id = ? AND proposal_id = ? ORDER BY claim_id`,
          [validScopeId, validProposalId],
        )[0];
        const prior = this.getClaim(validScopeId, correction.priorClaimId);
        if (!replacement || !prior || prior.status !== "accepted") {
          throw repositoryError("invalid_input", "Correction proposal no longer has an accepted prior claim.");
        }
        const replacementClaimId = requiredRowString(replacement, "claim_id");
        const supersededAt = prior.validFrom !== undefined && prior.validFrom >= reviewedAt
          ? prior.validFrom + 1
          : reviewedAt;
        this.run(
          `INSERT INTO claim_supersession(scope_id, prior_claim_id, replacement_claim_id, reason, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [validScopeId, correction.priorClaimId, replacementClaimId, correction.reason ?? null, reviewedAt],
        );
        this.run(
          `UPDATE claims SET status = 'superseded', valid_to = COALESCE(valid_to, ?), reviewed_at = ?
           WHERE scope_id = ? AND claim_id = ? AND status = 'accepted'`,
          [supersededAt, reviewedAt, validScopeId, correction.priorClaimId],
        );
        this.appendAuditEvent(validScopeId, {
          actorType,
          action: "supersession",
          targetType: "claim",
          targetId: replacementClaimId,
          beforeIds: [correction.priorClaimId],
          afterIds: [replacementClaimId],
          metadataJson: JSON.stringify({ reason: correction.reason ?? null }),
          sessionId,
          sessionEntryId,
          toolCallId,
          branchLeaf,
        });
      }
      this.appendAuditEvent(validScopeId, {
        actorType,
        action: decision === "accepted" ? "acceptance" : decision === "rejected" ? "rejection" : "proposal_reviewed",
        targetType: "proposal",
        targetId: validProposalId,
        sessionId,
        sessionEntryId,
        toolCallId,
        branchLeaf,
      });
    });
    return this.requireProposalRecord(validScopeId, validProposalId);
  }

  transaction<T>(operation: () => T): T {
    return this.withTransaction(operation);
  }

  appendAuditEvent(scopeId: string, input: AppendAuditEventInput): AuditEventRecord {
    const validScopeId = this.requireScope(scopeId);
    const auditEventId = this.resolveId(input.auditEventId, "audit_event", "aud_", "auditEventId");
    const actorType = validateActorType(input.actorType);
    const action = validateAuditAction(input.action);
    const targetType = validateAuditTargetType(input.targetType);
    const targetId = validateAuditTargetId(targetType, input.targetId, validScopeId);
    const sessionId = optionalText(input.sessionId, "sessionId", MAX_PROVENANCE_LENGTH);
    const sessionEntryId = optionalText(input.sessionEntryId, "sessionEntryId", MAX_PROVENANCE_LENGTH);
    const toolCallId = optionalText(input.toolCallId, "toolCallId", MAX_PROVENANCE_LENGTH);
    const branchLeaf = optionalText(input.branchLeaf, "branchLeaf", MAX_PROVENANCE_LENGTH);
    const beforeIds = validateAuditReferences(input.beforeIds ?? [], "beforeIds");
    const afterIds = validateAuditReferences(input.afterIds ?? [], "afterIds");
    const metadataJson = validateMetadataJson(input.metadataJson);

    this.run(
      `INSERT INTO audit_events(
         audit_event_id, scope_id, actor_type, action, target_type, target_id,
         occurred_at, session_id, session_entry_id, tool_call_id, branch_leaf,
         before_ids_json, after_ids_json, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        auditEventId,
        validScopeId,
        actorType,
        action,
        targetType,
        targetId ?? null,
        this.timestamp(),
        sessionId ?? null,
        sessionEntryId ?? null,
        toolCallId ?? null,
        branchLeaf ?? null,
        JSON.stringify(beforeIds),
        JSON.stringify(afterIds),
        metadataJson,
      ],
    );
    return this.requireAuditEventRecord(validScopeId, auditEventId);
  }

  getAuditEvent(scopeId: string, auditEventId: string): AuditEventRecord | undefined {
    const validScopeId = validateScopeId(scopeId);
    const validAuditEventId = validateId(auditEventId, "aud_", "auditEventId");
    const row = this.getRow(
      `SELECT audit_event_id, scope_id, actor_type, action, target_type, target_id,
              occurred_at, session_id, session_entry_id, tool_call_id, branch_leaf,
              before_ids_json, after_ids_json, metadata_json
       FROM audit_events
       WHERE scope_id = ? AND audit_event_id = ?`,
      [validScopeId, validAuditEventId],
    );
    return row ? mapAuditEvent(row) : undefined;
  }

  listAuditEvents(scopeId: string): AuditEventRecord[] {
    const validScopeId = this.requireScope(scopeId);
    return this.getRows(
      `SELECT audit_event_id, scope_id, actor_type, action, target_type, target_id,
              occurred_at, session_id, session_entry_id, tool_call_id, branch_leaf,
              before_ids_json, after_ids_json, metadata_json
       FROM audit_events
       WHERE scope_id = ?
       ORDER BY occurred_at, audit_event_id`,
      [validScopeId],
    ).map(mapAuditEvent);
  }

  private requireScope(scopeId: string): string {
    const validScopeId = validateScopeId(scopeId);
    if (!this.getScope(validScopeId)) {
      throw repositoryError("scope_not_found", "The requested scope is not registered.");
    }
    return validScopeId;
  }

  private requireScopeRecord(scopeId: string): ScopeRecord {
    const record = this.getScope(scopeId);
    if (!record) throw repositoryError("storage_error", "Registered scope could not be read back.");
    return record;
  }

  private requireEntityRecord(scopeId: string, entityId: string): EntityRecord {
    const record = this.getEntity(scopeId, entityId);
    if (!record) throw repositoryError("storage_error", "Inserted entity could not be read back.");
    return record;
  }

  private requireAliasRecord(scopeId: string, aliasId: string): AliasRecord {
    const record = this.getAlias(scopeId, aliasId);
    if (!record) throw repositoryError("storage_error", "Inserted alias could not be read back.");
    return record;
  }

  private requireEvidenceRecord(scopeId: string, evidenceId: string): EvidenceRecord {
    const record = this.getEvidence(scopeId, evidenceId);
    if (!record) throw repositoryError("storage_error", "Inserted evidence could not be read back.");
    return record;
  }

  private requireClaimRecord(scopeId: string, claimId: string): ClaimRecord {
    const record = this.getClaim(scopeId, claimId);
    if (!record) throw repositoryError("storage_error", "Inserted claim could not be read back.");
    return record;
  }

  private requireClaimEvidenceRecord(scopeId: string, claimId: string, evidenceId: string): ClaimEvidenceRecord {
    const record = this.getRows(
      `SELECT ce.claim_id, ce.evidence_id, ce.scope_id, ce.evidence_role,
              e.evidence_id AS e_evidence_id, e.scope_id AS e_scope_id,
              e.source_kind, e.locator, e.excerpt, e.excerpt_hash,
              e.captured_at, e.source_observed_at, e.trust_class,
              e.session_id, e.session_entry_id, e.tool_call_id, e.branch_leaf,
              e.actor_type
       FROM claim_evidence AS ce
       JOIN evidence AS e
         ON e.evidence_id = ce.evidence_id AND e.scope_id = ce.scope_id
       WHERE ce.scope_id = ? AND ce.claim_id = ? AND ce.evidence_id = ?`,
      [scopeId, claimId, evidenceId],
    ).map(mapClaimEvidence)[0];
    if (!record) throw repositoryError("storage_error", "Inserted claim evidence link could not be read back.");
    return record;
  }

  private requireSupersessionRecord(
    scopeId: string,
    priorClaimId: string,
    replacementClaimId: string,
  ): SupersessionLinkRecord {
    const record = this.getSupersession(scopeId, priorClaimId, replacementClaimId);
    if (!record) throw repositoryError("storage_error", "Inserted supersession link could not be read back.");
    return record;
  }

  private requireProposalSupersession(scopeId: string, proposalId: string): ProposalSupersessionRecord {
    const record = this.getProposalSupersession(scopeId, proposalId);
    if (!record) throw repositoryError("storage_error", "Inserted proposal supersession could not be read back.");
    return record;
  }

  private requireAuditEventRecord(scopeId: string, auditEventId: string): AuditEventRecord {
    const record = this.getAuditEvent(scopeId, auditEventId);
    if (!record) throw repositoryError("storage_error", "Inserted audit event could not be read back.");
    return record;
  }

  private requireProposalRecord(scopeId: string, proposalId: string): ProposalRecord {
    const record = this.getProposal(scopeId, proposalId);
    if (!record) throw repositoryError("storage_error", "Inserted proposal could not be read back.");
    return record;
  }

  private resolveId(
    suppliedId: string | undefined,
    kind: StableIdKind,
    prefix: string,
    field: string,
  ): string {
    const candidate = suppliedId ?? this.idFactory.next(kind);
    return validateId(candidate, prefix, field);
  }

  private findEvidenceByIdentity(
    scopeId: string,
    excerptHash: string,
    sourceKind: SourceKind,
    locator: string | undefined,
    trustClass: TrustClass,
  ): EvidenceRecord | undefined {
    const row = this.getRow(
      `SELECT evidence_id, scope_id, source_kind, locator, excerpt, excerpt_hash,
              captured_at, source_observed_at, trust_class, session_id, session_entry_id,
              tool_call_id, branch_leaf, actor_type
       FROM evidence
       WHERE scope_id = ? AND excerpt_hash = ? AND source_kind = ?
         AND COALESCE(locator, '') = COALESCE(?, '') AND trust_class = ?
       LIMIT 1`,
      [scopeId, excerptHash, sourceKind, locator ?? null, trustClass],
    );
    return row ? mapEvidence(row) : undefined;
  }

  private findProposalByFingerprint(scopeId: string, candidateFingerprint: string): ProposalRecord | undefined {
    const row = this.getRow(
      proposalSelectSql + " WHERE scope_id = ? AND candidate_fingerprint = ?",
      [scopeId, candidateFingerprint],
    );
    return row ? mapProposal(row) : undefined;
  }

  private findProposalByIdempotencyKey(scopeId: string, idempotencyKey: string): ProposalRecord | undefined {
    const row = this.getRow(
      proposalSelectSql + " WHERE scope_id = ? AND idempotency_key = ?",
      [scopeId, idempotencyKey],
    );
    return row ? mapProposal(row) : undefined;
  }

  private hasAcceptedAlias(scopeId: string, normalizedAlias: string): boolean {
    return this.getRow(
      `SELECT alias_id
       FROM aliases
       WHERE scope_id = ? AND normalized_alias = ? AND status = 'accepted'
       LIMIT 1`,
      [scopeId, normalizedAlias],
    ) !== undefined;
  }

  private timestamp(): number {
    const timestamp = this.now();
    return validateTimestamp(timestamp, "now") ?? 0;
  }

  private getRow(sql: string, parameters: readonly SqlValue[]): Row | undefined {
    const row = this.database.prepare(sql).get(...parameters);
    return isRow(row) ? row : undefined;
  }

  private getRows(sql: string, parameters: readonly SqlValue[]): Row[] {
    return this.database.prepare(sql).all(...parameters).filter(isRow);
  }

  private run(sql: string, parameters: readonly SqlValue[]): void {
    this.runChanges(sql, parameters);
  }

  private runChanges(sql: string, parameters: readonly SqlValue[]): number {
    try {
      const result = this.database.prepare(sql).run(...parameters);
      return typeof result.changes === "bigint" ? Number(result.changes) : result.changes;
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  }

  private withTransaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original failure; the database owner will close the connection if needed.
      }
      throw error;
    }
  }
}

const claimSelectSql = `
  SELECT claim_id, scope_id, status, subject_entity_id, predicate, object_kind,
         object_entity_id, object_text, object_number, object_boolean, object_date,
         object_url, observed_at, valid_from, valid_to, created_at, reviewed_at, proposal_id
  FROM claims`;

const proposalSelectSql = `
  SELECT proposal_id, scope_id, status, candidate_fingerprint, idempotency_key,
         actor_type, created_at, reviewed_at, session_id, session_entry_id,
         tool_call_id, branch_leaf
  FROM proposals`;

function mapScope(row: Row): ScopeRecord {
  return {
    scopeId: requiredRowString(row, "scope_id"),
    kind: requiredScopeKind(requiredRowString(row, "kind")),
    projectRoot: optionalRowString(row, "project_root"),
    identityPath: optionalRowString(row, "identity_path"),
    createdAt: requiredRowInteger(row, "created_at"),
  };
}

function mapEntity(row: Row): EntityRecord {
  return {
    entityId: requiredRowString(row, "entity_id"),
    scopeId: requiredRowString(row, "scope_id"),
    label: requiredRowString(row, "label"),
    normalizedLabel: requiredRowString(row, "normalized_label"),
    type: validateEntityType(requiredRowString(row, "entity_type")),
    status: validateEntityStatus(requiredRowString(row, "status")),
    createdAt: requiredRowInteger(row, "created_at"),
    reviewedAt: optionalRowInteger(row, "reviewed_at"),
    proposalId: optionalRowString(row, "proposal_id"),
  };
}

function mapAlias(row: Row): AliasRecord {
  return {
    aliasId: requiredRowString(row, "alias_id"),
    scopeId: requiredRowString(row, "scope_id"),
    entityId: requiredRowString(row, "entity_id"),
    alias: requiredRowString(row, "alias"),
    normalizedAlias: requiredRowString(row, "normalized_alias"),
    status: validateEntityStatus(requiredRowString(row, "status")),
    createdAt: requiredRowInteger(row, "created_at"),
    reviewedAt: optionalRowInteger(row, "reviewed_at"),
    proposalId: optionalRowString(row, "proposal_id"),
  };
}

function mapEvidence(row: Row): EvidenceRecord {
  return {
    evidenceId: requiredRowString(row, "evidence_id"),
    scopeId: requiredRowString(row, "scope_id"),
    sourceKind: validateSourceKind(requiredRowString(row, "source_kind")),
    locator: optionalRowString(row, "locator"),
    excerpt: requiredRowString(row, "excerpt"),
    excerptHash: requiredRowString(row, "excerpt_hash"),
    capturedAt: requiredRowInteger(row, "captured_at"),
    sourceObservedAt: optionalRowInteger(row, "source_observed_at"),
    trustClass: validateTrustClass(requiredRowString(row, "trust_class")),
    sessionId: optionalRowString(row, "session_id"),
    sessionEntryId: optionalRowString(row, "session_entry_id"),
    toolCallId: optionalRowString(row, "tool_call_id"),
    branchLeaf: optionalRowString(row, "branch_leaf"),
    actorType: optionalActorType(row["actor_type"]),
  };
}

function mapClaim(row: Row): ClaimRecord {
  return {
    claimId: requiredRowString(row, "claim_id"),
    scopeId: requiredRowString(row, "scope_id"),
    status: validateClaimStatus(requiredRowString(row, "status")),
    subjectEntityId: requiredRowString(row, "subject_entity_id"),
    predicate: requiredRowString(row, "predicate"),
    object: mapClaimObject(row),
    observedAt: requiredRowInteger(row, "observed_at"),
    validFrom: optionalRowInteger(row, "valid_from"),
    validTo: optionalRowInteger(row, "valid_to"),
    createdAt: requiredRowInteger(row, "created_at"),
    reviewedAt: optionalRowInteger(row, "reviewed_at"),
    proposalId: optionalRowString(row, "proposal_id"),
  };
}

function mapClaimEvidence(row: Row): ClaimEvidenceRecord {
  return {
    claimId: requiredRowString(row, "claim_id"),
    evidenceId: requiredRowString(row, "evidence_id"),
    scopeId: requiredRowString(row, "scope_id"),
    role: validateEvidenceRole(requiredRowString(row, "evidence_role")),
    evidence: mapEvidence({
      evidence_id: row.e_evidence_id,
      scope_id: row.e_scope_id,
      source_kind: row.source_kind,
      locator: row.locator,
      excerpt: row.excerpt,
      excerpt_hash: row.excerpt_hash,
      captured_at: row.captured_at,
      source_observed_at: row.source_observed_at,
      trust_class: row.trust_class,
      session_id: row.session_id,
      session_entry_id: row.session_entry_id,
      tool_call_id: row.tool_call_id,
      branch_leaf: row.branch_leaf,
      actor_type: row.actor_type,
    }),
  };
}

function mapProposalSupersession(row: Row): ProposalSupersessionRecord {
  return {
    scopeId: requiredRowString(row, "scope_id"),
    proposalId: requiredRowString(row, "proposal_id"),
    priorClaimId: requiredRowString(row, "prior_claim_id"),
    reason: optionalRowString(row, "reason"),
  };
}

function mapSupersession(row: Row): SupersessionLinkRecord {
  return {
    scopeId: requiredRowString(row, "scope_id"),
    priorClaimId: requiredRowString(row, "prior_claim_id"),
    replacementClaimId: requiredRowString(row, "replacement_claim_id"),
    reason: optionalRowString(row, "reason"),
    createdAt: requiredRowInteger(row, "created_at"),
  };
}

function mapAuditEvent(row: Row): AuditEventRecord {
  return {
    auditEventId: requiredRowString(row, "audit_event_id"),
    scopeId: requiredRowString(row, "scope_id"),
    actorType: validateActorType(requiredRowString(row, "actor_type")),
    action: validateAuditAction(requiredRowString(row, "action")),
    targetType: validateAuditTargetType(requiredRowString(row, "target_type")),
    targetId: optionalRowString(row, "target_id"),
    occurredAt: requiredRowInteger(row, "occurred_at"),
    sessionId: optionalRowString(row, "session_id"),
    sessionEntryId: optionalRowString(row, "session_entry_id"),
    toolCallId: optionalRowString(row, "tool_call_id"),
    branchLeaf: optionalRowString(row, "branch_leaf"),
    beforeIds: parseAuditReferences(requiredRowString(row, "before_ids_json")),
    afterIds: parseAuditReferences(requiredRowString(row, "after_ids_json")),
    metadataJson: validateMetadataJson(requiredRowString(row, "metadata_json")),
  };
}

function mapProposal(row: Row): ProposalRecord {
  return {
    proposalId: requiredRowString(row, "proposal_id"),
    scopeId: requiredRowString(row, "scope_id"),
    status: validateProposalStatus(requiredRowString(row, "status")),
    candidateFingerprint: validateFingerprint(requiredRowString(row, "candidate_fingerprint"), "candidateFingerprint"),
    idempotencyKey: optionalRowString(row, "idempotency_key"),
    actorType: validateActorType(requiredRowString(row, "actor_type")),
    createdAt: requiredRowInteger(row, "created_at"),
    reviewedAt: optionalRowInteger(row, "reviewed_at"),
    sessionId: optionalRowString(row, "session_id"),
    sessionEntryId: optionalRowString(row, "session_entry_id"),
    toolCallId: optionalRowString(row, "tool_call_id"),
    branchLeaf: optionalRowString(row, "branch_leaf"),
  };
}

function mapClaimObject(row: Row): ClaimObject {
  const kind = requiredRowString(row, "object_kind");
  switch (kind) {
    case "entity":
      return normalizeClaimObject({ kind, entityId: requiredRowString(row, "object_entity_id") });
    case "text":
      return normalizeClaimObject({ kind, value: requiredRowString(row, "object_text") });
    case "number": {
      const value = row.object_number;
      if (typeof value !== "number") throw repositoryError("corrupt_row", "Claim object number is invalid.");
      return normalizeClaimObject({ kind, value });
    }
    case "boolean": {
      const value = row.object_boolean;
      if (value !== 0 && value !== 1) throw repositoryError("corrupt_row", "Claim object boolean is invalid.");
      return normalizeClaimObject({ kind, value: value === 1 });
    }
    case "date":
      return normalizeClaimObject({ kind, value: requiredRowString(row, "object_date") });
    case "url":
      return normalizeClaimObject({ kind, value: requiredRowString(row, "object_url") });
    default:
      throw repositoryError("corrupt_row", "Claim object kind is invalid.");
  }
}

function normalizeClaimObject(value: unknown): ClaimObject {
  if (!isRow(value) || typeof value.kind !== "string") {
    throw repositoryError("invalid_input", "Claim object must be one typed object.");
  }
  switch (value.kind) {
    case "entity":
      requireExactKeys(value, ["kind", "entityId"], "Claim entity object");
      return { kind: "entity", entityId: validateId(value.entityId, "ent_", "object.entityId") };
    case "text":
      requireExactKeys(value, ["kind", "value"], "Claim text object");
      return { kind: "text", value: requiredText(value.value, "object.value", MAX_TEXT_OBJECT_LENGTH) };
    case "number":
      requireExactKeys(value, ["kind", "value"], "Claim number object");
      if (typeof value.value !== "number" || !Number.isFinite(value.value)) {
        throw repositoryError("invalid_input", "Claim number object must contain a finite number.");
      }
      return { kind: "number", value: value.value };
    case "boolean":
      requireExactKeys(value, ["kind", "value"], "Claim boolean object");
      if (typeof value.value !== "boolean") {
        throw repositoryError("invalid_input", "Claim boolean object must contain a boolean.");
      }
      return { kind: "boolean", value: value.value };
    case "date":
      requireExactKeys(value, ["kind", "value"], "Claim date object");
      return { kind: "date", value: validateUtcDate(value.value, "object.value") };
    case "url":
      requireExactKeys(value, ["kind", "value"], "Claim URL object");
      return { kind: "url", value: validateUrl(value.value, "object.value") };
    default:
      throw repositoryError("invalid_input", "Claim object kind is unsupported.");
  }
}

export function validateScopeId(value: unknown): string {
  if (typeof value !== "string" || !SCOPE_ID_PATTERN.test(value)) {
    throw repositoryError("invalid_scope", "Scope must be global or a project SHA-256 scope key.");
  }
  return value;
}

function validateScopeKind(scopeId: string, kind: ScopeKind): ScopeKind {
  if (kind !== "global" && kind !== "project") {
    throw repositoryError("invalid_input", "Scope kind is invalid.");
  }
  if ((scopeId === "global") !== (kind === "global")) {
    throw repositoryError("invalid_scope", "Scope ID and scope kind do not match.");
  }
  return kind;
}

function requiredScopeKind(value: string): ScopeKind {
  if (value === "global" || value === "project") return value;
  throw repositoryError("corrupt_row", "Stored scope kind is invalid.");
}

function validateId(value: unknown, prefix: string, field: string): string {
  if (typeof value !== "string" || !new RegExp(`^${prefix}${UUID_SUFFIX}$`, "u").test(value)) {
    throw repositoryError("invalid_input", `${field} must use the expected opaque UUID ID format.`);
  }
  return value;
}

function optionalId(value: unknown, prefix: string, field: string): string | undefined {
  if (value === undefined) return undefined;
  return validateId(value, prefix, field);
}

function validateEntityType(value: unknown): EntityType {
  if (
    value === "person" || value === "project" || value === "repository" || value === "service" ||
    value === "tool" || value === "organization" || value === "location" || value === "preference" ||
    value === "concept" || value === "other"
  ) return value;
  throw repositoryError("invalid_input", "Entity type is invalid.");
}

function validateEntityStatus(value: unknown): EntityStatus {
  if (value === "proposed" || value === "accepted" || value === "rejected") return value;
  throw repositoryError("invalid_input", "Entity status is invalid.");
}

function validateClaimStatus(value: unknown): ClaimStatus {
  if (value === "proposed" || value === "accepted" || value === "rejected" || value === "superseded") return value;
  throw repositoryError("invalid_input", "Claim status is invalid.");
}

function validateProposalStatus(value: unknown): ProposalStatus {
  if (value === "pending" || value === "accepted" || value === "rejected" || value === "cancelled") return value;
  throw repositoryError("invalid_input", "Proposal status is invalid.");
}

function validateFingerprint(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw repositoryError("invalid_input", `${field} must be a lowercase SHA-256 fingerprint.`);
  }
  return value;
}

function validateSourceKind(value: unknown): SourceKind {
  if (value === "user_statement" || value === "pi_session" || value === "file" || value === "command" || value === "url" || value === "other") return value;
  throw repositoryError("invalid_input", "Evidence source kind is invalid.");
}

function validateTrustClass(value: unknown): TrustClass {
  if (value === "user" || value === "agent" || value === "local_file" || value === "local_command" || value === "external" || value === "unknown") return value;
  throw repositoryError("invalid_input", "Evidence trust class is invalid.");
}

function validateActorType(value: unknown): ActorType {
  if (value === "user" || value === "agent" || value === "system") return value;
  throw repositoryError("invalid_input", "Actor type is invalid.");
}

function optionalActorType(value: unknown): ActorType | undefined {
  if (value === null || value === undefined) return undefined;
  return validateActorType(value);
}

function validateEvidenceRole(value: unknown): EvidenceRole {
  if (value === "primary" || value === "supporting") return value;
  throw repositoryError("invalid_input", "Evidence role is invalid.");
}

function validateAuditAction(value: unknown): AuditAction {
  if (
    value === "proposal_created" || value === "proposal_reviewed" || value === "acceptance" ||
    value === "rejection" || value === "correction" || value === "supersession" || value === "export" ||
    value === "forget" || value === "purge" || value === "migration" || value === "recovery"
  ) return value;
  throw repositoryError("invalid_input", "Audit action is invalid.");
}

function validateAuditTargetType(value: unknown): AuditTargetType {
  if (
    value === "scope" || value === "entity" || value === "alias" || value === "evidence" ||
    value === "claim" || value === "proposal" || value === "audit_event" || value === "system"
  ) return value;
  throw repositoryError("invalid_input", "Audit target type is invalid.");
}

function validateAuditTargetId(targetType: AuditTargetType, targetId: unknown, scopeId: string): string | undefined {
  if (targetType === "system") {
    if (targetId !== undefined) throw repositoryError("invalid_input", "System audit events cannot have a target ID.");
    return undefined;
  }
  if (targetId === undefined) {
    throw repositoryError("invalid_input", "Audit target ID is required for this target type.");
  }
  if (targetType === "scope") {
    const validTarget = validateScopeId(targetId);
    if (validTarget !== scopeId) throw repositoryError("not_found", "Audit target is outside the requested scope.");
    return validTarget;
  }
  const prefix = targetType === "entity"
    ? "ent_"
    : targetType === "alias"
      ? "als_"
      : targetType === "evidence"
        ? "evd_"
        : targetType === "claim"
          ? "clm_"
          : targetType === "proposal"
            ? "prp_"
            : "aud_";
  return validateId(targetId, prefix, "targetId");
}

function validatePredicate(value: unknown): string {
  if (typeof value !== "string" || !PREDICATE_PATTERN.test(value)) {
    throw repositoryError("invalid_input", "Predicate must be a normalized ASCII key.");
  }
  return value;
}

function requiredText(value: unknown, field: string, maximumCodePoints: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || codePointLength(value) > maximumCodePoints) {
    throw repositoryError("invalid_input", `${field} must be a non-empty string within its size limit.`);
  }
  return value;
}

function optionalText(value: unknown, field: string, maximumCodePoints: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, field, maximumCodePoints);
}

function normalizeLookupText(value: string, field: string): string {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");
  if (normalized.length === 0) throw repositoryError("invalid_input", `${field} cannot normalize to an empty value.`);
  return normalized;
}

function optionalTimestamp(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  return validateTimestamp(value, field);
}

function validateTimestamp(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw repositoryError("invalid_input", `${field} must be a non-negative integer timestamp.`);
  }
  return value;
}

function validateUtcDate(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > 64 || !value.endsWith("Z")) {
    throw repositoryError("invalid_input", `${field} must be a UTC RFC 3339 timestamp.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw repositoryError("invalid_input", `${field} must be a valid UTC timestamp.`);
  return new Date(parsed).toISOString();
}

function validateUrl(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) {
    throw repositoryError("invalid_input", `${field} must be a bounded URL.`);
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
  } catch {
    throw repositoryError("invalid_input", `${field} must be an HTTP or HTTPS URL.`);
  }
  return value;
}

function requireExactKeys(value: Row, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw repositoryError("invalid_input", `${label} contains unsupported fields.`);
  }
}

function validateAuditReferences(values: readonly string[], field: string): readonly string[] {
  if (values.length > MAX_AUDIT_REFERENCE_COUNT) {
    throw repositoryError("invalid_input", `${field} contains too many references.`);
  }
  return values.map((value, index) => requiredText(value, `${field}[${index}]`, 128));
}

function validateMetadataJson(value: string | undefined): string {
  if (value === undefined) return "{}";
  if (value.length > MAX_METADATA_LENGTH) throw repositoryError("invalid_input", "Audit metadata is too large.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw repositoryError("invalid_input", "Audit metadata must be valid JSON.");
  }
  if (!isRow(parsed)) throw repositoryError("invalid_input", "Audit metadata must be a JSON object.");
  return value;
}

function parseAuditReferences(value: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw repositoryError("corrupt_row", "Stored audit references are invalid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw repositoryError("corrupt_row", "Stored audit references are invalid.");
  }
  return validateAuditReferences(parsed, "audit references");
}

function codePointLength(value: string): number {
  return [...value].length;
}

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredRowString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw repositoryError("corrupt_row", `Stored ${key} is not a string.`);
  return value;
}

function optionalRowString(row: Row, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  return requiredRowString(row, key);
}

function requiredRowInteger(row: Row, key: string): number {
  return validateTimestamp(row[key], key);
}

function optionalRowInteger(row: Row, key: string): number | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  return validateTimestamp(value, key);
}

function repositoryError(code: RepositoryErrorCode, message: string): KnowledgeGraphRepositoryError {
  return new KnowledgeGraphRepositoryError(code, message);
}

function normalizeDatabaseError(error: unknown): KnowledgeGraphRepositoryError {
  if (error instanceof KnowledgeGraphRepositoryError) return error;
  const message = error instanceof Error ? error.message : "";
  if (/UNIQUE constraint failed/u.test(message)) return repositoryError("duplicate", "The record already exists.");
  if (/FOREIGN KEY constraint failed/u.test(message)) return repositoryError("not_found", "A referenced record is not in the requested scope.");
  return repositoryError("storage_error", "The knowledge-graph database rejected the operation.");
}

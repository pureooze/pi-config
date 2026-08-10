import {
  computeCandidateFingerprint,
  type ClaimObject,
  type EntityType,
  KnowledgeGraphRepositories,
  type ProposalCandidateRecords,
  type ProposalRecord,
  type ProposalStatus,
  type SourceKind,
  type ActorType,
} from "./repository.ts";
import { assertNoSecrets, KnowledgeGraphSecurityError } from "./security.ts";

export type ProposedEntity =
  | { readonly entityId: string }
  | { readonly label: string; readonly type: EntityType; readonly aliases?: readonly string[] };

export type ProposedObject =
  | ({ readonly kind: "entity" } & Exclude<ProposedEntity, { readonly entityId: string }>)
  | { readonly kind: "entity"; readonly entityId: string }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "date"; readonly value: string }
  | { readonly kind: "url"; readonly value: string };

export interface ProposalEvidenceInput {
  readonly sourceKind: SourceKind;
  readonly locator?: string;
  readonly excerpt: string;
  readonly sourceObservedAt?: number | string;
}

export interface SubmitProposalInput {
  readonly actorType: ActorType;
  readonly subject: ProposedEntity;
  readonly predicate: string;
  readonly object: ProposedObject;
  readonly validFrom?: number | string;
  readonly validTo?: number | string;
  readonly evidence: readonly ProposalEvidenceInput[];
  readonly idempotencyKey?: string;
  readonly supersedesClaimId?: string;
  readonly supersessionReason?: string;
  readonly sessionId?: string;
  readonly sessionEntryId?: string;
  readonly toolCallId?: string;
  readonly branchLeaf?: string;
}

export interface ProposalSubmission {
  readonly status: "pending" | "already_known";
  readonly proposal: ProposalRecord;
  readonly candidates: ProposalCandidateRecords;
}

export type ProposalReviewDecision = "accepted" | "rejected" | "cancelled";

export class KnowledgeGraphProposalError extends Error {
  readonly code:
    | "invalid_input"
    | "invalid_reference_scope"
    | "secret_detected"
    | "not_found"
    | "storage_error";

  constructor(code: KnowledgeGraphProposalError["code"], message: string) {
    super(message);
    this.name = "KnowledgeGraphProposalError";
    this.code = code;
  }
}

interface NewEntityCandidate {
  readonly kind: "new";
  readonly label: string;
  readonly type: EntityType;
  readonly aliases: readonly string[];
}

interface ExistingEntityCandidate {
  readonly kind: "existing";
  readonly entityId: string;
}

type NormalizedEntity = NewEntityCandidate | ExistingEntityCandidate;
type ExistingEntityObject = { readonly kind: "existing_entity"; readonly entityId: string };
type NewEntityObject = { readonly kind: "new_entity"; readonly label: string; readonly type: EntityType; readonly aliases: readonly string[] };
type NormalizedObject = ClaimObject | ExistingEntityObject | NewEntityObject;

const MAX_EVIDENCE_COUNT = 5;
const MAX_ALIAS_COUNT = 8;
const MAX_LABEL_LENGTH = 256;
const MAX_LOCATOR_LENGTH = 2_048;
const MAX_EXCERPT_LENGTH = 4_000;
const MAX_PROVENANCE_LENGTH = 512;
const PREDICATE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/u;
const ID_PATTERN = /^ent_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CLAIM_ID_PATTERN = /^clm_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class KnowledgeGraphProposalService {
  private readonly repositories: KnowledgeGraphRepositories;

  constructor(repositories: KnowledgeGraphRepositories) {
    this.repositories = repositories;
  }

  submit(scopeId: string, input: SubmitProposalInput): ProposalSubmission {
    const normalized = normalizeSubmission(input);
    this.assertReferences(scopeId, normalized.subject);
    if (normalized.object.kind === "existing_entity") {
      this.assertReferences(scopeId, { kind: "existing", entityId: normalized.object.entityId });
    }
    if (normalized.supersedesClaimId !== undefined) {
      const priorClaim = this.repositories.getClaim(scopeId, normalized.supersedesClaimId);
      if (!priorClaim || priorClaim.status !== "accepted") {
        throw new KnowledgeGraphProposalError("invalid_reference_scope", "The correction target is not an accepted claim in the requested scope.");
      }
    }

    const fingerprint = computeCandidateFingerprint(JSON.stringify({
      subject: normalized.subject,
      predicate: normalized.predicate,
      object: normalized.object,
      validFrom: normalized.validFrom,
      validTo: normalized.validTo,
      evidence: normalized.evidence.map((evidence) => ({
        sourceKind: evidence.sourceKind,
        locator: evidence.locator,
        excerpt: evidence.excerpt,
        sourceObservedAt: evidence.sourceObservedAt,
      })),
      supersedesClaimId: normalized.supersedesClaimId,
    }));
    const existing = this.repositories.findProposal(scopeId, {
      candidateFingerprint: fingerprint,
      idempotencyKey: normalized.idempotencyKey,
    });
    if (existing) {
      return { status: "already_known", proposal: existing, candidates: this.repositories.getProposalCandidates(scopeId, existing.proposalId) };
    }

    return this.repositories.transaction(() => {
      const race = this.repositories.findProposal(scopeId, {
        candidateFingerprint: fingerprint,
        idempotencyKey: normalized.idempotencyKey,
      });
      if (race) {
        return { status: "already_known", proposal: race, candidates: this.repositories.getProposalCandidates(scopeId, race.proposalId) };
      }

      const proposal = this.repositories.createProposal(scopeId, {
        candidateFingerprint: fingerprint,
        idempotencyKey: normalized.idempotencyKey,
        actorType: normalized.actorType,
        sessionId: normalized.sessionId,
        sessionEntryId: normalized.sessionEntryId,
        toolCallId: normalized.toolCallId,
        branchLeaf: normalized.branchLeaf,
      });
      if (normalized.supersedesClaimId !== undefined) {
        this.repositories.linkProposalSupersession(scopeId, proposal.proposalId, {
          priorClaimId: normalized.supersedesClaimId,
          reason: normalized.supersessionReason,
        });
      }
      const subjectEntityId = this.createOrReferenceEntity(scopeId, normalized.subject, proposal.proposalId);
      const object = normalized.object.kind === "new_entity"
        ? { kind: "entity" as const, entityId: this.createOrReferenceEntity(scopeId, normalized.object, proposal.proposalId) }
        : normalized.object.kind === "existing_entity"
          ? { kind: "entity" as const, entityId: normalized.object.entityId }
          : normalized.object;

      const createdEvidence = normalized.evidence.map((evidence) => this.repositories.createEvidence(scopeId, {
        sourceKind: evidence.sourceKind,
        locator: evidence.locator,
        excerpt: evidence.excerpt,
        sourceObservedAt: evidence.sourceObservedAt,
        trustClass: trustClassFor(evidence.sourceKind, normalized.actorType),
        sessionId: normalized.sessionId,
        sessionEntryId: normalized.sessionEntryId,
        toolCallId: normalized.toolCallId,
        branchLeaf: normalized.branchLeaf,
        actorType: normalized.actorType,
      }));
      const claim = this.repositories.createClaim(scopeId, {
        subjectEntityId,
        predicate: normalized.predicate,
        object,
        status: "proposed",
        validFrom: normalized.validFrom,
        validTo: normalized.validTo,
        proposalId: proposal.proposalId,
      });
      for (const evidence of createdEvidence) {
        this.repositories.attachEvidence(scopeId, { claimId: claim.claimId, evidenceId: evidence.evidenceId, role: "primary" });
        this.repositories.linkProposalEvidence(scopeId, proposal.proposalId, evidence.evidenceId);
      }
      this.repositories.linkProposalClaim(scopeId, proposal.proposalId, claim.claimId);
      this.repositories.appendAuditEvent(scopeId, {
        actorType: normalized.actorType,
        action: normalized.supersedesClaimId === undefined ? "proposal_created" : "correction",
        targetType: "proposal",
        targetId: proposal.proposalId,
        sessionId: normalized.sessionId,
        sessionEntryId: normalized.sessionEntryId,
        toolCallId: normalized.toolCallId,
        branchLeaf: normalized.branchLeaf,
      });
      return { status: "pending", proposal, candidates: this.repositories.getProposalCandidates(scopeId, proposal.proposalId) };
    });
  }

  edit(
    scopeId: string,
    proposalId: string,
    correctedExcerpt: string,
    provenance: Omit<SubmitProposalInput, "subject" | "predicate" | "object" | "validFrom" | "validTo" | "evidence" | "idempotencyKey">,
  ): { proposal: ProposalRecord; candidates: ProposalCandidateRecords } {
    const candidate = this.repositories.getProposalCandidates(scopeId, proposalId);
    const originalEvidence = candidate.evidence[0];
    const claim = candidate.claims[0];
    if (!originalEvidence || !claim) throw new KnowledgeGraphProposalError("not_found", "Proposal has no editable candidate evidence.");
    if (candidate.claims.some((item) => item.status !== "proposed")) {
      throw new KnowledgeGraphProposalError("invalid_input", "Only pending candidate claims can be edited.");
    }
    const excerpt = requiredText(correctedExcerpt, "correctedExcerpt", MAX_EXCERPT_LENGTH);
    assertNoSecrets([{ field: "correctedExcerpt", text: excerpt }]);
    const actorType = validateActorType(provenance.actorType);
    const sessionId = optionalText(provenance.sessionId, "sessionId", MAX_PROVENANCE_LENGTH);
    const sessionEntryId = optionalText(provenance.sessionEntryId, "sessionEntryId", MAX_PROVENANCE_LENGTH);
    const toolCallId = optionalText(provenance.toolCallId, "toolCallId", MAX_PROVENANCE_LENGTH);
    const branchLeaf = optionalText(provenance.branchLeaf, "branchLeaf", MAX_PROVENANCE_LENGTH);

    return this.repositories.transaction(() => {
      const evidence = this.repositories.createEvidence(scopeId, {
        sourceKind: originalEvidence.sourceKind,
        locator: originalEvidence.locator,
        excerpt,
        sourceObservedAt: originalEvidence.sourceObservedAt,
        trustClass: "user",
        sessionId,
        sessionEntryId,
        toolCallId,
        branchLeaf,
        actorType,
      });
      this.repositories.attachEvidence(scopeId, { claimId: claim.claimId, evidenceId: evidence.evidenceId, role: "supporting" });
      this.repositories.linkProposalEvidence(scopeId, proposalId, evidence.evidenceId);
      this.repositories.appendAuditEvent(scopeId, {
        actorType,
        action: "correction",
        targetType: "proposal",
        targetId: proposalId,
        beforeIds: [originalEvidence.evidenceId],
        afterIds: [evidence.evidenceId],
        sessionId,
        sessionEntryId,
        toolCallId,
        branchLeaf,
      });
      const proposal = this.repositories.getProposal(scopeId, proposalId);
      if (!proposal) throw new KnowledgeGraphProposalError("not_found", "Proposal does not exist in the requested scope.");
      return { proposal, candidates: this.repositories.getProposalCandidates(scopeId, proposalId) };
    });
  }

  review(
    scopeId: string,
    proposalId: string,
    decision: ProposalReviewDecision,
    provenance: Omit<SubmitProposalInput, "subject" | "predicate" | "object" | "validFrom" | "validTo" | "evidence" | "idempotencyKey">,
  ): { proposal: ProposalRecord; candidates: ProposalCandidateRecords } {
    const proposal = this.repositories.reviewProposal(scopeId, proposalId, {
      decision,
      actorType: provenance.actorType,
      sessionId: provenance.sessionId,
      sessionEntryId: provenance.sessionEntryId,
      toolCallId: provenance.toolCallId,
      branchLeaf: provenance.branchLeaf,
    });
    return { proposal, candidates: this.repositories.getProposalCandidates(scopeId, proposal.proposalId) };
  }

  listPending(scopeId: string): readonly ProposalRecord[] {
    return this.repositories.listProposals(scopeId, "pending");
  }

  private assertReferences(scopeId: string, entity: NormalizedEntity): void {
    if (entity.kind === "existing" && !this.repositories.getEntity(scopeId, entity.entityId)) {
      throw new KnowledgeGraphProposalError("invalid_reference_scope", "Referenced entity is not visible in the requested scope.");
    }
  }

  private createOrReferenceEntity(scopeId: string, entity: NormalizedEntity | NewEntityObject, proposalId: string): string {
    if (entity.kind === "existing") return entity.entityId;
    const created = this.repositories.createEntity(scopeId, {
      label: entity.label,
      type: entity.type,
      status: "proposed",
      proposalId,
    });
    for (const alias of entity.aliases) {
      this.repositories.createAlias(scopeId, {
        entityId: created.entityId,
        alias,
        status: "proposed",
        proposalId,
      });
    }
    return created.entityId;
  }
}

function normalizeSubmission(input: SubmitProposalInput) {
  const actorType = validateActorType(input.actorType);
  const subject = normalizeEntity(input.subject, "subject");
  const predicate = normalizePredicate(input.predicate);
  const object = normalizeObject(input.object);
  const validFrom = optionalTimestamp(input.validFrom, "validFrom");
  const validTo = optionalTimestamp(input.validTo, "validTo");
  if (validFrom !== undefined && validTo !== undefined && validTo <= validFrom) {
    throw new KnowledgeGraphProposalError("invalid_input", "validTo must be later than validFrom.");
  }
  if (!Array.isArray(input.evidence) || input.evidence.length < 1 || input.evidence.length > MAX_EVIDENCE_COUNT) {
    throw new KnowledgeGraphProposalError("invalid_input", `Evidence must contain 1 through ${MAX_EVIDENCE_COUNT} entries.`);
  }
  const evidence = input.evidence.map((entry, index) => normalizeEvidence(entry, index));
  assertNoSecrets([
    ...evidence.map((entry, index) => ({ field: `evidence[${index}].excerpt`, text: entry.excerpt })),
    ...evidence.filter((entry) => entry.locator !== undefined).map((entry, index) => ({ field: `evidence[${index}].locator`, text: entry.locator ?? "" })),
  ]);
  const newEntityCount = (subject.kind === "new" ? 1 : 0) + (object.kind === "new_entity" ? 1 : 0);
  if (newEntityCount > 2) throw new KnowledgeGraphProposalError("invalid_input", "A proposal may create at most two entities.");
  return {
    actorType,
    subject,
    predicate,
    object,
    validFrom,
    validTo,
    evidence,
    idempotencyKey: optionalText(input.idempotencyKey, "idempotencyKey", 128),
    supersedesClaimId: input.supersedesClaimId === undefined ? undefined : validateEntityOrClaimId(input.supersedesClaimId, "supersedesClaimId", "clm_"),
    supersessionReason: optionalText(input.supersessionReason, "supersessionReason", 2_048),
    sessionId: optionalText(input.sessionId, "sessionId", MAX_PROVENANCE_LENGTH),
    sessionEntryId: optionalText(input.sessionEntryId, "sessionEntryId", MAX_PROVENANCE_LENGTH),
    toolCallId: optionalText(input.toolCallId, "toolCallId", MAX_PROVENANCE_LENGTH),
    branchLeaf: optionalText(input.branchLeaf, "branchLeaf", MAX_PROVENANCE_LENGTH),
  };
}

function normalizeEntity(value: unknown, field: string): NormalizedEntity {
  if (!isRecord(value)) throw new KnowledgeGraphProposalError("invalid_input", `${field} must be an entity reference.`);
  if (Object.keys(value).length === 1 && typeof value.entityId === "string") {
    if (!ID_PATTERN.test(value.entityId)) throw new KnowledgeGraphProposalError("invalid_input", `${field}.entityId is invalid.`);
    return { kind: "existing", entityId: value.entityId };
  }
  const label = requiredText(value.label, `${field}.label`, MAX_LABEL_LENGTH);
  const type = validateEntityType(value.type);
  const aliases = normalizeAliases(value.aliases, `${field}.aliases`);
  return { kind: "new", label, type, aliases };
}

function normalizeObject(value: unknown): NormalizedObject {
  if (!isRecord(value) || typeof value.kind !== "string") throw new KnowledgeGraphProposalError("invalid_input", "object must be a typed object.");
  if (value.kind === "entity") {
    if (typeof value.entityId === "string" && Object.keys(value).length === 2) {
      if (!ID_PATTERN.test(value.entityId)) throw new KnowledgeGraphProposalError("invalid_input", "object.entityId is invalid.");
      return { kind: "existing_entity", entityId: value.entityId };
    }
    const entity = normalizeEntity({ label: value.label, type: value.type, aliases: value.aliases }, "object");
    if (entity.kind === "existing") throw new KnowledgeGraphProposalError("invalid_input", "New object entity is malformed.");
    return { kind: "new_entity", label: entity.label, type: entity.type, aliases: entity.aliases };
  }
  if (value.kind === "text") return { kind: "text", value: requiredText(value.value, "object.value", 2_048) };
  if (value.kind === "number") {
    if (typeof value.value !== "number" || !Number.isFinite(value.value)) throw new KnowledgeGraphProposalError("invalid_input", "object.value must be a finite number.");
    return { kind: "number", value: value.value };
  }
  if (value.kind === "boolean") {
    if (typeof value.value !== "boolean") throw new KnowledgeGraphProposalError("invalid_input", "object.value must be a boolean.");
    return { kind: "boolean", value: value.value };
  }
  if (value.kind === "date") return { kind: "date", value: validateDate(value.value) };
  if (value.kind === "url") return { kind: "url", value: validateUrl(value.value) };
  throw new KnowledgeGraphProposalError("invalid_input", "object.kind is unsupported.");
}

function normalizeEvidence(value: unknown, index: number) {
  if (!isRecord(value)) throw new KnowledgeGraphProposalError("invalid_input", `evidence[${index}] is invalid.`);
  const sourceKind = validateSourceKind(value.sourceKind);
  const excerpt = requiredText(value.excerpt, `evidence[${index}].excerpt`, MAX_EXCERPT_LENGTH);
  const locator = optionalText(value.locator, `evidence[${index}].locator`, MAX_LOCATOR_LENGTH);
  const sourceObservedAt = optionalTimestamp(value.sourceObservedAt, `evidence[${index}].sourceObservedAt`);
  return { sourceKind, excerpt, locator, sourceObservedAt };
}

function normalizeAliases(value: unknown, field: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ALIAS_COUNT) throw new KnowledgeGraphProposalError("invalid_input", `${field} must contain at most ${MAX_ALIAS_COUNT} aliases.`);
  const normalized = value.map((alias, index) => requiredText(alias, `${field}[${index}]`, MAX_LABEL_LENGTH).normalize("NFKC").trim().replace(/\s+/gu, " "));
  return [...new Set(normalized)].sort();
}

function normalizePredicate(value: unknown): string {
  if (typeof value !== "string" || !PREDICATE_PATTERN.test(value)) throw new KnowledgeGraphProposalError("invalid_input", "predicate must be a normalized ASCII key.");
  return value;
}

function validateEntityType(value: unknown): EntityType {
  if (value === "person" || value === "project" || value === "repository" || value === "service" || value === "tool" || value === "organization" || value === "location" || value === "preference" || value === "concept" || value === "other") return value;
  throw new KnowledgeGraphProposalError("invalid_input", "entity type is invalid.");
}

function validateSourceKind(value: unknown): SourceKind {
  if (value === "user_statement" || value === "pi_session" || value === "file" || value === "command" || value === "url" || value === "other") return value;
  throw new KnowledgeGraphProposalError("invalid_input", "source kind is invalid.");
}

function validateActorType(value: unknown): ActorType {
  if (value === "user" || value === "agent" || value === "system") return value;
  throw new KnowledgeGraphProposalError("invalid_input", "actor type is invalid.");
}

function trustClassFor(sourceKind: SourceKind, actorType: ActorType) {
  if (sourceKind === "file") return "local_file" as const;
  if (sourceKind === "command") return "local_command" as const;
  if (sourceKind === "url") return "external" as const;
  if (sourceKind === "user_statement" && actorType === "user") return "user" as const;
  if (sourceKind === "pi_session" || actorType === "agent") return "agent" as const;
  return "unknown" as const;
}

function optionalTimestamp(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && value.endsWith("Z")) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  throw new KnowledgeGraphProposalError("invalid_input", `${field} must be a valid UTC timestamp.`);
}

function validateDate(value: unknown): string {
  const timestamp = optionalTimestamp(value, "object.value");
  if (timestamp === undefined) throw new KnowledgeGraphProposalError("invalid_input", "object.value must be a date.");
  return new Date(timestamp).toISOString();
}

function validateUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 1_024) throw new KnowledgeGraphProposalError("invalid_input", "object.value must be a bounded URL.");
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
  } catch {
    throw new KnowledgeGraphProposalError("invalid_input", "object.value must be an HTTP or HTTPS URL.");
  }
  return value;
}

function validateEntityOrClaimId(value: unknown, field: string, prefix: "clm_"): string {
  if (typeof value !== "string" || (prefix === "clm_" && !CLAIM_ID_PATTERN.test(value))) {
    throw new KnowledgeGraphProposalError("invalid_input", `${field} is invalid.`);
  }
  return value;
}

function requiredText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || [...value].length > maximum) throw new KnowledgeGraphProposalError("invalid_input", `${field} is invalid or too large.`);
  return value;
}

function optionalText(value: unknown, field: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, field, maximum);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

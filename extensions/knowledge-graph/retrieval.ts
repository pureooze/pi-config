import type { DatabaseSync } from "node:sqlite";
import {
  type ClaimRecord,
  type ClaimStatus,
  type ClaimObject,
  type EntityRecord,
  type EvidenceRecord,
  KnowledgeGraphRepositories,
  type ScopeId,
  validateScopeId,
} from "./repository.ts";

export interface SearchRequest {
  readonly query: string;
  readonly includeGlobal?: boolean;
  readonly includeHistory?: boolean;
  readonly asOf?: number | string;
  readonly limit?: number;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
}

export interface EvidenceCitation {
  readonly evidenceId: string;
  readonly excerpt: string;
  readonly locator: string | undefined;
  readonly sourceKind: EvidenceRecord["sourceKind"];
  readonly capturedAt: number;
  readonly untrusted: true;
}

export interface EntityResolutionMatch {
  readonly entityId: string;
  readonly scopeId: string;
  readonly label: string;
  readonly type: EntityRecord["type"];
  readonly matchedBy: "label" | "alias";
}

export interface EntityResolutionResponse {
  readonly matches: readonly EntityResolutionMatch[];
  readonly ambiguous: boolean;
}

export interface EntitySearchResult {
  readonly resultKind: "entity";
  readonly id: string;
  readonly scopeId: string;
  readonly entityId: string;
  readonly label: string;
  readonly type: EntityRecord["type"];
  readonly status: EntityRecord["status"];
  readonly score: number;
  readonly matchedFields: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly citations: readonly EvidenceCitation[];
}

export interface ClaimSearchResult {
  readonly resultKind: "claim";
  readonly id: string;
  readonly scopeId: string;
  readonly claimId: string;
  readonly subjectEntityId: string;
  readonly predicate: string;
  readonly object: ClaimObject;
  readonly status: ClaimStatus;
  readonly validFrom: number | undefined;
  readonly validTo: number | undefined;
  readonly score: number;
  readonly matchedFields: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly citations: readonly EvidenceCitation[];
}

export type SearchResult = EntitySearchResult | ClaimSearchResult;

export interface SearchDiagnostics {
  readonly queryTokenCount: number;
  readonly matchedDocuments: number;
  readonly candidateCount: number;
  readonly returnedCount: number;
  readonly visibility: readonly string[];
  readonly elapsedMs: number;
}

export interface SearchResponse {
  readonly schemaVersion: 1;
  readonly visibility: readonly string[];
  readonly results: readonly SearchResult[];
  readonly truncated: boolean;
  readonly insufficientEvidence: boolean;
  readonly diagnostics: SearchDiagnostics;
}

export interface OneHopRequest {
  readonly direction?: "incoming" | "outgoing" | "both";
  readonly includeHistory?: boolean;
  readonly asOf?: number | string;
  readonly limit?: number;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
}

export interface OneHopEdge {
  readonly claim: ClaimSearchResult;
  readonly neighborEntityId: string;
  readonly direction: "incoming" | "outgoing";
}

export interface OneHopResponse {
  readonly schemaVersion: 1;
  readonly entityId: string;
  readonly visibility: readonly string[];
  readonly edges: readonly OneHopEdge[];
  readonly truncated: boolean;
}

export interface GetRequest {
  readonly id: string;
  readonly view?: "summary" | "history" | "neighbors" | "evidence";
  readonly limit?: number;
  readonly direction?: "incoming" | "outgoing" | "both";
  readonly includeGlobal?: boolean;
  readonly asOf?: number | string;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
}

export interface EvidenceGetResult {
  readonly resultKind: "evidence";
  readonly id: string;
  readonly scopeId: string;
  readonly evidence: EvidenceCitation;
  readonly claims: readonly ClaimSearchResult[];
}

export interface GetResponse {
  readonly schemaVersion: 1;
  readonly visibility: readonly string[];
  readonly target: EntitySearchResult | ClaimSearchResult | EvidenceGetResult;
  readonly history: readonly ClaimSearchResult[];
  readonly neighbors: readonly OneHopEdge[];
  readonly truncated: boolean;
}

export type RetrievalErrorCode =
  | "invalid_query"
  | "invalid_scope"
  | "scope_not_found"
  | "not_found"
  | "cancelled"
  | "deadline_exceeded"
  | "storage_error";

export class KnowledgeGraphRetrievalError extends Error {
  readonly code: RetrievalErrorCode;

  constructor(code: RetrievalErrorCode, message: string) {
    super(message);
    this.name = "KnowledgeGraphRetrievalError";
    this.code = code;
  }
}

interface RetrievalOptions {
  readonly now?: () => number;
  readonly maxDocuments?: number;
}

interface SearchCandidate {
  readonly resultKind: "entity" | "claim";
  readonly id: string;
  readonly scopeId: string;
  score: number;
  readonly matchedFields: Set<string>;
}

interface SearchContext {
  readonly scopeIds: readonly string[];
  readonly includeHistory: boolean;
  readonly asOf: number | undefined;
  readonly explicitAsOf: boolean;
  readonly deadlineAt: number | undefined;
  readonly signal: AbortSignal | undefined;
}

type Row = Record<string, unknown>;

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const DEFAULT_MAX_DOCUMENTS = 400;
const MAX_QUERY_LENGTH = 512;
const MAX_EVIDENCE_CITATIONS = 3;
const MAX_EVIDENCE_OUTPUT_LENGTH = 1_000;
const MAX_DEADLINE_MS = 10_000;

export class KnowledgeGraphRetrieval {
  private readonly database: DatabaseSync;
  private readonly repositories: KnowledgeGraphRepositories;
  private readonly now: () => number;
  private readonly maxDocuments: number;

  constructor(
    database: DatabaseSync,
    repositories: KnowledgeGraphRepositories,
    options: RetrievalOptions = {},
  ) {
    this.database = database;
    this.repositories = repositories;
    this.now = options.now ?? Date.now;
    this.maxDocuments = options.maxDocuments ?? DEFAULT_MAX_DOCUMENTS;
  }

  resolveEntity(scopeId: ScopeId, query: string, includeGlobal = false): EntityResolutionResponse {
    const validScopeId = this.requireScope(scopeId);
    const normalizedQuery = normalizeLookupQuery(query);
    const scopeIds = includeGlobal && validScopeId !== "global"
      ? [validScopeId, "global"]
      : [validScopeId];
    const placeholders = scopeIds.map(() => "?").join(", ");
    const rows = this.getRows(
      `SELECT entity_id, scope_id, 'label' AS matched_by
       FROM entities
       WHERE scope_id IN (${placeholders}) AND status = 'accepted' AND normalized_label = ?
       UNION ALL
       SELECT a.entity_id, a.scope_id, 'alias' AS matched_by
       FROM aliases AS a
       WHERE a.scope_id IN (${placeholders}) AND a.status = 'accepted' AND a.normalized_alias = ?
       ORDER BY entity_id, matched_by`,
      [...scopeIds, normalizedQuery, ...scopeIds, normalizedQuery],
    );
    const matches = new Map<string, EntityResolutionMatch>();
    for (const row of rows) {
      const entityId = rowString(row, "entity_id");
      const rowScopeId = rowString(row, "scope_id");
      const entity = this.repositories.getEntity(rowScopeId, entityId);
      if (!entity) continue;
      const matchedBy = rowString(row, "matched_by");
      const current = matches.get(`${rowScopeId}:${entityId}`);
      if (current && current.matchedBy === "label") continue;
      matches.set(`${rowScopeId}:${entityId}`, {
        entityId: entity.entityId,
        scopeId: entity.scopeId,
        label: entity.label,
        type: entity.type,
        matchedBy: matchedBy === "label" ? "label" : "alias",
      });
    }
    const ordered = [...matches.values()].sort((left, right) => left.scopeId.localeCompare(right.scopeId) || left.entityId.localeCompare(right.entityId));
    return { matches: ordered, ambiguous: ordered.length > 1 };
  }

  search(scopeId: ScopeId, request: SearchRequest): SearchResponse {
    const startedAt = Date.now();
    const context = this.createContext(scopeId, request);
    const query = validateQuery(request.query);
    const tokens = tokenizeQuery(query);
    const limit = validateLimit(request.limit);

    if (tokens.length === 0) {
      return {
        schemaVersion: 1,
        visibility: context.scopeIds,
        results: [],
        truncated: false,
        insufficientEvidence: true,
        diagnostics: {
          queryTokenCount: 0,
          matchedDocuments: 0,
          candidateCount: 0,
          returnedCount: 0,
          visibility: context.scopeIds,
          elapsedMs: Date.now() - startedAt,
        },
      };
    }

    const matchQuery = makeFtsMatchQuery(tokens);
    const questionQuery = isQuestionQuery(tokens);
    const placeholders = context.scopeIds.map(() => "?").join(", ");
    const rows = this.getRows(
      `SELECT search_documents.doc_key, search_documents.scope_id, search_documents.record_kind,
              search_documents.record_id, search_documents.text, bm25(search_documents) AS rank
       FROM search_documents
       JOIN search_visibility AS visibility
         ON visibility.doc_key = search_documents.doc_key
        AND visibility.scope_id = search_documents.scope_id
        AND visibility.visible = 1
       WHERE search_documents MATCH ?
         AND search_documents.scope_id IN (${placeholders})
       ORDER BY rank ASC, search_documents.doc_key ASC
       LIMIT ?`,
      [matchQuery, ...context.scopeIds, Math.min(this.maxDocuments, Math.max(limit * 2, limit))],
    );

    const candidates = new Map<string, SearchCandidate>();
    for (const row of rows) {
      this.checkBudget(context);
      const matchedText = rowString(row, "text");
      if (questionQuery && countMatchedMeaningfulTokens(matchedText, tokens) < Math.min(2, meaningfulTokenCount(tokens))) continue;
      const recordKind = rowString(row, "record_kind");
      const scope = rowString(row, "scope_id");
      const recordId = rowString(row, "record_id");
      const rank = rowNumber(row, "rank");
      const score = Number.isFinite(rank) ? -rank : 0;
      if (recordKind === "entity") {
        const entity = this.repositories.getEntity(scope, recordId);
        if (entity && entity.status === "accepted") {
          this.addCandidate(candidates, "entity", entity.entityId, scope, score, "label");
        }
      } else if (recordKind === "alias") {
        const aliasId = rowStringFromDocKey(rowString(row, "doc_key"), "alias:");
        const alias = this.repositories.getAlias(scope, aliasId);
        if (alias && alias.status === "accepted") {
          this.addCandidate(candidates, "entity", alias.entityId, scope, score, "alias");
          this.addEntityRelatedClaims(candidates, scope, alias.entityId, score, context);
        }
      } else if (recordKind === "claim") {
        const claim = this.repositories.getClaim(scope, recordId);
        if (claim && this.isClaimVisible(claim, context)) {
          this.addCandidate(candidates, "claim", claim.claimId, scope, score, "claim");
          this.addClaimRelatedEntities(candidates, claim, score);
        }
      } else if (recordKind === "evidence") {
        const evidenceId = recordId;
        for (const claimId of this.findClaimIdsForEvidence(scope, evidenceId)) {
          const claim = this.repositories.getClaim(scope, claimId);
          if (claim && this.isClaimVisible(claim, context)) {
            this.addCandidate(candidates, "claim", claim.claimId, scope, score, "evidence");
            this.addClaimRelatedEntities(candidates, claim, score);
          }
        }
      }
    }

    const orderedCandidates = [...candidates.values()].sort(compareCandidates);
    const results: SearchResult[] = [];
    for (const candidate of orderedCandidates) {
      this.checkBudget(context);
      const result = candidate.resultKind === "entity"
        ? this.buildEntityResult(candidate, context)
        : this.buildClaimResult(candidate, context);
      if (result) results.push(result);
      if (results.length >= limit) break;
    }

    const elapsedMs = Date.now() - startedAt;
    return {
      schemaVersion: 1,
      visibility: context.scopeIds,
      results,
      truncated: orderedCandidates.length > limit,
      insufficientEvidence: results.length === 0,
      diagnostics: {
        queryTokenCount: tokens.length,
        matchedDocuments: rows.length,
        candidateCount: orderedCandidates.length,
        returnedCount: results.length,
        visibility: context.scopeIds,
        elapsedMs,
      },
    };
  }

  get(scopeId: ScopeId, request: GetRequest): GetResponse {
    const validScopeId = this.requireScope(scopeId);
    const view = request.view ?? "summary";
    if (view !== "summary" && view !== "history" && view !== "neighbors" && view !== "evidence") {
      throw new KnowledgeGraphRetrievalError("invalid_query", "View must be summary, history, neighbors, or evidence.");
    }
    const limit = validateLimit(request.limit);
    const includeGlobal = request.includeGlobal ?? false;
    const scopeIds = includeGlobal && validScopeId !== "global"
      ? [validScopeId, "global"]
      : [validScopeId];
    const includeHistory = view === "history";
    const explicitAsOf = request.asOf !== undefined;
    const asOf = explicitAsOf ? validateTimestamp(request.asOf, "asOf") : undefined;
    const context: SearchContext = {
      scopeIds,
      includeHistory,
      asOf,
      explicitAsOf,
      deadlineAt: makeDeadline(request.deadlineMs),
      signal: request.signal,
    };

    if (request.id.startsWith("ent_")) {
      for (const candidateScope of scopeIds) {
        const entity = this.repositories.getEntity(candidateScope, request.id);
        if (!entity || entity.status !== "accepted") continue;
        const result = this.buildEntityResult({
          resultKind: "entity",
          id: entity.entityId,
          scopeId: entity.scopeId,
          score: 1,
          matchedFields: new Set(["exact_id"]),
        }, context);
        if (!result) continue;
        const history = view === "history" ? this.entityClaims(entity, context, limit) : [];
        const neighbors = view === "neighbors"
          ? this.expandOneHop(candidateScope, entity.entityId, {
            direction: request.direction,
            includeHistory,
            asOf,
            limit,
            deadlineMs: request.deadlineMs,
            signal: request.signal,
          }).edges
          : [];
        return { schemaVersion: 1, visibility: scopeIds, target: result, history, neighbors, truncated: history.length >= limit || neighbors.length >= limit };
      }
      throw new KnowledgeGraphRetrievalError("not_found", "Entity was not found in the requested visibility.");
    }

    if (request.id.startsWith("clm_")) {
      for (const candidateScope of scopeIds) {
        const claim = this.repositories.getClaim(candidateScope, request.id);
        if (!claim || !this.isClaimVisible(claim, context)) continue;
        const result = this.toClaimResult(claim, 1, ["exact_id"]);
        const history = view === "history" ? this.claimHistory(candidateScope, claim.claimId, limit) : [];
        const neighbors = view === "neighbors" && claim.object.kind === "entity"
          ? this.expandOneHop(candidateScope, claim.object.entityId, {
            direction: request.direction,
            includeHistory,
            asOf,
            limit,
            deadlineMs: request.deadlineMs,
            signal: request.signal,
          }).edges
          : [];
        return { schemaVersion: 1, visibility: scopeIds, target: result, history, neighbors, truncated: history.length >= limit || neighbors.length >= limit };
      }
      throw new KnowledgeGraphRetrievalError("not_found", "Claim was not found in the requested visibility.");
    }

    if (request.id.startsWith("evd_")) {
      for (const candidateScope of scopeIds) {
        const evidence = this.repositories.getEvidence(candidateScope, request.id);
        if (!evidence) continue;
        const claims = this.findClaimIdsForEvidence(candidateScope, evidence.evidenceId, limit)
          .map((claimId) => this.repositories.getClaim(candidateScope, claimId))
          .filter((claim): claim is ClaimRecord => claim !== undefined && this.isClaimVisible(claim, context))
          .slice(0, limit)
          .map((claim) => this.toClaimResult(claim, 1, ["evidence"]));
        return {
          schemaVersion: 1,
          visibility: scopeIds,
          target: { resultKind: "evidence", id: evidence.evidenceId, scopeId: candidateScope, evidence: toCitation(evidence), claims },
          history: [],
          neighbors: [],
          truncated: claims.length >= limit,
        };
      }
      throw new KnowledgeGraphRetrievalError("not_found", "Evidence was not found in the requested visibility.");
    }

    throw new KnowledgeGraphRetrievalError("invalid_query", "ID must be an entity, claim, or evidence ID.");
  }

  expandOneHop(scopeId: ScopeId, entityId: string, request: OneHopRequest = {}): OneHopResponse {
    const validScopeId = this.requireScope(scopeId);
    const entity = this.repositories.getEntity(validScopeId, entityId);
    if (!entity || entity.status !== "accepted") {
      throw new KnowledgeGraphRetrievalError("not_found", "Entity was not found in the requested scope.");
    }
    const includeHistory = request.includeHistory ?? false;
    const explicitAsOf = request.asOf !== undefined;
    const asOf = explicitAsOf ? validateTimestamp(request.asOf, "asOf") : this.now();
    const limit = validateLimit(request.limit);
    const direction = request.direction ?? "both";
    if (direction !== "incoming" && direction !== "outgoing" && direction !== "both") {
      throw new KnowledgeGraphRetrievalError("invalid_query", "Direction must be incoming, outgoing, or both.");
    }
    const deadlineAt = makeDeadline(request.deadlineMs);
    const signal = request.signal;
    const edges: OneHopEdge[] = [];
    const directions: Array<"incoming" | "outgoing"> = direction === "both"
      ? ["outgoing", "incoming"]
      : [direction];

    for (const edgeDirection of directions) {
      this.checkBudget({ deadlineAt, signal });
      const predicate = edgeDirection === "outgoing"
        ? "subject_entity_id = ?"
        : "object_entity_id = ?";
      const rows = this.getRows(
        `SELECT claim_id
         FROM claims
         WHERE scope_id = ? AND ${predicate}
         ORDER BY claim_id
         LIMIT ?`,
        [validScopeId, entityId, limit + 1],
      );
      for (const row of rows) {
        this.checkBudget({ deadlineAt, signal });
        const claim = this.repositories.getClaim(validScopeId, rowString(row, "claim_id"));
        if (!claim || !this.isClaimVisible(claim, { scopeIds: [validScopeId], includeHistory, asOf, explicitAsOf, deadlineAt, signal })) continue;
        const neighborEntityId = edgeDirection === "outgoing"
          ? objectEntityId(claim.object)
          : claim.subjectEntityId;
        if (neighborEntityId === undefined) continue;
        edges.push({
          claim: this.toClaimResult(claim, 0, ["neighbor"]),
          neighborEntityId,
          direction: edgeDirection,
        });
        if (edges.length >= limit) {
          return {
            schemaVersion: 1,
            entityId,
            visibility: [validScopeId],
            edges,
            truncated: rows.length > limit,
          };
        }
      }
    }

    return {
      schemaVersion: 1,
      entityId,
      visibility: [validScopeId],
      edges,
      truncated: false,
    };
  }

  private createContext(scopeId: string, request: SearchRequest): SearchContext {
    const validScopeId = this.requireScope(scopeId);
    const includeGlobal = request.includeGlobal ?? false;
    const scopeIds = includeGlobal && validScopeId !== "global"
      ? [validScopeId, "global"]
      : [validScopeId];
    const includeHistory = request.includeHistory ?? false;
    const explicitAsOf = request.asOf !== undefined;
    const asOf = explicitAsOf ? validateTimestamp(request.asOf, "asOf") : undefined;
    return {
      scopeIds,
      includeHistory,
      asOf,
      explicitAsOf,
      deadlineAt: makeDeadline(request.deadlineMs),
      signal: request.signal,
    };
  }

  private requireScope(scopeId: string): string {
    let validScopeId: string;
    try {
      validScopeId = validateScopeId(scopeId);
    } catch {
      throw new KnowledgeGraphRetrievalError("invalid_scope", "Scope must be global or a project SHA-256 scope key.");
    }
    if (!this.repositories.getScope(validScopeId)) {
      throw new KnowledgeGraphRetrievalError("scope_not_found", "The requested scope is not registered.");
    }
    return validScopeId;
  }

  private addCandidate(
    candidates: Map<string, SearchCandidate>,
    resultKind: SearchCandidate["resultKind"],
    id: string,
    scopeId: string,
    score: number,
    field: string,
  ): void {
    const key = `${resultKind}:${scopeId}:${id}`;
    const existing = candidates.get(key);
    if (existing) {
      existing.score = Math.max(existing.score, score);
      existing.matchedFields.add(field);
      return;
    }
    candidates.set(key, {
      resultKind,
      id,
      scopeId,
      score,
      matchedFields: new Set([field]),
    });
  }

  private addEntityRelatedClaims(
    candidates: Map<string, SearchCandidate>,
    scopeId: string,
    entityId: string,
    score: number,
    context: SearchContext,
  ): void {
    for (const claimId of this.findClaimIdsForEntity(scopeId, entityId, this.maxDocuments)) {
      const claim = this.repositories.getClaim(scopeId, claimId);
      if (claim && this.isClaimVisible(claim, context)) {
        this.addCandidate(candidates, "claim", claim.claimId, scopeId, score, "entity_relation");
        this.addClaimRelatedEntities(candidates, claim, score);
      }
    }
  }

  private entityClaims(entity: EntityRecord, context: SearchContext, limit: number): ClaimSearchResult[] {
    return this.findClaimIdsForEntity(entity.scopeId, entity.entityId, limit)
      .map((claimId) => this.repositories.getClaim(entity.scopeId, claimId))
      .filter((claim): claim is ClaimRecord => claim !== undefined && this.isClaimVisible(claim, context))
      .slice(0, limit)
      .map((claim) => this.toClaimResult(claim, 1, ["history"]));
  }

  private claimHistory(scopeId: string, claimId: string, limit: number): ClaimSearchResult[] {
    const rows = this.getRows(
      `SELECT prior_claim_id, replacement_claim_id
       FROM claim_supersession
       WHERE scope_id = ? AND (prior_claim_id = ? OR replacement_claim_id = ?)
       ORDER BY created_at
       LIMIT ?`,
      [scopeId, claimId, claimId, limit],
    );
    const ids = new Set<string>();
    for (const row of rows) {
      ids.add(rowString(row, "prior_claim_id"));
      ids.add(rowString(row, "replacement_claim_id"));
    }
    return [...ids]
      .filter((id) => id !== claimId)
      .map((id) => this.repositories.getClaim(scopeId, id))
      .filter((claim): claim is ClaimRecord => claim !== undefined)
      .slice(0, limit)
      .map((claim) => this.toClaimResult(claim, 1, ["history"]));
  }

  private addClaimRelatedEntities(candidates: Map<string, SearchCandidate>, claim: ClaimRecord, score: number): void {
    const relatedScore = score;
    const subject = this.repositories.getEntity(claim.scopeId, claim.subjectEntityId);
    if (subject?.status === "accepted") {
      this.addCandidate(candidates, "entity", subject.entityId, claim.scopeId, relatedScore, "claim_entity");
    }
    const objectId = objectEntityId(claim.object);
    if (objectId === undefined || objectId === claim.subjectEntityId) return;
    const object = this.repositories.getEntity(claim.scopeId, objectId);
    if (object?.status === "accepted") {
      this.addCandidate(candidates, "entity", object.entityId, claim.scopeId, relatedScore, "claim_entity");
    }
  }

  private buildEntityResult(candidate: SearchCandidate, context: SearchContext): EntitySearchResult | undefined {
    const entity = this.repositories.getEntity(candidate.scopeId, candidate.id);
    if (!entity || entity.status !== "accepted") return undefined;
    const citations = this.entityCitations(entity, context);
    if (context.explicitAsOf && citations.length === 0) return undefined;
    return {
      resultKind: "entity",
      id: entity.entityId,
      scopeId: entity.scopeId,
      entityId: entity.entityId,
      label: entity.label,
      type: entity.type,
      status: entity.status,
      score: candidate.score,
      matchedFields: [...candidate.matchedFields].sort(),
      evidenceIds: citations.map((citation) => citation.evidenceId),
      citations,
    };
  }

  private buildClaimResult(candidate: SearchCandidate, context: SearchContext): ClaimSearchResult | undefined {
    const claim = this.repositories.getClaim(candidate.scopeId, candidate.id);
    if (!claim || !this.isClaimVisible(claim, context)) return undefined;
    return this.toClaimResult(claim, candidate.score, [...candidate.matchedFields].sort());
  }

  private toClaimResult(claim: ClaimRecord, score: number, matchedFields: readonly string[]): ClaimSearchResult {
    const citations = this.claimCitations(claim.scopeId, claim.claimId);
    return {
      resultKind: "claim",
      id: claim.claimId,
      scopeId: claim.scopeId,
      claimId: claim.claimId,
      subjectEntityId: claim.subjectEntityId,
      predicate: claim.predicate,
      object: claim.object,
      status: claim.status,
      validFrom: claim.validFrom,
      validTo: claim.validTo,
      score,
      matchedFields,
      evidenceIds: citations.map((citation) => citation.evidenceId),
      citations,
    };
  }

  private claimCitations(scopeId: string, claimId: string): readonly EvidenceCitation[] {
    return this.repositories
      .listClaimEvidence(scopeId, claimId)
      .slice(0, MAX_EVIDENCE_CITATIONS)
      .map((link) => toCitation(link.evidence));
  }

  private entityCitations(entity: EntityRecord, context: SearchContext): readonly EvidenceCitation[] {
    const claimIds = this.findClaimIdsForEntity(entity.scopeId, entity.entityId, MAX_EVIDENCE_CITATIONS * 16);
    const citations: EvidenceCitation[] = [];
    const seen = new Set<string>();
    for (const claimId of claimIds) {
      const claim = this.repositories.getClaim(entity.scopeId, claimId);
      if (!claim || !this.isClaimVisible(claim, context)) continue;
      for (const citation of this.claimCitations(entity.scopeId, claim.claimId)) {
        if (seen.has(citation.evidenceId)) continue;
        seen.add(citation.evidenceId);
        citations.push(citation);
        if (citations.length >= MAX_EVIDENCE_CITATIONS) return citations;
      }
    }
    return citations;
  }

  private findClaimIdsForEvidence(scopeId: string, evidenceId: string, limit = this.maxDocuments): string[] {
    return this.getRows(
      `SELECT claim_id
       FROM claim_evidence
       WHERE scope_id = ? AND evidence_id = ?
       ORDER BY claim_id
       LIMIT ?`,
      [scopeId, evidenceId, Math.min(this.maxDocuments, Math.max(1, limit))],
    ).map((row) => rowString(row, "claim_id"));
  }

  private findClaimIdsForEntity(scopeId: string, entityId: string, limit = this.maxDocuments): string[] {
    return this.getRows(
      `SELECT claim_id
       FROM claims
       WHERE scope_id = ? AND (subject_entity_id = ? OR object_entity_id = ?)
       ORDER BY claim_id
       LIMIT ?`,
      [scopeId, entityId, entityId, Math.min(this.maxDocuments, Math.max(1, limit))],
    ).map((row) => rowString(row, "claim_id"));
  }

  private isClaimVisible(claim: ClaimRecord, context: SearchContext): boolean {
    if (claim.status !== "accepted" && !(context.includeHistory && claim.status === "superseded")) return false;
    if (context.includeHistory && !context.explicitAsOf) return true;
    const asOf = context.asOf ?? this.now();
    return (claim.validFrom === undefined || claim.validFrom <= asOf) &&
      (claim.validTo === undefined || asOf < claim.validTo);
  }

  private checkBudget(context: Pick<SearchContext, "signal" | "deadlineAt">): void {
    if (context.signal?.aborted) {
      throw new KnowledgeGraphRetrievalError("cancelled", "Knowledge-graph retrieval was cancelled.");
    }
    if (context.deadlineAt !== undefined && Date.now() >= context.deadlineAt) {
      throw new KnowledgeGraphRetrievalError("deadline_exceeded", "Knowledge-graph retrieval exceeded its deadline.");
    }
  }

  private getRows(sql: string, parameters: readonly (string | number | null)[]): Row[] {
    try {
      return this.database.prepare(sql).all(...parameters).filter(isRow);
    } catch {
      throw new KnowledgeGraphRetrievalError("storage_error", "Knowledge-graph search failed.");
    }
  }
}

export function serializeSearchResponse(response: SearchResponse, maximumBytes = 12 * 1024): string {
  if (!Number.isInteger(maximumBytes) || maximumBytes < 1_024) {
    throw new KnowledgeGraphRetrievalError("invalid_query", "Response byte limit is invalid.");
  }
  let results = [...response.results];
  while (true) {
    const candidate: SearchResponse = {
      ...response,
      results,
      truncated: response.truncated || results.length < response.results.length,
      diagnostics: { ...response.diagnostics, returnedCount: results.length },
    };
    const serialized = JSON.stringify(candidate);
    if (Buffer.byteLength(serialized, "utf8") <= maximumBytes) return serialized;
    if (results.length === 0) break;
    results = results.slice(0, -1);
  }

  const minimal = JSON.stringify({
    schemaVersion: 1,
    visibility: response.visibility,
    results: [],
    truncated: true,
    insufficientEvidence: true,
  });
  if (Buffer.byteLength(minimal, "utf8") > maximumBytes) {
    throw new KnowledgeGraphRetrievalError("storage_error", "Response metadata exceeds the configured byte limit.");
  }
  return minimal;
}

export function serializeGetResponse(response: GetResponse, maximumBytes = 12 * 1024): string {
  if (!Number.isInteger(maximumBytes) || maximumBytes < 1_024) {
    throw new KnowledgeGraphRetrievalError("invalid_query", "Response byte limit is invalid.");
  }
  let history = [...response.history];
  let neighbors = [...response.neighbors];
  let evidenceClaims = response.target.resultKind === "evidence" ? [...response.target.claims] : undefined;
  while (true) {
    const target = evidenceClaims === undefined || response.target.resultKind !== "evidence"
      ? response.target
      : { ...response.target, claims: evidenceClaims };
    const candidate: GetResponse = { ...response, target, history, neighbors, truncated: response.truncated || history.length < response.history.length || neighbors.length < response.neighbors.length };
    const serialized = JSON.stringify(candidate);
    if (Buffer.byteLength(serialized, "utf8") <= maximumBytes) return serialized;
    if (evidenceClaims !== undefined && evidenceClaims.length > 0) {
      evidenceClaims = evidenceClaims.slice(0, -1);
    } else if (history.length > 0) {
      history = history.slice(0, -1);
    } else if (neighbors.length > 0) {
      neighbors = neighbors.slice(0, -1);
    } else {
      break;
    }
  }
  const minimal = JSON.stringify({
    schemaVersion: 1,
    visibility: response.visibility,
    target: response.target.resultKind === "evidence"
      ? { resultKind: "evidence", id: response.target.id, scopeId: response.target.scopeId, evidence: response.target.evidence, claims: [] }
      : { resultKind: response.target.resultKind, id: response.target.id, scopeId: response.target.scopeId },
    history: [],
    neighbors: [],
    truncated: true,
  });
  if (Buffer.byteLength(minimal, "utf8") > maximumBytes) {
    throw new KnowledgeGraphRetrievalError("storage_error", "Response metadata exceeds the configured byte limit.");
  }
  return minimal;
}

function normalizeLookupQuery(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || codePointLength(value) > 256) {
    throw new KnowledgeGraphRetrievalError("invalid_query", "Entity lookup must be a bounded non-empty string.");
  }
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");
  if (normalized.length === 0) throw new KnowledgeGraphRetrievalError("invalid_query", "Entity lookup is empty.");
  return normalized;
}

function validateQuery(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || codePointLength(value) > MAX_QUERY_LENGTH) {
    throw new KnowledgeGraphRetrievalError("invalid_query", "Search query must be a bounded non-empty string.");
  }
  return value.normalize("NFKC").trim();
}

function tokenizeQuery(query: string): string[] {
  const tokens = query.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const normalized = tokens.map((token) => token.toLocaleLowerCase("und"));
  const expanded = normalized.flatMap((token) => {
    if (token === "dependency" || token === "dependencies") return [token, "depend"];
    if (token === "relationship" || token === "relationships") return [token, "relat"];
    if (token === "deployment" || token === "deployments") return [token, "deploy"];
    return [token];
  });
  return [...new Set(expanded)];
}

function isQuestionQuery(tokens: readonly string[]): boolean {
  return tokens.some((token) => ["who", "what", "when", "where", "which", "how", "does", "is", "are", "can"].includes(token));
}

const QUERY_STOP_WORDS = new Set([
  "a", "an", "are", "can", "do", "does", "for", "how", "in", "is", "of", "on", "own", "owns", "the", "to", "what", "when", "where", "which", "who",
]);

function meaningfulTokenCount(tokens: readonly string[]): number {
  return tokens.filter((token) => !QUERY_STOP_WORDS.has(token)).length;
}

function countMatchedMeaningfulTokens(text: string, tokens: readonly string[]): number {
  const textTokens = tokenizeQuery(text);
  return tokens.filter((token) =>
    !QUERY_STOP_WORDS.has(token) && textTokens.some((textToken) => textToken.startsWith(token)),
  ).length;
}

function makeFtsMatchQuery(tokens: readonly string[]): string {
  return tokens
    .map((token) => `"${token.replaceAll('"', '""')}"*`)
    .join(" OR ");
}

function validateLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new KnowledgeGraphRetrievalError("invalid_query", `Limit must be an integer from 1 through ${MAX_LIMIT}.`);
  }
  return value;
}

function validateTimestamp(value: unknown, field: string): number {
  if (typeof value === "string") {
    if (!value.endsWith("Z")) throw new KnowledgeGraphRetrievalError("invalid_query", `${field} must be a UTC timestamp.`);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new KnowledgeGraphRetrievalError("invalid_query", `${field} must be a non-negative integer timestamp.`);
  }
  return value;
}

function makeDeadline(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_DEADLINE_MS) {
    throw new KnowledgeGraphRetrievalError("invalid_query", `deadlineMs must be an integer from 1 through ${MAX_DEADLINE_MS}.`);
  }
  return Date.now() + value;
}

function compareCandidates(left: SearchCandidate, right: SearchCandidate): number {
  return right.score - left.score || left.resultKind.localeCompare(right.resultKind) || left.scopeId.localeCompare(right.scopeId) || left.id.localeCompare(right.id);
}

function toCitation(evidence: EvidenceRecord): EvidenceCitation {
  return {
    evidenceId: evidence.evidenceId,
    excerpt: truncateCodePoints(evidence.excerpt, MAX_EVIDENCE_OUTPUT_LENGTH),
    locator: evidence.locator,
    sourceKind: evidence.sourceKind,
    capturedAt: evidence.capturedAt,
    untrusted: true,
  };
}

function objectEntityId(object: ClaimObject): string | undefined {
  return object.kind === "entity" ? object.entityId : undefined;
}

function rowString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new KnowledgeGraphRetrievalError("storage_error", `Search row ${key} is invalid.`);
  return value;
}

function rowStringFromDocKey(docKey: string, prefix: string): string {
  if (!docKey.startsWith(prefix)) throw new KnowledgeGraphRetrievalError("storage_error", "Search document key is invalid.");
  return docKey.slice(prefix.length);
}

function rowNumber(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value;
}

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codePointLength(value: string): number {
  return [...value].length;
}

function truncateCodePoints(value: string, maximum: number): string {
  const characters = [...value];
  return characters.length > maximum
    ? `${characters.slice(0, maximum).join("")}…`
    : value;
}

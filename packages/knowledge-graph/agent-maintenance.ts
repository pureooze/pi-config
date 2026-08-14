import {
  KnowledgeGraphDeletionService,
  type KnowledgeGraphDeletionPreview,
} from "./deletion.ts";
import {
  KnowledgeGraphProposalService,
  type ProposalEvidenceInput,
  type ProposedEntity,
  type ProposedObject,
} from "./proposal.ts";
import {
  KnowledgeGraphRepositories,
  type ProposalCandidateRecords,
  type ProposalStatus,
} from "./repository.ts";
import { assertNoSecrets } from "./security.ts";
import type { DatabaseSync } from "node:sqlite";

export interface AgentMaintenanceProvenance {
  readonly sessionId?: string;
  readonly sessionEntryId?: string;
  readonly toolCallId?: string;
  readonly branchLeaf?: string;
}

export interface AgentClaimMaintenanceInput {
  readonly operation: "insert" | "update";
  readonly subject: ProposedEntity;
  readonly predicate: string;
  readonly object: ProposedObject;
  readonly validFrom?: number | string;
  readonly validTo?: number | string;
  readonly evidence: readonly ProposalEvidenceInput[];
  readonly idempotencyKey?: string;
  readonly supersedesClaimId?: string;
  readonly supersessionReason?: string;
}

export interface AgentDeleteMaintenanceInput {
  readonly operation: "delete";
  readonly targetId: string;
  readonly reason: string;
}

export type AgentMaintenanceInput = AgentClaimMaintenanceInput | AgentDeleteMaintenanceInput;

export class KnowledgeGraphAgentMaintenanceError extends Error {
  readonly code = "invalid_input" as const;

  constructor(message: string) {
    super(message);
    this.name = "KnowledgeGraphAgentMaintenanceError";
  }
}

export interface AgentClaimMaintenanceResult {
  readonly operation: "insert" | "update";
  readonly scopeId: string;
  readonly status: "accepted" | "already_known";
  readonly durable: true;
  readonly claimIds: readonly string[];
  readonly entityIds: readonly string[];
  readonly evidenceIds: readonly string[];
}

export interface AgentDeleteMaintenanceResult {
  readonly operation: "delete";
  readonly scopeId: string;
  readonly status: "deleted";
  readonly durable: true;
  readonly targetId: string;
  readonly affected: KnowledgeGraphDeletionPreview["counts"];
  readonly auditEventId: string;
}

export type AgentMaintenanceResult = AgentClaimMaintenanceResult | AgentDeleteMaintenanceResult;

export class KnowledgeGraphAgentMaintenanceService {
  private readonly proposals: KnowledgeGraphProposalService;
  private readonly deletion: KnowledgeGraphDeletionService;

  constructor(database: DatabaseSync, repositories: KnowledgeGraphRepositories) {
    this.proposals = new KnowledgeGraphProposalService(repositories);
    this.deletion = new KnowledgeGraphDeletionService(database, repositories);
  }

  execute(
    scopeId: string,
    input: AgentMaintenanceInput,
    provenance: AgentMaintenanceProvenance,
  ): AgentMaintenanceResult {
    if (input.operation === "delete") return this.delete(scopeId, input, provenance);
    return this.acceptClaim(scopeId, input, provenance);
  }

  private acceptClaim(
    scopeId: string,
    input: AgentClaimMaintenanceInput,
    provenance: AgentMaintenanceProvenance,
  ): AgentClaimMaintenanceResult {
    if (input.operation === "update" && input.supersedesClaimId === undefined) {
      throw new KnowledgeGraphAgentMaintenanceError("An update must identify the accepted claim it supersedes.");
    }
    if (input.operation === "insert" && input.supersedesClaimId !== undefined) {
      throw new KnowledgeGraphAgentMaintenanceError("An insert cannot supersede an existing claim.");
    }

    const submission = this.proposals.submit(scopeId, {
      actorType: "agent",
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      validFrom: input.validFrom,
      validTo: input.validTo,
      evidence: input.evidence,
      idempotencyKey: input.idempotencyKey,
      supersedesClaimId: input.supersedesClaimId,
      supersessionReason: input.supersessionReason,
      sessionId: provenance.sessionId,
      sessionEntryId: provenance.sessionEntryId,
      toolCallId: provenance.toolCallId,
      branchLeaf: provenance.branchLeaf,
    });

    if (submission.status === "already_known" && submission.proposal.status !== "pending") {
      return this.claimResult(input.operation, scopeId, submission.proposal.status, submission.candidates, true);
    }

    const reviewed = this.proposals.review(scopeId, submission.proposal.proposalId, "accepted", {
      actorType: "agent",
      sessionId: provenance.sessionId,
      sessionEntryId: provenance.sessionEntryId,
      toolCallId: provenance.toolCallId,
      branchLeaf: provenance.branchLeaf,
    });
    return this.claimResult(input.operation, scopeId, reviewed.proposal.status, reviewed.candidates, false);
  }

  private delete(
    scopeId: string,
    input: AgentDeleteMaintenanceInput,
    provenance: AgentMaintenanceProvenance,
  ): AgentDeleteMaintenanceResult {
    assertNoSecrets([{ field: "reason", text: input.reason }]);
    const result = this.deletion.forget(scopeId, input.targetId, {
      actorType: "agent",
      sessionId: provenance.sessionId,
      sessionEntryId: provenance.sessionEntryId,
      toolCallId: provenance.toolCallId,
      branchLeaf: provenance.branchLeaf,
      reason: input.reason,
    });
    return {
      operation: "delete",
      scopeId,
      status: "deleted",
      durable: true,
      targetId: input.targetId,
      affected: result.preview.counts,
      auditEventId: result.auditEvent.auditEventId,
    };
  }

  private claimResult(
    operation: "insert" | "update",
    scopeId: string,
    proposalStatus: ProposalStatus,
    candidates: ProposalCandidateRecords,
    alreadyKnown: boolean,
  ): AgentClaimMaintenanceResult {
    const status = alreadyKnown && proposalStatus === "accepted" ? "already_known" : proposalStatus;
    if (status !== "accepted" && status !== "already_known") {
      throw new KnowledgeGraphAgentMaintenanceError("Autonomous maintenance did not produce a durable accepted result.");
    }
    return {
      operation,
      scopeId,
      status,
      durable: true,
      claimIds: candidates.claims.map((claim) => claim.claimId),
      entityIds: candidates.entities.map((entity) => entity.entityId),
      evidenceIds: candidates.evidence.map((evidence) => evidence.evidenceId),
    };
  }
}

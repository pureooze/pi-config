import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { resolveKnowledgeGraphConfig } = await import("../../extensions/knowledge-graph/config.ts");
const { KnowledgeGraphDatabase } = await import("../../extensions/knowledge-graph/database.ts");
const {
  KnowledgeGraphRepositories,
  computeCandidateFingerprint,
} = await import("../../extensions/knowledge-graph/repository.ts");

export const GLOBAL_SCOPE = "global";
export const PROJECT_SCOPE = `project:${"a".repeat(64)}`;
export const OTHER_PROJECT_SCOPE = `project:${"b".repeat(64)}`;
export const FIXTURE_NOW = 1_700_000_000_000;

export function fixtureId(prefix, number) {
  return `${prefix}00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

export function createKnowledgeGraphFixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-knowledge-graph-core-"));
  const config = resolveKnowledgeGraphConfig({
    cwd: join(root, "project"),
    projectRoot: join(root, "project"),
    projectTrusted: false,
    env: { PI_KNOWLEDGE_GRAPH_DIR: join(root, "store") },
    homeDirectory: join(root, "home"),
  });
  const database = new KnowledgeGraphDatabase({ paths: config, now: () => FIXTURE_NOW });
  const repositories = new KnowledgeGraphRepositories(database.open(), { now: () => FIXTURE_NOW });
  repositories.registerScope({ scopeId: GLOBAL_SCOPE, kind: "global" });
  repositories.registerScope({
    scopeId: PROJECT_SCOPE,
    kind: "project",
    projectRoot: join(root, "project"),
    identityPath: join(root, "project", ".git"),
  });
  repositories.registerScope({ scopeId: OTHER_PROJECT_SCOPE, kind: "project" });
  return { root, config, database, repositories };
}

export function seedKnowledgeGraphFixture(fixture) {
  const { repositories } = fixture;
  const entity = repositories.createEntity(PROJECT_SCOPE, {
    entityId: fixtureId("ent_", 1),
    label: "Atlas API",
    type: "service",
    status: "accepted",
  });
  const alias = repositories.createAlias(PROJECT_SCOPE, {
    aliasId: fixtureId("als_", 1),
    entityId: entity.entityId,
    alias: "Atlas",
    status: "accepted",
  });
  const evidence = repositories.createEvidence(PROJECT_SCOPE, {
    evidenceId: fixtureId("evd_", 1),
    sourceKind: "user_statement",
    locator: "session:fixture",
    excerpt: "The Atlas API is the project service boundary.",
    sourceObservedAt: FIXTURE_NOW - 1_000,
    trustClass: "user",
    sessionId: "fixture-session",
    actorType: "user",
  });
  const claim = repositories.createClaim(PROJECT_SCOPE, {
    claimId: fixtureId("clm_", 1),
    subjectEntityId: entity.entityId,
    predicate: "is.service_boundary",
    object: { kind: "boolean", value: true },
    status: "accepted",
  });
  repositories.attachEvidence(PROJECT_SCOPE, {
    claimId: claim.claimId,
    evidenceId: evidence.evidenceId,
    role: "primary",
  });
  const proposal = repositories.createProposal(PROJECT_SCOPE, {
    proposalId: fixtureId("prp_", 1),
    candidateFingerprint: computeCandidateFingerprint("fixture-proposal-v1"),
    idempotencyKey: "fixture-proposal-v1",
    actorType: "agent",
    sessionId: "fixture-session",
  });
  const audit = repositories.appendAuditEvent(PROJECT_SCOPE, {
    auditEventId: fixtureId("aud_", 1),
    actorType: "system",
    action: "proposal_created",
    targetType: "proposal",
    targetId: proposal.proposalId,
    sessionId: "fixture-session",
  });
  return { entity, alias, evidence, claim, proposal, audit };
}

export function cleanupKnowledgeGraphFixture(fixture) {
  fixture.database.close();
  rmSync(fixture.root, { recursive: true, force: true });
}

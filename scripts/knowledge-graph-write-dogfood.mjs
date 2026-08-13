import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { KnowledgeGraphAgentMaintenanceService } = await import("../extensions/knowledge-graph/agent-maintenance.ts");
const { KnowledgeGraphSessionRuntime } = await import("../extensions/knowledge-graph/session.ts");

const root = mkdtempSync(join(tmpdir(), "pi-knowledge-graph-write-dogfood-"));
const projectA = join(root, "project-a");
const projectB = join(root, "project-b");
mkdirSync(projectA, { recursive: true });
mkdirSync(projectB, { recursive: true });
const previousStorageRoot = process.env.PI_KNOWLEDGE_GRAPH_DIR;
process.env.PI_KNOWLEDGE_GRAPH_DIR = join(root, "store");
const observations = [];

function freshSession(cwd, sessionId, operation) {
  const runtime = new KnowledgeGraphSessionRuntime();
  const context = { cwd, isProjectTrusted: () => false };
  runtime.start(context);
  try {
    const current = runtime.ensure(context);
    return operation(current, sessionId);
  } finally {
    runtime.close();
  }
}

try {
  const first = freshSession(projectA, "dogfood-session-1", (current, sessionId) => {
    const maintenance = new KnowledgeGraphAgentMaintenanceService(current.database.open(), current.repositories);
    const accepted = maintenance.execute(current.project.scopeId, {
      operation: "insert",
      subject: { label: "Dogfood App", type: "project", aliases: ["dogfood"] },
      predicate: "release_channel",
      object: { kind: "text", value: "beta" },
      evidence: [{ sourceKind: "user_statement", excerpt: "Dogfood App currently uses the beta release channel." }],
    }, {
      sessionId,
      sessionEntryId: "entry-1",
      toolCallId: "tool-1",
      branchLeaf: "leaf-1",
    });
    assert.equal(accepted.status, "accepted");
    observations.push({ sessionId, project: "project-a", action: "autonomous-insert" });
    return {
      scopeId: current.project.scopeId,
      entityId: accepted.entityIds[0],
      claimId: accepted.claimIds[0],
    };
  });

  freshSession(projectA, "dogfood-session-2", (current, sessionId) => {
    const response = current.retrieval.search(current.project.scopeId, { query: "Dogfood App beta", limit: 5 });
    assert.equal(response.insufficientEvidence, false);
    assert.equal(response.results.some((result) => result.claimId === first.claimId), true);
    observations.push({ sessionId, project: "project-a", action: "recall", recalled: true, resultCount: response.results.length });
  });

  const correction = freshSession(projectA, "dogfood-session-3", (current, sessionId) => {
    const maintenance = new KnowledgeGraphAgentMaintenanceService(current.database.open(), current.repositories);
    const accepted = maintenance.execute(current.project.scopeId, {
      operation: "update",
      subject: { entityId: first.entityId },
      predicate: "release_channel",
      object: { kind: "text", value: "stable" },
      supersedesClaimId: first.claimId,
      supersessionReason: "The release channel changed to stable.",
      evidence: [{ sourceKind: "user_statement", excerpt: "Dogfood App now uses the stable release channel." }],
    }, {
      sessionId,
      toolCallId: "tool-3",
      branchLeaf: "leaf-3",
    });
    assert.equal(accepted.status, "accepted");
    observations.push({ sessionId, project: "project-a", action: "autonomous-update" });
    return accepted.claimIds[0];
  });

  freshSession(projectB, "dogfood-session-4", (current, sessionId) => {
    const response = current.retrieval.search(current.project.scopeId, { query: "Dogfood App stable", limit: 5 });
    assert.equal(response.insufficientEvidence, false);
    assert.equal(response.results.some((result) => result.claimId === correction), true);
    observations.push({ sessionId, project: "project-b", action: "shared-recall", shared: true, resultCount: response.results.length });
  });

  freshSession(projectA, "dogfood-session-5", (current, sessionId) => {
    const response = current.retrieval.search(current.project.scopeId, { query: "Dogfood App stable", limit: 5 });
    assert.equal(response.results.some((result) => result.claimId === correction), true);
    assert.equal(response.results.some((result) => result.claimId === first.claimId), false);
    const history = current.retrieval.get(current.project.scopeId, { id: correction, view: "history" });
    assert.equal(history.history.some((result) => result.id === first.claimId), true);
    observations.push({ sessionId, project: "project-a", action: "recall-corrected-history", supersededHistoryRetained: true });
  });

  console.log(JSON.stringify({
    status: "pass",
    freshSessions: observations.length,
    sharedScope: true,
    autonomousMutations: observations.filter((observation) => observation.action.startsWith("autonomous-")).length,
    observations,
  }, null, 2));
} finally {
  if (previousStorageRoot === undefined) delete process.env.PI_KNOWLEDGE_GRAPH_DIR;
  else process.env.PI_KNOWLEDGE_GRAPH_DIR = previousStorageRoot;
  rmSync(root, { recursive: true, force: true });
}

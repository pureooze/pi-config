import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { KnowledgeGraphSessionRuntime } = await import("../../extensions/knowledge-graph/session.ts");

function context() {
  return { cwd: process.cwd(), isProjectTrusted: () => false };
}

test("session runtime resolves scope, opens lazily, closes idempotently, and recalls across sessions", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-knowledge-graph-session-test-"));
  const previous = process.env.PI_KNOWLEDGE_GRAPH_DIR;
  process.env.PI_KNOWLEDGE_GRAPH_DIR = join(root, "store");
  try {
    const first = new KnowledgeGraphSessionRuntime();
    first.start(context());
    const runtime = first.ensure(context());
    const entity = runtime.repositories.createEntity(runtime.project.scopeId, {
      entityId: "ent_00000000-0000-4000-8000-000000000901",
      label: "Session service",
      type: "service",
      status: "accepted",
    });
    const evidence = runtime.repositories.createEvidence(runtime.project.scopeId, {
      evidenceId: "evd_00000000-0000-4000-8000-000000000901",
      sourceKind: "user_statement",
      excerpt: "The session service persists across sessions.",
      trustClass: "user",
    });
    const claim = runtime.repositories.createClaim(runtime.project.scopeId, {
      claimId: "clm_00000000-0000-4000-8000-000000000901",
      subjectEntityId: entity.entityId,
      predicate: "persists_across",
      object: { kind: "text", value: "sessions" },
      status: "accepted",
    });
    runtime.repositories.attachEvidence(runtime.project.scopeId, {
      claimId: claim.claimId,
      evidenceId: evidence.evidenceId,
      role: "primary",
    });
    first.close();
    first.close();

    for (let index = 0; index < 3; index += 1) {
      const next = new KnowledgeGraphSessionRuntime();
      next.start(context());
      const nextRuntime = next.ensure(context());
      const response = nextRuntime.retrieval.search(nextRuntime.project.scopeId, { query: "session service" });
      assert.equal(response.results.some((result) => result.id === entity.entityId), true);
      assert.equal(response.results.some((result) => result.id === claim.claimId), true);
      next.close();
    }
  } finally {
    if (previous === undefined) delete process.env.PI_KNOWLEDGE_GRAPH_DIR;
    else process.env.PI_KNOWLEDGE_GRAPH_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { resolveKnowledgeScope } = await import("../../extensions/knowledge-graph/scope.ts");

test("knowledge scope is shared while config context still resolves through Git", () => {
  const scope = resolveKnowledgeScope(process.cwd());
  assert.equal(scope.kind, "global");
  assert.equal(scope.source, "git-common-dir");
  assert.equal(scope.scopeId, "global");
  assert.equal(scope.projectRoot.length > 0, true);
  assert.equal(scope.identityPath.length > 0, true);
});

test("non-Git directories share knowledge while retaining canonical config context", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-knowledge-graph-scope-test-"));
  try {
    const nested = join(root, "nested");
    mkdirSync(nested);
    const rootScope = resolveKnowledgeScope(root);
    const nestedScope = resolveKnowledgeScope(nested);
    assert.equal(rootScope.source, "directory");
    assert.equal(nestedScope.source, "directory");
    assert.equal(rootScope.scopeId, "global");
    assert.equal(nestedScope.scopeId, "global");
    assert.equal(rootScope.identityPath, realpathSync(root));
    assert.equal(nestedScope.identityPath, realpathSync(nested));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

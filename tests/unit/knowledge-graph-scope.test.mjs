import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { resolveProjectScope } = await import("../../extensions/knowledge-graph/scope.ts");

test("project scope resolution uses the Git common directory for this repository", () => {
  const scope = resolveProjectScope(process.cwd());
  assert.equal(scope.kind, "project");
  assert.equal(scope.source, "git-common-dir");
  assert.match(scope.scopeId, /^project:[0-9a-f]{64}$/u);
  assert.equal(scope.projectRoot.length > 0, true);
  assert.equal(scope.identityPath.length > 0, true);
});

test("non-Git scope resolution is canonical-directory based", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-knowledge-graph-scope-test-"));
  try {
    const nested = join(root, "nested");
    mkdirSync(nested);
    const rootScope = resolveProjectScope(root);
    const nestedScope = resolveProjectScope(nested);
    assert.equal(rootScope.source, "directory");
    assert.equal(nestedScope.source, "directory");
    assert.notEqual(rootScope.scopeId, nestedScope.scopeId);
    assert.equal(rootScope.identityPath, realpathSync(root));
    assert.equal(nestedScope.identityPath, realpathSync(nested));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

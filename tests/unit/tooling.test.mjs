import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("MVP corpus fixture is present and deterministic", () => {
  const fixturePath = resolve(process.cwd(), "tests/fixtures/knowledge-graph-mvp-corpus.json");
  const corpus = JSON.parse(readFileSync(fixturePath, "utf8"));

  assert.equal(corpus.schemaVersion, 1);
  assert.equal(corpus.corpusId, "pi-knowledge-graph-mvp-v1");
  assert.equal(corpus.claims.length, 35);
  assert.equal(corpus.evidence.length, 35);
  assert.equal(corpus.queries.length, 22);
  assert.equal(corpus.scopes.filter((scope) => scope.kind === "project").length, 2);
});

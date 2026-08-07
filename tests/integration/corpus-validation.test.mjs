import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("corpus validator passes as an integration command", () => {
  const result = spawnSync(process.execPath, ["scripts/validate-knowledge-graph-mvp-corpus.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "pass");
  assert.equal(summary.claims, 35);
});

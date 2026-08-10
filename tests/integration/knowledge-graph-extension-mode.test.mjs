import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const extensionPath = resolve("extensions/knowledge-graph/index.ts");

for (const command of ["--help", "--list-models"]) {
  test(`knowledge graph extension loads in offline JSON mode with ${command}`, () => {
    const result = spawnSync(
      "pi",
      ["--offline", "--no-extensions", "--no-context-files", "--no-session", "-e", extensionPath, "--mode", "json", command],
      { cwd: process.cwd(), encoding: "utf8", input: "", timeout: 15_000 },
    );
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.length + result.stderr.length > 0, true);
  });
}

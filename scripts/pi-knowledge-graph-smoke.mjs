import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(process.cwd());
const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-knowledge-graph-smoke-"));
const markerPath = join(temporaryRoot, "extension-loaded.marker");
const extensionPath = resolve(repositoryRoot, "tests/fixtures/pi-smoke-extension.ts");

try {
  const result = spawnSync(
    "pi",
    [
      "--offline",
      "--no-extensions",
      "--no-context-files",
      "--no-session",
      "-e",
      extensionPath,
      "--mode",
      "json",
    ],
    {
      cwd: repositoryRoot,
      env: { ...process.env, PI_KG_SMOKE_MARKER: markerPath },
      encoding: "utf8",
      input: "",
      timeout: 15_000,
    },
  );

  assert.equal(result.error, undefined, `Pi smoke process failed to start: ${result.error?.message ?? "unknown error"}`);
  assert.equal(result.status, 0, `Pi smoke process exited ${result.status}: ${result.stderr}`);
  assert.equal(existsSync(markerPath), true, "explicit test extension did not run");
  assert.equal(readFileSync(markerPath, "utf8"), "loaded\n");

  console.log(JSON.stringify({
    status: "pass",
    pi: "offline-json",
    explicitExtension: true,
    marker: "temporary",
  }, null, 2));
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const report = new URL("../../scripts/delegate-report.mjs", import.meta.url);

test("cache report separates first request from later requests and excludes legacy from measured cohort", () => {
  const dir = mkdtempSync(join(tmpdir(), "delegate-cache-report-"));
  try {
    mkdirSync(join(dir, "delegate"));
    const rows = [
      { status: "completed", provider: "minimax", model: "MiniMax-M3", type: "explore",
        assistantRequests: 2, firstRequestInputTokens: 100, firstRequestCachedInputTokens: 0,
        firstRequestCacheWriteTokens: 0, firstRequestCost: 0.001, firstRequestEndMs: 50,
        inputTokens: 130, cachedInputTokens: 270, cacheWriteTokens: 0, cost: 0.005, durationMs: 100,
        toolResultSizes: { read: { calls: 2, totalTextBytes: 600, maxTextBytes: 500 }, grep: { calls: 1, totalTextBytes: 20, maxTextBytes: 20 } } },
      { status: "completed", provider: "minimax", model: "MiniMax-M3", type: "explore",
        assistantRequests: 1, firstRequestInputTokens: 50, firstRequestCachedInputTokens: 50,
        firstRequestCacheWriteTokens: 0, firstRequestCost: 0.002, firstRequestEndMs: 150,
        inputTokens: 50, cachedInputTokens: 50, cacheWriteTokens: 0, cost: 0.002, durationMs: 300,
        toolResultSizes: { read: { calls: 1, totalTextBytes: 400, maxTextBytes: 400 } } },
      // Old/empty records have no first-request telemetry and must not silently become misses.
      { status: "completed", provider: "minimax", model: "MiniMax-M3", type: "explore",
        inputTokens: 500, cachedInputTokens: 500, cost: 0.1, durationMs: 1000 },
      { status: "completed", provider: "minimax", model: "MiniMax-M3", type: "explore", assistantRequests: 0,
        inputTokens: 0, cachedInputTokens: 0 },
      { status: "failed", provider: "minimax", model: "MiniMax-M3", type: "explore",
        assistantRequests: 1, firstRequestInputTokens: 500, firstRequestCachedInputTokens: 0 },
    ];
    writeFileSync(join(dir, "delegate", "telemetry.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const child = spawnSync(process.execPath, [report.pathname], { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: dir } });
    assert.equal(child.status, 0, child.stderr);
    const data = JSON.parse(child.stdout);
    assert.equal(data.cacheMeasurement.measuredCalls, 2);
    assert.equal(data.cacheMeasurement.legacyOrNoResponseCalls, 2);
    const first = data.cacheMeasurement.combined.firstRequest;
    assert.equal(first.inputTokens, 150);
    assert.equal(first.cachedInputTokens, 50);
    assert.equal(first.cacheShare, 0.25);
    assert.equal(first.averageEndMs, 100);
    assert.equal(first.totalCost, 0.003);
    const later = data.cacheMeasurement.combined.laterRequests;
    assert.equal(later.inputTokens, 30);
    assert.equal(later.cachedInputTokens, 270);
    assert.equal(later.cacheShare, 0.9);
    assert.equal(data.cacheMeasurement.combined.averageJobDurationMs, 200);
    assert.equal(data.cacheMeasurement.combined.averageJobCost, 0.0035);
    assert.equal(data.cacheMeasurement.byModelAndMode["minimax/MiniMax-M3:explore"].calls, 2);
    assert.equal(data.toolResultSizes.measuredCalls, 2);
    assert.equal(data.toolResultSizes.legacyCalls, 2);
    assert.deepEqual(data.toolResultSizes.byTool.read, { calls: 3, totalTextBytes: 1000, maxTextBytes: 500, averageTextBytes: 333 });
    assert.deepEqual(data.toolResultSizes.byTool.grep, { calls: 1, totalTextBytes: 20, maxTextBytes: 20, averageTextBytes: 20 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy-only reports do not invent first-request stats", () => {
  const dir = mkdtempSync(join(tmpdir(), "delegate-cache-legacy-"));
  try {
    mkdirSync(join(dir, "delegate"));
    writeFileSync(join(dir, "delegate", "telemetry.jsonl"), JSON.stringify({ status: "completed", inputTokens: 20, cachedInputTokens: 40 }) + "\n");
    const child = spawnSync(process.execPath, [report.pathname], { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: dir } });
    assert.equal(child.status, 0, child.stderr);
    const data = JSON.parse(child.stdout);
    assert.equal(data.cacheMeasurement.measuredCalls, 0);
    assert.equal(data.cacheMeasurement.combined, null);
    assert.equal(data.toolResultSizes.measuredCalls, 0);
    assert.deepEqual(data.toolResultSizes.byTool, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

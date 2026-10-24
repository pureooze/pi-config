import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

const SCRIPT = join(process.cwd(), "scripts/delegate-evaluate.mjs");

function runCli(args, env = {}) {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function record({
  pairId,
  variant,
  status = "settled",
  experiment = "exp-1",
  outer = {
    initialModel: { provider: "minimax", model: "MiniMax-M3" },
    usage: { input: 10, output: 20, cacheRead: 1, totalTokens: 30, cost: 0.001 },
    assistantTurns: 1,
  },
  cwd = "/tmp/proj",
  delegations = [],
  nestedUsage = { input: 0, output: 0, totalTokens: 0 },
  totalUsage = { totalTokens: 30, cost: 0.001 },
  durationMs = 1000,
}) {
  return {
    type: "operation",
    experiment,
    pairId,
    variant,
    status,
    classification: variant === "delegated" ? "subagent" : "direct",
    cwd,
    outer,
    delegations,
    nestedUsage,
    totalUsage,
    durationMs,
  };
}

function delegateDelegations() {
  return [{ toolName: "delegate", toolCallId: "d1", mode: "parallel", durationMs: 500, isError: false, results: [], usage: { totalTokens: 0 } }];
}

function tempFixture(records, { malformedLine = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "delegate-eval-test-"));
  const file = join(dir, "operations.jsonl");
  const lines = records.map((r) => JSON.stringify(r));
  if (malformedLine) lines.push("{not-json");
  writeFileSync(file, lines.join("\n") + "\n");
  return { dir, file };
}

test("matched pair: same initial model + cwd + delegate yields signed deltas and avoids Sol tokens", () => {
  const direct = record({
    pairId: "p1",
    variant: "direct",
    outer: { initialModel: { provider: "minimax", model: "MiniMax-M3" }, usage: { input: 100, output: 200, cacheRead: 50, totalTokens: 300, cost: 0.01 } },
    totalUsage: { totalTokens: 300, cost: 0.01 },
    durationMs: 5000,
  });
  const delegated = record({
    pairId: "p1",
    variant: "delegated",
    outer: { initialModel: { provider: "minimax", model: "MiniMax-M3" }, usage: { input: 40, output: 60, cacheRead: 10, totalTokens: 100, cost: 0.003 } },
    delegations: delegateDelegations(),
    nestedUsage: { input: 20, output: 30, totalTokens: 50 },
    totalUsage: { totalTokens: 150, cost: 0.005 },
    durationMs: 3000,
  });
  const { dir, file } = tempFixture([direct, delegated]);
  try {
    const out = JSON.parse(runCli(["--experiment", "exp-1", "--file", file]));
    assert.equal(out.experiment, "exp-1");
    assert.equal(out.pairs, 1);
    assert.equal(out.skippedPairs, 0);
    const detail = out.pairsDetail[0];
    assert.equal(detail.solTokensAvoided, 200);
    assert.equal(detail.workerTokensAdded, 50);
    assert.equal(detail.costSaved, 0.01 - 0.005);
    assert.equal(detail.durationSavedMs, 2000);
    assert.equal(out.averageSolTokensAvoided, 200);
    assert.equal(out.averageWorkerTokensAdded, 50);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("absent quality reports: every pair is unscored and note indicates descriptive deltas", () => {
  const make = (id) => [
    record({ pairId: id, variant: "direct", outer: { initialModel: { provider: "minimax", model: "MiniMax-M3" }, usage: { totalTokens: 100, cost: 0.001 } }, totalUsage: { totalTokens: 100, cost: 0.001 } }),
    record({ pairId: id, variant: "delegated", outer: { initialModel: { provider: "minimax", model: "MiniMax-M3" }, usage: { totalTokens: 40, cost: 0.0004 } }, delegations: delegateDelegations(), nestedUsage: { totalTokens: 20 }, totalUsage: { totalTokens: 60, cost: 0.0006 } }),
  ];
  const { dir, file } = tempFixture([...make("a"), ...make("b")]);
  try {
    const out = JSON.parse(runCli(["--experiment", "exp-1", "--file", file]));
    assert.equal(out.pairs, 2);
    assert.equal(out.qualityScoredPairs, 0);
    assert.equal(out.totalRedoCount, 0);
    assert.equal(out.totalSolCorrectionCount, 0);
    for (const p of out.pairsDetail) assert.equal(p.quality, "unscored");
    assert.match(out.note, /assess quality for every pair/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quality file with accepted + redo/correction counts surfaces regression and totals", () => {
  const direct = record({
    pairId: "p1",
    variant: "direct",
    outer: { initialModel: { provider: "minimax", model: "MiniMax-M3" }, usage: { totalTokens: 300, cost: 0.01 } },
    totalUsage: { totalTokens: 300, cost: 0.01 },
    durationMs: 5000,
  });
  const delegated = record({
    pairId: "p1",
    variant: "delegated",
    outer: { initialModel: { provider: "minimax", model: "MiniMax-M3" }, usage: { totalTokens: 100, cost: 0.003 } },
    delegations: delegateDelegations(),
    nestedUsage: { totalTokens: 50 },
    totalUsage: { totalTokens: 150, cost: 0.005 },
    durationMs: 3000,
  });
  const { dir, file } = tempFixture([direct, delegated]);
  const qualityFile = join(dir, "quality.json");
  writeFileSync(qualityFile, JSON.stringify({
    p1: {
      direct: { accepted: true },
      delegated: { accepted: false, redoCount: 2, solCorrectionCount: 3 },
    },
  }));
  try {
    const out = JSON.parse(runCli(["--experiment", "exp-1", "--file", file, "--quality", qualityFile]));
    assert.equal(out.qualityScoredPairs, 1);
    assert.equal(out.qualityRegressionPairs, 1);
    assert.equal(out.totalRedoCount, 2);
    assert.equal(out.totalSolCorrectionCount, 3);
    const q = out.pairsDetail[0].quality;
    assert.equal(q.directAccepted, true);
    assert.equal(q.delegatedAccepted, false);
    assert.equal(q.delegatedRedoCount, 2);
    assert.equal(q.solCorrectionCount, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skips unmatched, duplicate, mismatched model, mismatched cwd, delegated without delegate tool", () => {
  const rec = (overrides) => record({
    pairId: "px",
    outer: { initialModel: { provider: "minimax", model: "MiniMax-M3" }, usage: { totalTokens: 100, cost: 0.001 } },
    totalUsage: { totalTokens: 100, cost: 0.001 },
    ...overrides,
  });
  const records = [
    // unmatched: only direct
    rec({ pairId: "unmatched", variant: "direct" }),
    // duplicate direct: 2 directs + 1 delegated
    rec({ pairId: "dup", variant: "direct" }),
    rec({ pairId: "dup", variant: "direct" }),
    rec({ pairId: "dup", variant: "delegated", delegations: delegateDelegations(), nestedUsage: { totalTokens: 10 }, totalUsage: { totalTokens: 110, cost: 0.0011 } }),
    // mismatched model
    rec({ pairId: "model-mismatch", variant: "direct", outer: { initialModel: { provider: "minimax", model: "Other" }, usage: { totalTokens: 100, cost: 0.001 } } }),
    rec({ pairId: "model-mismatch", variant: "delegated", delegations: delegateDelegations(), nestedUsage: { totalTokens: 10 }, totalUsage: { totalTokens: 110, cost: 0.0011 } }),
    // mismatched cwd
    rec({ pairId: "cwd-mismatch", variant: "delegated", cwd: "/tmp/other", delegations: delegateDelegations(), nestedUsage: { totalTokens: 10 }, totalUsage: { totalTokens: 110, cost: 0.0011 } }),
    // delegated without delegate tool
    rec({ pairId: "no-delegate-tool", variant: "delegated", delegations: [{ toolName: "read", toolCallId: "r1" }], nestedUsage: { totalTokens: 10 }, totalUsage: { totalTokens: 110, cost: 0.0011 } }),
  ];
  const { dir, file } = tempFixture(records);
  try {
    const out = JSON.parse(runCli(["--experiment", "exp-1", "--file", file]));
    assert.equal(out.pairs, 0);
    assert.equal(out.skippedPairs, 5);
    assert.equal(out.pairsDetail.length, 0);
    assert.match(out.note, /No valid matched pairs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed JSONL lines are ignored, valid records still processed", () => {
  const direct = record({ pairId: "ok", variant: "direct", outer: { initialModel: { provider: "minimax", model: "MiniMax-M3" }, usage: { totalTokens: 50, cost: 0.001 } }, totalUsage: { totalTokens: 50, cost: 0.001 } });
  const delegated = record({ pairId: "ok", variant: "delegated", outer: { initialModel: { provider: "minimax", model: "MiniMax-M3" }, usage: { totalTokens: 20, cost: 0.0004 } }, delegations: delegateDelegations(), nestedUsage: { totalTokens: 5 }, totalUsage: { totalTokens: 25, cost: 0.0005 } });
  const { dir, file } = tempFixture([direct, delegated], { malformedLine: true });
  try {
    const out = JSON.parse(runCli(["--experiment", "exp-1", "--file", file]));
    assert.equal(out.pairs, 1);
    assert.equal(out.pairsDetail[0].pairId, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no matching experiment yields zero pairs and skip note", () => {
  const direct = record({ pairId: "p1", variant: "direct", experiment: "other-exp" });
  const { dir, file } = tempFixture([direct]);
  try {
    const out = JSON.parse(runCli(["--experiment", "exp-1", "--file", file]));
    assert.equal(out.pairs, 0);
    assert.equal(out.skippedPairs, 0);
    assert.equal(out.pairsDetail.length, 0);
    assert.match(out.note, /No valid matched pairs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

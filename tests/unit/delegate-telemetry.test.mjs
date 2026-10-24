import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { default: telemetryExtension } = await import("../../packages/telemetry/index.ts");

function harness() {
  const commands = new Map();
  const handlers = new Map();
  return {
    commands,
    handlers,
    api: {
      registerCommand(name, options) { commands.set(name, options); },
      on(event, handler) { handlers.set(event, handler); },
    },
  };
}

function makeCtx(overrides = {}) {
  return {
    cwd: overrides.cwd ?? process.cwd(),
    hasUI: false,
    isProjectTrusted: () => true,
    ui: { notify() {} },
    sessionManager: { getSessionId: () => overrides.sessionId ?? "sess-delegate-1" },
    ...(overrides.model !== undefined ? { model: overrides.model, thinkingLevel: overrides.thinkingLevel ?? "off" } : {}),
  };
}

test("delegate tool classifies operation as subagent and extracts nested usage from results", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "telemetry-delegate-test-"));
  const telemetryPath = join(tempDir, "operations.jsonl");
  const previousPath = process.env.PI_TELEMETRY_PATH;
  const previousExperiment = process.env.PI_TELEMETRY_EXPERIMENT;
  const previousVariant = process.env.PI_TELEMETRY_VARIANT;
  const previousPair = process.env.PI_TELEMETRY_PAIR;
  process.env.PI_TELEMETRY_PATH = telemetryPath;
  process.env.PI_TELEMETRY_PAIR = "matched-1";
  delete process.env.PI_TELEMETRY_EXPERIMENT;
  delete process.env.PI_TELEMETRY_VARIANT;

  try {
    const h = harness();
    telemetryExtension(h.api);
    assert.equal(h.commands.has("telemetry-status"), true);
    assert.equal(h.commands.has("telemetry-report"), true);
    assert.equal(h.handlers.has("before_agent_start"), true);
    assert.equal(h.handlers.has("tool_execution_start"), true);
    assert.equal(h.handlers.has("tool_execution_end"), true);
    assert.equal(h.handlers.has("agent_settled"), true);

    const ctx = makeCtx({
      model: { provider: "minimax", id: "MiniMax-M3" },
      thinkingLevel: "off",
    });

    await h.handlers.get("before_agent_start")({}, ctx);
    h.handlers.get("agent_start")({});

    const toolCallId = "delegate-call-1";
    await h.handlers.get("tool_execution_start")({ toolName: "delegate", toolCallId }, ctx);

    const delegateResult = {
      details: {
        mode: "parallel",
        results: [
          {
            agent: "researcher",
            agentSource: "worker",
            provider: "minimax",
            model: "MiniMax-M3",
            status: "ok",
            startedAt: "2025-01-01T00:00:00.000Z",
            endedAt: "2025-01-01T00:00:02.000Z",
            durationMs: 2000,
            stopReason: "stop",
            usage: {
              input: 100,
              output: 200,
              cacheRead: 10,
              cacheWrite: 5,
              reasoning: 7,
              totalTokens: 322,
              cost: 0.0042,
            },
          },
          {
            agent: "summarizer",
            provider: "minimax",
            model: "MiniMax-M3",
            usage: {
              input: 50,
              output: 25,
              totalTokens: 75,
            },
          },
          { agent: "", usage: { totalTokens: 999 } },
          "not-an-object",
        ],
      },
    };
    await h.handlers.get("tool_execution_end")(
      { toolName: "delegate", toolCallId, result: delegateResult, isError: false },
      ctx,
    );

    await h.handlers.get("turn_end")({
      turnIndex: 0,
      toolResults: [],
      message: {
        role: "assistant",
        provider: "minimax",
        model: "MiniMax-M3",
        responseModel: "MiniMax-M3",
        stopReason: "stop",
        usage: { input: 10, output: 20, totalTokens: 30, cost: { total: 0.001 } },
        content: [{ type: "text", text: "ok" }],
      },
    });

    await h.handlers.get("agent_settled")({}, ctx);

    const raw = readFileSync(telemetryPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    assert.equal(lines.length, 1, "exactly one operation record emitted");
    const record = JSON.parse(lines[0]);

    assert.equal(record.classification, "subagent", "delegate flags subagent classification");
    assert.equal(record.status, "settled");
    assert.equal(record.sessionId, "sess-delegate-1");
    assert.equal(record.pairId, "matched-1");

    assert.equal(record.delegations.length, 1);
    const delegation = record.delegations[0];
    assert.equal(delegation.toolName, "delegate");
    assert.equal(delegation.toolCallId, toolCallId);
    assert.equal(delegation.mode, "parallel");
    assert.equal(delegation.isError, false);
    assert.equal(typeof delegation.durationMs, "number");

    assert.equal(delegation.results.length, 2, "malformed child entries are dropped");
    const [a, b] = delegation.results;
    assert.equal(a.agent, "researcher");
    assert.equal(a.provider, "minimax");
    assert.equal(a.model, "MiniMax-M3");
    assert.equal(a.usage.input, 100);
    assert.equal(a.usage.output, 200);
    assert.equal(a.usage.totalTokens, 322);
    assert.equal(a.usage.cost, 0.0042);
    assert.equal(b.agent, "summarizer");
    assert.equal(b.usage.totalTokens, 75);

    assert.equal(delegation.usage.input, 150, "delegation usage sums child usage");
    assert.equal(delegation.usage.output, 225);
    assert.equal(delegation.usage.totalTokens, 397);
    assert.equal(Math.abs(delegation.usage.cost - 0.0042) < 1e-9, true);

    assert.equal(record.nestedUsage.input, 150);
    assert.equal(record.nestedUsage.totalTokens, 397);

    assert.equal(record.totalUsage.totalTokens, 30 + 397, "total = outer + nested");
    assert.equal(record.outer.usage.totalTokens, 30);
    assert.equal(record.outer.assistantTurns, 1);
  } finally {
    if (previousPath === undefined) delete process.env.PI_TELEMETRY_PATH;
    else process.env.PI_TELEMETRY_PATH = previousPath;
    if (previousExperiment === undefined) delete process.env.PI_TELEMETRY_EXPERIMENT;
    else process.env.PI_TELEMETRY_EXPERIMENT = previousExperiment;
    if (previousVariant === undefined) delete process.env.PI_TELEMETRY_VARIANT;
    else process.env.PI_TELEMETRY_VARIANT = previousVariant;
    if (previousPair === undefined) delete process.env.PI_TELEMETRY_PAIR;
    else process.env.PI_TELEMETRY_PAIR = previousPair;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("non-subagent operations classify as direct", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "telemetry-delegate-test-"));
  const telemetryPath = join(tempDir, "operations.jsonl");
  const previousPath = process.env.PI_TELEMETRY_PATH;
  process.env.PI_TELEMETRY_PATH = telemetryPath;

  try {
    const h = harness();
    telemetryExtension(h.api);
    const ctx = makeCtx({ sessionId: "sess-direct-1" });

    await h.handlers.get("before_agent_start")({}, ctx);
    await h.handlers.get("tool_execution_start")({ toolName: "read", toolCallId: "r1" }, ctx);
    await h.handlers.get("tool_execution_end")(
      { toolName: "read", toolCallId: "r1", result: { details: { results: [] } }, isError: false },
      ctx,
    );
    await h.handlers.get("agent_settled")({}, ctx);

    const raw = readFileSync(telemetryPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.classification, "direct");
    assert.equal(record.delegations.length, 0);
  } finally {
    if (previousPath === undefined) delete process.env.PI_TELEMETRY_PATH;
    else process.env.PI_TELEMETRY_PATH = previousPath;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

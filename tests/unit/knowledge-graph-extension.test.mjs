import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { default: installKnowledgeGraphExtension } = await import("../../extensions/knowledge-graph/index.ts");

function extensionHarness() {
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  return {
    tools,
    commands,
    handlers,
    api: {
      registerTool(tool) { tools.set(tool.name, tool); },
      registerCommand(name, options) { commands.set(name, options); },
      on(event, handler) { handlers.set(event, handler); },
    },
  };
}

test("knowledge graph exposes autonomous maintenance as its only agent mutation path", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "pi-knowledge-graph-extension-test-"));
  const previousStorageRoot = process.env.PI_KNOWLEDGE_GRAPH_DIR;
  process.env.PI_KNOWLEDGE_GRAPH_DIR = join(storageRoot, "store");
  try {
    const harness = extensionHarness();
    installKnowledgeGraphExtension(harness.api);
    assert.deepEqual([...harness.tools.keys()].sort(), ["knowledge_get", "knowledge_maintain", "knowledge_search"]);
    assert.deepEqual([...harness.commands.keys()].sort(), ["knowledge-export", "knowledge-forget", "knowledge-status"]);
    assert.equal(harness.handlers.has("session_start"), true);
    assert.equal(harness.handlers.has("session_shutdown"), true);
    assert.equal(harness.handlers.has("before_agent_start"), true);
    assert.equal(harness.handlers.has("before_tree"), false);
    const routedPrompt = await harness.handlers.get("before_agent_start")({
      prompt: "What is the dashboard authentication flow?",
      systemPrompt: "base system prompt",
      systemPromptOptions: { selectedTools: ["knowledge_search", "read", "grep"] },
    }, {});
    assert.match(routedPrompt.systemPrompt, /knowledge_search before using read, grep, find, bash/u);
    assert.match(routedPrompt.systemPrompt, /answer from its cited results without another knowledge-graph call/u);
    assert.match(routedPrompt.systemPrompt, /do not repeat it merely to confirm a complete search result/u);
    const blockedFileSearch = await harness.handlers.get("tool_call")({ toolName: "read", toolCallId: "read-first", input: { path: "README.md" } }, {});
    assert.equal(blockedFileSearch.block, true);
    const allowedKnowledgeSearch = await harness.handlers.get("tool_call")({ toolName: "knowledge_search", toolCallId: "knowledge-first", input: { query: "dashboard authentication flow" } }, {});
    assert.equal(allowedKnowledgeSearch, undefined);
    const blockedUntilResult = await harness.handlers.get("tool_call")({ toolName: "grep", toolCallId: "grep-parallel", input: { pattern: "auth" } }, {});
    assert.equal(blockedUntilResult.block, true);
    await harness.handlers.get("tool_result")({ toolName: "knowledge_search" }, {});
    const allowedFallback = await harness.handlers.get("tool_call")({ toolName: "read", toolCallId: "read-fallback", input: { path: "README.md" } }, {});
    assert.equal(allowedFallback, undefined);
    await harness.handlers.get("before_agent_start")({
      prompt: "Implement the dashboard authentication flow.",
      systemPrompt: "base system prompt",
      systemPromptOptions: { selectedTools: ["knowledge_search", "read", "grep"] },
    }, {});
    const allowedImplementationSearch = await harness.handlers.get("tool_call")({ toolName: "read", toolCallId: "read-implementation", input: { path: "README.md" } }, {});
    assert.equal(allowedImplementationSearch, undefined);

    const notifications = [];
    const context = {
      cwd: process.cwd(),
      hasUI: true,
      isProjectTrusted: () => false,
      ui: {
        notify(message) { notifications.push(message); },
        confirm: async () => true,
      },
      sessionManager: { getSessionId: () => "extension-session", getLeafId: () => "extension-leaf" },
    };
    await harness.handlers.get("session_start")({ type: "session_start", reason: "startup" }, context);
    const result = await harness.tools.get("knowledge_search").execute(
      "tool-call",
      { query: "unanswerable" },
      new AbortController().signal,
      undefined,
      context,
    );
    assert.equal(result.isError, undefined);
    const searchPayload = JSON.parse(result.content[0].text);
    assert.equal(searchPayload.insufficientEvidence, true);
    assert.deepEqual(searchPayload.visibility, ["global"]);

    const autonomousInsert = await harness.tools.get("knowledge_maintain").execute(
      "autonomous-insert-call",
      {
        operation: "insert",
        subject: { label: "Autonomous Extension Fact", type: "concept" },
        predicate: "has_note",
        object: { kind: "text", value: "accepted without review" },
        evidence: [{ sourceKind: "user_statement", excerpt: "The autonomous extension fact is durable." }],
      },
      new AbortController().signal,
      undefined,
      context,
    );
    const autonomousInsertPayload = JSON.parse(autonomousInsert.content[0].text);
    assert.equal(autonomousInsertPayload.status, "accepted");
    assert.equal(autonomousInsertPayload.scopeId, "global");

    const autonomousDelete = await harness.tools.get("knowledge_maintain").execute(
      "autonomous-delete-call",
      {
        operation: "delete",
        targetId: autonomousInsertPayload.claimIds[0],
        reason: "The autonomous extension fixture is no longer needed.",
      },
      new AbortController().signal,
      undefined,
      context,
    );
    assert.equal(JSON.parse(autonomousDelete.content[0].text).status, "deleted");

    const persistentInsert = await harness.tools.get("knowledge_maintain").execute(
      "persistent-insert-call",
      {
        operation: "insert",
        subject: { label: "Persistent Extension Fact", type: "concept" },
        predicate: "has_note",
        object: { kind: "text", value: "kept for forget command" },
        evidence: [{ sourceKind: "user_statement", excerpt: "The persistent extension fact is retained." }],
      },
      new AbortController().signal,
      undefined,
      context,
    );
    const persistentClaimId = JSON.parse(persistentInsert.content[0].text).claimIds[0];

    await harness.commands.get("knowledge-export").handler("extension-export.json all", context);
    assert.equal(existsSync(join(storageRoot, "store", "exports", "extension-export.json")), true);

    context.hasUI = false;
    await harness.commands.get("knowledge-forget").handler(persistentClaimId, context);
    assert.equal(notifications.some((message) => message.includes("no knowledge was deleted")), true);
    context.hasUI = true;
    context.ui.confirm = async () => false;
    await harness.commands.get("knowledge-forget").handler(persistentClaimId, context);
    assert.equal(notifications.some((message) => message.includes("deletion cancelled")), true);
    context.ui.confirm = async () => true;

    await harness.commands.get("knowledge-forget").handler(persistentClaimId, context);
    assert.equal(notifications.some((message) => message.includes("Knowledge deletion complete")), true);
    await harness.commands.get("knowledge-status").handler("", context);
    await harness.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, context);
  } finally {
    if (previousStorageRoot === undefined) delete process.env.PI_KNOWLEDGE_GRAPH_DIR;
    else process.env.PI_KNOWLEDGE_GRAPH_DIR = previousStorageRoot;
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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

test("knowledge graph extension registers read-only tools and lifecycle-safe status", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "pi-knowledge-graph-extension-test-"));
  const previousStorageRoot = process.env.PI_KNOWLEDGE_GRAPH_DIR;
  process.env.PI_KNOWLEDGE_GRAPH_DIR = join(storageRoot, "store");
  try {
    const harness = extensionHarness();
    installKnowledgeGraphExtension(harness.api);
    assert.deepEqual([...harness.tools.keys()].sort(), ["knowledge_get", "knowledge_propose", "knowledge_search"]);
    assert.equal(harness.commands.has("knowledge-status"), true);
    assert.equal(harness.handlers.has("session_start"), true);
    assert.equal(harness.handlers.has("session_shutdown"), true);

    const notifications = [];
    const reviewChoices = ["Edit", "Accept"];
    const context = {
      cwd: process.cwd(),
      hasUI: true,
      isProjectTrusted: () => false,
      ui: {
        notify(message) { notifications.push(message); },
        select: async () => reviewChoices.shift(),
        editor: async () => "The corrected extension fixture is pending review.",
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
    assert.equal(JSON.parse(result.content[0].text).insufficientEvidence, true);
    const proposal = await harness.tools.get("knowledge_propose").execute(
      "proposal-call",
      {
        subject: { label: "Extension Project", type: "project" },
        predicate: "has_note",
        object: { kind: "text", value: "read-only extension fixture" },
        evidence: [{ sourceKind: "user_statement", excerpt: "The extension fixture is pending review." }],
      },
      new AbortController().signal,
      undefined,
      context,
    );
    const proposalId = JSON.parse(proposal.content[0].text).proposalId;
    assert.equal(JSON.parse(proposal.content[0].text).status, "pending");
    await harness.commands.get("knowledge-review").handler(proposalId, context);
    await harness.commands.get("knowledge-review").handler(proposalId, context);
    assert.equal(notifications.some((message) => message.includes("untrusted") && message.includes("pending review")), true);
    assert.equal(notifications.some((message) => message.includes("Decision: accepted")), true);
    await harness.commands.get("knowledge-status").handler("", context);
    await harness.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, context);
  } finally {
    if (previousStorageRoot === undefined) delete process.env.PI_KNOWLEDGE_GRAPH_DIR;
    else process.env.PI_KNOWLEDGE_GRAPH_DIR = previousStorageRoot;
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

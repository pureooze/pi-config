import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { TaskMemoryStore } = await import("../../packages/delegate/task-memory.ts");
const { parentTaskId, extractCandidates, workerResources, lookupHadResults, outputBudget, DEFAULT_DELEGATE_MODEL, resolveDelegateModel, selectThinkingLevel, renderResult, finalizeWorkerOutput } = await import("../../packages/delegate/index.ts");
const delegateModule = await import("../../packages/delegate/index.ts");
const delegateExtension = delegateModule.default;

function newRoot() {
  return mkdtempSync(join(tmpdir(), "delegate-test-"));
}

function entry(id, role, parentId) {
  return {
    id,
    type: "message",
    parentId,
    message: { role, content: [{ type: "text", text: role === "user" ? `user ${id}` : "..." }] },
  };
}

function mockSession(sessionId, entries) {
  return {
    getSessionId: () => sessionId,
    getBranch: () => [...entries],
  };
}

test("delegate progress renderer: expanded in-progress view shows task and current worker activity", () => {
  const theme = { fg: (_color, text) => text };
  const result = renderResult({
    content: [{ type: "text", text: "Worker running (2 tools)" }],
    details: { status: "running", toolCalls: 2, toolErrors: 1, activeTool: "grep" },
  }, { expanded: true, isPartial: true }, theme, {
    args: { type: "explore", task: "Inspect the data flow", files: ["src/data.ts"], constraints: ["Do not edit"] },
  });
  const rendered = result.render(120).join("\n");
  assert.ok(rendered.includes("Inspect the data flow"));
  assert.ok(rendered.includes("src/data.ts"));
  assert.ok(rendered.includes("Worker tools: 2 (1 errors)"));
  assert.ok(rendered.includes("Current tool: grep"));
});

test("delegate progress renderer: collapsed view stays compact", () => {
  const theme = { fg: (_color, text) => text };
  const result = renderResult({
    content: [{ type: "text", text: "Worker running (2 tools)" }],
    details: { status: "running", toolCalls: 2 },
  }, { expanded: false, isPartial: true }, theme);
  assert.match(result.render(120).join(""), /running.*Worker running/);
});

test("delegate result renderer: expanded view shows final text and telemetry", () => {
  const theme = { fg: (_color, text) => text };
  const result = renderResult({
    content: [{ type: "text", text: "Worker completed the task." }],
    details: {
      status: "completed",
      durationMs: 2340,
      firstResponseMs: 410,
      assistantMessages: 3,
      toolCalls: 15,
      toolErrors: 1,
      lastAssistantStopReason: "stop",
      emptyFinalText: false,
      results: [{ usage: { input: 36182, output: 7364, cacheRead: 323955, totalTokens: 367501 } }],
    },
  }, { expanded: true }, theme);
  const rendered = result.render(120).join("\\n");
  assert.match(rendered, /Worker completed the task/);
  assert.match(rendered, /Delegate telemetry/);
  assert.match(rendered, /Duration: 2\.3s/);
  assert.match(rendered, /First response: 410ms/);
  assert.match(rendered, /Assistant messages: 3/);
  assert.match(rendered, /Worker tools: 15 \(1 errors\)/);
  assert.match(rendered, /36,182 input \/ 7,364 output/);
  assert.match(rendered, /323,955 cached/);
  assert.match(rendered, /Stop reason: stop/);
});

test("delegate result renderer: collapsed view includes compact telemetry", () => {
  const theme = { fg: (_color, text) => text };
  const result = renderResult({
    content: [{ type: "text", text: "A useful worker summary" }],
    details: {
      status: "failed",
      durationMs: 2340,
      toolCalls: 15,
      results: [{ usage: { input: 36182, output: 7364 } }],
    },
    isError: true,
  }, { expanded: false }, theme);
  const rendered = result.render(120).join("");
  assert.match(rendered, /failed.*2\.3s.*15 tools.*36\.2k in \/ 7\.4k out/);
  assert.match(rendered, /A useful worker summary/);
});

test("TaskMemoryStore: same-task re-instantiation shares notes", () => {
  const root = newRoot();
  try {
    const taskId = "parent-1";
    const a = new TaskMemoryStore(root, taskId);
    a.write({ key: "finding", category: "test", content: "hello", evidence: ["x"] });

    const b = new TaskMemoryStore(root, taskId);
    assert.equal(b.get("finding")?.content, "hello");
    assert.deepEqual(b.search("hello").map((e) => e.key), ["finding"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TaskMemoryStore: different task cannot read another task's notes", () => {
  const root = newRoot();
  try {
    const a = new TaskMemoryStore(root, "parent-1");
    a.write({ key: "secret", content: "private" });

    const b = new TaskMemoryStore(root, "parent-2");
    assert.equal(b.get("secret"), undefined);
    assert.deepEqual(b.search("private"), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TaskMemoryStore: write upserts existing keys in place", () => {
  const root = newRoot();
  try {
    const store = new TaskMemoryStore(root, "parent-1");
    store.write({ key: "k", content: "one" });
    const first = store.get("k");
    store.write({ key: "k", content: "two" });
    const second = store.get("k");
    assert.equal(second?.content, "two");
    assert.equal(first?.createdAt, second?.createdAt, "createdAt preserved across upsert");
    assert.ok(second.updatedAt >= first.updatedAt);
    assert.equal(store.search("two").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TaskMemoryStore: TTL expiration via mocked Date.now", () => {
  const root = newRoot();
  try {
    const taskId = "parent-ttl";
    const realNow = Date.now;
    try {
      Date.now = () => 1_000_000;
      const store = new TaskMemoryStore(root, taskId);
      store.write({ key: "k", content: "alive" });

      Date.now = () => 1_000_000 + 23 * 60 * 60 * 1000;
      const before = new TaskMemoryStore(root, taskId);
      assert.equal(before.get("k")?.content, "alive");

      Date.now = () => 1_000_000 + 25 * 60 * 60 * 1000;
      const after = new TaskMemoryStore(root, taskId);
      assert.equal(after.get("k"), undefined, "entry expired after TTL");

      const afterWrite = new TaskMemoryStore(root, taskId);
      afterWrite.write({ key: "k", content: "revived" });
      assert.equal(afterWrite.get("k")?.content, "revived");
    } finally {
      Date.now = realNow;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TaskMemoryStore: rejects oversized content", () => {
  const root = newRoot();
  try {
    const store = new TaskMemoryStore(root, "parent-1");
    const tooLong = "x".repeat(1201);
    assert.throws(() => store.write({ key: "k", content: tooLong }), /content must be a non-empty string up to 1200 characters/);

    const ok = "x".repeat(1200);
    store.write({ key: "k", content: ok });
    assert.equal(store.get("k")?.content.length, 1200);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TaskMemoryStore: hard cap of 64 entries", () => {
  const root = newRoot();
  try {
    const store = new TaskMemoryStore(root, "parent-1");
    for (let i = 0; i < 64; i++) store.write({ key: `k${i}`, content: `v${i}` });
    assert.equal(store.search("v").length, 5, "search caps to MAX_SEARCH_RESULTS");
    assert.throws(() => store.write({ key: "k64", content: "overflow" }), /memory store is full/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workerTools: names include search/get/memory but exclude knowledge_maintain and delegate", async () => {
  const root = newRoot();
  try {
    const memory = new TaskMemoryStore(root, "parent-1");
    const { workerTools } = await import("../../packages/delegate/worker-tools.ts");
    const tools = workerTools(memory, root, true).tools;
    const names = new Set(tools.map((t) => t.name));

    assert.equal(names.has("knowledge_search"), true);
    assert.equal(names.has("knowledge_get"), true);
    assert.equal(names.has("task_memory_search"), true);
    assert.equal(names.has("task_memory_get"), true);
    assert.equal(names.has("task_memory_write"), true);

    assert.equal(names.has("knowledge_maintain"), false, "no durable maintenance tool exposed");
    assert.equal(names.has("delegate"), false, "no nested delegation tool");
    assert.equal(names.has("delegate_extraction"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workerTools: task_memory_write then search/get round-trip via tool execute", async () => {
  const root = newRoot();
  try {
    const memory = new TaskMemoryStore(root, "parent-1");
    const { workerTools } = await import("../../packages/delegate/worker-tools.ts");
    const tools = workerTools(memory, root, true).tools;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    const writeResult = await byName.task_memory_write.execute("call-1", {
      key: "finding",
      category: "test",
      content: "needle in a haystack",
      evidence: ["docs/spec.md"],
    });
    const writePayload = JSON.parse(writeResult.content[0].text);
    assert.equal(writePayload.stored, true);
    assert.equal(writePayload.key, "finding");

    const searchResult = await byName.task_memory_search.execute("call-2", { query: "haystack" });
    const searchPayload = JSON.parse(searchResult.content[0].text);
    assert.deepEqual(searchPayload.map((e) => e.key), ["finding"]);

    const getResult = await byName.task_memory_get.execute("call-3", { key: "finding" });
    const getPayload = JSON.parse(getResult.content[0].text);
    assert.equal(getPayload?.content, "needle in a haystack");
    assert.equal(getPayload?.category, "test");

    const missing = await byName.task_memory_get.execute("call-4", { key: "absent" });
    assert.equal(JSON.parse(missing.content[0].text), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parentTaskId: same branch returns same id across calls and differs for new user message", () => {
  const sessionId = "session-xyz";
  const branch = [
    entry("u1", "user", null),
    { id: "a1", type: "message", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
    entry("u2", "user", "a1"),
    { id: "a2", type: "message", parentId: "u2", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
  ];
  const session = mockSession(sessionId, branch);

  const first = parentTaskId(session);
  const second = parentTaskId(session);
  assert.equal(first, second, "stable across calls for unchanged branch");
  assert.equal(first, `${sessionId}:u2`, "uses the latest user message id");

  const extended = [...branch, entry("u3", "user", "a2")];
  const session2 = mockSession(sessionId, extended);
  assert.notEqual(parentTaskId(session2), first, "changes after a new user message");
});

test("worker resource loader is empty except for its own small prompt", () => {
  const resources = workerResources(() => ({ marker: "empty-runtime" }));
  assert.deepEqual(resources.getAgentsFiles(), { agentsFiles: [] });
  assert.deepEqual(resources.getSkills(), { skills: [], diagnostics: [] });
  assert.deepEqual(resources.getAppendSystemPrompt(), []);
  assert.deepEqual(resources.getExtensions().extensions, []);
  assert.ok(resources.getSystemPrompt().length < 1500);
  assert.doesNotMatch(resources.getSystemPrompt(), /entire parent conversation/u);
});

test("SDK worker session registers only explicitly allowed tools and starts with empty history", async () => {
  const root = newRoot();
  try {
    const { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
    const { workerTools } = await import("../../packages/delegate/worker-tools.ts");
    const { repositoryToolOverrides } = await import("../../packages/delegate/worker-isolation.ts");
    const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null });
    const model = modelRuntime.getModel("minimax", "MiniMax-M3");
    assert.ok(model);
    const additional = workerTools(new TaskMemoryStore(root, "test"), root, false);
    const readOverride = repositoryToolOverrides(root, join(root, "agent")).find((tool) => tool.name === "read");
    assert.ok(readOverride);
    const { session } = await createAgentSession({
      cwd: root, modelRuntime, model,
      tools: ["read", ...additional.tools.map((tool) => tool.name)], customTools: [readOverride, ...additional.tools],
      resourceLoader: workerResources(createExtensionRuntime),
      sessionManager: SessionManager.inMemory(root),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    });
    try {
      assert.equal(session.messages.length, 0);
      assert.deepEqual(session.getActiveToolNames().sort(), ["read", ...additional.tools.map((t) => t.name)].sort());
      assert.equal(session.getToolDefinition("knowledge_maintain"), undefined);
      assert.equal(session.getToolDefinition("delegate"), undefined);
      assert.equal(session.getToolDefinition("bash"), undefined);
      assert.throws(() => session.getToolDefinition("read").execute("deny", { path: join(root, "..", "outside.txt") }), /outside the repository|protected storage/);
    } finally { session.dispose(); additional.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("candidate extraction returns at most three bounded suggestions without durable writes", () => {
  const line = "Knowledge candidate: Task memory has a 24h TTL | evidence: packages/delegate/task-memory.ts | reason: avoids stale notes | confidence: high";
  const parsed = extractCandidates(["Work completed: tests", line, line, line, line].join("\n"));
  assert.equal(parsed.knowledgeCandidates.length, 3);
  assert.equal(parsed.knowledgeCandidates[0].evidence[0], "packages/delegate/task-memory.ts");
  assert.equal(parsed.text.split("\n").length, 4);
});

test("parentTaskId: falls back to 'initial' when no user message exists", () => {
  const session = mockSession("s", [{ id: "a1", type: "message", parentId: null, message: { role: "assistant", content: [] } }]);
  assert.equal(parentTaskId(session), "s:initial");
});

test("TaskMemoryStore: migrates existing directory permissions from 0755 to 0700 and preserves note", () => {
  const root = newRoot();
  try {
    const taskId = "parent-perm-migrate";
    const seed = new TaskMemoryStore(root, taskId);
    seed.write({ key: "finding", category: "test", content: "preserved", evidence: ["docs/spec.md"] });

    chmodSync(root, 0o755);
    assert.equal(lstatSync(root).mode & 0o777, 0o755, "precondition: directory loosened to 0755");

    const reopened = new TaskMemoryStore(root, taskId);
    assert.equal((lstatSync(root).mode & 0o777), 0o700, "directory tightened back to 0700");

    const got = reopened.get("finding");
    assert.ok(got, "existing note remains readable after migration");
    assert.equal(got.content, "preserved");
    assert.equal(got.category, "test");
    assert.deepEqual(got.evidence, ["docs/spec.md"]);

    const searched = reopened.search("preserved").map((e) => e.key);
    assert.deepEqual(searched, ["finding"], "search index rebuilt against existing note");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TaskMemoryStore.complete: removes this task's persisted JSON and isolates other tasks", () => {
  const root = newRoot();
  try {
    const taskA = "parent-complete-a";
    const taskB = "parent-complete-b";

    const a = new TaskMemoryStore(root, taskA);
    a.write({ key: "finding", category: "test", content: "alpha", evidence: ["docs/spec.md"] });

    const other = new TaskMemoryStore(root, taskB);
    other.write({ key: "other", content: "beta" });

    // Precondition: both notes are reachable.
    assert.equal(a.get("finding")?.content, "alpha");
    assert.equal(other.get("other")?.content, "beta");

    a.complete();

    // A new instance for the completed task cannot retrieve the note.
    const reopenedA = new TaskMemoryStore(root, taskA);
    assert.equal(reopenedA.get("finding"), undefined);
    assert.deepEqual(reopenedA.search("alpha"), []);

    // The other task's note must remain intact.
    const reopenedOther = new TaskMemoryStore(root, taskB);
    assert.equal(reopenedOther.get("other")?.content, "beta");
    assert.deepEqual(reopenedOther.search("beta").map((e) => e.key), ["other"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TaskMemoryStore.complete: writing under the completed id starts fresh", () => {
  const root = newRoot();
  try {
    const taskId = "parent-complete-fresh";
    const first = new TaskMemoryStore(root, taskId);
    first.write({ key: "k", content: "original" });
    assert.equal(first.get("k")?.content, "original");

    first.complete();

    const second = new TaskMemoryStore(root, taskId);
    assert.equal(second.get("k"), undefined, "no leftover entry after complete()");

    second.write({ key: "k", content: "renewed" });
    const third = new TaskMemoryStore(root, taskId);
    assert.equal(third.get("k")?.content, "renewed", "subsequent write under completed id starts fresh");
    assert.equal(third.search("renewed").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TaskMemoryStore: expired note's persisted file is removed on load", () => {
  const root = newRoot();
  try {
    const taskId = "parent-expired-file";
    const realNow = Date.now;
    try {
      Date.now = () => 1_000_000;
      const seeded = new TaskMemoryStore(root, taskId);
      seeded.write({ key: "k", content: "alive" });

      // Locate the persisted file via fs listing inside the root.
      const beforeFiles = readdirSync(root);
      const beforeFile = beforeFiles.find((f) => f.endsWith(".task-memory.json"));
      assert.ok(beforeFile, "precondition: persisted file exists while fresh");

      // Advance past TTL so load() treats the store as expired and resets.
      Date.now = () => 1_000_000 + 25 * 60 * 60 * 1000;
      const reloaded = new TaskMemoryStore(root, taskId);
      assert.equal(reloaded.get("k"), undefined, "expired entry is no longer accessible");

      // The expired file must be gone from disk after the reset.
      const afterFiles = readdirSync(root);
      assert.equal(
        afterFiles.find((f) => f.endsWith(".task-memory.json")),
        undefined,
        "expired persisted file is removed on load",
      );
    } finally {
      Date.now = realNow;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TaskMemoryStore: rejects directory provided via symlink", () => {
  const parent = newRoot();
  const target = join(parent, "real-store");
  const link = join(parent, "store-link");
  try {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    symlinkSync(target, link);

    assert.throws(
      () => new TaskMemoryStore(link, "parent-symlink"),
      /symlink|directory|rootDirectory/i,
      "constructing TaskMemoryStore over a symlink must throw",
    );

    assert.equal((lstatSync(target).mode & 0o777), 0o700, "symlink target untouched on rejection");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

function lookupContent(text) {
  return { content: [{ type: "text", text }] };
}

test("lookupHadResults: task_memory_search miss/hit based on array length", () => {
  assert.equal(lookupHadResults("task_memory_search", lookupContent(JSON.stringify([]))), false, "empty array is a miss");
  assert.equal(lookupHadResults("task_memory_search", lookupContent(JSON.stringify([{ key: "k" }]))), true, "nonempty array is a hit");
  assert.equal(lookupHadResults("task_memory_search", lookupContent("not json")), false, "malformed JSON is a miss");
  assert.equal(lookupHadResults("task_memory_search", { content: [{ type: "text", text: "hi" }] }), false, "non-JSON text is a miss");
});

test("lookupHadResults: task_memory_get null miss vs object hit", () => {
  assert.equal(lookupHadResults("task_memory_get", lookupContent(JSON.stringify(null))), false, "null payload is a miss");
  assert.equal(lookupHadResults("task_memory_get", lookupContent(JSON.stringify({ key: "k", content: "x" }))), true, "object payload is a hit");
  assert.equal(lookupHadResults("task_memory_get", lookupContent("oops")), false, "malformed JSON is a miss");
});

test("lookupHadResults: knowledge_search empty results miss vs nonempty hit", () => {
  assert.equal(lookupHadResults("knowledge_search", lookupContent(JSON.stringify({ results: [] }))), false, "empty results array is a miss");
  assert.equal(lookupHadResults("knowledge_search", lookupContent(JSON.stringify({ results: [{ id: "r1" }] }))), true, "nonempty results array is a hit");
  assert.equal(lookupHadResults("knowledge_search", lookupContent(JSON.stringify({}))), false, "missing results key is a miss");
  assert.equal(lookupHadResults("knowledge_search", lookupContent("garbage")), false, "malformed JSON is a miss");
});

test("lookupHadResults: knowledge_get requires target field", () => {
  assert.equal(lookupHadResults("knowledge_get", lookupContent(JSON.stringify({ other: 1 }))), false, "missing target is a miss");
  assert.equal(lookupHadResults("knowledge_get", lookupContent(JSON.stringify({ target: { id: "t1" } }))), true, "object with target is a hit");
  assert.equal(lookupHadResults("knowledge_get", lookupContent(JSON.stringify(null))), false, "null is a miss");
});

test("lookupHadResults: malformed, error, and non-text results are misses", () => {
  assert.equal(lookupHadResults("knowledge_search", null), false, "null value is a miss");
  assert.equal(lookupHadResults("knowledge_search", undefined), false, "undefined value is a miss");
  assert.equal(lookupHadResults("knowledge_search", "plain string"), false, "primitive value is a miss");
  assert.equal(lookupHadResults("knowledge_search", { content: "not-array" }), false, "non-array content is a miss");
  assert.equal(lookupHadResults("knowledge_search", { content: [{ type: "image", data: "x" }] }), false, "non-text content type is a miss");
  assert.equal(lookupHadResults("knowledge_search", { content: [{ type: "text", text: 42 }] }), false, "non-string text is a miss");
  assert.equal(lookupHadResults("knowledge_search", { content: [{ type: "text" }] }), false, "missing text field is a miss");
  assert.equal(lookupHadResults("knowledge_search", { content: [] }), false, "empty content array is a miss");
  assert.equal(lookupHadResults("knowledge_search", lookupContent("{")), false, "thrown JSON parse is a miss");
  assert.equal(lookupHadResults("knowledge_search", lookupContent(JSON.stringify({ results: "not-array" }))), false, "non-array results is a miss");
});

test("delegate extension: registers /delegate-complete command and clears only current task", async () => {
  const tempAgentDir = mkdtempSync(join(tmpdir(), "delegate-ext-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tempAgentDir;
  try {
    const { SessionManager, getAgentDir } = await import("@earendil-works/pi-coding-agent");
    assert.equal(getAgentDir(), tempAgentDir, "PI_CODING_AGENT_DIR redirects the agent dir");

    const sessionId = "session-ext-cmd";
    const branch = [
      entry("u1", "user", null),
      { id: "a1", type: "message", parentId: "u1", message: { role: "assistant", content: [] } },
    ];
    const sessionManager = SessionManager.inMemory("/tmp");
    Object.defineProperty(sessionManager, "getSessionId", { value: () => sessionId, configurable: true });
    Object.defineProperty(sessionManager, "getBranch", { value: () => [...branch], configurable: true });

    const notifyCalls = [];
    const ui = {
      notify: (msg, level) => { notifyCalls.push({ msg, level }); },
      select: async () => null,
      confirm: async () => false,
      input: async () => "",
    };
    const commands = new Map();
    const tools = [];
    const pi = {
      registerCommand(name, options) { commands.set(name, options); },
      registerTool(tool) { tools.push(tool); },
    };
    delegateExtension(pi);
    assert.ok(commands.has("delegate-complete"), "delegate-complete command is registered");
    assert.equal(tools[0].executionMode, "sequential", "sibling calls cannot form an implicit swarm");

    // Derived parent id for the in-memory session.
    const derivedParentId = `${sessionId}:u1`;

    // Seed a note for the derived parent task and an unrelated task.
    const tasksRoot = join(tempAgentDir, "delegate", "tasks");
    const derivedStore = new TaskMemoryStore(tasksRoot, derivedParentId);
    derivedStore.write({ key: "finding", category: "test", content: "current-task-note", evidence: ["docs/spec.md"] });
    const unrelatedStore = new TaskMemoryStore(tasksRoot, "session-other:u9");
    unrelatedStore.write({ key: "other-finding", content: "unrelated-note" });

    // Sanity: both notes reachable before invoking the command.
    assert.equal(new TaskMemoryStore(tasksRoot, derivedParentId).get("finding")?.content, "current-task-note");
    assert.equal(new TaskMemoryStore(tasksRoot, "session-other:u9").get("other-finding")?.content, "unrelated-note");

    const ctx = {
      hasUI: true,
      ui,
      sessionManager,
      cwd: "/tmp",
      mode: "tui",
      modelRegistry: undefined,
      model: undefined,
      scopedModels: [],
      thinkingLevel: undefined,
      isIdle: () => true,
      isProjectTrusted: () => false,
      signal: undefined,
      abort: () => {},
      hasPendingMessages: () => false,
      shutdown: () => {},
      getContextUsage: () => undefined,
      compact: () => {},
      getSystemPrompt: () => "",
    };

    await commands.get("delegate-complete").handler("", ctx);

    // Only the current (derived) task's memory should be cleared.
    assert.equal(new TaskMemoryStore(tasksRoot, derivedParentId).get("finding"), undefined, "current task memory cleared");
    assert.equal(
      new TaskMemoryStore(tasksRoot, "session-other:u9").get("other-finding")?.content,
      "unrelated-note",
      "unrelated task memory is untouched",
    );
    assert.equal(notifyCalls.length, 1, "ui.notify called exactly once when hasUI is true");
    assert.equal(notifyCalls[0].level, "info");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tempAgentDir, { recursive: true, force: true });
  }
});

function captureBudgetEnv() {
  const keys = ["PI_DELEGATE_EXPLORE_OUTPUT_TOKENS", "PI_DELEGATE_TEST_OUTPUT_TOKENS", "PI_DELEGATE_FIX_OUTPUT_TOKENS", "PI_DELEGATE_IMPLEMENT_OUTPUT_TOKENS"];
  const snapshot = {};
  for (const key of keys) snapshot[key] = key in process.env ? process.env[key] : undefined;
  return snapshot;
}

function restoreBudgetEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("outputBudget: default budgets for explore/test/fix/implement when env is unset", () => {
  const snapshot = captureBudgetEnv();
  try {
    for (const key of Object.keys(snapshot)) delete process.env[key];
    assert.equal(outputBudget("explore"), 500);
    assert.equal(outputBudget("test"), 500);
    assert.equal(outputBudget("fix"), 600);
    assert.equal(outputBudget("implement"), 800);
  } finally {
    restoreBudgetEnv(snapshot);
  }
});

test("outputBudget: valid PI_DELEGATE_IMPLEMENT_OUTPUT_TOKENS env override is honored", () => {
  const snapshot = captureBudgetEnv();
  try {
    delete process.env.PI_DELEGATE_EXPLORE_OUTPUT_TOKENS;
    delete process.env.PI_DELEGATE_TEST_OUTPUT_TOKENS;
    delete process.env.PI_DELEGATE_FIX_OUTPUT_TOKENS;
    process.env.PI_DELEGATE_IMPLEMENT_OUTPUT_TOKENS = "1000";
    assert.equal(outputBudget("implement"), 1000, "1000 is a valid override and takes precedence over the default of 800");
  } finally {
    restoreBudgetEnv(snapshot);
  }
});

test("outputBudget: per-mode env overrides are honored", () => {
  const snapshot = captureBudgetEnv();
  try {
    process.env.PI_DELEGATE_EXPLORE_OUTPUT_TOKENS = "750";
    process.env.PI_DELEGATE_TEST_OUTPUT_TOKENS = "650";
    process.env.PI_DELEGATE_FIX_OUTPUT_TOKENS = "550";
    process.env.PI_DELEGATE_IMPLEMENT_OUTPUT_TOKENS = "1250";
    assert.equal(outputBudget("explore"), 750);
    assert.equal(outputBudget("test"), 650);
    assert.equal(outputBudget("fix"), 550);
    assert.equal(outputBudget("implement"), 1250);
  } finally {
    restoreBudgetEnv(snapshot);
  }
});

test("outputBudget: malformed or out-of-range env values fall back to defaults safely", () => {
  const snapshot = captureBudgetEnv();
  try {
    const cases = [
      ["abc", "non-numeric"],
      ["12", "below 100 minimum"],
      ["99", "still below 100"],
      ["2001", "above 2000 maximum"],
      ["2500", "above 2000 maximum"],
      ["", "empty string"],
      ["100.5", "non-integer"],
      ["0", "zero"],
      ["100 ", "trailing whitespace not matched by regex"],
      [" 100", "leading whitespace not matched by regex"],
      ["1000\n", "trailing newline not matched by regex"],
      ["10000000", "too many digits to match 3-4 digit regex"],
    ];
    for (const mode of ["explore", "test", "fix", "implement"]) {
      for (const [value, label] of cases) {
        process.env[`PI_DELEGATE_${mode.toUpperCase()}_OUTPUT_TOKENS`] = value;
        const expected = mode === "explore" ? 500 : mode === "test" ? 500 : mode === "fix" ? 600 : 800;
        assert.equal(outputBudget(mode), expected, `${mode} with env=${JSON.stringify(value)} (${label}) falls back to default ${expected}`);
      }
    }
  } finally {
    restoreBudgetEnv(snapshot);
  }
});

test("outputBudget: per-invocation requested argument overrides env and defaults", () => {
  const snapshot = captureBudgetEnv();
  try {
    process.env.PI_DELEGATE_IMPLEMENT_OUTPUT_TOKENS = "1000";
    assert.equal(outputBudget("implement", 1200), 1200, "explicit requested value overrides env");
    assert.equal(outputBudget("implement", 100), 100, "lower bound explicit value is honored");
    assert.equal(outputBudget("implement", 2000), 2000, "upper bound explicit value is honored");
    // Without an explicit requested value, env is still consulted.
    assert.equal(outputBudget("implement"), 1000);
    // Sanity: when neither requested nor env is set, default is returned.
    delete process.env.PI_DELEGATE_IMPLEMENT_OUTPUT_TOKENS;
    assert.equal(outputBudget("implement"), 800);
    assert.equal(outputBudget("implement", 1500), 1500);
  } finally {
    restoreBudgetEnv(snapshot);
  }
});

test("workerResources: system prompt escalates architecture, product, and visual decisions and does not mention parent transcript injection", () => {
  const resources = workerResources(() => ({ marker: "empty-runtime" }));
  const prompt = resources.getSystemPrompt();
  assert.ok(typeof prompt === "string" && prompt.length > 0, "system prompt must be a non-empty string");
  assert.ok(prompt.length < 1500, "system prompt stays under the documented size cap");

  // Must escalate architecture, product, and visual decisions.
  assert.match(prompt, /architecture/i, "system prompt must mention architecture decisions");
  assert.match(prompt, /product/i, "system prompt must mention product decisions");
  assert.match(prompt, /visual/i, "system prompt must mention visual decisions");
  // The prompt uses "report ambiguity to the primary agent" as its escalation directive.
  assert.match(prompt, /report ambiguity to the primary agent/u, "system prompt must direct the worker to escalate ambiguous decisions to the primary agent");

  // Must not mention parent transcript injection.
  assert.doesNotMatch(prompt, /parent\s+transcript/u, "system prompt must not reference a parent transcript");
  assert.doesNotMatch(prompt, /entire\s+parent\s+conversation/u, "system prompt must not promise to inject the parent conversation");
  assert.doesNotMatch(prompt, /inject(ing|ion)?\s+(the\s+)?parent/u, "system prompt must not describe injecting parent content");
  assert.doesNotMatch(prompt, /transcript/u, "system prompt must not mention a transcript at all");

  // Worker is isolated: no parent conversation, no extensions/skills/themes.
  assert.deepEqual(resources.getAgentsFiles(), { agentsFiles: [] });
  assert.deepEqual(resources.getSkills(), { skills: [], diagnostics: [] });
  assert.deepEqual(resources.getPrompts(), { prompts: [], diagnostics: [] });
  assert.deepEqual(resources.getThemes(), { themes: [], diagnostics: [] });
  assert.deepEqual(resources.getExtensions().extensions, []);
  assert.deepEqual(resources.getAppendSystemPrompt(), []);
  assert.equal(resources.getSystemPromptSource(), undefined);
  assert.deepEqual(resources.getAppendSystemPromptSources(), []);
});

test("DEFAULT_DELEGATE_MODEL: default worker model is the local Ollama Qwen subagent", () => {
  assert.equal(DEFAULT_DELEGATE_MODEL, "home-ollama/smtek/Qwen3.8-27B:Q3_K_M", "default must be the Fedora home-ollama Qwen model");
});

test("selectThinkingLevel: returns 'off' for the default Ollama Qwen subagent", () => {
  // The default worker is home-ollama/smtek/Qwen3.8-27B:Q3_K_M: no adaptive-thinking override, so "off".
  assert.equal(selectThinkingLevel("home-ollama", "smtek/Qwen3.8-27B:Q3_K_M"), "off", "default Qwen subagent keeps thinking off");
  // The legacy adaptive-thinking target still classifies as "low" when explicitly selected.
  assert.equal(selectThinkingLevel("minimax", "MiniMax-M3.1-Flash-Preview"), "low", "M3.1 Flash Preview override keeps adaptive low thinking");
  // Other provider/model combinations keep the previous behavior.
  assert.equal(selectThinkingLevel("minimax", "MiniMax-M3"), "off", "legacy M3 keeps thinking off");
  assert.equal(selectThinkingLevel("openrouter", "minimax/minimax-m3"), "off", "openrouter alias keeps thinking off");
  assert.equal(selectThinkingLevel("openai", "gpt-5"), "off", "unrelated provider keeps thinking off");
  assert.equal(selectThinkingLevel("", ""), "off", "empty inputs keep thinking off");
});

test("selectThinkingLevel: is exact-match — case and whitespace changes fall back to 'off'", () => {
  assert.equal(selectThinkingLevel("minimax", "MiniMax-M3.1-FLASH-PREVIEW"), "off", "case must match exactly");
  assert.equal(selectThinkingLevel("minimax", "MiniMax-M3.1-Flash-Preview "), "off", "trailing whitespace breaks the match");
  assert.equal(selectThinkingLevel("MiniMax", "MiniMax-M3.1-Flash-Preview"), "off", "provider case must match exactly");
});

test("selectThinkingLevel: only sends 'low' for that exact provider/model pair, never 'off'", () => {
  const level = selectThinkingLevel("minimax", "MiniMax-M3.1-Flash-Preview");
  assert.notEqual(level, "off", "adaptive-thinking target must never receive a disabled-thinking request");
  assert.equal(level, "low");
});

function captureModelEnv() {
  const keys = ["PI_DELEGATE_MODEL"];
  const snapshot = {};
  for (const key of keys) snapshot[key] = key in process.env ? process.env[key] : undefined;
  return snapshot;
}

function restoreModelEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("PI_DELEGATE_MODEL: when unset, the tool's resolved model name equals DEFAULT_DELEGATE_MODEL", () => {
  // The same constant the execute path uses to resolve the model name.
  const snapshot = captureModelEnv();
  try {
    delete process.env.PI_DELEGATE_MODEL;
    const resolved = resolveDelegateModel(undefined);
    assert.equal(resolved, DEFAULT_DELEGATE_MODEL, "unresolved default must equal DEFAULT_DELEGATE_MODEL");
    assert.equal(resolved, "home-ollama/smtek/Qwen3.8-27B:Q3_K_M");
  } finally {
    restoreModelEnv(snapshot);
  }
});

test("PI_DELEGATE_MODEL: an explicit override is not replaced by the new default", () => {
  const snapshot = captureModelEnv();
  try {
    process.env.PI_DELEGATE_MODEL = "openrouter/minimax/minimax-m3";
    const resolved = resolveDelegateModel(undefined);
    assert.equal(resolved, "openrouter/minimax/minimax-m3", "environment override must take precedence over DEFAULT_DELEGATE_MODEL");
    // And the helper still classifies the override as 'off' so legacy behavior is preserved.
    const [provider, ...rest] = resolved.split("/");
    assert.equal(selectThinkingLevel(provider, rest.join("/")), "off");
  } finally {
    restoreModelEnv(snapshot);
  }
});

test("delegate model override: invocation parameter takes precedence and keeps nested model ids", () => {
  assert.equal(
    resolveDelegateModel("openrouter/vendor/model-name", "minimax/MiniMax-M3"),
    "openrouter/vendor/model-name",
  );
});

test("delegate model override: rejects malformed values", () => {
  for (const value of ["", "provider", "/model", "provider/", "provider/model with spaces"]) {
    assert.throws(() => resolveDelegateModel(value, undefined), /provider\/model-id/u, `should reject ${JSON.stringify(value)}`);
  }
});

test("finalizeWorkerOutput: non-empty text is trimmed and status is preserved", () => {
  const d = { stopReason: "end_turn", assistantMessages: 1, toolCalls: 0, toolErrors: 0, filesChanged: ["src/a.ts"] };

  const r = finalizeWorkerOutput("  line one\nline two  ", "completed", d);
  assert.equal(r.output, "line one\nline two", "non-empty text is trimmed and preserved");
  assert.equal(r.status, "completed");
  assert.equal(r.emptyFinalText, false);

  const failed = finalizeWorkerOutput(" done ", "failed", d);
  assert.equal(failed.output, "done");
  assert.equal(failed.status, "failed");
  assert.equal(failed.emptyFinalText, false);

  const aborted = finalizeWorkerOutput(" stopped ", "aborted", d);
  assert.equal(aborted.output, "stopped");
  assert.equal(aborted.status, "aborted");
  assert.equal(aborted.emptyFinalText, false);
});

test("finalizeWorkerOutput: whitespace-only output yields a nonempty useful diagnostic", () => {
  const d = { stopReason: "length_limit", assistantMessages: 3, toolCalls: 7, toolErrors: 2, filesChanged: ["src/a.ts"] };
  const r = finalizeWorkerOutput("   \n\t  ", "aborted", d);
  assert.ok(r.output.trim().length > 0, "diagnostic must be non-empty");
  assert.equal(r.status, "aborted");
  assert.equal(r.emptyFinalText, true);
  assert.match(r.output, /stop\s*reason/i, "diagnostic mentions stopReason");
  assert.match(r.output, /length_limit/, "diagnostic includes the stopReason value");
  assert.match(r.output, /assistant/i, "diagnostic mentions assistant messages");
  assert.match(r.output, /tool/i, "diagnostic mentions tool activity");
  assert.match(r.output, /3/); // assistantMessages
  assert.match(r.output, /7/); // toolCalls
  assert.match(r.output, /2/); // toolErrors
  assert.ok(r.output.includes("src/a.ts"), "diagnostic lists the changed paths");
});

test("finalizeWorkerOutput: undefined output with no changed files reports none", () => {
  const d = { stopReason: "aborted", assistantMessages: 2, toolCalls: 4, toolErrors: 1, filesChanged: [] };
  const r = finalizeWorkerOutput(undefined, "aborted", d);
  assert.ok(r.output.trim().length > 0, "undefined output still produces a diagnostic");
  assert.equal(r.status, "aborted");
  assert.equal(r.emptyFinalText, true);
  assert.match(r.output, /stop\s*reason/i);
  assert.match(r.output, /aborted/);
  assert.match(r.output, /assistant/i);
  assert.match(r.output, /tool/i);
  assert.match(r.output, /\bnone\b|no files/i, "empty filesChanged reported as none");
});

test("finalizeWorkerOutput: empty output forces completed to failed but preserves aborted", () => {
  const d = { stopReason: "end_turn", assistantMessages: 1, toolCalls: 0, toolErrors: 0, filesChanged: [] };

  const forced = finalizeWorkerOutput("", "completed", d);
  assert.equal(forced.status, "failed", "empty output demotes completed to failed");
  assert.equal(forced.emptyFinalText, true);
  assert.ok(forced.output.trim().length > 0, "demoted result still carries a diagnostic");

  const abortedKept = finalizeWorkerOutput("", "aborted", d);
  assert.equal(abortedKept.status, "aborted", "aborted status is preserved on empty output");
  assert.equal(abortedKept.emptyFinalText, true);
  assert.ok(abortedKept.output.trim().length > 0);

  const undefinedEmpty = finalizeWorkerOutput(undefined, "completed", d);
  assert.equal(undefinedEmpty.status, "failed", "undefined output with completed also demotes to failed");
  assert.equal(undefinedEmpty.emptyFinalText, true);
  assert.ok(undefinedEmpty.output.trim().length > 0);
});
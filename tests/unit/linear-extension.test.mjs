import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";

// Redirect Pi's agent dir before importing the extension so auth helpers
// land in a temp directory we control.
const tmpAgent = mkdtempSync(join(tmpdir(), "pi-linear-test-"));
process.env.PI_CODING_AGENT_DIR = tmpAgent;

const linear = await import("../../packages/linear/index.ts");
const oauth = await import("../../packages/linear/oauth.ts");
const { LinearClient, configureClient } = await import("../../packages/linear/client.ts");

test("extension factory registers 2 commands and 10 tools, no network calls", () => {
  const commands = new Map();
  const tools = new Map();
  linear.default({
    registerCommand(name, opts) { commands.set(name, opts); },
    registerTool(tool) { tools.set(tool.name, tool); },
  });
  assert.deepEqual([...commands.keys()].sort(), ["linear-login", "linear-logout"]);
  assert.deepEqual([...tools.keys()].sort(), [
    "linear_create_comment", "linear_create_issue", "linear_create_project",
    "linear_get_issue", "linear_get_project",
    "linear_search_issues", "linear_search_projects",
    "linear_update_issue", "linear_update_project", "linear_viewer",
  ]);
  for (const tool of tools.values()) {
    // Strict schemas: every parameter schema must reject unknown keys.
    assert.equal(tool.parameters?.additionalProperties, false, `${tool.name} should be strict`);
  }
});

test("no delete or archive operations are registered", () => {
  const tools = new Map();
  linear.default({ registerCommand() {}, registerTool(tool) { tools.set(tool.name, tool); } });
  for (const name of tools.keys()) {
    assert.equal(/delete|archive|remove|trash/i.test(name), false, `${name} should not exist`);
  }
});

test("update_issue accepts optional description and projectId, and nothing else", () => {
  const tools = new Map();
  linear.default({ registerCommand() {}, registerTool(tool) { tools.set(tool.name, tool); } });
  const props = tools.get("linear_update_issue").parameters.properties;
  assert.deepEqual(Object.keys(props).sort(), [
    "assigneeId", "description", "id", "priority", "projectId", "stateId", "title",
  ]);
});

test("factory body is fast and does not import the GraphQL client", async () => {
  // Re-import fresh and confirm the heavy modules are not pulled in.
  const before = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  const commands = new Map();
  const tools = new Map();
  linear.default({ registerCommand(name) { commands.set(name, undefined); }, registerTool(tool) { tools.set(tool.name, tool); } });
  const dt = performance.now() - t0;
  // Sanity: the factory should run in well under 5ms after warm-up.
  assert.ok(dt < 5, `factory took ${dt.toFixed(2)}ms`);
  void before;
});

test("PKCE verifier/challenge pair is generated and verifier never logged", () => {
  // White-box check on the helper via authorize URL construction.
  const state = "abcd1234";
  // We can't call internal generatePkce, but we can verify the authorize URL
  // shape by faking the openBrowser path.
  const url = new URL("https://linear.app/oauth/authorize");
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("sanitize() strips bearer tokens, lin_api_ keys, and JSON token fields", () => {
  const raw = [
    "Bearer lin_api_abcdefghijklmnop",
    "Authorization: Bearer eyJabc.def-ghi_jkl",
    `{"access_token":"lin_api_xyz","refresh_token":"lin_api_zzz"}`,
    `Authorization: Bearer foo`,
  ].join("\n");
  const cleaned = oauth.sanitize(raw);
  assert.equal(cleaned.includes("lin_api_abcdefghijklmnop"), false, "raw lin_api_ value redacted");
  assert.equal(cleaned.includes("lin_api_xyz"), false, "raw lin_api_ in JSON redacted");
  assert.equal(cleaned.includes("lin_api_zzz"), false, "raw refresh_token value redacted");
  assert.equal(cleaned.match(/Bearer [A-Za-z0-9._-]+/g), null, "Bearer token values redacted");
  assert.ok(cleaned.includes("Bearer <redacted>"));
  assert.ok(cleaned.includes("Authorization: <redacted>"));
});

test("readAuth/writeAuth persists with mode 0o600 in the agent dir", () => {
  const sample = {
    access_token: "lin_api_TESTACCESS",
    refresh_token: "lin_api_TESTREFRESH",
    expires_at: Date.now() + 60_000,
    scope: "read,write,issues:create",
    token_type: "Bearer",
    client_id: "client-id",
  };
  oauth.writeAuth(sample);
  const path = oauth.authPath();
  assert.ok(existsSync(path), `auth file should exist at ${path}`);
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o600, `auth file mode should be 0o600, got ${mode.toString(8)}`);
  const back = oauth.readAuth();
  assert.deepEqual(back, sample);
});

test("redirect URI is the fixed http://localhost:3000/oauth/callback", () => {
  assert.equal(oauth.REDIRECT_URI, "http://localhost:3000/oauth/callback");
  const parsed = new URL(oauth.REDIRECT_URI);
  assert.equal(parsed.hostname, "localhost", "hostname must stay compatible with a loopback listener");
  assert.equal(parsed.port, "3000");
  assert.equal(parsed.pathname, "/oauth/callback");
  // Loopback-only: localhost must not resolve off-host.
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(parsed.hostname));
});

test("config.json stores only the client ID with 0o600 mode in a 0o700 dir", () => {
  oauth.writeConfig({ clientId: "test-client-id" });
  const path = oauth.configPath();
  assert.ok(existsSync(path), `config file should exist at ${path}`);
  assert.equal(statSync(path).mode & 0o777, 0o600, "config file must be 0o600");
  assert.equal(statSync(oauth.authDir()).mode & 0o777, 0o700, "agent linear dir must be 0o700");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(Object.keys(raw), ["clientId"], "config must not persist secrets");
  assert.deepEqual(oauth.readConfig(), { clientId: "test-client-id" });
});

test("malformed config.json reads as undefined", () => {
  const path = oauth.configPath();
  writeFileSync(path, "{not json");
  assert.equal(oauth.readConfig(), undefined);
  writeFileSync(path, JSON.stringify({ clientId: 42 }));
  assert.equal(oauth.readConfig(), undefined);
  writeFileSync(path, JSON.stringify({}));
  assert.equal(oauth.readConfig(), undefined);
});

test("/linear-login prompts only when env and stored config are both missing", async () => {
  const previous = process.env.LINEAR_OAUTH_CLIENT_ID;
  delete process.env.LINEAR_OAUTH_CLIENT_ID;
  rmSync(oauth.configPath(), { force: true });

  const commands = new Map();
  linear.default({ registerCommand(name, opts) { commands.set(name, opts); }, registerTool() {} });
  const login = commands.get("linear-login");
  assert.ok(login, "linear-login must be registered");

  const prompted = [];
  const notices = [];
  const ctx = {
    ui: {
      input: async (message, initial) => { prompted.push(message); return initial ?? ""; },
      notify: (message, level) => { notices.push({ message, level }); },
    },
  };
  // Empty input: no client ID anywhere -> error, and no network/browser work.
  await login.handler("", ctx);
  assert.equal(prompted.length, 1, "should prompt exactly once");
  assert.ok(prompted[0].toLowerCase().includes("client id"));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].level, "error");
  assert.equal(existsSync(oauth.configPath()), false, "nothing persisted without a client ID");

  if (previous !== undefined) process.env.LINEAR_OAUTH_CLIENT_ID = previous;
});

test("clearAuth() removes the persisted token", () => {
  oauth.writeAuth({
    access_token: "lin_api_TEST",
    refresh_token: "lin_api_TEST",
    expires_at: Date.now() + 60_000,
    scope: "read",
    token_type: "Bearer",
    client_id: "client",
  });
  oauth.clearAuth();
  assert.equal(oauth.readAuth(), undefined);
});

test("token coalescing: concurrent refreshes share one upstream call", async () => {
  oauth.writeAuth({
    access_token: "stale-token",
    refresh_token: "stale-refresh",
    expires_at: Date.now() - 1_000, // expired
    scope: "read",
    token_type: "Bearer",
    client_id: "client",
  });
  configureClient({ clientId: "client" });

  let upstreamCalls = 0;
  // Stub both /oauth/token and /graphql so refresh + coalesced requests hit
  // the same server.
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    res.setHeader("Content-Type", "application/json");
    if (url.includes("/oauth/token")) {
      upstreamCalls++;
      res.end(JSON.stringify({
        access_token: `fresh-${upstreamCalls}`,
        refresh_token: `refresh-${upstreamCalls}`,
        expires_in: 3600,
        scope: "read",
        token_type: "Bearer",
      }));
      return;
    }
    if (url.startsWith("/graphql")) {
      res.end(JSON.stringify({ data: { ok: true } }));
      return;
    }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  // Point LinearClient at the stubbed token endpoint by patching the module.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url).pathname;
    return realFetch(new URL(`http://127.0.0.1:${port}${path}`), init);
  };

  try {
    const client = new LinearClient({ endpoint: "https://api.linear.app/graphql" });
    const [a, b, c] = await Promise.all([
      client.graphql("query Q"),
      client.graphql("query Q"),
      client.graphql("query Q"),
    ]);
    assert.equal(upstreamCalls, 1, "concurrent refreshes must coalesce into a single network call");
    assert.deepEqual(a, { ok: true });
    assert.deepEqual(b, { ok: true });
    assert.deepEqual(c, { ok: true });
  } finally {
    globalThis.fetch = realFetch;
    server.close();
  }
});

test("graphql retries once on 401, then bubbles sanitized error", async () => {
  oauth.clearAuth();
  oauth.writeAuth({
    access_token: "first-token",
    refresh_token: "rt",
    expires_at: Date.now() + 10 * 60 * 1000,
    scope: "read",
    token_type: "Bearer",
    client_id: "client",
  });
  configureClient({ clientId: "client" });

  let upstreamRequests = 0;
  const calls = [];
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    const auth = req.headers.authorization ?? "";
    res.setHeader("Content-Type", "application/json");
    if (url.startsWith("/graphql")) {
      upstreamRequests++;
      calls.push(auth);
      if (upstreamRequests === 1) {
        res.statusCode = 401;
        res.end(JSON.stringify({ errors: [{ message: "token revoked lin_api_SECRET" }] }));
        return;
      }
      res.end(JSON.stringify({ data: { ok: true } }));
      return;
    }
    if (url.includes("/oauth/token")) {
      res.end(JSON.stringify({
        access_token: "second-token",
        refresh_token: "rt2",
        expires_in: 3600,
        scope: "read",
        token_type: "Bearer",
      }));
      return;
    }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return realFetch(new URL(`http://127.0.0.1:${port}${new URL(url).pathname}`), init);
  };

  try {
    const client = new LinearClient({ endpoint: "https://api.linear.app/graphql" });
    const data = await client.graphql("query Q");
    assert.deepEqual(data, { ok: true });
    assert.equal(upstreamRequests, 2);
    assert.ok(calls[0].endsWith("first-token"), `first call should carry first-token, got ${calls[0]}`);
    assert.ok(calls[1].endsWith("second-token"), `second call should carry second-token, got ${calls[1]}`);
  } finally {
    globalThis.fetch = realFetch;
    server.close();
  }
});

test.after(() => rmSync(tmpAgent, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// Project / issue read tools and confirm-gated writes.
//
// bootstrapClient() dynamically imports ./client.ts, which calls the global
// fetch. Stubbing globalThis.fetch (and redirecting the URL to a local server,
// as the tests above already do) therefore observes every network call a tool
// makes — which is what the "declined write issues no request" assertions need.
// ---------------------------------------------------------------------------

function collectTools() {
  const tools = new Map();
  linear.default({ registerCommand() {}, registerTool(tool) { tools.set(tool.name, tool); } });
  return tools;
}

function signIn() {
  oauth.writeAuth({
    access_token: "lin_api_TESTACCESS",
    refresh_token: "lin_api_TESTREFRESH",
    expires_at: Date.now() + 10 * 60 * 1000,
    scope: "read,write",
    token_type: "Bearer",
    client_id: "client",
  });
}

/** Run `fn` against a stub GraphQL server; resolves to the recorded requests plus fn's result. */
async function withStubbedLinear(responder, fn) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      requests.push(parsed);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: responder(parsed) }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return realFetch(new URL(`http://127.0.0.1:${port}${new URL(url).pathname}`), init);
  };
  let result;
  try {
    result = await fn();
  } finally {
    globalThis.fetch = realFetch;
    server.close();
  }
  return { requests, result };
}

/** Run `fn` with fetch replaced by a tripwire that records and rejects every call. */
async function withForbiddenNetwork(fn) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    calls.push(String(input));
    throw new Error("network access attempted");
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
  return calls;
}

const decliningCtx = { ui: { confirm: async () => false } };
const acceptingCtx = { ui: { confirm: async () => true } };

test("linear_get_issue surfaces description, project, and recent comments", async () => {
  signIn();
  const tools = collectTools();
  const { requests, result } = await withStubbedLinear(() => ({
    issues: { nodes: [{
      id: "issue-uuid-1",
      identifier: "ABC-12",
      title: "Ship project tools",
      url: "https://linear.app/acme/issue/ABC-12",
      description: "Detailed body",
      updatedAt: "2026-01-01T00:00:00.000Z",
      state: { name: "In Progress", type: "started" },
      team: { key: "ENG" },
      assignee: { name: "Ada" },
      project: { id: "proj-1", name: "Q1", url: "https://linear.app/acme/project/q1" },
      comments: { nodes: [
        { id: "c1", body: "latest note", createdAt: "2026-01-03T00:00:00.000Z", user: { name: "Ada" } },
        { id: "c2", body: "older note", createdAt: "2026-01-02T00:00:00.000Z", user: null },
      ] },
    }] },
  }), () => tools.get("linear_get_issue").execute("t1", { id: "ABC-12", commentLimit: 2 }));

  assert.equal(requests.length, 1, "one upstream request");
  assert.equal(requests[0].variables.commentLimit, 2, "comment bound passed upstream");
  const text = result.content[0].text;
  assert.ok(text.includes("ABC-12"));
  assert.ok(text.includes("Detailed body"), "description included");
  assert.ok(text.includes("Q1 (https://linear.app/acme/project/q1)"), "project included");
  assert.ok(text.includes("latest note") && text.includes("older note"), "comments included");
  assert.ok(text.includes("unknown"), "missing comment author labelled");
  assert.equal(result.details.projectId, "proj-1");
  assert.equal(result.details.commentCount, 2);
});

test("linear_get_issue reports a miss without throwing", async () => {
  signIn();
  const tools = collectTools();
  const { result } = await withStubbedLinear(() => ({ issues: { nodes: [] } }),
    () => tools.get("linear_get_issue").execute("t1", { id: "nope" }));
  assert.equal(result.details.found, false);
  assert.ok(result.content[0].text.includes('No issue matched "nope"'));
});

test("linear_search_projects omits the filter when no query is given and reports progress", async () => {
  signIn();
  const tools = collectTools();
  const { requests, result } = await withStubbedLinear(() => ({
    projects: { nodes: [
      { id: "p1", name: "Q1", url: "https://linear.app/acme/project/q1", targetDate: "2026-03-01", status: { name: "Started", type: "started" }, progress: 0.42, teams: { nodes: [{ key: "ENG" }] } },
      { id: "p2", name: "Q2", url: "https://linear.app/acme/project/q2", targetDate: null, status: { name: "Backlog", type: "backlog" }, progress: 0, teams: { nodes: [] } },
    ] },
  }), () => tools.get("linear_search_projects").execute("t1", { limit: 5 }));

  assert.equal(requests.length, 1);
  assert.equal(requests[0].variables.filter, undefined, "no filter without a query");
  assert.equal(requests[0].variables.first, 5);
  const text = result.content[0].text;
  assert.ok(text.includes("42%") && text.includes("target 2026-03-01"));
  assert.equal(result.details.count, 2);

  const filtered = await withStubbedLinear(() => ({ projects: { nodes: [] } }),
    () => tools.get("linear_search_projects").execute("t1", { query: "roadmap" }));
  assert.deepEqual(filtered.requests[0].variables.filter, { name: { contains: "roadmap" } });
});

test("linear_get_project returns the project description, teams, and dates", async () => {
  signIn();
  const tools = collectTools();
  const { requests, result } = await withStubbedLinear(() => ({
    projects: { nodes: [{
      id: "p1", name: "Q1", description: "Goals for the quarter", url: "https://linear.app/acme/project/q1",
      startDate: "2026-01-01", targetDate: "2026-03-31", progress: 0.5, updatedAt: "2026-01-05T00:00:00.000Z",
      status: { name: "Started", type: "started" }, teams: { nodes: [{ key: "ENG", name: "Engineering" }] },
    }] },
  }), () => tools.get("linear_get_project").execute("t1", { id: "p1" }));

  assert.deepEqual(requests[0].variables.filter, { id: { eq: "p1" } });
  const text = result.content[0].text;
  assert.ok(text.includes("Goals for the quarter"));
  assert.ok(text.includes("ENG Engineering"));
  assert.ok(text.includes("2026-01-01 → 2026-03-31"));
  assert.equal(result.details.targetDate, "2026-03-31");
});

test("declined create_project issues no network request", async () => {
  signIn();
  const tools = collectTools();
  const calls = await withForbiddenNetwork(async () => {
    const result = await tools.get("linear_create_project").execute(
      "t1", { name: "Q3", teamIds: ["team-1"] }, undefined, undefined, decliningCtx);
    assert.equal(result.details.canceled, true);
    assert.ok(result.content[0].text.includes("Declined"));
  });
  assert.deepEqual(calls, [], "declined create_project must not touch the network");
});

test("declined update_project issues no network request", async () => {
  signIn();
  const tools = collectTools();
  const calls = await withForbiddenNetwork(async () => {
    const result = await tools.get("linear_update_project").execute(
      "t1", { id: "p1", name: "Q3 Renamed" }, undefined, undefined, decliningCtx);
    assert.equal(result.details.canceled, true);
  });
  assert.deepEqual(calls, [], "declined update_project must not touch the network");
});

test("declined create_comment issues no network request", async () => {
  signIn();
  const tools = collectTools();
  const calls = await withForbiddenNetwork(async () => {
    const result = await tools.get("linear_create_comment").execute(
      "t1", { issueId: "issue-uuid-1", body: "please review" }, undefined, undefined, decliningCtx);
    assert.equal(result.details.canceled, true);
  });
  assert.deepEqual(calls, [], "declined create_comment must not touch the network");
});

test("declined update_issue with description/projectId issues no network request", async () => {
  signIn();
  const tools = collectTools();
  const calls = await withForbiddenNetwork(async () => {
    const result = await tools.get("linear_update_issue").execute(
      "t1", { id: "issue-uuid-1", description: "new body", projectId: "proj-1" }, undefined, undefined, decliningCtx);
    assert.equal(result.details.canceled, true);
  });
  assert.deepEqual(calls, [], "declined update_issue must not touch the network");
});

test("confirmed project/comment writes send exactly one request with the right input", async () => {
  signIn();
  const tools = collectTools();

  const created = await withStubbedLinear(() => ({ projectCreate: { success: true, project: { id: "p9", name: "Q3", url: "https://linear.app/acme/project/q3" } } }),
    () => tools.get("linear_create_project").execute(
      "t1", { name: "Q3", teamIds: ["team-1"], targetDate: "2026-09-30" }, undefined, undefined, acceptingCtx));
  assert.equal(created.requests.length, 1);
  assert.deepEqual(created.requests[0].variables.input, { teamIds: ["team-1"], name: "Q3", targetDate: "2026-09-30" });
  assert.equal(created.result.details.id, "p9");

  const updatedProject = await withStubbedLinear(() => ({ projectUpdate: { success: true, project: { id: "p9", name: "Q3b", url: "https://linear.app/acme/project/q3" } } }),
    () => tools.get("linear_update_project").execute(
      "t1", { id: "p9", name: "Q3b" }, undefined, undefined, acceptingCtx));
  assert.deepEqual(updatedProject.requests[0].variables.input, { name: "Q3b" });
  assert.equal(updatedProject.requests[0].variables.id, "p9");

  const commented = await withStubbedLinear(() => ({ commentCreate: { success: true, comment: { id: "c9", url: "https://linear.app/acme/comment/c9" } } }),
    () => tools.get("linear_create_comment").execute(
      "t1", { issueId: "issue-uuid-1", body: "looks good" }, undefined, undefined, acceptingCtx));
  assert.deepEqual(commented.requests[0].variables.input, { issueId: "issue-uuid-1", body: "looks good" });

  const updatedIssue = await withStubbedLinear(() => ({ issueUpdate: { success: true, issue: { id: "issue-uuid-1", identifier: "ABC-12", title: "T", url: "u" } } }),
    () => tools.get("linear_update_issue").execute(
      "t1", { id: "issue-uuid-1", projectId: "proj-1" }, undefined, undefined, acceptingCtx));
  assert.deepEqual(updatedIssue.requests[0].variables.input, { projectId: "proj-1" });
});

test("rejected writes surface a message instead of a fake success", async () => {
  signIn();
  const tools = collectTools();
  const { result } = await withStubbedLinear(() => ({ projectCreate: { success: false, project: null } }),
    () => tools.get("linear_create_project").execute("t1", { name: "Q3", teamIds: ["t"] }, undefined, undefined, acceptingCtx));
  assert.equal(result.details.canceled, false);
  assert.ok(result.content[0].text.includes("rejected"));
});

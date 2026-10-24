import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { assertRepositoryPath, macSandboxProfile, repositoryToolOverrides, isolatedBashOperations } =
  await import("../../packages/delegate/worker-isolation.ts");

function newRoot() {
  return mkdtempSync(join(tmpdir(), "delegate-iso-"));
}

function setupRepo() {
  const root = newRoot();
  const repo = join(root, "repo");
  const agent = join(root, "agent");
  mkdirSync(repo, { mode: 0o700 });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "inside.txt"), "inside");
  mkdirSync(agent, { mode: 0o700 });
  writeFileSync(join(agent, "secret.txt"), "agent-secret");
  return { root, repo, agent };
}

test("assertRepositoryPath: relative path inside repo is allowed", () => {
  const { root, repo } = setupRepo();
  try {
    assert.doesNotThrow(() => assertRepositoryPath(repo, "src/inside.txt"));
    assert.doesNotThrow(() => assertRepositoryPath(repo, "./src/inside.txt"));
    assert.doesNotThrow(() => assertRepositoryPath(repo, "src/../src/inside.txt"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("assertRepositoryPath: absolute path outside repo is denied", () => {
  const { root, repo, agent } = setupRepo();
  try {
    assert.throws(() => assertRepositoryPath(repo, agent), /outside the repository|protected storage/);
    assert.throws(() => assertRepositoryPath(repo, "/etc/passwd"), /outside the repository|protected storage/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("assertRepositoryPath: symlink from repo to outside is denied", () => {
  const { root, repo, agent } = setupRepo();
  const linkPath = join(repo, "escape");
  try {
    symlinkSync(join(agent, "secret.txt"), linkPath);
    assert.throws(() => assertRepositoryPath(repo, "escape"), /outside the repository|protected storage/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("assertRepositoryPath: broken symlink with target outside repo is denied via canonical resolution", () => {
  const { root, repo } = setupRepo();
  const brokenInside = join(repo, "broken-inside");
  try {
    symlinkSync(join(root, "does-not-exist"), brokenInside);
    assert.throws(() => assertRepositoryPath(repo, "broken-inside"), /ENOENT|no such file/i);
    // But an absolute broken path outside repo is denied.
    assert.throws(
      () => assertRepositoryPath(repo, join(root, "does-not-exist")),
      /outside the repository|protected storage/,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("assertRepositoryPath: protected paths inside repo are still denied", () => {
  const { root, repo, agent } = setupRepo();
  // Place the agent directory inside the repo to confirm protected overrides.
  const insideAgent = join(repo, "node_modules", ".agent");
  mkdirSync(insideAgent, { recursive: true });
  writeFileSync(join(insideAgent, "note.txt"), "x");
  try {
    // External protected path still denied
    assert.throws(() => assertRepositoryPath(repo, agent), /outside the repository|protected storage/);
    // Protected path even when physically inside the repo: absolute target escapes if protected dir is outside
    // Here we test with the agent dir outside; also assert a path that would be inside repo is denied because it's protected.
    const protectedInside = join(repo, "protected-area");
    mkdirSync(protectedInside);
    writeFileSync(join(protectedInside, "f.txt"), "p");
    assert.throws(
      () => assertRepositoryPath(repo, "protected-area/f.txt", [protectedInside]),
      /outside the repository|protected storage/,
      "paths inside a protected dir are denied even when inside repo",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("macSandboxProfile: canonicalizes paths (e.g. /tmp -> /private/tmp on macOS)", () => {
  const { root } = setupRepo();
  try {
    const profile = macSandboxProfile([tmpdir()]);
    // Find the canonicalized entry — must NOT contain the raw /tmp literal if it canonicalizes elsewhere.
    // We just assert that whatever path appears is resolvable (canonical) and matches a realpathSync result.
    const canonicalTmp = realpathSync(tmpdir());
    // profile contains a quoted path; assert it's the canonical one, not /tmp alias.
    assert.ok(profile.includes(JSON.stringify(canonicalTmp)), "profile uses canonical tmp path");
    if (canonicalTmp !== tmpdir()) {
      assert.ok(!profile.includes(JSON.stringify(tmpdir())), "non-canonical /tmp alias must not appear");
    }
    assert.ok(profile.startsWith("(version 1)\n(allow default)\n"), "header present");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("repositoryToolOverrides: read tool denies path outside repo", async () => {
  const { root, repo, agent } = setupRepo();
  const prev = process.env.PI_KNOWLEDGE_GRAPH_DIR;
  try {
    delete process.env.PI_KNOWLEDGE_GRAPH_DIR;
    const tools = repositoryToolOverrides(repo, agent);
    const read = tools.find((t) => t.name === "read");
    assert.ok(read, "read tool present");
    assert.throws(
      () => read.execute("id-1", { path: join(agent, "secret.txt") }),
      /outside the repository|protected storage/,
    );
  } finally {
    if (prev !== undefined) process.env.PI_KNOWLEDGE_GRAPH_DIR = prev; else delete process.env.PI_KNOWLEDGE_GRAPH_DIR;
    rmSync(root, { recursive: true, force: true });
  }
});

test("repositoryToolOverrides: write tool denies path outside repo", async () => {
  const { root, repo, agent } = setupRepo();
  const prev = process.env.PI_KNOWLEDGE_GRAPH_DIR;
  try {
    delete process.env.PI_KNOWLEDGE_GRAPH_DIR;
    const tools = repositoryToolOverrides(repo, agent);
    const write = tools.find((t) => t.name === "write");
    assert.ok(write, "write tool present");
    assert.throws(
      () => write.execute("id-2", { path: join(agent, "new.txt"), content: "x" }),
      /outside the repository|protected storage/,
    );
  } finally {
    if (prev !== undefined) process.env.PI_KNOWLEDGE_GRAPH_DIR = prev; else delete process.env.PI_KNOWLEDGE_GRAPH_DIR;
    rmSync(root, { recursive: true, force: true });
  }
});

test("repositoryToolOverrides: write and read work within repository", async () => {
  const { root, repo, agent } = setupRepo();
  try {
    const tools = repositoryToolOverrides(repo, agent);
    const write = tools.find((tool) => tool.name === "write");
    const read = tools.find((tool) => tool.name === "read");
    assert.ok(write && read);
    await write.execute("write-in-repo", { path: "src/new.txt", content: "allowed" });
    assert.equal(readFileSync(join(repo, "src", "new.txt"), "utf8"), "allowed");
    const result = await read.execute("read-in-repo", { path: "src/new.txt" });
    assert.match(result.content[0].text, /allowed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("repositoryToolOverrides: edit tool denies symlink escape", async () => {
  const { root, repo, agent } = setupRepo();
  const prev = process.env.PI_KNOWLEDGE_GRAPH_DIR;
  const linkPath = join(repo, "leak");
  try {
    delete process.env.PI_KNOWLEDGE_GRAPH_DIR;
    symlinkSync(join(agent, "secret.txt"), linkPath);
    const tools = repositoryToolOverrides(repo, agent);
    const edit = tools.find((t) => t.name === "edit");
    assert.ok(edit, "edit tool present");
    assert.throws(
      () => edit.execute("id-3", { path: "leak", oldText: "agent-secret", newText: "tampered" }),
      /outside the repository|protected storage/,
    );
  } finally {
    if (prev !== undefined) process.env.PI_KNOWLEDGE_GRAPH_DIR = prev; else delete process.env.PI_KNOWLEDGE_GRAPH_DIR;
    rmSync(root, { recursive: true, force: true });
  }
});

test("isolatedBashOperations: throws when sandbox-exec is unavailable", () => {
  // On non-darwin the function throws synchronously; on darwin it returns operations
  // and the sandbox check happens inside exec. We test the non-darwin path safely.
  if (process.platform !== "darwin") {
    const ops = isolatedBashOperations([]);
    assert.throws(
      () => ops.exec("echo hi", process.cwd(), { onData: () => {}, env: {} }),
      /sandbox-exec|unavailable/,
    );
  }
  // On darwin, the actual sandbox tests are in the next test; this branch is a no-op assertion.
});

// macOS cannot launch a second sandbox-exec from inside the worker's sandbox.
// Run these integration checks in the parent test suite, not nested worker tests.
const darwinBash = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") && !process.env.PI_DELEGATE_SANDBOXED ? test : test.skip;

darwinBash("isolatedBashOperations: real command on Darwin denies read of protected fixture and leaves it unchanged", async () => {
  const { root, repo, agent } = setupRepo();
  const protectedFixture = join(agent, "protected.txt");
  const original = "ORIGINAL-PROTECTED";
  writeFileSync(protectedFixture, original);
  try {
    const ops = isolatedBashOperations([agent]);
    const result = await ops.exec(`cat ${protectedFixture}`, repo, { onData: () => {}, env: {} });
    assert.notEqual(result.exitCode, 0, "reading a protected path must fail inside sandbox");
    assert.equal(readFileSync(protectedFixture, "utf8"), original, "protected fixture unchanged");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

darwinBash("isolatedBashOperations: real command on Darwin denies write to protected fixture and leaves it unchanged", async () => {
  const { root, repo, agent } = setupRepo();
  const protectedFixture = join(agent, "protected.txt");
  const original = "ORIGINAL-PROTECTED";
  writeFileSync(protectedFixture, original);
  try {
    const ops = isolatedBashOperations([agent]);
    const result = await ops.exec(
      `printf 'tampered' > ${protectedFixture}`,
      repo,
      { onData: () => {}, env: {} },
    );
    assert.notEqual(result.exitCode, 0, "writing a protected path must fail inside sandbox");
    assert.equal(readFileSync(protectedFixture, "utf8"), original, "protected fixture unchanged");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

darwinBash("isolatedBashOperations: normal repo command succeeds on Darwin", async () => {
  const { root, repo } = setupRepo();
  const out = join(repo, "hello.txt");
  try {
    const ops = isolatedBashOperations([]);
    const result = await ops.exec(`printf hi > ${out}`, repo, { onData: () => {}, env: {} });
    assert.equal(result.exitCode, 0, "non-protected write inside repo must succeed");
    assert.equal(readFileSync(out, "utf8"), "hi");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
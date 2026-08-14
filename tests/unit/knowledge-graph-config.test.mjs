import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const {
  assertPrivateDirectory,
  ensurePrivateFile,
  prepareStoragePaths,
  resolveKnowledgeGraphConfig,
  StoragePathError,
} = await import("../../packages/knowledge-graph/config.ts");

function createFixtureRoot() {
  return mkdtempSync(join(tmpdir(), "pi-knowledge-graph-config-test-"));
}

function writeJson(path, value, mode = 0o600) {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode });
  chmodSync(path, mode);
}

function configOptions(homeDirectory, projectRoot, projectTrusted, env = {}) {
  return {
    cwd: projectRoot,
    projectRoot,
    projectTrusted,
    env,
    homeDirectory,
  };
}

test("configuration precedence keeps storage security controls outside project config", () => {
  const root = createFixtureRoot();
  try {
    const homeDirectory = join(root, "home");
    const projectRoot = join(root, "atlas");
    const globalRoot = join(homeDirectory, ".pi", "agent", "knowledge-graph");
    mkdirSync(join(projectRoot, ".pi"), { recursive: true, mode: 0o700 });
    writeJson(join(globalRoot, "config.json"), {
      defaultSearchLimit: 12,
      showSourceLocators: true,
      storageRoot: "/synthetic-global-redirect-must-be-ignored",
    });
    writeJson(join(projectRoot, ".pi", "knowledge-graph.json"), {
      defaultSearchLimit: 4,
      showSourceLocators: false,
      includeGlobalByDefault: true,
    }, 0o644);

    const trusted = resolveKnowledgeGraphConfig(configOptions(
      homeDirectory,
      projectRoot,
      true,
      { PI_KNOWLEDGE_GRAPH_DEFAULT_SEARCH_LIMIT: "7" },
    ));
    assert.equal(trusted.rootDirectory, globalRoot);
    assert.equal(trusted.defaultSearchLimit, 7);
    assert.equal(trusted.showSourceLocators, false);
    assert.equal(trusted.projectConfigPath, join(projectRoot, ".pi", "knowledge-graph.json"));
    assert.ok(trusted.warnings.includes("global_config_unknown_field_ignored"));
    assert.ok(trusted.warnings.includes("project_config_unknown_field_ignored"));

    const untrusted = resolveKnowledgeGraphConfig(configOptions(homeDirectory, projectRoot, false));
    assert.equal(untrusted.defaultSearchLimit, 12);
    assert.equal(untrusted.showSourceLocators, true);
    assert.equal(untrusted.projectConfigPath, undefined);
    assert.equal(untrusted.warnings.includes("project_config_unknown_field_ignored"), false);

    const overrideRoot = join(root, "custom-store");
    const overridden = resolveKnowledgeGraphConfig(configOptions(
      homeDirectory,
      projectRoot,
      false,
      {
        PI_KNOWLEDGE_GRAPH_DIR: overrideRoot,
        PI_KNOWLEDGE_GRAPH_DEFAULT_SEARCH_LIMIT: "3",
        PI_KNOWLEDGE_GRAPH_SHOW_SOURCE_LOCATORS: "true",
      },
    ));
    assert.equal(overridden.rootDirectory, overrideRoot);
    assert.equal(overridden.defaultSearchLimit, 3);
    assert.equal(overridden.showSourceLocators, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid external values fall back safely or fail closed for storage roots", () => {
  const malformedRoot = createFixtureRoot();
  try {
    const homeDirectory = join(malformedRoot, "home");
    const projectRoot = join(malformedRoot, "project");
    const configPath = join(homeDirectory, ".pi", "agent", "knowledge-graph", "config.json");
    mkdirSync(join(configPath, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(configPath, "not json\n", { encoding: "utf8", mode: 0o600 });
    chmodSync(configPath, 0o600);

    const malformed = resolveKnowledgeGraphConfig(configOptions(homeDirectory, projectRoot, false));
    assert.equal(malformed.defaultSearchLimit, 8);
    assert.ok(malformed.warnings.includes("global_config_invalid_json"));

    const invalidEnvironment = resolveKnowledgeGraphConfig(configOptions(
      homeDirectory,
      projectRoot,
      false,
      { PI_KNOWLEDGE_GRAPH_DEFAULT_SEARCH_LIMIT: "999" },
    ));
    assert.equal(invalidEnvironment.defaultSearchLimit, 8);
    assert.ok(invalidEnvironment.warnings.includes("PI_KNOWLEDGE_GRAPH_DEFAULT_SEARCH_LIMIT_invalid"));

    assert.throws(
      () => resolveKnowledgeGraphConfig(configOptions(
        homeDirectory,
        projectRoot,
        false,
        { PI_KNOWLEDGE_GRAPH_DIR: "relative-store" },
      )),
      (error) => error?.code === "invalid_storage_root",
    );
  } finally {
    rmSync(malformedRoot, { recursive: true, force: true });
  }
});

test("storage directories and database/backup/export files are private", () => {
  const root = createFixtureRoot();
  try {
    const homeDirectory = join(root, "home");
    const projectRoot = join(root, "project");
    const storageRoot = join(root, "store");
    const config = resolveKnowledgeGraphConfig(configOptions(
      homeDirectory,
      projectRoot,
      false,
      { PI_KNOWLEDGE_GRAPH_DIR: storageRoot },
    ));

    prepareStoragePaths(config);
    assert.equal(statSync(config.rootDirectory).mode & 0o777, 0o700);
    assert.equal(statSync(config.backupDirectory).mode & 0o777, 0o700);
    assert.equal(statSync(config.exportDirectory).mode & 0o777, 0o700);
    assert.equal(statSync(config.databasePath).mode & 0o777, 0o600);

    const backupPath = join(config.backupDirectory, "fixture.sqlite");
    const exportPath = join(config.exportDirectory, "fixture.json");
    ensurePrivateFile(backupPath);
    ensurePrivateFile(exportPath);
    assert.equal(statSync(backupPath).mode & 0o777, 0o600);
    assert.equal(statSync(exportPath).mode & 0o777, 0o600);

    chmodSync(config.backupDirectory, 0o755);
    assert.throws(
      () => assertPrivateDirectory(config.backupDirectory),
      (error) => error instanceof StoragePathError && error.code === "insecure_permissions",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("storage root symlinks are rejected", () => {
  const root = createFixtureRoot();
  try {
    const realRoot = join(root, "real-store");
    const symlinkRoot = join(root, "linked-store");
    mkdirSync(realRoot, { recursive: true, mode: 0o700 });
    symlinkSync(realRoot, symlinkRoot, "dir");
    const config = resolveKnowledgeGraphConfig(configOptions(
      join(root, "home"),
      join(root, "project"),
      false,
      { PI_KNOWLEDGE_GRAPH_DIR: symlinkRoot },
    ));

    assert.throws(
      () => prepareStoragePaths(config),
      (error) => error instanceof StoragePathError && error.code === "symlink_not_allowed",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

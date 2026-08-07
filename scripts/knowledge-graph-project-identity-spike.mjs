import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "pi-kg-identity-spike-"));
const main = join(root, "main");
const worktree = join(root, "worktree");
const mainLink = join(root, "main-link");
const plain = join(root, "plain");
mkdirSync(join(main, "src"), { recursive: true });
mkdirSync(plain);

const runGit = (cwd, args) => {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
};

const runRequiredGit = (cwd, args) => {
  const result = runGit(cwd, args);
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
};

const inspect = (cwd) => {
  const canonicalCwd = realpathSync(cwd);
  const inside = runGit(canonicalCwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || inside.stdout !== "true") {
    return { cwd: canonicalCwd, git: false };
  }
  const rootOutput = runRequiredGit(canonicalCwd, ["rev-parse", "--show-toplevel"]);
  const commonOutput = runRequiredGit(canonicalCwd, ["rev-parse", "--git-common-dir"]);
  const commonPath = resolve(canonicalCwd, commonOutput);
  return {
    cwd: canonicalCwd,
    git: true,
    projectRoot: realpathSync(rootOutput),
    commonDir: realpathSync(commonPath),
  };
};

try {
  assert.equal(runGit(main, ["init", "-q"]).status, 0);
  assert.equal(
    runGit(main, [
      "-c", "user.name=KG Test",
      "-c", "user.email=kg-test@example.invalid",
      "commit", "--allow-empty", "-m", "init", "-q",
    ]).status,
    0,
  );
  assert.equal(runGit(main, ["worktree", "add", "-q", worktree, "-b", "kg-test-worktree"]).status, 0);
  symlinkSync(main, mainLink, "dir");
  writeFileSync(join(main, "src", "marker.txt"), "temporary fixture\n");

  const mainResult = inspect(join(main, "src"));
  const symlinkResult = inspect(join(mainLink, "src"));
  const worktreeResult = inspect(worktree);
  const plainResult = inspect(plain);

  assert.equal(mainResult.git, true);
  assert.equal(symlinkResult.git, true);
  assert.equal(worktreeResult.git, true);
  assert.equal(plainResult.git, false);
  assert.equal(symlinkResult.projectRoot, mainResult.projectRoot);
  assert.equal(symlinkResult.commonDir, mainResult.commonDir);
  assert.equal(worktreeResult.commonDir, mainResult.commonDir);

  console.log(JSON.stringify({
    status: "pass",
    results: {
      repositorySubdirectory: mainResult,
      symlinkedRepository: symlinkResult,
      linkedWorktree: worktreeResult,
      nonGitDirectory: plainResult,
    },
  }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}

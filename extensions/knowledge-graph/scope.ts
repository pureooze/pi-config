import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export interface KnowledgeScopeResolution {
  /** The knowledge graph is shared; these fields only describe the config context. */
  readonly scopeId: "global";
  readonly kind: "global";
  readonly projectRoot: string;
  readonly identityPath: string;
  readonly source: "git-common-dir" | "directory";
}

export class KnowledgeGraphScopeError extends Error {
  readonly code = "scope_unavailable" as const;

  constructor(message: string) {
    super(message);
    this.name = "KnowledgeGraphScopeError";
  }
}

export function resolveKnowledgeScope(cwd: string): KnowledgeScopeResolution {
  const canonicalCwd = canonicalPath(cwd);
  try {
    const projectRoot = canonicalPath(runGit(canonicalCwd, ["rev-parse", "--show-toplevel"]));
    const commonDirectoryOutput = runGit(canonicalCwd, ["rev-parse", "--git-common-dir"]);
    const identityPath = canonicalPath(isAbsolute(commonDirectoryOutput)
      ? commonDirectoryOutput
      : join(canonicalCwd, commonDirectoryOutput));
    return {
      scopeId: "global",
      kind: "global",
      projectRoot,
      identityPath,
      source: "git-common-dir",
    };
  } catch {
    return {
      scopeId: "global",
      kind: "global",
      projectRoot: canonicalCwd,
      identityPath: canonicalCwd,
      source: "directory",
    };
  }
}

function runGit(cwd: string, args: readonly string[]): string {
  try {
    const output = execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
      windowsHide: true,
    });
    const trimmed = output.trim();
    if (trimmed.length === 0) throw new Error("git returned no output");
    return trimmed;
  } catch {
    throw new KnowledgeGraphScopeError("Git project identity could not be resolved.");
  }
}

function canonicalPath(value: string): string {
  try {
    return realpathSync(resolve(value));
  } catch {
    throw new KnowledgeGraphScopeError("Current project path could not be canonicalized.");
  }
}

import { spawn } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  createBashToolDefinition, createEditToolDefinition, createFindToolDefinition,
  createGrepToolDefinition, createReadToolDefinition, createWriteToolDefinition, defineTool,
  type BashOperations, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

function canonical(path: string): string {
  const absolute = resolve(path);
  let found = false;
  try { lstatSync(absolute); found = true; }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (found) return realpathSync(absolute); // Broken symlinks fail closed.
  const parent = dirname(absolute);
  if (parent === absolute) throw new Error("Cannot resolve path");
  return join(canonical(parent), absolute.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
}

function inside(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

export function assertRepositoryPath(cwd: string, path: string, protectedPaths: readonly string[] = []): void {
  const root = canonical(cwd);
  const target = canonical(resolve(cwd, path));
  if (!inside(root, target) || protectedPaths.some((protectedPath) => inside(canonical(protectedPath), target))) {
    throw new Error("Worker file tools cannot access paths outside the repository or inside protected storage");
  }
}

// Mac sandbox profiles operate on canonical filesystem paths; /tmp, /var etc.
// are often symlinks. Never interpolate a non-canonical path into the profile.
export function macSandboxProfile(paths: readonly string[]): string {
  const quoted = (path: string) => JSON.stringify(canonical(path));
  return [`(version 1)`, `(allow default)`, ...paths.flatMap((path) => [
    `(deny file-read* (subpath ${quoted(path)}))`,
    `(deny file-write* (subpath ${quoted(path)}))`,
  ])].join("\n");
}

export function isolatedBashOperations(protectedPaths: readonly string[]): BashOperations {
  return {
    exec(command, cwd, { onData, signal, timeout, env }) {
      if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) {
        throw new Error("Worker bash requires an OS sandbox (macOS sandbox-exec); unavailable on this platform");
      }
      const profile = macSandboxProfile(protectedPaths);
      return new Promise((resolveResult, reject) => {
        if (signal?.aborted) { reject(new Error("Worker command aborted")); return; }
        const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, "/bin/bash", "-c", command], {
          cwd, env: { ...process.env, ...env, PI_DELEGATE_SANDBOXED: "1" },
          detached: true, stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        let timedOut = false;
        const kill = () => {
          if (child.pid) {
            try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
          }
        };
        const abort = () => kill();
        signal?.addEventListener("abort", abort, { once: true });
        const timer = timeout && timeout > 0 ? setTimeout(() => { timedOut = true; kill(); }, timeout * 1000) : undefined;
        const cleanup = () => { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", abort); };
        child.once("error", (error) => { cleanup(); reject(error); });
        child.once("close", (code) => {
          cleanup();
          if (signal?.aborted) reject(new Error("Worker command aborted"));
          else if (timedOut) reject(new Error("Worker command timed out"));
          else resolveResult({ exitCode: code });
        });
      });
    },
  };
}

// SDK custom definitions override native tools of the same name. This is a
// defense against tool-path access outside cwd, including symlink escapes.
export function repositoryToolOverrides(cwd: string, agentDir: string): ToolDefinition[] {
  const protectedPaths = [agentDir, process.env.PI_KNOWLEDGE_GRAPH_DIR].filter((p): p is string => Boolean(p));
  const check = (path: string) => assertRepositoryPath(cwd, path, protectedPaths);
  const read = createReadToolDefinition(cwd);
  const find = createFindToolDefinition(cwd);
  const grep = createGrepToolDefinition(cwd);
  const edit = createEditToolDefinition(cwd);
  const write = createWriteToolDefinition(cwd);
  const bash = createBashToolDefinition(cwd, { operations: isolatedBashOperations(protectedPaths) });
  return [
    defineTool({ ...read, execute(id, args, signal, onUpdate, ctx) { check(args.path); return read.execute(id, args, signal, onUpdate, ctx); } }),
    defineTool({ ...find, execute(id, args, signal, onUpdate, ctx) { check(args.path ?? "."); return find.execute(id, args, signal, onUpdate, ctx); } }),
    defineTool({ ...grep, execute(id, args, signal, onUpdate, ctx) { check(args.path ?? "."); return grep.execute(id, args, signal, onUpdate, ctx); } }),
    defineTool({ ...edit, execute(id, args, signal, onUpdate, ctx) { check(args.path); return edit.execute(id, args, signal, onUpdate, ctx); } }),
    defineTool({ ...write, execute(id, args, signal, onUpdate, ctx) { check(args.path); return write.execute(id, args, signal, onUpdate, ctx); } }),
    defineTool(bash),
  ];
}

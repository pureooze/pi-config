import delegateExtension from "../packages/delegate/index.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";

let delegate;
delegateExtension({ registerTool(tool) { delegate = tool; }, registerCommand() {} });
const sessionManager = SessionManager.inMemory(process.cwd());
const context = { cwd: process.cwd(), sessionManager, isProjectTrusted: () => true };
const [mode = "explore", ...words] = process.argv.slice(2);
const tasks = mode === "--chain" ? [
  "Read packages/delegate/task-memory.ts; store ONE real short finding under key smoke-task-memory with evidence pointing to that file via task_memory_write. Report the key only.",
  "Retrieve key smoke-task-memory via task_memory_get; verify the finding against packages/delegate/task-memory.ts, then run npm run typecheck using bash. Report the finding and validation in under 120 words.",
] : [words.join(" ") || "Explore the repository package layout and report which test command to use. Read package.json. Do not modify files."];
for (const task of tasks) {
  const result = await delegate.execute("smoke", { task, type: mode === "--chain" ? "test" : mode }, new AbortController().signal, undefined, context);
  console.log(result.content[0]?.text);
  console.log(JSON.stringify(result.details));
  if (result.isError) { process.exitCode = 1; break; }
}

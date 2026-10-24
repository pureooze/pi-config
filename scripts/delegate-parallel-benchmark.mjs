// Independent read-only requests: compare two sequential versus two simultaneous workers.
// No prompts or source code are logged. Run explicitly; this makes four paid model calls.
import { performance } from "node:perf_hooks";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import delegateExtension from "../packages/delegate/index.ts";

let delegate;
delegateExtension({ registerTool(tool) { delegate = tool; }, registerCommand() {} });
const context = { cwd: process.cwd(), isProjectTrusted: () => true, sessionManager: SessionManager.inMemory(process.cwd()) };
const jobs = [
  { task: "Read packages/delegate/package.json. Return only the package name and Node engine requirement.", type: "explore", files: ["packages/delegate/package.json"], maxOutputTokens: 100 },
  { task: "Read packages/delegate/task-memory.ts. Return only the TTL duration and maximum entry count.", type: "explore", files: ["packages/delegate/task-memory.ts"], maxOutputTokens: 100 },
];
async function run(job) {
  const result = await delegate.execute("bench", job, new AbortController().signal, undefined, context);
  if (result.isError) throw new Error("Worker failed during read-only benchmark");
  return { tokens: result.usage?.totalTokens ?? 0, cost: result.usage?.cost.total ?? 0 };
}
const parallelStart = performance.now();
const simultaneous = await Promise.all(jobs.map(run));
const parallelMs = Math.round(performance.now() - parallelStart);
const sequentialStart = performance.now();
const sequential = [];
for (const job of jobs) sequential.push(await run(job));
const sequentialMs = Math.round(performance.now() - sequentialStart);
const sum = (rows, field) => rows.reduce((n, item) => n + item[field], 0);
console.log(JSON.stringify({
  model: process.env.PI_DELEGATE_MODEL || "minimax/MiniMax-M3",
  maxWorkers: 2,
  parallelMs, sequentialMs,
  parallelTokens: sum(simultaneous, "tokens"), sequentialTokens: sum(sequential, "tokens"),
  parallelCost: sum(simultaneous, "cost"), sequentialCost: sum(sequential, "cost"),
  note: "One small run is not a stable performance estimate; tasks were independent and read-only.",
}, null, 2));

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const file = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "delegate", "telemetry.jsonl");
let records;
try {
  records = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
} catch {
  console.log("No delegation telemetry found.");
  process.exit(0);
}
const runs = records.filter((r) => r.status === "completed");
const sum = (field) => runs.reduce((total, r) => total + (r[field] || 0), 0);
const avg = (field) => runs.length ? Math.round(sum(field) / runs.length) : 0;
// Older records have only whole-job totals. Never treat their first request as a cache miss.
const measured = runs.filter((r) => r.assistantRequests > 0 &&
  Number.isFinite(r.firstRequestInputTokens) && Number.isFinite(r.firstRequestCachedInputTokens));
function cacheSummary(rows) {
  if (!rows.length) return null;
  const total = (field) => rows.reduce((n, r) => n + (Number.isFinite(r[field]) ? r[field] : 0), 0);
  const share = (read, input, write) => read + input + write > 0 ? read / (read + input + write) : null;
  const firstInput = total("firstRequestInputTokens");
  const firstRead = total("firstRequestCachedInputTokens");
  const firstWrite = total("firstRequestCacheWriteTokens");
  const laterInput = total("inputTokens") - firstInput;
  const laterRead = total("cachedInputTokens") - firstRead;
  const laterWrite = total("cacheWriteTokens") - firstWrite;
  return {
    calls: rows.length, assistantRequests: total("assistantRequests"),
    firstRequest: { inputTokens: firstInput, cachedInputTokens: firstRead, cacheWriteTokens: firstWrite,
      cacheShare: share(firstRead, firstInput, firstWrite),
      averageEndMs: Math.round(total("firstRequestEndMs") / rows.length),
      totalCost: total("firstRequestCost") },
    laterRequests: { inputTokens: laterInput, cachedInputTokens: laterRead, cacheWriteTokens: laterWrite,
      cacheShare: share(laterRead, laterInput, laterWrite) },
    averageJobDurationMs: Math.round(total("durationMs") / rows.length),
    averageJobCost: total("cost") / rows.length,
  };
}
const groups = Map.groupBy(measured, (r) => `${r.provider}/${r.model}:${r.type}`);
const sizedRuns = runs.filter((r) => r.toolResultSizes && typeof r.toolResultSizes === "object" && !Array.isArray(r.toolResultSizes));
const toolSizes = new Map();
for (const run of sizedRuns) {
  for (const [name, size] of Object.entries(run.toolResultSizes)) {
    if (!size || !Number.isFinite(size.calls) || size.calls <= 0 ||
      !Number.isFinite(size.totalTextBytes) || size.totalTextBytes < 0 ||
      !Number.isFinite(size.maxTextBytes) || size.maxTextBytes < 0) continue;
    const combined = toolSizes.get(name) ?? { calls: 0, totalTextBytes: 0, maxTextBytes: 0 };
    combined.calls += size.calls;
    combined.totalTextBytes += size.totalTextBytes;
    combined.maxTextBytes = Math.max(combined.maxTextBytes, size.maxTextBytes);
    toolSizes.set(name, combined);
  }
}
console.log(JSON.stringify({
  calls: records.length, completed: runs.length, failed: records.length - runs.length,
  averageDurationMs: avg("durationMs"), averageFirstResponseMs: avg("firstResponseMs"),
  workerInputTokens: sum("inputTokens"), cachedInputTokens: sum("cachedInputTokens"),
  workerOutputTokens: sum("outputTokens"), toolCalls: sum("toolCalls"), toolErrors: sum("toolErrors"),
  cacheMeasurement: { measuredCalls: measured.length, legacyOrNoResponseCalls: runs.length - measured.length,
    combined: cacheSummary(measured), byModelAndMode: Object.fromEntries(
      [...groups].map(([key, rows]) => [key, cacheSummary(rows)])) },
  toolResultSizes: { measuredCalls: sizedRuns.length, legacyCalls: runs.length - sizedRuns.length,
    byTool: Object.fromEntries([...toolSizes].sort((a, b) => b[1].totalTextBytes - a[1].totalTextBytes)
      .map(([name, size]) => [name, { ...size, averageTextBytes: Math.round(size.totalTextBytes / size.calls) }])) },
  taskMemoryLookups: runs.reduce((n, r) => n + (r.taskMemoryLookups ?? r.taskMemoryHits ?? 0), 0),
  taskMemoryConfirmedHits: runs.reduce((n, r) => n + (r.taskMemoryLookups === undefined ? 0 : r.taskMemoryHits || 0), 0),
  durableKnowledgeLookups: runs.reduce((n, r) => n + (r.durableKnowledgeLookups ?? r.durableKnowledgeHits ?? 0), 0),
  durableKnowledgeConfirmedHits: runs.reduce((n, r) => n + (r.durableKnowledgeLookups === undefined ? 0 : r.durableKnowledgeHits || 0), 0),
  legacyLookupOnlyCalls: runs.filter((r) => r.taskMemoryLookups === undefined).length,
  note: "Legacy jobs lack per-tool output sizes. Text bytes exclude images and are not token counts. First-request cache share does not prove reuse between delegations. Compare equivalent tasks and quality before capping outputs.",
}, null, 2));

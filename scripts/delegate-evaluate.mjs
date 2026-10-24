#!/usr/bin/env node
// Paired, metadata-only evaluation. Never reads prompts, tool arguments or source code.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--file", "--experiment", "--quality"].includes(argv[i]) || !argv[i + 1]) {
      throw new Error("Use: delegate-evaluate.mjs --experiment NAME [--file operations.jsonl] [--quality quality.json]");
    }
    result[argv[i].slice(2)] = argv[i + 1];
  }
  if (!result.experiment) throw new Error("--experiment is required");
  return result;
}

const numeric = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;
const usageTokens = (usage) => numeric(usage?.totalTokens);
const usageCost = (usage) => numeric(usage?.cost);
const sum = (rows, field) => rows.reduce((total, row) => total + row[field], 0);
const average = (rows, field) => rows.length ? Math.round(sum(rows, field) / rows.length) : 0;

let options;
try { options = args(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exit(1); }
const file = options.file || process.env.PI_TELEMETRY_PATH ||
  join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "telemetry", "operations.jsonl");
let records;
try {
  records = readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { const record = JSON.parse(line); return record?.type === "operation" ? [record] : []; }
    catch { return []; }
  });
} catch (error) { console.error(`Unable to read telemetry: ${error.code || "invalid file"}`); process.exit(1); }
const quality = options.quality ? JSON.parse(readFileSync(options.quality, "utf8")) : {};
const groups = new Map();
for (const record of records) {
  if (record.experiment !== options.experiment || record.status !== "settled" || !record.pairId ||
      !["direct", "delegated"].includes(record.variant)) continue;
  const group = groups.get(record.pairId) || { direct: [], delegated: [] };
  group[record.variant].push(record);
  groups.set(record.pairId, group);
}
const pairs = [];
const skipped = [];
for (const [pairId, group] of groups) {
  if (group.direct.length !== 1 || group.delegated.length !== 1) { skipped.push(pairId); continue; }
  const [direct] = group.direct;
  const [delegated] = group.delegated;
  const sameModel = Boolean(direct.outer?.initialModel?.provider && direct.outer?.initialModel?.model) &&
    direct.outer.initialModel.provider === delegated.outer?.initialModel?.provider &&
    direct.outer.initialModel.model === delegated.outer?.initialModel?.model;
  if (!sameModel || direct.cwd !== delegated.cwd || !delegated.delegations?.some((d) => d.toolName === "delegate")) {
    skipped.push(pairId); continue;
  }
  const judgment = quality[pairId];
  const directAccepted = judgment?.direct?.accepted === true;
  const delegatedAccepted = judgment?.delegated?.accepted === true;
  pairs.push({
    pairId,
    solTokensAvoided: usageTokens(direct.outer?.usage) - usageTokens(delegated.outer?.usage),
    workerTokensAdded: usageTokens(delegated.nestedUsage),
    solCachedReadAvoided: numeric(direct.outer?.usage?.cacheRead) - numeric(delegated.outer?.usage?.cacheRead),
    costSaved: usageCost(direct.totalUsage) - usageCost(delegated.totalUsage),
    durationSavedMs: numeric(direct.durationMs) - numeric(delegated.durationMs),
    quality: judgment && typeof judgment.direct?.accepted === "boolean" && typeof judgment.delegated?.accepted === "boolean"
      ? { directAccepted, delegatedAccepted, delegatedRedoCount: numeric(judgment.delegated.redoCount),
        solCorrectionCount: numeric(judgment.delegated.solCorrectionCount) }
      : "unscored",
  });
}
const assessed = pairs.filter((pair) => pair.quality !== "unscored");
console.log(JSON.stringify({
  experiment: options.experiment, pairs: pairs.length, skippedPairs: skipped.length,
  averageSolTokensAvoided: average(pairs, "solTokensAvoided"),
  averageWorkerTokensAdded: average(pairs, "workerTokensAdded"),
  averageCostSaved: pairs.length ? sum(pairs, "costSaved") / pairs.length : 0,
  averageDurationSavedMs: average(pairs, "durationSavedMs"),
  qualityScoredPairs: assessed.length,
  qualityRegressionPairs: assessed.filter((pair) => pair.quality.directAccepted && !pair.quality.delegatedAccepted).length,
  totalRedoCount: assessed.reduce((n, pair) => n + pair.quality.delegatedRedoCount, 0),
  totalSolCorrectionCount: assessed.reduce((n, pair) => n + pair.quality.solCorrectionCount, 0),
  pairsDetail: pairs,
  note: pairs.length === 0 ? "No valid matched pairs. Do not infer savings."
    : assessed.length !== pairs.length ? "Token/cost deltas are descriptive; assess quality for every pair before claiming value."
      : "Use multiple representative pairs. A quality regression can outweigh token savings.",
}, null, 2));

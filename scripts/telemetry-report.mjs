#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const DEFAULT_PATH = join(homedir(), ".pi", "agent", "telemetry", "operations.jsonl");

function usage() {
	console.log("Usage: telemetry-report.mjs [path] [--session <session-id>]");
}

function parseArgs(argv) {
	let path;
	let sessionId;
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--help" || argument === "-h") return { help: true };
		if (argument === "--session") {
			sessionId = argv[++index];
			if (!sessionId) throw new Error("--session requires a session ID");
			continue;
		}
		if (argument.startsWith("--session=")) {
			sessionId = argument.slice("--session=".length);
			if (!sessionId) throw new Error("--session requires a session ID");
			continue;
		}
		if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
		if (path) throw new Error(`Unexpected argument: ${argument}`);
		path = argument;
	}
	return { help: false, path, sessionId };
}

function telemetryPath(pathArgument) {
	const raw = pathArgument || process.env.PI_TELEMETRY_PATH || DEFAULT_PATH;
	const expanded = raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
	return isAbsolute(expanded) ? expanded : resolve(expanded);
}

function isRecord(value) {
	return value && typeof value === "object" && value.schemaVersion === 1 && value.type === "operation";
}

async function load(path) {
	let content;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return { records: [], malformed: 0 };
		throw error;
	}

	const records = [];
	let malformed = 0;
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line);
			if (isRecord(parsed)) records.push(parsed);
			else malformed++;
		} catch {
			malformed++;
		}
	}
	return { records, malformed };
}

function number(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function percentile(values, fraction) {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function duration(ms) {
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
	return `${(ms / 60_000).toFixed(1)}m`;
}

function tokens(value) {
	if (value < 1_000) return Math.round(value).toString();
	if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(2)}m`;
}

function addSample(groups, key, sample) {
	const group = groups.get(key) || [];
	group.push(sample);
	groups.set(key, group);
}

function operationSample(record) {
	return {
		durationMs: number(record.durationMs),
		tokens: number(record.totalUsage?.totalTokens),
		cost: number(record.totalUsage?.cost),
	};
}

function modelSample(record, model) {
	return {
		durationMs: number(record.durationMs),
		tokens: number(model.usage?.totalTokens),
		cost: number(model.usage?.cost),
	};
}

function childSample(child) {
	return {
		durationMs: number(child.durationMs),
		tokens: number(child.usage?.totalTokens),
		cost: number(child.usage?.cost),
	};
}

function printGroups(title, groups) {
	console.log(`\n${title}`);
	console.log("-".repeat(title.length));
	if (groups.size === 0) {
		console.log("(none)");
		return;
	}

	for (const [key, samples] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		const durations = samples.map((sample) => sample.durationMs).filter((value) => value > 0);
		const totalTokens = samples.reduce((sum, sample) => sum + sample.tokens, 0);
		const totalCost = samples.reduce((sum, sample) => sum + sample.cost, 0);
		const avgDuration = durations.length
			? duration(durations.reduce((sum, value) => sum + value, 0) / durations.length)
			: "n/a";
		const p50 = durations.length ? duration(percentile(durations, 0.5)) : "n/a";
		const p95 = durations.length ? duration(percentile(durations, 0.95)) : "n/a";
		console.log(
			`${key}\n` +
			`  n=${samples.length} avg=${avgDuration} p50=${p50} p95=${p95} ` +
			`avgTokens=${tokens(totalTokens / samples.length)} totalTokens=${tokens(totalTokens)} cost=$${totalCost.toFixed(4)}`,
		);
	}
}

let options;
try {
	options = parseArgs(process.argv.slice(2));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	usage();
	process.exit(1);
}
if (options.help) {
	usage();
	process.exit(0);
}

const path = telemetryPath(options.path);
const loaded = await load(path);
const records = options.sessionId
	? loaded.records.filter((record) => record.sessionId === options.sessionId)
	: loaded.records;
console.log(`Telemetry file: ${path}`);
console.log(`Valid operations: ${loaded.records.length}`);
if (options.sessionId) console.log(`Session filter: ${options.sessionId} (${records.length} matching)`);
if (loaded.malformed) console.log(`Malformed lines ignored: ${loaded.malformed}`);

if (records.length === 0) {
	console.log(options.sessionId ? "No telemetry operations match this session." : "No telemetry operations recorded yet.");
	process.exit(0);
}

const classifications = new Map();
const outerModels = new Map();
const subagentModels = new Map();
const experiments = new Map();
const sessions = new Map();

for (const record of records) {
	addSample(classifications, record.classification || "unknown", operationSample(record));

	const models = Array.isArray(record.outer?.models) ? record.outer.models : [];
	for (const model of models) {
		const response = model.responseModel ? ` (response: ${model.responseModel})` : "";
		addSample(outerModels, `${model.provider || "unknown"}/${model.model || "unknown"}${response}`, modelSample(record, model));
	}

	const delegations = Array.isArray(record.delegations) ? record.delegations : [];
	for (const delegation of delegations) {
		const children = Array.isArray(delegation.results) ? delegation.results : [];
		for (const child of children) {
			const key = `${child.agent || "unknown"} · ${child.provider || "unknown"}/${child.model || "unknown"}`;
			addSample(subagentModels, key, childSample(child));
		}
	}

	const experiment = record.experiment || "(unlabelled)";
	const variant = record.variant || record.classification || "(unlabelled)";
	addSample(experiments, `${experiment} · ${variant}`, operationSample(record));
	addSample(sessions, record.sessionId || "unknown", operationSample(record));
}

printGroups("Direct vs subagent", classifications);
printGroups("Outer models", outerModels);
printGroups("Subagent profiles and models", subagentModels);
printGroups("Experiments and variants", experiments);
printGroups("Pi sessions", sessions);

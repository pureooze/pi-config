import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	type ExtensionAPI,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

const SCHEMA_VERSION = 1;
const DEFAULT_TELEMETRY_PATH = join(getAgentDir(), "telemetry", "operations.jsonl");

interface UsageRecord {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	totalTokens: number;
	cost: number;
}

interface ModelUsageRecord {
	provider: string;
	model: string;
	responseModel?: string;
	turns: number;
	usage: UsageRecord;
}

interface TurnRecord {
	agentRun: number;
	turnIndex: number;
	startedAt: string;
	endedAt: string;
	durationMs: number;
	provider?: string;
	model?: string;
	responseModel?: string;
	stopReason?: string;
	toolResultCount: number;
	usage: UsageRecord;
}

interface SubagentResultRecord {
	agent: string;
	agentSource?: string;
	provider?: string;
	model?: string;
	status?: string;
	startedAt?: string;
	endedAt?: string;
	durationMs?: number;
	exitCode?: number;
	stopReason?: string;
	usage: UsageRecord;
}

interface DelegationRecord {
	toolName: string;
	toolCallId: string;
	mode?: string;
	startedAt: string;
	endedAt: string;
	durationMs: number;
	isError: boolean;
	results: SubagentResultRecord[];
	usage: UsageRecord;
}

interface OperationRecord {
	schemaVersion: typeof SCHEMA_VERSION;
	type: "operation";
	id: string;
	startedAt: string;
	endedAt: string;
	durationMs: number;
	status: "settled" | "shutdown" | "superseded";
	sessionId: string;
	cwd: string;
	experiment?: string;
	variant?: string;
	classification: "direct" | "subagent";
	outer: {
		initialModel?: { provider: string; model: string; thinkingLevel: string };
		agentRuns: number;
		assistantTurns: number;
		turns: TurnRecord[];
		models: ModelUsageRecord[];
		usage: UsageRecord;
	};
	delegations: DelegationRecord[];
	nestedUsage: UsageRecord;
	totalUsage: UsageRecord;
}

interface ToolStart {
	toolName: string;
	startedAtMs: number;
	startedAt: string;
}

interface TurnStart {
	startedAtMs: number;
	startedAt: string;
}

interface ActiveOperation {
	id: string;
	startedAtMs: number;
	startedAt: string;
	sessionId: string;
	cwd: string;
	experiment?: string;
	variant?: string;
	initialModel?: { provider: string; model: string; thinkingLevel: string };
	agentRuns: number;
	assistantTurns: number;
	turns: TurnRecord[];
	turnStarts: Map<string, TurnStart>;
	modelUsage: Map<string, ModelUsageRecord>;
	outerUsage: UsageRecord;
	delegations: DelegationRecord[];
	toolStarts: Map<string, ToolStart>;
	usedSubagent: boolean;
}

interface LoadedRecords {
	records: OperationRecord[];
	malformed: number;
}

function emptyUsage(): UsageRecord {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		totalTokens: 0,
		cost: 0,
	};
}

function addUsage(target: UsageRecord, addition: UsageRecord): void {
	target.input += addition.input;
	target.output += addition.output;
	target.cacheRead += addition.cacheRead;
	target.cacheWrite += addition.cacheWrite;
	target.reasoning += addition.reasoning;
	target.totalTokens += addition.totalTokens;
	target.cost += addition.cost;
}

function cloneUsage(usage: UsageRecord): UsageRecord {
	return { ...usage };
}

function usageFromAssistant(usage: Usage): UsageRecord {
	return {
		input: usage.input ?? 0,
		output: usage.output ?? 0,
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
		reasoning: usage.reasoning ?? 0,
		totalTokens: usage.totalTokens ?? 0,
		cost: usage.cost?.total ?? 0,
	};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function usageFromUnknown(value: unknown): UsageRecord {
	const record = asRecord(value);
	if (!record) return emptyUsage();

	const input = finiteNumber(record.input) ?? 0;
	const output = finiteNumber(record.output) ?? 0;
	const cacheRead = finiteNumber(record.cacheRead) ?? 0;
	const cacheWrite = finiteNumber(record.cacheWrite) ?? 0;
	const costRecord = asRecord(record.cost);
	const cost = finiteNumber(record.cost) ?? finiteNumber(costRecord?.total) ?? 0;

	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		reasoning: finiteNumber(record.reasoning) ?? 0,
		totalTokens: finiteNumber(record.totalTokens) ?? input + output + cacheRead + cacheWrite,
		cost,
	};
}

function resolveConfiguredPath(): string {
	const configured = process.env.PI_TELEMETRY_PATH?.trim();
	if (!configured) return DEFAULT_TELEMETRY_PATH;
	const expanded = configured === "~"
		? homedir()
		: configured.startsWith("~/")
			? join(homedir(), configured.slice(2))
			: configured;
	return isAbsolute(expanded) ? expanded : resolve(expanded);
}

function optionalEnv(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value ? value : undefined;
}

function isSubagentTool(toolName: string): boolean {
	const normalized = toolName.toLowerCase();
	return normalized === "subagent" ||
		normalized.startsWith("delegate_to_") ||
		normalized.includes("subagent");
}

function turnKey(agentRun: number, turnIndex: number): string {
	return `${agentRun}:${turnIndex}`;
}

function sanitizeSubagentResult(value: unknown): SubagentResultRecord | undefined {
	const record = asRecord(value);
	const agent = nonEmptyString(record?.agent);
	if (!record || !agent) return undefined;

	return {
		agent,
		agentSource: nonEmptyString(record.agentSource),
		provider: nonEmptyString(record.provider),
		model: nonEmptyString(record.model),
		status: nonEmptyString(record.status),
		startedAt: nonEmptyString(record.startedAt),
		endedAt: nonEmptyString(record.endedAt),
		durationMs: finiteNumber(record.durationMs),
		exitCode: finiteNumber(record.exitCode),
		stopReason: nonEmptyString(record.stopReason),
		usage: usageFromUnknown(record.usage),
	};
}

function delegationFromResult(
	toolName: string,
	toolCallId: string,
	start: ToolStart | undefined,
	result: unknown,
	isError: boolean,
): DelegationRecord {
	const endedAtMs = Date.now();
	const resultRecord = asRecord(result);
	const details = asRecord(resultRecord?.details);
	const rawResults = Array.isArray(details?.results) ? details.results : [];
	const results = rawResults
		.map(sanitizeSubagentResult)
		.filter((item): item is SubagentResultRecord => item !== undefined);
	const usage = emptyUsage();
	for (const child of results) addUsage(usage, child.usage);

	return {
		toolName,
		toolCallId,
		mode: nonEmptyString(details?.mode),
		startedAt: start?.startedAt ?? new Date(endedAtMs).toISOString(),
		endedAt: new Date(endedAtMs).toISOString(),
		durationMs: start ? endedAtMs - start.startedAtMs : 0,
		isError,
		results,
		usage,
	};
}

function isOperationRecord(value: unknown): value is OperationRecord {
	const record = asRecord(value);
	return record?.schemaVersion === SCHEMA_VERSION && record.type === "operation";
}

async function loadRecords(telemetryPath: string): Promise<LoadedRecords> {
	let content: string;
	try {
		content = await readFile(telemetryPath, "utf8");
	} catch (error) {
		if (nonEmptyString(asRecord(error)?.code) === "ENOENT") return { records: [], malformed: 0 };
		throw error;
	}

	const records: OperationRecord[] = [];
	let malformed = 0;
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (isOperationRecord(parsed)) records.push(parsed);
			else malformed++;
		} catch {
			malformed++;
		}
	}
	return { records, malformed };
}

function percentile(values: number[], fraction: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function formatDuration(durationMs: number): string {
	if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
	if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
	return `${(durationMs / 60_000).toFixed(1)}m`;
}

function formatTokens(tokens: number): string {
	if (tokens < 1_000) return Math.round(tokens).toString();
	if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return `${(tokens / 1_000_000).toFixed(2)}m`;
}

function compactReport(records: OperationRecord[], malformed: number): string {
	if (records.length === 0) {
		return malformed > 0
			? `No valid telemetry operations (${malformed} malformed line${malformed === 1 ? "" : "s"}).`
			: "No telemetry operations recorded yet.";
	}

	const lines = [`Telemetry: ${records.length} operation${records.length === 1 ? "" : "s"}`];
	for (const classification of ["direct", "subagent"] as const) {
		const matching = records.filter((record) => record.classification === classification);
		if (matching.length === 0) continue;
		const durations = matching.map((record) => finiteNumber(record.durationMs) ?? 0);
		const tokens = matching.reduce((sum, record) => sum + (finiteNumber(record.totalUsage?.totalTokens) ?? 0), 0);
		const cost = matching.reduce((sum, record) => sum + (finiteNumber(record.totalUsage?.cost) ?? 0), 0);
		lines.push(
			`${classification}: n=${matching.length}, avg=${formatDuration(durations.reduce((a, b) => a + b, 0) / matching.length)}, ` +
			`p50=${formatDuration(percentile(durations, 0.5))}, tokens=${formatTokens(tokens)}, cost=$${cost.toFixed(4)}`,
		);
	}

	const childGroups = new Map<string, SubagentResultRecord[]>();
	for (const record of records) {
		for (const delegation of record.delegations ?? []) {
			for (const child of delegation.results ?? []) {
				const key = `${child.agent} · ${child.provider ?? "unknown"}/${child.model ?? "unknown"}`;
				const group = childGroups.get(key) ?? [];
				group.push(child);
				childGroups.set(key, group);
			}
		}
	}
	for (const [key, children] of [...childGroups.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8)) {
		const durations = children.flatMap((child) => child.durationMs === undefined ? [] : [child.durationMs]);
		const tokens = children.reduce((sum, child) => sum + (finiteNumber(child.usage?.totalTokens) ?? 0), 0);
		lines.push(
			`${key}: n=${children.length}, avg=${durations.length ? formatDuration(durations.reduce((a, b) => a + b, 0) / durations.length) : "n/a"}, ` +
			`tokens=${formatTokens(tokens)}`,
		);
	}

	const sessionGroups = new Map<string, OperationRecord[]>();
	for (const record of records) {
		const key = record.sessionId || "unknown";
		const group = sessionGroups.get(key) ?? [];
		group.push(record);
		sessionGroups.set(key, group);
	}
	lines.push("Sessions:");
	for (const [sessionId, operations] of [...sessionGroups.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8)) {
		const direct = operations.filter((record) => record.classification === "direct").length;
		const subagent = operations.filter((record) => record.classification === "subagent").length;
		const durations = operations.map((record) => finiteNumber(record.durationMs) ?? 0);
		const totalTokens = operations.reduce(
			(sum, record) => sum + (finiteNumber(record.totalUsage?.totalTokens) ?? 0),
			0,
		);
		lines.push(
			`${sessionId}: n=${operations.length}, direct=${direct}, subagent=${subagent}, ` +
			`avg=${formatDuration(durations.reduce((a, b) => a + b, 0) / operations.length)}, tokens=${formatTokens(totalTokens)}`,
		);
	}
	if (sessionGroups.size > 8) lines.push(`... ${sessionGroups.size - 8} more sessions (use the CLI report for all)`);
	if (malformed > 0) lines.push(`Ignored malformed lines: ${malformed}`);
	return lines.join("\n");
}

export default function telemetryExtension(pi: ExtensionAPI) {
	const telemetryPath = resolveConfiguredPath();
	let active: ActiveOperation | undefined;

	const appendOperation = async (record: OperationRecord): Promise<void> => {
		try {
			await withFileMutationQueue(telemetryPath, async () => {
				await mkdir(dirname(telemetryPath), { recursive: true });
				await appendFile(telemetryPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[telemetry] Could not append ${telemetryPath}: ${message}`);
		}
	};

	const finishOperation = async (status: OperationRecord["status"]): Promise<void> => {
		if (!active) return;
		const operation = active;
		active = undefined;
		const endedAtMs = Date.now();

		for (const [toolCallId, start] of operation.toolStarts) {
			operation.delegations.push({
				toolName: start.toolName,
				toolCallId,
				startedAt: start.startedAt,
				endedAt: new Date(endedAtMs).toISOString(),
				durationMs: endedAtMs - start.startedAtMs,
				isError: true,
				results: [],
				usage: emptyUsage(),
			});
		}

		const nestedUsage = emptyUsage();
		for (const delegation of operation.delegations) addUsage(nestedUsage, delegation.usage);
		const totalUsage = cloneUsage(operation.outerUsage);
		addUsage(totalUsage, nestedUsage);

		await appendOperation({
			schemaVersion: SCHEMA_VERSION,
			type: "operation",
			id: operation.id,
			startedAt: operation.startedAt,
			endedAt: new Date(endedAtMs).toISOString(),
			durationMs: endedAtMs - operation.startedAtMs,
			status,
			sessionId: operation.sessionId,
			cwd: operation.cwd,
			experiment: operation.experiment,
			variant: operation.variant,
			classification: operation.usedSubagent ? "subagent" : "direct",
			outer: {
				initialModel: operation.initialModel,
				agentRuns: operation.agentRuns,
				assistantTurns: operation.assistantTurns,
				turns: operation.turns,
				models: [...operation.modelUsage.values()],
				usage: cloneUsage(operation.outerUsage),
			},
			delegations: operation.delegations,
			nestedUsage,
			totalUsage,
		});
	};

	pi.on("before_agent_start", async (_event, ctx) => {
		if (active) await finishOperation("superseded");
		const startedAtMs = Date.now();
		active = {
			id: randomUUID(),
			startedAtMs,
			startedAt: new Date(startedAtMs).toISOString(),
			sessionId: ctx.sessionManager.getSessionId(),
			cwd: ctx.cwd,
			experiment: optionalEnv("PI_TELEMETRY_EXPERIMENT"),
			variant: optionalEnv("PI_TELEMETRY_VARIANT"),
			initialModel: ctx.model
				? { provider: ctx.model.provider, model: ctx.model.id, thinkingLevel: ctx.thinkingLevel }
				: undefined,
			agentRuns: 0,
			assistantTurns: 0,
			turns: [],
			turnStarts: new Map(),
			modelUsage: new Map(),
			outerUsage: emptyUsage(),
			delegations: [],
			toolStarts: new Map(),
			usedSubagent: false,
		};
	});

	pi.on("agent_start", () => {
		if (active) active.agentRuns++;
	});

	pi.on("turn_start", (event) => {
		if (!active) return;
		const startedAtMs = Date.now();
		active.turnStarts.set(turnKey(active.agentRuns, event.turnIndex), {
			startedAtMs,
			startedAt: new Date(startedAtMs).toISOString(),
		});
	});

	pi.on("turn_end", (event) => {
		if (!active) return;
		const endedAtMs = Date.now();
		const key = turnKey(active.agentRuns, event.turnIndex);
		const start = active.turnStarts.get(key);
		active.turnStarts.delete(key);
		const message = event.message;
		const assistantUsage = message.role === "assistant" ? usageFromAssistant(message.usage) : emptyUsage();
		const provider = message.role === "assistant" ? message.provider : undefined;
		const model = message.role === "assistant" ? message.model : undefined;
		const responseModel = message.role === "assistant" ? message.responseModel : undefined;

		active.turns.push({
			agentRun: active.agentRuns,
			turnIndex: event.turnIndex,
			startedAt: start?.startedAt ?? new Date(endedAtMs).toISOString(),
			endedAt: new Date(endedAtMs).toISOString(),
			durationMs: start ? endedAtMs - start.startedAtMs : 0,
			provider,
			model,
			responseModel,
			stopReason: message.role === "assistant" ? message.stopReason : undefined,
			toolResultCount: event.toolResults.length,
			usage: assistantUsage,
		});

		if (message.role !== "assistant") return;
		active.assistantTurns++;
		addUsage(active.outerUsage, assistantUsage);
		const modelKey = `${message.provider}/${message.model}/${message.responseModel ?? ""}`;
		const existing = active.modelUsage.get(modelKey);
		if (existing) {
			existing.turns++;
			addUsage(existing.usage, assistantUsage);
		} else {
			active.modelUsage.set(modelKey, {
				provider: message.provider,
				model: message.model,
				responseModel: message.responseModel,
				turns: 1,
				usage: cloneUsage(assistantUsage),
			});
		}
	});

	pi.on("tool_execution_start", (event) => {
		if (!active || !isSubagentTool(event.toolName)) return;
		const startedAtMs = Date.now();
		active.usedSubagent = true;
		active.toolStarts.set(event.toolCallId, {
			toolName: event.toolName,
			startedAtMs,
			startedAt: new Date(startedAtMs).toISOString(),
		});
	});

	pi.on("tool_execution_end", (event) => {
		if (!active || !isSubagentTool(event.toolName)) return;
		const start = active.toolStarts.get(event.toolCallId);
		active.toolStarts.delete(event.toolCallId);
		active.delegations.push(
			delegationFromResult(event.toolName, event.toolCallId, start, event.result, event.isError),
		);
	});

	pi.on("agent_settled", async () => {
		await finishOperation("settled");
	});

	pi.on("session_shutdown", async () => {
		await finishOperation("shutdown");
	});

	pi.registerCommand("telemetry-status", {
		description: "Show the local telemetry path and record count",
		handler: async (_args, ctx) => {
			try {
				const loaded = await loadRecords(telemetryPath);
				ctx.ui.notify(
					`${telemetryPath}\n${loaded.records.length} valid operation${loaded.records.length === 1 ? "" : "s"}` +
						(loaded.malformed ? `; ${loaded.malformed} malformed line${loaded.malformed === 1 ? "" : "s"}` : ""),
					"info",
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not read telemetry: ${message}`, "error");
			}
		},
	});

	pi.registerCommand("telemetry-report", {
		description: "Compare telemetry, optionally filtered by an exact Pi session ID",
		handler: async (args, ctx) => {
			try {
				const loaded = await loadRecords(telemetryPath);
				const sessionId = args.trim();
				const records = sessionId
					? loaded.records.filter((record) => record.sessionId === sessionId)
					: loaded.records;
				const heading = sessionId ? `Session: ${sessionId}\n` : "";
				ctx.ui.notify(`${heading}${compactReport(records, loaded.malformed)}`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not read telemetry: ${message}`, "error");
			}
		},
	});
}

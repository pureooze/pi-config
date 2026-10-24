import assert from "node:assert/strict";
import test from "node:test";
import modelFailoverExtension, { isOpenAiRateOrQuotaFailure } from "../../packages/model-failover/index.ts";

// ---------- Pure matcher ----------

test("matcher: chatgpt usage limit on openai returns true", () => {
	assert.equal(
		isOpenAiRateOrQuotaFailure({
			provider: "openai",
			stopReason: "error",
			errorMessage: "ChatGPT usage limit reached (5h window).",
		}),
		true,
	);
});

test("matcher: codex chatgpt usage limit returns true", () => {
	assert.equal(
		isOpenAiRateOrQuotaFailure({
			provider: "openai-codex",
			stopReason: "error",
			errorMessage: "ChatGPT usage limit reached",
		}),
		true,
	);
});

test("matcher: explicit HTTP 429 returns true", () => {
	assert.equal(
		isOpenAiRateOrQuotaFailure({
			provider: "openai",
			stopReason: "error",
			errorMessage: "upstream returned 429 Too Many Requests",
		}),
		true,
	);
});

test("matcher: generic rate_limit / too many requests returns true", () => {
	assert.equal(
		isOpenAiRateOrQuotaFailure({
			provider: "openai",
			stopReason: "error",
			errorMessage: "rate_limit exceeded (too many requests)",
		}),
		true,
	);
});

test("matcher: quota / insufficient_quota returns true", () => {
	assert.equal(
		isOpenAiRateOrQuotaFailure({
			provider: "openai",
			stopReason: "error",
			errorMessage: "insufficient_quota: account quota exceeded",
		}),
		true,
	);
});

test("matcher: rejects non-openai providers", () => {
	for (const provider of ["minimax", "anthropic", "google"]) {
		assert.equal(
			isOpenAiRateOrQuotaFailure({
				provider,
				stopReason: "error",
				errorMessage: "ChatGPT usage limit reached",
			}),
			false,
			`provider=${provider}`,
		);
	}
});

test("matcher: rejects 5xx / network / auth / context errors", () => {
	const cases = [
		"500 Internal Server Error",
		"502 Bad Gateway",
		"network connection reset",
		"ECONNRESET",
		"unauthorized: invalid api key",
		"context length exceeded",
		"content_policy_violation",
	];
	for (const errorMessage of cases) {
		assert.equal(
			isOpenAiRateOrQuotaFailure({ provider: "openai", stopReason: "error", errorMessage }),
			false,
			errorMessage,
		);
	}
});

test("matcher: rejects when stopReason is not error", () => {
	assert.equal(
		isOpenAiRateOrQuotaFailure({
			provider: "openai",
			stopReason: "end_turn",
			errorMessage: "ChatGPT usage limit reached",
		}),
		false,
	);
});

test("matcher: rejects when errorMessage is empty / missing", () => {
	assert.equal(isOpenAiRateOrQuotaFailure({ provider: "openai", stopReason: "error" }), false);
	assert.equal(
		isOpenAiRateOrQuotaFailure({ provider: "openai", stopReason: "error", errorMessage: "" }),
		false,
	);
});

// ---------- Extension behaviour ----------

function makePi() {
	const handlers = new Map();
	return {
		handlers,
		on(name, fn) {
			handlers.set(name, fn);
		},
		async setModel() {
			return true;
		},
		setThinkingLevel() {},
		async sendUserMessage() {},
	};
}

function makeCtx({
	provider = "openai",
	modelId = "gpt-5",
	sessionId = "sess-1",
	pending = false,
	idle = true,
	registryHas = true,
} = {}) {
	const model = { provider, id: modelId };
	return {
		model,
		hasPendingMessages: () => pending,
		isIdle: () => idle,
		modelRegistry: {
			find: (_p, _m) =>
				registryHas ? { provider: "minimax", id: "MiniMax-M3" } : undefined,
		},
		sessionManager: { getSessionId: () => sessionId },
		ui: { notify() {} },
	};
}

function flush() {
	return new Promise((r) => setTimeout(r, 5));
}

test("extension: failed agent_end + settled switches to MiniMax M3 then high, one queued continuation", async () => {
	const pi = makePi();
	modelFailoverExtension(pi);

	const agentEnd = {
		messages: [
			{
				role: "assistant",
				provider: "openai",
				stopReason: "error",
				errorMessage: "ChatGPT usage limit reached (5h window).",
			},
		],
	};
	const ctx = makeCtx();
	pi.handlers.get("agent_end")(agentEnd, ctx);

	let switchedTo = null;
	let thinkingLevel = null;
	pi.setModel = async (target) => {
		switchedTo = target;
		ctx.model = target;
		return true;
	};
	pi.setThinkingLevel = (lvl) => {
		thinkingLevel = lvl;
	};
	let sentPrompt = null;
	pi.sendUserMessage = async (p) => {
		sentPrompt = p;
	};

	await pi.handlers.get("agent_settled")({}, ctx);
	await flush();

	assert.equal(switchedTo.provider, "minimax");
	assert.equal(switchedTo.id, "MiniMax-M3");
	assert.equal(thinkingLevel, "high");
	assert.equal(sentPrompt, "Continue the previous user request from where it stopped. Do not repeat completed work.");
});

test("extension: successful agent_end resets candidate; settled does not switch", async () => {
	const pi = makePi();
	modelFailoverExtension(pi);

	const ctx = makeCtx();
	pi.handlers.get("agent_end")(
		{
			messages: [
				{ role: "assistant", provider: "openai", stopReason: "end_turn", errorMessage: "" },
			],
		},
		ctx,
	);

	let switched = false;
	pi.setModel = async () => {
		switched = true;
		return true;
	};

	await pi.handlers.get("agent_settled")({}, ctx);
	assert.equal(switched, false);
});

test("extension: missing fallback model leaves original model", async () => {
	const pi = makePi();
	modelFailoverExtension(pi);

	const ctx = makeCtx({ registryHas: false });
	pi.handlers.get("agent_end")(
		{
			messages: [
				{ role: "assistant", provider: "openai", stopReason: "error", errorMessage: "ChatGPT usage limit reached" },
			],
		},
		ctx,
	);

	let switched = false;
	pi.setModel = async () => {
		switched = true;
		return true;
	};

	await pi.handlers.get("agent_settled")({}, ctx);
	assert.equal(switched, false);
	assert.equal(ctx.model.provider, "openai");
});

test("extension: setModel rejection (returns false) leaves original model", async () => {
	const pi = makePi();
	modelFailoverExtension(pi);

	const ctx = makeCtx();
	pi.handlers.get("agent_end")(
		{
			messages: [
				{ role: "assistant", provider: "openai", stopReason: "error", errorMessage: "429 rate_limit" },
			],
		},
		ctx,
	);

	pi.setModel = async () => false;
	pi.sendUserMessage = async () => {
		throw new Error("should not be called");
	};

	await pi.handlers.get("agent_settled")({}, ctx);
	assert.equal(ctx.model.provider, "openai");
});

test("extension: guard pending messages blocks failover", async () => {
	const pi = makePi();
	modelFailoverExtension(pi);

	const ctx = makeCtx({ pending: true });
	pi.handlers.get("agent_end")(
		{
			messages: [
				{ role: "assistant", provider: "openai", stopReason: "error", errorMessage: "ChatGPT usage limit reached" },
			],
		},
		ctx,
	);

	let switched = false;
	pi.setModel = async () => {
		switched = true;
		return true;
	};

	await pi.handlers.get("agent_settled")({}, ctx);
	assert.equal(switched, false);
});

test("extension: aborted (agent_end with no messages) clears candidate", async () => {
	const pi = makePi();
	modelFailoverExtension(pi);

	const ctx = makeCtx();
	pi.handlers.get("agent_end")({ messages: [] }, ctx);

	let switched = false;
	pi.setModel = async () => {
		switched = true;
		return true;
	};

	await pi.handlers.get("agent_settled")({}, ctx);
	assert.equal(switched, false);
});

test("extension: changed session id at timer fire aborts queued continuation", async () => {
	const pi = makePi();
	modelFailoverExtension(pi);

	let currentSession = "sess-1";
	const ctx = makeCtx();
	ctx.sessionManager.getSessionId = () => currentSession;
	// After setModel, the runtime's ctx.model now reflects failover target.
	const originalSetModel = pi.setModel;
	pi.setModel = async (target) => {
		ctx.model = target;
		return originalSetModel ? originalSetModel(target) : true;
	};

	pi.handlers.get("agent_end")(
		{
			messages: [
				{ role: "assistant", provider: "openai", stopReason: "error", errorMessage: "ChatGPT usage limit reached" },
			],
		},
		ctx,
	);

	let sent = false;
	pi.sendUserMessage = async () => {
		sent = true;
	};

	await pi.handlers.get("agent_settled")({}, ctx);

	// Simulate session reload before the 0ms timer fires.
	currentSession = "sess-2";
	await flush();
	assert.equal(sent, false);
});

test("extension: manual model switch before timer aborts queued continuation", async () => {
	const pi = makePi();
	modelFailoverExtension(pi);

	const ctx = makeCtx();
	const originalSetModel = pi.setModel;
	pi.setModel = async (target) => {
		ctx.model = target;
		return originalSetModel ? originalSetModel(target) : true;
	};

	pi.handlers.get("agent_end")(
		{
			messages: [
				{ role: "assistant", provider: "openai", stopReason: "error", errorMessage: "ChatGPT usage limit reached" },
			],
		},
		ctx,
	);

	let sent = false;
	pi.sendUserMessage = async () => {
		sent = true;
	};

	await pi.handlers.get("agent_settled")({}, ctx);

	// Manual switch away before timer fires.
	ctx.model = { provider: "anthropic", id: "claude-opus" };
	await flush();
	assert.equal(sent, false);
});

test("extension: non-openai active model at settle blocks failover", async () => {
	const pi = makePi();
	modelFailoverExtension(pi);

	const ctx = makeCtx({ provider: "anthropic", modelId: "claude-opus" });
	pi.handlers.get("agent_end")(
		{
			messages: [
				{ role: "assistant", provider: "openai", stopReason: "error", errorMessage: "ChatGPT usage limit reached" },
			],
		},
		ctx,
	);

	let switched = false;
	pi.setModel = async () => {
		switched = true;
		return true;
	};

	await pi.handlers.get("agent_settled")({}, ctx);
	assert.equal(switched, false);
});
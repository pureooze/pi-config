import type {
	AgentEndEvent,
	AgentSettledEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type AgentMessage = unknown;

/**
 * Provider ids we consider as "OpenAI-compatible" for failover purposes.
 * Matches the parent spec: only `openai` and `openai-codex`.
 */
const OPENAI_PROVIDERS = new Set(["openai", "openai-codex"]);

/**
 * Failover target (fixed by architecture; not user-configurable).
 */
const FAILOVER_PROVIDER = "minimax";
const FAILOVER_MODEL_ID = "MiniMax-M3";
const FAILOVER_THINKING_LEVEL = "high";

/**
 * Single short continuation prompt. Never re-sends the original user text.
 */
const CONTINUE_PROMPT =
	"Continue the previous user request from where it stopped. Do not repeat completed work.";

/**
 * Pure matcher helper (exported so it's independently testable).
 *
 * Returns true only when:
 *   - provider is `openai` or `openai-codex`, AND
 *   - stopReason is `"error"`, AND
 *   - errorMessage matches one of the explicit rate/quota/usage-limit signals.
 *
 * Excludes unrelated failures (auth, network, context length, content policy, server 5xx, etc.).
 */
export function isOpenAiRateOrQuotaFailure(input: {
	provider?: string;
	stopReason?: string;
	errorMessage?: string;
}): boolean {
	if (!input || !input.provider || !OPENAI_PROVIDERS.has(input.provider)) return false;
	if (input.stopReason !== "error") return false;
	const msg = (input.errorMessage ?? "").toLowerCase();
	if (!msg) return false;

	// Explicit rate/quota/usage-limit signals only.
	// Order is irrelevant; any one match is sufficient.
	const signals: RegExp[] = [
		/\b429\b/, // HTTP status
		/rate[_ -]?limit/, // "rate limit", "rate_limit", "rate-limit"
		/too many requests/,
		/chatgpt usage limit/,
		/usage[_ -]?limit[_ -]?reached/,
		/insufficient[_ -]?quota/,
		/quota exceeded/,
	];

	for (const re of signals) {
		if (re.test(msg)) return true;
	}
	return false;
}

/**
 * Extract the final assistant message from an agent_end event.
 * Returns undefined when there is no assistant message.
 */
function lastAssistantMessage(messages: AgentMessage[] | undefined): AgentMessage | undefined {
	if (!messages || messages.length === 0) return undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string };
		if (m && m.role === "assistant") return messages[i];
	}
	return undefined;
}

/**
 * Read fields off an assistant message in a provider-agnostic way.
 * The Pi message shape exposes stopReason / errorMessage / provider via the
 * assistant message itself.
 */
function readAssistantFields(msg: AgentMessage): {
	provider?: string;
	stopReason?: string;
	errorMessage?: string;
} {
	const m = msg as unknown as {
		provider?: string;
		model?: { provider?: string } | string;
		stopReason?: string;
		errorMessage?: string;
	};
	let provider = m.provider;
	if (!provider && m.model && typeof m.model === "object" && "provider" in m.model) {
		provider = (m.model as { provider?: string }).provider;
	}
	return {
		provider,
		stopReason: m.stopReason,
		errorMessage: m.errorMessage,
	};
}

/**
 * Module-scoped state: at most one pending failover candidate per extension
 * load. Cleared on success or after a successful continuation send.
 */
let pendingCandidate: {
	provider: string;
	stopReason: string;
	errorMessage: string;
} | null = null;

export default function modelFailoverExtension(pi: ExtensionAPI): void {
	pi.on("agent_end", (_event: AgentEndEvent, _ctx: ExtensionContext) => {
		const last = lastAssistantMessage(_event.messages);
		if (!last) {
			pendingCandidate = null;
			return;
		}
		const fields = readAssistantFields(last);
		if (isOpenAiRateOrQuotaFailure(fields)) {
			pendingCandidate = {
				provider: fields.provider!,
				stopReason: fields.stopReason!,
				errorMessage: fields.errorMessage ?? "",
			};
		} else {
			// Reset on any non-matching outcome (success or unrelated failure).
			pendingCandidate = null;
		}
	});

	pi.on("agent_settled", async (_event: AgentSettledEvent, ctx: ExtensionContext) => {
		const candidate = pendingCandidate;
		// Clear immediately so a follow-up settle cannot retry.
		pendingCandidate = null;

		if (!candidate) return;

		// Guard 1: only act if the active model is still an OpenAI variant.
		if (!ctx.model || !OPENAI_PROVIDERS.has(ctx.model.provider)) return;
		// Guard 2: don't interleave with user-queued prompts.
		if (ctx.hasPendingMessages()) return;

		const target = ctx.modelRegistry.find(FAILOVER_PROVIDER, FAILOVER_MODEL_ID);
		if (!target) {
			ctx.ui.notify(
				`Model failover unavailable: ${FAILOVER_PROVIDER}/${FAILOVER_MODEL_ID} not registered.`,
				"warning",
			);
			return;
		}

		// pi.setModel returns false when auth (or any other precondition) is
		// missing; we don't need to inspect/expose the API key ourselves.
		let switched = false;
		try {
			switched = await pi.setModel(target);
		} catch (err) {
			ctx.ui.notify(
				`Model failover failed: could not switch to ${FAILOVER_PROVIDER}/${FAILOVER_MODEL_ID}.`,
				"warning",
			);
			return;
		}
		if (!switched) {
			// Includes the missing-auth case (returns false, never throws).
			ctx.ui.notify(
				`Model failover declined: switch to ${FAILOVER_PROVIDER}/${FAILOVER_MODEL_ID} was not accepted (check credentials).`,
				"warning",
			);
			return;
		}

		try {
			pi.setThinkingLevel(FAILOVER_THINKING_LEVEL);
		} catch {
			// Non-fatal: thinking level is best-effort.
		}

		ctx.ui.notify(
			`Failing over from ${candidate.provider} to ${FAILOVER_PROVIDER}/${FAILOVER_MODEL_ID} after rate/quota error.`,
			"info",
		);

		// Capture session id and target model identity now (sync, on the
		// captured ExtensionContext) so we can detect stale-session / reload
		// cases when the timer fires.
		const originalSessionId = ctx.sessionManager.getSessionId();
		const targetModelId = target.id;

		// Schedule the continuation outside the event handler so Pi's runtime
		// has fully returned control. Re-check idle + exact target model
		// (provider + id) + no pending messages + same session immediately
		// before sending to avoid racing a manual switch, a user-typed
		// follow-up, or a session reload.
		setTimeout(() => {
			try {
				if (!ctx.sessionManager.getSessionId() || ctx.sessionManager.getSessionId() !== originalSessionId) return;
				if (!ctx.isIdle()) return;
				if (!ctx.model) return;
				if (ctx.model.provider !== FAILOVER_PROVIDER) return;
				if (ctx.model.id !== targetModelId) return;
				if (ctx.hasPendingMessages()) return;

				void pi.sendUserMessage(CONTINUE_PROMPT);
			} catch (err) {
				try {
					ctx.ui.notify(
						`Model failover continuation failed to send; please retry your last prompt.`,
						"warning",
					);
				} catch {
					// Even notify may throw on a torn-down session; swallow.
				}
			}
		}, 0);
	});
}

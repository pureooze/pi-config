# @pureooze/pi-delegate

In-process Pi extension that spawns cheap, isolated workers for narrow tasks (explore, implement, test, fix). The parent session is the architect; workers have no parent transcript, no extensions, no skills, and a fixed toolset per mode.

## Install

Local install in Pi:

```sh
# from this repo
pi install ./packages/delegate
# One-run trial, without installing:
pi --no-extensions -e ./packages/delegate/index.ts
```

For npm installs after publishing: `pi install npm:@pureooze/pi-delegate`. For local development, run `npm ci` at the workspace root first.

Peer deps required at runtime: `@earendil-works/pi-coding-agent`, `typebox`, `@pureooze/pi-knowledge-graph` (`^0.1.2`). Node `>=24.14.1`.

## Model + auth

Workers use Pi's model catalog and a cached worker model runtime backed by Pi's stored credentials/environment (parent-only runtime API-key overrides are not inherited). The default is `home-ollama/smtek/Qwen3.8-27B:Q3_K_M`, the local Qwen subagent on the home Ollama server reached over Tailscale. **Pi must have that model registered in its catalog** (it is registered in this environment's `models.json` as provider `home-ollama`); if your catalog does not include it, either register it there with `provider: home-ollama` or point `PI_DELEGATE_MODEL` at any other provider/model-id known to Pi. The default needs no cloud credentials — only a reachable `home-ollama` provider; other providers use Pi's existing auth for that provider. The extension validates that the model string contains a `/` and that auth is configured for its provider; otherwise it returns a clear error.

Override the worker model with `PI_DELEGATE_MODEL=provider/model-id`, e.g.:

```sh
PI_DELEGATE_MODEL=minimax/MiniMax-M3.1-Flash-Preview pi
# any other provider/model-id known to Pi works
```

Override models keep the legacy `thinkingLevel: "off"`, **except** the legacy adaptive-thinking target `minimax/MiniMax-M3.1-Flash-Preview`: that model requires adaptive thinking and rejects a disabled-thinking request, so for it the extension sends `thinkingLevel: "low"` — Pi's anthropic provider translates that to adaptive thinking plus `output_config.effort low` per the model's own map (the `home-ollama` provider maps `"off"` to Ollama's `/no_think` and `"low"` to `/think`). Default answer budgets can be changed with `PI_DELEGATE_EXPLORE_OUTPUT_TOKENS`, `PI_DELEGATE_IMPLEMENT_OUTPUT_TOKENS`, `PI_DELEGATE_TEST_OUTPUT_TOKENS`, and `PI_DELEGATE_FIX_OUTPUT_TOKENS` (integer 100–2000). Per-call `maxOutputTokens` takes precedence.

## `delegate` tool

Registered by `index.ts` with this exact schema (no extra properties):

- `task` (string, 1–8000) — the work, plus any files/constraints you want passed in.
- `type` (one of `explore | implement | test | fix`, default `explore`).
- `files` (string[], ≤20, each ≤500 chars) — file hints prepended to the prompt.
- `constraints` (string[], ≤20, each ≤500 chars) — bullet list prepended to the prompt.
- `maxOutputTokens` (int, 100–2000) — overrides the per-mode default; used for the final-answer cap and a hard truncation bound on returned text.

### Modes → tool sets (exact, from `index.ts`)

| Mode      | Tools                                                   | Default final-answer cap |
|-----------|---------------------------------------------------------|--------------------------|
| `explore` | `read`, `find`, `grep`                                  | 500                      |
| `implement` | `read`, `find`, `grep`, `edit`, `write`, `bash`        | 800                      |
| `test`    | `read`, `grep`, `bash`                                  | 500                      |
| `fix`     | `read`, `grep`, `edit`, `bash`                          | 600                      |

Each mode also gets the worker toolset described below. The `delegate` tool itself is **not** in the worker registry (no recursion, no nested `delegate`).

In the Pi TUI, the collapsed tool row previews the mode, assigned task, and completion status. Expand the tool row to see the **full task, file references, constraints, and final worker reply**. This renders the existing call and result locally; it does not make another model call, duplicate output in the model context, or stream the worker's intermediate steps. Expanding long output has ordinary local TUI rendering cost.

### Worker toolset (`worker-tools.ts`)

Five tools, lazily started and shut down with the session:

- `knowledge_search(query, limit?)` — read-only retrieval against the project knowledge graph; returns summaries + IDs + up to 3 evidence IDs per hit.
- `knowledge_get(id, view?)` — expand a record (`summary | history | neighbors | evidence`).
- `task_memory_search(query, category?)` — sibling workers' task-scoped notes.
- `task_memory_get(key)` — fetch one task-scoped note.
- `task_memory_write(key, content, category?, evidence?)` — upsert a short note.

Notably **absent** from the worker registry: any `knowledge_*` maintenance/destructive tool, an extension loader, a generic memory namespace, and `delegate` itself.

### Tool isolation — read this carefully

Code-level isolation is real: each worker runs with a fixed tool list, no parent transcript, no extensions, no skills, no themes, no `agentsFiles`, no `appendSystemPrompt`, and a single deterministic system prompt. The trust flag is forwarded for knowledge-graph configuration; the worker does not load project extensions or other project-discovered resources.

Built-in repository file tools are overridden to refuse paths outside the repository and protected Pi storage, including symlink escapes. On macOS, worker `bash` is launched inside `sandbox-exec` with read/write denied to Pi's agent directory and `PI_KNOWLEDGE_GRAPH_DIR` (including canonical path aliases); normal repository commands still work. On other platforms `bash` fails closed until an OS sandbox backend is implemented. The in-process knowledge and task-memory tools still access their own stores through their narrow APIs.

**This is not a general security sandbox.** Commands can access other host files, network, inherited environment variables, and processes; the Pi host itself retains OS privileges. Untrusted repositories and adversarial worker instructions require full process isolation. The worker prompt's ban on destructive/publishing/remote commands is policy, not enforcement.

## Task memory

Short-lived, private to one parent task:

- Parent task id = `${sessionId}:${lastUserMessageIdOnBranch}`, derived from the active session branch (separate from session id alone).
- The task id is **hashed (SHA-256) to a filename** — raw ids never touch disk.
- Stored as a single JSON file: `~/.pi/agent/delegate/tasks/<hash>.task-memory.json`, mode `0o600`; directory mode `0o700` (older owned 0755 directories are tightened automatically). Atomic writes via `*.tmp` + rename.
- TTL: **24 hours** from creation. Accessing an expired note deletes that task's old file; notes from other tasks are not swept on startup. `/delegate-complete` explicitly deletes the current parent task's notes without affecting sibling tasks.
- Limits per file: ≤64 entries; key ≤100; category ≤100; content ≤1200; ≤8 evidence strings each ≤300.
- Search is a token-overlap score over `key + content + evidence` (capped at 5 hits).
- **Not** automatically promoted to durable knowledge. `task_memory_write` cannot write durable knowledge; only `task_memory_get/search/write` are exposed. Up to 3 evidence-backed `knowledgeCandidates` may be returned in tool details for the parent to consider; they are never persisted automatically.

## Telemetry

Append-only JSONL at `~/.pi/agent/delegate/telemetry.jsonl` (dir `0o700`, file `0o600`). Per-delegation record:

`startedAt`, `provider`, `model`, `type`, `firstResponseMs`, `durationMs`, `inputTokens`, `cachedInputTokens`, `outputTokens`, `cacheWriteTokens`, `reasoningTokens`, `totalTokens`, `cost`, `assistantRequests`, `firstRequestInputTokens`, `firstRequestCachedInputTokens`, `firstRequestCacheWriteTokens`, `firstRequestCost`, `firstRequestEndMs`, `toolCalls`, `toolErrors`, `toolResultSizes` (per-tool counts and sum/max text bytes only; no content or arguments), `taskMemoryLookups`, `taskMemoryHits`, `durableKnowledgeLookups`, `durableKnowledgeHits`, `systemPromptChars`, `toolSchemaChars`, `filesChanged` (deduped target paths from `edit`/`write` only — never contents or bash args), `status` (`completed | failed | aborted`). First-request fields are absent if no assistant response completed; older records lack these fields.

The result includes Pi-native nested `usage` and a compact `details.results` record so the separately installed `@pureooze/pi-telemetry` extension classifies `delegate` operations and counts worker costs alongside Sol usage. Caveats: the model reports token usage; `outputTokens` is not an enforced cap. lookups count attempts while hits count nonempty results (older telemetry counted attempts as hits); `filesChanged` counts attempted edit/write targets (bash side effects are not detected). Summarize worker metadata with `node scripts/delegate-report.mjs` and paired-operation costs with `node scripts/telemetry-report.mjs`. The worker report separates first-request and subsequent-request cache shares for **new completed records only**, grouped by model and mode; it also reports average first-request end time and job cost/duration. Cache share is `cacheRead / (input + cacheRead + cacheWrite)`. It is not proof of reuse *between* workers: provider caches can be warmed by other calls. The report also ranks per-tool text-result byte totals for new records; image payloads are excluded and bytes are not token counts. Compare matched task quality, cost, and latency before changing prompts or tools. Telemetry writes are best-effort and never fail the task.

## Limits & cost

- Cached input tokens may still be billed by the provider (typically at a discount); the extension does not strip cache reads.
- There is **no guaranteed output token cap** — `maxOutputTokens` only shapes the prompt instruction and a soft character cap (`maxOutputTokens * 4` chars) on returned text.
- `delegate` is registered with Pi's sequential execution mode: no implicit parallel workers or worker swarms. Independent parallel requests were benchmarked but are not enabled in the Pi tool.
- Cached-token costs still apply. Accumulated worker tool history can grow across turns within a single call, even though each invocation starts fresh.
- Worker is short-lived per call. Savings depend on how much primary-model work is avoided; no Sol token reduction has yet been measured.

## Sample chain

Parent (architect) decides the design and writes the brief; workers do the work.

```text
[parent session]
  delegate(explore)   → "Map the auth flow in src/auth; list call sites and tests"
                        worker tools: read, find, grep
                        + knowledge_search / knowledge_get
  delegate(implement) → "Add retry-with-backoff to submit(); see src/auth/flow.ts"
                        files: ["src/auth/flow.ts", "src/auth/flow.test.ts"]
                        worker tools: read, find, grep, edit, write, bash
  delegate(test)      → "Run the test suite for the new retry path and report failures"
                        worker tools: read, grep, bash
  delegate(fix)       → "Fix flake in flow.test.ts: race between abort and drain"
                        worker tools: read, grep, edit, bash
```

Siblings spawned from the same parent task share the same hashed task-memory file, so an early `explore` worker can `task_memory_write` a finding the `implement` worker `task_memory_search`-es.

### UI design-brief workflow

Use the parent session to own look-and-feel decisions; delegate only bounded implementation steps. For example, Sol's brief might specify: *"Keep the primary CTA visually dominant, use existing button/type tokens, show loading/error/empty states, stack the secondary panel below content on mobile, and retain keyboard navigation. Do not choose a new color palette or change the information hierarchy."*

1. Parent: write a design brief (layout, copy, color/typography tokens, states, a11y notes, reference screenshots) and any non-negotiable UX rules.
2. `delegate(explore)` — worker inventories existing components, tokens, and the target route, returning file lists and constraints.
3. `delegate(implement)` — worker edits/creates components against the brief, with `files` pointing at the relevant module and `constraints` restating non-negotiables (e.g. "must use existing Button", "no new design tokens").
4. Parent reviews the worker's `filesChanged` and patches anything the worker couldn't decide (visual judgment, microcopy).
5. `delegate(test)` — worker runs interaction/visual-regression tests; parent inspects screenshots, not raw output. Delegate new test creation to `implement`. Use the target project's existing browser/Playwright scripts when available; this package does not install a browser framework.

Architecture, product, and visual judgment remain with the parent. Workers that hit ambiguity must report it back rather than decide.

## Measurements and next steps

Local observations (not guarantees): cold extension import ~88 ms; bare factory registration <0.001 ms; one simple direct M3 test delegation ~3.4 s with first response ~0.7 s. macOS shell sandbox fixtures added ~8–15 ms per command. A local one-entry task-memory microbenchmark averaged ~0.38 ms/write and ~0.035 ms/search over 1,000 operations (not a multi-worker benchmark). Worker tool schemas measured 2.3–3.7 k characters by mode. Cached input can greatly exceed fresh input across multi-turn worker calls.

Three *matched, read-only* repo questions (same cwd, `openai-codex/gpt-5.6-sol` primary, forced direct tools vs forced `minimax/MiniMax-M3` delegate) were manually reviewed: both variants passed all 3, with no corrections or redo. Totals: direct Sol 55,551 tokens vs delegated Sol 6,684 (~88% reduction); delegated workers added 39,913 tokens. Mean cost saved was ~$0.028 per task, **but delegation added ~5.2 seconds per task**. These tiny exploration questions do not establish a general token-saving or quality target, nor do they test UI implementation. A separate two-job read-only direct-harness parallel trial took 2.60 s versus 2.89 s sequential but cost ~49% more; this does not justify enabling Pi tool-level parallelism.

For new A/B comparisons, assign each equivalent task a `PI_TELEMETRY_EXPERIMENT` and `PI_TELEMETRY_PAIR`, and set `PI_TELEMETRY_VARIANT=direct` or `delegated` in separate Pi processes. Use the **same primary model and cwd** and label independent, comparable prompts. Run `node scripts/delegate-evaluate.mjs --experiment NAME` to report *paired* Sol tokens avoided, worker tokens introduced, cost, and duration. Optionally pass `--quality /path/to/quality.json` with manually judged outcomes:

```json
{
  "pair-1": {
    "direct": { "accepted": true },
    "delegated": { "accepted": true, "redoCount": 0, "solCorrectionCount": 0 }
  }
}
```

Quality remains unscored unless explicitly supplied; malformed, unpaired, mismatched-model/cwd, and non-delegated comparisons are excluded. Full operation metadata remains in Pi's existing telemetry store and can be viewed with `node scripts/telemetry-report.mjs`. Avoid claims of savings from unpaired or unreviewed runs. Next optimization candidates: measure tool-schema/context growth and provider variance on larger repo/UI tasks, then selectively reduce tools or stored notes where evidence supports it. Do not add an LLM router, automatic parallelism, or a browser framework without a measured need.

## Safety summary

- No destructive, publishing, or remote commands without consent (prompt policy, not enforcement). Mac worker shell commands have targeted OS path restrictions, not general process/network isolation.
- On non-macOS systems shell commands fail closed; use a fully isolated environment or add a tested OS sandbox backend before enabling them.
- Knowledge and task-memory tools are read or short-lived-write only.
- Worker output is truncated to a hard character cap before being returned to the parent.

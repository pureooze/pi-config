# Pi config

Git-managed Pi customizations.

## Extensions

- [`ask-user.ts`](extensions/ask-user.ts) provides the interactive `ask_user` tool.
- [`subagents`](extensions/subagents) provides the model-agnostic `delegate_to_subagent` tool. It dynamically discovers agent profiles from `~/.pi/agent/agents`; those profiles choose their own providers, models, prompts, and tools and are not part of this package. For non-trivial tasks, the tool guidance asks the main agent to delegate suitable bounded work by default after choosing an approach. Running agents refresh their tool row every five seconds with status, elapsed time, last activity, and PID; one minute without process output is marked as possibly stalled.
- [`telemetry`](extensions/telemetry) records operation, turn, model, token, cost, and subagent metrics described below.
- [`todo-session.ts`](extensions/todo-session.ts) records Pi session metadata in the nearest `TODO.md`.

Pi loads this checkout directly as a local package, so edits here take effect after `/reload` (or after restarting Pi).

## Telemetry

Telemetry is appended as one JSON object per settled outer operation to:

```text
~/.pi/agent/telemetry/operations.jsonl
```

Set `PI_TELEMETRY_PATH` to use another path. Each record includes outer turn durations and usage grouped by actual provider/model, delegation duration, sanitized child profile/model/timing/usage, and combined outer-plus-subagent totals. Operations are automatically classified as `direct` or `subagent`.

Telemetry does **not** store prompts, responses, tool arguments or results, delegated task text, stderr, or error text. It does store the session ID and working directory so local results can be grouped by session or project.

For controlled comparisons, label Pi processes with an experiment and optional variant:

```bash
PI_TELEMETRY_EXPERIMENT=auth-refactor PI_TELEMETRY_VARIANT=direct pi
PI_TELEMETRY_EXPERIMENT=auth-refactor PI_TELEMETRY_VARIANT=subagent-model-a pi
```

The automatic `direct`/`subagent` classification is recorded independently of the manual variant. Every operation also records its Pi session ID.

Inside Pi, use `/telemetry-status` for the path/count, `/telemetry-report` for a compact comparison, or filter to one session with `/telemetry-report <session-id>`. For the full report:

```bash
node scripts/telemetry-report.mjs
# Filter one Pi session:
node scripts/telemetry-report.mjs --session <session-id>
# Or report another file, optionally filtered:
node scripts/telemetry-report.mjs /path/to/operations.jsonl --session <session-id>
```

To configure this checkout on another machine:

```bash
pi install /absolute/path/to/pi-config
```

Pi records the local path in `~/.pi/agent/settings.json`; it does not copy the package.

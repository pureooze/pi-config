# @pureooze/pi-telemetry

Records local Pi operation timing and usage metrics for comparisons and reporting.

## Install

```bash
pi install npm:@pureooze/pi-telemetry
```

Telemetry is written locally to `~/.pi/agent/telemetry/operations.jsonl`, or to `PI_TELEMETRY_PATH` when configured. Records include operation status, duration, Pi session ID, working directory, provider/model, token counts, costs, and delegated-agent metadata.

It does **not** record prompts, responses, tool arguments or results, delegated task text, stderr, or error text. The extension does not make network requests. Review the source and local retention requirements before enabling it.

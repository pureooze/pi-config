# Pi config

Git-managed Pi customizations.

## Extensions

- [`ask-user.ts`](extensions/ask-user.ts) provides the interactive `ask_user` tool.
- [`telemetry`](extensions/telemetry) records operation, turn, model, token, and cost metrics described below.
- [`todo-session.ts`](extensions/todo-session.ts) records the last useful Pi session in the nearest project `TODO.md`.
- [`scripts/pi-auto-resume`](scripts/pi-auto-resume) is the launcher used by `pi` to resume that recorded session, including when started from a project subdirectory.

Pi loads this checkout directly as a local package, so edits here take effect after `/reload` (or after restarting Pi).

## Companion Pi packages

These extensions are installed as separate npm Pi packages rather than vendored in this repository:

- [`pi-mcp-adapter`](https://www.npmjs.com/package/pi-mcp-adapter) adds lazy, on-demand access to configured MCP servers.
- [`pi-system-reminders`](https://www.npmjs.com/package/pi-system-reminders) discovers reactive reminders from `~/.pi/agent/reminders/` and `.pi/reminders/`.

Install them globally for Pi:

```bash
pi install npm:pi-mcp-adapter
pi install npm:pi-system-reminders
```

Restart Pi after installation. Use `/mcp setup` to configure MCP sources; see each package's linked documentation for its full setup and security considerations.

## Telemetry

Telemetry is appended as one JSON object per settled outer operation to:

```text
~/.pi/agent/telemetry/operations.jsonl
```

Set `PI_TELEMETRY_PATH` to use another path. Each record includes operation and outer-turn durations plus usage grouped by actual provider/model.

Telemetry does **not** store prompts, responses, tool arguments or results, delegated task text, stderr, or error text. It does store the session ID and working directory so local results can be grouped by session or project.

For controlled comparisons, label Pi processes with an experiment and optional variant:

```bash
PI_TELEMETRY_EXPERIMENT=auth-refactor PI_TELEMETRY_VARIANT=baseline pi
```

Every operation also records its Pi session ID.

Inside Pi, use `/telemetry-status` for the path/count, `/telemetry-report` for a compact comparison, or filter to one session with `/telemetry-report <session-id>`. For the full report:

```bash
node scripts/telemetry-report.mjs
# Filter one Pi session:
node scripts/telemetry-report.mjs --session <session-id>
# Or report another file, optionally filtered:
node scripts/telemetry-report.mjs /path/to/operations.jsonl --session <session-id>
```

To configure this checkout on another machine, clone it and install the local package plus its companion packages:

```bash
pi install /absolute/path/to/pi-config
pi install npm:pi-mcp-adapter
pi install npm:pi-system-reminders
```

Pi records the local checkout path in `~/.pi/agent/settings.json`; it does not copy the package.

## Automatic session resume

Install the launcher after cloning this repository:

```bash
install -m 755 scripts/pi-auto-resume ~/.local/bin/pi
```

With a nearby `TODO.md`, bare `pi` resumes its recorded non-empty session. If that
session is unavailable, it selects the newest usable session for the project.
Explicit session flags and Pi management commands pass through unchanged. Set
`PI_TODO_NEW_SESSION=1 pi` (or `PI_AUTO_RESUME=0 pi`) to start fresh once.

The launcher is a wrapper around the real Pi executable; it does not replace Pi
itself.

## Development

This repository uses npm `11.11.0` with the committed `package-lock.json`.

```bash
npm ci
npm run test:all
```

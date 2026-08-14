# Pi extensions

This repository is an npm workspace containing independently publishable Pi packages. The workspace root is development-only; install the packages you want instead of installing the repository root.

## Packages

| Package | Purpose | Install |
| --- | --- | --- |
| [`@pureooze/pi-ask-user`](packages/ask-user) | Interactive `ask_user` tool | `pi install npm:@pureooze/pi-ask-user` |
| [`@pureooze/pi-telemetry`](packages/telemetry) | Local operation and usage metrics | `pi install npm:@pureooze/pi-telemetry` |
| [`@pureooze/pi-todo-session`](packages/todo-session) | Saves the latest useful session in `TODO.md` | `pi install npm:@pureooze/pi-todo-session` |
| [`@pureooze/pi-knowledge-graph`](packages/knowledge-graph) | Local shared knowledge search and maintenance | `pi install npm:@pureooze/pi-knowledge-graph` |

Each package README documents its behavior and data handling. Pi packages execute with the permissions of the Pi process; review an extension before installing it.

## Local development

```bash
npm ci
npm run test:all
```

Test an individual extension without installing it permanently:

```bash
pi --no-extensions -e ./packages/ask-user/index.ts
pi --no-extensions -e ./packages/telemetry/index.ts
pi --no-extensions -e ./packages/todo-session/index.ts
pi --no-extensions -e ./packages/knowledge-graph/index.ts
```

Install a local package for a project-scoped trial:

```bash
pi install ./packages/ask-user -l
```

The root workspace also contains the knowledge-graph test fixtures, validation scripts, and design documentation. Those files are not included in any package tarball.

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

## Automatic session resume

Install the launcher after cloning this repository:

```bash
install -m 755 scripts/pi-auto-resume ~/.local/bin/pi
```

With a nearby `TODO.md`, bare `pi` resumes its recorded non-empty session. If that session is unavailable, it selects the newest usable session for the project. Explicit session flags and Pi management commands pass through unchanged. Set `PI_TODO_NEW_SESSION=1 pi` (or `PI_AUTO_RESUME=0 pi`) to start fresh once.

The launcher is a wrapper around the real Pi executable; it does not replace Pi itself.

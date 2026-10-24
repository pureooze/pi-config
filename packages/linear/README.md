# @pureooze/pi-linear

Fast, minimal Linear extension for Pi. Read-only by default; writes require explicit user confirmation. No new runtime dependencies — built on Node's `http`, `net`, `crypto`, and `fetch`.

## Tools

| Tool | Kind | Description |
| --- | --- | --- |
| `linear_viewer` | read | Show workspace, current user, and teams. |
| `linear_search_issues` | read | Search issues by free-text, optionally scoped to a team. |
| `linear_get_issue` | read | Fetch one issue by UUID or identifier, with description, project, and recent comments. |
| `linear_search_projects` | read | List or search projects by name, with state, progress, teams, and target date. |
| `linear_get_project` | read | Fetch one project with its description, state, progress, teams, and dates. |
| `linear_create_issue` | write (confirm-gated) | Create a Linear issue. |
| `linear_update_issue` | write (confirm-gated) | Update an existing issue (state, assignee, priority, title, description, project). |
| `linear_create_project` | write (confirm-gated) | Create a project for one or more teams. |
| `linear_update_project` | write (confirm-gated) | Update an existing project (name, description, target date). |
| `linear_create_comment` | write (confirm-gated) | Add a comment to an issue. |

## Commands

- `/linear-login` — start the OAuth dance. Uses the client ID from `LINEAR_OAUTH_CLIENT_ID`, else the ID stored on the first login (`~/.pi/agent/linear/config.json`), else prompts for it once. `LINEAR_OAUTH_CLIENT_SECRET` is optional (public-PKCE clients need no secret).
- `/linear-logout` — delete the stored token.

## Setup

1. Register a Linear OAuth app at <https://linear.app/settings/api/applications>. Add the following to your OAuth app:
   - OAuth 2.0 redirect URI: `http://localhost:3000/oauth/callback` (fixed; register it exactly).
   - Scopes: `read`, `write`, `issues:create`.
2. Set the credentials in your shell or `.env` (needed only for the first login):
   ```sh
   export LINEAR_OAUTH_CLIENT_ID="your-client-id"
   # Public-PKCE clients do not need a secret; confidential clients should set:
   # export LINEAR_OAUTH_CLIENT_SECRET="your-client-secret"
   ```
3. Install and load:
   ```sh
   pi install ./packages/linear
   pi --extension ./packages/linear/index.ts   # local development
   ```
4. Run `/linear-login`. The extension opens your browser to Linear, captures the redirect on a loopback-only HTTP server bound to `127.0.0.1:3000` at the fixed path `/oauth/callback`, exchanges the code with PKCE, and stores the tokens at `~/.pi/agent/linear/auth.json` (mode `0o600`). The client ID (non-secret) is saved once to `~/.pi/agent/linear/config.json` (mode `0o600`, directory `0o700`) so later logins need no env var. Port 3000 must be free during login. The token is never echoed to the model transcript.

## Performance

The factory body stays small: OAuth and GraphQL code is dynamically imported inside each tool `execute()`. The first three cold loads register in well under a millisecond after warm-up. Network calls go to a single endpoint, with token refresh coalesced across concurrent calls and one transparent retry on `401`.

## Safety

- Tokens live only in `~/.pi/agent/linear/auth.json` with `0o600` mode and are never written elsewhere.
- The only other persisted credential is the non-secret client ID in `~/.pi/agent/linear/config.json` (`0o600` file, `0o700` dir); no client secret is persisted there.
- `oauth.sanitize()` strips `Bearer …`, `lin_api_*`, `Authorization:` headers, and `access_token`/`refresh_token` JSON fields from any text the extension surfaces.
- Writes require `ctx.ui.confirm()` **before any network call**; a declined write returns immediately without issuing a request. Confirmations are ignored in non-interactive modes; the tool returns without mutating.
- No raw GraphQL passthrough, no webhook administration, no admin actions.
- No delete, archive, or trash operations are exposed.
- No new runtime dependencies.

## Limit & cost

A single Linear API call per tool invocation. Descriptions and comments are clamped (4,000 and 1,000 characters respectively, with an explicit truncation marker) and list results are capped by schema limits (25). Errors are surfaced verbatim; we do not retry non-401 failures.

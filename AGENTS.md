# Global development preferences

Apply these defaults when working on TypeScript, React, Vercel, or Supabase repositories. Project instructions and established repository conventions take precedence.

## Start by understanding the repository

- Read the nearest `AGENTS.md` or `CLAUDE.md`, `package.json`, lockfile, TypeScript config, framework config, README, and relevant tests before changing code.
- Detect the framework and package manager from repository files. Use the existing package manager and scripts; do not replace the lockfile or introduce another package manager.
- Search for existing components, utilities, schemas, and patterns before creating new abstractions.
- Keep changes focused. Avoid unrelated refactors, generated-file churn, and dependency additions unless they are necessary and justified.

## Implementation workflow

- For non-trivial work, state a short plan, then inspect, implement, and validate rather than stopping after analysis.
- Preserve behavior unless the task explicitly changes it. Fix root causes rather than masking errors.
- Use available project scripts for formatting, linting, type-checking, tests, and builds. Run the narrowest relevant checks while iterating, then the broader applicable checks before finishing.
- Do not suppress failing checks, weaken compiler/linter settings, or remove tests merely to make validation pass.
- Report changed files, validation commands and results, and any unverified assumptions or follow-up work.

## Subagents

- Use `delegate_to_subagent` by default for non-trivial work.
- Delegate scouting and deterministic checks (search, lint, types, build, tests, diff) to suitable subagents.
- Give bounded scope and acceptance criteria; never run parallel mutating agents in one checkout.
- Main agent owns decisions, inspects delegated work, and reports `Delegation:`; skip only for trivial work or no useful isolation.

## TypeScript

- Preserve strict typing. Prefer inference plus explicit public-boundary types; avoid `any`, unsafe casts, non-null assertions, and broad index signatures.
- Treat external data as `unknown` and validate it at runtime. Model domain states with discriminated unions where useful.
- Keep types close to their domain and reuse generated API/database types. Do not hand-edit generated files.
- Handle errors deliberately and keep async behavior, nullability, and server/client boundaries explicit.

## React

- Follow the repository's framework, router, rendering model, state management, styling system, and component conventions.
- Prefer small composable components, semantic HTML, accessible labels, keyboard support, and clear loading, empty, error, and success states.
- Keep state minimal and derived during render when possible. Use effects only for synchronization with external systems, with correct dependencies and cleanup.
- Do not prematurely memoize. Measure before adding performance complexity.
- Keep browser-only code and secrets out of server modules, and server-only code and privileged credentials out of client bundles.

## Vercel

- Respect the detected runtime and framework conventions. Check Node versus Edge compatibility before using platform APIs or dependencies.
- Keep environment-specific values in environment variables and document required names in `.env.example` without secret values.
- Do not run production deployments, link or relink projects, change production environment variables, or alter domains without explicit confirmation.
- Before deployment-related work, validate the production build locally and call out assumptions about Vercel configuration, regions, caching, rewrites, and function limits.

## Supabase

- Treat schema changes as versioned migrations. Prefer additive, reversible changes and preserve existing migration history.
- Enable and verify Row Level Security for exposed tables. Write explicit policies for intended roles and test both allowed and denied access paths.
- Never expose the service-role key or database credentials to client code. The public URL and anon/publishable key may be client-visible only when RLS and policies make that safe.
- Keep generated database types synchronized after schema changes when project tooling supports it.
- Do not apply remote migrations, reset databases, modify production data, rotate credentials, or link a Supabase project without explicit confirmation. Clearly distinguish local from remote commands.
- When Supabase MCP OAuth or re-authentication is required, always print the complete clickable authorization URL directly in the assistant response. Tell the user to approve it and paste back the full redirected localhost callback URL, noting that the localhost page may fail to load. Do not assume the URL shown only inside tool output is sufficient.

## Security and operations

- Never print, commit, or copy secrets into source, examples, logs, prompts, or shell history. Inspect `.env` files only when necessary and do not echo their values.
- Validate authorization and input at server boundaries; do not rely on hidden UI controls for security.
- Ask before destructive actions or actions that publish, deploy, transmit repository data, or change remote infrastructure.
- Prefer local and read-only diagnostics first. Use official, version-matched documentation when platform behavior is uncertain.

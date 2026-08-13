# ADR-003: Scope isolation and canonical project identity

**Status:** superseded by [ADR-009: Shared knowledge scope](knowledge-graph-adr-009-shared-knowledge-scope.md)

> Historical design record. Its project-visibility decision no longer applies to runtime knowledge access.

**Date:** 2026-08-06

**Decision task:** KGM-1.3

## Context

Pi supplies the extension’s current working directory through `ExtensionContext.cwd` and reports whether project-local trust is active through `ExtensionContext.isProjectTrusted()`. Pi sessions can start from project subdirectories, symlinked paths, Git worktrees, non-Git directories, and different clones of the same remote repository.

The graph must not silently merge unrelated projects or expose one project’s knowledge to another. It also must not use a remote URL as an identity: remote URLs can be absent, mutable, shared by multiple clones, or require network access.

## Decision

Use two durable visibility classes:

- `global`: user knowledge intentionally available across projects.
- `project:<sha256>`: accepted knowledge for one canonical project identity.

Pending proposals retain one of those target scopes as a separate status and are never searchable as accepted knowledge. The SQLite database remains shared, but every repository operation receives an explicit resolved scope. Scope filtering occurs before exact-ID lookup, FTS ranking, entity resolution, or graph traversal.

### Git project identity

For a real Git work tree, resolve the following using bounded, argument-based Git commands from a canonicalized `ctx.cwd`:

1. `git rev-parse --show-toplevel` identifies the current worktree root.
2. `git rev-parse --git-common-dir` identifies the shared Git administrative directory.
3. Resolve relative command output against the canonical working directory and apply `realpath`.
4. Set the project identity path to the canonical Git common directory.
5. Set the scope key to:

```text
project:sha256("git-common-dir\0" + identityPath)
```

Store the canonical project root and identity path as diagnostic metadata, but use the prefixed hash as the stable scope identifier. The resolver must not invoke a shell or contact a remote.

Using the Git common directory makes linked worktrees share one project scope while keeping separate clones separate. The current worktree root remains available for display and diagnostics.

### Non-Git identity

If the current directory is not inside a Git work tree, use the canonical current directory itself:

```text
project:sha256("directory\0" + realpath(ctx.cwd))
```

A non-Git directory and each of its subdirectories are separate scopes because there is no reliable repository boundary. If the current directory cannot be canonicalized, project-scoped operations fail closed with a scope-resolution error; they never fall back to global visibility.

## Required behavior

| Situation | Result |
|---|---|
| Git repository subdirectory | Same scope as the repository’s worktree |
| Symlink to a Git repository | Same scope after canonicalization |
| Linked Git worktree | Same scope through `git-common-dir` |
| Separate clone, even with the same remote | Separate scope |
| Repository moved to a new path | New scope; no automatic merge |
| Nested Git repository | Closest repository selected by Git |
| Non-Git directory | Canonical-directory scope |
| Git unavailable or `rev-parse` fails | Canonical-directory fallback, with a diagnostic reason |
| Unresolvable current directory | No project reads/writes; explicit global only if separately requested |

Repository moves and clone merging require a future explicit export/import or identity-migration workflow. The MVP must never guess that two paths represent the same project.

## Visibility defaults and global access

- Search, get, proposal, review, export, forget, and purge default to the current project scope.
- Global data is included only when the operation explicitly requests it, such as `includeGlobal: true` or `scope: "global"`.
- Project configuration cannot enable global visibility by default. The user or an explicit operation must request it.
- A proposal defaults to the current project scope. A global proposal requires an explicit global target and the review/confirmation flow.
- Exact IDs and neighbor traversal are still restricted to the operation’s resolved visibility set; possessing an ID does not bypass scope.
- Scope names, counts, and diagnostics must not expose claim or evidence content from an excluded scope.

## Project-local configuration and Pi trust

The extension does not override Pi’s project-trust decision. After `session_start`, it may inspect `ctx.isProjectTrusted()`:

- Trusted projects may provide a validated `.pi/knowledge-graph.json` for safe, non-security-sensitive preferences defined by the later configuration ADR.
- Untrusted projects’ local knowledge-graph configuration is ignored and defaults are used.
- Project-local configuration may not change the database path, canonical identity algorithm, scope key, or per-operation requirement for explicit global access.
- Non-interactive modes use Pi’s resolved trust state and never wait for a trust prompt.

Project trust is an input-loading guard, not an authorization replacement. Repository code and retrieved knowledge remain untrusted data.

## Verification evidence

Pi’s installed v0.84.0 type declarations expose `ExtensionContext.cwd`, `ExtensionContext.isProjectTrusted()`, and the `project_trust` lifecycle event. The relevant documented behavior is in Pi’s Extensions, Usage, Settings, and Security documentation, summarized in [knowledge-graph-research.md](knowledge-graph-research.md).

The reproducible probe is [`scripts/knowledge-graph-project-identity-spike.mjs`](../scripts/knowledge-graph-project-identity-spike.mjs). It creates and removes temporary Git fixtures without changing this repository.

```text
$ node scripts/knowledge-graph-project-identity-spike.mjs
status: pass
repositorySubdirectory: git=true
symlinkedRepository: same project root/common directory
a linked worktree: same common directory as the main repository
nonGitDirectory: git=false
```

Observed Git behavior was consistent with the algorithm above. The resolver implementation and automated fixtures are part of KGM-2.3/KGM-4.1.

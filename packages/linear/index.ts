import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Pi extension: minimal, fast Linear integration.
 *
 * Design goals (parent-fixed):
 * - No new runtime dependencies; built-in node:http, node:net, node:crypto, fetch.
 * - Single GraphQL endpoint https://api.linear.app/graphql, Bearer auth.
 * - OAuth uses authorization_code + PKCE on a fixed loopback redirect (port 3000).
 * - Tokens persist only to ~/.pi/agent/linear/auth.json (mode 0o600); the
 *   non-secret client ID persists to ~/.pi/agent/linear/config.json.
 * - Lazy: heavy OAuth/GraphQL code is dynamically imported inside tool
 *   execute()s. The factory body must stay cheap (we measure below).
 * - Concurrent refreshes coalesce into a single round-trip.
 * - Writes require ctx.ui.confirm(); confirmation happens before any network
 *   call, so a declined write never touches the API.
 * - Errors sanitized: bearer tokens, lin_api_*, Authorization headers, and
 *   access_token/refresh_token JSON fields are stripped from surfaced text.
 * - Tool output is bounded: long descriptions/comments are clamped before they
 *   reach the model, and list results are capped by schema limits.
 */
export default function linearExtension(pi: ExtensionAPI): void {
  pi.registerCommand("linear-login", {
    description: "Sign in to Linear (opens browser, captures token, never logs it).",
    handler: async (_args, ctx) => {
      const { authorizeInteractive, readConfig, writeAuth, writeConfig } = await import("./oauth.ts");
      const clientSecret = process.env.LINEAR_OAUTH_CLIENT_SECRET;
      // Precedence: env, then the one-time stored config, then an interactive prompt.
      let clientId = process.env.LINEAR_OAUTH_CLIENT_ID || readConfig()?.clientId;
      if (!clientId) {
        const entered = await ctx.ui.input("Linear OAuth client ID:", "");
        clientId = entered?.trim() || undefined;
      }
      if (!clientId) {
        ctx.ui.notify("No Linear client ID. Set LINEAR_OAUTH_CLIENT_ID or enter it when prompted.", "error");
        return;
      }
      writeConfig({ clientId });
      const auth = await authorizeInteractive({ clientId, ...(clientSecret ? { clientSecret } : {}) }, async (url) => {
        // Prefer the parent process opener when available; otherwise surface the URL.
        try {
          const opener = (await import("node:child_process")).exec;
          await new Promise<void>((resolve) => opener(`open "${url}"`, () => resolve()));
        } catch {
          ctx.ui.notify(`Open this URL to continue: ${url}`, "info");
        }
      });
      writeAuth(auth);
      ctx.ui.notify("Linear: signed in.", "info");
    },
  });

  pi.registerCommand("linear-logout", {
    description: "Forget the stored Linear token.",
    handler: async (_args, ctx) => {
      const { clearAuth } = await import("./oauth.ts");
      clearAuth();
      ctx.ui.notify("Linear: signed out.", "info");
    },
  });

  // Read tools — default active. Write tools — confirm-gated.
  for (const tool of readTools()) {
    pi.registerTool(tool);
  }
  for (const tool of writeTools()) {
    pi.registerTool(tool);
  }
}

// ---------------------------------------------------------------------------
// Parameter schemas (TypeBox, hoisted so the tool body stays compact).
// ---------------------------------------------------------------------------

const viewerParams = Type.Object({}, { additionalProperties: false });
const searchParams = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 200 }),
  teamId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
}, { additionalProperties: false });
const createParams = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200 }),
  teamId: Type.String({ minLength: 1, maxLength: 64 }),
  description: Type.Optional(Type.String({ maxLength: 20_000 })),
  priority: Type.Optional(Type.Union([
    Type.Literal("urgent"), Type.Literal("high"), Type.Literal("medium"), Type.Literal("low"), Type.Literal("noPriority"),
  ])),
}, { additionalProperties: false });
const updateParams = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  priority: Type.Optional(Type.Union([
    Type.Literal("urgent"), Type.Literal("high"), Type.Literal("medium"), Type.Literal("low"), Type.Literal("noPriority"),
  ])),
  stateId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  assigneeId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  description: Type.Optional(Type.String({ maxLength: 20_000 })),
  projectId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
}, { additionalProperties: false });
const getIssueParams = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  commentLimit: Type.Optional(Type.Integer({ minimum: 0, maximum: 25 })),
}, { additionalProperties: false });
const searchProjectsParams = Type.Object({
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
}, { additionalProperties: false });
const getProjectParams = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
}, { additionalProperties: false });
const createProjectParams = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  teamIds: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { minItems: 1, maxItems: 10 }),
  description: Type.Optional(Type.String({ maxLength: 20_000 })),
  targetDate: Type.Optional(Type.String({ minLength: 10, maxLength: 10 })),
}, { additionalProperties: false });
const updateProjectParams = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  description: Type.Optional(Type.String({ maxLength: 20_000 })),
  targetDate: Type.Optional(Type.String({ minLength: 10, maxLength: 10 })),
}, { additionalProperties: false });
const createCommentParams = Type.Object({
  issueId: Type.String({ minLength: 1, maxLength: 64 }),
  body: Type.String({ minLength: 1, maxLength: 20_000 }),
}, { additionalProperties: false });

// Output bounds. Keeps model context small regardless of how large the
// upstream description/comment bodies are.
const MAX_TEXT_CHARS = 4_000;
const MAX_COMMENT_CHARS = 1_000;
const DEFAULT_COMMENT_LIMIT = 5;

/** Clamp long upstream text, marking the truncation so the model knows. */
function clamp(text: string | null | undefined, max: number): string {
  if (!text) return "";
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n…[truncated ${trimmed.length - max} chars]`;
}

// ---------------------------------------------------------------------------
// Auth bootstrap helper used by every tool.
// ---------------------------------------------------------------------------

async function bootstrapClient() {
  const { LinearClient, configureClient } = await import("./client.ts");
  const { readAuth } = await import("./oauth.ts");
  const auth = readAuth();
  if (!auth) throw new Error("Linear: not signed in. Run /linear-login.");
  configureClient({ clientId: auth.client_id, ...(auth.client_secret ? { clientSecret: auth.client_secret } : {}) });
  return new LinearClient();
}

// ---------------------------------------------------------------------------
// Tool factories. Heavy imports stay inside execute() to keep factory cost low.
// ---------------------------------------------------------------------------

function readTools() {
  return [
    defineTool({
      name: "linear_viewer",
      label: "Linear Viewer",
      description: "Show current user, workspace, and teams (read-only).",
      parameters: viewerParams,
      async execute() {
        const client = await bootstrapClient();
        const data = await client.graphql<{
          viewer: { id: string; name: string; email: string };
          organization: { id: string; name: string; urlKey: string };
          teams: { nodes: Array<{ id: string; key: string; name: string }> };
        }>(`query Viewer {
          viewer { id name email }
          organization { id name urlKey }
          teams(first: 50) { nodes { id key name } }
        }`);
        const teams = data.teams.nodes.map((team) => `${team.key} ${team.name} (${team.id})`).join("\n");
        return {
          content: [{ type: "text", text: `Workspace: ${data.organization.name} (${data.organization.urlKey})\nViewer: ${data.viewer.name} <${data.viewer.email}> (${data.viewer.id})\nTeams:\n${teams}` }],
          details: { workspaceId: data.organization.id, viewerId: data.viewer.id, teamCount: data.teams.nodes.length },
        } as const;
      },
    }),
    defineTool({
      name: "linear_search_issues",
      label: "Linear Search Issues",
      description: "Search issues in the workspace by free-text query, optionally scoped to a team.",
      parameters: searchParams,
      async execute(_id: string, params: { query: string; teamId?: string; limit?: number }) {
        const client = await bootstrapClient();
        const limit = params.limit ?? 10;
        const filter: Record<string, unknown> = { title: { contains: params.query } };
        if (params.teamId) filter.team = { id: { eq: params.teamId } };
        const data = await client.graphql<{ issues: { nodes: Array<{ identifier: string; title: string; url: string; state: { name: string }; assignee: { name: string } | null; updatedAt: string }> } }>(`query SearchIssues($filter: IssueFilter!, $first: Int!) {
          issues(first: $first, filter: $filter, orderBy: updatedAt) {
            nodes { id identifier title url state { name type } assignee { name } updatedAt }
          }
        }`, { filter, first: limit });
        const issues = data.issues.nodes;
        if (issues.length === 0) {
          return { content: [{ type: "text", text: `No issues matched "${params.query}".` }], details: { count: 0 } } as const;
        }
        const rows = issues.map((issue) =>
          `${issue.identifier}  ${issue.title}  [${issue.state.name}]${issue.assignee ? `  @${issue.assignee.name}` : ""}\n  ${issue.url}\n  updated ${issue.updatedAt}`
        ).join("\n\n");
        return { content: [{ type: "text", text: rows }], details: { count: issues.length } } as const;
      },
    }),
    defineTool({
      name: "linear_get_issue",
      label: "Linear Get Issue",
      description: "Fetch one Linear issue by UUID or identifier, including description, project, and recent comments (read-only).",
      parameters: getIssueParams,
      async execute(_id: string, params: { id: string; commentLimit?: number }) {
        const client = await bootstrapClient();
        const commentLimit = params.commentLimit ?? DEFAULT_COMMENT_LIMIT;
        // Resolve UUID or human identifier (e.g. "ABC-12") in one round-trip.
        const data = await client.graphql<{
          issues: { nodes: Array<{
            id: string; identifier: string; title: string; url: string; description: string | null;
            state: { name: string; type: string };
            team: { key: string };
            assignee: { name: string } | null;
            project: { id: string; name: string; url: string } | null;
            updatedAt: string;
            comments: { nodes: Array<{ id: string; body: string; createdAt: string; user: { name: string } | null }> };
          }> };
        }>(`query GetIssue($filter: IssueFilter!, $commentLimit: Int!) {
          issues(first: 1, filter: $filter) {
            nodes {
              id identifier title url description updatedAt
              state { name type }
              team { key }
              assignee { name }
              project { id name url }
              comments(first: $commentLimit, orderBy: updatedAt) { nodes { id body createdAt user { name } } }
            }
          }
        }`, {
          filter: { or: [{ id: { eq: params.id } }, { identifier: { eq: params.id } }] },
          commentLimit,
        });
        const issue = data.issues.nodes[0];
        if (!issue) {
          const missing: { found: boolean; id?: string; identifier?: string; url?: string; projectId?: string | null; commentCount?: number } = { found: false };
          return { content: [{ type: "text", text: `No issue matched "${params.id}".` }], details: missing } as const;
        }
        const lines = [
          `${issue.identifier}  ${issue.title}  [${issue.state.name}]  team ${issue.team.key}`,
          `  ${issue.url}`,
          `  updated ${issue.updatedAt}${issue.assignee ? `  assignee ${issue.assignee.name}` : ""}`,
          `Project: ${issue.project ? `${issue.project.name} (${issue.project.url})` : "none"}`,
          "Description:",
          clamp(issue.description, MAX_TEXT_CHARS) || "(none)",
        ];
        const comments = issue.comments.nodes;
        lines.push(`Comments (${comments.length} most recent):`);
        if (comments.length === 0) lines.push("(none)");
        else for (const comment of comments) {
          const author = comment.user?.name ?? "unknown";
          lines.push(`- [${comment.createdAt}] ${author}: ${clamp(comment.body, MAX_COMMENT_CHARS)}`);
        }
        const details: { found: boolean; id?: string; identifier?: string; url?: string; projectId?: string | null; commentCount?: number } = {
          found: true,
          id: issue.id,
          identifier: issue.identifier,
          url: issue.url,
          projectId: issue.project?.id ?? null,
          commentCount: comments.length,
        };
        return { content: [{ type: "text", text: lines.join("\n") }], details } as const;
      },
    }),
    defineTool({
      name: "linear_search_projects",
      label: "Linear Search Projects",
      description: "List or search Linear projects by name, with state, progress, teams, and target date (read-only).",
      parameters: searchProjectsParams,
      async execute(_id: string, params: { query?: string; limit?: number }) {
        const client = await bootstrapClient();
        const limit = params.limit ?? 10;
        const filter = params.query ? { name: { contains: params.query } } : undefined;
        const data = await client.graphql<{
          projects: { nodes: Array<{
            id: string; name: string; url: string; targetDate: string | null;
            status: { name: string; type: string };
            progress: number;
            teams: { nodes: Array<{ key: string }> };
          }> };
        }>(`query SearchProjects($filter: ProjectFilter, $first: Int!) {
          projects(first: $first, filter: $filter) {
            nodes {
              id name url targetDate progress
              status { name type }
              teams { nodes { key } }
            }
          }
        }`, { first: limit, ...(filter ? { filter } : {}) });
        const projects = data.projects.nodes;
        if (projects.length === 0) {
          const what = params.query ? ` matching "${params.query}"` : "";
          return { content: [{ type: "text", text: `No projects${what}.` }], details: { count: 0 } } as const;
        }
        const rows = projects.map((project) => {
          const teams = project.teams.nodes.map((team) => team.key).join(",") || "no team";
          const target = project.targetDate ? `  target ${project.targetDate}` : "";
          return `${project.name}  [${project.status.name}]  ${Math.round(project.progress * 100)}%  ${teams}${target}\n  ${project.url}`;
        }).join("\n\n");
        return { content: [{ type: "text", text: rows }], details: { count: projects.length } } as const;
      },
    }),
    defineTool({
      name: "linear_get_project",
      label: "Linear Get Project",
      description: "Fetch one Linear project by ID with its description, state, progress, teams, and target date (read-only).",
      parameters: getProjectParams,
      async execute(_id: string, params: { id: string }) {
        const client = await bootstrapClient();
        const data = await client.graphql<{
          projects: { nodes: Array<{
            id: string; name: string; description: string | null; url: string; targetDate: string | null;
            startDate: string | null;
            status: { name: string; type: string };
            progress: number;
            teams: { nodes: Array<{ key: string; name: string }> };
            updatedAt: string;
          }> };
        }>(`query GetProject($filter: ProjectFilter!) {
          projects(first: 1, filter: $filter) {
            nodes {
              id name description url startDate targetDate progress updatedAt
              status { name type }
              teams { nodes { key name } }
            }
          }
        }`, { filter: { id: { eq: params.id } } });
        const project = data.projects.nodes[0];
        if (!project) {
          const missing: { found: boolean; id?: string; name?: string; url?: string; targetDate?: string | null } = { found: false };
          return { content: [{ type: "text", text: `No project matched "${params.id}".` }], details: missing } as const;
        }
        const lines = [
          `${project.name}  [${project.status.name}]  ${Math.round(project.progress * 100)}%`,
          `  ${project.url}`,
          `  teams: ${project.teams.nodes.map((team) => `${team.key} ${team.name}`).join(", ") || "none"}`,
          `  dates: ${project.startDate ?? "—"} → ${project.targetDate ?? "—"}`,
          `  updated ${project.updatedAt}`,
          "Description:",
          clamp(project.description, MAX_TEXT_CHARS) || "(none)",
        ];
        const details: { found: boolean; id?: string; name?: string; url?: string; targetDate?: string | null } = {
          found: true,
          id: project.id,
          name: project.name,
          url: project.url,
          targetDate: project.targetDate ?? null,
        };
        return { content: [{ type: "text", text: lines.join("\n") }], details } as const;
      },
    }),
  ];
}

function writeTools() {
  return [
    defineTool({
      name: "linear_create_issue",
      label: "Linear Create Issue",
      description: "Create a Linear issue. Requires user confirmation.",
      parameters: createParams,
      async execute(_id: string, params: { title: string; teamId: string; description?: string; priority?: string }, _signal, _onUpdate, ctx) {
        const lines = [
          "Create Linear issue:",
          `  Team:    ${params.teamId}`,
          `  Title:   ${params.title}`,
          params.priority ? `  Priority: ${params.priority}` : null,
          params.description ? `  Description: ${params.description.length} chars` : null,
        ].filter((line): line is string => Boolean(line)).join("\n");
        if (!(await ctx.ui.confirm("Linear: create issue", lines))) {
          return { content: [{ type: "text", text: "Declined; no issue was created." }], details: { canceled: true } } as const;
        }
        const client = await bootstrapClient();
        const input: Record<string, unknown> = { teamId: params.teamId, title: params.title };
        if (params.description) input.description = params.description;
        if (params.priority) input.priority = params.priority;
        const data = await client.graphql<{ issueCreate: { success: boolean; issue: { id: string; identifier: string; title: string; url: string } | null } }>(`mutation IssueCreate($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue { id identifier title url }
          }
        }`, { input });
        const result = data.issueCreate;
        if (!result.success || !result.issue) {
          return { content: [{ type: "text", text: "Linear rejected the create request." }], details: { canceled: false } } as const;
        }
        return { content: [{ type: "text", text: `Created ${result.issue.identifier} ${result.issue.title}\n${result.issue.url}` }],
          details: { id: result.issue.id, identifier: result.issue.identifier, url: result.issue.url } } as const;
      },
    }),
    defineTool({
      name: "linear_update_issue",
      label: "Linear Update Issue",
      description: "Update an existing Linear issue. Requires user confirmation.",
      parameters: updateParams,
      async execute(_id: string, params: { id: string; title?: string; priority?: string; stateId?: string; assigneeId?: string; description?: string; projectId?: string }, _signal, _onUpdate, ctx) {
        const lines = [
          "Update Linear issue:",
          `  Issue: ${params.id}`,
          params.title ? `  Title → ${params.title}` : null,
          params.priority ? `  Priority → ${params.priority}` : null,
          params.stateId ? `  State → ${params.stateId}` : null,
          params.assigneeId ? `  Assignee → ${params.assigneeId}` : null,
          params.projectId ? `  Project → ${params.projectId}` : null,
          params.description !== undefined ? `  Description → replaced (${params.description.length} chars)` : null,
        ].filter((line): line is string => Boolean(line)).join("\n");
        if (!(await ctx.ui.confirm("Linear: update issue", lines))) {
          return { content: [{ type: "text", text: "Declined; no issue was updated." }], details: { canceled: true } } as const;
        }
        const client = await bootstrapClient();
        const input: Record<string, unknown> = {};
        if (params.title !== undefined) input.title = params.title;
        if (params.priority !== undefined) input.priority = params.priority;
        if (params.stateId !== undefined) input.stateId = params.stateId;
        if (params.assigneeId !== undefined) input.assigneeId = params.assigneeId;
        if (params.projectId !== undefined) input.projectId = params.projectId;
        if (params.description !== undefined) input.description = params.description;
        const data = await client.graphql<{ issueUpdate: { success: boolean; issue: { id: string; identifier: string; title: string; url: string } | null } }>(`mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) {
            success
            issue { id identifier title url }
          }
        }`, { id: params.id, input });
        const result = data.issueUpdate;
        if (!result.success || !result.issue) {
          return { content: [{ type: "text", text: "Linear rejected the update." }], details: { canceled: false } } as const;
        }
        return { content: [{ type: "text", text: `Updated ${result.issue.identifier} ${result.issue.title}\n${result.issue.url}` }],
          details: { id: result.issue.id, identifier: result.issue.identifier, url: result.issue.url } } as const;
      },
    }),
    defineTool({
      name: "linear_create_project",
      label: "Linear Create Project",
      description: "Create a Linear project for one or more teams. Requires user confirmation.",
      parameters: createProjectParams,
      async execute(_id: string, params: { name: string; teamIds: string[]; description?: string; targetDate?: string }, _signal, _onUpdate, ctx) {
        const lines = [
          "Create Linear project:",
          `  Teams:       ${params.teamIds.join(", ")}`,
          `  Name:        ${params.name}`,
          params.targetDate ? `  Target date: ${params.targetDate}` : null,
          params.description ? `  Description: ${params.description.length} chars` : null,
        ].filter((line): line is string => Boolean(line)).join("\n");
        if (!(await ctx.ui.confirm("Linear: create project", lines))) {
          return { content: [{ type: "text", text: "Declined; no project was created." }], details: { canceled: true } } as const;
        }
        const client = await bootstrapClient();
        const input: Record<string, unknown> = { teamIds: params.teamIds, name: params.name };
        if (params.description !== undefined) input.description = params.description;
        if (params.targetDate !== undefined) input.targetDate = params.targetDate;
        const data = await client.graphql<{ projectCreate: { success: boolean; project: { id: string; name: string; url: string } | null } }>(`mutation ProjectCreate($input: ProjectCreateInput!) {
          projectCreate(input: $input) {
            success
            project { id name url }
          }
        }`, { input });
        const result = data.projectCreate;
        if (!result.success || !result.project) {
          return { content: [{ type: "text", text: "Linear rejected the project create request." }], details: { canceled: false } } as const;
        }
        return { content: [{ type: "text", text: `Created project ${result.project.name}\n${result.project.url}` }],
          details: { id: result.project.id, name: result.project.name, url: result.project.url } } as const;
      },
    }),
    defineTool({
      name: "linear_update_project",
      label: "Linear Update Project",
      description: "Update an existing Linear project (name, description, target date). Requires user confirmation.",
      parameters: updateProjectParams,
      async execute(_id: string, params: { id: string; name?: string; description?: string; targetDate?: string }, _signal, _onUpdate, ctx) {
        const lines = [
          "Update Linear project:",
          `  Project: ${params.id}`,
          params.name ? `  Name → ${params.name}` : null,
          params.targetDate !== undefined ? `  Target date → ${params.targetDate}` : null,
          params.description !== undefined ? `  Description → replaced (${params.description.length} chars)` : null,
        ].filter((line): line is string => Boolean(line)).join("\n");
        if (!(await ctx.ui.confirm("Linear: update project", lines))) {
          return { content: [{ type: "text", text: "Declined; no project was updated." }], details: { canceled: true } } as const;
        }
        const client = await bootstrapClient();
        const input: Record<string, unknown> = {};
        if (params.name !== undefined) input.name = params.name;
        if (params.description !== undefined) input.description = params.description;
        if (params.targetDate !== undefined) input.targetDate = params.targetDate;
        const data = await client.graphql<{ projectUpdate: { success: boolean; project: { id: string; name: string; url: string } | null } }>(`mutation ProjectUpdate($id: String!, $input: ProjectUpdateInput!) {
          projectUpdate(id: $id, input: $input) {
            success
            project { id name url }
          }
        }`, { id: params.id, input });
        const result = data.projectUpdate;
        if (!result.success || !result.project) {
          return { content: [{ type: "text", text: "Linear rejected the project update." }], details: { canceled: false } } as const;
        }
        return { content: [{ type: "text", text: `Updated project ${result.project.name}\n${result.project.url}` }],
          details: { id: result.project.id, name: result.project.name, url: result.project.url } } as const;
      },
    }),
    defineTool({
      name: "linear_create_comment",
      label: "Linear Create Comment",
      description: "Add a comment to a Linear issue. Requires user confirmation.",
      parameters: createCommentParams,
      async execute(_id: string, params: { issueId: string; body: string }, _signal, _onUpdate, ctx) {
        const lines = [
          "Comment on Linear issue:",
          `  Issue: ${params.issueId}`,
          `  Body:  ${clamp(params.body, 500)}`,
        ].join("\n");
        if (!(await ctx.ui.confirm("Linear: create comment", lines))) {
          return { content: [{ type: "text", text: "Declined; no comment was created." }], details: { canceled: true } } as const;
        }
        const client = await bootstrapClient();
        const data = await client.graphql<{ commentCreate: { success: boolean; comment: { id: string; url: string } | null } }>(`mutation CommentCreate($input: CommentCreateInput!) {
          commentCreate(input: $input) {
            success
            comment { id url }
          }
        }`, { input: { issueId: params.issueId, body: params.body } });
        const result = data.commentCreate;
        if (!result.success || !result.comment) {
          return { content: [{ type: "text", text: "Linear rejected the comment." }], details: { canceled: false } } as const;
        }
        return { content: [{ type: "text", text: `Comment added to ${params.issueId}\n${result.comment.url}` }],
          details: { id: result.comment.id, issueId: params.issueId, url: result.comment.url } } as const;
      },
    }),
  ];
}

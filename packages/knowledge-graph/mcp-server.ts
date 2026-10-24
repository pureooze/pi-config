import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { KnowledgeGraphDatabase } from "./database.ts";
import { resolveKnowledgeGraphConfig } from "./config.ts";
import { KnowledgeGraphRepositories } from "./repository.ts";
import {
  KnowledgeGraphRetrieval,
  serializeGetResponse,
  serializeSearchResponse,
} from "./retrieval.ts";
import { resolveKnowledgeScope } from "./scope.ts";

const cwd = process.env.PWD || process.cwd();
const project = resolveKnowledgeScope(cwd);
const config = resolveKnowledgeGraphConfig({
  cwd,
  projectRoot: project.projectRoot,
  projectTrusted: true,
});
const database = new KnowledgeGraphDatabase({ paths: config });
const connection = database.open();
const repositories = new KnowledgeGraphRepositories(connection);
repositories.registerScope({ scopeId: "global", kind: "global" });
const retrieval = new KnowledgeGraphRetrieval(connection, repositories);

const server = new McpServer({
  name: "pi-knowledge-graph",
  version: "0.1.0",
});

const result = (text: string) => ({
  content: [{ type: "text" as const, text }],
});

const registerTool = (server as any).tool.bind(server) as (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<any>,
) => unknown;

registerTool(
  "knowledge_search",
  "Search the shared Pi knowledge graph for evidence-backed project facts, decisions, preferences, and relationships. Search before inspecting files when the question concerns existing project knowledge.",
  {
    query: z.string().min(1).max(512),
    limit: z.number().int().min(1).max(20).optional(),
    includeHistory: z.boolean().optional(),
    asOf: z.string().min(1).max(64).optional(),
  },
  async ({ query, limit, includeHistory, asOf }) => {
    try {
      const response = retrieval.search("global", {
        query,
        limit,
        includeHistory,
        asOf,
      });
      return result(serializeSearchResponse(response));
    } catch (error) {
      return {
        ...result(error instanceof Error ? error.message : "Knowledge search failed."),
        isError: true,
      };
    }
  },
);

registerTool(
  "knowledge_get",
  "Inspect a cited Pi knowledge-graph record by stable ID. Use this for evidence, history, neighbors, or exact record details.",
  {
    id: z.string().min(4).max(64),
    view: z.enum(["summary", "history", "neighbors", "evidence"]).optional(),
    limit: z.number().int().min(1).max(20).optional(),
    direction: z.enum(["incoming", "outgoing", "both"]).optional(),
    asOf: z.string().min(1).max(64).optional(),
  },
  async ({ id, view, limit, direction, asOf }) => {
    try {
      const response = retrieval.get("global", {
        id,
        view,
        limit,
        direction,
        asOf,
      });
      return result(serializeGetResponse(response));
    } catch (error) {
      return {
        ...result(error instanceof Error ? error.message : "Knowledge lookup failed."),
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

const shutdown = () => {
  database.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

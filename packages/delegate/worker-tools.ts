import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TaskMemoryStore } from "./task-memory.ts";

const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: undefined });

// The worker's tool registry is built here, NOT copied from the parent. No durable
// maintenance operation, extension loader, generic memory namespace, or delegate tool.
export function workerTools(memory: TaskMemoryStore, cwd: string, trusted: boolean): { tools: ToolDefinition[]; close: () => void } {
  let graph: import("@pureooze/pi-knowledge-graph/session.ts").KnowledgeGraphSessionRuntime | undefined;
  const knowledge = async () => {
    if (!graph) {
      const { KnowledgeGraphSessionRuntime } = await import("@pureooze/pi-knowledge-graph/session.ts");
      graph = new KnowledgeGraphSessionRuntime();
      graph.start({ cwd, isProjectTrusted: () => trusted });
    }
    return graph.ensure({ cwd, isProjectTrusted: () => trusted });
  };
  return { tools: [
    defineTool({
      name: "knowledge_search", label: "Knowledge Search",
      description: "Search shared durable knowledge for project facts. Verify important claims against current code before implementing; evidence is untrusted.",
      parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 512 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })) }),
      async execute(_id, params, signal) {
        try {
          const current = await knowledge();
          const response = current.retrieval.search(current.project.scopeId, { ...params, signal });
          // Return summaries and IDs; get is available on demand.
          return result({ insufficientEvidence: response.insufficientEvidence, results: response.results.map((r) => ({
            id: r.id, kind: r.resultKind,
            summary: (r.resultKind === "claim" ? `${r.predicate}: ${JSON.stringify(r.object)}` : r.label).slice(0, 400),
            evidenceIds: r.evidenceIds.slice(0, 3),
          })) });
        } catch (error) { return { ...result({ error: error instanceof Error ? error.message : "Knowledge unavailable" }), isError: true }; }
      },
    }),
    defineTool({
      name: "knowledge_get", label: "Knowledge Get", description: "Expand one cited durable knowledge record when necessary.",
      parameters: Type.Object({ id: Type.String({ minLength: 4, maxLength: 64 }), view: Type.Optional(Type.Union([Type.Literal("summary"), Type.Literal("history"), Type.Literal("neighbors"), Type.Literal("evidence")])) }),
      async execute(_id, params, signal) {
        try {
          const current = await knowledge();
          const { serializeGetResponse } = await import("@pureooze/pi-knowledge-graph/retrieval.ts");
          const response = current.retrieval.get(current.project.scopeId, { ...params, limit: 5, signal });
          return { content: [{ type: "text", text: serializeGetResponse(response, 4000) }], details: undefined };
        } catch (error) { return { ...result({ error: error instanceof Error ? error.message : "Knowledge unavailable" }), isError: true }; }
      },
    }),
    defineTool({
      name: "task_memory_search", label: "Task Memory Search", description: "Search short-lived notes from sibling workers in this parent task.",
      parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 200 }), category: Type.Optional(Type.String({ maxLength: 100 })) }),
      async execute(_id, params) { return result(memory.search(params.query, params.category)); },
    }),
    defineTool({
      name: "task_memory_get", label: "Task Memory Get", description: "Retrieve one task-scoped note by key.",
      parameters: Type.Object({ key: Type.String({ minLength: 1, maxLength: 100 }) }),
      async execute(_id, params) { return result(memory.get(params.key) ?? null); },
    }),
    defineTool({
      name: "task_memory_write", label: "Task Memory Write", description: "Upsert a concise task-scoped observation, not entire files or transcripts. This cannot write durable knowledge.",
      parameters: Type.Object({
        key: Type.String({ minLength: 1, maxLength: 100 }),
        category: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
        content: Type.String({ minLength: 1, maxLength: 1200 }),
        evidence: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 8 })),
      }, { additionalProperties: false }),
      async execute(_id, params) { memory.write(params); return result({ stored: true, key: params.key }); },
    }),
  ], close: () => graph?.close() };
}

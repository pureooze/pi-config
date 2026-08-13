import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  resolveKnowledgeGraphConfig,
  type KnowledgeGraphConfig,
} from "./config.ts";
import {
  KnowledgeGraphDatabase,
  type KnowledgeGraphDatabaseError,
} from "./database.ts";
import { KnowledgeGraphRepositories } from "./repository.ts";
import { KnowledgeGraphRetrieval } from "./retrieval.ts";
import { resolveKnowledgeScope, type KnowledgeScopeResolution } from "./scope.ts";

export interface KnowledgeGraphRuntime {
  readonly config: KnowledgeGraphConfig;
  readonly project: KnowledgeScopeResolution;
  readonly projectTrusted: boolean;
  readonly database: KnowledgeGraphDatabase;
  readonly repositories: KnowledgeGraphRepositories;
  readonly retrieval: KnowledgeGraphRetrieval;
}

export interface KnowledgeGraphRuntimeStatus {
  readonly scopeId: string;
  readonly projectRoot: string;
  readonly identityPath: string;
  readonly projectSource: KnowledgeScopeResolution["source"];
  readonly projectTrusted: boolean;
  readonly databasePath: string;
  readonly rootDirectory: string;
  readonly storeOpen: boolean;
  readonly schemaVersion: number | undefined;
  readonly warnings: readonly string[];
  readonly entities: number | undefined;
  readonly claims: number | undefined;
  readonly workflowRecords: number | undefined;
}

export class KnowledgeGraphSessionRuntime {
  private state: {
    config: KnowledgeGraphConfig;
    project: KnowledgeScopeResolution;
    projectTrusted: boolean;
    database: KnowledgeGraphDatabase | undefined;
    repositories: KnowledgeGraphRepositories | undefined;
    retrieval: KnowledgeGraphRetrieval | undefined;
  } | undefined;

  start(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): void {
    this.close();
    const project = resolveKnowledgeScope(ctx.cwd);
    const projectTrusted = ctx.isProjectTrusted();
    const config = resolveKnowledgeGraphConfig({
      cwd: ctx.cwd,
      projectRoot: project.projectRoot,
      projectTrusted,
    });
    this.state = { config, project, projectTrusted, database: undefined, repositories: undefined, retrieval: undefined };
  }

  ensure(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): KnowledgeGraphRuntime {
    if (!this.state) this.start(ctx);
    const state = this.state;
    if (!state) throw new Error("Knowledge-graph runtime could not be initialized.");

    if (!state.database || !state.repositories || !state.retrieval) {
      const database = new KnowledgeGraphDatabase({ paths: state.config });
      const connection = database.open();
      const repositories = new KnowledgeGraphRepositories(connection);
      repositories.registerScope({ scopeId: "global", kind: "global" });
      state.database = database;
      state.repositories = repositories;
      state.retrieval = new KnowledgeGraphRetrieval(connection, repositories);
    }

    return {
      config: state.config,
      project: state.project,
      projectTrusted: state.projectTrusted,
      database: state.database,
      repositories: state.repositories,
      retrieval: state.retrieval,
    };
  }

  close(): void {
    this.state?.database?.close();
    this.state = undefined;
  }

  status(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): KnowledgeGraphRuntimeStatus {
    const runtime = this.ensure(ctx);
    const entities = runtime.repositories.listEntities(runtime.project.scopeId);
    const claims = runtime.repositories.listClaims(runtime.project.scopeId);
    const workflowRecords = runtime.repositories.listProposals(runtime.project.scopeId);
    return {
      scopeId: runtime.project.scopeId,
      projectRoot: runtime.project.projectRoot,
      identityPath: runtime.project.identityPath,
      projectSource: runtime.project.source,
      projectTrusted: runtime.projectTrusted,
      databasePath: runtime.config.databasePath,
      rootDirectory: runtime.config.rootDirectory,
      storeOpen: runtime.database.isOpen,
      schemaVersion: runtime.database.getSchemaVersion(),
      warnings: runtime.config.warnings,
      entities: entities.length,
      claims: claims.length,
      workflowRecords: workflowRecords.length,
    };
  }
}

export function isDatabaseError(error: unknown): error is KnowledgeGraphDatabaseError {
  return error instanceof Error && error.name === "KnowledgeGraphDatabaseError";
}

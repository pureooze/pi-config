import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const { resolveKnowledgeGraphConfig } = await import("../../extensions/knowledge-graph/config.ts");
const { KnowledgeGraphDatabase } = await import("../../extensions/knowledge-graph/database.ts");
const { KnowledgeGraphRepositories } = await import("../../extensions/knowledge-graph/repository.ts");
const corpus = JSON.parse(readFileSync(resolve("tests/fixtures/knowledge-graph-mvp-corpus.json"), "utf8"));

export const CORPUS_NOW = Date.parse("2026-08-07T00:00:00.000Z");

export function createCorpusFixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-knowledge-graph-corpus-"));
  const config = resolveKnowledgeGraphConfig({
    cwd: join(root, "project"),
    projectRoot: join(root, "project"),
    projectTrusted: false,
    env: { PI_KNOWLEDGE_GRAPH_DIR: join(root, "store") },
    homeDirectory: join(root, "home"),
  });
  const database = new KnowledgeGraphDatabase({ paths: config, now: () => CORPUS_NOW });
  const repositories = new KnowledgeGraphRepositories(database.open(), { now: () => CORPUS_NOW });
  for (const scope of corpus.scopes) {
    repositories.registerScope({
      scopeId: scope.scopeKey,
      kind: scope.kind,
      identityPath: scope.identityPath,
    });
  }
  return { root, config, database, repositories, corpus };
}

export function seedCorpusFixture(fixture) {
  const { repositories } = fixture;
  for (const entity of fixture.corpus.entities) {
    repositories.createEntity(entity.scopeKey, {
      entityId: entity.id,
      label: entity.label,
      type: entity.type,
      status: entity.status,
    });
  }
  for (const alias of fixture.corpus.aliases) {
    repositories.createAlias(alias.scopeKey, {
      aliasId: alias.id,
      entityId: alias.entityId,
      alias: alias.value,
      status: alias.status,
    });
  }
  for (const evidence of fixture.corpus.evidence) {
    repositories.createEvidence(evidence.scopeKey, {
      evidenceId: evidence.id,
      sourceKind: evidence.sourceKind,
      locator: evidence.locator,
      excerpt: evidence.excerpt,
      sourceObservedAt: Date.parse(evidence.capturedAt),
      trustClass: evidence.sourceTrust,
    });
  }

  const claims = new Map();
  for (const claim of fixture.corpus.claims) {
    const created = repositories.createClaim(claim.scopeKey, {
      claimId: claim.id,
      subjectEntityId: claim.subjectEntityId,
      predicate: claim.predicate,
      object: claim.object,
      status: claim.status === "superseded" ? "accepted" : claim.status,
      observedAt: Date.parse(claim.observedAt),
      validFrom: claim.validFrom === undefined ? undefined : Date.parse(claim.validFrom),
      validTo: claim.validTo === undefined ? undefined : Date.parse(claim.validTo),
    });
    claims.set(claim.id, created);
    for (const evidenceId of claim.evidenceIds) {
      repositories.attachEvidence(claim.scopeKey, {
        claimId: claim.id,
        evidenceId,
        role: "primary",
      });
    }
  }

  for (const claim of fixture.corpus.claims) {
    if (claim.supersededBy === undefined) continue;
    repositories.supersedeClaim(claim.scopeKey, {
      priorClaimId: claim.id,
      replacementClaimId: claim.supersededBy,
      reason: "Corpus correction.",
    });
  }
  return { claims };
}

export function cleanupCorpusFixture(fixture) {
  fixture.database.close();
  rmSync(fixture.root, { recursive: true, force: true });
}

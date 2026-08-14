import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const { KnowledgeGraphProposalService } = await import("../../packages/knowledge-graph/proposal.ts");
const {
  PROJECT_SCOPE,
  cleanupKnowledgeGraphFixture,
  createKnowledgeGraphFixture,
} = await import("../helpers/knowledge-graph-fixture.mjs");

const databaseModule = pathToFileURL(resolve("packages/knowledge-graph/database.ts")).href;
const proposalModule = pathToFileURL(resolve("packages/knowledge-graph/proposal.ts")).href;
const repositoryModule = pathToFileURL(resolve("packages/knowledge-graph/repository.ts")).href;

const reviewWorker = `
const { KnowledgeGraphDatabase } = await import(${JSON.stringify(databaseModule)});
const { KnowledgeGraphProposalService } = await import(${JSON.stringify(proposalModule)});
const { KnowledgeGraphRepositories } = await import(${JSON.stringify(repositoryModule)});
const paths = JSON.parse(process.env.KG_PATHS);
const database = new KnowledgeGraphDatabase({ paths, busyTimeoutMs: 5_000 });
try {
  const repositories = new KnowledgeGraphRepositories(database.open());
  const service = new KnowledgeGraphProposalService(repositories);
  const result = service.review(process.env.KG_SCOPE, process.env.KG_PROPOSAL_ID, "accepted", {
    actorType: "user",
    sessionId: process.env.KG_SESSION_ID,
  });
  process.stdout.write(JSON.stringify({ status: result.proposal.status }));
} catch (error) {
  process.stderr.write(JSON.stringify({ name: error?.name, code: error?.code, message: error?.message }));
  process.exitCode = 1;
} finally {
  database.close();
}
`;

function runReview(paths, proposalId, sessionId) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", reviewWorker], {
      cwd: resolve("."),
      env: {
        ...process.env,
        KG_PATHS: JSON.stringify(paths),
        KG_SCOPE: PROJECT_SCOPE,
        KG_PROPOSAL_ID: proposalId,
        KG_SESSION_ID: sessionId,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`review worker failed (${code ?? signal}): ${stderr || stdout}`));
        return;
      }
      try {
        resolveResult(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`review worker returned invalid output: ${error.message}; stdout=${stdout}`));
      }
    });
  });
}

test("concurrent Pi-process reviews serialize without losing accepted updates", async () => {
  const fixture = createKnowledgeGraphFixture();
  try {
    const service = new KnowledgeGraphProposalService(fixture.repositories);
    const first = service.submit(PROJECT_SCOPE, {
      actorType: "agent",
      subject: { label: "Concurrent Fact One", type: "concept" },
      predicate: "has_value",
      object: { kind: "text", value: "one" },
      evidence: [{ sourceKind: "user_statement", excerpt: "Concurrent fact one is one." }],
    });
    const second = service.submit(PROJECT_SCOPE, {
      actorType: "agent",
      subject: { label: "Concurrent Fact Two", type: "concept" },
      predicate: "has_value",
      object: { kind: "text", value: "two" },
      evidence: [{ sourceKind: "user_statement", excerpt: "Concurrent fact two is two." }],
    });
    const paths = {
      rootDirectory: fixture.config.rootDirectory,
      databasePath: fixture.config.databasePath,
      backupDirectory: fixture.config.backupDirectory,
      exportDirectory: fixture.config.exportDirectory,
    };

    const results = await Promise.all([
      runReview(paths, first.proposal.proposalId, "process-review-one"),
      runReview(paths, second.proposal.proposalId, "process-review-two"),
    ]);

    assert.deepEqual(results.map((result) => result.status).sort(), ["accepted", "accepted"]);
    assert.equal(fixture.repositories.getProposal(PROJECT_SCOPE, first.proposal.proposalId)?.status, "accepted");
    assert.equal(fixture.repositories.getProposal(PROJECT_SCOPE, second.proposal.proposalId)?.status, "accepted");
    assert.equal(fixture.repositories.listClaims(PROJECT_SCOPE, "accepted").filter((claim) => claim.predicate === "has_value").length, 2);
    assert.equal(fixture.repositories.listAuditEvents(PROJECT_SCOPE).filter((event) => event.action === "acceptance").length, 2);
    fixture.database.checkIntegrity();
  } finally {
    cleanupKnowledgeGraphFixture(fixture);
  }
});

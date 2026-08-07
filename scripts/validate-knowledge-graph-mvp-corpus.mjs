import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const fixturePath = resolve(process.cwd(), "tests/fixtures/knowledge-graph-mvp-corpus.json");
const corpus = JSON.parse(readFileSync(fixturePath, "utf8"));

const idPattern = /^(ent|als|clm|evd|prp|aud)_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const predicatePattern = /^[a-z][a-z0-9_.-]{0,63}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const sourceKinds = new Set(["user_statement", "pi_session", "file", "command", "url", "other"]);
const sourceTrusts = new Set(["user", "agent", "local_file", "local_command", "external", "unknown"]);
const statuses = new Set(["accepted", "proposed", "rejected", "superseded"]);
const entityTypes = new Set(["person", "project", "repository", "service", "tool", "organization", "location", "preference", "concept", "other"]);

assert.equal(corpus.schemaVersion, 1);
assert.equal(corpus.fixturePolicy.allCanonicalValuesAreSynthetic, true);
assert.equal(corpus.fixturePolicy.expectedSetsAreIndependentOfGeneratedAnswers, true);

const scopes = new Map(corpus.scopes.map((scope) => [scope.scopeKey, scope]));
assert.equal(scopes.has("global"), true);
assert.ok([...scopes.values()].filter((scope) => scope.kind === "project").length >= 2);

const byId = (records, label) => {
  const map = new Map();
  for (const record of records) {
    assert.equal(typeof record.id, "string", `${label} ID must be a string`);
    assert.match(record.id, idPattern, `${label} ID has invalid shape: ${record.id}`);
    assert.equal(map.has(record.id), false, `duplicate ${label} ID: ${record.id}`);
    map.set(record.id, record);
  }
  return map;
};

const entities = byId(corpus.entities, "entity");
const aliases = byId(corpus.aliases, "alias");
const evidence = byId(corpus.evidence, "evidence");
const claims = byId(corpus.claims, "claim");

const assertScope = (scopeKey, context) => assert.equal(scopes.has(scopeKey), true, `${context} has unknown scope ${scopeKey}`);
const assertTimestamp = (value, context) => {
  assert.match(value, timestampPattern, `${context} is not UTC millisecond timestamp`);
  assert.equal(Number.isNaN(Date.parse(value)), false, `${context} is not a date`);
};
const normalize = (value) => value.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/gu, " ");

for (const entity of entities.values()) {
  assertScope(entity.scopeKey, `entity ${entity.id}`);
  assert.ok(entity.label.length > 0 && entity.label.length <= 256);
  assert.ok(entityTypes.has(entity.type), `unknown entity type ${entity.type}`);
  assert.ok(["accepted", "proposed", "rejected"].includes(entity.status));
}

const aliasKeys = new Set();
for (const alias of aliases.values()) {
  assertScope(alias.scopeKey, `alias ${alias.id}`);
  const entity = entities.get(alias.entityId);
  assert.ok(entity, `alias ${alias.id} references missing entity`);
  assert.equal(entity.scopeKey, alias.scopeKey, `alias ${alias.id} crosses scope`);
  assert.ok(alias.value.length > 0 && alias.value.length <= 256);
  assert.equal(alias.status, "accepted");
  const key = `${alias.scopeKey}\0${normalize(alias.value)}`;
  assert.equal(aliasKeys.has(key), false, `duplicate normalized alias ${alias.value}`);
  aliasKeys.add(key);
}

for (const item of evidence.values()) {
  assertScope(item.scopeKey, `evidence ${item.id}`);
  assert.ok(sourceKinds.has(item.sourceKind), `unknown source kind ${item.sourceKind}`);
  assert.ok(sourceTrusts.has(item.sourceTrust), `unknown source trust ${item.sourceTrust}`);
  assert.ok(item.excerpt.length > 0 && item.excerpt.length <= 4000);
  assert.ok(item.locator.length > 0 && item.locator.length <= 2048);
  assertTimestamp(item.capturedAt, `evidence ${item.id}.capturedAt`);
  const hash = createHash("sha256").update(item.excerpt, "utf8").digest("hex");
  assert.equal(item.contentHash, hash, `evidence ${item.id} hash mismatch`);
}

const claimEvidence = new Set();
for (const claim of claims.values()) {
  assertScope(claim.scopeKey, `claim ${claim.id}`);
  assert.ok(statuses.has(claim.status), `unknown claim status ${claim.status}`);
  assert.ok(entities.has(claim.subjectEntityId), `claim ${claim.id} references missing subject`);
  assert.equal(entities.get(claim.subjectEntityId).scopeKey, claim.scopeKey, `claim ${claim.id} subject crosses scope`);
  assert.match(claim.predicate, predicatePattern, `claim ${claim.id} predicate is not normalized`);
  assertTimestamp(claim.observedAt, `claim ${claim.id}.observedAt`);
  if (claim.validFrom) assertTimestamp(claim.validFrom, `claim ${claim.id}.validFrom`);
  if (claim.validTo) assertTimestamp(claim.validTo, `claim ${claim.id}.validTo`);
  if (claim.validFrom && claim.validTo) assert.ok(Date.parse(claim.validTo) > Date.parse(claim.validFrom), `claim ${claim.id} interval is not half-open and ordered`);
  const object = claim.object;
  assert.ok(object && typeof object === "object");
  if (object.kind === "entity") {
    assert.ok(entities.has(object.entityId), `claim ${claim.id} references missing object`);
    assert.equal(entities.get(object.entityId).scopeKey, claim.scopeKey, `claim ${claim.id} object crosses scope`);
  } else {
    assert.ok(["text", "number", "boolean", "date", "url"].includes(object.kind), `claim ${claim.id} has invalid object kind`);
    if (object.kind === "text" || object.kind === "url") assert.ok(object.value.length > 0);
    if (object.kind === "number") assert.equal(Number.isFinite(object.value), true);
    if (object.kind === "date") assertTimestamp(object.value, `claim ${claim.id}.object.date`);
  }
  assert.ok(Array.isArray(claim.evidenceIds) && claim.evidenceIds.length > 0, `claim ${claim.id} needs evidence`);
  for (const evidenceId of claim.evidenceIds) {
    const item = evidence.get(evidenceId);
    assert.ok(item, `claim ${claim.id} references missing evidence ${evidenceId}`);
    assert.equal(item.scopeKey, claim.scopeKey, `claim ${claim.id} evidence crosses scope`);
    claimEvidence.add(evidenceId);
  }
  if (claim.supersededBy) {
    const replacement = claims.get(claim.supersededBy);
    assert.ok(replacement, `claim ${claim.id} references missing replacement`);
    assert.equal(claim.status, "superseded");
    assert.equal(replacement.scopeKey, claim.scopeKey, `claim ${claim.id} replacement crosses scope`);
    assert.equal(replacement.status, "accepted");
  }
}

assert.ok(claims.size >= corpus.expectations.minimumEvidenceBackedClaims);
assert.ok(claimEvidence.size >= corpus.expectations.minimumEvidenceBackedClaims);
const projectClaimCounts = new Map();
for (const claim of claims.values()) projectClaimCounts.set(claim.scopeKey, (projectClaimCounts.get(claim.scopeKey) ?? 0) + 1);
for (const scope of scopes.values()) {
  if (scope.kind === "project") assert.ok((projectClaimCounts.get(scope.scopeKey) ?? 0) > 0, `project scope ${scope.scopeKey} has no claims`);
}

const allExpectedIds = new Set([...claims.keys(), ...entities.keys(), ...evidence.keys()]);
const expectedArray = (query, key) => {
  const values = query.expected[key] ?? [];
  assert.equal(new Set(values).size, values.length, `${query.id} has duplicate ${key}`);
  for (const value of values) assert.ok(allExpectedIds.has(value), `${query.id} references unknown ${key} ID ${value}`);
  return values;
};
const claimScope = (id) => claims.get(id)?.scopeKey;
const entityScope = (id) => entities.get(id)?.scopeKey;
const evidenceScope = (id) => evidence.get(id)?.scopeKey;

const queryKinds = new Set(corpus.queries.map((query) => query.kind));
for (const required of ["alias", "relationship", "one_hop", "temporal", "irrelevant", "unanswerable", "global_opt_in", "scope_isolation"]) {
  assert.ok(queryKinds.has(required), `missing query kind ${required}`);
}
for (const query of corpus.queries) {
  assertScope(query.scopeKey, `query ${query.id}`);
  assert.ok(query.operation === "search" || query.operation === "get");
  const claimIds = expectedArray(query, "claimIds");
  const entityIds = expectedArray(query, "entityIds");
  const evidenceIds = expectedArray(query, "evidenceIds");
  const forbidden = expectedArray(query, "forbiddenClaimIds");
  for (const id of [...claimIds, ...entityIds, ...evidenceIds]) {
    assert.equal(forbidden.includes(id), false, `${query.id} both expects and forbids ${id}`);
  }
  for (const id of claimIds) assert.equal(claimScope(id), query.scopeKey === "global" ? "global" : claimScope(id) === "global" && query.params.includeGlobal ? "global" : query.scopeKey, `${query.id} expected claim outside visibility`);
  for (const id of entityIds) assert.ok(entityScope(id) === query.scopeKey || (entityScope(id) === "global" && query.params.includeGlobal), `${query.id} expected entity outside visibility`);
  for (const id of evidenceIds) assert.ok(evidenceScope(id) === query.scopeKey || (evidenceScope(id) === "global" && query.params.includeGlobal), `${query.id} expected evidence outside visibility`);
  if (query.params.includeGlobal !== true) {
    assert.equal(claimIds.some((id) => claimScope(id) === "global"), false, `${query.id} leaks global claim without opt-in`);
    assert.equal(entityIds.some((id) => entityScope(id) === "global"), false, `${query.id} leaks global entity without opt-in`);
    assert.equal(evidenceIds.some((id) => evidenceScope(id) === "global"), false, `${query.id} leaks global evidence without opt-in`);
  }
  if (query.expected.errorCode) assert.ok(["not_found", "invalid_input", "scope_unavailable"].includes(query.expected.errorCode));
  if (query.expected.paths) {
    for (const path of query.expected.paths) {
      assert.equal(path.length, 3);
      assert.ok(entities.has(path[0]) && claims.has(path[1]) && entities.has(path[2]));
    }
  }
}

assert.ok(corpus.securityCases.some((item) => item.kind === "secret_like_candidate"));
assert.ok(corpus.securityCases.some((item) => item.kind === "scope_isolation"));
const secretCase = corpus.securityCases.find((item) => item.kind === "secret_like_candidate");
assert.equal(secretCase.expected.persisted, false);
assert.equal(secretCase.expected.claimIds.length, 0);
assert.equal(secretCase.expected.evidenceIds.length, 0);
for (const item of corpus.securityCases) {
  assertScope(item.scopeKey, `security case ${item.id}`);
  const expectedClaimIds = item.expected.claimIds ?? [];
  const expectedEvidenceIds = item.expected.evidenceIds ?? [];
  if (item.expected.persisted === false) {
    assert.equal(expectedClaimIds.length, 0);
    assert.equal(expectedEvidenceIds.length, 0);
  }
}

console.log(JSON.stringify({
  status: "pass",
  corpusId: corpus.corpusId,
  scopes: scopes.size,
  projectScopes: [...scopes.values()].filter((scope) => scope.kind === "project").length,
  entities: entities.size,
  aliases: aliases.size,
  claims: claims.size,
  evidence: evidence.size,
  queries: corpus.queries.length,
  securityCases: corpus.securityCases.length,
}, null, 2));

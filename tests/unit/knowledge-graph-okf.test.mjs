import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { stringify } from 'yaml';
import { exportOkfBundle, previewOkfImport, applyOkfImport } from '../../packages/knowledge-graph/okf.ts';
import { KnowledgeGraphMaintenance } from '../../packages/knowledge-graph/maintenance.ts';
import { KnowledgeGraphAgentMaintenanceService } from '../../packages/knowledge-graph/agent-maintenance.ts';
import { createKnowledgeGraphFixture, cleanupKnowledgeGraphFixture, PROJECT_SCOPE } from '../helpers/knowledge-graph-fixture.mjs';

function temp(run) {
  const root = mkdtempSync(join(tmpdir(), 'pi-okf-test-'));
  try { return run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function document(root, content, name = 'concept.md') { writeFileSync(join(root, name), content); }
const candidate = {
  operation: 'insert', subject: { label: 'OKF Sample', type: 'concept' }, predicate: 'has_value',
  object: { kind: 'number', value: 42 }, evidence: [{ sourceKind: 'user_statement', excerpt: 'The value is 42.' }],
};

test('OKF exports a private current-knowledge view, previews without writes, and imports idempotently', () => temp((root) => {
  const source = createKnowledgeGraphFixture();
  const dest = createKnowledgeGraphFixture();
  try {
    const service = new KnowledgeGraphAgentMaintenanceService(source.database.open(), source.repositories);
    service.execute(PROJECT_SCOPE, candidate, {});
    service.execute(PROJECT_SCOPE, { ...candidate, predicate: 'relates_to', object: { kind: 'entity', label: 'Other Concept', type: 'concept' } }, {});
    const snapshot = new KnowledgeGraphMaintenance(source.database.open(), source.repositories).exportSnapshot();
    const bundle = exportOkfBundle(snapshot, join(root, 'exports'), 'sample');
    assert.equal(statSync(bundle).mode & 0o777, 0o700);
    for (const file of readdirSync(bundle)) assert.equal(statSync(join(bundle, file)).mode & 0o777, 0o600);
    assert.match(readFileSync(join(bundle, 'index.md'), 'utf8'), /okf_version: '0.2'/);
    assert.throws(() => exportOkfBundle(snapshot, join(root, 'exports'), 'sample'));
    assert.throws(() => exportOkfBundle(snapshot, join(root, 'exports'), '../escape'));
    const preview = previewOkfImport(bundle);
    assert.equal(preview.concepts, snapshot.entities.filter((e) => e.status === 'accepted').length);
    assert.equal(preview.candidates.length, 2);
    assert.equal(dest.repositories.listClaims(PROJECT_SCOPE).length, 0);
    assert.ok(preview.candidates.every((c) => c.evidence.every((e) => e.sourceKind === 'file')));
    assert.equal(applyOkfImport(dest.database.open(), dest.repositories, PROJECT_SCOPE, preview, {}), 2);
    assert.equal(applyOkfImport(dest.database.open(), dest.repositories, PROJECT_SCOPE, preview, {}), 0);
    assert.equal(dest.repositories.listClaims(PROJECT_SCOPE, 'accepted').length, 2);
    assert.equal(dest.repositories.listAuditEvents(PROJECT_SCOPE).some((e) => e.action === 'acceptance'), true);
  } finally { cleanupKnowledgeGraphFixture(source); cleanupKnowledgeGraphFixture(dest); }
}));

test('OKF accepts ordinary YAML, unknown types and metadata, preserves content, and never follows links', () => temp((root) => {
  document(root, '---\ntype: BigQuery Table\ntitle: Orders\nverified: {by: "human:someone", at: "2026-01-01T00:00:00Z"}\nx-unknown: [one, two]\nexecutor: {resource: /does/not/exist}\n---\n# Orders\nSee [missing](/missing.md).\n');
  document(root, '# Navigation only', 'index.md');
  const result = previewOkfImport(root);
  assert.equal(result.concepts, 1);
  assert.equal(result.candidates[0].subject.type, 'concept');
  assert.match(result.candidates[0].object.value, /x-unknown/);
  assert.equal(result.candidates[0].evidence[0].sourceKind, 'file');
  assert.ok(result.warnings.some((w) => w.includes('untrusted')));
  const digest = result.digest;
  document(root, '---\ntype: Reference\n---\nChanged');
  assert.notEqual(previewOkfImport(root).digest, digest);
}));

test('OKF rejects malformed YAML, unsafe aliases, missing type, invalid extensions and oversized files', () => temp((root) => {
  for (const content of [
    'not frontmatter',
    '---\ntitle: Missing type\n---\nBody',
    '---\ntype: One\ntype: Two\n---\nBody',
    '---\ntype: Reference\nx: &a [one]\ny: *a\n---\nBody',
    '---\ntype: !!js/function bad\n---\nBody',
    '---\ntype: Reference\nx-pi-knowledge: {version: 99}\n---\nBody',
    '---\ntype: Reference\n---\n' + 'x'.repeat(256 * 1024),
  ]) {
    document(root, content);
    assert.throws(() => previewOkfImport(root));
  }
}));

test('OKF rejects bundle and entry symlinks', () => temp((root) => {
  const bundle = join(root, 'bundle'); mkdirSync(bundle);
  document(root, '---\ntype: Reference\n---\nOutside');
  symlinkSync(join(root, 'concept.md'), join(bundle, 'link.md'));
  assert.throws(() => previewOkfImport(bundle), /symlink/);
  rmSync(join(bundle, 'link.md'));
  symlinkSync(bundle, join(root, 'alias'));
  assert.throws(() => previewOkfImport(join(root, 'alias')), /symlink/);
  symlinkSync(root, join(bundle, 'directory-link'));
  assert.throws(() => previewOkfImport(bundle), /symlink/);
}));

test('OKF skips stale, draft and deprecated concepts and tolerates type-only concepts', () => temp((root) => {
  document(root, '---\ntype: Reference\nstatus: deprecated\n---\nOld', 'old.md');
  document(root, '---\ntype: Reference\nstatus: draft\n---\nDraft', 'draft.md');
  document(root, '---\ntype: Reference\nstale_after: 2000-01-01T00:00:00Z\n---\nStale', 'stale.md');
  document(root, '---\ntype: Unknown\n---\n', 'minimal.md');
  const preview = previewOkfImport(root);
  assert.equal(preview.concepts, 4);
  assert.equal(preview.candidates.length, 1);
}));

test('OKF rejects secrets during preview', () => temp((root) => {
  document(root, '---\ntype: Reference\n---\napi_key=' + 'sk-' + 'a'.repeat(48));
  assert.throws(() => previewOkfImport(root));
}));

test('OKF batch failures roll back claims, evidence, entities, proposals and audit events', () => {
  const fixture = createKnowledgeGraphFixture();
  try {
    const maintenance = new KnowledgeGraphMaintenance(fixture.database.open(), fixture.repositories);
    const before = maintenance.exportSnapshot();
    const preview = { concepts: 1, digest: '', warnings: [], candidates: [candidate, { ...candidate, predicate: 'Bad predicate!' }] };
    assert.throws(() => applyOkfImport(fixture.database.open(), fixture.repositories, PROJECT_SCOPE, preview, {}));
    assert.deepEqual(maintenance.exportSnapshot(), before);
    const valid = { ...preview, candidates: [candidate] };
    assert.equal(applyOkfImport(fixture.database.open(), fixture.repositories, PROJECT_SCOPE, valid, {}), 1);
  } finally { cleanupKnowledgeGraphFixture(fixture); }
});

test('OKF exported extension must remain authoritative and malformed evidence is rejected', () => temp((root) => {
  const metadata = { type: 'concept', 'x-pi-knowledge': { version: 1, subject: candidate.subject, claims: [{ predicate: 'has_value', object: candidate.object, evidence: [] }] } };
  document(root, `---\n${stringify(metadata)}---\nBody`);
  assert.throws(() => previewOkfImport(root), /extension/);
}));

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import install from '../../packages/knowledge-graph/index.ts';

for (const scenario of ['no-ui', 'decline', 'changed', 'accept']) {
  test(`OKF import command: ${scenario}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-okf-command-'));
    const old = process.env.PI_KNOWLEDGE_GRAPH_DIR;
    process.env.PI_KNOWLEDGE_GRAPH_DIR = join(root, 'store');
    const commands = new Map(), tools = new Map(), handlers = new Map();
    const notices = [];
    let confirmations = 0;
    install({ registerCommand(name, value) { commands.set(name, value); }, registerTool(tool) { tools.set(tool.name, tool); }, on(name, handler) { handlers.set(name, handler); } });
    const bundle = join(root, 'bundle'); mkdirSync(bundle);
    const file = join(bundle, 'sample.md');
    writeFileSync(file, '---\ntype: Reference\ntitle: Command Import\n---\nA durable local fact.');
    const ctx = {
      cwd: root, hasUI: scenario !== 'no-ui', isProjectTrusted: () => false,
      sessionManager: { getSessionId: () => 'okf-command', getLeafId: () => 'leaf' },
      ui: {
        notify(message) { notices.push(message); },
        async confirm() {
          confirmations++;
          if (scenario === 'changed') writeFileSync(file, '---\ntype: Reference\n---\nChanged after preview');
          return scenario !== 'decline';
        },
      },
    };
    try {
      await commands.get('knowledge-import').handler(bundle, ctx);
      assert.equal(confirmations, scenario === 'no-ui' ? 0 : 1);
      assert.ok(notices.some((n) => n.includes('OKF preview')));
      const response = await tools.get('knowledge_search').execute('search', { query: 'durable' }, undefined, undefined, ctx);
      const result = JSON.parse(response.content[0].text);
      assert.equal(result.insufficientEvidence, scenario !== 'accept');
      if (scenario === 'changed') assert.ok(notices.some((n) => n.includes('changed after preview')));
      if (scenario === 'accept') {
        assert.ok(notices.some((n) => n.includes('1 claims inserted')));
        await commands.get('knowledge-export').handler('--format okf portable', ctx);
        assert.ok(readdirSync(join(root, 'store', 'exports', 'portable')).includes('index.md'));
        await commands.get('knowledge-export').handler('canonical.json', ctx);
        assert.ok(readdirSync(join(root, 'store', 'exports')).includes('canonical.json'));
      }
    } finally {
      await handlers.get('session_shutdown')?.({}, ctx);
      if (old === undefined) delete process.env.PI_KNOWLEDGE_GRAPH_DIR;
      else process.env.PI_KNOWLEDGE_GRAPH_DIR = old;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

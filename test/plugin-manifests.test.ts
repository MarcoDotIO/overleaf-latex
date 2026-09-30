import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createMcpServer, type OverleafApi } from '../src/tools.js';

const root = resolve(import.meta.dirname, '..');
const json = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const pkg = json('package.json');
const claude = json('.claude-plugin/plugin.json');
const marketplace = json('.claude-plugin/marketplace.json');
const codex = json('.codex-plugin/plugin.json');
const codexMcp = json(codex.mcpServers);

test('Claude Code and Codex manifests describe the same plugin and version', () => {
  assert.equal(claude.name, pkg.name);
  assert.equal(codex.name, pkg.name);
  assert.equal(claude.version, pkg.version);
  assert.equal(codex.version.split('+')[0], pkg.version);
  assert.deepEqual(marketplace.plugins.map((plugin: { name: string; source: string }) => [plugin.name, plugin.source]), [[pkg.name, './']]);
});

test('both hosts launch the committed bundle under the same server name', () => {
  const claudeServer = claude.mcpServers.overleaf;
  assert.equal(claudeServer.command, 'node');
  assert.deepEqual(claudeServer.args, ['${CLAUDE_PLUGIN_ROOT}/bundle/overleaf-mcp.mjs']);
  // Claude Code also loads the root .mcp.json, then replaces same-named servers
  // from plugin.json, so Codex's cwd-relative entry must keep the same name.
  assert.deepEqual(Object.keys(codexMcp.mcpServers), ['overleaf']);
  const codexServer = codexMcp.mcpServers.overleaf;
  assert.equal(codexServer.command, 'node');
  assert.equal(codexServer.cwd, '.');
  assert.deepEqual(codexServer.args, ['./bundle/overleaf-mcp.mjs']);
  assert.ok(existsSync(join(root, 'bundle/overleaf-mcp.mjs')));
  assert.ok(existsSync(join(root, 'bundle/overleaf-login.mjs')));
});

test('the committed bundle serves the same tools as the source (run npm run bundle if stale)', async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer({} as OverleafApi).connect(serverSide);
  const source = new Client({ name: 'manifest-test', version: '0' });
  await source.connect(clientSide);

  const directory = mkdtempSync(join(tmpdir(), 'overleaf-bundle-test-'));
  const bundled = new Client({ name: 'manifest-test', version: '0' });
  try {
    await bundled.connect(new StdioClientTransport({
      command: process.execPath, args: [join(root, 'bundle/overleaf-mcp.mjs')], cwd: directory,
      env: { OVERLEAF_SESSION_FILE: join(directory, 'session.json'), OVERLEAF_CHECKPOINT_DIR: join(directory, 'checkpoints') },
      stderr: 'ignore',
    }));
    assert.deepEqual((await bundled.listTools()).tools, (await source.listTools()).tools);
    assert.equal(bundled.getInstructions(), source.getInstructions());
  } finally {
    await bundled.close();
    await source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

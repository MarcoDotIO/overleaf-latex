import assert from 'node:assert/strict';
import test from 'node:test';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpServer } from '../src/http.js';
import type { OverleafApi } from '../src/tools.js';

test('loopback HTTP supports real MCP initialization, discovery and tool calls', async () => {
  const api = { listProjects: async () => [{ name: 'Integration test' }] } as unknown as OverleafApi;
  const http = await startHttpServer(api, 0);
  const address = http.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  const client = new Client({ name: 'http-test', version: '1' });
  try {
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
    assert.equal((await fetch(`${url}/healthz`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${url}/healthz`, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(foreignHostStatus, 403);
    assert.equal((await fetch(`${url}/mcp`, { method: 'POST', body: '{' })).status, 400);
    assert.equal((await fetch(`${url}/mcp`, { method: 'POST', body: 'x'.repeat(2_000_001) })).status, 413);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
    assert.equal((await client.listTools()).tools.length, 9);
    const result = await client.callTool({ name: 'overleaf_list_projects', arguments: {} });
    assert.match(JSON.stringify(result), /Integration test/);
  } finally {
    await client.close();
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpServer } from '../src/http.js';
import type { OverleafApi } from '../src/tools.js';

test('loopback HTTP supports real MCP initialization, discovery and tool calls', async () => {
  const projectId = '0123456789abcdef01234567';
  const documentId = '1123456789abcdef01234567';
  const pdfUrl = `/project/${projectId}/output/output.pdf`;
  let source = { content: 'A document', version: 1 };
  const api = {
    listProjects: async () => [{ name: 'Integration test' }],
    getProject: async () => ({ _id: projectId, rootDoc_id: documentId, rootFolder: [{ _id: projectId, name: '', docs: [{ _id: documentId, name: 'main.tex' }], folders: [], fileRefs: [] }] }),
    readDocument: async () => ({ ...source }),
    compileProject: async () => ({ status: 'success', outputFiles: [{ path: 'output.pdf', url: pdfUrl }] }),
    readOutput: async () => ({ data: Buffer.from('%PDF-1.7\nHTTP fixture'), contentType: 'application/pdf' }),
  } as unknown as OverleafApi;
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
    assert.equal((await client.listTools()).tools.length, 13);
    const result = await client.callTool({ name: 'overleaf_list_projects', arguments: {} });
    assert.match(JSON.stringify(result), /Integration test/);
    const premature = await client.callTool({ name: 'overleaf_read_output', arguments: { project_id: projectId, output_url: pdfUrl } });
    assert.equal(premature.isError, true);
    const compilation = await client.callTool({ name: 'overleaf_compile_project', arguments: { project_id: projectId } });
    assert.equal(compilation.isError, false);
    const pdf = await client.callTool({ name: 'overleaf_read_output', arguments: { project_id: projectId, output_url: pdfUrl } });
    assert.notEqual(pdf.isError, true, 'Compile receipts must survive separate stateless HTTP requests');
    assert.ok((pdf.content as Array<{ type: string }>).some(item => item.type === 'resource'));
    source = { content: 'A collaborator changed the document', version: 2 };
    const stale = await client.callTool({ name: 'overleaf_read_output', arguments: { project_id: projectId, output_url: pdfUrl } });
    assert.equal(stale.isError, true);
  } finally {
    await client.close();
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
  }
});

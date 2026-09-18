import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, type OverleafApi } from '../src/tools.js';

const projectId = '0123456789abcdef01234567';
const documentId = '1123456789abcdef01234567';

export function fakeApi(overrides: Partial<OverleafApi> = {}): OverleafApi {
  return {
    listProjects: async () => [{ _id: projectId, name: 'Paper' }],
    createProject: async name => ({ project_id: projectId, name }),
    getProject: async () => ({ _id: projectId, rootDoc_id: documentId }),
    readDocument: async () => ({ content: 'original', version: 7, hash: 'abc' }),
    writeDocument: async (_p, _d, content, version) => {
      if (version !== 7) throw new Error('Version conflict: read the document again.');
      return { content, version: 8, concurrentChanges: false };
    },
    createDocument: async (_p, name) => ({ _id: documentId, name }),
    createFolder: async (_p, name) => ({ _id: documentId, name }),
    compileProject: async () => ({ status: 'success', outputFiles: [{ path: 'output.pdf' }] }),
    readOutput: async () => ({ data: Buffer.from('%PDF-1.7\nfixture'), contentType: 'application/pdf' }),
    ...overrides,
  };
}

async function connect(api: OverleafApi = fakeApi()) {
  const server = createMcpServer(api);
  const client = new Client({ name: 'integration-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test('MCP initialization advertises nine tools with correct action annotations', async () => {
  const { client, close } = await connect();
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 9);
    const write = tools.find(t => t.name === 'overleaf_write_document')!;
    assert.equal(write.annotations?.readOnlyHint, false);
    assert.equal(write.annotations?.destructiveHint, true);
    assert.ok(write.inputSchema.required?.includes('expected_version'));
    assert.equal(tools.find(t => t.name === 'overleaf_read_document')?.annotations?.readOnlyHint, true);
  } finally { await close(); }
});

test('protocol rejects missing version and invalid IDs before reaching adapter', async () => {
  let called = false;
  const { client, close } = await connect(fakeApi({ writeDocument: async () => { called = true; return {}; } }));
  try {
    const missingVersion = await client.callTool({ name: 'overleaf_write_document', arguments: { project_id: projectId, document_id: documentId, content: 'edit' } });
    assert.equal(missingVersion.isError, true);
    const invalidId = await client.callTool({ name: 'overleaf_write_document', arguments: { project_id: '../other', document_id: documentId, content: 'edit', expected_version: 7 } });
    assert.equal(invalidId.isError, true);
    assert.equal(called, false);
  } finally { await close(); }
});

test('read/write cycle sends version, reports conflicts and returns applied text', async () => {
  const { client, close } = await connect();
  try {
    const read = await client.callTool({ name: 'overleaf_read_document', arguments: { project_id: projectId, document_id: documentId } });
    assert.equal((read.structuredContent as { result: { version: number } }).result.version, 7);
    const conflict = await client.callTool({ name: 'overleaf_write_document', arguments: { project_id: projectId, document_id: documentId, content: 'edit', expected_version: 6 } });
    assert.equal(conflict.isError, true);
    const applied = await client.callTool({ name: 'overleaf_write_document', arguments: { project_id: projectId, document_id: documentId, content: 'edit', expected_version: 7 } });
    assert.deepEqual((applied.structuredContent as { result: unknown }).result, { content: 'edit', version: 8, concurrentChanges: false });
  } finally { await close(); }
});

test('compile failure remains visible and diagnostics remain readable', async () => {
  const { client, close } = await connect(fakeApi({
    compileProject: async () => ({ status: 'failure', outputFiles: [{ path: 'output.log' }] }),
    readOutput: async () => ({ data: Buffer.from('! Undefined control sequence.'), contentType: 'text/plain' }),
  }));
  try {
    const compilation = await client.callTool({ name: 'overleaf_compile_project', arguments: { project_id: projectId } });
    assert.equal((compilation.structuredContent as { result: { status: string } }).result.status, 'failure');
    const log = await client.callTool({ name: 'overleaf_read_output', arguments: { project_id: projectId, output_url: `/project/${projectId}/output/output.log` } });
    assert.match(JSON.stringify(log.content), /Undefined control sequence/);
  } finally { await close(); }
});

test('PDF is returned as an MCP resource with the actual bytes', async () => {
  const { client, close } = await connect();
  try {
    const pdf = await client.callTool({ name: 'overleaf_read_output', arguments: { project_id: projectId, output_url: `/project/${projectId}/output/output.pdf` } });
    const content = pdf.content as Array<{ type: string; resource?: { mimeType: string; blob: string } }>;
    const resource = content.find(item => item.type === 'resource')!.resource!;
    assert.equal(resource.mimeType, 'application/pdf');
    assert.equal(Buffer.from(resource.blob, 'base64').toString(), '%PDF-1.7\nfixture');
  } finally { await close(); }
});

test('credential headers do not escape via tool error strings', async () => {
  const { client, close } = await connect(fakeApi({ listProjects: async () => { throw new Error('Request failed\nCookie: session=secret\nAuthorization: Bearer secret'); } }));
  try {
    const response = await client.callTool({ name: 'overleaf_list_projects', arguments: {} });
    assert.equal(response.isError, true);
    assert.doesNotMatch(JSON.stringify(response), /session=secret|Bearer secret/);
  } finally { await close(); }
});

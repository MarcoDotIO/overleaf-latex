import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, type OverleafApi } from '../src/tools.js';

const projectId = '0123456789abcdef01234567';
const documentId = '1123456789abcdef01234567';
const pdfUrl = `/project/${projectId}/output/output.pdf`;
const logUrl = `/project/${projectId}/output/output.log`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export function fakeApi(overrides: Partial<OverleafApi> = {}): OverleafApi {
  let snapshot = { content: 'original', version: 7, hash: hash('original'), type: 'sharejs-text-ot' };
  return {
    listProjects: async () => [{ _id: projectId, name: 'Paper' }],
    createProject: async name => ({ project_id: projectId, name }),
    getProject: async () => ({ _id: projectId, rootDoc_id: documentId, rootFolder: [{ _id: projectId, name: '', docs: [{ _id: documentId, name: 'main.tex' }], folders: [], fileRefs: [] }] }),
    readDocument: async () => ({ ...snapshot }),
    writeDocument: async (_p, _d, content, version) => {
      if (version !== snapshot.version) throw new Error('Version conflict: read the document again.');
      snapshot = { ...snapshot, content, version: version + 1, hash: hash(content) };
      return { ...snapshot, concurrentChanges: false };
    },
    createDocument: async (_p, name) => ({ _id: documentId, name }),
    createFolder: async (_p, name) => ({ _id: documentId, name }),
    compileProject: async () => ({ status: 'success', outputFiles: [{ path: 'output.pdf', url: pdfUrl }] }),
    readOutput: async () => ({ data: Buffer.from('%PDF-1.7\nfixture'), contentType: 'application/pdf' }),
    ...overrides,
  };
}

async function connect(api: OverleafApi = fakeApi()) {
  const checkpointDir = mkdtempSync(join(tmpdir(), 'overleaf-mcp-edit-'));
  const previousDir = process.env.OVERLEAF_CHECKPOINT_DIR;
  process.env.OVERLEAF_CHECKPOINT_DIR = checkpointDir;
  const server = createMcpServer(api);
  if (previousDir === undefined) delete process.env.OVERLEAF_CHECKPOINT_DIR;
  else process.env.OVERLEAF_CHECKPOINT_DIR = previousDir;
  const client = new Client({ name: 'integration-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); rmSync(checkpointDir, { recursive: true, force: true }); } };
}

test('MCP initialization advertises thirteen tools with correct action annotations', async () => {
  const { client, close } = await connect();
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 13);
    const write = tools.find(t => t.name === 'overleaf_write_document')!;
    assert.equal(write.annotations?.readOnlyHint, false);
    assert.equal(write.annotations?.destructiveHint, true);
    assert.ok(write.inputSchema.required?.includes('expected_version'));
    const edit = tools.find(t => t.name === 'overleaf_edit_project')!;
    assert.equal(edit.annotations?.readOnlyHint, false);
    assert.equal(edit.annotations?.destructiveHint, true);
    assert.ok(edit.inputSchema.required?.includes('changes'));
    assert.equal(tools.find(t => t.name === 'overleaf_recover_edit')?.annotations?.destructiveHint, true);
    assert.equal(tools.find(t => t.name === 'overleaf_read_checkpoint')?.annotations?.readOnlyHint, true);
    assert.equal(tools.find(t => t.name === 'overleaf_read_compile_log')?.annotations?.readOnlyHint, true);
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

test('initialization sends version, reports conflicts and rejects replacement of existing text', async () => {
  let snapshot = { content: '', version: 7, hash: hash('') };
  const { client, close } = await connect(fakeApi({
    readDocument: async () => ({ ...snapshot }),
    writeDocument: async (_p, _d, content, version) => {
      assert.equal(version, snapshot.version);
      snapshot = { content, version: version + 1, hash: hash(content) };
      return { ...snapshot, concurrentChanges: false };
    },
  }));
  try {
    const read = await client.callTool({ name: 'overleaf_read_document', arguments: { project_id: projectId, document_id: documentId } });
    assert.equal((read.structuredContent as { result: { version: number } }).result.version, 7);
    const conflict = await client.callTool({ name: 'overleaf_write_document', arguments: { project_id: projectId, document_id: documentId, content: 'edit', expected_version: 6 } });
    assert.equal(conflict.isError, true);
    const applied = await client.callTool({ name: 'overleaf_write_document', arguments: { project_id: projectId, document_id: documentId, content: 'edit', expected_version: 7 } });
    assert.deepEqual((applied.structuredContent as { result: unknown }).result, { content: 'edit', version: 8, hash: hash('edit'), concurrentChanges: false });
    const blocked = await client.callTool({ name: 'overleaf_write_document', arguments: { project_id: projectId, document_id: documentId, content: '', expected_version: 8 } });
    assert.equal(blocked.isError, true);
    assert.equal(snapshot.content, 'edit');
  } finally { await close(); }
});

test('compile failure remains visible and diagnostics remain readable', async () => {
  const { client, close } = await connect(fakeApi({
    compileProject: async () => ({ status: 'failure', outputFiles: [{ path: 'output.log', url: logUrl }] }),
    readOutput: async () => ({ data: Buffer.from('! Undefined control sequence.'), contentType: 'text/plain' }),
  }));
  try {
    const compilation = await client.callTool({ name: 'overleaf_compile_project', arguments: { project_id: projectId } });
    assert.equal((compilation.structuredContent as { result: { status: string } }).result.status, 'failure');
    assert.equal(compilation.isError, true);
    const log = await client.callTool({ name: 'overleaf_read_output', arguments: { project_id: projectId, output_url: `/project/${projectId}/output/output.log` } });
    assert.match(JSON.stringify(log.content), /Undefined control sequence/);
  } finally { await close(); }
});

test('PDF is returned as an MCP resource with the actual bytes', async () => {
  const { client, close } = await connect();
  try {
    const premature = await client.callTool({ name: 'overleaf_read_output', arguments: { project_id: projectId, output_url: pdfUrl } });
    assert.equal(premature.isError, true);
    const compilation = await client.callTool({ name: 'overleaf_compile_project', arguments: { project_id: projectId } });
    assert.equal(compilation.isError, false);
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

test('checked edits require hashes, compile strictly, and return a checkpoint through MCP', async () => {
  const compileOptions: unknown[] = [];
  const { client, close } = await connect(fakeApi({
    compileProject: async (_projectId, options) => {
      compileOptions.push(options);
      return { status: 'success', outputFiles: [{ path: 'output.pdf', url: pdfUrl }] };
    },
  }));
  try {
    const missingHash = await client.callTool({ name: 'overleaf_edit_project', arguments: { project_id: projectId,
      changes: [{ document_id: documentId, expected_version: 7, patches: [{ search: 'original', replace: 'updated' }] }],
    } });
    assert.equal(missingHash.isError, true);
    assert.equal(compileOptions.length, 0);
    const applied = await client.callTool({ name: 'overleaf_edit_project', arguments: { project_id: projectId,
      changes: [{ document_id: documentId, expected_version: 7, expected_hash: hash('original'), patches: [{ search: 'original', replace: 'updated' }] }],
    } });
    assert.equal(applied.isError, false);
    const result = (applied.structuredContent as { result: { status: string; checkpoint_id: string } }).result;
    assert.equal(result.status, 'success');
    assert.equal(typeof result.checkpoint_id, 'string');
    assert.deepEqual(compileOptions, [{ rootDocId: documentId, stopOnFirstError: true }, { rootDocId: documentId, stopOnFirstError: true }]);
    const read = await client.callTool({ name: 'overleaf_read_document', arguments: { project_id: projectId, document_id: documentId } });
    assert.equal((read.structuredContent as { result: { content: string } }).result.content, 'updated');
    const checkpoint = await client.callTool({ name: 'overleaf_read_checkpoint', arguments: { project_id: projectId, checkpoint_id: result.checkpoint_id, document_id: documentId } });
    assert.equal((checkpoint.structuredContent as { result: { before_text: string } }).result.before_text, 'original');
  } finally { await close(); }
});

test('a rolled-back edit is an MCP error and exposes its failure and recovery', async () => {
  let compilations = 0;
  const { client, close } = await connect(fakeApi({
    compileProject: async () => ({ status: ++compilations === 2 ? 'failure' : 'success', outputFiles: [{ path: 'output.pdf', url: pdfUrl }, { path: 'output.log', url: logUrl }] }),
    readOutput: async () => ({ data: Buffer.from('! Undefined control sequence.\nl.3 \\broken'), contentType: 'text/plain' }),
  }));
  try {
    const applied = await client.callTool({ name: 'overleaf_edit_project', arguments: { project_id: projectId,
      changes: [{ document_id: documentId, expected_version: 7, expected_hash: hash('original'), patches: [{ search: 'original', replace: 'broken' }] }],
    } });
    assert.equal(applied.isError, true);
    const outcome = (applied.structuredContent as { result: { status: string; checkpoint_id: string; failed_compilation: { status: string } } }).result;
    assert.equal(outcome.status, 'rolled_back');
    assert.equal(outcome.failed_compilation.status, 'failure');
    assert.equal(compilations, 3);
    const read = await client.callTool({ name: 'overleaf_read_document', arguments: { project_id: projectId, document_id: documentId } });
    assert.equal((read.structuredContent as { result: { content: string } }).result.content, 'original');
    const log = await client.callTool({ name: 'overleaf_read_compile_log', arguments: { project_id: projectId, output_url: logUrl, offset: 0, length: 12 } });
    const page = (log.structuredContent as { result: { text: string; next_offset: number; complete: boolean } }).result;
    assert.equal(page.text, '! Undefined ');
    assert.equal(page.next_offset, 12);
    assert.equal(page.complete, false);
  } finally { await close(); }
});

test('MCP rejects continue-on-error compilation before reaching the adapter', async () => {
  let called = false;
  const { client, close } = await connect(fakeApi({ compileProject: async () => { called = true; return {}; } }));
  try {
    const response = await client.callTool({ name: 'overleaf_compile_project', arguments: { project_id: projectId, stop_on_first_error: false } });
    assert.equal(response.isError, true);
    assert.equal(called, false);
  } finally { await close(); }
});

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicitly opt in: this creates/edits a real project in the connected account.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifacts = join(root, 'artifacts');
const receiptFile = join(artifacts, 'live-receipt.json');
const mode = process.argv[2];
if (!['--create', '--resume'].includes(mode)) {
  console.error('Usage: npm run live-check -- --create | --resume');
  process.exit(1);
}
let receipt;
try { receipt = JSON.parse(await readFile(receiptFile, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (mode === '--create' && receipt?.projectId) throw new Error('A test project already exists in artifacts/live-receipt.json; use --resume.');
if (mode === '--resume' && !receipt?.projectId) throw new Error('No saved test project to resume. Use --create to opt into creating one.');
receipt ??= { startedAt: new Date().toISOString() };
await mkdir(artifacts, { recursive: true });
async function save(stage) {
  receipt.stage = stage;
  await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

const client = new Client({ name: 'overleaf-live-verification', version: '1.0.0' });
async function call(name, args) {
  const response = await client.callTool({ name: `overleaf_${name}`, arguments: args }, undefined, { timeout: 240_000 });
  if (response.isError) throw new Error(response.content.filter(item => item.type === 'text').map(item => item.text).join('\n'));
  return response;
}
async function data(name, args) { return (await call(name, args)).structuredContent?.result; }
function entityId(value) {
  const id = value?._id ?? value?.id ?? value?.doc_id ?? value?.folder_id;
  if (!/^[a-f\d]{24}$/i.test(id ?? '')) throw new Error('Unexpected created entity identifier; inspect the project before retrying.');
  return id;
}

try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'dist/server.js')] }));
  receipt.toolCount = (await client.listTools()).tools.length;
  const projects = await data('list_projects', {});
  receipt.authenticationVerified = Array.isArray(projects);
  if (!receipt.projectId) {
    const created = await data('create_project', { name: 'ChatGPT Overleaf Plugin Verification', template: 'blank' });
    receipt.projectId = created.project_id;
    if (!receipt.projectId) throw new Error('Project creation response did not contain an ID. Check Overleaf before creating another.');
    receipt.projectUrl = `https://www.overleaf.com/project/${receipt.projectId}`;
    await save('project_created');
    console.log(`Created ${receipt.projectUrl}`);
  }
  const project = { project_id: receipt.projectId };
  // Use dedicated empty files; never replace an existing template or user source.
  for (const [key, name] of [['checkedPreambleId', 'mcp-checked-preamble.tex'], ['checkedRootId', 'mcp-checked-main.tex']]) {
    if (!receipt[key]) {
      receipt[key] = entityId(await data('create_document', { ...project, name }));
      await save(`${key}_created`);
    }
  }
  const preamble = String.raw`\newcommand{\mcpmetric}[1]{\mathsf{#1}}
`;
  const latex = String.raw`\documentclass{article}
\input{mcp-checked-preamble}
\begin{document}
\section{Checked edit verification}
The measured quantity is $\mcpmetric{x}$.
This is a disposable MCP acceptance document.
\end{document}
`;
  for (const [id, content] of [[receipt.checkedPreambleId, preamble], [receipt.checkedRootId, latex]]) {
    const before = await data('read_document', { ...project, document_id: id });
    if (!before.content) await data('write_document', { ...project, document_id: id, content, expected_version: before.version });
    else if (before.content !== content) throw new Error('The dedicated test source differs from its fixture. Inspect it and recovery checkpoints before resuming.');
  }
  const before = await data('read_document', { ...project, document_id: receipt.checkedPreambleId });
  // Deliberately break only the disposable preamble, then require conditional recovery.
  const broken = await client.callTool({ name: 'overleaf_edit_project', arguments: {
    ...project, root_document_id: receipt.checkedRootId,
    changes: [{ document_id: receipt.checkedPreambleId, expected_version: before.version, expected_hash: before.hash,
      patches: [{ search: '\\newcommand{\\mcpmetric}', replace: '\\newcommand{\\mcprenamedmetric}' }] }],
  } }, undefined, { timeout: 600_000 });
  const recovery = broken.structuredContent?.result;
  receipt.recoveryStatus = recovery?.status;
  receipt.checkpointId = recovery?.checkpoint_id;
  await save('recovery_checked');
  if (recovery?.status !== 'rolled_back') throw new Error('The recovery scenario needs attention; inspect its checkpoint before retrying.');
  const after = await data('read_document', { ...project, document_id: receipt.checkedPreambleId });
  if (after.content !== preamble) throw new Error('Recovered preamble did not match the fixture.');
  receipt.verifiedContent = true;
  const compile = await data('compile_project', { ...project, root_document_id: receipt.checkedRootId });
  receipt.compileStatus = compile.status;
  const log = compile.outputFiles?.find(file => file.path === 'output.log');
  if (log) {
    const response = await call('read_output', { ...project, output_url: log.url });
    await writeFile(join(artifacts, 'output.log'), response.content.filter(item => item.type === 'text').map(item => item.text).join('\n'));
  }
  const pdf = compile.outputFiles?.find(file => file.path === 'output.pdf');
  if (compile.status !== 'success' || !pdf) { await save('compile_failed'); throw new Error('Compilation did not succeed; inspect artifacts/output.log and the project.'); }
  const output = await call('read_output', { ...project, output_url: pdf.url });
  const resource = output.content.find(item => item.type === 'resource')?.resource;
  if (!resource?.blob) throw new Error('No PDF bytes were returned.');
  const bytes = Buffer.from(resource.blob, 'base64');
  if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('Output is not a PDF.');
  receipt.pdfPath = join(artifacts, 'overleaf-plugin-test.pdf');
  receipt.pdfBytes = bytes.length;
  await writeFile(receipt.pdfPath, bytes);
  receipt.completedAt = new Date().toISOString();
  await save('complete');
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Live verification failed.');
  process.exitCode = 1;
} finally {
  await client.close();
}

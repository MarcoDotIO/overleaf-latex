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
  const tree = await data('get_project', project);
  receipt.rootDocumentId = tree.rootDoc_id;
  if (!receipt.rootDocumentId) throw new Error('Project has no root document. Open it in Overleaf to choose main.tex.');
  if (!receipt.folderId) {
    receipt.folderId = entityId(await data('create_folder', { ...project, name: 'sections' }));
    await save('folder_created');
  }
  if (!receipt.sectionDocumentId) {
    receipt.sectionDocumentId = entityId(await data('create_document', { ...project, name: 'verification.tex', parent_folder_id: receipt.folderId }));
    await save('section_created');
  }
  const section = { ...project, document_id: receipt.sectionDocumentId };
  const beforeSection = await data('read_document', section);
  await data('write_document', { ...section, expected_version: beforeSection.version, content: '\\section{Connection verified}\nThis document was created, edited, and compiled through the Overleaf MCP plugin.\nThe login uses the owner\'s normal Google sign-in to Overleaf.\n' });
  const document = { ...project, document_id: receipt.rootDocumentId };
  const before = await data('read_document', document);
  const latex = String.raw`\documentclass{article}
\usepackage[T1]{fontenc}
\usepackage{amsmath}
\usepackage[margin=1in]{geometry}
\title{Overleaf Plugin Verification}
\author{Created with ChatGPT}
\date{\today}
\begin{document}
\maketitle
\input{sections/verification.tex}
\section{LaTeX compilation}
The plugin supports complete LaTeX documents, equations, and included source files.
For example, the Monte Carlo estimate of an expectation is
\[
  \widehat{\mu}_N = \frac{1}{N}\sum_{i=1}^{N} f(X_i).
\]
Source updates are submitted with a document version and checked after Overleaf confirms application.
\end{document}
`;
  const after = await data('write_document', { ...document, content: latex, expected_version: before.version });
  receipt.documentVersion = after.version;
  receipt.documentType = after.type;
  receipt.verifiedContent = after.content === latex;
  if (!receipt.verifiedContent) throw new Error('Concurrent changes detected; inspect the test document before continuing.');
  await save('source_verified');
  const compile = await data('compile_project', project);
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

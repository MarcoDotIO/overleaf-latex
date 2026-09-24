// Local long-paper regression: actual plugin + MCP, synthetic Overleaf I/O, real Tectonic.
// No account session, network Overleaf operations, or user documents are used.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OverleafClient } from '../dist/overleaf-client.js';
import { sessionFromCookieHeader } from '../dist/session.js';
import { createMcpServer } from '../dist/tools.js';

const run = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = join(projectRoot, 'artifacts/checked-edit-local');
process.env.OVERLEAF_CHECKPOINT_DIR = join(root, 'checkpoints');
const paper = join(root, 'paper');
const compiler = process.env.AUDIT_TECTONIC ?? 'tectonic';
const projectId = '0123456789abcdef01234567';
const docs = new Map();
let nextId = 1;
let compileCount = 0;
let updateCount = 0;
const builds = new Map();
const sha = text => createHash('sha256').update(text).digest('hex');
await mkdir(paper, { recursive: true });
async function add(name, content) {
  const id = (nextId++).toString(16).padStart(24, '0');
  docs.set(id, { name, content, version: 0 });
  await mkdir(dirname(join(paper, name)), { recursive: true });
  await writeFile(join(paper, name), content);
  return id;
}
const preamble = String.raw`\usepackage{amsmath}
\newcommand{\metric}[1]{\mathsf{#1}}
\newcommand{\methodname}{ExampleMethod}
\newcommand{\resultref}[1]{Section~\ref{#1}}
`;
const preambleId = await add('preamble.tex', preamble);
const main = String.raw`\documentclass[11pt]{article}
\input{preamble}
\begin{document}
\title{Synthetic Long-Paper Edit-Safety Fixture}
\author{Local Test}
\maketitle
This generated document is an integration test, not a research result.
\tableofcontents
\clearpage
` + Array.from({ length: 12 }, (_, i) => `\\input{chapters/chapter-${i + 1}}\n`).join('') + '\\end{document}\n';
const rootId = await add('main.tex', main);
let chapterId;
for (let chapter = 1; chapter <= 12; chapter++) {
  let source = `\\section{Chapter ${chapter}}\\label{sec:${chapter}}\n`;
  for (let page = 1; page <= 4; page++) {
    source += `\\subsection{Analysis ${chapter}.${page}}\n`;
    for (let para = 0; para < 5; para++) source += String.raw`The method \methodname{} evaluates the quantity $\metric{x}$ using the shared preamble. This paragraph deliberately exercises a custom macro in every source fragment. Definitions in one file affect the entire paper, including \resultref{sec:1}. We preserve equation syntax, citations by label, and surrounding prose when making a local edit.

`;
    source += String.raw`\begin{equation}\metric{x}_{t+1}=\metric{x}_t+1\end{equation}
\clearpage
`;
  }
  const id = await add(`chapters/chapter-${chapter}.tex`, source);
  if (chapter === 6) chapterId = id;
}
const initialHashes = Object.fromEntries([...docs].map(([id, d]) => [id, sha(d.content)]));
const trace = [];
const socketFactory = async () => {
  const events = new EventEmitter();
  return {
    project: { _id: projectId, rootDoc_id: rootId, rootFolder: [{ _id: 'f'.repeat(24), name: '', docs: [...docs].map(([id, d]) => ({ _id: id, name: d.name })), folders: [], fileRefs: [] }] },
    on(event, listener) { events.on(event, listener); return () => events.off(event, listener); },
    close() {},
    async request(event, args) {
      const doc = docs.get(args[0]);
      assert.ok(doc);
      if (event === 'joinDoc') return [{ content: doc.content }, doc.version, [], {}, 'history-ot'];
      assert.equal(event, 'applyOtUpdate');
      const message = args[1];
      assert.equal(message.v, doc.version);
      let cursor = 0, after = '';
      for (const component of message.op[0].textOperation) {
        if (typeof component === 'string') after += component;
        else if (component > 0) { after += doc.content.slice(cursor, cursor + component); cursor += component; }
        else cursor -= component;
      }
      assert.equal(cursor, doc.content.length);
      const oldVersion = doc.version;
      doc.content = after;
      doc.version++;
      updateCount++;
      await writeFile(join(paper, doc.name), after);
      events.emit('otUpdateApplied', { doc: args[0], v: oldVersion });
      return [];
    },
  };
};
async function compile(options) {
  const build = `local-${++compileCount}`;
  const out = join(root, build);
  await mkdir(out, { recursive: true });
  let stdout = '', stderr = '', code = 0;
  try {
    ({ stdout, stderr } = await run(compiler, ['--untrusted', '--keep-logs', '--outdir', out, 'main.tex'], { cwd: paper, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 }));
  } catch (error) {
    stdout = error.stdout ?? ''; stderr = error.stderr ?? ''; code = error.code;
    if (typeof code !== 'number') throw error;
  }
  let log;
  try { log = await readFile(join(out, 'main.log')); } catch { log = Buffer.from(stdout + stderr); }
  await writeFile(join(out, 'compiler-console.txt'), stdout + stderr);
  const files = new Map([['output.log', log]]);
  if (code === 0) files.set('output.pdf', await readFile(join(out, 'main.pdf')));
  builds.set(build, files);
  const result = { status: code === 0 ? 'success' : 'failure', outputFiles: [...files.keys()].map(path => ({ path, url: `/project/${projectId}/build/${build}/output/${path}` })) };
  trace.push({ build, compiler_exit_code: code, status: result.status, requested_stop_on_first_error: options.stopOnFirstError, source_versions: Object.fromEntries([...docs].map(([id, d]) => [d.name, d.version])) });
  console.log(JSON.stringify({ build, status: result.status }));
  return result;
}
const api = new OverleafClient({
  loadSession: async () => sessionFromCookieHeader('overleaf.sid=synthetic-local-only'),
  socketFactory,
  fetch: async (value, init) => {
    const url = new URL(value);
    assert.equal(url.origin, 'https://www.overleaf.com');
    if (url.pathname === '/project') return new Response('<meta name="ol-csrfToken" content="synthetic">', { headers: { 'content-type': 'text/html' } });
    if (url.pathname.endsWith('/compile')) return Response.json(await compile(JSON.parse(init.body)));
    const match = url.pathname.match(/\/build\/(local-\d+)\/output\/(output\.(?:log|pdf))$/);
    assert.ok(match, `Unexpected fake request ${url.pathname}`);
    const bytes = builds.get(match[1]).get(match[2]);
    return new Response(bytes, { headers: { 'content-type': match[2].endsWith('.pdf') ? 'application/pdf' : 'text/plain' } });
  },
});
const server = createMcpServer(api);
const client = new Client({ name: 'local-long-paper-audit', version: '1' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
async function call(name, args = {}) {
  const response = await client.callTool({ name: `overleaf_${name}`, arguments: { project_id: projectId, ...args } }, undefined, { timeout: 240_000 });
  assert.notEqual(response.isError, true, JSON.stringify(response));
  return response;
}
async function read(id) { return (await call('read_document', { document_id: id })).structuredContent.result; }
async function edit(id, search, replace) {
  const current = await read(id);
  return client.callTool({ name: 'overleaf_edit_project', arguments: {
    project_id: projectId, root_document_id: rootId,
    changes: [{ document_id: id, expected_version: current.version, expected_hash: current.hash, patches: [{ search, replace }] }],
  } }, undefined, { timeout: 600_000 });
}
async function compileTool() { return await call('compile_project', { root_document_id: rootId }); }
try {
  const baseline = (await compileTool()).structuredContent.result;
  assert.equal(baseline.status, 'success');
  const initialPdf = baseline.outputFiles.find(f => f.path === 'output.pdf');
  const scopedResponse = await edit(chapterId, 'a local edit.', 'a carefully scoped edit.');
  // The source intentionally repeats paragraphs. Ambiguous edits must fail untouched.
  assert.equal(scopedResponse.isError, true);
  assert.equal(updateCount, 0);
  const scoped = await edit(chapterId, '\\subsection{Analysis 6.1}', '\\subsection{Revised analysis 6.1}');
  assert.notEqual(scoped.isError, true, JSON.stringify(scoped));
  assert.equal(scoped.structuredContent.result.status, 'success');
  assert.ok([...docs].filter(([id]) => id !== chapterId).every(([id, d]) => sha(d.content) === initialHashes[id]));
  const stale = await client.callTool({ name: 'overleaf_read_output', arguments: { project_id: projectId, output_url: initialPdf.url } });
  assert.equal(stale.isError, true);
  const broken = await edit(preambleId, '\\newcommand{\\metric}', '\\newcommand{\\renamedmetric}');
  assert.equal(broken.isError, true);
  const outcome = broken.structuredContent.result;
  assert.equal(outcome.status, 'rolled_back', JSON.stringify(outcome));
  assert.equal((await read(preambleId)).content, preamble);
  assert.match(JSON.stringify(outcome.failed_compilation.diagnostics), /Undefined control sequence/i);
  assert.equal(outcome.compilation.status, 'success');
  assert.equal(updateCount, 3); // chapter patch, invalid macro patch, inverse restoration
  const pdf = outcome.compilation.outputFiles.find(f => f.path === 'output.pdf');
  const response = await call('read_output', { output_url: pdf.url });
  const resource = response.content.find(item => item.type === 'resource').resource;
  const bytes = Buffer.from(resource.blob, 'base64');
  assert.ok(bytes.subarray(0, 5).equals(Buffer.from('%PDF-')));
  await writeFile(join(root, 'verified-paper.pdf'), bytes);
  const receipt = {
    checked_at: new Date().toISOString(), environment: 'LOCAL: actual plugin/MCP and Tectonic, synthetic Overleaf I/O; no account access.',
    files: docs.size, chapters: 12, source_characters: [...docs.values()].reduce((n, d) => n + d.content.length, 0),
    checks: { baseline_compiled: true, ambiguous_patch_rejected_without_write: true, scoped_edit_compiled: true,
      other_files_preserved: true, old_pdf_rejected: true, broken_shared_macro_automatically_restored: true,
      recovery_compiled: true, latest_pdf_retrieved: true, mutations: updateCount },
    checkpoint_id: outcome.checkpoint_id, pdf_bytes: bytes.length,
    source_sha256: Object.fromEntries(await Promise.all(['tools.ts', 'overleaf-client.ts', 'edit-workflow.ts', 'patches.ts', 'output-slices.ts'].map(async name => [name, sha(await readFile(join(projectRoot, 'src', name)))]))),
    compile_trace: trace,
  };
  await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ ...receipt, compile_trace: trace.map(({ build, status }) => ({ build, status })) }, null, 2));
} finally { await client.close(); await server.close(); }

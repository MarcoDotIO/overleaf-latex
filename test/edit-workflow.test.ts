import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditWorkflow } from '../src/edit-workflow.js';
import { OverleafError, type DocumentSnapshot } from '../src/overleaf-client.js';
import type { OverleafApi } from '../src/tools.js';

const PROJECT = '0123456789abcdef01234567';
const ROOT = '1123456789abcdef01234567';
const PREAMBLE = '2123456789abcdef01234567';
const CHAPTER = '3123456789abcdef01234567';
const FOLDER = '4123456789abcdef01234567';
type Patch = { search: string; replace: string };
type Write = { documentId: string; content: string; expectedVersion: number };
type CompileOptions = { rootDocId?: string; stopOnFirstError?: boolean };
const hash = (content: string) => createHash('sha256').update(content).digest('hex');

function snapshot(content: string, version = 1): DocumentSnapshot {
  return { content, version, hash: hash(content), type: 'sharejs-text-ot' };
}

/** Fake transport with independently mutable collaborator state and write acknowledgements. */
class ProjectFixture implements OverleafApi {
  projectId = PROJECT;
  docs = new Map<string, DocumentSnapshot>([
    [ROOT, snapshot('\\documentclass{article}\n\\input{preamble}\n\\begin{document}\n\\input{chapter}\n\\end{document}\n')],
    [PREAMBLE, snapshot('\\newcommand{\\sharedmacro}{shared text}\n')],
    [CHAPTER, snapshot('\\section{Introduction}\nA short paragraph using \\sharedmacro.\n')],
  ]);
  writes: Write[] = [];
  compiles: CompileOptions[] = [];
  reads: string[] = [];
  outputReads: string[] = [];
  events: string[] = [];
  compileStatuses: string[] = [];
  beforeWrite?: (write: Write) => Promise<void> | void;
  afterWrite?: (write: Write) => Promise<void> | void;
  beforeCompile?: (number: number) => Promise<void> | void;
  afterOutput?: () => Promise<void> | void;

  workflow(t: TestContext) {
    const checkpointDir = mkdtempSync(join(tmpdir(), 'overleaf-checked-edit-'));
    t.after(() => rmSync(checkpointDir, { recursive: true, force: true }));
    return new EditWorkflow(this, { checkpointDir });
  }

  pdfReads() { return this.outputReads.filter(url => url.includes('output.pdf')); }

  async listProjects() { return [{ _id: PROJECT, name: 'Shared preamble paper' }]; }
  async createProject(name: string) { return { _id: PROJECT, name }; }
  async createDocument(_projectId: string, name: string) { return { _id: CHAPTER, name }; }
  async createFolder(_projectId: string, name: string) { return { _id: FOLDER, name }; }
  async getProject() {
    return {
      _id: this.projectId, rootDoc_id: ROOT,
      rootFolder: [{ _id: FOLDER, name: '', docs: [...this.docs.keys()].map((_id, i) => ({ _id, name: ['main.tex', 'preamble.tex', 'chapter.tex'][i] ?? `file-${i}.tex` })), folders: [], fileRefs: [] }],
    };
  }
  async readDocument(_projectId: string, documentId: string) {
    this.reads.push(documentId);
    const value = this.docs.get(documentId);
    assert.ok(value, `Unexpected document ${documentId}`);
    return { ...value };
  }
  mutate(documentId: string, content: string) {
    const previous = this.docs.get(documentId)!;
    this.docs.set(documentId, snapshot(content, previous.version + 1));
  }
  async writeDocument(_projectId: string, documentId: string, content: string, expectedVersion: number) {
    const write = { documentId, content, expectedVersion };
    this.events.push(`write:${documentId}`);
    await this.beforeWrite?.(write);
    const current = this.docs.get(documentId)!;
    if (current.version !== expectedVersion) throw new OverleafError('VERSION_CONFLICT', 'A collaborator changed the document.');
    this.writes.push(write);
    this.mutate(documentId, content);
    await this.afterWrite?.(write);
    return { ...this.docs.get(documentId)!, applied: true, concurrentChanges: this.docs.get(documentId)!.content !== content };
  }
  async patchDocument(projectId: string, documentId: string, patches: Patch[], expectedVersion: number) {
    let content = this.docs.get(documentId)!.content;
    for (const patch of patches) {
      assert.equal(content.split(patch.search).length, 2, 'Fixture patches must match exactly once');
      content = content.replace(patch.search, () => patch.replace);
    }
    return this.writeDocument(projectId, documentId, content, expectedVersion);
  }
  async compileProject(_projectId: string, options: CompileOptions = {}) {
    this.compiles.push({ ...options });
    this.events.push(`compile:${this.compiles.length}`);
    await this.beforeCompile?.(this.compiles.length);
    const build = this.compiles.length;
    return { status: this.compileStatuses[build - 1] ?? 'success', outputFiles: [
      { path: 'output.pdf', url: `/project/${this.projectId}/output/output.pdf?build=${build}` },
      { path: 'output.log', url: `/project/${this.projectId}/output/output.log?build=${build}` },
    ] };
  }
  async readOutput(_projectId: string, outputUrl: string) {
    this.outputReads.push(outputUrl);
    const output = outputUrl.includes('output.log')
      ? { data: Buffer.from('This is pdfTeX\n! Undefined control sequence.\nl.3 \\missingmacro\n'), contentType: 'text/plain' }
      : { data: Buffer.from('%PDF-1.7\nsynthetic fixture'), contentType: 'application/pdf' };
    await this.afterOutput?.();
    return output;
  }
}

function change(fixture: ProjectFixture, documentId = CHAPTER, search = 'short paragraph', replace = 'clear paragraph') {
  const before = fixture.docs.get(documentId)!;
  return { documentId, expectedVersion: before.version, expectedHash: before.hash, patches: [{ search, replace }] };
}

test('checked edit compiles the shared root before and after a bounded chapter patch', async t => {
  const fixture = new ProjectFixture();
  const originalRoot = { ...fixture.docs.get(ROOT)! };
  const originalPreamble = { ...fixture.docs.get(PREAMBLE)! };
  const result = await fixture.workflow(t).editProject(PROJECT, { changes: [change(fixture)] });
  assert.equal(result.status, 'success');
  assert.equal(fixture.docs.get(CHAPTER)!.content.includes('clear paragraph'), true);
  assert.deepEqual(fixture.docs.get(ROOT), originalRoot);
  assert.deepEqual(fixture.docs.get(PREAMBLE), originalPreamble);
  assert.equal(fixture.writes.length, 1);
  assert.equal(fixture.events[0], 'compile:1');
  assert.equal(fixture.compiles.length, 2);
  assert.ok(fixture.compiles.every(options => options.stopOnFirstError === true && options.rootDocId === ROOT));
  for (const id of [ROOT, PREAMBLE, CHAPTER]) assert.ok(fixture.reads.includes(id), 'Checkpoint includes every source file');
});

test('failed baseline compilation makes no changes even when a PDF is present', async t => {
  const fixture = new ProjectFixture();
  fixture.compileStatuses = ['failure'];
  const before = structuredClone([...fixture.docs]);
  const result = await fixture.workflow(t).editProject(PROJECT, { changes: [change(fixture)] });
  assert.equal(result.status, 'baseline_failed');
  assert.equal(fixture.writes.length, 0);
  assert.deepEqual([...fixture.docs], before);
});

test('a failed edit compilation restores only acknowledged unchanged writes and verifies recovery', async t => {
  const fixture = new ProjectFixture();
  fixture.compileStatuses = ['success', 'failure', 'success'];
  const original = fixture.docs.get(PREAMBLE)!.content;
  const result = await fixture.workflow(t).editProject(PROJECT, {
    changes: [change(fixture, PREAMBLE, '\\sharedmacro', '\\renamedmacro')],
  });
  assert.equal(result.status, 'rolled_back');
  assert.equal(fixture.docs.get(PREAMBLE)!.content, original);
  assert.equal(fixture.writes.length, 2);
  assert.equal(fixture.writes[1]!.expectedVersion, 2);
  assert.equal(fixture.compiles.length, 3);
});

test('a collaborator change in an edited file is never overwritten during recovery', async t => {
  const fixture = new ProjectFixture();
  fixture.compileStatuses = ['success', 'failure'];
  fixture.beforeCompile = number => {
    if (number === 2) fixture.mutate(CHAPTER, fixture.docs.get(CHAPTER)!.content + '% collaborator addition\n');
  };
  const result = await fixture.workflow(t).editProject(PROJECT, { changes: [change(fixture)] });
  assert.equal(result.status, 'recovery_required');
  assert.equal(fixture.writes.length, 1);
  assert.match(fixture.docs.get(CHAPTER)!.content, /collaborator addition/);
  assert.equal(typeof result.checkpoint_id, 'string');
});

test('a collaborator change with identical final text still prevents restoration at a newer version', async t => {
  const fixture = new ProjectFixture();
  fixture.compileStatuses = ['success', 'failure'];
  fixture.beforeCompile = number => {
    if (number === 2) fixture.mutate(CHAPTER, fixture.docs.get(CHAPTER)!.content);
  };
  const result = await fixture.workflow(t).editProject(PROJECT, { changes: [change(fixture)] });
  assert.equal(result.status, 'recovery_required');
  assert.equal(fixture.writes.length, 1);
  assert.match(fixture.docs.get(CHAPTER)!.content, /clear paragraph/);
});

test('failed recovery compilation is reported as requiring recovery despite successful source restoration', async t => {
  const fixture = new ProjectFixture();
  fixture.compileStatuses = ['success', 'failure', 'failure'];
  const original = fixture.docs.get(CHAPTER)!.content;
  const result = await fixture.workflow(t).editProject(PROJECT, { changes: [change(fixture)] });
  assert.equal(result.status, 'recovery_required');
  assert.equal(fixture.docs.get(CHAPTER)!.content, original);
  assert.equal(fixture.compiles.length, 3);
});

test('an unrelated source change invalidates baseline approval before the first write', async t => {
  const fixture = new ProjectFixture();
  fixture.beforeCompile = number => {
    if (number === 1) fixture.mutate(PREAMBLE, fixture.docs.get(PREAMBLE)!.content + '% collaborator baseline change\n');
  };
  const result = await fixture.workflow(t).editProject(PROJECT, { changes: [change(fixture)] });
  assert.equal(result.status, 'baseline_failed');
  assert.equal(fixture.writes.length, 0);
  assert.match(fixture.docs.get(PREAMBLE)!.content, /collaborator baseline change/);
});

test('stale versions and hashes fail before mutation', async t => {
  for (const field of ['expectedVersion', 'expectedHash'] as const) {
    const fixture = new ProjectFixture();
    const edit = change(fixture);
    if (field === 'expectedVersion') edit.expectedVersion -= 1;
    else edit.expectedHash = '0'.repeat(64);
    await assert.rejects(fixture.workflow(t).editProject(PROJECT, { changes: [edit] }));
    assert.equal(fixture.writes.length, 0);
  }
});

test('an explicitly rejected second batch write restores the first without touching the second', async t => {
  const fixture = new ProjectFixture();
  const original = fixture.docs.get(CHAPTER)!.content;
  fixture.beforeWrite = write => {
    if (write.documentId === PREAMBLE) throw new OverleafError('WRITE_REJECTED', 'Server refused this edit.');
  };
  const result = await fixture.workflow(t).editProject(PROJECT, {
    changes: [change(fixture), change(fixture, PREAMBLE, 'shared text', 'updated shared text')],
  });
  assert.equal(result.status, 'rolled_back');
  assert.equal(fixture.docs.get(CHAPTER)!.content, original);
  assert.deepEqual(fixture.writes.map(write => write.documentId), [CHAPTER, CHAPTER]);
});

test('an ambiguous write acknowledgement never triggers a retry or automatic overwrite', async t => {
  const fixture = new ProjectFixture();
  fixture.afterWrite = () => { throw new OverleafError('WRITE_STATE_UNKNOWN', 'Disconnected after submission.'); };
  const result = await fixture.workflow(t).editProject(PROJECT, { changes: [change(fixture)] });
  assert.equal(result.status, 'recovery_required');
  assert.equal(fixture.writes.length, 1);
  assert.match(fixture.docs.get(CHAPTER)!.content, /clear paragraph/);
  assert.equal(typeof result.checkpoint_id, 'string');
});

test('edit batches enforce file and changed-character limits before writes', async t => {
  const fixture = new ProjectFixture();
  for (let i = 5; i < 11; i++) fixture.docs.set(String(i).padStart(24, '0'), snapshot(`unique-${i}`));
  const changes = [...fixture.docs.keys()].slice(3).map(documentId => change(fixture, documentId, fixture.docs.get(documentId)!.content, 'replacement'));
  const workflow = fixture.workflow(t);
  await assert.rejects(workflow.editProject(PROJECT, { changes }));
  await assert.rejects(workflow.editProject(PROJECT, { changes: [change(fixture, CHAPTER, 'short paragraph', 'x'.repeat(20_001))] }));
  assert.equal(fixture.writes.length, 0);
});

test('same-project operations serialize through the whole compile/edit transaction', async t => {
  const fixture = new ProjectFixture();
  let release!: () => void;
  let entered!: () => void;
  const enteredBaseline = new Promise<void>(resolve => { entered = resolve; });
  const blockedBaseline = new Promise<void>(resolve => { release = resolve; });
  fixture.beforeCompile = async number => {
    if (number === 1) { entered(); await blockedBaseline; }
  };
  const workflow = fixture.workflow(t);
  const first = workflow.editProject(PROJECT, { changes: [change(fixture)] });
  await enteredBaseline;
  const second = workflow.compileProject(PROJECT);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(fixture.compiles.length, 1, 'A second compile must not interleave with the pending edit baseline');
  release();
  assert.equal((await first).status, 'success');
  await second;
  assert.deepEqual(fixture.events, ['compile:1', `write:${CHAPTER}`, 'compile:2', 'compile:3']);
});

test('initialization rejects existing content and accepts only a freshly empty file at its current version', async t => {
  const fixture = new ProjectFixture();
  const workflow = fixture.workflow(t);
  await assert.rejects(workflow.initializeDocument(PROJECT, CHAPTER, 'Replacement', 1));
  assert.equal(fixture.writes.length, 0);
  fixture.docs.set(CHAPTER, snapshot('', 4));
  await assert.rejects(workflow.initializeDocument(PROJECT, CHAPTER, 'New content', 3));
  await workflow.initializeDocument(PROJECT, CHAPTER, 'New content', 4);
  assert.equal(fixture.docs.get(CHAPTER)!.content, 'New content');
  assert.equal(fixture.writes.length, 1);
});

test('PDF output requires a successful fresh compile receipt for the complete source snapshot', async t => {
  const fixture = new ProjectFixture();
  const workflow = fixture.workflow(t);
  const firstPdf = `/project/${PROJECT}/output/output.pdf?build=1`;
  await assert.rejects(workflow.readOutput(PROJECT, firstPdf));
  assert.equal(fixture.pdfReads().length, 0);
  await workflow.compileProject(PROJECT);
  const pdf = await workflow.readOutput(PROJECT, firstPdf);
  assert.equal(pdf.data.subarray(0, 5).toString(), '%PDF-');
  fixture.mutate(PREAMBLE, fixture.docs.get(PREAMBLE)!.content + '% changed shared preamble\n');
  await assert.rejects(workflow.readOutput(PROJECT, firstPdf));
  assert.equal(fixture.pdfReads().length, 1, 'Stale PDF must not be downloaded');
});

test('a failed later compile revokes the previous PDF even if the latest response lists a PDF', async t => {
  const fixture = new ProjectFixture();
  fixture.compileStatuses = ['success', 'failure'];
  const workflow = fixture.workflow(t);
  await workflow.compileProject(PROJECT);
  await workflow.compileProject(PROJECT);
  await assert.rejects(workflow.readOutput(PROJECT, `/project/${PROJECT}/output/output.pdf?build=1`));
  await assert.rejects(workflow.readOutput(PROJECT, `/project/${PROJECT}/output/output.pdf?build=2`));
  assert.equal(fixture.pdfReads().length, 0);
});

test('a collaborator edit during PDF transfer invalidates the returned bytes', async t => {
  const fixture = new ProjectFixture();
  const workflow = fixture.workflow(t);
  await workflow.compileProject(PROJECT);
  fixture.afterOutput = () => fixture.mutate(PREAMBLE, fixture.docs.get(PREAMBLE)!.content + '% during transfer\n');
  await assert.rejects(workflow.readOutput(PROJECT, `/project/${PROJECT}/output/output.pdf?build=1`));
});

test('explicit root selection is respected while permissive compilation is always overridden', async t => {
  const fixture = new ProjectFixture();
  const workflow = fixture.workflow(t);
  const result = await workflow.compileProject(PROJECT, { rootDocId: CHAPTER, stopOnFirstError: false });
  assert.equal(result.status, 'success');
  assert.deepEqual(fixture.compiles, [{ rootDocId: CHAPTER, stopOnFirstError: true }]);
});

test('an unavailable baseline compiler fails without any source mutation', async t => {
  const fixture = new ProjectFixture();
  fixture.beforeCompile = () => { throw new Error('Compiler unavailable'); };
  await assert.rejects(fixture.workflow(t).editProject(PROJECT, { changes: [change(fixture)] }));
  assert.equal(fixture.writes.length, 0);
});

test('checkpoints survive restart, page original text, and do not turn an unknown write into an owned write', async t => {
  const fixture = new ProjectFixture();
  const checkpointDir = mkdtempSync(join(tmpdir(), 'overleaf-checked-restart-'));
  t.after(() => rmSync(checkpointDir, { recursive: true, force: true }));
  const before = fixture.docs.get(CHAPTER)!.content;
  const first = new EditWorkflow(fixture, { checkpointDir });
  fixture.afterWrite = () => { throw new OverleafError('WRITE_STATE_UNKNOWN', 'Disconnected after submission.'); };
  const result = await first.editProject(PROJECT, { changes: [change(fixture)] });
  assert.ok(result.checkpoint_id);
  fixture.afterWrite = undefined;
  const restarted = new EditWorkflow(fixture, { checkpointDir });
  const page = await restarted.readCheckpoint(PROJECT, result.checkpoint_id, CHAPTER, 3, 12);
  assert.equal(page.before_text, before.slice(3, 15));
  assert.equal(page.next_offset, 15);
  assert.equal(page.total_characters, before.length);
  const recovery = await restarted.recoverEdit(PROJECT, result.checkpoint_id);
  assert.equal(recovery.status, 'recovery_required');
  assert.equal(fixture.writes.length, 1);
  assert.match(fixture.docs.get(CHAPTER)!.content, /clear paragraph/);
  await assert.rejects(restarted.readCheckpoint('999999999999999999999999', result.checkpoint_id));
  await assert.rejects(restarted.readCheckpoint(PROJECT, '../outside-checkpoint'));
});

test('logs remain available after a failed compile with bounded continuation metadata', async t => {
  const fixture = new ProjectFixture();
  fixture.compileStatuses = ['failure'];
  const workflow = fixture.workflow(t);
  await workflow.compileProject(PROJECT);
  const url = `/project/${PROJECT}/output/output.log?build=1`;
  const full = await workflow.readLog(PROJECT, url);
  assert.match(full.text, /Undefined control sequence/);
  assert.equal(full.complete, true);
  const first = await workflow.readLog(PROJECT, url, 0, 10);
  assert.equal(first.text, full.text.slice(0, 10));
  assert.equal(first.next_offset, 10);
  assert.equal(first.complete, false);
  const second = await workflow.readLog(PROJECT, url, 10, 10);
  assert.equal(second.text, full.text.slice(10, 20));
  assert.equal(second.total_bytes, Buffer.byteLength(full.text));
  await assert.rejects(workflow.readLog(PROJECT, url, -1));
  await assert.rejects(workflow.readLog(PROJECT, url, 0, 65_537));
  await assert.rejects(workflow.readLog('999999999999999999999999', url));
});

test('oversized source projects are rejected before compilation or writes', async t => {
  const many = new ProjectFixture();
  for (let i = 0; i < 99; i++) many.docs.set((i + 100).toString(16).padStart(24, '0'), snapshot('Other source'));
  await assert.rejects(many.workflow(t).editProject(PROJECT, { changes: [change(many)] }));
  assert.equal(many.compiles.length, 0);
  assert.equal(many.writes.length, 0);
  const huge = new ProjectFixture();
  huge.docs.set(PREAMBLE, snapshot('x'.repeat(8 * 1024 * 1024)));
  await assert.rejects(huge.workflow(t).editProject(PROJECT, { changes: [change(huge)] }));
  assert.equal(huge.compiles.length, 0);
  assert.equal(huge.writes.length, 0);
});

test('restart discovers recent checkpoints for only the requested project without exposing source text', async t => {
  const checkpointDir = mkdtempSync(join(tmpdir(), 'overleaf-checkpoint-discovery-'));
  t.after(() => rmSync(checkpointDir, { recursive: true, force: true }));
  const fixture = new ProjectFixture();
  const first = new EditWorkflow(fixture, { checkpointDir });
  const ownIds: string[] = [];
  for (let i = 0; i < 22; i++) {
    const [search, replace] = i % 2 === 0 ? ['short paragraph', 'clear paragraph'] : ['clear paragraph', 'short paragraph'];
    const result = await first.editProject(PROJECT, { changes: [change(fixture, CHAPTER, search, replace)] });
    assert.ok(result.checkpoint_id);
    ownIds.push(result.checkpoint_id);
  }
  const other = new ProjectFixture();
  other.projectId = '999999999999999999999999';
  const foreign = await new EditWorkflow(other, { checkpointDir }).editProject(other.projectId, { changes: [change(other)] });
  assert.ok(foreign.checkpoint_id);
  const restarted = new EditWorkflow(fixture, { checkpointDir });
  const found = await restarted.readCheckpoint(PROJECT);
  assert.equal(found.total, 22);
  assert.equal(found.checkpoints?.length, 20);
  for (const entry of found.checkpoints!) {
    assert.ok(ownIds.includes(entry.checkpoint_id));
    assert.notEqual(entry.checkpoint_id, foreign.checkpoint_id);
    assert.deepEqual(Object.keys(entry).sort(), ['checkpoint_id', 'created_at', 'status']);
  }
  const dates = found.checkpoints!.map(entry => entry.created_at);
  assert.deepEqual(dates, [...dates].sort().reverse());
  assert.doesNotMatch(JSON.stringify(found), /short paragraph|clear paragraph|sharedmacro|before_text|expected_hash/);
  const otherFound = await restarted.readCheckpoint(other.projectId);
  assert.deepEqual(otherFound.checkpoints?.map(entry => entry.checkpoint_id), [foreign.checkpoint_id]);
  const noMatchingProject = await restarted.readCheckpoint('888888888888888888888888');
  assert.deepEqual(noMatchingProject.checkpoints, []);
});

test('a small patch in JSON-escaped source cannot start writing if its recovery checkpoint would exceed storage', async t => {
  const fixture = new ProjectFixture();
  // The source fits both the per-file 2 MiB and project 8 MiB bounds. JSON escaping,
  // plus before/after/owned copies across two affected files, crosses the recovery cap.
  const escaped = '\\'.repeat(1_800_000);
  fixture.docs.set(PREAMBLE, snapshot(`${escaped}\nunique-preamble-marker\n`));
  fixture.docs.set(CHAPTER, snapshot(`${escaped}\nunique-chapter-marker\n`));
  const before = [...fixture.docs].map(([id, value]) => [id, { ...value }]);
  await assert.rejects(fixture.workflow(t).editProject(PROJECT, { changes: [
    change(fixture, PREAMBLE, 'unique-preamble-marker', 'updated-preamble-marker'),
    change(fixture, CHAPTER, 'unique-chapter-marker', 'updated-chapter-marker'),
  ] }), /checkpoint.*storage limit/i);
  assert.equal(fixture.writes.length, 0);
  assert.deepEqual([...fixture.docs], before);
});

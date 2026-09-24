import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, readdir, readFile, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OverleafApi } from './tools.js';
import { planPatches, type TextPatch, type PatchPlan } from './patches.js';
import { parseDiagnostics } from './output-slices.js';

type Snapshot = { content: string; version: number; hash: string };
type ProjectSnapshot = { root: string; treeHash: string; documents: Record<string, Snapshot> };
type Change = { documentId: string; expectedVersion: number; expectedHash: string; patches: TextPatch[] };
type SavedChange = { documentId: string; before: Snapshot; after: string; ranges: PatchPlan['ranges']; attempted?: boolean; owned?: Snapshot; restored?: boolean; problem?: string };
type Checkpoint = { id: string; projectId: string; root: string; createdAt: string; status: string; changes: SavedChange[] };
type CompileReceipt = { compile_id: string; status: string; source_verified: boolean; outputFiles: Array<{ path: string; url: string }>; [key: string]: unknown };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const asObject = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Overleaf returned an invalid object.');
  return value as Record<string, any>;
};
function snapshot(value: unknown): Snapshot {
  const data = asObject(value);
  if (typeof data.content !== 'string' || !Number.isSafeInteger(data.version) || data.version < 0) throw new Error('Invalid source snapshot.');
  return { content: data.content, version: data.version, hash: hash(data.content) };
}
function same(a: Snapshot, b: Snapshot) { return a.version === b.version && a.hash === b.hash; }
function sameProject(a: ProjectSnapshot, b: ProjectSnapshot) {
  return a.root === b.root && a.treeHash === b.treeHash && Object.keys(a.documents).length === Object.keys(b.documents).length
    && Object.entries(a.documents).every(([id, value]) => b.documents[id] && same(value, b.documents[id]!));
}

/** Coordinates one server process. Hosted collaborators remain independent. */
export class EditWorkflow {
  private queues = new Map<string, Promise<unknown>>();
  private latest = new Map<string, { receipt: CompileReceipt; source: ProjectSnapshot }>();
  private outputs = new Map<string, { projectId: string; compileId: string; path: string }>();
  private checkpointDir: string;
  constructor(private raw: OverleafApi, options: { checkpointDir?: string } = {}) {
    this.checkpointDir = options.checkpointDir ?? process.env.OVERLEAF_CHECKPOINT_DIR ?? join(homedir(), '.config/overleaf-latex/checkpoints');
  }

  private async serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(id) ?? Promise.resolve();
    const work = prior.catch(() => {}).then(action);
    this.queues.set(id, work);
    try { return await work; } finally { if (this.queues.get(id) === work) this.queues.delete(id); }
  }
  async mutate<T>(id: string, action: () => Promise<T>): Promise<T> {
    return this.serial(id, async () => { this.latest.delete(id); return action(); });
  }
  private async save(cp: Checkpoint) {
    const body = JSON.stringify(cp);
    if (Buffer.byteLength(body) > 20 * 1024 * 1024) throw new Error('Checkpoint exceeds its private storage limit.');
    await mkdir(this.checkpointDir, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.checkpointDir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('Checkpoint directory must be private and not a symlink.');
    const tmp = join(this.checkpointDir, `${cp.id}.${randomUUID()}.tmp`);
    await writeFile(tmp, body, { mode: 0o600, flag: 'wx' });
    await rename(tmp, join(this.checkpointDir, `${cp.id}.json`));
  }
  private async load(projectId: string, id: string): Promise<Checkpoint> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Use a returned checkpoint_id.');
    const path = join(this.checkpointDir, `${id}.json`);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20 * 1024 * 1024 || (stat.mode & 0o077)) throw new Error('Invalid private checkpoint.');
    const cp = JSON.parse(await readFile(path, 'utf8')) as Checkpoint;
    if (cp.projectId !== projectId || cp.id !== id) throw new Error('Checkpoint belongs to another project.');
    return cp;
  }
  async readCheckpoint(projectId: string, id?: string, documentId?: string, offset = 0, length = 20_000) {
    if (!id) {
      let names: string[];
      try { names = await readdir(this.checkpointDir); } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { checkpoints: [] };
        throw new Error('Could not list private checkpoints.');
      }
      const entries: Array<{ checkpoint_id: string; created_at: string; status: string }> = [];
      for (const name of names.filter(n => /^[a-f0-9-]{36}\.json$/.test(n))) {
        try { const cp = await this.load(projectId, name.slice(0, -5)); entries.push({ checkpoint_id: cp.id, created_at: cp.createdAt, status: cp.status }); }
        catch { /* Other projects or unreadable checkpoints are not disclosed. */ }
      }
      return { checkpoints: entries.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 20), total: entries.length };
    }
    const cp = await this.load(projectId, id);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 20_000) throw new Error('Invalid checkpoint character window.');
    const summaries = cp.changes.map(c => ({ document_id: c.documentId, before_version: c.before.version, before_hash: c.before.hash,
      owned_version: c.owned?.version, owned_hash: c.owned?.hash, attempted: !!c.attempted, restored: !!c.restored, problem: c.problem }));
    if (!documentId) return { checkpoint_id: id, status: cp.status, changes: summaries };
    const change = cp.changes.find(c => c.documentId === documentId);
    if (!change) throw new Error('Document is outside this checkpoint.');
    const text = change.before.content;
    return { checkpoint_id: id, document_id: documentId, before_text: text.slice(offset, offset + length), offset,
      next_offset: offset + length < text.length ? offset + length : null, total_characters: text.length, changes: summaries };
  }

  private async projectSnapshot(projectId: string, rootOverride?: string): Promise<ProjectSnapshot> {
    const project = asObject(await this.raw.getProject(projectId));
    const ids: string[] = [];
    const walk = (folders: any[]): unknown[] => folders.map(folder => ({ id: folder._id, name: folder.name,
      docs: (folder.docs ?? []).map((doc: any) => { ids.push(doc._id); return { id: doc._id, name: doc.name }; }),
      files: (folder.fileRefs ?? []).map((file: any) => ({ id: file._id, name: file.name, hash: file.hash, linkedFileData: file.linkedFileData })),
      folders: walk(folder.folders ?? []),
    }));
    const tree = walk(project.rootFolder ?? []);
    const root = rootOverride ?? project.rootDoc_id;
    if (!root || !ids.includes(root) || ids.length > 100 || new Set(ids).size !== ids.length) throw new Error('Select an existing root document in a project with at most 100 text files.');
    const documents: Record<string, Snapshot> = {};
    let bytes = 0;
    for (let i = 0; i < ids.length; i += 4) {
      for (const [id, doc] of await Promise.all(ids.slice(i, i + 4).map(async id => [id, snapshot(await this.raw.readDocument(projectId, id))] as const))) {
        bytes += Buffer.byteLength(doc.content);
        if (bytes > 8 * 1024 * 1024) throw new Error('Project source exceeds the 8 MiB checked-edit limit.');
        documents[id] = doc;
      }
    }
    return { root, treeHash: hash(JSON.stringify({ tree, compiler: project.compiler, root: project.rootDoc_id })), documents };
  }

  async initializeDocument(projectId: string, id: string, content: string, version: number) {
    return this.mutate(projectId, async () => {
      const current = snapshot(await this.raw.readDocument(projectId, id));
      if (current.version !== version) throw new Error('Version conflict: read the document again.');
      if (current.content !== '') throw new Error('Full-document writes only initialize empty files. Use overleaf_edit_project for existing source.');
      return this.raw.writeDocument(projectId, id, content, version);
    });
  }

  private async compile(projectId: string, root?: string): Promise<CompileReceipt> {
    this.latest.delete(projectId);
    const before = await this.projectSnapshot(projectId, root);
    const value = asObject(await this.raw.compileProject(projectId, { rootDocId: before.root, stopOnFirstError: true }));
    const after = await this.projectSnapshot(projectId, before.root);
    const verified = sameProject(before, after);
    const receipt: CompileReceipt = { ...value, compile_id: randomUUID(), status: verified ? String(value.status) : 'source_changed',
      source_verified: verified, outputFiles: Array.isArray(value.outputFiles) ? value.outputFiles : [],
      source_versions: Object.fromEntries(Object.entries(after.documents).map(([id, d]) => [id, { version: d.version, hash: d.hash }])),
      root_document_id: before.root, note: 'Versions checked before and after compilation; external collaborators are not locked. Binary dependency contents are not verified.' };
    this.latest.set(projectId, { receipt, source: after });
    for (const output of receipt.outputFiles) {
      if (typeof output.url === 'string' && typeof output.path === 'string') this.outputs.set(output.url, { projectId, compileId: receipt.compile_id, path: output.path });
    }
    while (this.outputs.size > 500) this.outputs.delete(this.outputs.keys().next().value!);
    receipt.diagnostics = await this.diagnostics(projectId, receipt);
    return receipt;
  }
  compileProject(projectId: string, options: { rootDocId?: string; stopOnFirstError?: boolean } = {}) {
    return this.serial(projectId, () => this.compile(projectId, options.rootDocId));
  }
  private async diagnostics(projectId: string, receipt: CompileReceipt) {
    const log = receipt.outputFiles.find(f => /(?:^|\/)output\.log$/.test(f.path));
    if (!log) return { errors: [], warnings: [], unavailable: true };
    try { return await this.readLog(projectId, log.url); }
    catch { return { errors: [], warnings: [], unavailable: true, note: 'Log retrieval failed; use the returned log descriptor to retry.' }; }
  }
  async readLog(projectId: string, url: string, offset = 0, length = 65536) {
    const known = this.outputs.get(url);
    if (!known || known.projectId !== projectId || !/\.log$/.test(known.path)) throw new Error('Use a log descriptor returned by this server process.');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 65536) throw new Error('Invalid log byte window.');
    const part = this.raw.readOutputSlice ? await this.raw.readOutputSlice(projectId, url, offset, length) : await (async () => {
      const output = await this.raw.readOutput(projectId, url, 50 * 1024 * 1024);
      return { data: output.data.subarray(offset, offset + length), offset, nextOffset: offset + length < output.data.length ? offset + length : null, complete: offset + length >= output.data.length, totalBytes: output.data.length };
    })();
    const text = part.data.toString('utf8');
    return { ...parseDiagnostics(text), text, offset: part.offset, next_offset: part.nextOffset, complete: part.complete, total_bytes: part.totalBytes,
      compile_id: known.compileId, note: 'Diagnostics cover this byte window only; line or UTF-8 boundaries can span windows. Compilation status is authoritative.' };
  }
  readOutput(projectId: string, url: string, maxBytes = 5_000_000) {
    return this.serial(projectId, async () => {
      const known = this.outputs.get(url);
      if (!known || known.projectId !== projectId) throw new Error('Use an output descriptor returned by this server process.');
      if (!/\.pdf$/.test(known.path)) return this.raw.readOutput(projectId, url, maxBytes);
      const current = this.latest.get(projectId);
      if (!current || current.receipt.compile_id !== known.compileId || current.receipt.status !== 'success' || !current.receipt.source_verified) throw new Error('This PDF is not from the latest verified successful compile. Recompile the current source.');
      if (!sameProject(current.source, await this.projectSnapshot(projectId, current.source.root))) throw new Error('Source changed since this PDF was compiled. Recompile.');
      const output = await this.raw.readOutput(projectId, url, maxBytes);
      if (!sameProject(current.source, await this.projectSnapshot(projectId, current.source.root))) throw new Error('Source changed while reading this PDF. Recompile.');
      return output;
    });
  }

  editProject(projectId: string, args: { rootDocumentId?: string; changes: Change[] }) {
    return this.serial(projectId, async () => {
      if (!args.changes.length || args.changes.length > 5 || new Set(args.changes.map(c => c.documentId)).size !== args.changes.length) throw new Error('Specify 1 to 5 distinct files per checked edit.');
      const start = await this.projectSnapshot(projectId, args.rootDocumentId);
      let budget = 0;
      const planned: SavedChange[] = args.changes.map(change => {
        const before = start.documents[change.documentId];
        if (!before || before.version !== change.expectedVersion || before.hash !== change.expectedHash) throw new Error('Version or hash conflict: read source and dependencies again.');
        const plan = planPatches(before.content, change.patches);
        budget += plan.changedCharacters;
        return { documentId: change.documentId, before, after: plan.content, ranges: plan.ranges };
      });
      if (budget > 20_000) throw new Error('A checked edit may change at most 20,000 characters across files.');
      const baseline = await this.compile(projectId, start.root);
      if (baseline.status !== 'success') return { status: 'baseline_failed', baseline, changes_applied: false };
      if (!sameProject(start, await this.projectSnapshot(projectId, start.root))) throw new Error('Source changed during the baseline compile; no edit was applied.');
      const cp: Checkpoint = { id: randomUUID(), projectId, root: start.root, createdAt: new Date().toISOString(), status: 'prepared', changes: planned };
      const largest = { ...cp, changes: planned.map(c => ({ ...c, owned: { content: c.after, hash: hash(c.after), version: c.before.version + 1 } })) };
      if (Buffer.byteLength(JSON.stringify(largest)) > 19 * 1024 * 1024) throw new Error('Edit checkpoint would exceed its recovery storage limit; use a smaller batch.');
      await this.save(cp);
      this.latest.delete(projectId);
      let failed: unknown;
      try {
        let expected = start;
        for (let i = 0; i < planned.length; i++) {
          if (!sameProject(expected, await this.projectSnapshot(projectId, start.root))) throw new Error('Project source changed before the next write.');
          const change = planned[i]!;
          change.attempted = true; cp.status = 'applying'; await this.save(cp);
          let response: unknown;
          try {
            response = this.raw.patchDocument
              ? await this.raw.patchDocument(projectId, change.documentId, args.changes[i]!.patches, change.before.version)
              : await this.raw.writeDocument(projectId, change.documentId, change.after, change.before.version);
          } catch (error) {
            const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
            if (['VERSION_CONFLICT', 'WRITE_REJECTED', 'OVERLEAF_REJECTED', 'INVALID_CONTENT', 'INVALID_VERSION'].includes(String(code))) {
              change.attempted = false; change.problem = 'Write was explicitly rejected; no restoration is required for this file.';
            } else change.problem = 'Write outcome is uncertain. Read current source and reconcile; this file will not be automatically restored.';
            await this.save(cp); throw new Error(change.problem);
          }
          const written = snapshot(response);
          if (written.content !== change.after || written.version !== change.before.version + 1 || asObject(response).concurrentChanges === true) {
            change.problem = 'Write differs from the expected version or text; possible collaborator changes.';
            await this.save(cp); throw new Error(change.problem);
          }
          change.owned = written;
          await this.save(cp);
          expected = { ...expected, documents: { ...expected.documents, [change.documentId]: written } };
        }
        if (!sameProject(expected, await this.projectSnapshot(projectId, start.root))) throw new Error('Source changed after the edit.');
        const compilation = await this.compile(projectId, start.root);
        if (compilation.status === 'success' && sameProject(expected, this.latest.get(projectId)!.source)) { cp.status = 'success'; await this.save(cp); return { status: 'success', checkpoint_id: cp.id, compilation }; }
        if (compilation.status === 'success') compilation.status = 'source_changed';
        failed = compilation;
      } catch (error) { failed = { status: 'operation_failed', message: error instanceof Error ? error.message : 'Edit failed.' }; }
      const recovery = await this.restore(cp);
      return { ...recovery, failed_compilation: failed };
    });
  }
  recoverEdit(projectId: string, id: string) { return this.serial(projectId, async () => this.restore(await this.load(projectId, id))); }
  private async restore(cp: Checkpoint) {
    this.latest.delete(cp.projectId);
    const outcomes: Array<{ document_id: string; status: string }> = [];
    for (const change of [...cp.changes].reverse()) {
      if (!change.attempted || change.restored) continue;
      if (!change.owned) { outcomes.push({ document_id: change.documentId, status: 'uncertain_write_requires_reconciliation' }); continue; }
      try {
        const now = snapshot(await this.raw.readDocument(cp.projectId, change.documentId));
        if (!same(now, change.owned)) { outcomes.push({ document_id: change.documentId, status: 'collaborator_change_preserved' }); continue; }
        // Persist the pending restore before sending it; a crash cannot cause a blind replay.
        const owned = change.owned;
        change.owned = undefined; change.problem = 'Restore pending; inspect source before retrying if interrupted.'; await this.save(cp);
        const restored = snapshot(this.raw.restoreDocument
          ? await this.raw.restoreDocument(cp.projectId, change.documentId, change.before.content, owned.version, change.ranges)
          : await this.raw.writeDocument(cp.projectId, change.documentId, change.before.content, owned.version));
        if (restored.hash !== change.before.hash || restored.version !== owned.version + 1) throw new Error('Restore requires reconciliation.');
        change.restored = true; change.problem = undefined; await this.save(cp);
        outcomes.push({ document_id: change.documentId, status: 'restored' });
      } catch { outcomes.push({ document_id: change.documentId, status: 'restore_unverified' }); }
    }
    let compilation: unknown;
    try { compilation = await this.compile(cp.projectId, cp.root); } catch { compilation = { status: 'unavailable' }; }
    const restoredAll = cp.changes.every(c => !c.attempted || c.restored);
    cp.status = restoredAll && asObject(compilation).status === 'success' ? 'rolled_back' : 'recovery_required';
    await this.save(cp);
    return { status: cp.status, checkpoint_id: cp.id, recovery: outcomes, compilation,
      note: 'Recovery is conditional per file, not an atomic project rollback. Uncertain writes and collaborator changes are preserved for reconciliation.' };
  }
}

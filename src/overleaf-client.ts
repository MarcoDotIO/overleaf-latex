import { createHash } from 'node:crypto';
import { buildCookieHeader, loadSession } from './session.js';
import { AUTH_MESSAGE, connectRealtime, OverleafError, type RealtimeConnection, type SocketFactory } from './realtime.js';

export { OverleafError } from './realtime.js';
export const OVERLEAF_ORIGIN = 'https://www.overleaf.com';
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
type Session = Awaited<ReturnType<typeof loadSession>>;
type JsonObject = Record<string, unknown>;

export interface ClientOptions {
  fetch?: typeof globalThis.fetch;
  loadSession?: () => Promise<Session>;
  socketFactory?: SocketFactory;
  timeoutMs?: number;
}

export interface DocumentSnapshot {
  content: string;
  version: number;
  hash: string;
  type: 'sharejs-text-ot' | 'history-ot';
}

export interface CompileOptions {
  compiler?: 'pdflatex' | 'xelatex' | 'lualatex' | 'latex';
  rootDocId?: string;
  stopOnFirstError?: boolean;
}

export interface CompileOutput extends JsonObject {
  path: string;
  url: string;
}

export interface CompileResult extends JsonObject {
  status: string;
  outputFiles: CompileOutput[];
}

export class OverleafClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly getSession: () => Promise<Session>;
  private readonly socketFactory: SocketFactory;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.getSession = options.loadSession ?? loadSession;
    this.socketFactory = options.socketFactory ?? connectRealtime;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async listProjects(): Promise<JsonObject[]> {
    const response = await this.json('/user/projects');
    if (!Array.isArray(response.projects)) throw protocolError();
    return response.projects as JsonObject[];
  }

  async createProject(name: string, template: 'blank' | 'example' = 'blank'): Promise<JsonObject> {
    validateName(name);
    return this.json('/project/new', { projectName: name, template });
  }

  async getProject(projectId: string): Promise<JsonObject> {
    return this.withProject(projectId, async socket => socket.project);
  }

  async readDocument(projectId: string, documentId: string): Promise<DocumentSnapshot> {
    validateId(documentId);
    return this.withProject(projectId, socket => this.joinDocument(socket, documentId));
  }

  async writeDocument(projectId: string, documentId: string, content: string, expectedVersion: number): Promise<DocumentSnapshot & { applied: boolean; concurrentChanges: boolean }> {
    validateId(documentId);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new OverleafError('INVALID_VERSION', 'Provide the document version returned by read_document.');
    validateContent(content);
    // Overleaf stores normalized document lines. Normalize once before both OT and verification.
    content = content.replace(/\r\n?/g, '\n');
    return this.withProject(projectId, async socket => {
      const current = await this.joinDocument(socket, documentId);
      if (current.version !== expectedVersion) {
        throw new OverleafError('VERSION_CONFLICT', `The document changed: expected version ${expectedVersion}, current version ${current.version}. Read it again and merge your edit; nothing was written.`);
      }
      if (current.content === content) return { ...current, applied: false, concurrentChanges: false };
      const op = buildTextOperation(current.content, content, current.type);
      let timer: NodeJS.Timeout | undefined;
      const unsubscribers: (() => void)[] = [];
      const applied = new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(unknownWriteError()), this.timeoutMs);
        unsubscribers.push(socket.on('otUpdateApplied', data => {
          if (isObject(data) && data.doc === documentId && !('op' in data) && Number.isSafeInteger(data.v) && (data.v as number) >= current.version) resolve();
        }));
        unsubscribers.push(socket.on('otUpdateError', (_error, data) => {
          if (!isObject(data) || !data.doc_id || data.doc_id === documentId) {
            reject(new OverleafError('WRITE_REJECTED', 'Overleaf rejected the document update. Read the document before retrying.'));
          }
        }));
        unsubscribers.push(socket.on('disconnect', () => reject(unknownWriteError())));
      });
      try {
        // The RPC callback only confirms queue ingestion. Wait for persistence/broadcast acknowledgement too.
        await Promise.all([socket.request('applyOtUpdate', [documentId, { doc: documentId, v: current.version, op }]), applied]);
      } catch (error) {
        if (error instanceof OverleafError && (error.code === 'WRITE_REJECTED' || error.code === 'OVERLEAF_REJECTED')) throw error;
        throw unknownWriteError();
      } finally {
        if (timer) clearTimeout(timer);
        unsubscribers.forEach(unsubscribe => unsubscribe());
      }
      let updated: DocumentSnapshot;
      try { updated = await this.joinDocument(socket, documentId); }
      catch { throw new OverleafError('WRITE_APPLIED_READ_FAILED', 'Overleaf acknowledged the edit, but verification could not read the updated document. Read it again before making another edit.'); }
      if (updated.version <= current.version) throw new OverleafError('WRITE_APPLIED_READ_FAILED', 'Overleaf acknowledged the edit, but the verification read did not advance the document version. Read the document again before making another edit.');
      return { ...updated, applied: true, concurrentChanges: updated.content !== content };
    });
  }

  async createDocument(projectId: string, name: string, parentFolderId?: string): Promise<JsonObject> {
    return this.createEntity(projectId, 'doc', name, parentFolderId);
  }

  async createFolder(projectId: string, name: string, parentFolderId?: string): Promise<JsonObject> {
    return this.createEntity(projectId, 'folder', name, parentFolderId);
  }

  async compileProject(projectId: string, options: CompileOptions = {}): Promise<CompileResult> {
    validateId(projectId);
    if (options.rootDocId) validateId(options.rootDocId);
    const result = await this.json(`/project/${projectId}/compile?file_line_errors=true`, {
      stopOnFirstError: options.stopOnFirstError ?? false,
      ...(options.compiler ? { compiler: options.compiler } : {}),
      ...(options.rootDocId ? { rootDoc_id: options.rootDocId } : {}),
    }, 180_000);
    if (typeof result.status !== 'string' || !Array.isArray(result.outputFiles)) throw protocolError();
    const outputFiles = result.outputFiles.map((entry: unknown): CompileOutput => {
      if (!isObject(entry) || typeof entry.path !== 'string' || typeof entry.url !== 'string') throw protocolError();
      const url = trustedOutputUrl(projectId, entry.url);
      if (typeof result.clsiServerId === 'string') url.searchParams.set('clsiserverid', result.clsiServerId);
      if (typeof result.compileGroup === 'string') url.searchParams.set('compileGroup', result.compileGroup);
      return { ...entry, path: entry.path, url: url.href };
    });
    return { ...result, status: result.status, outputFiles };
  }

  async readOutput(projectId: string, outputUrl: string, maxBytes = 25 * 1024 * 1024): Promise<{ data: Buffer; contentType: string }> {
    validateId(projectId);
    const url = trustedOutputUrl(projectId, outputUrl);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 50 * 1024 * 1024) throw new OverleafError('INVALID_LIMIT', 'Output limit must be between 1 byte and 50 MB.');
    const response = await this.request(url.pathname + url.search, undefined, this.timeoutMs);
    return { data: await readLimited(response, maxBytes), contentType: response.headers.get('content-type') ?? 'application/octet-stream' };
  }

  private async createEntity(projectId: string, kind: 'doc' | 'folder', name: string, parentFolderId?: string): Promise<JsonObject> {
    validateId(projectId); validateName(name);
    if (parentFolderId) validateId(parentFolderId);
    return this.json(`/project/${projectId}/${kind}`, { name, ...(parentFolderId ? { parent_folder_id: parentFolderId } : {}) });
  }

  private async joinDocument(socket: RealtimeConnection, documentId: string): Promise<DocumentSnapshot> {
    const [lines, version, , , type] = await socket.request('joinDoc', [documentId, -1, { supportsHistoryOT: true }]);
    if (!Number.isSafeInteger(version) || (version as number) < 0) throw protocolError();
    let content: string;
    let documentType: DocumentSnapshot['type'];
    if (type === 'history-ot' && isObject(lines) && typeof lines.content === 'string') {
      content = lines.content;
      documentType = type;
    } else if ((type === 'sharejs-text-ot' || type == null) && Array.isArray(lines) && lines.every(line => typeof line === 'string')) {
      // Older Overleaf encodes UTF-8 bytes into Latin-1 strings specifically for joinDoc.
      content = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(lines.join('\n'), 'latin1'));
      documentType = 'sharejs-text-ot';
    } else throw new OverleafError('UNSUPPORTED_DOCUMENT', 'Overleaf returned an unsupported document representation. No document was changed.');
    validateContent(content);
    return { content, version: version as number, hash: createHash('sha256').update(content).digest('hex'), type: documentType };
  }

  private async withProject<T>(projectId: string, action: (socket: RealtimeConnection) => Promise<T>): Promise<T> {
    validateId(projectId);
    const session = await this.getSession();
    const cookie = buildCookieHeader(session, `${OVERLEAF_ORIGIN}/socket.io`);
    if (!cookie) throw new OverleafError('AUTH_OR_CHALLENGE', AUTH_MESSAGE);
    const socket = await this.socketFactory({ projectId, cookie, origin: OVERLEAF_ORIGIN, fetch: this.fetchImpl, timeoutMs: this.timeoutMs });
    try { return await action(socket); } finally { socket.close(); }
  }

  private async json(path: string, body?: JsonObject, timeoutMs = this.timeoutMs): Promise<JsonObject> {
    const response = await this.request(path, body, timeoutMs);
    let result: unknown;
    try { result = JSON.parse((await readLimited(response, MAX_RESPONSE_BYTES)).toString('utf8')); }
    catch (error) { if (error instanceof OverleafError) throw error; throw protocolError(); }
    if (!isObject(result)) throw protocolError();
    return result;
  }

  private async request(path: string, body?: JsonObject, timeoutMs = this.timeoutMs): Promise<Response> {
    const url = new URL(path, OVERLEAF_ORIGIN);
    if (url.origin !== OVERLEAF_ORIGIN || url.username || url.password) throw new OverleafError('UNSAFE_URL', 'Refusing to send Overleaf credentials to another origin.');
    const session = await this.getSession();
    const cookie = buildCookieHeader(session, url.href);
    if (!cookie) throw new OverleafError('AUTH_OR_CHALLENGE', AUTH_MESSAGE);
    const headers: Record<string, string> = { Cookie: cookie, Accept: 'application/json', Origin: OVERLEAF_ORIGIN, Referer: `${OVERLEAF_ORIGIN}/project` };
    if (body !== undefined) {
      const page = await this.fetchImpl(`${OVERLEAF_ORIGIN}/project`, { headers, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) });
      checkResponse(page, true);
      const html = (await readLimited(page, MAX_RESPONSE_BYTES)).toString('utf8');
      const csrf = extractMeta(html, 'ol-csrfToken');
      if (!csrf) throw new OverleafError('AUTH_OR_CHALLENGE', AUTH_MESSAGE);
      headers['x-csrf-token'] = csrf;
      headers['Content-Type'] = 'application/json';
    }
    const response = await this.fetchImpl(url, { method: body === undefined ? 'GET' : 'POST', headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    checkResponse(response);
    return response;
  }
}

export function buildTextOperation(before: string, after: string, type: DocumentSnapshot['type']): unknown[] {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  // Never split an astral character when nearby Unicode characters change.
  if (prefix > 0 && isHighSurrogate(before.charCodeAt(prefix - 1))) prefix--;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  if (suffix > 0 && isLowSurrogate(before.charCodeAt(before.length - suffix))) suffix--;
  const removed = before.slice(prefix, before.length - suffix);
  const inserted = after.slice(prefix, after.length - suffix);
  if (type === 'history-ot') {
    const textOperation: (string | number)[] = [];
    if (prefix) textOperation.push(prefix);
    if (removed) textOperation.push(-removed.length);
    if (inserted) textOperation.push(inserted);
    if (suffix) textOperation.push(suffix);
    return [{ textOperation }];
  }
  return [...(removed ? [{ p: prefix, d: removed }] : []), ...(inserted ? [{ p: prefix, i: inserted }] : [])];
}

export function trustedOutputUrl(projectId: string, value: string): URL {
  validateId(projectId);
  let url: URL;
  try { url = new URL(value, OVERLEAF_ORIGIN); }
  catch { throw new OverleafError('UNSAFE_OUTPUT_URL', 'The requested output must be an Overleaf compile artifact for this project.'); }
  // The client exposes only compile output files, never arbitrary authenticated URLs.
  const pattern = new RegExp(`^/(?:download/)?project/${projectId}/(?:user/[a-fA-F0-9]{24}/)?build/[A-Za-z0-9_-]+/output/(?:cached/)?[^/]+(?:/[^/]+)*$`);
  let unsafePath = /[\\\x00-\x1f]/.test(value) || /(?:^|\/)\.{1,2}(?:\/|$|[?#])/.test(value);
  try {
    unsafePath ||= url.pathname.split('/').some(part => {
      const decoded = decodeURIComponent(part);
      return decoded === '.' || decoded === '..' || /[/\\%\x00-\x1f]/.test(decoded);
    });
  } catch { unsafePath = true; }
  if (url.origin !== OVERLEAF_ORIGIN || url.username || url.password || !pattern.test(url.pathname) || unsafePath || /%2e/i.test(value)) {
    throw new OverleafError('UNSAFE_OUTPUT_URL', 'The requested output must be an Overleaf compile artifact for this project.');
  }
  url.hash = '';
  return url;
}

export function extractMeta(html: string, name: string): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attributes = new Map<string, string>();
    for (const match of tag.matchAll(/([\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) attributes.set(match[1]!.toLowerCase(), match[3]!);
    if (attributes.get('name') === name) return attributes.get('content')?.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }
  return undefined;
}

function validateId(id: string): void { if (!/^[a-fA-F0-9]{24}$/.test(id)) throw new OverleafError('INVALID_ID', 'Overleaf project, document, and folder IDs must be 24 hexadecimal characters.'); }
function validateName(name: string): void { if (!name.trim() || name.length >= 150 || /[\x00-\x1f\\/]/.test(name) || name === '.' || name === '..') throw new OverleafError('INVALID_NAME', 'Choose a nonempty name under 150 characters without slashes or control characters.'); }
function validateContent(content: string): void { if (Buffer.byteLength(content, 'utf8') > MAX_DOCUMENT_BYTES || content.includes('\0') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(content)) throw new OverleafError('INVALID_CONTENT', 'Document text must be valid Unicode, contain no NUL characters, and fit within 2 MB.'); }
function isHighSurrogate(code: number): boolean { return code >= 0xd800 && code <= 0xdbff; }
function isLowSurrogate(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff; }
function isObject(value: unknown): value is JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function protocolError(): OverleafError { return new OverleafError('OVERLEAF_PROTOCOL', 'Overleaf returned an unexpected response. The plugin may need updating for this deployment.'); }
function unknownWriteError(): OverleafError { return new OverleafError('WRITE_STATUS_UNKNOWN', 'The connection ended before the edit was confirmed. It may have been applied. Read the document before retrying; do not automatically repeat this write.'); }
function checkResponse(response: Response, allowHtml = false): void {
  if (response.status >= 300 && response.status < 400 || response.status === 401 || response.status === 403 || (!allowHtml && response.headers.get('content-type')?.includes('text/html'))) throw new OverleafError('AUTH_OR_CHALLENGE', AUTH_MESSAGE);
  if (response.status === 429) throw new OverleafError('RATE_LIMITED', 'Overleaf rate-limited this request. Wait before retrying.');
  if (!response.ok) throw new OverleafError('OVERLEAF_HTTP', `Overleaf returned HTTP ${response.status}. Check project access and retry only after reading current state for any uncertain write.`);
}

async function readLimited(response: Response, limit: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new OverleafError('RESPONSE_TOO_LARGE', 'The Overleaf response exceeds the allowed size.'); }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) { await reader.cancel(); throw new OverleafError('RESPONSE_TOO_LARGE', 'The Overleaf response exceeds the allowed size.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}

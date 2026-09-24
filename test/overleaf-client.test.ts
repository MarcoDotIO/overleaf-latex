import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { OverleafClient, OverleafError, OVERLEAF_ORIGIN, buildTextOperation, extractMeta, trustedOutputUrl } from '../src/overleaf-client.js';
import { planPatches, PatchError } from '../src/patches.js';
import type { RealtimeConnection } from '../src/realtime.js';
import { sessionFromCookieHeader } from '../src/session.js';

const projectId = '0123456789abcdef01234567';
const documentId = '1123456789abcdef01234567';
const folderId = '2123456789abcdef01234567';
const output = `/project/${projectId}/build/build-123/output/output.pdf`;
const session = sessionFromCookieHeader('overleaf.sid=local-test-secret');
const loadSession = async () => session;
const errorCode = (code: string) => (error: unknown): boolean => error instanceof OverleafError && error.code === code;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const csrfPage = () => new Response('<meta content="csrf&amp;value" name="ol-csrfToken">', { headers: { 'content-type': 'text/html' } });
const wellFormed = (value: string) => Buffer.from(value).toString('utf8') === value;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

class FakeSocket implements RealtimeConnection {
  project = { _id: projectId, rootFolder: [{ _id: folderId, docs: [{ _id: documentId, name: 'main.tex' }] }] };
  events = new EventEmitter();
  requests: { event: string; args: unknown[] }[] = [];
  closed = false;
  constructor(private handler: (event: string, args: unknown[]) => Promise<unknown[]> = async () => []) {}
  request(event: string, args: unknown[]): Promise<unknown[]> { this.requests.push({ event, args }); return this.handler(event, args); }
  on(event: string, listener: (...args: unknown[]) => void): () => void { this.events.on(event, listener); return () => { this.events.off(event, listener); }; }
  close(): void { this.closed = true; }
}

function fromSocket(socket: FakeSocket, timeoutMs = 300): OverleafClient {
  return new OverleafClient({ loadSession, timeoutMs, socketFactory: async options => {
    assert.equal(options.projectId, projectId);
    assert.equal(options.origin, OVERLEAF_ORIGIN);
    assert.equal(options.cookie, 'overleaf.sid=local-test-secret');
    return socket;
  } });
}

function snapshot(content: string, version = 4, type = 'history-ot'): unknown[] {
  const lines = type === 'history-ot' ? { content, comments: {}, trackedChanges: [] } : content.split('\n').map(line => Buffer.from(line).toString('latin1'));
  return [lines, version, [], {}, type];
}

function applyOperation(before: string, operation: unknown[], type: 'history-ot' | 'sharejs-text-ot'): string {
  if (type === 'sharejs-text-ot') {
    let content = before;
    for (const component of operation as { p: number; d?: string; i?: string }[]) {
      assert.equal(wellFormed(content.slice(0, component.p)), true);
      if (component.d !== undefined) {
        assert.equal(content.slice(component.p, component.p + component.d.length), component.d);
        assert.equal(wellFormed(component.d), true);
        content = content.slice(0, component.p) + content.slice(component.p + component.d.length);
      }
      if (component.i !== undefined) content = content.slice(0, component.p) + component.i + content.slice(component.p);
      assert.equal(wellFormed(content), true);
    }
    return content;
  }
  let cursor = 0;
  let content = '';
  for (const component of (operation[0] as { textOperation: (number | string)[] }).textOperation) {
    if (typeof component === 'string') content += component;
    else {
      const fragment = before.slice(cursor, cursor + Math.abs(component));
      assert.equal(wellFormed(fragment), true);
      if (component > 0) content += fragment;
      cursor += Math.abs(component);
    }
  }
  assert.equal(cursor, before.length);
  assert.equal(wellFormed(content), true);
  return content;
}

function documentServer(content: string, type: 'history-ot' | 'sharejs-text-ot') {
  const state = { content, version: 4 };
  const sockets: FakeSocket[] = [];
  const operations: unknown[][] = [];
  const client = new OverleafClient({ loadSession, socketFactory: async () => {
    const socket = new FakeSocket(async (event, args) => {
      if (event === 'joinDoc') return snapshot(state.content, state.version, type);
      assert.equal(event, 'applyOtUpdate');
      assert.equal(args[0], documentId);
      const update = args[1] as { doc: string; v: number; op: unknown[] };
      assert.equal(update.doc, documentId);
      assert.equal(update.v, state.version);
      operations.push(update.op);
      state.content = applyOperation(state.content, update.op, type);
      state.version++;
      queueMicrotask(() => socket.events.emit('otUpdateApplied', { doc: documentId, v: update.v }));
      return [];
    });
    sockets.push(socket);
    return socket;
  } });
  return { state, client, sockets, operations };
}

test('list projects uses authenticated GET, fixed origin, and manual redirects', async () => {
  const client = new OverleafClient({ loadSession, fetch: async (url, init) => {
    assert.equal(String(url), `${OVERLEAF_ORIGIN}/user/projects`);
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).get('cookie'), 'overleaf.sid=local-test-secret');
    assert.ok(init?.signal);
    return json({ projects: [{ _id: projectId, name: 'Paper' }] });
  } });
  assert.deepEqual(await client.listProjects(), [{ _id: projectId, name: 'Paper' }]);
});

test('project and entity creation fetch CSRF and use reference request bodies', async () => {
  const requests: { url: string; body: unknown }[] = [];
  let pageCount = 0;
  const client = new OverleafClient({ loadSession, fetch: async (url, init) => {
    assert.equal(init?.redirect, 'manual');
    assert.equal(new URL(String(url)).origin, OVERLEAF_ORIGIN);
    if (String(url) === `${OVERLEAF_ORIGIN}/project`) { pageCount++; return csrfPage(); }
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('x-csrf-token'), 'csrf&value');
    assert.equal(new Headers(init?.headers).get('content-type'), 'application/json');
    requests.push({ url: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) });
    return json({ _id: documentId, project_id: projectId });
  } });
  await client.createProject('My paper', 'example');
  await client.createDocument(projectId, 'main.tex');
  await client.createFolder(projectId, 'chapters', folderId);
  assert.equal(pageCount, 3);
  assert.deepEqual(requests, [
    { url: '/project/new', body: { projectName: 'My paper', template: 'example' } },
    { url: `/project/${projectId}/doc`, body: { name: 'main.tex' } },
    { url: `/project/${projectId}/folder`, body: { name: 'chapters', parent_folder_id: folderId } },
  ]);
});

test('CSRF extraction accepts attribute ordering and escapes', () => {
  assert.equal(extractMeta("<meta data-other='x' content='a&#39;b&amp;c' name='ol-csrfToken' />", 'ol-csrfToken'), "a'b&c");
  assert.equal(extractMeta('<meta name="other" content="x">', 'ol-csrfToken'), undefined);
});

test('CSRF authentication failure never sends the mutation or follows redirects', async () => {
  for (const page of [new Response('', { status: 302, headers: { location: 'https://evil.test' } }), new Response('Google login')]) {
    let calls = 0;
    const client = new OverleafClient({ loadSession, fetch: async (_url, init) => { calls++; assert.equal(init?.redirect, 'manual'); return page; } });
    await assert.rejects(client.createProject('Paper'), errorCode('AUTH_OR_CHALLENGE'));
    assert.equal(calls, 1);
  }
});

test('API redirects, HTML challenges, access failures and rate limits have safe errors', async () => {
  for (const [status, contentType, code] of [[302, 'text/plain', 'AUTH_OR_CHALLENGE'], [200, 'text/html', 'AUTH_OR_CHALLENGE'], [403, 'text/plain', 'AUTH_OR_CHALLENGE'], [429, 'text/plain', 'RATE_LIMITED'], [500, 'application/json', 'OVERLEAF_HTTP']] as const) {
    let calls = 0;
    const client = new OverleafClient({ loadSession, fetch: async (_url, init) => {
      calls++; assert.equal(init?.redirect, 'manual');
      return new Response('private response local-test-secret', { status, headers: { 'content-type': contentType, location: 'https://evil.test' } });
    } });
    await assert.rejects(client.listProjects(), error => { assert.ok(errorCode(code)(error)); assert.doesNotMatch(String(error), /local-test-secret|private response|evil.test/); return true; });
    assert.equal(calls, 1);
  }
});

test('invalid identifiers, names, and missing cookies reject before any network request', async () => {
  let calls = 0;
  const client = new OverleafClient({ loadSession, fetch: async () => { calls++; throw Error('unexpected request'); }, socketFactory: async () => { calls++; throw Error('unexpected socket'); } });
  for (const name of ['', ' ', '..', 'a/b', 'a\\b', 'a\n', 'x'.repeat(150)]) await assert.rejects(client.createProject(name), errorCode('INVALID_NAME'));
  await assert.rejects(client.readDocument('../wrong', documentId), errorCode('INVALID_ID'));
  await assert.rejects(client.createDocument(projectId, 'main.tex', 'invalid'), errorCode('INVALID_ID'));
  const expired = new OverleafClient({ loadSession: async () => ({ ...session, cookies: session.cookies.map(cookie => ({ ...cookie, expires: 0 })) }), fetch: async () => { calls++; throw Error('unexpected request'); } });
  await assert.rejects(expired.listProjects(), errorCode('AUTH_OR_CHALLENGE'));
  assert.equal(calls, 0);
});

test('JSON and download responses enforce content-length and streaming byte limits', async () => {
  const tooLarge = new OverleafClient({ loadSession, fetch: async () => new Response('{}', { headers: { 'content-length': String(9 * 1024 * 1024) } }) });
  await assert.rejects(tooLarge.listProjects(), errorCode('RESPONSE_TOO_LARGE'));
  const client = new OverleafClient({ loadSession, fetch: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3, 4])); controller.close(); } })) });
  await assert.rejects(client.readOutput(projectId, output, 3), errorCode('RESPONSE_TOO_LARGE'));
  for (const max of [0, -1, 0.5, 51 * 1024 * 1024]) await assert.rejects(client.readOutput(projectId, output, max), errorCode('INVALID_LIMIT'));
});

for (const type of ['history-ot', 'sharejs-text-ot'] as const) {
  test(`reads ${type} Unicode content, version and content hash`, async () => {
    const content = 'Équation: α = 😀\n第二行';
    const socket = new FakeSocket(async () => snapshot(content, 4, type));
    const actual = await fromSocket(socket).readDocument(projectId, documentId);
    assert.deepEqual(actual, { content, version: 4, hash: createHash('sha256').update(content).digest('hex'), type });
    assert.deepEqual(socket.requests, [{ event: 'joinDoc', args: [documentId, -1, { supportsHistoryOT: true }] }]);
    assert.equal(socket.closed, true);
  });
}

test('project inspection returns its joined tree and always closes the socket', async () => {
  const socket = new FakeSocket();
  assert.deepEqual(await fromSocket(socket).getProject(projectId), socket.project);
  assert.equal(socket.closed, true);
});

test('unsupported representations and malformed Unicode are rejected', async () => {
  for (const payload of [[[], 4, [], {}, 'unknown'], [{ content: 'bad\uD800' }, 4, [], {}, 'history-ot'], snapshot('valid', -1)]) {
    const socket = new FakeSocket(async () => payload);
    await assert.rejects(fromSocket(socket).readDocument(projectId, documentId));
    assert.equal(socket.closed, true);
  }
});

test('both OT wire formats apply correctly to Unicode edits without splitting surrogate pairs', () => {
  for (const [before, after] of [['abc', 'aXc'], ['😀x', '😃x'], ['x😀', 'x😃'], ['', 'LaTeX α😀'], ['remove😀', ''], ['prefix😀tail', 'prefix😀Ztail'], ['é\n中', 'é\n文'], ['same', 'same']]) {
    for (const type of ['history-ot', 'sharejs-text-ot'] as const) {
      const operation = buildTextOperation(before!, after!, type);
      let actual = before!;
      if (type === 'sharejs-text-ot') {
        for (const component of operation as { p: number; d?: string; i?: string }[]) {
          assert.equal(wellFormed(actual.slice(0, component.p)), true);
          if (component.d !== undefined) { assert.equal(actual.slice(component.p, component.p + component.d.length), component.d); assert.equal(wellFormed(component.d), true); actual = actual.slice(0, component.p) + actual.slice(component.p + component.d.length); }
          if (component.i !== undefined) { assert.equal(wellFormed(component.i), true); actual = actual.slice(0, component.p) + component.i + actual.slice(component.p); }
        }
      } else {
        let cursor = 0;
        actual = '';
        for (const component of (operation[0] as { textOperation: (number | string)[] }).textOperation) {
          if (typeof component === 'string') { assert.equal(wellFormed(component), true); actual += component; }
          else if (component > 0) { actual += before!.slice(cursor, cursor + component); cursor += component; }
          else cursor -= component;
        }
        assert.equal(cursor, before!.length);
      }
      assert.equal(actual, after);
    }
  }
});

test('version conflicts and unchanged content never send an update', async () => {
  const conflict = new FakeSocket(async () => snapshot('current', 6));
  await assert.rejects(fromSocket(conflict).writeDocument(projectId, documentId, 'new', 4), errorCode('VERSION_CONFLICT'));
  assert.deepEqual(conflict.requests.map(item => item.event), ['joinDoc']);
  assert.equal(conflict.closed, true);
  const unchanged = new FakeSocket(async () => snapshot('a\nb', 4));
  const result = await fromSocket(unchanged).writeDocument(projectId, documentId, 'a\r\nb', 4);
  assert.equal(result.applied, false);
  assert.deepEqual(unchanged.requests.map(item => item.event), ['joinDoc']);
});

test('invalid content and expected versions reject before opening a project', async () => {
  let calls = 0;
  const client = new OverleafClient({ loadSession, socketFactory: async () => { calls++; throw Error('unexpected socket'); } });
  for (const content of ['bad\0text', 'bad\uD800', '\uDC00bad', 'é'.repeat(1024 * 1024 + 1)]) await assert.rejects(client.writeDocument(projectId, documentId, content, 0), errorCode('INVALID_CONTENT'));
  for (const version of [-1, 0.5, NaN, Infinity]) await assert.rejects(client.writeDocument(projectId, documentId, 'fine', version), errorCode('INVALID_VERSION'));
  assert.equal(calls, 0);
});

for (const type of ['history-ot', 'sharejs-text-ot'] as const) {
  test(`${type} bounded patches and recovery roundtrip distant Unicode changes without rewriting the gap`, async () => {
    const gap = '\\newcommand{\\custommacro}{Shared α😀}\n'.repeat(100);
    const before = `FIRST😀\n${gap}\nLAST中`;
    const patches = [{ search: 'LAST中', replace: 'END😃' }, { search: 'FIRST😀', replace: 'START' }];
    const plan = planPatches(before, patches);
    const server = documentServer(before, type);
    const changed = await server.client.patchDocument(projectId, documentId, patches, 4);
    assert.equal(changed.content, plan.content);
    assert.equal(changed.version, 5);
    assert.equal(changed.applied, true);
    assert.equal(changed.concurrentChanges, false);
    const restored = await server.client.restoreDocument(projectId, documentId, before, changed.version, plan.ranges);
    assert.equal(restored.content, before);
    assert.equal(restored.version, 6);
    assert.equal(restored.applied, true);
    assert.equal(restored.concurrentChanges, false);
    assert.equal(server.operations.length, 2);
    for (const operation of server.operations) assert.doesNotMatch(JSON.stringify(operation), /custommacro|Shared/);
    assert.ok(server.sockets.every(socket => socket.closed && socket.events.eventNames().length === 0));
  });

  test(`${type} recovery restores adjacent deletions and insertions at the same inverse offset`, async () => {
    for (const patches of [
      [{ search: 'A😀', replace: '' }, { search: 'B中', replace: '' }],
      [{ search: 'A😀', replace: '' }, { search: 'B中', replace: 'replacement😃' }],
    ]) {
      const before = 'A😀B中 untouched tail';
      const plan = planPatches(before, patches);
      const server = documentServer(before, type);
      const changed = await server.client.patchDocument(projectId, documentId, patches, 4);
      const restored = await server.client.restoreDocument(projectId, documentId, before, changed.version, plan.ranges);
      assert.equal(restored.content, before);
      assert.equal(restored.version, 6);
      assert.equal(server.operations.length, 2);
      for (const operation of server.operations) assert.doesNotMatch(JSON.stringify(operation), /untouched tail/);
    }
  });

  test(`${type} stale patch or recovery versions preserve collaborator changes`, async () => {
    const before = 'A😀 untouched text B中';
    const patches = [{ search: 'A😀', replace: 'Z' }];
    const plan = planPatches(before, patches);
    const server = documentServer(before, type);
    await assert.rejects(server.client.patchDocument(projectId, documentId, patches, 3), errorCode('VERSION_CONFLICT'));
    assert.equal(server.operations.length, 0);
    await server.client.patchDocument(projectId, documentId, patches, 4);
    server.state.content += ' collaborator addition';
    server.state.version++;
    const collaboratorContent = server.state.content;
    await assert.rejects(server.client.restoreDocument(projectId, documentId, before, 5, plan.ranges), errorCode('VERSION_CONFLICT'));
    assert.equal(server.state.content, collaboratorContent);
    assert.equal(server.operations.length, 1);
    assert.ok(server.sockets.every(socket => socket.closed));
  });
}

test('patch planning errors never enqueue an update', async () => {
  for (const patches of [
    [{ search: 'missing', replace: 'x' }],
    [{ search: 'abc', replace: '' }],
    [{ search: 'a', replace: 'x'.repeat(200) }],
  ]) {
    const server = documentServer('abc', 'history-ot');
    await assert.rejects(server.client.patchDocument(projectId, documentId, patches, 4), error => error instanceof PatchError);
    assert.equal(server.operations.length, 0);
    assert.equal(server.state.content, 'abc');
    assert.ok(server.sockets.every(socket => socket.closed));
  }
});

test('recovery rejects changed patch content and changes outside saved hunks even at the supplied version', async () => {
  const before = 'A😀 untouched text B中';
  const plan = planPatches(before, [{ search: 'A😀', replace: 'Z' }]);
  for (const content of [plan.content.replace('Z', 'X'), plan.content + ' collaborator addition']) {
    const server = documentServer(content, 'history-ot');
    await assert.rejects(server.client.restoreDocument(projectId, documentId, before, 4, plan.ranges), errorCode('VERSION_CONFLICT'));
    assert.equal(server.operations.length, 0);
    assert.equal(server.state.content, content);
    assert.ok(server.sockets.every(socket => socket.closed));
  }
});

for (const type of ['history-ot', 'sharejs-text-ot'] as const) {
  test(`${type} write waits for queue AND own applied acknowledgement, then verifies`, async () => {
    let joins = 0;
    let queueResolve!: (value: unknown[]) => void;
    const queued = new Promise<unknown[]>(resolve => { queueResolve = resolve; });
    const socket = new FakeSocket(async event => event === 'joinDoc' ? snapshot(++joins === 1 ? 'before 😀' : 'after 😃\n', joins === 1 ? 4 : 5, type) : queued);
    let completed = false;
    const write = fromSocket(socket).writeDocument(projectId, documentId, 'after 😃\r\n', 4).then(result => { completed = true; return result; });
    await tick();
    assert.equal(socket.requests[1]?.event, 'applyOtUpdate');
    assert.deepEqual(socket.requests[1]?.args, [documentId, { doc: documentId, v: 4, op: buildTextOperation('before 😀', 'after 😃\n', type) }]);
    socket.events.emit('otUpdateApplied', { doc: documentId, v: 4, op: [{ i: 'collaborator', p: 0 }] });
    socket.events.emit('otUpdateApplied', { doc: folderId, v: 4 });
    socket.events.emit('otUpdateApplied', { doc: documentId, v: 3 });
    await tick();
    assert.equal(completed, false);
    assert.equal(joins, 1);
    socket.events.emit('otUpdateApplied', { doc: documentId, v: 4 });
    await tick();
    assert.equal(completed, false);
    assert.equal(joins, 1);
    queueResolve([]);
    const actual = await write;
    assert.equal(actual.applied, true);
    assert.equal(actual.concurrentChanges, false);
    assert.equal(actual.content, 'after 😃\n');
    assert.equal(actual.version, 5);
    assert.equal(socket.closed, true);
    assert.equal(socket.events.eventNames().length, 0);
  });
}

test('queue acknowledgement alone times out as an uncertain write and is not retried', async () => {
  const socket = new FakeSocket(async event => event === 'joinDoc' ? snapshot('before') : []);
  await assert.rejects(fromSocket(socket, 15).writeDocument(projectId, documentId, 'after', 4), errorCode('WRITE_STATUS_UNKNOWN'));
  assert.deepEqual(socket.requests.map(item => item.event), ['joinDoc', 'applyOtUpdate']);
  assert.equal(socket.events.eventNames().length, 0);
  assert.equal(socket.closed, true);
});

test('persistence rejection and disconnect preserve known versus uncertain outcomes', async () => {
  for (const kind of ['rejection', 'disconnect', 'queue-error'] as const) {
    const socket = new FakeSocket(async event => {
      if (event === 'joinDoc') return snapshot('before');
      if (kind === 'queue-error') throw new OverleafError('OVERLEAF_REJECTED', 'No access');
      queueMicrotask(() => kind === 'rejection' ? socket.events.emit('otUpdateError', 'private server error', { doc_id: documentId }) : socket.events.emit('disconnect'));
      return [];
    });
    await assert.rejects(fromSocket(socket).writeDocument(projectId, documentId, 'after', 4), errorCode(kind === 'rejection' ? 'WRITE_REJECTED' : kind === 'queue-error' ? 'OVERLEAF_REJECTED' : 'WRITE_STATUS_UNKNOWN'));
    assert.equal(socket.events.eventNames().length, 0);
  }
});

test('post-write reads distinguish concurrent edits, stale snapshots, and failed verification', async () => {
  for (const mode of ['concurrent', 'stale', 'failed'] as const) {
    let joins = 0;
    const socket = new FakeSocket(async event => {
      if (event === 'joinDoc') {
        if (++joins === 1 || mode === 'stale') return snapshot('before');
        if (mode === 'failed') throw Error('read failed');
        return snapshot('after with collaborator changes', 6);
      }
      queueMicrotask(() => socket.events.emit('otUpdateApplied', { doc: documentId, v: 4 }));
      return [];
    });
    const write = fromSocket(socket).writeDocument(projectId, documentId, 'after', 4);
    if (mode === 'concurrent') { const result = await write; assert.equal(result.applied, true); assert.equal(result.concurrentChanges, true); assert.equal(result.version, 6); }
    else await assert.rejects(write, errorCode('WRITE_APPLIED_READ_FAILED'));
    assert.equal(socket.requests.filter(item => item.event === 'applyOtUpdate').length, 1);
  }
});

test('compile follows reference fields and carries routing parameters to safe output URLs', async () => {
  const client = new OverleafClient({ loadSession, fetch: async (url, init) => {
    if (String(url) === `${OVERLEAF_ORIGIN}/project`) return csrfPage();
    assert.equal(String(url), `${OVERLEAF_ORIGIN}/project/${projectId}/compile?file_line_errors=true`);
    assert.deepEqual(JSON.parse(String(init?.body)), { stopOnFirstError: true, compiler: 'xelatex', rootDoc_id: documentId });
    return json({ status: 'success', clsiServerId: 'server-1', compileGroup: 'priority', outputFiles: [{ path: 'output.pdf', url: output }, { path: 'nested/output.log', url: output.replace('output.pdf', 'nested/output.log') }] });
  } });
  const result = await client.compileProject(projectId, { compiler: 'xelatex', rootDocId: documentId, stopOnFirstError: true });
  assert.equal(result.outputFiles.length, 2);
  assert.equal(result.outputFiles[0]?.url, `${OVERLEAF_ORIGIN}${output}?clsiserverid=server-1&compileGroup=priority`);
});

test('compilation stops on the first error by default while allowing explicit legacy behavior', async () => {
  const observed: unknown[] = [];
  const client = new OverleafClient({ loadSession, fetch: async (url, init) => {
    if (String(url) === `${OVERLEAF_ORIGIN}/project`) return csrfPage();
    observed.push(JSON.parse(String(init?.body)));
    return json({ status: 'success', outputFiles: [] });
  } });
  await client.compileProject(projectId);
  await client.compileProject(projectId, { stopOnFirstError: false });
  assert.deepEqual(observed, [{ stopOnFirstError: true }, { stopOnFirstError: false }]);
});

test('output allowlist permits reference routes but blocks foreign origins and traversal', async () => {
  for (const path of [output, output.replace('/build/', `/user/${folderId}/build/`), `/download${output}`, `/download${output.replace('/output/', '/output/cached/')}`, output.replace('output.pdf', 'nested/output.log')]) assert.equal(trustedOutputUrl(projectId, path).origin, OVERLEAF_ORIGIN);
  let calls = 0;
  const client = new OverleafClient({ loadSession, fetch: async () => { calls++; throw Error('unexpected fetch'); } });
  for (const unsafe of [`https://evil.test${output}`, `https://www.overleaf.com.evil.test${output}`, `https://user:pass@www.overleaf.com${output}`, '//evil.test/output.pdf', output.replace(projectId, folderId), `/project/${projectId}`, output.replace('output.pdf', '../output.pdf'), output.replace('output.pdf', '%2e%2e/output.pdf'), output.replace('output.pdf', 'x%2fy.pdf'), output.replace('output.pdf', 'x%5cy.pdf'), output.replace('output.pdf', '%252e%252e.pdf'), output.replace('output.pdf', '%ZZ.pdf'), 'https://[invalid']) await assert.rejects(client.readOutput(projectId, unsafe), errorCode('UNSAFE_OUTPUT_URL'));
  assert.equal(calls, 0);
});

test('output download returns bounded bytes and never follows an artifact redirect', async () => {
  const client = new OverleafClient({ loadSession, fetch: async (url, init) => { assert.equal(String(url), `${OVERLEAF_ORIGIN}${output}`); assert.equal(init?.redirect, 'manual'); return new Response('%PDF', { headers: { 'content-type': 'application/pdf' } }); } });
  const result = await client.readOutput(projectId, output, 4);
  assert.equal(result.contentType, 'application/pdf');
  assert.equal(result.data.toString(), '%PDF');
  const redirect = new OverleafClient({ loadSession, fetch: async () => new Response('', { status: 302, headers: { location: 'https://evil.test/private.pdf' } }) });
  await assert.rejects(redirect.readOutput(projectId, output), errorCode('AUTH_OR_CHALLENGE'));
});

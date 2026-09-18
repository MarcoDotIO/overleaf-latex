import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { connectRealtime, mergeHandshakeCookies, OverleafError, SocketIo09Connection, type RealtimeOptions } from '../src/realtime.js';

const projectId = '0123456789abcdef01234567';
const errorCode = (code: string) => (error: unknown): boolean => error instanceof OverleafError && error.code === code;
const options: RealtimeOptions = { projectId, origin: 'https://www.overleaf.com', cookie: 'overleaf.sid=test-secret', fetch: globalThis.fetch, timeoutMs: 300 };
const event = (name: string, args: unknown[]) => `5:::${JSON.stringify({ name, args })}`;

async function localSocket(t: TestContext, timeoutMs = 500) {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const incoming = once(wss, 'connection');
  const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/socket.io/1/websocket/fixture-session`);
  const connection = new SocketIo09Connection(ws, timeoutMs, 'fixture-session');
  const [peer] = await incoming as [WebSocket];
  await once(ws, 'open');
  t.after(async () => {
    connection.close();
    peer.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return { connection, peer, ws };
}

async function joinedSocket(t: TestContext, timeoutMs = 500) {
  const result = await localSocket(t, timeoutMs);
  result.peer.send('1::');
  result.peer.send(event('joinProjectResponse', [{ project: { _id: projectId, name: 'Protocol fixture' }, publicId: 'public-test-id' }]));
  await result.connection.ready;
  return result;
}

test('default real-time resource reaches fixed-origin handshake with no redirect following', async () => {
  for (const status of [401, 403, 302]) {
    let requests = 0;
    await assert.rejects(connectRealtime({ ...options, fetch: async (url, init) => {
      requests++;
      const target = new URL(String(url));
      assert.equal(target.origin, options.origin);
      assert.equal(target.pathname, '/socket.io/1/');
      assert.equal(target.searchParams.get('projectId'), projectId);
      assert.equal(init?.redirect, 'manual');
      assert.equal(new Headers(init?.headers).get('Cookie'), options.cookie);
      assert.ok(init?.signal);
      return new Response('private server body', { status, headers: { location: 'https://evil.test' } });
    } }), error => { assert.ok(errorCode('AUTH_OR_CHALLENGE')(error)); assert.doesNotMatch(String(error), /private server body|test-secret/); return true; });
    assert.equal(requests, 1);
  }
});

test('handshake rejects modern protocols, missing websocket, HTML, and oversized bodies', async () => {
  for (const response of [new Response('0{"sid":"modern"}'), new Response('sid:15:60:xhr-polling'), new Response('sid:15:60:websocket\nextra'), new Response('x'.repeat(4097)), new Response('please sign in', { headers: { 'content-type': 'text/html' } })]) {
    await assert.rejects(connectRealtime({ ...options, fetch: async () => response }), error => error instanceof OverleafError && ['UNSUPPORTED_REALTIME', 'AUTH_OR_CHALLENGE'].includes(error.code));
  }
});

test('handshake origin, path, and project ID are validated before credentials leave', async () => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => { calls++; throw Error('must not fetch'); };
  for (const changes of [{ origin: 'https://evil.test' }, { origin: 'https://www.overleaf.com.evil.test' }, { resource: '//evil.test' }, { resource: '/socket.io/../private' }, { resource: '/socket.io?redirect=evil' }, { resource: '/socket.io/%2f' }, { projectId: '../../private' }]) await assert.rejects(connectRealtime({ ...options, ...changes, fetch }), error => error instanceof OverleafError && ['UNSAFE_URL', 'INVALID_ID'].includes(error.code));
  assert.equal(calls, 0);
});

test('handshake cookies replace load-balancer affinity without leaking or persisting credentials', () => {
  const target = 'wss://www.overleaf.com/socket.io/1/websocket/session';
  const original = 'overleaf.sid=session-secret; GCLB=old-route; expired=old';
  const actual = mergeHandshakeCookies(original, [
    'GCLB=new-route; Path=/; Secure; HttpOnly',
    'socket-token=scoped; Domain=.overleaf.com; Path=/socket.io/1',
    'expired=remove; Max-Age=0; Path=/',
    'evil-domain=no; Domain=google.com; Path=/',
    'wrong-path=no; Path=/project',
    'bad-value=secret\r\nInjected: yes; Path=/',
    'invalid cookie=no; Path=/',
    'ancient=remove; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/',
  ], target);
  assert.equal(actual, 'overleaf.sid=session-secret; GCLB=new-route; socket-token=scoped');
  assert.equal(original, 'overleaf.sid=session-secret; GCLB=old-route; expired=old');
  assert.throws(() => mergeHandshakeCookies(original, [], 'wss://evil.test/socket.io'), errorCode('UNSAFE_URL'));
});

test('full handshake uses fresh routing cookie on local WebSocket upgrade and opens project', async t => {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  let peer: WebSocket | undefined;
  let connection: Awaited<ReturnType<typeof connectRealtime>> | undefined;
  t.after(async () => {
    connection?.close();
    peer?.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  wss.once('connection', (socket, request) => {
    peer = socket;
    assert.equal(request.headers.cookie, 'overleaf.sid=test-secret; GCLB=fresh-route');
    socket.send('1::');
    socket.send(event('joinProjectResponse', [{ project: { _id: projectId } }]));
  });
  connection = await connectRealtime({
    ...options, cookie: 'overleaf.sid=test-secret; GCLB=stale-route',
    fetch: async () => new Response('fixture-session:15:60:websocket,xhr-polling', { headers: { 'set-cookie': 'GCLB=fresh-route; Path=/; HttpOnly' } }),
    webSocketFactory: (url, socketOptions) => {
      const target = new URL(url);
      assert.equal(target.origin, 'wss://www.overleaf.com');
      assert.equal(target.pathname, '/socket.io/1/websocket/fixture-session');
      assert.equal(socketOptions.followRedirects, false);
      assert.equal(socketOptions.maxPayload, 8 * 1024 * 1024);
      return new WebSocket(`ws://127.0.0.1:${port}${target.pathname}${target.search}`, socketOptions);
    },
  });
  assert.deepEqual(connection.project, { _id: projectId });
});

test('failed WebSocket upgrades expose only the HTTP status, never response details', async t => {
  const server = createServer((_request, response) => { response.writeHead(502, { 'x-secret': 'private-header' }); response.end('private body'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/socket.io/1/websocket/test`);
  const connection = new SocketIo09Connection(ws, 500, 'test');
  await assert.rejects(connection.ready, error => {
    assert.ok(errorCode('REALTIME_HTTP')(error));
    assert.match(String(error), /HTTP 502/);
    assert.doesNotMatch(String(error), /private-header|private body/);
    return true;
  });
});

test('local Socket.IO 0.9 frames join the project and acknowledge reference joinDoc RPC', async t => {
  const { connection, peer } = await joinedSocket(t);
  assert.deepEqual(connection.project, { _id: projectId, name: 'Protocol fixture' });
  const wire = once(peer, 'message');
  const response = connection.request('joinDoc', ['1123456789abcdef01234567', -1, { supportsHistoryOT: true }]);
  const [packet] = await wire;
  assert.equal(String(packet), '5:1+::{"name":"joinDoc","args":["1123456789abcdef01234567",-1,{"supportsHistoryOT":true}]}');
  peer.send('6:::1+[null,{"content":"Hello α😀"},7,[],{},"history-ot"]');
  assert.deepEqual(await response, [{ content: 'Hello α😀' }, 7, [], {}, 'history-ot']);
});

test('queue callback accepts empty acknowledgement and application event remains independent', async t => {
  const { connection, peer } = await joinedSocket(t);
  let applied: unknown[] | undefined;
  const unsubscribe = connection.on('otUpdateApplied', (...args) => { applied = args; });
  const wire = once(peer, 'message');
  const queued = connection.request('applyOtUpdate', ['doc', { v: 7, op: [] }]);
  await wire;
  peer.send('6:::1');
  assert.deepEqual(await queued, []);
  assert.equal(applied, undefined);
  const delivered = new Promise<void>(resolve => connection.on('otUpdateApplied', () => resolve()));
  peer.send(event('otUpdateApplied', [{ doc: 'doc', v: 7 }]));
  await delivered;
  assert.deepEqual(applied, [{ doc: 'doc', v: 7 }]);
  unsubscribe();
});

test('Socket.IO and Overleaf server heartbeats both receive matching responses', async t => {
  const { peer } = await joinedSocket(t);
  const heartbeat = once(peer, 'message');
  peer.send('2::');
  assert.equal(String((await heartbeat)[0]), '2::');
  const pong = once(peer, 'message');
  peer.send(event('serverPing', [2, 123456, 'websocket', 'fixture-session']));
  assert.equal(String((await pong)[0]), '5:::{"name":"clientPong","args":[2,123456,"websocket","fixture-session","websocket","fixture-session"]}');
});

test('server rejection is redacted and only the matching request is rejected', async t => {
  const { connection, peer } = await joinedSocket(t);
  const request = connection.request('joinDoc', ['doc']);
  const rejected = assert.rejects(request, error => { assert.ok(errorCode('OVERLEAF_REJECTED')(error)); assert.doesNotMatch(String(error), /private secret/); return true; });
  peer.send('6:::999+[null,"unrelated"]');
  peer.send('6:::1+[{"message":"private secret"}]');
  await rejected;
  const next = connection.request('joinDoc', ['another-doc']);
  peer.send('6:::2+[null,[],1]');
  assert.deepEqual(await next, [[], 1]);
});

test('real request deadline rejects without replaying a timed-out write', async t => {
  const { connection, peer } = await joinedSocket(t, 100);
  const packets: string[] = [];
  peer.on('message', data => packets.push(data.toString()));
  await assert.rejects(connection.request('applyOtUpdate', ['doc', {}]), errorCode('REALTIME_TIMEOUT'));
  assert.equal(packets.length, 1);
  peer.send('6:::1'); // late acknowledgement is ignored
});

test('disconnect fails in-flight requests and future requests are not sent', async t => {
  const { connection, peer } = await joinedSocket(t);
  const request = connection.request('joinDoc', ['doc']);
  const rejected = assert.rejects(request, errorCode('REALTIME_DISCONNECTED'));
  peer.send('0::');
  await rejected;
  await assert.rejects(connection.request('joinDoc', ['doc']), errorCode('REALTIME_DISCONNECTED'));
});

test('invalid frames and malformed acknowledgement payloads fail closed', async t => {
  for (const packet of ['garbage', '6:::1+{"not":"array"}', '5:::{"name":"event","args":"not-array"}', '4:::unsupported-json']) {
    await t.test(packet, async sub => {
      const { connection, peer } = await joinedSocket(sub);
      const rejected = assert.rejects(connection.request('joinDoc', ['doc']), errorCode('REALTIME_PROTOCOL'));
      peer.send(packet);
      await rejected;
    });
  }
});

test('join rejection, malformed project, and startup timeout reject readiness', async t => {
  for (const [packet, code] of [[event('connectionRejected', [{ message: 'private secret' }]), 'AUTH_OR_CHALLENGE'], [event('joinProjectResponse', [{ project: [] }]), 'REALTIME_PROTOCOL'], ['', 'REALTIME_TIMEOUT']] as const) {
    await t.test(code, async sub => {
      const { connection, peer } = await localSocket(sub, 100);
      const rejected = assert.rejects(connection.ready, errorCode(code));
      if (packet) peer.send(packet);
      await rejected;
    });
  }
});

test('service reconnect requests close without silently replaying pending operations', async t => {
  for (const name of ['reconnectGracefully', 'forceDisconnect']) await t.test(name, async sub => {
    const { connection, peer } = await joinedSocket(sub);
    const rejected = assert.rejects(connection.request('applyOtUpdate', ['doc', {}]), errorCode('REALTIME_DISCONNECTED'));
    peer.send(event(name, []));
    await rejected;
  });
});

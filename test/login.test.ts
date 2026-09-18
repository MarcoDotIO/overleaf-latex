import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkSavedSession, isAuthenticatedProjectHtml, parseLoginArguments } from '../src/login.js';
import {
  buildCookieHeader, clearSession, getSessionPath, loadSession, OVERLEAF_ORIGIN,
  saveSession, sessionFromCookieHeader, validateSession, type SessionCookie,
} from '../src/session.js';

const cookie: SessionCookie = {
  name: 'overleaf.sid', value: 'private-session-test-value', domain: '.overleaf.com',
  path: '/', expires: -1, secure: true, httpOnly: true, sameSite: 'Lax',
};
const authenticatedHtml = '<meta content="{&quot;_id&quot;:&quot;0123456789abcdef01234567&quot;}" name="ol-user" data-type="json">';

test('saves only Overleaf cookies atomically with private directory and file permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'overleaf-session-test-'));
  try {
    const path = join(directory, 'private', 'session.json');
    await saveSession({ cookies: [cookie, { ...cookie, domain: '.google.com', name: 'google-token' }] }, path);
    const actual = await loadSession(path);
    assert.deepEqual(actual.cookies, [cookie]);
    assert.deepEqual(actual.origins, []);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, 'private'))).mode & 0o777, 0o700);
    assert.doesNotMatch(await readFile(path, 'utf8'), /google-token/);
    await saveSession({ cookies: [{ ...cookie, value: 'replacement' }] }, path);
    assert.equal((await loadSession(path)).cookies[0]?.value, 'replacement');
    await clearSession(path);
    await clearSession(path);
    await assert.rejects(loadSession(path), /No saved Overleaf session/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('rejects readable session files, symlinks, and insecure parent directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'overleaf-session-test-'));
  try {
    const path = join(directory, 'session.json');
    await saveSession({ cookies: [cookie] }, path);
    await chmod(path, 0o644);
    await assert.rejects(loadSession(path), /owner-only regular file/);
    await chmod(path, 0o600);
    const link = join(directory, 'session-link.json');
    await symlink(path, link);
    await assert.rejects(loadSession(link), /symbolic link/);
    await chmod(directory, 0o755);
    await assert.rejects(saveSession({ cookies: [cookie] }, path), /owner-only directory/);
    assert.equal((await stat(directory)).mode & 0o777, 0o755, 'does not chmod a user-supplied shared directory');
  } finally { await chmod(directory, 0o700); await rm(directory, { recursive: true, force: true }); }
});

test('invalid saved content never appears in validation errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'overleaf-session-test-'));
  try {
    const path = join(directory, 'session.json');
    await writeFile(path, 'super-secret malformed JSON', { mode: 0o600 });
    await assert.rejects(loadSession(path), error => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /super-secret/);
      return true;
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('cookie headers obey origin, expiration, and path boundaries', () => {
  const session = sessionFromCookieHeader('overleaf.sid=session');
  session.cookies.push({ ...cookie, name: 'expired', expires: 0 });
  session.cookies.push({ ...cookie, name: 'project-cookie', path: '/project/123' });
  assert.equal(buildCookieHeader(session), 'overleaf.sid=session');
  assert.equal(buildCookieHeader(session, `${OVERLEAF_ORIGIN}/project/123/doc`), 'project-cookie=private-session-test-value; overleaf.sid=session');
  assert.equal(buildCookieHeader(session, `${OVERLEAF_ORIGIN}/project/1234`), 'overleaf.sid=session');
  for (const url of ['https://evil.test/project', 'http://www.overleaf.com/project', 'https://www.overleaf.com.evil.test/project', 'https://user:pass@www.overleaf.com/project']) {
    assert.throws(() => buildCookieHeader(session, url), /another origin/);
  }
});

test('session validation rejects untrusted domains and header injection', () => {
  const session = sessionFromCookieHeader('overleaf.sid=session');
  assert.throws(() => validateSession({ ...session, cookies: [{ ...cookie, domain: '.google.com' }] }), /Invalid Overleaf session cookie/);
  assert.throws(() => validateSession({ ...session, cookies: [{ ...cookie, value: 'secret\r\nOther: header' }] }), /Invalid Overleaf session cookie/);
  assert.throws(() => validateSession({ ...session, origin: 'https://evil.test' }), /Invalid Overleaf session file/);
  assert.throws(() => validateSession({ ...session, origins: [{ origin: 'https://google.com', localStorage: [] }] }), /Invalid Overleaf session file/);
});

test('manual Cookie import requires an Overleaf session and rejects malformed data', () => {
  const result = sessionFromCookieHeader('Cookie: overleaf.sid=s%3Aabc; cf_clearance=abc=xyz\n');
  assert.equal(buildCookieHeader(result), 'overleaf.sid=s%3Aabc; cf_clearance=abc=xyz');
  for (const invalid of ['cookie=value', 'overleaf.sid=', 'overleaf.sid=x\r\nHost: evil.test', 'overleaf.sid=x; no-equals']) {
    assert.throws(() => sessionFromCookieHeader(invalid));
  }
});

test('authenticated page requires the actual Overleaf project route and a user ID', () => {
  assert.ok(isAuthenticatedProjectHtml(authenticatedHtml, `${OVERLEAF_ORIGIN}/project`));
  assert.ok(isAuthenticatedProjectHtml(authenticatedHtml, `${OVERLEAF_ORIGIN}/project/`));
  assert.equal(isAuthenticatedProjectHtml(authenticatedHtml, `${OVERLEAF_ORIGIN}/login`), false);
  assert.equal(isAuthenticatedProjectHtml(authenticatedHtml, 'https://evil.test/project'), false);
  assert.equal(isAuthenticatedProjectHtml('<meta name="ol-user" content="null">', `${OVERLEAF_ORIGIN}/project`), false);
  assert.equal(isAuthenticatedProjectHtml('<meta name="ol-user" content="{}">', `${OVERLEAF_ORIGIN}/project`), false);
});

test('session check makes a bounded request without following redirects', async () => {
  const session = sessionFromCookieHeader('overleaf.sid=session');
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(input, `${OVERLEAF_ORIGIN}/project`);
    assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).get('Cookie'), 'overleaf.sid=session');
    assert.ok(init?.signal);
    return new Response(authenticatedHtml);
  };
  await checkSavedSession(session, fetcher);
  await assert.rejects(checkSavedSession(session, async () => new Response('', { status: 302, headers: { Location: 'https://evil.test' } })), /did not confirm/);
  await assert.rejects(checkSavedSession(session, async () => new Response('', { status: 403 })), /refused session verification/);
  await assert.rejects(checkSavedSession(session, async () => { throw new Error('secret-data'); }), error => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /secret-data/);
    return true;
  });
});

test('CLI arguments separate session checking, removal, manual import, and bounded login', () => {
  assert.deepEqual(parseLoginArguments([]), { mode: 'login', timeoutSeconds: 600 });
  assert.equal(parseLoginArguments(['--check']).mode, 'check');
  assert.equal(parseLoginArguments(['--logout']).mode, 'logout');
  assert.equal(parseLoginArguments(['--timeout', '900']).timeoutSeconds, 900);
  assert.equal(parseLoginArguments(['--import-cookie-file', '/private/cookie.txt']).cookieFile, '/private/cookie.txt');
  for (const args of [['--check', '--logout'], ['--timeout', 'NaN'], ['--timeout', '1'], ['--import-cookie-file'], ['--unknown']]) {
    assert.throws(() => parseLoginArguments(args));
  }
  assert.equal(getSessionPath({ OVERLEAF_SESSION_FILE: '/private/session.json' }), '/private/session.json');
});

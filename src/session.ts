import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const OVERLEAF_ORIGIN = 'https://www.overleaf.com';
const MAX_SESSION_BYTES = 256 * 1024;
const TRUSTED_DOMAINS = new Set(['overleaf.com', '.overleaf.com', 'www.overleaf.com', '.www.overleaf.com']);

export interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

export interface SavedSession {
  version: 1;
  origin: typeof OVERLEAF_ORIGIN;
  savedAt: string;
  cookies: SessionCookie[];
  origins: [];
}

export function getSessionPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OVERLEAF_SESSION_FILE?.trim();
  return configured ? resolve(configured) : join(homedir(), '.config', 'overleaf-latex', 'session.json');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateCookie(value: unknown): SessionCookie {
  if (!isObject(value) || typeof value.name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value.name)
    || typeof value.value !== 'string' || !/^[\x21-\x3A\x3C-\x7E]*$/.test(value.value)
    || typeof value.domain !== 'string' || !TRUSTED_DOMAINS.has(value.domain)
    || typeof value.path !== 'string' || !value.path.startsWith('/') || /[\x00-\x20\x7F]/.test(value.path)
    || typeof value.expires !== 'number' || !Number.isFinite(value.expires) || value.expires < -1
    || typeof value.httpOnly !== 'boolean' || typeof value.secure !== 'boolean'
    || !['Strict', 'Lax', 'None'].includes(value.sameSite as string)) {
    throw new Error('Invalid Overleaf session cookie. Sign in again.');
  }
  return {
    name: value.name, value: value.value, domain: value.domain, path: value.path,
    expires: value.expires, httpOnly: value.httpOnly, secure: value.secure,
    sameSite: value.sameSite as SessionCookie['sameSite'],
  };
}

export function validateSession(value: unknown): SavedSession {
  if (!isObject(value) || value.version !== 1 || value.origin !== OVERLEAF_ORIGIN
    || typeof value.savedAt !== 'string' || !Number.isFinite(Date.parse(value.savedAt))
    || !Array.isArray(value.cookies) || value.cookies.length === 0 || value.cookies.length > 512
    || !Array.isArray(value.origins) || value.origins.length !== 0) {
    throw new Error('Invalid Overleaf session file. Sign in again.');
  }
  return {
    version: 1, origin: OVERLEAF_ORIGIN, savedAt: value.savedAt,
    cookies: value.cookies.map(validateCookie), origins: [],
  };
}

export async function loadSession(filePath = getSessionPath()): Promise<SavedSession> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_SESSION_BYTES || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error('Session file must be a private, owner-only regular file (chmod 600).');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(await handle.readFile('utf8')); }
    catch { throw new Error('Invalid Overleaf session file. Sign in again.'); }
    return validateSession(parsed);
  } catch (error) {
    if (isObject(error) && error.code === 'ENOENT') {
      throw new Error('No saved Overleaf session. Run npm run login first.');
    }
    if (isObject(error) && error.code === 'ELOOP') {
      throw new Error('The Overleaf session file must not be a symbolic link.');
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

/** Store only Overleaf cookies; Google cookies, localStorage, and tokens are discarded. */
export async function saveSession(
  storageState: { cookies: unknown[] }, filePath = getSessionPath(),
): Promise<SavedSession> {
  const session = validateSession({
    version: 1, origin: OVERLEAF_ORIGIN, savedAt: new Date().toISOString(), origins: [],
    cookies: storageState.cookies.filter(cookie => isObject(cookie) && TRUSTED_DOMAINS.has(cookie.domain as string)),
  });
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
    || (directoryStat.mode & 0o777) !== 0o700
    || (process.getuid && directoryStat.uid !== process.getuid())) {
    throw new Error('Session directory must be an owner-only directory (chmod 700). Choose a private OVERLEAF_SESSION_FILE location.');
  }
  const temporary = join(directory, `.session-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(`${JSON.stringify(session)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filePath);
    await chmod(filePath, 0o600);
  } finally {
    await handle?.close();
    await unlink(temporary).catch(() => undefined);
  }
  return session;
}

export async function clearSession(filePath = getSessionPath()): Promise<void> {
  await unlink(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

/** Refuse to disclose session cookies to any other origin. */
export function buildCookieHeader(session: SavedSession, url = `${OVERLEAF_ORIGIN}/project`): string {
  const target = new URL(url);
  if (target.origin !== OVERLEAF_ORIGIN || target.username || target.password) {
    throw new Error('Refusing to send an Overleaf session to another origin.');
  }
  const now = Date.now() / 1000;
  return session.cookies.map(validateCookie)
    .filter(cookie => (cookie.expires === -1 || cookie.expires > now)
      && (target.pathname === cookie.path || target.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`)))
    .sort((a, b) => b.path.length - a.path.length)
    .map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

/** Import only a Cookie request-header line copied locally from Overleaf. */
export function sessionFromCookieHeader(header: string): SavedSession {
  const trimmed = header.trim().replace(/^Cookie:\s*/i, '');
  if (!trimmed || trimmed.length > MAX_SESSION_BYTES || /[\r\n]/.test(trimmed)) {
    throw new Error('Expected a single Cookie request-header line from www.overleaf.com.');
  }
  const cookies = trimmed.split(';').map(part => {
    const item = part.trim();
    const separator = item.indexOf('=');
    if (separator < 1) throw new Error('Invalid Cookie request-header line.');
    return validateCookie({
      name: item.slice(0, separator), value: item.slice(separator + 1),
      domain: 'www.overleaf.com', path: '/', expires: -1,
      secure: true, httpOnly: true, sameSite: 'Lax',
    });
  });
  if (!cookies.some(cookie => cookie.name === 'overleaf.sid' && cookie.value)) {
    throw new Error('The Cookie header does not contain an Overleaf session (overleaf.sid).');
  }
  return validateSession({ version: 1, origin: OVERLEAF_ORIGIN, savedAt: new Date().toISOString(), cookies, origins: [] });
}

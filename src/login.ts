import { constants } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type BrowserContext } from 'playwright';
import {
  buildCookieHeader, clearSession, getSessionPath, loadSession, OVERLEAF_ORIGIN,
  saveSession, sessionFromCookieHeader, type SavedSession,
} from './session.js';

function decodeHtml(value: string): string {
  return value.replace(/&(?:quot|apos|amp|lt|gt|#\d+|#x[0-9a-f]+);/gi, entity => {
    const names: Record<string, string> = { '&quot;': '"', '&apos;': "'", '&amp;': '&', '&lt;': '<', '&gt;': '>' };
    if (names[entity.toLowerCase()]) return names[entity.toLowerCase()]!;
    const hex = entity.slice(0, 3).toLowerCase() === '&#x';
    const number = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    return number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
  });
}

/** The reference server renders ol-user with a user ID only for authenticated users. */
export function isAuthenticatedProjectHtml(html: string, url: string): boolean {
  let location: URL;
  try { location = new URL(url); } catch { return false; }
  if (location.origin !== OVERLEAF_ORIGIN || !/^\/project\/?$/.test(location.pathname)) return false;
  for (const tag of html.matchAll(/<meta\s+[^>]*>/gi)) {
    const attributes: Record<string, string> = {};
    for (const attribute of tag[0].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attributes[attribute[1]!.toLowerCase()] = decodeHtml(attribute[2] ?? attribute[3] ?? '');
    }
    if (attributes.name !== 'ol-user') continue;
    try {
      const user: unknown = JSON.parse(attributes.content ?? '');
      if (user && typeof user === 'object' && '_id' in user && typeof user._id === 'string' && /^[a-f\d]{24}$/i.test(user._id)) return true;
    } catch { /* Not an authenticated metadata payload. */ }
  }
  return false;
}

export async function checkSavedSession(session: SavedSession, fetcher: typeof fetch = fetch): Promise<void> {
  const url = `${OVERLEAF_ORIGIN}/project`;
  const cookie = buildCookieHeader(session, url);
  if (!cookie) throw new Error('The saved Overleaf session has expired. Run npm run login again.');
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { Cookie: cookie, Accept: 'text/html' },
      redirect: 'manual', signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error('Could not reach Overleaf to verify the session. Check your connection and try again.');
  }
  if (response.status === 403 || response.status === 429) {
    throw new Error(`Overleaf refused session verification (HTTP ${response.status}). Complete any browser challenge in Overleaf; no challenge bypass is attempted.`);
  }
  if (!response.ok || !isAuthenticatedProjectHtml(await response.text(), response.url || url)) {
    throw new Error('Overleaf did not confirm an authenticated project page. Run npm run login again.');
  }
}

export interface LoginOptions {
  mode: 'login' | 'check' | 'logout' | 'import' | 'help';
  timeoutSeconds: number;
  cookieFile?: string;
}

export function parseLoginArguments(args: string[]): LoginOptions {
  const result: LoginOptions = { mode: 'login', timeoutSeconds: 600 };
  let hasMode = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--timeout') {
      const timeout = Number(args[++index]);
      if (!Number.isInteger(timeout) || timeout < 30 || timeout > 1800) throw new Error('--timeout must be between 30 and 1800 seconds.');
      result.timeoutSeconds = timeout;
    } else if (['--check', '--logout', '--help', '-h', '--import-cookie-file'].includes(argument ?? '')) {
      if (hasMode) throw new Error('Choose only one login action.');
      hasMode = true;
      if (argument === '--import-cookie-file') {
        const file = args[++index];
        if (!file || file.startsWith('--')) throw new Error('--import-cookie-file requires a local file path.');
        result.mode = 'import';
        result.cookieFile = resolve(file);
      } else {
        result.mode = argument === '--check' ? 'check' : argument === '--logout' ? 'logout' : 'help';
      }
    } else {
      throw new Error('Unknown login option. Run npm run login -- --help for usage.');
    }
  }
  return result;
}

async function interactiveLogin(timeoutSeconds: number): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), 'overleaf-latex-login-'));
  let context: BrowserContext | undefined;
  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
    void context?.close().catch(() => undefined);
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);
  try {
    try {
      context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false });
    } catch {
      console.log('Installed Chrome could not be started; trying the dedicated Playwright Chromium browser.');
      try { context = await chromium.launchPersistentContext(profile, { headless: false }); }
      catch { throw new Error('Could not launch a login browser. Install Chrome or run npx playwright install chromium.'); }
    }
    if (interrupted) throw new Error('Overleaf login canceled.');
    console.log('Sign in to Overleaf in the dedicated browser window, including Google sign-in or any normal browser challenge.');
    console.log('This browser uses a temporary profile. No existing browser profiles or saved passwords are read.');
    console.log('Google may reject automated browsers. If that happens, close this window and use --import-cookie-file; see --help.');
    const page = context.pages()[0] ?? await context.newPage();
    try { await page.goto(`${OVERLEAF_ORIGIN}/login`, { waitUntil: 'domcontentloaded', timeout: 60_000 }); }
    catch { throw new Error('Could not open Overleaf login. Check your connection and try again.'); }
    const deadline = Date.now() + timeoutSeconds * 1000;
    let closed = false;
    context.on('close', () => { closed = true; });
    while (Date.now() < deadline && !closed && !interrupted) {
      for (const candidate of context.pages()) {
        let authenticated = false;
        try {
          const location = new URL(candidate.url());
          if (location.origin === OVERLEAF_ORIGIN && /^\/project\/?$/.test(location.pathname)) {
            authenticated = isAuthenticatedProjectHtml(await candidate.content(), candidate.url());
          }
        } catch {
          // A page navigating or closing during sign-in will be checked again.
        }
        if (authenticated) {
          await saveSession(await context.storageState());
          console.log(`Overleaf session saved privately to ${getSessionPath()}.`);
          console.log('Run npm run login -- --check to confirm HTTP access for the plugin.');
          return;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error(interrupted ? 'Overleaf login canceled.' : closed ? 'Login browser closed before Overleaf sign-in was confirmed.' : 'Login timed out. Run npm run login again or increase --timeout.');
  } finally {
    await context?.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true });
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onInterrupt);
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseLoginArguments(args);
  if (options.mode === 'help') {
    console.log(`Overleaf login helper\n\n  npm run login                         Open a dedicated browser for manual sign-in\n  npm run login -- --timeout 900         Allow up to 900 seconds for sign-in\n  npm run login -- --check               Verify the saved session against Overleaf\n  npm run login -- --logout              Remove only this plugin's local session\n  npm run login -- --import-cookie-file /private/path/cookie.txt\n\nGoogle sign-in fallback: Sign in normally in your own browser. On\nhttps://www.overleaf.com/project, use browser developer tools > Network to\ncopy the Cookie request header from that page's request into a private\nlocal file (chmod 600). The file must contain only that one header line,\nwith or without its Cookie: prefix. Import verifies the session before\nsaving. Delete that temporary file afterward. Never paste cookies into chat.\n\nSession: OVERLEAF_SESSION_FILE, default ~/.config/overleaf-latex/session.json\nIts directory must have mode 700; its file is written with mode 600.\nThe temporary login browser is removed after login; only Overleaf cookies\nare saved. Logout does not sign other browsers out or revoke server sessions.`);
    return;
  }
  if (options.mode === 'logout') {
    await clearSession();
    console.log('Removed the plugin\'s saved local Overleaf session. Other browser sessions are unchanged.');
    return;
  }
  if (options.mode === 'check') {
    await checkSavedSession(await loadSession());
    console.log('The saved Overleaf session is authenticated and the project page is accessible.');
    return;
  }
  if (options.mode === 'import') {
    const file = options.cookieFile!;
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let header: string;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 256 * 1024 || (info.mode & 0o077) !== 0
        || (process.getuid && info.uid !== process.getuid())) {
        throw new Error('The Cookie header file must be a small private file (chmod 600).');
      }
      header = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
    const session = sessionFromCookieHeader(header);
    await checkSavedSession(session);
    await saveSession(session);
    console.log(`Authenticated Overleaf session saved privately to ${getSessionPath()}. Delete your temporary Cookie header file now.`);
    return;
  }
  await interactiveLogin(options.timeoutSeconds);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    // Only helper-generated errors are expected; never log browser or request objects.
    console.error(error instanceof Error ? error.message : 'Overleaf login failed.');
    process.exitCode = 1;
  });
}

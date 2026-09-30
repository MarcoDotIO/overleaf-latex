// src/login.ts
import { constants as constants2, realpathSync } from "node:fs";
import { mkdtemp, open as open2, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as join2, resolve as resolve2 } from "node:path";
import { pathToFileURL } from "node:url";

// src/session.ts
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
var OVERLEAF_ORIGIN = "https://www.overleaf.com";
var MAX_SESSION_BYTES = 256 * 1024;
var TRUSTED_DOMAINS = /* @__PURE__ */ new Set(["overleaf.com", ".overleaf.com", "www.overleaf.com", ".www.overleaf.com"]);
function getSessionPath(env = process.env) {
  const configured = env.OVERLEAF_SESSION_FILE?.trim();
  return configured ? resolve(configured) : join(homedir(), ".config", "overleaf-latex", "session.json");
}
function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function validateCookie(value) {
  if (!isObject(value) || typeof value.name !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value.name) || typeof value.value !== "string" || !/^[\x21-\x3A\x3C-\x7E]*$/.test(value.value) || typeof value.domain !== "string" || !TRUSTED_DOMAINS.has(value.domain) || typeof value.path !== "string" || !value.path.startsWith("/") || /[\x00-\x20\x7F]/.test(value.path) || typeof value.expires !== "number" || !Number.isFinite(value.expires) || value.expires < -1 || typeof value.httpOnly !== "boolean" || typeof value.secure !== "boolean" || !["Strict", "Lax", "None"].includes(value.sameSite)) {
    throw new Error("Invalid Overleaf session cookie. Sign in again.");
  }
  return {
    name: value.name,
    value: value.value,
    domain: value.domain,
    path: value.path,
    expires: value.expires,
    httpOnly: value.httpOnly,
    secure: value.secure,
    sameSite: value.sameSite
  };
}
function validateSession(value) {
  if (!isObject(value) || value.version !== 1 || value.origin !== OVERLEAF_ORIGIN || typeof value.savedAt !== "string" || !Number.isFinite(Date.parse(value.savedAt)) || !Array.isArray(value.cookies) || value.cookies.length === 0 || value.cookies.length > 512 || !Array.isArray(value.origins) || value.origins.length !== 0) {
    throw new Error("Invalid Overleaf session file. Sign in again.");
  }
  return {
    version: 1,
    origin: OVERLEAF_ORIGIN,
    savedAt: value.savedAt,
    cookies: value.cookies.map(validateCookie),
    origins: []
  };
}
async function loadSession(filePath = getSessionPath()) {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_SESSION_BYTES || (stat.mode & 63) !== 0 || process.getuid && stat.uid !== process.getuid()) {
      throw new Error("Session file must be a private, owner-only regular file (chmod 600).");
    }
    let parsed;
    try {
      parsed = JSON.parse(await handle.readFile("utf8"));
    } catch {
      throw new Error("Invalid Overleaf session file. Sign in again.");
    }
    return validateSession(parsed);
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") {
      throw new Error("No saved Overleaf session. Run npm run login first (in Claude Code: /overleaf-latex:login).");
    }
    if (isObject(error) && error.code === "ELOOP") {
      throw new Error("The Overleaf session file must not be a symbolic link.");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}
async function saveSession(storageState, filePath = getSessionPath()) {
  const session = validateSession({
    version: 1,
    origin: OVERLEAF_ORIGIN,
    savedAt: (/* @__PURE__ */ new Date()).toISOString(),
    origins: [],
    cookies: storageState.cookies.filter((cookie) => isObject(cookie) && TRUSTED_DOMAINS.has(cookie.domain))
  });
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 448 });
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 511) !== 448 || process.getuid && directoryStat.uid !== process.getuid()) {
    throw new Error("Session directory must be an owner-only directory (chmod 700). Choose a private OVERLEAF_SESSION_FILE location.");
  }
  const temporary = join(directory, `.session-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 384);
    await handle.writeFile(`${JSON.stringify(session)}
`, "utf8");
    await handle.sync();
    await handle.close();
    handle = void 0;
    await rename(temporary, filePath);
    await chmod(filePath, 384);
  } finally {
    await handle?.close();
    await unlink(temporary).catch(() => void 0);
  }
  return session;
}
async function clearSession(filePath = getSessionPath()) {
  await unlink(filePath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}
function buildCookieHeader(session, url = `${OVERLEAF_ORIGIN}/project`) {
  const target = new URL(url);
  if (target.origin !== OVERLEAF_ORIGIN || target.username || target.password) {
    throw new Error("Refusing to send an Overleaf session to another origin.");
  }
  const now = Date.now() / 1e3;
  return session.cookies.map(validateCookie).filter((cookie) => (cookie.expires === -1 || cookie.expires > now) && (target.pathname === cookie.path || target.pathname.startsWith(cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`))).sort((a, b) => b.path.length - a.path.length).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}
function sessionFromCookieHeader(header) {
  const trimmed = header.trim().replace(/^Cookie:\s*/i, "");
  if (!trimmed || trimmed.length > MAX_SESSION_BYTES || /[\r\n]/.test(trimmed)) {
    throw new Error("Expected a single Cookie request-header line from www.overleaf.com.");
  }
  const cookies = trimmed.split(";").map((part) => {
    const item = part.trim();
    const separator = item.indexOf("=");
    if (separator < 1) throw new Error("Invalid Cookie request-header line.");
    return validateCookie({
      name: item.slice(0, separator),
      value: item.slice(separator + 1),
      domain: "www.overleaf.com",
      path: "/",
      expires: -1,
      secure: true,
      httpOnly: true,
      sameSite: "Lax"
    });
  });
  if (!cookies.some((cookie) => cookie.name === "overleaf.sid" && cookie.value)) {
    throw new Error("The Cookie header does not contain an Overleaf session (overleaf.sid).");
  }
  return validateSession({ version: 1, origin: OVERLEAF_ORIGIN, savedAt: (/* @__PURE__ */ new Date()).toISOString(), cookies, origins: [] });
}

// src/login.ts
function decodeHtml(value) {
  return value.replace(/&(?:quot|apos|amp|lt|gt|#\d+|#x[0-9a-f]+);/gi, (entity) => {
    const names = { "&quot;": '"', "&apos;": "'", "&amp;": "&", "&lt;": "<", "&gt;": ">" };
    if (names[entity.toLowerCase()]) return names[entity.toLowerCase()];
    const hex = entity.slice(0, 3).toLowerCase() === "&#x";
    const number = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    return number >= 0 && number <= 1114111 ? String.fromCodePoint(number) : "";
  });
}
function isAuthenticatedProjectHtml(html, url) {
  let location;
  try {
    location = new URL(url);
  } catch {
    return false;
  }
  if (location.origin !== OVERLEAF_ORIGIN || !/^\/project\/?$/.test(location.pathname)) return false;
  for (const tag of html.matchAll(/<meta\s+[^>]*>/gi)) {
    const attributes = {};
    for (const attribute of tag[0].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attributes[attribute[1].toLowerCase()] = decodeHtml(attribute[2] ?? attribute[3] ?? "");
    }
    if (attributes.name !== "ol-user") continue;
    try {
      const user = JSON.parse(attributes.content ?? "");
      if (user && typeof user === "object" && "_id" in user && typeof user._id === "string" && /^[a-f\d]{24}$/i.test(user._id)) return true;
    } catch {
    }
  }
  return false;
}
async function checkSavedSession(session, fetcher = fetch) {
  const url = `${OVERLEAF_ORIGIN}/project`;
  const cookie = buildCookieHeader(session, url);
  if (!cookie) throw new Error("The saved Overleaf session has expired. Run npm run login again.");
  let response;
  try {
    response = await fetcher(url, {
      headers: { Cookie: cookie, Accept: "text/html" },
      redirect: "manual",
      signal: AbortSignal.timeout(2e4)
    });
  } catch {
    throw new Error("Could not reach Overleaf to verify the session. Check your connection and try again.");
  }
  if (response.status === 403 || response.status === 429) {
    throw new Error(`Overleaf refused session verification (HTTP ${response.status}). Complete any browser challenge in Overleaf; no challenge bypass is attempted.`);
  }
  if (!response.ok || !isAuthenticatedProjectHtml(await response.text(), response.url || url)) {
    throw new Error("Overleaf did not confirm an authenticated project page. Run npm run login again.");
  }
}
function parseLoginArguments(args) {
  const result = { mode: "login", timeoutSeconds: 600 };
  let hasMode = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--timeout") {
      const timeout = Number(args[++index]);
      if (!Number.isInteger(timeout) || timeout < 30 || timeout > 1800) throw new Error("--timeout must be between 30 and 1800 seconds.");
      result.timeoutSeconds = timeout;
    } else if (["--check", "--logout", "--help", "-h", "--import-cookie-file"].includes(argument ?? "")) {
      if (hasMode) throw new Error("Choose only one login action.");
      hasMode = true;
      if (argument === "--import-cookie-file") {
        const file = args[++index];
        if (!file || file.startsWith("--")) throw new Error("--import-cookie-file requires a local file path.");
        result.mode = "import";
        result.cookieFile = resolve2(file);
      } else {
        result.mode = argument === "--check" ? "check" : argument === "--logout" ? "logout" : "help";
      }
    } else {
      throw new Error("Unknown login option. Run npm run login -- --help for usage.");
    }
  }
  return result;
}
async function loadChromium() {
  try {
    return (await import("playwright")).chromium;
  } catch {
    throw new Error("Playwright is not installed. Run npm ci in the plugin directory, or use --import-cookie-file; see --help.");
  }
}
async function interactiveLogin(timeoutSeconds) {
  const chromium = await loadChromium();
  const profile = await mkdtemp(join2(tmpdir(), "overleaf-latex-login-"));
  let context;
  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
    void context?.close().catch(() => void 0);
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  try {
    try {
      context = await chromium.launchPersistentContext(profile, { channel: "chrome", headless: false });
    } catch {
      console.log("Installed Chrome could not be started; trying the dedicated Playwright Chromium browser.");
      try {
        context = await chromium.launchPersistentContext(profile, { headless: false });
      } catch {
        throw new Error("Could not launch a login browser. Install Chrome or run npx playwright install chromium.");
      }
    }
    if (interrupted) throw new Error("Overleaf login canceled.");
    console.log("Sign in to Overleaf in the dedicated browser window, including Google sign-in or any normal browser challenge.");
    console.log("This browser uses a temporary profile. No existing browser profiles or saved passwords are read.");
    console.log("Google may reject automated browsers. If that happens, close this window and use --import-cookie-file; see --help.");
    const page = context.pages()[0] ?? await context.newPage();
    try {
      await page.goto(`${OVERLEAF_ORIGIN}/login`, { waitUntil: "domcontentloaded", timeout: 6e4 });
    } catch {
      throw new Error("Could not open Overleaf login. Check your connection and try again.");
    }
    const deadline = Date.now() + timeoutSeconds * 1e3;
    let closed = false;
    context.on("close", () => {
      closed = true;
    });
    while (Date.now() < deadline && !closed && !interrupted) {
      for (const candidate of context.pages()) {
        let authenticated = false;
        try {
          const location = new URL(candidate.url());
          if (location.origin === OVERLEAF_ORIGIN && /^\/project\/?$/.test(location.pathname)) {
            authenticated = isAuthenticatedProjectHtml(await candidate.content(), candidate.url());
          }
        } catch {
        }
        if (authenticated) {
          await saveSession(await context.storageState());
          console.log(`Overleaf session saved privately to ${getSessionPath()}.`);
          console.log("Run npm run login -- --check to confirm HTTP access for the plugin.");
          return;
        }
      }
      await new Promise((resolve3) => setTimeout(resolve3, 1e3));
    }
    throw new Error(interrupted ? "Overleaf login canceled." : closed ? "Login browser closed before Overleaf sign-in was confirmed." : "Login timed out. Run npm run login again or increase --timeout.");
  } finally {
    await context?.close().catch(() => void 0);
    await rm(profile, { recursive: true, force: true });
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
  }
}
async function main(args = process.argv.slice(2)) {
  const options = parseLoginArguments(args);
  if (options.mode === "help") {
    console.log(`Overleaf login helper

  npm run login                         Open a dedicated browser for manual sign-in
  npm run login -- --timeout 900         Allow up to 900 seconds for sign-in
  npm run login -- --check               Verify the saved session against Overleaf
  npm run login -- --logout              Remove only this plugin's local session
  npm run login -- --import-cookie-file /private/path/cookie.txt

Google sign-in fallback: Sign in normally in your own browser. On
https://www.overleaf.com/project, use browser developer tools > Network to
copy the Cookie request header from that page's request into a private
local file (chmod 600). The file must contain only that one header line,
with or without its Cookie: prefix. Import verifies the session before
saving. Delete that temporary file afterward. Never paste cookies into chat.

Session: OVERLEAF_SESSION_FILE, default ~/.config/overleaf-latex/session.json
Its directory must have mode 700; its file is written with mode 600.
The temporary login browser is removed after login; only Overleaf cookies
are saved. Logout does not sign other browsers out or revoke server sessions.`);
    return;
  }
  if (options.mode === "logout") {
    await clearSession();
    console.log("Removed the plugin's saved local Overleaf session. Other browser sessions are unchanged.");
    return;
  }
  if (options.mode === "check") {
    await checkSavedSession(await loadSession());
    console.log("The saved Overleaf session is authenticated and the project page is accessible.");
    return;
  }
  if (options.mode === "import") {
    const file = options.cookieFile;
    const handle = await open2(file, constants2.O_RDONLY | constants2.O_NOFOLLOW);
    let header;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 256 * 1024 || (info.mode & 63) !== 0 || process.getuid && info.uid !== process.getuid()) {
        throw new Error("The Cookie header file must be a small private file (chmod 600).");
      }
      header = await handle.readFile("utf8");
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
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Overleaf login failed.");
    process.exitCode = 1;
  });
}
export {
  checkSavedSession,
  isAuthenticatedProjectHtml,
  main,
  parseLoginArguments
};

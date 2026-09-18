import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

/** The reference Overleaf real-time service speaks Socket.IO 0.9, not modern Socket.IO. */
export interface RealtimeConnection {
  project: Record<string, unknown>;
  request(event: string, args: unknown[]): Promise<unknown[]>;
  on(event: string, listener: (...args: unknown[]) => void): () => void;
  close(): void;
}

export interface RealtimeOptions {
  projectId: string;
  cookie: string;
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
  origin: string;
  resource?: string;
  webSocketFactory?: (url: string, options: WebSocket.ClientOptions) => WebSocket;
}

export type SocketFactory = (options: RealtimeOptions) => Promise<RealtimeConnection>;

export class OverleafError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'OverleafError';
  }
}

export const AUTH_MESSAGE = 'Overleaf authentication expired or the request was blocked. Run the plugin login command and finish sign-in in its browser, then retry. Browser security challenges must be completed manually.';

export const connectRealtime: SocketFactory = async options => {
  const resource = options.resource ?? '/socket.io';
  // Cookies are never forwarded to a URL selected by project content or server redirects.
  if (options.origin !== 'https://www.overleaf.com' || !/^\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(resource) || resource.split('/').some(part => part === '.' || part === '..')) {
    throw new OverleafError('UNSAFE_URL', 'Only the trusted Overleaf origin and a simple socket path are supported.');
  }
  if (!/^[a-fA-F0-9]{24}$/.test(options.projectId)) throw new OverleafError('INVALID_ID', 'Overleaf project IDs must be 24 hexadecimal characters.');
  const query = new URLSearchParams({ projectId: options.projectId, t: String(Date.now()) });
  const response = await options.fetch(`${options.origin}${resource}/1/?${query}`, {
    headers: { Cookie: options.cookie, Origin: options.origin, Referer: `${options.origin}/project/${options.projectId}` },
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (!response.ok || response.headers.get('content-type')?.includes('text/html')) {
    throw new OverleafError('AUTH_OR_CHALLENGE', AUTH_MESSAGE);
  }
  const handshake = await readHandshake(response);
  const match = /^([A-Za-z0-9_-]+):([\d.]+):([\d.]+):([^\r\n]+)$/.exec(handshake.trim());
  if (!match || !match[4]?.split(',').includes('websocket')) {
    throw new OverleafError('UNSUPPORTED_REALTIME', 'This Overleaf deployment did not offer the supported Socket.IO 0.9 WebSocket protocol. The plugin must be updated for this deployment; no document was changed.');
  }
  const url = `${options.origin.replace('https:', 'wss:')}${resource}/1/websocket/${match[1]}?${query}`;
  // The hosted load balancer sets a fresh GCLB affinity cookie on this handshake.
  // Keeping the previous cookie can route the upgrade to a different real-time host.
  const websocketCookie = mergeHandshakeCookies(options.cookie, response.headers.getSetCookie(), url);
  const createWebSocket = options.webSocketFactory ?? ((url, websocketOptions) => new WebSocket(url, websocketOptions));
  const ws = createWebSocket(url, {
    headers: { Cookie: websocketCookie, Origin: options.origin, Referer: `${options.origin}/project/${options.projectId}` },
    followRedirects: false,
    handshakeTimeout: options.timeoutMs,
    maxPayload: 8 * 1024 * 1024,
  });
  const connection = new SocketIo09Connection(ws, options.timeoutMs, match[1]);
  await connection.ready;
  return connection;
};

export class SocketIo09Connection implements RealtimeConnection {
  project: Record<string, unknown> = {};
  readonly ready: Promise<void>;
  private readonly events = new EventEmitter();
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<string, { resolve: (args: unknown[]) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readonly readyTimer: NodeJS.Timeout;
  private readonly idleTimer: NodeJS.Timeout;
  private lastPacketAt = Date.now();

  constructor(private readonly ws: WebSocket, private readonly timeoutMs: number, private readonly sessionId?: string) {
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.readyTimer = setTimeout(() => this.fail(new OverleafError('REALTIME_TIMEOUT', 'Overleaf did not open the project in time.')), timeoutMs);
    this.idleTimer = setInterval(() => {
      if (Date.now() - this.lastPacketAt > Math.max(60_000, timeoutMs)) {
        this.fail(new OverleafError('REALTIME_TIMEOUT', 'The Overleaf connection stopped responding.'));
      }
    }, 15_000);
    this.idleTimer.unref();
    ws.on('message', data => this.receive(data.toString()));
    ws.on('unexpected-response', (_request, response) => {
      response.resume();
      this.fail(new OverleafError('REALTIME_HTTP', `Overleaf refused the WebSocket upgrade with HTTP ${response.statusCode ?? 'unknown'}. Run login again if your session expired.`));
    });
    ws.on('error', () => this.fail(new OverleafError('REALTIME_CONNECTION', 'Could not establish the authenticated Overleaf WebSocket. Run login again if your session expired.')));
    ws.on('close', () => this.fail(new OverleafError('REALTIME_DISCONNECTED', 'Overleaf disconnected the project session.')));
  }

  on(event: string, listener: (...args: unknown[]) => void): () => void {
    this.events.on(event, listener);
    return () => { this.events.off(event, listener); };
  }

  request(event: string, args: unknown[]): Promise<unknown[]> {
    if (this.closed) return Promise.reject(new OverleafError('REALTIME_DISCONNECTED', 'The project session is closed.'));
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new OverleafError('REALTIME_TIMEOUT', `Overleaf did not acknowledge ${event} in time.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(`5:${id}+::${JSON.stringify({ name: event, args })}`);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new OverleafError('REALTIME_DISCONNECTED', 'The project session disconnected before sending the request.'));
      }
    });
  }

  close(): void {
    this.fail(new OverleafError('REALTIME_DISCONNECTED', 'The project session is closed.'));
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.readyTimer);
    clearInterval(this.idleTimer);
    this.readyReject(error);
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
    this.events.emit('disconnect', error);
    this.ws.terminate();
  }

  private receive(packet: string): void {
    if (this.closed) return;
    this.lastPacketAt = Date.now();
    const match = /^(\d):([^:]*):([^:]*):?([\s\S]*)$/.exec(packet);
    if (!match) return this.fail(new OverleafError('REALTIME_PROTOCOL', 'Overleaf sent an unsupported real-time packet.'));
    const [, type, , , payload = ''] = match;
    try {
      if (type === '2') { this.ws.send('2::'); return; }
      if (type === '0' || type === '7') { this.fail(new OverleafError('REALTIME_DISCONNECTED', 'Overleaf rejected or closed the real-time session.')); return; }
      if (type === '1' || type === '8') return;
      if (type === '6') {
        const ack = /^(\d+)(?:\+([\s\S]*))?$/.exec(payload);
        if (!ack) throw new Error('bad ack');
        const id = ack[1]!;
        const waiting = this.pending.get(id);
        if (!waiting) return;
        const args: unknown = ack[2] ? JSON.parse(ack[2]) : [];
        if (!Array.isArray(args)) throw new Error('bad ack args');
        clearTimeout(waiting.timer);
        this.pending.delete(id);
        if (args[0] != null) {
          waiting.reject(new OverleafError('OVERLEAF_REJECTED', 'Overleaf rejected this project operation. Check your project access and read the current document before retrying.'));
        } else waiting.resolve(args.slice(1));
        return;
      }
      if (type !== '5') throw new Error('unknown packet');
      const event: unknown = JSON.parse(payload);
      if (!event || typeof event !== 'object' || !('name' in event) || typeof event.name !== 'string' || !('args' in event) || !Array.isArray(event.args)) throw new Error('bad event');
      if (event.name === 'connectionRejected') {
        this.fail(new OverleafError('AUTH_OR_CHALLENGE', AUTH_MESSAGE));
      } else if (event.name === 'serverPing') {
        // Overleaf adds its own diagnostics heartbeat on top of Socket.IO's 2:: heartbeat.
        this.ws.send(`5:::${JSON.stringify({ name: 'clientPong', args: [...event.args.slice(0, 4), 'websocket', this.sessionId ?? null] })}`);
      } else if (event.name === 'reconnectGracefully' || event.name === 'forceDisconnect') {
        // A fresh user operation may reconnect; never transparently replay an uncertain edit.
        this.fail(new OverleafError('REALTIME_DISCONNECTED', 'Overleaf requested that the project session reconnect. Read current state before retrying an edit.'));
      } else if (event.name === 'joinProjectResponse') {
        const response = event.args[0];
        if (!response || typeof response !== 'object' || !response.project || typeof response.project !== 'object' || Array.isArray(response.project)) throw new Error('bad project');
        this.project = response.project as Record<string, unknown>;
        clearTimeout(this.readyTimer);
        this.readyResolve();
      } else {
        this.events.emit(event.name, ...event.args);
      }
    } catch {
      this.fail(new OverleafError('REALTIME_PROTOCOL', 'Overleaf returned an unexpected real-time response.'));
    }
  }
}

/** Apply only cookies scoped to the trusted upgrade URL; never persist them or expose values. */
export function mergeHandshakeCookies(original: string, setCookies: string[], websocketUrl: string): string {
  const target = new URL(websocketUrl);
  if (target.protocol !== 'wss:' || target.hostname !== 'www.overleaf.com' || target.port || target.username || target.password) {
    throw new OverleafError('UNSAFE_URL', 'Refusing to send Overleaf credentials to another origin.');
  }
  const cookies = new Map(original.split(';').map(part => {
    const separator = part.indexOf('=');
    return [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
  }));
  for (const header of setCookies) {
    const [pair = '', ...rawAttributes] = header.split(';');
    const separator = pair.indexOf('=');
    if (separator < 1) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || !/^[\x21-\x3A\x3C-\x7E]*$/.test(value)) continue;
    const attributes = new Map(rawAttributes.map(attribute => {
      const index = attribute.indexOf('=');
      return index < 0 ? [attribute.trim().toLowerCase(), ''] : [attribute.slice(0, index).trim().toLowerCase(), attribute.slice(index + 1).trim()];
    }));
    const domain = attributes.get('domain')?.toLowerCase().replace(/^\./, '');
    if (domain && domain !== 'www.overleaf.com' && domain !== 'overleaf.com') continue;
    const path = attributes.get('path') || target.pathname.slice(0, target.pathname.indexOf('/websocket/') + 1);
    if (!path.startsWith('/') || !(target.pathname === path || target.pathname.startsWith(path.endsWith('/') ? path : `${path}/`))) continue;
    const maxAge = attributes.get('max-age');
    const expires = attributes.get('expires');
    if (maxAge !== undefined ? /^-?\d+$/.test(maxAge) && Number(maxAge) <= 0 : expires !== undefined && Date.parse(expires) <= Date.now()) cookies.delete(name);
    else cookies.set(name, value);
  }
  return [...cookies].filter(([name]) => name).map(([name, value]) => `${name}=${value}`).join('; ');
}

async function readHandshake(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) {
        await reader.cancel();
        throw new OverleafError('UNSUPPORTED_REALTIME', 'Overleaf returned an unexpected real-time handshake.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size).toString('utf8');
}

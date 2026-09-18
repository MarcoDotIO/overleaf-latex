import { createServer, type Server } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer, type OverleafApi } from './tools.js';

/** Local diagnostic transport only. ChatGPT should reach stdio via Secure MCP Tunnel. */
export async function startHttpServer(client: OverleafApi, port = 3333): Promise<Server> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535.');
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Browser pages must not gain access to the owner's localhost session.
    // Reject all browser origins (even same-origin); CLI MCP clients send none.
    if (req.headers.origin || !/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(req.headers.host ?? '')) {
      res.writeHead(403).end('Local MCP clients only.'); return;
    }
    if (req.url === '/healthz' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', service: 'overleaf-latex' })); return;
    }
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); res.writeHead(405).end(); return; }
    // Never create a network-wide listener or publicly forward this endpoint:
    // access is deliberately scoped to the local user's trust boundary.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const mcp = createMcpServer(client);
    res.on('close', () => { void mcp.close(); });
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 2_000_000) { res.writeHead(413).end('Request is too large.'); return; }
        chunks.push(Buffer.from(chunk));
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { res.writeHead(400).end('Invalid JSON.'); return; }
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(500).end('MCP request failed.');
      else res.end();
    }
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return server;
}

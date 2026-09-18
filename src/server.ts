import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { OverleafClient } from './overleaf-client.js';
import { createMcpServer } from './tools.js';
import { startHttpServer } from './http.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.some(a => a !== '--http')) throw new Error('Usage: node dist/server.js [--http]');
  const client = new OverleafClient();
  if (args.includes('--http')) {
    const server = await startHttpServer(client, Number(process.env.PORT ?? 3333));
    const address = server.address();
    console.error(`Overleaf MCP listening locally at http://127.0.0.1:${typeof address === 'object' && address ? address.port : 3333}/mcp`);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
      server.closeAllConnections(); server.close();
    });
  } else {
    const server = createMcpServer(client);
    await server.connect(new StdioServerTransport());
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void server.close(); });
  }
}

main().catch(() => { console.error('Could not start Overleaf MCP. Check Node 22+, dependencies, and PORT.'); process.exitCode = 1; });

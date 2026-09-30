// Builds the plugin entry points committed under bundle/.
// Plugin installs never run `npm run build`, so Claude Code and Codex launch
// these prebuilt files. Only this project's code is bundled: packages resolve
// from node_modules, which Claude Code installs automatically and a local
// checkout gets from `npm ci`.
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const common = {
  absWorkingDir: join(dirname(fileURLToPath(import.meta.url)), '..'),
  bundle: true, packages: 'external', platform: 'node', target: 'node22', format: 'esm', logLevel: 'warning',
};

await Promise.all([
  build({ ...common, entryPoints: ['src/server.ts'], outfile: 'bundle/overleaf-mcp.mjs' }),
  build({ ...common, entryPoints: ['src/login.ts'], outfile: 'bundle/overleaf-login.mjs' }),
]);

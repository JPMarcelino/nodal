import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import pkg from './package.json';

/**
 * The agent bridge as one file the web app serves at ./nodal-agent.mjs, with
 * the method catalog baked in, so an agent can download and run it without
 * the repository (see agent-bridge/README.md).
 */
function agentBridgeFile(): string {
  const src = readFileSync(new URL('./agent-bridge/nodal-agent.mjs', import.meta.url), 'utf8');
  const catalog = readFileSync(new URL('./src/agent/catalog.json', import.meta.url), 'utf8');
  const marker = 'const EMBEDDED_CATALOG = null;';
  if (!src.includes(marker)) throw new Error('agent bridge: catalog marker missing');
  return src.replace(marker, `const EMBEDDED_CATALOG = ${JSON.stringify(JSON.parse(catalog))};`);
}

function agentBridge(): Plugin {
  return {
    name: 'nodal-agent-bridge',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.split('?')[0].endsWith('/nodal-agent.mjs')) return next();
        res.setHeader('content-type', 'text/javascript; charset=utf-8');
        res.end(agentBridgeFile());
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'nodal-agent.mjs', source: agentBridgeFile() });
    },
  };
}

// BASE_PATH is set by the GitHub Pages workflow; desktop builds use relative paths.
export default defineConfig({
  plugins: [react(), agentBridge()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  base: process.env.BASE_PATH ?? './',
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: ['es2021', 'chrome100', 'safari15'],
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  test: { environment: 'node' },
} as any);

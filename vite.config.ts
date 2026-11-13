import { defineConfig, loadEnv } from 'vite';
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

/**
 * The KiCad symbol library (built into kicad-library/ by
 * scripts/build-kicad-library.ts) at ./kicad/ while developing; the deploy
 * script copies it next to the built app.
 */
function kicadLibrary(): Plugin {
  const root = new URL('./kicad-library/', import.meta.url);
  return {
    name: 'nodal-kicad-library',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /\/kicad\/([\w./+-]+\.(?:json|md))$/.exec(decodeURIComponent(req.url?.split('?')[0] ?? ''));
        if (!m || m[1].includes('..')) return next();
        try {
          const body = readFileSync(new URL(m[1], root));
          res.setHeader('content-type', m[1].endsWith('.md') ? 'text/markdown; charset=utf-8' : 'application/json');
          res.end(body);
        } catch {
          next();
        }
      });
    },
  };
}

/**
 * Content-Security-Policy for the built app (web and desktop). Scripts only
 * come from the app itself, so nothing injected through a file, a symbol or a
 * share link can run. Network access is limited to the app's own files, the
 * live-session relay (when turned on), an agent bridge on this computer, the
 * desktop app's KiCad library host, and https downloads the user asks for
 * (add-library links). ipc: / ipc.localhost are the desktop app's own IPC.
 */
function contentSecurityPolicy(env: Record<string, string | undefined>): Plugin {
  const collab = env.VITE_COLLAB_URL ?? 'wss://nodal-collab.nodal-collab.workers.dev';
  const origin = (u: string | undefined) => {
    try {
      return u ? new URL(u).origin : '';
    } catch {
      return '';
    }
  };
  const connect = [
    "'self'",
    collab && collab !== 'off' ? origin(collab) : '',
    'ws://127.0.0.1:*',
    'ws://localhost:*',
    'https:',
    'ipc:',
    'http://ipc.localhost',
  ].filter(Boolean);
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    `connect-src ${connect.join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join('; ');
  return {
    name: 'nodal-csp',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`),
  };
}

// BASE_PATH is set by the GitHub Pages workflow; desktop builds use relative paths.
export default defineConfig(({ mode }) => ({
  plugins: [react(), agentBridge(), kicadLibrary(), contentSecurityPolicy({ ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env })],
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
}) as any);

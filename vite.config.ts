import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json';

// BASE_PATH is set by the GitHub Pages workflow; desktop builds use relative paths.
export default defineConfig({
  plugins: [react()],
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

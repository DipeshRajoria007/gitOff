import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const api = `http://127.0.0.1:${process.env.GITOFF_PORT || process.env.OGH_PORT || 4777}`;

export default defineConfig({
  root,
  plugins: [react()],
  resolve: { alias: { '@shared': path.resolve(root, '../src/shared') } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // "/assets" is where the server serves cached PR media, so the app's own files live under /static.
    assetsDir: 'static',
    chunkSizeWarningLimit: 4000,
  },
  server: {
    port: 5173,
    proxy: { '/api': api, '/assets': api },
  },
});

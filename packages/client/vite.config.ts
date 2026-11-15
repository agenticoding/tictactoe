import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/',
  // Component tests need a DOM; jsdom also leaves node builtins (fs/path) usable
  // for the pure node-style tests in this package.
  test: {
    environment: 'jsdom',
  },
  resolve: {
    alias: {
      // The client package is ESM, so `__dirname` is undefined; derive the src
      // dir from this module's URL instead.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Dev proxy to the backend (:3001). ONLY the `/api` HTTP routes and the
    // game WebSocket upgrade are forwarded. The `/g/:id` document must be served
    // by Vite's own SPA fallback so the dev server loads the source entrypoint;
    // proxying the document would return the stale production dist/index.html,
    // whose /assets/* bundle Vite does not serve, rendering a blank page.
    proxy: {
      '/api': 'http://localhost:3001',
      '^/g/[^/]+/ws$': { target: 'http://localhost:3001', ws: true },
    },
  },
});

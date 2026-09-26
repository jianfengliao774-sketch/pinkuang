import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// @ts-expect-error Shared Node middleware has no generated declaration.
import { proxyFirsto } from './server/firsto-proxy.mjs';

export default defineConfig({ plugins: [react(), {
  name: 'firsto-readonly-quotes',
  configureServer(server) { server.middlewares.use((req,res,next) => { if (req.url?.startsWith('/firsto-api/')) void proxyFirsto(req,res); else next(); }); },
  configurePreviewServer(server) { server.middlewares.use((req,res,next) => { if (req.url?.startsWith('/firsto-api/')) void proxyFirsto(req,res); else next(); }); },
}], base: './', build: { chunkSizeWarningLimit: 800 } });

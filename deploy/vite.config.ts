import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// @ts-expect-error Shared Node middleware has no generated declaration.
import { proxyFirsto } from './server/firsto-proxy.mjs';
// @ts-expect-error Shared Node journal service has no generated declaration.
import { createJournalService, journalConfiguration } from './server/journal-api.mjs';
// @ts-expect-error Node-only source compiler used to pin the browser build.
import { verifiedBuildDigest } from './scripts/build-artifacts.mjs';

export default defineConfig(() => ({ define: { __DEPLOYMENT_ARTIFACT_DIGEST__: JSON.stringify(verifiedBuildDigest()) }, plugins: [react(), {
  name: 'firsto-readonly-quotes',
  configureServer(server) { server.middlewares.use((req,res,next) => { if (req.url?.startsWith('/firsto-api/')) void proxyFirsto(req,res); else next(); }); },
  configurePreviewServer(server) { server.middlewares.use((req,res,next) => { if (req.url?.startsWith('/firsto-api/')) void proxyFirsto(req,res); else next(); }); },
}, {
  name: 'durable-wallet-journal',
  configureServer(server) {
    const service = createJournalService(journalConfiguration({ ...process.env, NODE_ENV: 'development' }));
    server.middlewares.use((req, res, next) => { if (req.url?.startsWith('/api/journal/')) service.handle(req, res); else next(); });
    server.httpServer?.once('close', () => { void service.close(); });
  },
  configurePreviewServer(server) {
    const service = createJournalService(journalConfiguration({ ...process.env, NODE_ENV: 'development' }));
    server.middlewares.use((req, res, next) => { if (req.url?.startsWith('/api/journal/')) service.handle(req, res); else next(); });
    server.httpServer?.once('close', () => { void service.close(); });
  },
}], base: './', build: { chunkSizeWarningLimit: 800 } }));

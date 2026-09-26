import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// @ts-expect-error Shared Node middleware has no generated declaration.
import { proxyFirsto } from './server/firsto-proxy.mjs';
// @ts-expect-error Node-only source compiler used to pin the browser build.
import { verifiedBuildDigest } from './scripts/build-artifacts.mjs';

export default defineConfig(() => ({ define: { __DEPLOYMENT_ARTIFACT_DIGEST__: JSON.stringify(verifiedBuildDigest()) }, plugins: [react(), {
  name: 'firsto-readonly-quotes',
  configureServer(server) { server.middlewares.use((req,res,next) => { if (req.url?.startsWith('/firsto-api/')) void proxyFirsto(req,res); else next(); }); },
  configurePreviewServer(server) { server.middlewares.use((req,res,next) => { if (req.url?.startsWith('/firsto-api/')) void proxyFirsto(req,res); else next(); }); },
}], base: './', build: { chunkSizeWarningLimit: 800 } }));

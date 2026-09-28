import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
// @ts-expect-error Shared Node digest reader has no generated declaration.
import { servedArtifactDigest } from './server/artifact-digest.mjs';
// @ts-expect-error Shared Node middleware has no generated declaration.
import { proxyFirsto } from './server/firsto-proxy.mjs';
// @ts-expect-error Shared Node journal service has no generated declaration.
import { createJournalService, journalConfiguration } from './server/journal-api.mjs';
// @ts-expect-error Node-only source compiler used to pin the browser build.
import { assertCurrentArtifactInputs, verifiedBuildDigest } from './scripts/build-artifacts.mjs';

const artifactPath = fileURLToPath(new URL('./public/deployment-artifacts.json', import.meta.url));
const previewArtifactPath = fileURLToPath(new URL('./dist/deployment-artifacts.json', import.meta.url));
const sourcePath = fileURLToPath(new URL('../contracts/src/', import.meta.url));
const configPath = fileURLToPath(new URL('./vite.config.ts', import.meta.url));
const builderPath = fileURLToPath(new URL('./scripts/build-artifacts.mjs', import.meta.url));
const foundryPath = fileURLToPath(new URL('../contracts/foundry.toml', import.meta.url));
const buildInputs = new Set([configPath, builderPath, foundryPath]);
const fileHash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

export default defineConfig(() => {
  const digest = verifiedBuildDigest();
  const builderHash = fileHash(builderPath);
  const configHash = fileHash(configPath);
  const assertSigningInputsCurrent = () => {
    if (fileHash(builderPath) !== builderHash || fileHash(configPath) !== configHash) throw new Error('Build scripts changed.');
    assertCurrentArtifactInputs(digest);
  };
  return { define: { __DEPLOYMENT_ARTIFACT_DIGEST__: JSON.stringify(digest) }, plugins: [react(), {
  name: 'refresh-deployment-artifact-digest',
  configureServer(server) {
    // Vite's define value is frozen at startup. Regenerating the public artifact
    // must re-run the independent compiler check before the page can sign again.
    server.watcher.add([artifactPath, sourcePath, ...buildInputs]);
    let restarting = false;
    const refresh = (changed: string) => {
      const path = resolve(changed);
      if (path !== artifactPath) {
        if ((path.startsWith(sourcePath) && path.endsWith('.sol')) || buildInputs.has(path)) {
          try { assertSigningInputsCurrent(); }
          catch { server.ws.send({ type: 'error', err: { message: '合约源码或构建输入已更改，请重新生成部署产物；新的部署签名已暂停。', stack: '' } }); }
        }
        return;
      }
      if (restarting) return;
      restarting = true;
      void server.restart().catch(error => {
        server.config.logger.error(`Cannot reload deployment artifacts: ${String(error)}`);
      }).finally(() => { restarting = false; });
    };
    server.watcher.on('change', refresh);
    server.watcher.on('add', refresh);
    server.watcher.on('unlink', refresh);
  },
}, {
  name: 'firsto-readonly-quotes',
  configureServer(server) { server.middlewares.use((req,res,next) => { if (req.url?.startsWith('/firsto-api/')) void proxyFirsto(req,res); else next(); }); },
  configurePreviewServer(server) { server.middlewares.use((req,res,next) => { if (req.url?.startsWith('/firsto-api/')) void proxyFirsto(req,res); else next(); }); },
}, {
  name: 'durable-wallet-journal',
  configureServer(server) {
    const service = createJournalService({ ...journalConfiguration({ ...process.env, NODE_ENV: 'development' }),
      currentArtifactDigest: () => servedArtifactDigest(artifactPath), assertSigningInputsCurrent });
    server.middlewares.use((req, res, next) => { if (req.url?.startsWith('/api/journal/')) service.handle(req, res); else next(); });
    server.httpServer?.once('close', () => { void service.close(); });
  },
  configurePreviewServer(server) {
    const service = createJournalService({ ...journalConfiguration({ ...process.env, NODE_ENV: 'development' }),
      currentArtifactDigest: () => servedArtifactDigest(previewArtifactPath) });
    server.middlewares.use((req, res, next) => { if (req.url?.startsWith('/api/journal/')) service.handle(req, res); else next(); });
    server.httpServer?.once('close', () => { void service.close(); });
  },
}], base: './', build: { chunkSizeWarningLimit: 800 } };
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const release = JSON.parse(readFileSync(resolve('.governance24-release/config.json'), 'utf8'));
if (release.kind !== 'governance24-upgrade-static-release-v1' || release.entryPath !== '/pinkuang-governance24-upgrade/'
  || release.rpcPath !== '/pinkuang-governance24-read/api/rpc'
  || !release.pins?.trustedPredecessorInputDigest || !release.pins?.trustedReviewCatalogDigest
  || !release.pins?.trustedUpgradeArtifactDigest || !release.gasEvidenceDigest || !release.liveReviewEvidenceDigest) {
  throw new Error('Build requires independently reviewed governance24 artifacts, current graph, measured gas and live evidence.');
}
export default defineConfig({ base: './', publicDir: '.governance24-release/public', plugins: [react()],
  define: { __GOVERNANCE24_RELEASE__: JSON.stringify(release) },
  build: { outDir: 'dist-governance24', emptyOutDir: true,
    rollupOptions: { input: resolve('governance24-upgrade.html') } } });

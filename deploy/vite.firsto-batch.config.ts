import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const release = JSON.parse(readFileSync(resolve('.firsto-batch-release/config.json'), 'utf8'));
if (release.kind !== 'firsto-batch-upgrade-static-release-v1' || release.entryPath !== '/pinkuang-firsto-batch-upgrade/'
  || !release.pins?.trustedReviewCatalogDigest
  || !release.pins?.trustedPriorCoreCatalogDigest || !release.pins?.trustedProtocolReviewDigest) {
  throw new Error('Build requires an independently reviewed current graph catalog.');
}
export default defineConfig({
  base: './', publicDir: '.firsto-batch-release/public', plugins: [react()],
  define: { __FIRSTO_BATCH_RELEASE__: JSON.stringify(release) },
  build: { outDir: 'dist-firsto-batch', emptyOutDir: true,
    rollupOptions: { input: resolve('firsto-batch-upgrade.html') } },
});

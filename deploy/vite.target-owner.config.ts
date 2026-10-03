import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const release = JSON.parse(readFileSync(resolve('.target-owner-release/config.json'), 'utf8'));
if (release.kind !== 'target-owner-upgrade-static-release-v1' || !release.pins?.trustedReviewCatalogDigest) {
  throw new Error('Build requires an independently reviewed current graph catalog.');
}
export default defineConfig({
  base: './', publicDir: '.target-owner-release/public', plugins: [react()],
  define: { __TARGET_OWNER_RELEASE__: JSON.stringify(release) },
  build: { outDir: 'dist-target-owner', emptyOutDir: true,
    rollupOptions: { input: resolve('target-owner-upgrade.html') } },
});

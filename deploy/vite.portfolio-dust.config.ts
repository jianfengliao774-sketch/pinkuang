import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const release = JSON.parse(readFileSync(resolve('.portfolio-dust-release/config.json'), 'utf8'));
if (release.kind !== 'portfolio-dust-static-v1' || !release.configSha256) throw new Error('A pinned portfolio release is required.');
export default defineConfig({ base: './', publicDir: '.portfolio-dust-release/public', plugins: [react()],
  define: { __PORTFOLIO_DUST_RELEASE__: JSON.stringify(release) },
  build: { outDir: 'dist-portfolio-dust', emptyOutDir: true, rollupOptions: { input: resolve('portfolio-dust-upgrade.html') } } });

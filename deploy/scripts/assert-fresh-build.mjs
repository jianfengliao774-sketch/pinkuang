import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultDist = fileURLToPath(new URL('../dist/', import.meta.url));
const rootFiles = new Set(['index.html', 'favicon.svg', 'deployment-artifacts.json']);

/** The fresh release must contain only its deployment entry and pinned assets. */
export async function assertFreshBuild(dist = defaultDist) {
  const entries = await readdir(dist, { withFileTypes: true });
  const names = new Set(entries.map(entry => entry.name));
  for (const name of rootFiles) {
    if (!names.has(name)) throw new Error(`Fresh deployment build is missing ${name}.`);
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name === 'assets') continue;
    if (!entry.isFile() || !rootFiles.has(entry.name)) {
      throw new Error(`Fresh deployment build contains an unexpected entry: ${entry.name}.`);
    }
  }
  const html = await readFile(join(dist, 'index.html'), 'utf8');
  if (!html.includes('assets/') || html.includes('upgrade.html')) {
    throw new Error('Fresh deployment entry is not a standalone compiled page.');
  }
  const assets = await readdir(join(dist, 'assets'), { withFileTypes: true });
  if (!assets.length || assets.some(entry => !entry.isFile() || !/\.(?:js|css)$/.test(entry.name)
    || /upgrade/i.test(entry.name))) {
    throw new Error('Fresh deployment assets are missing or contain an unexpected file.');
  }
  for (const entry of assets.filter(item => item.name.endsWith('.js'))) {
    const source = await readFile(join(dist, 'assets', entry.name), 'utf8');
    if (source.includes('upgrade-genesis/') || source.includes('pinkuang-upgrade-v2/')) {
      throw new Error(`Fresh deployment asset contains a retired upgrade route: ${entry.name}.`);
    }
    if (/0x(?:2995b10d19056c8c24c57b281c22562a603c571f|cb24e7f96d81037086a268d6ea63c53f91d412a2)/i.test(source)) {
      throw new Error(`Fresh deployment asset contains a previous Factory address: ${entry.name}.`);
    }
    if (/bemine-v2\/|pinkuang-deploy-v3\/|migrateLegacyMarketPending/.test(source)) {
      throw new Error(`Fresh deployment asset contains a retired product or market route: ${entry.name}.`);
    }
  }
  return { dist: resolve(dist), files: entries.length + assets.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await assertFreshBuild();
  console.log(`Fresh deployment package verified: ${result.files} files.`);
}

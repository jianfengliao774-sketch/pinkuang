import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const distRoot = fileURLToPath(new URL('../dist/', import.meta.url));

// The deployment bundle and icon are the only public files reviewed for a fresh console.
for (const name of ['deployment-artifacts.json', 'favicon.svg']) {
  await copyFile(join(publicRoot, name), join(distRoot, name));
}

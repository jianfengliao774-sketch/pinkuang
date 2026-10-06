import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEPLOY = fileURLToPath(new URL('../', import.meta.url));
const files = ['deployment-artifacts.json', 'upgrade-genesis/genesis-record.json',
  'upgrade-genesis/genesis-artifacts.json'];

for (const name of files) {
  const source = join(DEPLOY, 'public', name);
  const stat = lstatSync(source);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 8_000_000,
    `Invalid pinned upgrade public file: ${name}`);
  const bytes = readFileSync(source);
  const target = join(DEPLOY, 'dist-upgrade', name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes, { flag: 'wx', mode: 0o644 });
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const deploy = realpathSync(resolve(here, '../..'));
const root = realpathSync(resolve(deploy, '..'));
const files = {
  'package.json': 'ops/v2/purchase-runtime/package.json',
  'package-lock.json': 'ops/v2/purchase-runtime/package-lock.json',
  'scripts/purchase-supervisor.mjs': 'scripts/purchase-supervisor.mjs',
  'scripts/purchase-keeper.mjs': 'scripts/purchase-keeper.mjs',
  'scripts/official-market-discovery.mjs': 'scripts/official-market-discovery.mjs',
  'scripts/budget-multicall-read.mjs': 'scripts/budget-multicall-read.mjs',
  'src/firsto-purchase.mjs': 'src/firsto-purchase.mjs',
};
const hash = data => createHash('sha256').update(data).digest('hex');

const output = process.argv[2];
assert(process.argv.length === 3 && isAbsolute(output), 'Usage: node package-purchase-runtime.mjs /absolute/new/release');
const target = resolve(output), parent = realpathSync(dirname(target));
assert(parent === dirname(target) && target !== root && !target.startsWith(root + sep), 'Output must be outside the repository.');
const dirty = execFileSync('git', ['status', '--porcelain', '--', ...Object.values(files).map(name => `deploy/${name}`)], { cwd: root, encoding: 'utf8' });
assert(!dirty.trim(), 'Commit purchase runtime files before packaging.');
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
mkdirSync(target, { recursive: false });
const manifest = { kind: 'pinkuang-purchase-v2', chainId: 56, sourceHead, createdAt: new Date().toISOString(), files: {} };
for (const [name, source] of Object.entries(files)) {
  const input = join(deploy, source), stat = lstatSync(input);
  assert(stat.isFile() && !stat.isSymbolicLink(), `Invalid source file: ${source}`);
  const destination = join(target, name);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(input, destination);
  const bytes = readFileSync(destination);
  manifest.files[name] = { sha256: hash(bytes), bytes: bytes.length, source: relative(root, input) };
}
writeFileSync(join(target, 'purchase-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
console.log(JSON.stringify({ directory: target, sourceHead, files: Object.keys(files).length }));

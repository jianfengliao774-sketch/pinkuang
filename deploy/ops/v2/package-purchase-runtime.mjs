import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const deploy = realpathSync(resolve(here, '../..'));
const root = realpathSync(resolve(deploy, '..'));
export const PURCHASE_RUNTIME_FILES = Object.freeze({
  "shared/fresh-runtime-identity.mjs": "shared/fresh-runtime-identity.mjs",
  "server/fresh-machine-readiness.mjs": "server/fresh-machine-readiness.mjs",
  "scripts/fresh-worker-readiness.mjs": "scripts/fresh-worker-readiness.mjs",
  'package.json': 'ops/v2/purchase-runtime/package.json',
  'package-lock.json': 'ops/v2/purchase-runtime/package-lock.json',
  'scripts/purchase-supervisor.mjs': 'scripts/purchase-supervisor.mjs',
  'scripts/purchase-keeper.mjs': 'scripts/purchase-keeper.mjs',
  'scripts/keeper-credential.mjs': 'scripts/keeper-credential.mjs',
  'scripts/fresh-purchase-guard.mjs': 'scripts/fresh-purchase-guard.mjs',
  'scripts/official-market-discovery.mjs': 'scripts/official-market-discovery.mjs',
  'scripts/budget-multicall-read.mjs': 'scripts/budget-multicall-read.mjs',
  'src/firsto-purchase.mjs': 'src/firsto-purchase.mjs',
  'server/product-graph.mjs': 'server/product-graph.mjs',
  'shared/firsto-upgrade-proof.mjs': 'shared/firsto-upgrade-proof.mjs',
  'shared/fresh-activation-chain-proof.mjs': 'shared/fresh-activation-chain-proof.mjs',
  'shared/fresh-activation-execution.mjs': 'shared/fresh-activation-execution.mjs',
  'shared/integrated-upgrade-plan.mjs': 'shared/integrated-upgrade-plan.mjs',
  'shared/original-gas-wallet.mjs': 'shared/original-gas-wallet.mjs',
});
const hash = data => createHash('sha256').update(data).digest('hex');

/** Check every literal local import, including the supervisor's opt-in dynamic guard. */
export function assertPurchaseImportClosure(contents) {
  assert(contents instanceof Map, 'Package contents must be a map.');
  let edges = 0;
  for (const [name, bytes] of contents) {
    if (!name.endsWith('.mjs')) continue;
    const source = bytes.toString('utf8');
    const imports = [
      ...source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:[^;]*?\s+from\s+)?['"]([^'"]+)['"]/g),
      ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ];
    for (const [, specifier] of imports) {
      if (!specifier.startsWith('.')) continue;
      const target = relative('/', resolve('/', dirname(name), specifier)).split(sep).join('/');
      assert(contents.has(target), `Missing packaged import: ${name} -> ${specifier}`);
      edges++;
    }
  }
  assert(edges >= 10, 'Purchase import scan did not cover the expected module graph.');
  return edges;
}

export function packagePurchaseRuntime({ output, sourceHead, verifyGit = true } = {}) {
  assert(isAbsolute(output ?? ''), 'Output must be an absolute new release directory.');
  const target = resolve(output), parent = realpathSync(dirname(target));
  assert(parent === dirname(target) && target !== root && !target.startsWith(root + sep), 'Output must be outside the repository.');
  if (verifyGit) {
    const dirty = execFileSync('git', ['status', '--porcelain', '--',
      'deploy/ops/v2/package-purchase-runtime.mjs',
      ...Object.values(PURCHASE_RUNTIME_FILES).map(name => `deploy/${name}`)], { cwd: root, encoding: 'utf8' });
    assert(!dirty.trim(), 'Commit purchase runtime files before packaging.');
  }
  sourceHead ??= execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert(/^[0-9a-f]{40}$/.test(sourceHead), 'A complete source Git commit is required.');
  const contents = new Map();
  for (const [name, source] of Object.entries(PURCHASE_RUNTIME_FILES)) {
    const input = join(deploy, source), stat = lstatSync(input);
    assert(stat.isFile() && !stat.isSymbolicLink(), `Invalid source file: ${source}`);
    contents.set(name, readFileSync(input));
  }
  const checkedImports = assertPurchaseImportClosure(contents);
  mkdirSync(target, { recursive: false });
  const manifest = { kind: 'pinkuang-purchase-v2', chainId: 56, sourceHead, createdAt: new Date().toISOString(), files: {} };
  for (const [name, source] of Object.entries(PURCHASE_RUNTIME_FILES)) {
    const destination = join(target, name);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents.get(name), { flag: 'wx', mode: 0o644 });
    const bytes = readFileSync(destination);
    manifest.files[name] = { sha256: hash(bytes), bytes: bytes.length, source: relative(root, join(deploy, source)) };
  }
  writeFileSync(join(target, 'purchase-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
  return { directory: target, sourceHead, files: contents.size, checkedImports };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(process.argv.length === 3, 'Usage: node package-purchase-runtime.mjs /absolute/new/release');
  console.log(JSON.stringify(packagePurchaseRuntime({ output: process.argv[2] })));
}

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertFreshBuild } from './assert-fresh-build.mjs';
import { servedArtifactDigest } from '../server/artifact-digest.mjs';

const DEPLOY = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const SOURCE_COMMIT = /^[a-f\d]{40}$/i;

// This is the complete, reviewed import graph of server/index.mjs. Adding a
// runtime dependency must update the allowlist and its tests; CLI entrypoints,
// tests, build inputs, old upgrade material and credentials are never copied.
export const RUNTIME_MODULES = Object.freeze([
  'scripts/authority-relay.mjs',
  'scripts/budget-multicall-read.mjs',
  'scripts/budget-official-discovery.mjs',
  'scripts/keeper-credential.mjs',
  'scripts/official-market-discovery.mjs',
  'scripts/purchase-keeper.mjs',
  'server/artifact-digest.mjs',
  'server/authority-relay-api.mjs',
  'server/budget-candidates.mjs',
  'server/creation-cutover.mjs',
  'server/firsto-proxy.mjs',
  'server/firsto-sale-preflight.mjs',
  'server/fresh-activation-journal.mjs',
  'server/index.mjs',
  'server/journal-api.mjs',
  'server/journal-store.mjs',
  'server/live-data-proxy.mjs',
  'server/notifications/config.mjs',
  'server/notifications/delivery.mjs',
  'server/notifications/runtime.mjs',
  'server/notifications/service.mjs',
  'server/notifications/store.mjs',
  'server/notifications/telegram.mjs',
  'server/portfolio-intent.mjs',
  'server/product-graph.mjs',
  'server/request-limiter.mjs',
  'shared/budget-queue.mjs',
  'shared/firsto-upgrade-proof.mjs',
  'shared/initialization-proof.mjs',
  'shared/integrated-upgrade-plan.mjs',
  'src/firsto-purchase.mjs',
]);

const REQUIRED_FILES = Object.freeze([
  'package.json', 'package-lock.json', 'public/deployment-artifacts.json',
]);
const forbidden = name => name.split('/').some(part => part.startsWith('.')
  || /^(?:node_modules|private|secrets?|credentials?|wallets?)$/i.test(part))
  || /\.(?:env|sqlite|sqlite3|db|wal|shm|pem|key|p12|pfx|keystore)(?:[-.]|$)/i.test(name)
  || /(?:^|\/)(?:upgrade|legacy)(?:[-./]|$)/i.test(name);

function regularFile(source, name) {
  assert(!forbidden(name), `Private or retired release path: ${name}`);
  const path = join(source, name), stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink(), `Only regular release files are allowed: ${name}`);
  const data = readFileSync(path);
  assert(!/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(data.toString('utf8')),
    `Private-key material is not allowed: ${name}`);
  return data;
}

export function relativeImports(source) {
  assert(!/\bimport\s*\(\s*(?!["'])/.test(source), 'Computed dynamic import is not allowed in a packaged runtime module.');
  const imports = [...source.matchAll(/\b(?:import|export)\s+(?:(?:[^;]*?\s+from\s+)?)['"]([^'"]+)['"]/g),
    ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)];
  return imports.map(match => match[1]).filter(specifier => specifier.startsWith('.'));
}

/** Assert the explicit allowlist is exactly the reachable module closure. */
export function verifyRuntimeClosure(files, runtimeModules = RUNTIME_MODULES) {
  const expected = new Set(runtimeModules);
  assert(expected.has('server/index.mjs'), 'The server entrypoint is required.');
  assert(expected.size === runtimeModules.length, 'Duplicate runtime allowlist entry.');
  const seen = new Set(), queue = ['server/index.mjs'];
  while (queue.length) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    assert(expected.has(name), `Missing allowlisted runtime dependency: ${name}`);
    seen.add(name);
    const data = files.get(name);
    assert(data, `Missing packaged runtime module: ${name}`);
    for (const specifier of relativeImports(data.toString('utf8'))) {
      const target = relative(resolve('/'), resolve('/', dirname(name), specifier)).split(sep).join('/');
      assert(!target.startsWith('../') && expected.has(target),
        `Missing allowlisted runtime dependency: ${name} -> ${specifier}`);
      queue.push(target);
    }
  }
  assert.deepEqual([...expected].sort(), [...seen].sort(), 'Runtime allowlist includes unreachable modules.');
  return seen.size;
}

function ensureSourceCommit(source, sourceHead) {
  assert(SOURCE_COMMIT.test(sourceHead), 'A complete 40-hex source commit is required.');
  const cleanPaths = ['src', 'server', 'shared', 'scripts', 'index.html', 'vite.config.ts',
    'package.json', 'package-lock.json', '../contracts/src', '../contracts/foundry.toml'];
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', ...cleanPaths],
    { cwd: source, encoding: 'utf8' });
  assert(!dirty.trim(), 'Commit reviewed source before creating a fresh console release.');
  const tracked = execFileSync('git', ['ls-files', '--', ...RUNTIME_MODULES],
    { cwd: source, encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(tracked.sort(), [...RUNTIME_MODULES].sort(), 'Every packaged runtime module must be tracked at the source commit.');
}

/** Build a new, source-pinned directory; no SSH, installation or transaction. */
export async function packageFreshConsole({ deployDir = DEPLOY, outDir, sourceHead,
  verifyGit = true } = {}) {
  assert(typeof outDir === 'string' && isAbsolute(outDir), '--out must name a new absolute directory.');
  const source = realpathSync(deployDir), output = resolve(outDir);
  const sourceRoot = realpathSync(join(source, '..'));
  assert(!output.startsWith(sourceRoot + sep), 'The package must be outside the source checkout.');
  const parent = realpathSync(dirname(output));
  assert(parent === resolve(dirname(output)), 'Package parent must be canonical.');
  try { lstatSync(output); assert.fail('Package output already exists and will not be overwritten.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await assertFreshBuild(join(source, 'dist'));
  if (verifyGit) ensureSourceCommit(source, sourceHead);

  const files = new Map();
  for (const name of [...RUNTIME_MODULES, ...REQUIRED_FILES]) files.set(name, regularFile(source, name));
  for (const name of ['index.html', 'favicon.svg', 'deployment-artifacts.json'])
    files.set(`dist/${name}`, regularFile(source, `dist/${name}`));
  for (const entry of readdirSync(join(source, 'dist/assets')).sort())
    files.set(`dist/assets/${entry}`, regularFile(source, `dist/assets/${entry}`));
  verifyRuntimeClosure(files);
  assert(files.get('dist/deployment-artifacts.json').equals(files.get('public/deployment-artifacts.json')),
    'Served artifact differs from the packaged artifact.');
  const artifact = JSON.parse(files.get('public/deployment-artifacts.json').toString('utf8'));
  assert(!verifyGit || artifact.sourceCommit === sourceHead,
    'Artifact sourceCommit is not the reviewed source HEAD. Regenerate artifacts after committing.');
  for (const name of ['FreshPoolFactory', 'PlatformAuthority', 'AtomicDeployment',
    'BudgetPortfolioFactory', 'BudgetPortfolioVault'])
    assert(artifact.artifacts?.[name], `Fresh deployment artifact is missing: ${name}`);
  const artifactDigest = servedArtifactDigest(join(source, 'public/deployment-artifacts.json'));
  assert([...files].some(([name, bytes]) => name.startsWith('dist/assets/') && name.endsWith('.js')
    && bytes.toString('utf8').includes(artifactDigest)),
  'Browser bundle does not embed the current artifact digest. Rebuild the fresh page.');

  const ordered = [...files].sort(([a], [b]) => a.localeCompare(b));
  mkdirSync(output, { recursive: false });
  for (const [name, bytes] of ordered) {
    const target = join(output, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o644 });
  }
  const manifest = {
    schemaVersion: 1, kind: 'fresh-console-pre-genesis', chainId: 56,
    sourceCommit: artifact.sourceCommit, sourceHead,
    artifactDigest, artifactSha256: sha256(files.get('public/deployment-artifacts.json')),
    installation: 'npm ci --omit=dev --ignore-scripts', entrypoint: 'node server/index.mjs',
    runtimeModules: RUNTIME_MODULES, files: Object.fromEntries(ordered.map(([name, bytes]) =>
      [name, { sha256: sha256(bytes), bytes: bytes.length }])),
    activation: 'Deployment console only; product, Gas relay and automatic purchase remain disabled.',
  };
  writeFileSync(join(output, 'public/fresh-release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: 'wx', mode: 0o644 });
  return { directory: output, fileCount: files.size + 1, sourceHead, artifactDigest,
    manifestSha256: sha256(readFileSync(join(output, 'public/fresh-release-manifest.json'))) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert(process.argv.length === 4 && process.argv[2] === '--out',
      'Usage: node scripts/package-fresh-console.mjs --out <absolute-new-directory>');
    const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: DEPLOY, encoding: 'utf8' }).trim();
    console.log(JSON.stringify(await packageFreshConsole({ outDir: process.argv[3], sourceHead }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

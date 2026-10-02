import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertFreshBuild } from './assert-fresh-build.mjs';
import { servedArtifactDigest } from '../server/artifact-digest.mjs';
import { productGraphConfiguration } from '../server/product-graph.mjs';
import { validateFreshProductBindings } from '../server/fresh-product-gate.mjs';
import { createFreshIndexManifest, freshIndexManifestBytes, freshIndexManifestSha256 } from '../server/chain-index/fresh-manifest.mjs';
import { prepareFreshCutover } from '../ops/v4/prepare-fresh-cutover.mjs';

const DEPLOY = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const SOURCE_COMMIT = /^[a-f\d]{40}$/i;
const PINNED_SOURCE_PATHS = Object.freeze([
  // The artifact commit identifies the deployed Solidity build. Runtime code
  // is independently pinned by sourceHead and may receive later fixes.
  '../contracts/src', '../contracts/foundry.toml',
]);

// This is the complete, reviewed import graph of server/index.mjs. Adding a
// runtime dependency must update the allowlist and its tests; CLI entrypoints,
// tests, build inputs, old upgrade material and credentials are never copied.
export const RUNTIME_MODULES = Object.freeze([
  "scripts/budget-multicall-read.mjs",
  "scripts/budget-official-discovery.mjs",
  "scripts/official-market-discovery.mjs",
  "server/artifact-digest.mjs",
  "server/authority-ipc.mjs",
  "server/authority-role.mjs",
  "server/budget-candidates.mjs",
  "server/chain-index/fresh-manifest.mjs",
  "server/creation-cutover.mjs",
  "server/firsto-proxy.mjs",
  "server/firsto-sale-preflight.mjs",
  "server/firsto-ask-publisher.mjs",
  "server/firsto-ask-publisher-store.mjs",
  "server/fresh-activation-journal.mjs",
  "server/fresh-product-gate.mjs",
  "server/index.mjs",
  "server/journal-api.mjs",
  "server/journal-store.mjs",
  "server/live-data-proxy.mjs",
  "server/notifications/community-config.mjs",
  "server/notifications/community.mjs",
  "server/notifications/config.mjs",
  "server/notifications/delivery.mjs",
  "server/notifications/runtime.mjs",
  "server/notifications/service.mjs",
  "server/notifications/store.mjs",
  "server/notifications/telegram.mjs",
  "server/portfolio-intent.mjs",
  "server/product-graph.mjs",
  "server/request-limiter.mjs",
  "shared/budget-queue.mjs",
  "shared/firsto-upgrade-proof.mjs",
  "shared/firsto-native-ask.mjs",
  "shared/fresh-native-sale-proof.mjs",
  "shared/fresh-factory-reuse-proof.mjs",
  "shared/fresh-sale-policy-proof.mjs",
  "shared/fresh-activation-chain-proof.mjs",
  "shared/fresh-activation-execution.mjs",
  "shared/fresh-runtime-identity.mjs",
  "shared/fresh-wallet-actions.mjs",
  "shared/gas-signer-attestation.mjs",
  "shared/initialization-proof.mjs",
  "shared/integrated-upgrade-plan.mjs",
  "src/firsto-purchase.mjs"
]);

export const PRODUCT_BACKEND_MODULES = Object.freeze([
  "scripts/authority-relay.mjs",
  "scripts/budget-multicall-read.mjs",
  "scripts/budget-official-discovery.mjs",
  "scripts/fresh-purchase-guard.mjs",
  "scripts/fresh-worker-readiness.mjs",
  "scripts/keeper-credential.mjs",
  "scripts/mining-keeper.mjs",
  "scripts/mining-proofs.mjs",
  "scripts/mining-supervisor.mjs",
  "scripts/official-market-discovery.mjs",
  "scripts/purchase-keeper.mjs",
  "scripts/purchase-supervisor.mjs",
  "server/artifact-digest.mjs",
  "server/authority-ipc.mjs",
  "server/authority-relay-api.mjs",
  "server/authority-role.mjs",
  "server/authority-signer.mjs",
  "server/budget-candidates.mjs",
  "server/chain-index/api.mjs",
  "server/chain-index/cached-read-api.mjs",
  "server/chain-index/community.mjs",
  "server/chain-index/fresh-manifest.mjs",
  "server/chain-index/indexer.mjs",
  "server/chain-index/notifications.mjs",
  "server/chain-index/portfolio-notifications.mjs",
  "server/chain-index/server.mjs",
  "server/chain-index/pool-display-cache.mjs",
  "server/chain-index/overview-stats.mjs",
  "server/creation-cutover.mjs",
  "server/firsto-proxy.mjs",
  "server/firsto-sale-preflight.mjs",
  "server/firsto-ask-publisher.mjs",
  "server/firsto-ask-publisher-store.mjs",
  "server/firsto-listing-expiry-keeper.mjs",
  "server/fresh-activation-journal.mjs",
  "server/fresh-machine-readiness.mjs",
  "server/fresh-product-gate.mjs",
  "server/index.mjs",
  "server/journal-api.mjs",
  "server/journal-store.mjs",
  "server/live-data-proxy.mjs",
  "server/notifications/community-config.mjs",
  "server/notifications/community.mjs",
  "server/notifications/config.mjs",
  "server/notifications/delivery.mjs",
  "server/notifications/runtime.mjs",
  "server/notifications/service.mjs",
  "server/notifications/store.mjs",
  "server/notifications/telegram.mjs",
  "server/portfolio-intent.mjs",
  "server/product-graph.mjs",
  "server/request-limiter.mjs",
  "server/sale-reference-publisher.mjs",
  "server/sale-reference-status-read.mjs",
  "shared/authority-typed.mjs",
  "shared/activity-summary.mjs",
  "shared/budget-queue.mjs",
  "shared/firsto-upgrade-proof.mjs",
  "shared/firsto-native-ask.mjs",
  "shared/firsto-sale-reference.mjs",
  "shared/fresh-native-sale-proof.mjs",
  "shared/fresh-factory-reuse-proof.mjs",
  "shared/fresh-sale-policy-proof.mjs",
  "shared/fresh-activation-chain-proof.mjs",
  "shared/fresh-activation-execution.mjs",
  "shared/fresh-runtime-identity.mjs",
  "shared/fresh-wallet-actions.mjs",
  "shared/gas-signer-attestation.mjs",
  "shared/initialization-proof.mjs",
  "shared/integrated-upgrade-plan.mjs",
  "shared/original-gas-wallet.mjs",
  "shared/read-only-rpc-fallback.mjs",
  "shared/runtime-rpc-selection.mjs",
  "shared/sale-review-policy.mjs",
  "src/pricing.ts",
  "src/firsto-purchase.mjs"
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
export function verifyRuntimeClosure(files, runtimeModules = RUNTIME_MODULES,
  entrypoints = ['server/index.mjs']) {
  const expected = new Set(runtimeModules);
  assert(entrypoints.every(name => expected.has(name)), 'Every runtime entrypoint is required.');
  assert(expected.size === runtimeModules.length, 'Duplicate runtime allowlist entry.');
  const seen = new Set(), queue = [...entrypoints];
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

function ensureSourceCommit(source, sourceHead, runtimeModules) {
  assert(SOURCE_COMMIT.test(sourceHead), 'A complete 40-hex source commit is required.');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
  assert.equal(sourceHead.toLowerCase(), head.toLowerCase(), 'Release source HEAD differs from the checkout.');
  const cleanPaths = ['src', 'server', 'shared', 'scripts', 'ops', 'public/deployment-artifacts.json',
    'index.html', 'vite.config.ts', 'package.json', 'package-lock.json',
    '../contracts/src', '../contracts/foundry.toml'];
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', ...cleanPaths],
    { cwd: source, encoding: 'utf8' });
  assert(!dirty.trim(), `Commit reviewed source before creating a fresh console release. Dirty paths:\n${dirty.trim()}`);
  const tracked = execFileSync('git', ['ls-files', '--', ...runtimeModules],
    { cwd: source, encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(tracked.sort(), [...runtimeModules].sort(), 'Every packaged runtime module must be tracked at the source commit.');
}

export function assertPinnedSourceUnchanged(source, artifactCommit, sourceHead) {
  assert(SOURCE_COMMIT.test(artifactCommit), 'Deployment artifact source commit is malformed.');
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', artifactCommit, sourceHead],
    { cwd: source, stdio: 'ignore' });
  assert.equal(ancestor.status, 0, 'Deployment artifact source commit is not an ancestor of the release.');
  const changed = spawnSync('git', ['diff', '--quiet', artifactCommit, sourceHead,
    '--', ...PINNED_SOURCE_PATHS], { cwd: source, stdio: 'ignore' });
  assert.equal(changed.status, 0, 'Reviewed deploy or contract source changed since the artifact commit.');
}

/** Build a new, source-pinned directory; no SSH, installation or transaction. */
async function packageRelease({ deployDir = DEPLOY, outDir, sourceHead,
  verifyGit = true, indexManifest = null } = {}) {
  assert(typeof outDir === 'string' && isAbsolute(outDir), '--out must name a new absolute directory.');
  const source = realpathSync(deployDir), output = resolve(outDir);
  const sourceRoot = realpathSync(join(source, '..'));
  assert(!output.startsWith(sourceRoot + sep), 'The package must be outside the source checkout.');
  const parent = realpathSync(dirname(output));
  assert(parent === resolve(dirname(output)), 'Package parent must be canonical.');
  try { lstatSync(output); assert.fail('Package output already exists and will not be overwritten.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await assertFreshBuild(join(source, 'dist'));
  const runtimeModules = indexManifest ? PRODUCT_BACKEND_MODULES : RUNTIME_MODULES;
  if (verifyGit) ensureSourceCommit(source, sourceHead, runtimeModules);

  const files = new Map();
  for (const name of [...runtimeModules, ...REQUIRED_FILES]) files.set(name, regularFile(source, name));
  for (const name of ['index.html', 'favicon.svg', 'deployment-artifacts.json'])
    files.set(`dist/${name}`, regularFile(source, `dist/${name}`));
  for (const entry of readdirSync(join(source, 'dist/assets')).sort())
    files.set(`dist/assets/${entry}`, regularFile(source, `dist/assets/${entry}`));
  verifyRuntimeClosure(files, runtimeModules, indexManifest
    ? ["server/index.mjs","server/chain-index/server.mjs","server/authority-signer.mjs","scripts/purchase-supervisor.mjs","scripts/mining-supervisor.mjs"] : ['server/index.mjs']);
  assert(files.get('dist/deployment-artifacts.json').equals(files.get('public/deployment-artifacts.json')),
    'Served artifact differs from the packaged artifact.');
  const artifact = JSON.parse(files.get('public/deployment-artifacts.json').toString('utf8'));
  if (verifyGit) assertPinnedSourceUnchanged(source, artifact.sourceCommit, sourceHead);
  for (const name of ['FreshPoolFactory', 'PlatformAuthority', 'AtomicDeployment',
    'BudgetPortfolioFactory', 'BudgetPortfolioVault'])
    assert(artifact.artifacts?.[name], `Fresh deployment artifact is missing: ${name}`);
  const artifactDigest = servedArtifactDigest(join(source, 'public/deployment-artifacts.json'));
  if (indexManifest) {
    assert.equal(indexManifest.artifactDigest, artifactDigest.toLowerCase(),
      'Fresh index manifest must use the packaged deployment artifact.');
    files.set('public/fresh-product-manifest.json', freshIndexManifestBytes(indexManifest));
  }
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
    schemaVersion: 1, kind: indexManifest ? 'fresh-v4-product-backend-draft' : 'fresh-console-pre-genesis', chainId: 56,
    sourceCommit: artifact.sourceCommit, sourceHead,
    artifactDigest, artifactSha256: sha256(files.get('public/deployment-artifacts.json')),
    installation: 'npm ci --omit=dev --ignore-scripts', entrypoint: 'node server/index.mjs',
    runtimeModules, files: Object.fromEntries(ordered.map(([name, bytes]) =>
      [name, { sha256: sha256(bytes), bytes: bytes.length }])),
    ...(indexManifest ? { indexManifestSha256: freshIndexManifestSha256(indexManifest) } : {}),
    activation: indexManifest
      ? 'Offline product backend draft. Product writes, Stage 2, Gas relay and automatic purchase remain disabled.'
      : 'Deployment console only; product, Gas relay and automatic purchase remain disabled.',
  };
  writeFileSync(join(output, 'public/fresh-release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: 'wx', mode: 0o644 });
  return { directory: output, fileCount: files.size + 1, sourceHead, artifactDigest,
    manifestSha256: sha256(readFileSync(join(output, 'public/fresh-release-manifest.json'))) };
}

export function packageFreshConsole(options = {}) { return packageRelease(options); }

/** Include the separate v4 index only after matching a reviewed fresh graph to this source build. */
export function packageFreshProductBackend({ cutoverInput, ...options } = {}) {
  assert(cutoverInput && typeof cutoverInput === 'object', 'Reviewed fresh cutover input is required.');
  const draft = prepareFreshCutover(cutoverInput);
  assert.equal(draft.activationAllowed, false);
  return packageRelease({ ...options, indexManifest: draft.indexManifest });
}

/** Package a reviewed fresh graph without installing the historical v4 cutover layout. */
export function packageReviewedFreshProductBackend({record,bundle,activation,manifest,...options}={}) {
  const trusted=productGraphConfiguration({record,bundle,productActivation:activation,
    expectedGasWallet:manifest?.gasWallet});
  const indexManifest=createFreshIndexManifest(manifest);
  validateFreshProductBindings({manifest:indexManifest},trusted,
    new Set([manifest.factory,manifest.portfolioFactory].map(address=>address.toLowerCase())));
  return packageRelease({...options,indexManifest});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert(process.argv.length === 4 && process.argv[2] === '--out',
      'Usage: node scripts/package-fresh-console.mjs --out <absolute-new-directory>');
    const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: DEPLOY, encoding: 'utf8' }).trim();
    console.log(JSON.stringify(await packageFreshConsole({ outDir: process.argv[3], sourceHead }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

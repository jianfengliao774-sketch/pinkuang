import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactContentDigest, assertCurrentArtifacts, compileDeploymentArtifacts, repositoryRoot } from './build-artifacts.mjs';
import { evidenceDigest } from '../shared/firsto-upgrade-proof.mjs';

// Independent review roots. CI must not turn its own freshly generated digest
// into approval or apply the old full-deployment Gas plan to a new bundle.
export const targetOwnerCiPins = Object.freeze({
  legacySourceHead: '1486d897331e7a54a08f86d9068f3c2682258adf',
  legacyArtifactSourceCommit: '6361bff1247e7297b96d2659145a0e7256e6765c',
  legacyArtifactDigest: '0xbe37228e94095440e9cde68ae7b5e605b75154a5c7453d58b796ddb2925ec927',
  candidateArtifactDigest: '0xc9be5208ec97a0513d29c5f1d35a9e89f54c998b5994d2a291c09e5e496881e5',
  reviewCatalogDigest: '0x01ff90f9a074a6faeb71c452bd8ad36fc0989b143f68fe5240c4d6ece0c538ba',
});
export const publishedTargetOwnerUiPins = Object.freeze({
  sourceCommit: '9784000db2f9adf7775e0ebc232b76437f1fdef2',
  sourceDiffDigest: '6ddfbb24cf0b8528d5ff7d9ae665e9d97fd326faf08fa14fe173a5f20433709e',
  manifestSha256: '4442d7617931be348950ba8896bd2d0387c8672f8b4ec6d98101702febc08b2c',
});
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function assertPublishedTargetOwnerUiDigests({ sourceCommit, sourceDiffDigest, manifestSha256, headSourceDiffDigest }) {
  for (const [name, actual] of Object.entries({ sourceCommit, sourceDiffDigest, manifestSha256 }))
    assert.equal(actual, publishedTargetOwnerUiPins[name], `Published owner-upgrade UI root differs: ${name}.`);
  assert.equal(headSourceDiffDigest, publishedTargetOwnerUiPins.sourceDiffDigest,
    'Owner-upgrade UI/package source changed since the independently built and published release. Re-review and publish its new package.');
}

/** Prove HEAD matches the actually published package without claiming CI rebuilt it. */
export function assertPublishedTargetOwnerUiSources(root = repositoryRoot) {
  const bytes = readFileSync(join(root, 'docs/evidence/target-owner-upgrade-page-static-manifest-20261004.json'));
  const manifest = JSON.parse(bytes.toString('utf8'));
  // Exactly the reviewed preparation script's input closure. A new shared
  // source, changed wallet flow, CSS or package builder cannot inherit approval.
  const sources = ['deploy/src/TargetOwnerUpgradeStandalone.tsx', 'deploy/src/target-owner-upgrade-ui.ts',
    'deploy/src/target-owner-upgrade.css', 'deploy/src/wallet.ts', 'deploy/src/upgrade-transactions.ts',
    'deploy/vite.target-owner.config.ts', 'deploy/target-owner-upgrade.html', 'deploy/scripts/prepare-target-owner-static.mjs',
    'deploy/scripts/package-target-owner-static.mjs', 'deploy/scripts/measure-target-owner-gas.mjs',
    'deploy/evidence/target-owner-create-gas-20261004.json'];
  for (const file of readdirSync(join(root, 'deploy/shared')))
    if (file.endsWith('.mjs') && !file.endsWith('.test.mjs')) sources.push(`deploy/shared/${file}`);
  const hashes = Object.fromEntries(sources.sort().map(file => [file, sha256(readFileSync(join(root, file)))]));
  const headSourceDiffDigest = sha256(JSON.stringify(hashes));
  assertPublishedTargetOwnerUiDigests({ sourceCommit: manifest.sourceCommit, sourceDiffDigest: manifest.sourceDiffDigest,
    manifestSha256: sha256(bytes), headSourceDiffDigest });
  return { sourceCommit: manifest.sourceCommit, sourceDiffDigest: headSourceDiffDigest,
    sourceFileCount: sources.length, headSourceBytesMatchPublishedPackage: true, productionPackageRebuiltByCi: false };
}

// These tests compile the retained full-deployment bundle independently. They
// run, without modifications, in the exact reviewed legacy checkout below.
// All other tests, including the new upgrade UI, execute against current HEAD.
export const legacySourceCompiledTests = Object.freeze([
  'deployment.test.ts', 'deployment-replacement.test.ts', 'fresh-activation.integration.test.ts',
  'stage2-evm-recovery.test.ts', 'stage2-wrapped-evm-recovery.test.ts',
]);
const addedUpgradeUiPaths = Object.freeze([
  'deploy/src/TargetOwnerUpgradeStandalone.tsx', 'deploy/src/target-owner-upgrade-ui.ts',
  'deploy/src/target-owner-upgrade-ui.test.ts', 'deploy/src/target-owner-upgrade.css',
]);

export function assertTargetOwnerCiDigests(input) {
  for (const name of ['legacyArtifactDigest', 'legacyArtifactSourceCommit', 'candidateArtifactDigest', 'reviewCatalogDigest'])
    assert.equal(input[name], targetOwnerCiPins[name], `Owner upgrade CI review root differs: ${name}.`);
  assert.equal(input.catalogCandidateArtifactDigest, targetOwnerCiPins.candidateArtifactDigest,
    'The reviewed mixed graph belongs to another candidate.');
}

export function assertTargetOwnerCiRoots({ legacyBundle, candidateBundle, catalog }) {
  assertTargetOwnerCiDigests({ legacyArtifactDigest: artifactContentDigest(legacyBundle),
    legacyArtifactSourceCommit: legacyBundle.sourceCommit, candidateArtifactDigest: artifactContentDigest(candidateBundle),
    reviewCatalogDigest: evidenceDigest(catalog), catalogCandidateArtifactDigest: catalog.candidateArtifactDigest });
  assert.equal(catalog.profile, 'formal', 'Owner upgrade CI requires the reviewed formal graph.');
  assert.equal(catalog.genesisArtifactDigest, targetOwnerCiPins.legacyArtifactDigest,
    'The mixed graph must preserve the existing formal genesis artifact.');
}

export function selectTargetOwnerHeadTests(names) {
  assert.equal(new Set(names).size, names.length, 'Duplicate TypeScript test path.');
  assert(names.every(name => /^[\w.-]+\.test\.ts$/.test(name)), 'Unexpected TypeScript test path.');
  for (const name of legacySourceCompiledTests) assert(names.includes(name), `Missing retained deployment regression: ${name}.`);
  assert(names.includes('target-owner-upgrade-ui.test.ts'), 'The current owner-upgrade UI regressions are required.');
  return names.filter(name => !legacySourceCompiledTests.includes(name)).sort();
}

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

export function assertRetainedDeploymentSources(root = repositoryRoot) {
  const source = targetOwnerCiPins.legacySourceHead;
  const files = git(root, ['ls-tree', '-r', '--name-only', source, '--', 'deploy/src', 'web', '.nvmrc',
    'package.json', 'package-lock.json', 'deploy/package.json', 'deploy/package-lock.json']).split('\n').filter(Boolean);
  assert(files.length > 0, 'The reviewed legacy source commit is unavailable. Fetch full history.');
  for (const name of files) assert(readFileSync(join(root, name)).equals(execFileSync('git', ['show', `${source}:${name}`],
    { cwd: root, maxBuffer: 32 * 1024 * 1024 })),
    `Retained deployment/frontend source differs: ${name}. Review its CI profile before proceeding.`);
  const changes = git(root, ['diff', '--name-only', source, 'HEAD', '--', 'deploy/src', 'web']).split('\n').filter(Boolean);
  assert.deepEqual(changes.sort(), [...addedUpgradeUiPaths].sort(),
    'The owner-upgrade CI profile permits only the four reviewed new UI files; retained deployment/frontend sources must be identical.');
  assert.equal(spawnSync('git', ['diff', '--quiet', targetOwnerCiPins.legacyArtifactSourceCommit, source,
    '--', 'contracts/src', 'contracts/foundry.toml'], { cwd: root }).status, 0,
  'Legacy CI source must retain the approved artifact compiler inputs exactly.');
}

/** Prepare separate proof/candidate and legacy scopes; never overwrite a checked-in build input. */
export function prepareTargetOwnerCi(output, { root = repositoryRoot } = {}) {
  assert(isAbsolute(output) && !existsSync(output), 'CI output must be a new absolute directory.');
  assert.equal(realpathSync(dirname(output)), dirname(resolve(output)), 'CI output parent must be canonical.');
  assertRetainedDeploymentSources(root);
  const publishedUi = assertPublishedTargetOwnerUiSources(root);
  const sourceHead = git(root, ['rev-parse', 'HEAD']);
  const legacyBundle = JSON.parse(readFileSync(join(root, 'deploy/public/deployment-artifacts.json'), 'utf8'));
  const catalog = JSON.parse(readFileSync(join(root, 'docs/evidence/formal-target-owner-review-catalog-20261004.json'), 'utf8'));
  // This is a real compile of current HEAD, compared to the previously approved
  // constant, not to a self-generated expected JSON or its embedded digest.
  const candidateBundle = compileDeploymentArtifacts({ root });
  assertTargetOwnerCiRoots({ legacyBundle, candidateBundle, catalog });
  mkdirSync(output);
  writeFileSync(join(output, 'head-candidate-artifacts.json'), `${JSON.stringify(candidateBundle, null, 2)}\n`, { flag: 'wx' });
  const legacy = join(output, 'legacy-checkout');
  execFileSync('git', ['clone', '--shared', '--no-checkout', '--quiet', root, legacy], { stdio: 'pipe' });
  execFileSync('git', ['checkout', '--detach', '--quiet', targetOwnerCiPins.legacySourceHead], { cwd: legacy, stdio: 'pipe' });
  for (const name of ['node_modules', 'deploy/node_modules', 'web/node_modules']) {
    const dependency = join(root, name);
    assert(existsSync(dependency), `Install locked dependencies before preparing CI: ${name}.`);
    symlinkSync(realpathSync(dependency), join(legacy, name), 'dir');
  }
  // Git's trailing-slash directory ignore does not match dependency symlinks.
  // Keep only these exact locked dependency mounts out of the source-clean
  // check; source, artifacts and manifests remain fully tracked and checked.
  appendFileSync(join(legacy, '.git/info/exclude'), '\n/node_modules\n/deploy/node_modules\n/web/node_modules\n');
  const retained = JSON.parse(readFileSync(join(legacy, 'deploy/public/deployment-artifacts.json'), 'utf8'));
  assertCurrentArtifacts(legacyBundle, retained);
  assertCurrentArtifacts(retained, compileDeploymentArtifacts({ root: legacy }));
  const summary = { schemaVersion: 1, kind: 'target-owner-scoped-ci-v1', sourceHead,
    pins: targetOwnerCiPins, headScope: 'Current Solidity candidate, new upgrade UI and all shared/server/keeper/ops regressions.',
    legacyScope: 'Unmodified old full-deployment console, its measured Gas plan, product ABI and static/synthetic package builds.',
    retainedDeploymentAndFrontendSourceBytesIdentical: true,
    publishedUi,
    legacySourceCompiledTests, headCandidateArtifact: 'head-candidate-artifacts.json',
    candidateDeployedOrActivated: false, legacyBuildIsNotNewCandidateDeployment: true,
    chainActionsPerformed: false };
  writeFileSync(join(output, 'scope-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
  return summary;
}

function runHeadTests() {
  const names = readdirSync(join(repositoryRoot, 'deploy/src')).filter(name => name.endsWith('.test.ts'));
  const tests = selectTargetOwnerHeadTests(names).map(name => `src/${name}`);
  const result = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', '--test', ...tests],
    { cwd: join(repositoryRoot, 'deploy'), stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Current HEAD TypeScript regressions failed.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--head-tests') runHeadTests();
    else {
      assert(args.length === 2 && args[0] === '--out', 'Usage: node scripts/target-owner-ci-profile.mjs --out <new-absolute-directory> | --head-tests');
      console.log(JSON.stringify(prepareTargetOwnerCi(args[1]), null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

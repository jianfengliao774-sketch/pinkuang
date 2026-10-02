import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FRESH_ADMIN_ONE, FRESH_ADMIN_TWO, FRESH_DEPLOYER, FRESH_GAS_WALLET } from '../../deploy/shared/fresh-roles.mjs';
import { freshManifestDigest, validateFreshManifest } from '../lib/fresh-product-config.mjs';
import { DEFAULT_PUBLIC_SHARE_ORIGIN, isExactHttpsOrigin } from '../lib/public-share-origin.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..');
const repositoryRoot = resolve(webRoot, '..');
const defaultOutputRoot = join(webRoot, 'out-v4');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };
const same = (left, right) => typeof left === 'string' && typeof right === 'string'
  && left.toLowerCase() === right.toLowerCase();
const HASH = /^0x[\da-f]{64}$/i;
const activationSteps = ['deployAuthority', 'coreOperator', 'coreTreasury', 'budgetOperator',
  'budgetTreasury', 'coreOwner', 'budgetOwner'];
const defaultPublicOrigin = DEFAULT_PUBLIC_SHARE_ORIGIN;
const deployConsoleUrl = 'https://tapeout.cc.cd/pinkuang-deploy-v4/';

/** Require an explicit canonical HTTPS origin, never a path, redirect or credentials. */
export function validateFreshProductOrigin(value = defaultPublicOrigin) {
  if (!isExactHttpsOrigin(value))
    fail('Fresh product public origin must be an exact HTTPS origin without a path, credentials, query or fragment.');
  return value;
}

export function prepareFreshProductBuild(manifest, { publicOrigin = defaultPublicOrigin, version = '4' } = {}) {
  if (!['4', '5'].includes(version)) fail('Unsupported fresh product version.');
  const origin = validateFreshProductOrigin(publicOrigin);
  const manifestSha256 = freshManifestDigest(manifest);
  const checked = validateFreshManifest(manifest, manifestSha256);
  return Object.freeze({ basePath: `/bemine-v${version}`, productFamily: 'fresh-v4',
    publicOrigin: origin, publicUrl: `${origin}/bemine-v${version}/`,
    deployConsoleUrl: version === '5' ? 'https://tapeout.cc.cd/pinkuang-deploy-v5/' : deployConsoleUrl,
    manifestSha256, artifactDigest: checked.artifactDigest,
    factory: checked.factory, portfolioFactory: checked.portfolioFactory,
    authority: checked.authority, gasWallet: checked.gasWallet, deployment: checked.deployment,
    sourceCommit: checked.sourceCommit });
}

/** Production builds must match the roles and seven finalized steps reviewed by the deployment console. */
export function verifyFreshBuildEvidence(manifest, evidence) {
  const checked = validateFreshManifest(manifest, freshManifestDigest(manifest));
  const authority = checked.freshAuthority;
  if (!authority || !same(authority.administratorOne, FRESH_ADMIN_ONE)
    || !same(authority.administratorTwo, FRESH_ADMIN_TWO)
    || !same(authority.gasWallet, FRESH_GAS_WALLET))
    fail('Fresh product manifest roles differ from the reviewed deployment-console addresses.');
  if (evidence?.schemaVersion !== 1 || evidence.kind !== 'fresh-authority'
    || evidence.chainId !== 56 || typeof evidence.deploymentId !== 'string'
    || !same(evidence.deployer, FRESH_DEPLOYER)
    || !evidence.deploymentId || !same(evidence.genesisArtifactDigest, checked.artifactDigest)
    || !same(evidence.authority?.address, authority.address)
    || !same(evidence.authority?.deploymentTxHash, authority.deploymentTxHash)
    || !same(evidence.authority?.administratorOne, FRESH_ADMIN_ONE)
    || !same(evidence.authority?.administratorTwo, FRESH_ADMIN_TWO)
    || !same(evidence.authority?.gasWallet, FRESH_GAS_WALLET)
    || !Array.isArray(evidence.steps) || evidence.steps.length !== activationSteps.length)
    fail('Fresh activation evidence differs from the reviewed manifest or roles.');
  for (let index = 0; index < activationSteps.length; index++) {
    const step = evidence.steps[index];
    if (step?.id !== activationSteps[index] || !HASH.test(step.txHash ?? '')
      || !HASH.test(step.blockHash ?? '') || !Number.isSafeInteger(step.blockNumber)
      || step.blockNumber < checked.deployment.blockNumber
      || index > 0 && step.blockNumber < evidence.steps[index - 1].blockNumber)
      fail('Fresh activation evidence has an invalid finalized step.');
  }
  if (!same(evidence.steps[0].txHash, authority.deploymentTxHash)
    || evidence.steps.at(-1).blockNumber !== checked.verifiedBlockNumber
    || !same(evidence.steps.at(-1).blockHash, manifest.verifiedBlockHash))
    fail('Fresh activation evidence does not end at the pinned manifest block.');
  return checked;
}

export function reviewedSourceHead(repository = repositoryRoot) {
  const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'],
    { cwd: repository, encoding: 'utf8' }).trim();
  if (!/^[\da-f]{40}$/i.test(sourceHead)) fail('A complete reviewed frontend source HEAD is required.');
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', '.'],
    { cwd: repository, encoding: 'utf8' });
  if (dirty.trim()) fail('Commit reviewed repository source before building the v4 product.');
  return sourceHead;
}

function walk(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = join(directory, entry.name);
    if (entry.isSymbolicLink()) fail('Static release must not contain symlinks.');
    if (entry.isDirectory()) return walk(root, target);
    if (!entry.isFile()) fail('Static release contains a non-file entry.');
    return [relative(root, target)];
  });
}

/** Check out the exact reviewed commit without changing the operator's checkout.
 * Keep Git metadata: source verification recompiles Solidity and reads HEAD. */
function isolatedCheckout(repository, sourceHead, checkout) {
  const cloned = spawnSync('git', ['clone', '--shared', '--no-checkout', '--quiet', repository, checkout],
    { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
  if (cloned.error || cloned.status !== 0)
    fail(`Could not isolate the reviewed source commit (${cloned.status ?? cloned.error?.message}): ${cloned.stderr?.trim() ?? ''}`);
  const selected = spawnSync('git', ['-C', checkout, 'checkout', '--detach', '--quiet', sourceHead],
    { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
  if (selected.error || selected.status !== 0
    || execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== sourceHead)
    fail(`Could not check out the reviewed source commit (${selected.status ?? selected.error?.message}): ${selected.stderr?.trim() ?? ''}`);
  // Dependencies are reused by the disposable checkout. The static release
  // never includes these links or changes the original source files.
  for (const name of ['node_modules', 'web/node_modules', 'deploy/node_modules']) {
    const source = join(repository, name);
    if (existsSync(source) && statSync(source).isDirectory())
      symlinkSync(source, join(checkout, name), 'dir');
  }
}

/** Build from an isolated source snapshot; publish a separate static release. */
export function buildFreshProduct(manifestPath, activationEvidencePath,
  { run = spawnSync, repositoryDir = repositoryRoot, outputDir = defaultOutputRoot,
    publicOrigin = process.env.BEMINE_FRESH_PRODUCT_ORIGIN ?? defaultPublicOrigin, version = '4' } = {}) {
  if (!isAbsolute(manifestPath) || !isAbsolute(activationEvidencePath))
    fail('Reviewed manifest and activation evidence must use absolute paths.');
  if (!isAbsolute(outputDir) || existsSync(outputDir))
    fail('Fresh output must be a new absolute directory; existing releases are never overwritten.');
  const repository = realpathSync(repositoryDir);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const evidence = JSON.parse(readFileSync(activationEvidencePath, 'utf8'));
  const plan = prepareFreshProductBuild(manifest, { publicOrigin, version });
  verifyFreshBuildEvidence(manifest, evidence);
  const frontendSourceHead = reviewedSourceHead(repository);
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'bemine-v4-build-')));
  const checkout = join(scratch, 'checkout');
  let publication;
  try {
    isolatedCheckout(repository, frontendSourceHead, checkout);
    const isolatedWeb = join(checkout, 'web');
    const stagedManifest = join(isolatedWeb, `public/data/frontend-manifest.v${version}.json`);
    const compiledManifest = join(isolatedWeb, 'public/data/frontend-manifest.json');
    const outputRoot = join(isolatedWeb, 'out');
    if (existsSync(stagedManifest)) fail('Reviewed source already contains a staged v4 manifest.');
    if (existsSync(outputRoot)) fail('Reviewed source unexpectedly contains a compiled static output.');
    if (realpathSync(compiledManifest) !== compiledManifest || !lstatSync(compiledManifest).isFile())
      fail('Reviewed source frontend manifest must be a regular file within the isolated checkout.');
    mkdirSync(dirname(stagedManifest), { recursive: true });
    writeFileSync(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
    // Only the disposable checkout compiles the new trust root. A SIGKILL can
    // leave scratch files, but cannot change the old site's tracked manifest.
    writeFileSync(compiledManifest, `${JSON.stringify(manifest, null, 2)}\n`);
    const env = { ...process.env, NEXT_PUBLIC_BASE_PATH: plan.basePath,
      NEXT_PUBLIC_BEMINE_PRODUCT_FAMILY: plan.productFamily,
      NEXT_PUBLIC_V4_MANIFEST_SHA256: plan.manifestSha256,
      NEXT_PUBLIC_BEMINE_PUBLIC_ORIGIN: plan.publicOrigin,
      NEXT_PUBLIC_BEMINE_PUBLIC_URL: plan.publicUrl,
      NEXT_PUBLIC_DEPLOY_CONSOLE_URL: plan.deployConsoleUrl };
    for (const args of [['scripts/sync-contracts.mjs', '--check'],
      ['node_modules/next/dist/bin/next', 'build', '--webpack']]) {
      const build = run(process.execPath, args, { cwd: isolatedWeb, stdio: 'inherit', env });
      if (build.error || build.status !== 0)
        fail(`v4 product build failed (${build.status ?? build.error?.message}).`);
    }
    const exportedManifest = join(outputRoot, `data/frontend-manifest.v${version}.json`);
    if (!existsSync(join(outputRoot, 'index.html')) || !existsSync(exportedManifest)
      || !statSync(exportedManifest).isFile()) fail('v4 product export is incomplete.');
    const exported = JSON.parse(readFileSync(exportedManifest, 'utf8'));
    if (freshManifestDigest(exported) !== plan.manifestSha256)
      fail('Exported v4 manifest changed during build.');
    const oldManifest = join(outputRoot, 'data/frontend-manifest.json');
    if (existsSync(oldManifest)) rmSync(oldManifest);
    const files = walk(outputRoot).sort();
    const contentSha256 = sha256(files.map(name => `${name}\0${sha256(readFileSync(join(outputRoot, name)))}\n`).join(''));
    const release = { schemaVersion: 1, kind: `fresh-v${version}-product-static-candidate`, chainId: 56,
      ...plan, frontendSourceHead, contentSha256, fileCount: files.length,
      legacyManifestIncluded: false, activationAllowed: false };
    writeFileSync(join(outputRoot, 'fresh-product-release.json'), `${JSON.stringify(release, null, 2)}\n`,
      { flag: 'wx', mode: 0o644 });
    const destination = resolve(outputDir);
    const parent = realpathSync(dirname(destination));
    if (parent !== resolve(dirname(destination)) || existsSync(destination))
      fail('Fresh output parent must be canonical and the release directory must be new.');
    publication = mkdtempSync(join(parent, '.bemine-v4-publish-'));
    const stagedOutput = join(publication, 'release');
    cpSync(outputRoot, stagedOutput, { recursive: true, errorOnExist: true, force: false });
    if (existsSync(destination)) fail('Fresh output directory appeared during build.');
    renameSync(stagedOutput, destination);
    return release;
  } finally {
    if (publication) rmSync(publication, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4)
    fail('Usage: node scripts/build-fresh-product.mjs /absolute/reviewed-fresh-manifest.json /absolute/fresh-activation-evidence.json');
  console.log(JSON.stringify(buildFreshProduct(process.argv[2], process.argv[3]), null, 2));
}

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFreshProduct } from '../../../web/scripts/build-fresh-product.mjs';
import { packageFreshProductBackend } from '../../scripts/package-fresh-console.mjs';
import { verifyFreshReleasePair } from './verify-fresh-release-pair.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const deploy = join(repository, 'deploy');
const evidence = join(repository, 'docs/deployments/bsc-v4-20260930');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));

/** Builds only offline candidates from the reviewed, public mainnet evidence. */
export async function buildReviewedProductCi(output) {
  assert(isAbsolute(output) && !existsSync(output), 'A new absolute output directory is required.');
  assert.equal(realpathSync(dirname(output)), resolve(dirname(output)), 'Output parent must be canonical.');
  const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
  assert(/^[a-f0-9]{40}$/.test(sourceHead));
  assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'],
    { cwd: repository, encoding: 'utf8' }).trim(), '', 'The release checkout must be clean.');
  if (process.env.GITHUB_ACTIONS === 'true') assert.equal(process.env.GITHUB_SHA, sourceHead,
    'The attested source must be the actual workflow source commit.');
  const manifestPath = join(evidence, 'frontend-manifest.v4.json');
  const activationPath = join(evidence, 'fresh-activation.json');
  const input = {
    record: json(join(evidence, 'stage1-record.original.json')),
    bundle: json(join(deploy, 'public/deployment-artifacts.json')),
    activation: json(activationPath), manifest: json(manifestPath),
    expectedGasWallet: '0xA285d1933e32b5990625aC1F5BEa205Cf2606619',
    runtimeReleaseId: `v4-product-${sourceHead.slice(0, 12)}`,
    productReleaseId: `v4-product-${sourceHead.slice(0, 12)}`,
    keeperStateRoot: '/var/lib/pinkuang-v4-signer/keeper',
    // Used only to validate the disabled draft. No RPC is contacted by this build.
    rpcUrl: 'https://bsc-dataseed.bnbchain.org', logsRpcUrl: 'https://bsc-dataseed.bnbchain.org',
  };
  mkdirSync(output);
  const frontendDir = join(output, 'frontend'), backendDir = join(output, 'backend');
  const frontend = buildFreshProduct(manifestPath, activationPath,
    { outputDir: frontendDir, publicOrigin: 'https://bemine.cc.cd' });
  const backend = await packageFreshProductBackend({ deployDir: deploy, outDir: backendDir,
    sourceHead, cutoverInput: input });
  const pair = verifyFreshReleasePair({ frontendDir, backendDir, cutoverInput: input,
    expectedSourceCommit: input.record.sourceCommit, expectedSourceHead: sourceHead,
    expectedFrontendContentSha256: frontend.contentSha256,
    expectedBackendReleaseSha256: backend.manifestSha256 });
  // These digests become independent release pins only AFTER GitHub attests
  // the archives and the consumer verifies the expected workflow and commit.
  const archives = {};
  for (const [name, directory] of [['frontend.tar.gz', frontendDir], ['backend.tar.gz', backendDir]]) {
    execFileSync('tar', ['-C', directory, '-czf', join(output, name), '.']);
    const bytes = readFileSync(join(output, name));
    archives[name] = { sha256: sha256(bytes), bytes: bytes.length };
  }
  const inputFiles = ['package-lock.json', 'deploy/package-lock.json', 'web/pnpm-lock.yaml',
    'docs/deployments/bsc-v4-20260930/stage1-record.original.json',
    'docs/deployments/bsc-v4-20260930/fresh-activation.json',
    'docs/deployments/bsc-v4-20260930/frontend-manifest.v4.json'];
  const result = { schemaVersion: 1, kind: 'reviewed-v4-product-ci-candidate',
    sourceHead, genesisSourceCommit: input.record.sourceCommit,
    publicOrigin: 'https://bemine.cc.cd', basePath: '/bemine-v4', activationAllowed: false,
    command: 'node deploy/ops/v4/build-reviewed-product-ci.mjs --out <new-directory>',
    inputs: Object.fromEntries(inputFiles.map(name => [name, sha256(readFileSync(join(repository, name)))])),
    archives, releasePair: pair.releasePair,
    caveat: 'Build provenance does not authorize signing, runtime cutover or funds operations.' };
  writeFileSync(join(output, 'build-summary.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert(process.argv.length === 4 && process.argv[2] === '--out',
      'Usage: node build-reviewed-product-ci.mjs --out <new-absolute-directory>');
    console.log(JSON.stringify(await buildReviewedProductCi(process.argv[3]), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

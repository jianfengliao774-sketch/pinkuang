import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getAddress } from 'ethers';
import { ARTIFACT_DIGEST } from '../lib/chain-client.mjs';
import { FRESH_ADMIN_ONE, FRESH_ADMIN_TWO, FRESH_DEPLOYER, FRESH_GAS_WALLET } from '../../deploy/shared/fresh-roles.mjs';
import { buildFreshProduct, prepareFreshProductBuild, reviewedSourceHead,
  validateFreshProductOrigin, verifyFreshBuildEvidence } from './build-fresh-product.mjs';

const address = n => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const names = ['factory', 'shareMarket', 'lens', 'beacon', 'timelock', 'portfolioFactory',
  'portfolioMarket', 'portfolioBeacon', 'portfolioImplementation', 'portfolioFactoryImplementation'];
const activationSteps = ['deployAuthority', 'coreOperator', 'coreTreasury', 'budgetOperator',
  'budgetTreasury', 'coreOwner', 'budgetOwner'];

function fixture() {
  const authority = { address: address(30), administratorOne: FRESH_ADMIN_ONE,
    administratorTwo: FRESH_ADMIN_TWO, gasWallet: FRESH_GAS_WALLET,
    codehash: hash(99), deploymentTxHash: hash(60) };
  const manifest = { schemaVersion: 1, kind: 'integrated-v2', chainId: 56,
    ...Object.fromEntries(names.map((name, index) => [name, address(10 + index)])),
    codehash: Object.fromEntries(names.map(name => [name, hash(50)])),
    authority: authority.address, gasWallet: authority.gasWallet, freshAuthority: authority,
    deployment: { txHash: hash(40), blockNumber: 90, blockHash: hash(41) },
    artifactDigest: ARTIFACT_DIGEST, sourceCommit: 'a'.repeat(40),
    verifiedAt: '2026-09-29T00:00:00.000Z', verifiedBlockNumber: 100,
    verifiedBlockHash: hash(107) };
  const steps = activationSteps.map((id, index) => ({ id,
    txHash: index === 0 ? authority.deploymentTxHash : hash(60 + index),
    blockNumber: 94 + index, blockHash: index === 6 ? hash(107) : hash(101 + index) }));
  const evidence = { schemaVersion: 1, kind: 'fresh-authority', chainId: 56,
    deployer: FRESH_DEPLOYER,
    deploymentId: 'fresh-build-test', genesisArtifactDigest: ARTIFACT_DIGEST,
    authority: { address: authority.address, deploymentTxHash: authority.deploymentTxHash,
      administratorOne: FRESH_ADMIN_ONE, administratorTwo: FRESH_ADMIN_TWO,
      gasWallet: FRESH_GAS_WALLET }, steps, verifiedAt: '2026-09-29T01:00:00.000Z' };
  return { manifest, evidence };
}

function temporaryRepository() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bemine-v4-isolation-test-')));
  const input = realpathSync(mkdtempSync(join(tmpdir(), 'bemine-v4-input-test-')));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Build Source Test');
  git('config', 'user.email', 'build-source@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, 'web/public/data'), { recursive: true });
  writeFileSync(join(root, 'web/.gitignore'), 'out/\nout-v4/\n');
  writeFileSync(join(root, 'web/public/data/frontend-manifest.json'), '{"old":"site"}\n');
  writeFileSync(join(root, 'web/page.mjs'), 'export const page = true;\n');
  git('add', '.');
  git('commit', '-qm', 'reviewed source');
  mkdirSync(join(root, 'web/out'), { recursive: true });
  writeFileSync(join(root, 'web/out/old-site.txt'), 'unchanged\n');
  const { manifest, evidence } = fixture();
  const manifestPath = join(input, 'manifest.json');
  const evidencePath = join(input, 'evidence.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(evidencePath, JSON.stringify(evidence));
  return { root, input, git, manifest, evidence, manifestPath, evidencePath,
    outputDir: join(root, 'web/out-v4'),
    dispose: () => { rmSync(root, { recursive: true, force: true });
      rmSync(input, { recursive: true, force: true }); } };
}

test('v4 product origin defaults to the existing site and keeps the protected console separate', () => {
  const { manifest } = fixture();
  const legacy = prepareFreshProductBuild(manifest);
  assert.equal(validateFreshProductOrigin(), 'https://tapeout.cc.cd');
  assert.equal(legacy.publicUrl, 'https://tapeout.cc.cd/bemine-v4/');
  const product = prepareFreshProductBuild(manifest, { publicOrigin: 'https://bemine.cc.cd' });
  assert.equal(product.publicOrigin, 'https://bemine.cc.cd');
  assert.equal(product.publicUrl, 'https://bemine.cc.cd/bemine-v4/');
  assert.equal(product.basePath, legacy.basePath);
  assert.equal(product.manifestSha256, legacy.manifestSha256);
  assert.equal(product.deployConsoleUrl, 'https://tapeout.cc.cd/pinkuang-deploy-v4/');
});

for (const value of ['', null, {}, 'http://bemine.cc.cd', '//bemine.cc.cd', 'https://bemine.cc.cd/',
  'https://bemine.cc.cd/bemine-v4', 'https://bemine.cc.cd?other=1', 'https://bemine.cc.cd#other',
  'https://user@bemine.cc.cd', 'https://user:password@bemine.cc.cd', 'https://BEMINE.cc.cd',
  ' https://bemine.cc.cd', 'https://bemine.cc.cd\n', 'https://bemine.cc.cd:443',
  'https://bemine.cc.cd\\other', 'https://bemine.cc.cd?', 'https://bemine.cc.cd#']) {
  test(`v4 product origin rejects non-canonical value ${JSON.stringify(value)}`, () => {
    assert.throws(() => validateFreshProductOrigin(value), /exact HTTPS origin/);
  });
}

test('v4 build rejects uncommitted imports outside web', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bemine-v4-build-source-')));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.name', 'Build Source Test');
    git('config', 'user.email', 'build-source@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    mkdirSync(join(root, 'web'), { recursive: true });
    mkdirSync(join(root, 'deploy/shared'), { recursive: true });
    writeFileSync(join(root, 'web/page.mjs'), 'export const page = true;\n');
    writeFileSync(join(root, 'deploy/shared/authority-typed.mjs'), 'export const type = 1;\n');
    git('add', '.');
    git('commit', '-qm', 'reviewed source');
    assert.equal(reviewedSourceHead(root), git('rev-parse', 'HEAD'));
    writeFileSync(join(root, 'deploy/shared/authority-typed.mjs'), 'export const type = 2;\n');
    assert.throws(() => reviewedSourceHead(root), /Commit reviewed repository source/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('v4 production build binds public roles and all activation evidence to the manifest', () => {
  const { manifest, evidence } = fixture();
  assert.equal(verifyFreshBuildEvidence(manifest, evidence).factory, manifest.factory);
  assert.throws(() => verifyFreshBuildEvidence(manifest, { ...evidence, deployer: address(44) }),
    /activation evidence differs/);
  assert.throws(() => verifyFreshBuildEvidence({ ...manifest,
    freshAuthority: { ...manifest.freshAuthority, administratorOne: address(42) } }, evidence), /roles differ/);
  assert.throws(() => verifyFreshBuildEvidence(manifest, { ...evidence,
    authority: { ...evidence.authority, gasWallet: address(43) } }), /activation evidence differs/);
  assert.throws(() => verifyFreshBuildEvidence(manifest, { ...evidence,
    steps: evidence.steps.map((step, index) => index === 6 ? { ...step, blockHash: hash(200) } : step) }),
  /pinned manifest block/);
});

for (const configuredOrigin of [undefined, 'https://bemine.cc.cd']) {
test(`v4 isolated build binds ${configuredOrigin ?? 'default'} product origin without changing the old site`, () => {
  const scenario = temporaryRepository();
  const previousOrigin = process.env.BEMINE_FRESH_PRODUCT_ORIGIN;
  const expectedOrigin = configuredOrigin ?? 'https://tapeout.cc.cd';
  let isolatedWeb;
  try {
    if (configuredOrigin === undefined) delete process.env.BEMINE_FRESH_PRODUCT_ORIGIN;
    else process.env.BEMINE_FRESH_PRODUCT_ORIGIN = configuredOrigin;
    const run = (_command, args, options) => {
      isolatedWeb = options.cwd;
      assert.equal(options.env.NEXT_PUBLIC_BASE_PATH, '/bemine-v4');
      assert.equal(options.env.NEXT_PUBLIC_BEMINE_PUBLIC_ORIGIN, expectedOrigin);
      assert.equal(options.env.NEXT_PUBLIC_BEMINE_PUBLIC_URL, `${expectedOrigin}/bemine-v4/`);
      assert.equal(options.env.NEXT_PUBLIC_DEPLOY_CONSOLE_URL, 'https://tapeout.cc.cd/pinkuang-deploy-v4/');
      assert.notEqual(isolatedWeb, join(scenario.root, 'web'));
      assert.equal(execFileSync('git', ['rev-parse', 'HEAD'],
        { cwd: isolatedWeb, encoding: 'utf8' }).trim(), scenario.git('rev-parse', 'HEAD'));
      assert.equal(readFileSync(join(scenario.root, 'web/public/data/frontend-manifest.json'), 'utf8'),
        '{"old":"site"}\n');
      if (args[0] === 'node_modules/next/dist/bin/next') {
        const exported = join(isolatedWeb, 'out');
        mkdirSync(join(exported, 'data'), { recursive: true });
        writeFileSync(join(exported, 'index.html'), '<html>fresh</html>');
        copyFileSync(join(isolatedWeb, 'public/data/frontend-manifest.v4.json'),
          join(exported, 'data/frontend-manifest.v4.json'));
        copyFileSync(join(isolatedWeb, 'public/data/frontend-manifest.json'),
          join(exported, 'data/frontend-manifest.json'));
      }
      return { status: 0 };
    };
    const release = buildFreshProduct(scenario.manifestPath, scenario.evidencePath,
      { run, repositoryDir: scenario.root, outputDir: scenario.outputDir });
    assert.equal(release.productFamily, 'fresh-v4');
    assert.equal(release.publicOrigin, expectedOrigin);
    assert.equal(release.publicUrl, `${expectedOrigin}/bemine-v4/`);
    assert.equal(release.deployConsoleUrl, 'https://tapeout.cc.cd/pinkuang-deploy-v4/');
    assert.equal(release.activationAllowed, false);
    assert.equal(release.frontendSourceHead, scenario.git('rev-parse', 'HEAD'));
    assert.equal(readFileSync(join(scenario.root, 'web/out/old-site.txt'), 'utf8'), 'unchanged\n');
    assert.equal(readFileSync(join(scenario.root, 'web/public/data/frontend-manifest.json'), 'utf8'),
      '{"old":"site"}\n');
    assert.equal(readFileSync(join(scenario.outputDir, 'index.html'), 'utf8'), '<html>fresh</html>');
    assert.equal(existsSync(join(scenario.outputDir, 'data/frontend-manifest.json')), false);
    assert.equal(existsSync(join(isolatedWeb, 'public/data/frontend-manifest.v4.json')), false);
  } finally {
    if (previousOrigin === undefined) delete process.env.BEMINE_FRESH_PRODUCT_ORIGIN;
    else process.env.BEMINE_FRESH_PRODUCT_ORIGIN = previousOrigin;
    scenario.dispose();
  }
});
}

test('failed v4 build leaves the old site and new publication path untouched', () => {
  const scenario = temporaryRepository();
  let isolatedWeb;
  try {
    const run = (_command, args, options) => {
      isolatedWeb = options.cwd;
      return { status: args[0] === 'node_modules/next/dist/bin/next' ? 1 : 0 };
    };
    assert.throws(() => buildFreshProduct(scenario.manifestPath, scenario.evidencePath,
      { run, repositoryDir: scenario.root, outputDir: scenario.outputDir }), /v4 product build failed/);
    assert.equal(readFileSync(join(scenario.root, 'web/public/data/frontend-manifest.json'), 'utf8'),
      '{"old":"site"}\n');
    assert.equal(readFileSync(join(scenario.root, 'web/out/old-site.txt'), 'utf8'), 'unchanged\n');
    assert.equal(existsSync(scenario.outputDir), false);
    assert.equal(existsSync(isolatedWeb), false);
  } finally { scenario.dispose(); }
});

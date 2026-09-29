import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import trustedGenesisManifest from '../../web/public/data/frontend-manifest.json';
import freshCandidate from '../public/deployment-artifacts.json';
import { artifactDigest, type ArtifactBundle } from './deployment';
import { checkUpgradeExecutionRelease, initialUpgradeExecutionRelease,
  requireUpgradeExecutionRelease, type UpgradeReleaseInputs } from './upgrade-release';
import type { WalletProvider } from './wallet';
import type { IntegratedProposerBootstrapPlan, IntegratedUpgradePlan } from '../shared/integrated-upgrade-plan.mjs';

const origin = 'https://tapeout.cc.cd';
const graphBlock = trustedGenesisManifest.deployment.blockNumber + 100;
const blockHash = `0x${'a'.repeat(64)}`;
const planId = `0x${'b'.repeat(64)}`;
const bootstrapId = `0x${'c'.repeat(64)}`;
const genesisBytes = readFileSync(new URL('../../web/public/data/frontend-manifest.json', import.meta.url));
// Public bytes from the separately reviewed v2 static export and its candidate bundle.
// Fresh web/contract builds change web/out and public/deployment-artifacts.json.
const homeBytes = gunzipSync(readFileSync(new URL('./fixtures/upgrade-release/home.html.gz', import.meta.url)));
const appBytes = gunzipSync(readFileSync(new URL('./fixtures/upgrade-release/app-page.js.gz', import.meta.url)));
const artifactBytes = gunzipSync(readFileSync(new URL('./fixtures/upgrade-release/candidate-artifacts.json.gz', import.meta.url)));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256(homeBytes), 'e152a7eceb5d6e6b1418626f722d2c8a36e17aaa26229b6c96e912040086069b');
assert.equal(sha256(appBytes), '6b4f68e294d43409decdeabed27b896643c7855bc5f9a2c799eddb0b62d52a8d');
assert.equal(sha256(artifactBytes), 'f8211247b067ad941442b6f5dbe658c01a27bb248519af6a04b6416a89d43e7f');
const bundle = JSON.parse(artifactBytes.toString()) as ArtifactBundle;
const digest = artifactDigest(bundle);
assert.equal(digest, '0x328f8f9323c925551bddae687601594b76d073c96bf5946e3bf142516dfacc99');
(globalThis as Record<string, unknown>).__DEPLOYMENT_ARTIFACT_DIGEST__ = digest;
const appRelative = homeBytes.toString().match(/\/bemine-v2\/_next\/static\/chunks\/app\/page-[\w-]+\.js/)?.[0];
assert.ok(appRelative, 'Frozen product export must contain its unique app page chunk');
const appScript = `${origin}${appRelative}`;
assert.equal(appRelative, '/bemine-v2/_next/static/chunks/app/page-e3de400dd67b76a4.js');

function fixture() {
  const graph = {
    status: 'verified', chainId: 56, stage: 'genesis', operationId: null,
    artifactDigest: trustedGenesisManifest.artifactDigest,
    genesisArtifactDigest: trustedGenesisManifest.artifactDigest, upgradeArtifactDigest: digest,
    reviewedUpgradeOperationId: planId, reviewedBootstrapOperationId: bootstrapId,
    snapshotAgeMs: 500, verifiedBlockNumber: graphBlock, verifiedBlockHash: blockHash,
    stageActivationBlock: trustedGenesisManifest.deployment.blockNumber,
    stageActivationHash: trustedGenesisManifest.deployment.blockHash,
    factory: trustedGenesisManifest.factory, portfolioFactory: trustedGenesisManifest.portfolioFactory,
    manifest: trustedGenesisManifest,
  };
  const responses = new Map<string, {status: number; type: string; body: string | Uint8Array}>([
    [`${origin}/pinkuang-deploy-v2/api/journal/product-graph`,
      {status:200,type:'application/json',body:JSON.stringify(graph)}],
    [`${origin}/pinkuang-deploy-v2/deployment-artifacts.json`,
      {status:200,type:'application/json',body:artifactBytes}],
    [`${origin}/bemine-v2/data/frontend-manifest.json`,
      {status:200,type:'application/json',body:genesisBytes}],
    [`${origin}/bemine-v2/`,
      {status:200,type:'text/html',body:homeBytes}],
    [appScript,
      {status:200,type:'application/javascript',body:appBytes}],
  ]);
  const requests: Array<{url: string; init?: RequestInit}> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({url:String(url),init});
    const row=responses.get(String(url));
    if (!row) throw new Error('Unexpected URL: '+String(url));
    return new Response(row.body, {status:row.status,headers:{'Content-Type':row.type}});
  }) as typeof fetch;
  const walletReads: string[] = [];
  const wallet={request:async ({method}: {method:string}) => {
    walletReads.push(method);
    if (method==='eth_chainId') return '0x38';
    if (method==='eth_blockNumber') return `0x${(graphBlock+20).toString(16)}`;
    if (method==='eth_getBlockByNumber') return {number:`0x${graphBlock.toString(16)}`,hash:blockHash};
    throw new Error('Unexpected wallet method');
  }} as WalletProvider;
  const input:UpgradeReleaseInputs={origin,fetcher,wallet,candidateBundle:bundle,candidateDigest:digest,
    plan:{operationId:planId} as IntegratedUpgradePlan,
    bootstrapPlan:{operationId:bootstrapId} as IntegratedProposerBootstrapPlan};
  return {input,responses,requests,walletReads,graph};
}

test('the retired v2 Stage0 gate rejects its exact historical release before wallet access', async () => {
  const f=fixture();
  assert.equal(initialUpgradeExecutionRelease.ready,false);
  const checked=await checkUpgradeExecutionRelease(f.input);
  assert.equal(checked.ready,false);
  assert.match(checked.reason,/缺少或错误的构建产物：FreshPoolFactory/);
  assert.deepEqual(f.walletReads,[]);
  assert.equal(f.requests.length,4);
  assert.ok(f.requests.every(request=>request.init?.cache==='no-store' && request.init?.redirect==='error'));
  await assert.rejects(requireUpgradeExecutionRelease(f.input),/FreshPoolFactory/);
});

test('unavailable or untrusted graph responses remain closed before artifact validation', async () => {
  for (const status of [401,503]) {
    const f=fixture();f.responses.get(`${origin}/pinkuang-deploy-v2/api/journal/product-graph`)!.status=status;
    const checked=await checkUpgradeExecutionRelease(f.input);
    assert.equal(checked.ready,false);
    assert.match(checked.reason,/生产发布证据不可用/);
    await assert.rejects(requireUpgradeExecutionRelease(f.input),/生产发布证据不可用/);
  }
});

test('the current fresh v4 candidate cannot pass the retired v2 release gate', async () => {
  const f = fixture();
  const fresh = freshCandidate as ArtifactBundle;
  const freshDigest = artifactDigest(fresh);
  assert.notEqual(freshDigest, digest);
  f.input.candidateBundle = fresh;
  f.input.candidateDigest = freshDigest;
  f.responses.get(`${origin}/pinkuang-deploy-v2/deployment-artifacts.json`)!.body = JSON.stringify(fresh);
  assert.match((await checkUpgradeExecutionRelease(f.input)).reason, /部署产物与页面独立编译的源码摘要不一致/);
  assert.deepEqual(f.walletReads,[]);
});

test('altering either frozen product file breaks its pinned hash; bad genesis manifest and runtime fail closed', async () => {
  assert.notEqual(sha256(Buffer.concat([homeBytes,Buffer.from('<!-- changed -->')])),
    'e152a7eceb5d6e6b1418626f722d2c8a36e17aaa26229b6c96e912040086069b');
  assert.notEqual(sha256(Buffer.concat([appBytes,Buffer.from('// changed')])),
    '6b4f68e294d43409decdeabed27b896643c7855bc5f9a2c799eddb0b62d52a8d');
  const changed=fixture();changed.responses.get(`${origin}/bemine-v2/data/frontend-manifest.json`)!.body='{}';
  assert.match((await checkUpgradeExecutionRelease(changed.input)).reason,/清单/);
  const runtime=fixture();runtime.responses.get(`${origin}/pinkuang-deploy-v2/deployment-artifacts.json`)!.body='{}';
  assert.equal((await checkUpgradeExecutionRelease(runtime.input)).ready,false);
});

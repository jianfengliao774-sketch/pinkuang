import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import trustedGenesisManifest from '../../web/public/data/frontend-manifest.json';
import candidate from '../public/deployment-artifacts.json';
import { artifactDigest, type ArtifactBundle } from './deployment';
import { checkUpgradeExecutionRelease, initialUpgradeExecutionRelease,
  requireUpgradeExecutionRelease, type UpgradeReleaseInputs } from './upgrade-release';
import type { WalletProvider } from './wallet';
import type { IntegratedProposerBootstrapPlan, IntegratedUpgradePlan } from '../shared/integrated-upgrade-plan.mjs';

const origin = 'https://tapeout.cc.cd';
const bundle = candidate as ArtifactBundle;
const digest = artifactDigest(bundle);
(globalThis as Record<string, unknown>).__DEPLOYMENT_ARTIFACT_DIGEST__ = digest;
const graphBlock = trustedGenesisManifest.deployment.blockNumber + 100;
const blockHash = `0x${'a'.repeat(64)}`;
const planId = `0x${'b'.repeat(64)}`;
const bootstrapId = `0x${'c'.repeat(64)}`;
const genesisBytes = readFileSync(new URL('../../web/public/data/frontend-manifest.json', import.meta.url));
const artifactBytes = readFileSync(new URL('../public/deployment-artifacts.json', import.meta.url));
const homeBytes = readFileSync(new URL('../../web/out/index.html', import.meta.url));
const appRelative = homeBytes.toString().match(/\/bemine-v2\/_next\/static\/chunks\/app\/page-[\w-]+\.js/)?.[0];
assert.ok(appRelative, 'Frozen product export must contain its unique app page chunk');
const appScript = `${origin}${appRelative}`;
const appBytes = readFileSync(new URL(`../../web/out/${appRelative.slice('/bemine-v2/'.length)}`, import.meta.url));

function fixture() {
  const graph = {
    status: 'verified', chainId: 56, stage: 'genesis', operationalReady: false, operationId: null,
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

test('Stage0 release gate verifies current runtime, product bytes, reviewed plans and independent wallet chain', async () => {
  const f=fixture();
  assert.equal(initialUpgradeExecutionRelease.ready,false);
  const checked=await checkUpgradeExecutionRelease(f.input);
  assert.equal(checked.ready,true,checked.reason);
  assert.equal(checked.verifiedBlockNumber,graphBlock);
  assert.deepEqual(f.walletReads,['eth_chainId','eth_blockNumber','eth_getBlockByNumber']);
  assert.equal(f.requests.length,5);
  assert.ok(f.requests.every(request=>request.init?.cache==='no-store' && request.init?.redirect==='error'));
  await assert.doesNotReject(requireUpgradeExecutionRelease(f.input));
});

test('missing or mismatched server-reviewed operation IDs and old runtime errors remain closed', async () => {
  for (const changed of [
    {reviewedUpgradeOperationId:undefined}, {reviewedUpgradeOperationId:`0x${'d'.repeat(64)}`},
    {reviewedBootstrapOperationId:undefined}, {reviewedBootstrapOperationId:`0x${'d'.repeat(64)}`},
  ]) {
    const f=fixture();
    f.responses.get(`${origin}/pinkuang-deploy-v2/api/journal/product-graph`)!.body=JSON.stringify({...f.graph,...changed});
    assert.equal((await checkUpgradeExecutionRelease(f.input)).ready,false);
  }
  for (const status of [401,503]) {
    const f=fixture();f.responses.get(`${origin}/pinkuang-deploy-v2/api/journal/product-graph`)!.status=status;
    assert.equal((await checkUpgradeExecutionRelease(f.input)).ready,false);
    await assert.rejects(requireUpgradeExecutionRelease(f.input),/生产发布证据不可用/);
  }
});

test('old product JS, changed genesis manifest, and wrong candidate runtime all block Stage4', async () => {
  const old=fixture();old.responses.get(appScript)!.body=`const genesis='${trustedGenesisManifest.artifactDigest}'`;
  assert.match((await checkUpgradeExecutionRelease(old.input)).reason,/应用脚本/);
  const changed=fixture();changed.responses.get(`${origin}/bemine-v2/data/frontend-manifest.json`)!.body='{}';
  assert.match((await checkUpgradeExecutionRelease(changed.input)).reason,/清单/);
  const runtime=fixture();runtime.responses.get(`${origin}/pinkuang-deploy-v2/deployment-artifacts.json`)!.body='{}';
  assert.equal((await checkUpgradeExecutionRelease(runtime.input)).ready,false);
});

test('stale or different chain and a post-Stage0 graph block signatures', async () => {
  for (const changed of [
    {snapshotAgeMs:20_001}, {stage:'code-upgraded'}, {verifiedBlockHash:`0x${'d'.repeat(64)}`},
  ]) {
    const f=fixture();f.responses.get(`${origin}/pinkuang-deploy-v2/api/journal/product-graph`)!.body=JSON.stringify({...f.graph,...changed});
    assert.equal((await checkUpgradeExecutionRelease(f.input)).ready,false);
  }
  const f=fixture();f.input.wallet={request:async ({method}: {method:string}) =>
    method==='eth_chainId'?'0x38':method==='eth_blockNumber'?`0x${(graphBlock+133).toString(16)}`:
      {number:`0x${graphBlock.toString(16)}`,hash:blockHash}} as WalletProvider;
  assert.match((await checkUpgradeExecutionRelease(f.input)).reason,/已过期/);
  const fork=fixture();fork.input.wallet={request:async ({method}: {method:string}) =>
    method==='eth_chainId'?'0x38':method==='eth_blockNumber'?`0x${(graphBlock+20).toString(16)}`:
      {number:`0x${graphBlock.toString(16)}`,hash:`0x${'e'.repeat(64)}`}} as WalletProvider;
  assert.match((await checkUpgradeExecutionRelease(fork.input)).reason,/规范链/);
});

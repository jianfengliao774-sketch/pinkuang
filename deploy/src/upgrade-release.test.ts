import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import trustedGenesisManifest from '../../web/public/data/frontend-manifest.json';
import freshCandidate from '../public/deployment-artifacts.json';
import genesisBundle from '../public/upgrade-genesis/genesis-artifacts.json';
import { artifactDigest, type ArtifactBundle } from './deployment';
import { checkUpgradeExecutionRelease, initialUpgradeExecutionRelease,
  requireUpgradeExecutionRelease, checkFreshActiveUpgradeExecutionRelease,
  requireFreshActiveUpgradeExecutionRelease, type UpgradeReleaseInputs } from './upgrade-release';
import type { WalletProvider } from './wallet';
import type { IntegratedProposerBootstrapPlan, IntegratedUpgradePlan } from '../shared/integrated-upgrade-plan.mjs';

const productOrigin = 'https://bemine.cc.cd';
const origin = productOrigin;
const productBase = '/bemine-v5';
const graphUrl = `${productOrigin}${productBase}/api/journal/product-graph`;
const runtimeUrl = `${productOrigin}/pinkuang-upgrade-v5/deployment-artifacts.json`;
const manifestUrl = `${productOrigin}${productBase}/data/frontend-manifest.v5.json`;
const homeUrl = `${productOrigin}${productBase}/`;
const releaseUrl = `${productOrigin}${productBase}/fresh-product-release.json`;
const graphBlock = trustedGenesisManifest.verifiedBlockNumber + 100;
const blockHash = `0x${'a'.repeat(64)}`;
const planId = `0x${'b'.repeat(64)}`;
const bootstrapId = `0x${'c'.repeat(64)}`;
const manifestBytes = Buffer.from(`${JSON.stringify(trustedGenesisManifest, null, 2)}\n`);
const homeBytes = gunzipSync(readFileSync(new URL('./fixtures/upgrade-release-v5/home.html.gz', import.meta.url)));
const appBytes = gunzipSync(readFileSync(new URL('./fixtures/upgrade-release-v5/app-page.js.gz', import.meta.url)));
const releaseBytes = gunzipSync(readFileSync(new URL('./fixtures/upgrade-release-v5/product-release.json.gz', import.meta.url)));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256(manifestBytes), '0697a2d36e1056192c357c4cc82dc3e68f4993e79776ebe9257f59772dd950df');
assert.equal(sha256(homeBytes), '7ac16fe9100938cbf7711722bf21dbbb0e51c2e3b2bb00201ae66cd2f6ddcd4b');
assert.equal(sha256(appBytes), '0a59a3aa45bbcbaa87e4245a7566b31b84289146ad9b457472a16e07cd87dc70');
assert.equal(sha256(releaseBytes), '0be7a34dbf9c7d52a4bb172b582523ae29cbf191d04eacd48f22634e4e5923d2');
const bundle = freshCandidate as ArtifactBundle;
const digest = artifactDigest(bundle);
(globalThis as Record<string, unknown>).__DEPLOYMENT_ARTIFACT_DIGEST__ = digest;
const appRelative = homeBytes.toString().match(/\/bemine-v5\/_next\/static\/chunks\/app\/page-[\w-]+\.js/)?.[0];
assert.ok(appRelative, 'Pinned v5 homepage must contain its app page chunk');
const appScript = `${productOrigin}${appRelative}`;

function fixture() {
  const graph: Record<string, any> = {
    status: 'verified', chainId: 56, stage: 'fresh-active', operationId: null,
    artifactDigest: trustedGenesisManifest.artifactDigest,
    genesisArtifactDigest: trustedGenesisManifest.artifactDigest, upgradeArtifactDigest: null,
    reviewedUpgradeOperationId: null, reviewedBootstrapOperationId: null,
    snapshotAgeMs: 500, verifiedBlockNumber: graphBlock, verifiedBlockHash: blockHash,
    stageActivationBlock: trustedGenesisManifest.verifiedBlockNumber,
    stageActivationHash: trustedGenesisManifest.verifiedBlockHash,
    factory: trustedGenesisManifest.factory, portfolioFactory: trustedGenesisManifest.portfolioFactory,
    manifest: trustedGenesisManifest,
  };
  const responses = new Map<string, {status: number; type: string; body: string | Uint8Array}>([
    [graphUrl, {status:200,type:'application/json',body:JSON.stringify(graph)}],
    [runtimeUrl, {status:200,type:'application/json',body:JSON.stringify(bundle)}],
    [manifestUrl, {status:200,type:'application/json',body:manifestBytes}],
    [homeUrl, {status:200,type:'text/html',body:homeBytes}],
    [releaseUrl, {status:200,type:'application/json',body:releaseBytes}],
    [appScript, {status:200,type:'application/javascript',body:appBytes}],
  ]);
  const requests: Array<{url:string; init?:RequestInit}> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({url:String(url),init});
    const row=responses.get(String(url));
    if (!row) throw new Error('Unexpected URL: '+String(url));
    return new Response(row.body, {status:row.status,headers:{'Content-Type':row.type}});
  }) as typeof fetch;
  const walletReads: string[] = [];
  const wallet={request:async ({method,params}: {method:string;params?:unknown[]}) => {
    walletReads.push(method);
    if (method==='eth_chainId') return '0x38';
    if (method==='eth_blockNumber') return `0x${(graphBlock+20).toString(16)}`;
    if (method==='eth_getBlockByNumber') return {number:(params as string[])[0],hash:blockHash};
    throw new Error('Unexpected wallet method');
  }} as WalletProvider;
  const input:UpgradeReleaseInputs={origin,fetcher,wallet,candidateBundle:bundle,candidateDigest:digest,
    plan:{operationId:planId} as IntegratedUpgradePlan,
    bootstrapPlan:{operationId:bootstrapId} as IntegratedProposerBootstrapPlan};
  return {input,responses,requests,walletReads,graph};
}

test('the current BEMine v5 site and active genesis authorize only the separately pinned candidate', async () => {
  const f=fixture();
  assert.equal(initialUpgradeExecutionRelease.ready,false);
  const checked=await checkUpgradeExecutionRelease(f.input);
  assert.deepEqual(checked,{ready:true,reason:'正式 v5 网站、主网旧图与独立升级产物已核验。',verifiedBlockNumber:graphBlock});
  assert.deepEqual(f.walletReads,['eth_chainId','eth_blockNumber','eth_getBlockByNumber']);
  assert.equal(f.requests.length,6);
  assert.ok(f.requests.every(request=>request.init?.cache==='no-store' && request.init?.redirect==='error'));
  assert.ok(f.requests.some(request=>request.url===graphUrl));
  assert.ok(f.requests.some(request=>request.url===runtimeUrl));
  assert.ok(!f.requests.some(request=>request.url.includes('pinkuang-deploy-v2')||request.url.includes('bemine-v2')));
  await requireUpgradeExecutionRelease(f.input);
});

test('unavailable or untrusted graph responses remain closed before wallet access', async () => {
  for (const status of [401,503]) {
    const f=fixture(); f.responses.get(graphUrl)!.status=status;
    const checked=await checkUpgradeExecutionRelease(f.input);
    assert.equal(checked.ready,false);
    assert.match(checked.reason,/正式发布证据不可用/);
    assert.deepEqual(f.walletReads,[]);
    await assert.rejects(requireUpgradeExecutionRelease(f.input),/正式发布证据不可用/);
  }
  const badManifest=fixture(); badManifest.responses.get(manifestUrl)!.body='{}';
  assert.match((await checkUpgradeExecutionRelease(badManifest.input)).reason,/固定的主网旧图/);
  const badRelease=fixture(); badRelease.responses.get(releaseUrl)!.body='{}';
  assert.match((await checkUpgradeExecutionRelease(badRelease.input)).reason,/正式 v5 网站发布记录/);
});

test('wrong candidate bytes, a changed homepage or script, and a conflicting server plan fail closed', async () => {
  const stale=fixture(); stale.responses.get(runtimeUrl)!.body=JSON.stringify(genesisBundle);
  assert.match((await checkUpgradeExecutionRelease(stale.input)).reason,/部署产物与页面独立编译/);
  const changedHome=fixture(); changedHome.responses.get(homeUrl)!.body=Buffer.concat([homeBytes,Buffer.from('x')]);
  assert.match((await checkUpgradeExecutionRelease(changedHome.input)).reason,/首页不是已核验/);
  const changedApp=fixture(); changedApp.responses.get(appScript)!.body=Buffer.concat([appBytes,Buffer.from('x')]);
  assert.match((await checkUpgradeExecutionRelease(changedApp.input)).reason,/应用脚本/);
  const wrongPlan=fixture(); wrongPlan.graph.reviewedUpgradeOperationId=`0x${'d'.repeat(64)}`;
  wrongPlan.responses.get(graphUrl)!.body=JSON.stringify(wrongPlan.graph);
  assert.match((await checkUpgradeExecutionRelease(wrongPlan.input)).reason,/代码升级批次/);
  assert.deepEqual(wrongPlan.walletReads,[]);
});

test('chain stage, graph age and independent wallet canonical checks are required', async () => {
  const changed=fixture(); changed.graph.stage='code-upgraded';
  changed.responses.get(graphUrl)!.body=JSON.stringify(changed.graph);
  assert.match((await checkUpgradeExecutionRelease(changed.input)).reason,/未更改的 v5 激活状态/);
  const stale=fixture(); stale.graph.snapshotAgeMs=20_001;
  stale.responses.get(graphUrl)!.body=JSON.stringify(stale.graph);
  assert.match((await checkUpgradeExecutionRelease(stale.input)).reason,/近期最终确认区块/);
  const badWallet=fixture();
  badWallet.input.wallet={request:async ({method}: {method:string}) => method==='eth_chainId' ? '0x1'
    : method==='eth_blockNumber' ? `0x${(graphBlock+20).toString(16)}` : {number:`0x${graphBlock.toString(16)}`,hash:blockHash}} as WalletProvider;
  assert.match((await checkUpgradeExecutionRelease(badWallet.input)).reason,/钱包 RPC/);
});

test('active v5 preserves its pinned Authority and uses existing proposer roles without a bootstrap', async () => {
  const f = fixture();
  const { bootstrapPlan: _unused, ...active } = f.input;
  assert.equal((await checkFreshActiveUpgradeExecutionRelease(active)).ready, true);
  await requireFreshActiveUpgradeExecutionRelease(active);
  assert.ok(f.walletReads.every(method => !method.includes('sign') && !method.includes('send')));

  for (const key of ['address', 'codehash', 'deploymentTxHash', 'administratorOne', 'administratorTwo', 'gasWallet']) {
    const changed = fixture();
    changed.graph.manifest = structuredClone(trustedGenesisManifest);
    changed.graph.manifest.freshAuthority[key] = key === 'codehash' || key === 'deploymentTxHash'
      ? `0x${'f'.repeat(64)}` : `0x${'f'.repeat(40)}`;
    changed.responses.get(graphUrl)!.body = JSON.stringify(changed.graph);
    const { bootstrapPlan: _ignored, ...input } = changed.input;
    assert.match((await checkFreshActiveUpgradeExecutionRelease(input)).reason, /Authority/);
    assert.deepEqual(changed.walletReads, []);
  }
  const conflicting = fixture();
  conflicting.graph.reviewedBootstrapOperationId = bootstrapId;
  conflicting.responses.get(graphUrl)!.body = JSON.stringify(conflicting.graph);
  const { bootstrapPlan: _ignored, ...input } = conflicting.input;
  assert.match((await checkFreshActiveUpgradeExecutionRelease(input)).reason, /硬件钱包授权计划/);
});

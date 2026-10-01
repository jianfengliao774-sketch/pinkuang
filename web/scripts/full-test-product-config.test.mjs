import test from 'node:test';
import assert from 'node:assert/strict';
import { ARTIFACT_DIGEST } from '../lib/chain-client.mjs';
import { loadFullTestProductConfig, readCachedFullTestProductConfig, FULL_TEST_TIMINGS } from '../lib/full-test-product-config.mjs';
import { governanceAction } from '../lib/live-governance.mjs';
import { saleTimings } from '../lib/sale-timings.mjs';
import { validateManifest } from '../lib/live-config.mjs';
const address = n => `0x${n.toString(16).padStart(40, '0')}`;
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const roles = { deployer: address(101), administratorOne: address(101), administratorTwo: address(101), gasWallet: address(103) };
const root = { schemaVersion: 1, profile: 'full-test', chainId: 56, artifactDigest: ARTIFACT_DIGEST,
  roles, timings: FULL_TEST_TIMINGS, status: 'unconfigured' };
const keys = ['factory','shareMarket','lens','beacon','timelock','portfolioFactory','portfolioMarket',
  'portfolioBeacon','portfolioImplementation','portfolioFactoryImplementation'];
const manifest = { schemaVersion: 1, kind: 'integrated-v2', chainId: 56,
  ...Object.fromEntries(keys.map((name, i) => [name, address(i + 1)])),
  codehash: Object.fromEntries(keys.map(name => [name, hash(9)])), artifactDigest: ARTIFACT_DIGEST,
  sourceCommit: '1'.repeat(40), verifiedAt: '2026-10-01T00:00:00Z', verifiedBlockNumber: 2,
  deployment: { txHash: hash(1), blockHash: hash(2), blockNumber: 1 }, authority: address(11), gasWallet: roles.gasWallet,
  freshAuthority: { address: address(11), codehash: hash(3), deploymentTxHash: hash(4),
    administratorOne: roles.administratorOne, administratorTwo: roles.administratorTwo, gasWallet: roles.gasWallet } };
const load = (value, requests = []) => loadFullTestProductConfig({ origin: 'https://example.test',
  fetcher: async url => { requests.push(url); return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }); } });

test('unconfigured full test has no formal manifest fallback or RPC boot', async () => {
  const requests = []; const config = await load({ ...root, manifest }, requests);
  assert.equal(config.status, 'unconfigured'); assert.equal(config.manifest, undefined);
  assert.equal(config.deployer, roles.deployer);
  assert.deepEqual(requests, ['https://example.test/bemine-full-test/api/full-test/config']);
  assert.equal(config.deployConsoleUrl, 'https://example.test/bemine-full-test/deploy/');
});
test('a fully activated test graph binds its roles and API namespace', async () => {
  const config = await load({ ...root, status: 'ready', manifest, operationalReady: false });
  assert.equal(config.stage, 'fresh-active'); assert.equal(config.productFamily, 'fresh-v4');
  assert.equal(config.testProfile, true); assert.equal(config.operationalReady, false);
  assert.equal(config.pinnedManifest.factory, manifest.factory);
  assert.equal(config.journalBase, '/bemine-full-test/api/journal');
  await assert.rejects(load({ ...root, status: 'ready', manifest: { ...manifest, gasWallet: address(104),
    freshAuthority: { ...manifest.freshAuthority, gasWallet: address(104) } } }), /本次测试角色/);
});
test('single-admin test normalization preserves the formal two-admin validation', async()=>{
  assert.throws(()=>validateManifest(manifest,ARTIFACT_DIGEST,{singleAdministrator:false}),/重复/);
  assert.equal(validateManifest(manifest,ARTIFACT_DIGEST,{singleAdministrator:true}).freshAuthority.administratorOne,roles.deployer);
  await assert.rejects(load({...root,roles:{...roles,administratorTwo:address(102)}}),/唯一管理员/);
  await assert.rejects(load({...root,roles:{...roles,gasWallet:roles.deployer}}),/Gas 钱包须独立/);
});
test('a mismatched build or unactivated graph cannot become ready', async () => {
  await assert.rejects(load({ ...root, artifactDigest: hash(200) }), /本次测试合约构建/);
  const { freshAuthority, authority, gasWallet, ...stage1 } = manifest;
  await assert.rejects(load({ ...root, status: 'ready', manifest: stage1 }), /权限尚未绑定/);
});
test('test proposals have no hold or cooldown while formal waits and reward days stay intact', () => {
  const snapshot = { chainId: 56n, stage: 'fresh-active', displayOnly: true, testProfile: true,
    account: roles.deployer, factory: address(1), pool: address(12), shareMarket: address(2),
    state: 2n, timestamp: 100n, activatedAt: 100n, lastProposed: 100n, shares: 100n,
    activeProposalId: 0n, candidates: [], roundAnchor: null, blockNumber: null, blockHash: null };
  const action = { kind: 'propose', priceWei: '100', refPriceWei: '100', refAt: '100' };
  assert.equal(governanceAction(snapshot, roles.deployer, action).transaction.to, snapshot.pool);
  assert.throws(() => governanceAction({ ...snapshot, testProfile: false }, roles.deployer, action), /7 天/);
  assert.equal(saleTimings(snapshot).voteSeconds, 86400n);
  assert.equal(saleTimings(snapshot).listingSeconds, 604800n);
  assert.equal(saleTimings({}).holdSeconds, 604800n);
  const previousRound = { ...snapshot, roundAnchor: { endsAt: 100n, executed: false, currentFormat: true } };
  assert.doesNotThrow(() => governanceAction(previousRound, roles.deployer, action));
});


test('public test config restores display during an outage without granting transaction or automation readiness',async()=>{
  const entries = new Map();
  const storage = {getItem:key=>entries.get(key)??null,setItem:(key,value)=>entries.set(key,value),removeItem:key=>entries.delete(key)};
  const options={origin:'https://example.test',storage,now:1000000};
  await loadFullTestProductConfig({...options,fetcher:async()=>new Response(JSON.stringify({...root,status:'ready',manifest,
    operationalReady:true,transactionReady:true}),{headers:{'Content-Type':'application/json'}})});
  const cached=readCachedFullTestProductConfig({...options,now:1000001});
  assert.equal(cached.manifest.factory,manifest.factory);
  assert.equal(cached.configurationCached,true);
  assert.equal(cached.operationalReady,false);
  assert.equal(cached.transactionReady,false);
  assert.equal(readCachedFullTestProductConfig({...options,now:2800001}),null);
  assert.equal(readCachedFullTestProductConfig({...options,origin:'https://another.test'}),null);
  const key=[...entries.keys()][0],bad=JSON.parse(entries.get(key));bad.input.artifactDigest=hash(200);
  entries.set(key,JSON.stringify(bad));assert.equal(readCachedFullTestProductConfig(options),null);
});
test('live unconfigured response retires a previous display config',async()=>{
  const entries=new Map();const storage={getItem:k=>entries.get(k)??null,setItem:(k,v)=>entries.set(k,v),removeItem:k=>entries.delete(k)};
  const options={origin:'https://example.test',storage,now:1000000};
  for(const input of [{...root,status:'ready',manifest},root])
    await loadFullTestProductConfig({...options,fetcher:async()=>new Response(JSON.stringify(input),{headers:{'Content-Type':'application/json'}})});
  assert.equal(readCachedFullTestProductConfig(options),null);
});

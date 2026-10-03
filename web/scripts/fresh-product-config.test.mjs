import assert from 'node:assert/strict';
import test from 'node:test';
import { getAddress } from 'ethers';
import { ARTIFACT_DIGEST } from '../lib/chain-client.mjs';
import oldManifest from '../public/data/frontend-manifest.json' with { type: 'json' };
import { freshManifestDigest, loadFreshDisplayConfig, loadFreshLiveConfig, validateFreshManifest,
  validateFreshProductGraph } from '../lib/fresh-product-config.mjs';
import { loadProductConfig, validateCurrentProductGraph } from '../lib/product-config.mjs';
import { requireCurrentProductStage } from '../lib/live-transactions.mjs';
import { prepareFreshProductBuild } from './build-fresh-product.mjs';
import { pageDisplayKey, readDisplaySnapshot, writeDisplaySnapshot } from '../lib/display-snapshot.mjs';

const address = n => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const keys = ['factory','shareMarket','lens','beacon','timelock','portfolioFactory',
  'portfolioMarket','portfolioBeacon','portfolioImplementation','portfolioFactoryImplementation'];
const authority = { address: address(30), administratorOne: address(31),
  administratorTwo: address(32), gasWallet: address(33), codehash: hash(99), deploymentTxHash: hash(98) };
const manifest = { schemaVersion: 1, kind: 'integrated-v2', chainId: 56,
  ...Object.fromEntries(keys.map((key, index) => [key, address(index + 10)])),
  codehash: Object.fromEntries(keys.map(key => [key, hash(50)])),
  authority: authority.address, gasWallet: authority.gasWallet, freshAuthority: authority,
  deployment: { txHash: hash(40), blockNumber: 90, blockHash: hash(41) },
  artifactDigest: ARTIFACT_DIGEST, sourceCommit: 'a'.repeat(40),
  verifiedAt: '2026-09-29T00:00:00.000Z', verifiedBlockNumber: 100 };
const activationHash = hash(42);
const graph = { status: 'verified', chainId: 56, stage: 'fresh-active',
  artifactDigest: ARTIFACT_DIGEST, genesisArtifactDigest: ARTIFACT_DIGEST,
  upgradeArtifactDigest: null, operationId: null, freshFactoryVerified: true,
  verifiedBlockNumber: 102, verifiedBlockHash: hash(43),
  stageActivationBlock: 101, stageActivationHash: activationHash,
  factory: manifest.factory, portfolioFactory: manifest.portfolioFactory,
  freshAuthority: { ...authority, activationBlock: 101, activationHash },
  operationalReady: false, readMode: 'current', stale: false,
  manifest: { ...manifest, verifiedBlockNumber: 101 } };
const origin = 'https://example.test';
const response = (value, status = 200) => ({ status, ok: status >= 200 && status < 300,
  redirected: false, headers: { get: name => name === 'content-type' ? 'application/json' : null },
  text: async () => JSON.stringify(value) });

test('v4 static plan requires a reviewed fresh manifest and pins its own addresses', () => {
  const plan = prepareFreshProductBuild(manifest);
  assert.equal(plan.basePath, '/bemine-v4');
  assert.equal(plan.productFamily, 'fresh-v4');
  assert.equal(plan.manifestSha256, freshManifestDigest(manifest));
  assert.notEqual(plan.factory.toLowerCase(), oldManifest.factory.toLowerCase());
  assert.throws(() => prepareFreshProductBuild(oldManifest), { code: 'artifact_mismatch' });
  assert.throws(() => validateFreshManifest({ ...manifest, factory: address(200) }, plan.manifestSha256),
    { code: 'fresh_manifest_mismatch' });
  assert.throws(() => validateFreshManifest({ ...manifest, freshAuthority: undefined },
    freshManifestDigest({ ...manifest, freshAuthority: undefined })), /管理员/);
});

test('v4 pre-boot local display requires its build-pinned fresh manifest and expires after 30 minutes', () => {
  const saved = new Map();
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const page = pageDisplayKey({ route: 'home', pool: null }, null);
  const pinned = validateFreshManifest(manifest, freshManifestDigest(manifest));
  const result = { catalog: { source: { chainId: 56, factory: manifest.factory,
    market: manifest.shareMarket, complete: true, unknownReason: null, indexedThrough: 100,
    indexedTimestamp: 1700000000, indexedBlockHash: hash(43) }, items: [] } };
  assert.equal(writeDisplaySnapshot(storage, pinned, page, result, { now: 1000 }), true);
  const restored = readDisplaySnapshot(storage,
    validateFreshManifest(manifest, freshManifestDigest(manifest)), page,
    { now: 1000 + 29 * 60_000, maxAgeMs: 30 * 60_000 });
  assert.equal(restored.catalog.source.readMode, 'verified_snapshot');
  assert.equal(restored.catalog.source.transactionReady, false);
  assert.equal(readDisplaySnapshot(storage, pinned, page,
    { now: 1000 + 30 * 60_000 + 1, maxAgeMs: 30 * 60_000 }), null);
  assert.throws(() => validateFreshManifest({ ...manifest, factory: address(200) }, freshManifestDigest(manifest)),
    { code: 'fresh_manifest_mismatch' });
});

test('v4 boot uses only its separate manifest, API and index path', async () => {
  const calls = [], expectedSha = freshManifestDigest(manifest);
  const fetcher = async url => {
    calls.push(url);
    if (url.endsWith('/data/frontend-manifest.v4.json')) return response(manifest);
    if (url.endsWith('/api/journal/product-graph')) return response(graph);
    throw new Error(`Unexpected request: ${url}`);
  };
  const config = await loadProductConfig({ productFamily: 'fresh-v4', origin, basePath: '/bemine-v4',
    manifestSha256: expectedSha, fetcher });
  assert.deepEqual(calls, [
    `${origin}/bemine-v4/data/frontend-manifest.v4.json`,
    `${origin}/bemine-v4/api/journal/product-graph`,
  ]);
  assert.equal(config.status, 'ready');
  assert.equal(config.factory, undefined);
  assert.equal(config.manifest.factory, manifest.factory);
  assert.equal(config.pinnedManifest.factory, manifest.factory);
  assert.equal(config.indexBaseUrl, `${origin}/bemine-v4/api/chain-index`);
  assert.equal(config.journalBase, '/bemine-v4/api/journal');
  assert.equal(validateCurrentProductGraph(graph, config).stage, 'fresh-active');
  await assert.rejects(loadFreshLiveConfig({ origin, basePath: '/bemine-v2', manifestSha256: expectedSha, fetcher }),
    { code: 'invalid_config' });
});

test('v4 refuses old genesis, altered graph, incomplete Authority and stale snapshots', async () => {
  const expectedSha = freshManifestDigest(manifest);
  const read = (staticManifest, liveGraph) => loadFreshLiveConfig({ origin, basePath: '/bemine-v4',
    manifestSha256: expectedSha, fetcher: url => response(url.endsWith('.v4.json') ? staticManifest : liveGraph) });
  await assert.rejects(read(oldManifest, graph), { code: 'fresh_manifest_mismatch' });
  for (const changed of [
    { stage: 'genesis' }, { factory: oldManifest.factory },
    { manifest: { ...graph.manifest, shareMarket: oldManifest.shareMarket } },
    { freshAuthority: { ...graph.freshAuthority, gasWallet: address(201) } },
    { readMode: 'verified_snapshot', stale: true, transactionReady: false,
      refreshing: false, snapshotAgeMs: 31 * 60 * 1000 },
  ]) await assert.rejects(read(manifest, { ...graph, ...changed }));
  const displayOnly = validateFreshProductGraph({ ...graph, readMode: 'verified_snapshot',
    stale: true, transactionReady: false, refreshing: false,
    snapshotAgeMs: 20_000 }, manifest);
  assert.equal(displayOnly.transactionReady, false);
});

test('v4 transaction precheck binds the current graph to its own pinned manifest', async () => {
  const config = await loadFreshLiveConfig({ origin, basePath: '/bemine-v4',
    manifestSha256: freshManifestDigest(manifest),
    fetcher: url => response(url.endsWith('.v4.json') ? manifest : graph) });
  const actionConfig = { ...config, ...config.manifest };
  const current = await requireCurrentProductStage(actionConfig, async () => response(graph));
  assert.equal(current.stage, 'fresh-active');
  await assert.rejects(requireCurrentProductStage(actionConfig,
    async () => response({ ...graph, factory: oldManifest.factory })),
  { code: 'product_graph' });
});

test('a recovered service or wallet session does not masquerade as a deployment change', async () => {
  const config = await loadFreshLiveConfig({ origin, basePath: '/bemine-v4',
    manifestSha256: freshManifestDigest(manifest),
    fetcher: url => response(url.endsWith('.v4.json') ? manifest : graph) });
  // The UI masks readiness while reconnecting a wallet. The current graph
  // restores it without changing any deployed address or activation proof.
  const reconnecting = { ...config, ...config.manifest, walletSessionReady: false,
    operationalReady: false, transactionReady: false };
  const recovered = { ...graph, operationalReady: true, transactionReady: true };
  const current = await requireCurrentProductStage(reconnecting, () => response(recovered));
  assert.equal(current.operationalReady, true);
  assert.equal(current.stageActivationHash, config.stageActivationHash);
  await assert.rejects(requireCurrentProductStage({ ...reconnecting, stageActivationHash: hash(999) },
    () => response(recovered)), /链上产品阶段已变化/);
});


test('v5 display and current graph stay in the v5 namespace with no v4 boot requests', async () => {
  const calls=[];
  const fetcher=async url=>{calls.push(url);return response(url.endsWith('.v5.json')?manifest:graph);};
  const options={origin,basePath:'/bemine-v5/',manifestSha256:freshManifestDigest(manifest),fetcher};
  const display=await loadFreshDisplayConfig({...options,pinnedManifest:manifest});
  assert.equal(calls.length,0);
  assert.equal(display.manifestUrl,`${origin}/bemine-v5/data/frontend-manifest.v5.json`);
  assert.equal(display.rpcUrl,`${origin}/bemine-v5/api/rpc`);
  const live=await loadFreshLiveConfig(options);
  assert.equal(live.journalBase,'/bemine-v5/api/journal');
  assert.equal(live.indexBaseUrl,`${origin}/bemine-v5/api/chain-index`);
  assert(calls.every(url=>url.startsWith(`${origin}/bemine-v5/`)));
  const plan=prepareFreshProductBuild(manifest,{version:'5',publicOrigin:origin});
  assert.equal(plan.basePath,'/bemine-v5');
  assert.equal(plan.deployConsoleUrl,'https://tapeout.cc.cd/pinkuang-deploy-v5/');
  assert.throws(()=>prepareFreshProductBuild(manifest,{version:'6'}),/Unsupported/);
});

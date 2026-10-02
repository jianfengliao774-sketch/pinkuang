import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface, ZeroAddress, getAddress, keccak256, toQuantity } from 'ethers';
import { abi, ARTIFACT_DIGEST } from '../lib/chain-client.mjs';
import pinnedGenesis from '../public/data/frontend-manifest.json' with { type: 'json' };
import { LiveDataError, loadLiveConfig, validateManifest, createReadProvider, fetchLiveJson, MANIFEST_KEYS,
  GENESIS_ARTIFACT_DIGEST,
  validateProductGraph } from '../lib/live-config.mjs';
import { createLiveDataClient, fetchLiveJsonWithClock, requireRecentSnapshotState,
  validateIndexSource } from '../lib/live-data.mjs';

const addr = n => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const factory = addr(1), shareMarket = addr(2), lens = addr(3), beacon = addr(4), timelock = addr(5);
const pool = addr(6), account = addr(7), collection = addr(8), origin = 'https://example.test';
const blockHash = `0x${'a1'.repeat(32)}`, deploymentHash = `0x${'b2'.repeat(32)}`, txHash = `0x${'c3'.repeat(32)}`;
const timestamp = 1800000000, now = timestamp * 1000, code = '0x60006000';
const manifest = { schemaVersion: 1, chainId: 56, factory, shareMarket, lens, beacon, timelock,
  deployment: { txHash, blockNumber: 8, blockHash: deploymentHash }, artifactDigest: ARTIFACT_DIGEST,
  sourceCommit: 'a'.repeat(40), verifiedAt: new Date(now).toISOString(), verifiedBlockNumber: 9,
  codehash: Object.fromEntries(MANIFEST_KEYS.map(key => [key, keccak256(code)])) };
const portfolioFactory = addr(111), portfolioMarket = addr(112), portfolioBeacon = addr(113);
const portfolioImplementation = addr(114), portfolioFactoryImplementation = addr(115), portfolio = addr(116);
const integratedManifest = { ...manifest, kind: 'integrated-v2', portfolioFactory, portfolioMarket,
  portfolioBeacon, portfolioImplementation, portfolioFactoryImplementation,
  codehash: { ...manifest.codehash, ...Object.fromEntries([
    'portfolioFactory', 'portfolioMarket', 'portfolioBeacon', 'portfolioImplementation',
    'portfolioFactoryImplementation'].map(key => [key, keccak256(code)])) } };
const config = { status: 'ready', manifest, origin, basePath: '/bemine',
  indexBaseUrl: `${origin}/api/chain-index`, rpcUrl: `${origin}/api/rpc` };
const integratedConfig = { ...config, manifest: integratedManifest };
const source = { chainId: 56, factory, market: shareMarket, startBlock: 8, confirmations: 12,
  indexedThrough: 10, indexedBlockHash: blockHash, indexedTimestamp: timestamp, observedSafeHead: 10,
  complete: true, checkedAt: new Date(now).toISOString(), unknownReason: null };
const params = { circuits: collection, circuitId: 900719925474099312345n,
  targetRaise: 11000000000000000100n, priceCap: 10000000000000000000n,
  directSeller: ZeroAddress, directPrice: 0n, fundingDeadline: BigInt(timestamp + 500), purchaseDeadline: BigInt(timestamp + 1000) };
const bindings = new Interface(['function owner() view returns(address)', 'function factory() view returns(address)',
  'function timelock() view returns(address)', 'function lens() view returns(address)', 'function shareMarket() view returns(address)',
  'function beacon() view returns(address)', 'function VERSION() view returns(uint256)']);
const saleViews = new Interface([
  'function saleReference(address pool) view returns(uint128 marketPriceWei,uint64 observedAt,bytes32 sourceDigest)',
  'function saleReview(address pool,uint256 proposalId) view returns(uint8 status,uint128 priceWei)',
]);
const thresholdView = new Interface(['function saleReviewThresholdBps() view returns(uint16)']);
const referenceDigest = `0x${'ee'.repeat(32)}`;
function row(changes = {}) { return { pool, status: { validMask: (1n << 17n) - 1n, errorMask: 0n, trustError: 0n }, params,
  state: 2n, unitPriceWei: params.targetRaise / 100n, totalRaised: params.targetRaise, totalSupply: 100n,
  memberCount: 3n, depositPaused: false, purchaseCost: params.priceCap, activatedAt: BigInt(timestamp - 172800),
  shareTradingAllowed: true, shares: 0n, lockedShares: 0n, availableShares: 0n, claimableBEM: 0n,
  bnbOwed: 0n, initialContributedWei: 0n, ...changes }; }
const proposal = { proposer: account, snapshotTs: 1799999000n, endsAt: 1800085400n, refAt: 1799999000n,
  price: 10000n, refPrice: 10000n, snapshotMemberCount: 3n, snapshotTotalShares: 100n, yesCount: 2n, yesShares: 60n, executed: false };
function governance(changes = {}) { return { status: { validMask: (1n << 14n) - 1n, errorMask: 0n, trustError: 0n },
  state: 2n, activeProposalId: 1n, proposal, purchaseCost: 10000n, hasVoted: false, snapshotShares: 10n,
  listedProposalId: 0n, expiresAt: 0n, salePrice: 0n, requiredYesCount: 2n, requiredYesShares: 51n,
  discounted: false, passed: true, canVote: true, canExecute: true, canCancelExpired: false, ...changes }; }
function provider(options = {}) {
  const calls = [], rows = options.rows ?? [row()];
  return { calls, async request(request) {
    calls.push(request); const { method, params: args = [] } = request;
    if (method === 'eth_chainId') return options.wrongChain ? '0x1' : '0x38';
    if (method === 'eth_getBlockByNumber') {
      const n = args[0] === 'latest' ? BigInt(options.latestBlockNumber ?? 10) : BigInt(args[0]);
      return { number: toQuantity(n), timestamp: toQuantity(n === 8n ? timestamp - 2 : timestamp),
        hash: n === 8n ? (options.deploymentReorg ? blockHash : deploymentHash)
          : options.reorg || options.reorgBlockNumber !== undefined && n === BigInt(options.reorgBlockNumber)
            ? deploymentHash : blockHash };
    }
    if (method === 'eth_getCode') return options.badCode ? '0x6001' : code;
    assert.equal(method, 'eth_call'); assert.equal(args[1], options.directLatest ? 'latest' : toQuantity(options.blockNumber ?? 10n));
    const { to, data } = args[0];
    if (data === thresholdView.encodeFunctionData('saleReviewThresholdBps')) {
      if (options.saleReviewThresholdBps === undefined) throw Error('old implementation');
      return thresholdView.encodeFunctionResult('saleReviewThresholdBps', [options.saleReviewThresholdBps]);
    }
    let iface = to === factory ? abi.PoolFactory : to === lens ? abi.PoolLens : to === shareMarket ? abi.ShareMarket
      : to === portfolioFactory ? abi.BudgetPortfolioFactory : (options.portfolios ?? []).includes(to) ? abi.BudgetPortfolioVault
        : to === pool ? abi.PoolVault : bindings;
    let parsed = iface.parseTransaction({ data });
    if (!parsed && to === shareMarket) { iface = saleViews; parsed = iface.parseTransaction({ data }); }
    if (!parsed) { iface = bindings; parsed = iface.parseTransaction({ data }); }
    const name = parsed.name; let value;
    if (name === 'lens') value = options.wrongBinding ? addr(99) : lens;
    else if (name === 'factory') value = factory;
    else if (name === 'timelock' || name === 'owner') value = timelock;
    else if (name === 'shareMarket') value = shareMarket;
    else if (name === 'beacon') value = beacon;
    else if (name === 'VERSION') value = options.lensVersion ?? 1n;
    else if (name === 'poolCount') value = BigInt(options.totalPools ?? rows.length);
    else if (name === 'designatedSubscriber') value = options.subscribers?.[getAddress(parsed.args[0])] ?? ZeroAddress;
    else if (name === 'legacyFactory') value = factory;
    else if (name === 'portfolioCount') value = BigInt((options.portfolios ?? []).length);
    else if (name === 'portfolioAt') value = options.portfolios[Number(parsed.args[0])];
    else if (name === 'childCount') value = BigInt(options.childCounts?.[getAddress(to)] ?? 0);
    else if (name === 'isPool') value = (options.portfolios ?? []).includes(getAddress(parsed.args[0]));
    else if (name === 'childInfo') value = [options.acquiredChildren?.includes(getAddress(parsed.args[0])) ? collection : ZeroAddress,
      0n, 0n, false, false];
    else if (name === 'nextOrderId') value = 2n;
    else if (name === 'positions') value = { blockNumber: BigInt(options.blockNumber ?? 10), timestamp: BigInt(timestamp),
      totalPools: BigInt(options.totalPools ?? rows.length), nextCursor: 0n, registryCountValid: true,
      pools: parsed.args[0].map(address => rows.find(r => r.pool === address) ?? row({ pool: address })) };
    else if (name === 'poolPage') value = { blockNumber: BigInt(options.blockNumber ?? 10), timestamp: BigInt(timestamp),
      totalPools: BigInt(options.totalPools ?? rows.length), nextCursor: 0n, registryCountValid: true,
      pools: rows.slice(Number(parsed.args[0]), Number(parsed.args[0] + parsed.args[1])) };
    else if (name === 'bnbOwed') value = 123456789012345678901234n;
    else if (name === 'orders') value = { seller: account, pool, remaining: options.wrongOrder ? 3n : 5n,
      pricePerUnit: 123456789012345678901234n, active: true };
    else if (name === 'orderExpiresAt') value = BigInt(timestamp + 500);
    else if (name === 'governance') value = governance(options.governance ?? {});
    else if (name === 'proposalPassed') value = options.proposalPassed ?? true;
    else if (name === 'saleReference') {
      if (options.referenceReadError) throw new Error('reference unavailable');
      value = [options.referencePrice ?? 9000n, options.referenceAt ?? BigInt(timestamp - 100),
        options.referenceDigest ?? referenceDigest];
    }
    else if (name === 'saleReview') {
      if (options.reviewReadError) throw new Error('review unavailable');
      value = [options.reviewStatus ?? 0n, options.reviewPrice ?? 0n];
    }
    else throw new Error(`unexpected call ${name}`);
    return iface.encodeFunctionResult(name, ['saleReference', 'saleReview', 'childInfo'].includes(name) ? value : [value]);
  } };
}
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
function verifiedGraph(changes = {}) {
  const upgraded = changes.stage && changes.stage !== 'genesis';
  const liveManifest = upgraded ? { ...pinnedGenesis, artifactDigest: ARTIFACT_DIGEST,
    portfolioImplementation: addr(101), portfolioFactoryImplementation: addr(102),
    codehash: { ...pinnedGenesis.codehash, portfolioImplementation: blockHash, portfolioFactoryImplementation: blockHash } }
    : pinnedGenesis;
  return { chainId: 56, status: 'verified', stage: upgraded ? changes.stage : 'genesis',
    artifactDigest: upgraded ? ARTIFACT_DIGEST : pinnedGenesis.artifactDigest,
    genesisArtifactDigest: pinnedGenesis.artifactDigest, upgradeArtifactDigest: ARTIFACT_DIGEST,
    operationId: upgraded ? blockHash : null, verifiedBlockNumber: pinnedGenesis.verifiedBlockNumber + 2,
    verifiedBlockHash: blockHash, factory: pinnedGenesis.factory, portfolioFactory: pinnedGenesis.portfolioFactory,
    stageActivationBlock: upgraded ? pinnedGenesis.verifiedBlockNumber + 1 : pinnedGenesis.deployment.blockNumber,
    stageActivationHash: upgraded ? blockHash : pinnedGenesis.deployment.blockHash,
    creationPaused: upgraded ? true : undefined,
    operationalReady: false,
    manifest: { ...liveManifest, verifiedBlockNumber: upgraded ? pinnedGenesis.verifiedBlockNumber + 1 : pinnedGenesis.deployment.blockNumber }, ...changes };
}
function configFetcher(graph = verifiedGraph()) {
  return async url => response(url.endsWith('/data/frontend-manifest.json') ? pinnedGenesis : graph);
}
function indexFetcher(routes = {}, inputSource = source) {
  return async url => { const u = new URL(url); assert.equal(u.origin, origin); assert(u.pathname.startsWith('/api/chain-index/'));
    return response({ source: inputSource, data: routes[u.pathname.slice('/api/chain-index'.length)] }); };
}
const poolsData = { items: [{ address: pool, collection, circuitId: params.circuitId.toString(), createdBlock: 9 }], nextCursor: null };
const ordersData = { items: [{ orderId: '7', seller: account, pool, remaining: '5', pricePerUnitWei: '123456789012345678901234',
  expiresAt: String(timestamp + 500), listedBlock: 9, openAtSourceBlock: true, executable: false }], nextCursor: null };
const client = (routes, options, inputSource = source) => createLiveDataClient(config,
  { provider: provider(options), fetcher: indexFetcher(routes, inputSource), now: () => now });

test('page boots only after same-origin genesis and verified product graph agree', async () => {
  const urls = [];
  const trustedFetch = configFetcher();
  const ready = await loadLiveConfig({ origin, basePath: '/bemine/', fetcher: async url => { urls.push(url); return trustedFetch(url); } });
  assert.deepEqual(urls, [`${origin}/bemine/data/frontend-manifest.json`, `${origin}/bemine/api/journal/product-graph`]);
  assert.equal(ready.stage, 'genesis'); assert.equal(ready.manifest.artifactDigest, pinnedGenesis.artifactDigest);
  assert.equal(ready.status, 'ready'); assert.equal(ready.rpcUrl, `${origin}/bemine/api/rpc`); assert.equal(ready.indexBaseUrl, `${origin}/bemine/api/chain-index`); assert.equal(ready.journalBase, '/bemine/api/journal');
  const empty = await loadLiveConfig({ origin, fetcher: async () => response({}, 404) });
  assert.equal(empty.status, 'unconfigured'); assert.equal(empty.manifest, undefined);
  assert.throws(() => createLiveDataClient(empty), { code: 'unconfigured' });
});

test('boot fetches the pinned manifest and product graph concurrently, then validates them together', async () => {
  const calls = [], releases = new Map();
  const waiting = loadLiveConfig({ origin, fetcher: url => {
    calls.push(url);
    return new Promise(resolve => releases.set(url, resolve));
  } });
  await new Promise(resolve => setImmediate(resolve));
  const manifestUrl = `${origin}/data/frontend-manifest.json`;
  const graphUrl = `${origin}/api/journal/product-graph`;
  assert.deepEqual(calls, [manifestUrl, graphUrl]);
  releases.get(graphUrl)(response(verifiedGraph()));
  releases.get(manifestUrl)(response(pinnedGenesis));
  assert.equal((await waiting).status, 'ready');
});

test('manifest identity, artifact, blocks, addresses and RPC allowlist fail closed', async () => {
  for (const change of [{ chainId: 1 }, { schemaVersion: 2 }, { sourceCommit: '' }, { verifiedBlockNumber: 7 },
    { artifactDigest: blockHash }, { codehash: {} }, { lens: factory }]) assert.throws(() => validateManifest({ ...manifest, ...change }));
  const args = { origin, fetcher: configFetcher(), rpcUrl: 'https://unapproved.test/rpc' };
  await assert.rejects(loadLiveConfig(args), { code: 'rpc_not_allowed' });
  const allowed = await loadLiveConfig({ ...args, allowedRpcOrigins: ['https://unapproved.test'] });
  assert.equal(allowed.rpcUrl, args.rpcUrl);
  await assert.rejects(loadLiveConfig({ ...args, rpcUrl: 'http://unapproved.test/rpc', allowedRpcOrigins: ['http://unapproved.test'] }), { code: 'rpc_not_allowed' });
});

test('upgraded graph chooses candidate ABI without rewriting the pinned genesis file', async () => {
  const candidate = verifiedGraph({ stage: 'code-upgraded' });
  const ready = await loadLiveConfig({ origin, fetcher: configFetcher(candidate) });
  assert.equal(ready.stage, 'code-upgraded');
  assert.equal(ready.manifest.artifactDigest, ARTIFACT_DIGEST);
  assert.equal(ready.manifest.portfolioImplementation, candidate.manifest.portfolioImplementation);
  for (const change of [
    { stage: 'unknown' }, { status: 'unverified' }, { genesisArtifactDigest: blockHash },
    { artifactDigest: blockHash }, { operationId: null }, { creationPaused: false },
    { stageActivationBlock: 0 },
    { factory: addr(200) }, { manifest: { ...candidate.manifest, lens: addr(201) } },
  ]) assert.throws(() => validateProductGraph({ ...candidate, ...change }));
  await assert.rejects(loadLiveConfig({ origin, fetcher: configFetcher({ ...candidate, status: 'unverified' }) }),
    { code: 'product_graph' });
  await assert.rejects(loadLiveConfig({ origin, fetcher: async url => url.endsWith('frontend-manifest.json')
    ? response(pinnedGenesis) : response({}, 503) }), { code: 'http_unavailable' });
});

test('fresh graph is readable with complete Authority and Factory proof while transactions stay disabled', async () => {
  const authority=addr(200), gasWallet=addr(201), administratorOne=addr(202), administratorTwo=addr(203);
  const proof={address:authority,gasWallet,administratorOne,administratorTwo,
    codehash:blockHash,deploymentTxHash:txHash};
  const v3Genesis={...pinnedGenesis,artifactDigest:ARTIFACT_DIGEST,
    authority,gasWallet,freshAuthority:proof};
  const active = verifiedGraph({ stage:'fresh-active', artifactDigest:ARTIFACT_DIGEST,
    genesisArtifactDigest:ARTIFACT_DIGEST,
    upgradeArtifactDigest:null, operationId:null, creationPaused:undefined,
    operationalReady:false, freshFactoryVerified:true,
    freshAuthority:{...proof,activationBlock:v3Genesis.verifiedBlockNumber+1,activationHash:blockHash},
    manifest:{...v3Genesis,verifiedBlockNumber:v3Genesis.verifiedBlockNumber+1} });
  const accepted=validateProductGraph(active,v3Genesis);
  assert.equal(accepted.stage,'fresh-active');
  assert.equal(accepted.operationalReady,false);
  assert.equal(accepted.freshFactoryVerified,true);
  assert.equal(accepted.freshAuthority.address,authority);
  assert.equal(validateProductGraph({...active,previousFactoriesPaused:false},v3Genesis).stage,'fresh-active');
  for (const change of [{freshFactoryVerified:false},{operationalReady:null},
    {freshAuthority:null},{freshAuthority:{...active.freshAuthority,activationHash:deploymentHash}},
    {operationId:blockHash},{upgradeArtifactDigest:blockHash},
    {manifest:{...active.manifest,gasWallet:addr(204)}},
    {manifest:{...active.manifest,freshAuthority:{...proof,codehash:deploymentHash}}}])
    assert.throws(()=>validateProductGraph({...active,...change},v3Genesis));
});

test('a verified historical product graph remains display-only after boot', async () => {
  const current = verifiedGraph({ readMode: 'current', stale: false });
  const historical = { ...current, readMode: 'verified_snapshot', stale: true,
    refreshing: true, transactionReady: false, operationalReady: false, snapshotAgeMs: 12_000 };
  const config = await loadLiveConfig({ origin, fetcher: configFetcher(historical) });
  assert.equal(config.status, 'ready');
  assert.equal(config.readMode, 'verified_snapshot');
  assert.equal(config.stale, true);
  assert.equal(config.transactionReady, false);
  assert.equal(config.snapshotAgeMs, 12_000);
  for (const change of [{ transactionReady: true }, { operationalReady: true },
    { refreshing: undefined }, { snapshotAgeMs: -1 }, { readMode: 'current' }])
    assert.throws(() => validateProductGraph({ ...historical, ...change }), { code: 'product_graph' });
});

test('HTTP provider never requests wallet permission or signs/sends, and checks response ID', async () => {
  let count = 0;
  const rpc = createReadProvider(config, { fetcher: async (url, options) => { count++; assert.equal(url, config.rpcUrl);
    const payload = JSON.parse(options.body); return response({ jsonrpc: '2.0', id: payload.id, result: '0x38' }); } });
  assert.equal(await rpc.request({ method: 'eth_chainId' }), '0x38');
  for (const method of ['eth_sendTransaction', 'eth_sendRawTransaction', 'eth_requestAccounts', 'personal_sign']) await assert.rejects(rpc.request({ method }), { code: 'rpc_method_denied' });
  assert.equal(count, 1);
  const bad = createReadProvider(config, { fetcher: async () => response({ jsonrpc: '2.0', id: 999, result: '0x38' }) });
  await assert.rejects(bad.request({ method: 'eth_chainId' }), { code: 'rpc_error' });
});

test('JSON reader rejects oversized, HTML and redirect responses', async () => {
  await assert.rejects(fetchLiveJson(origin, { maxBytes: 5, fetcher: async () => response({ oversized: true }) }), { code: 'response_too_large' });
  await assert.rejects(fetchLiveJson(origin, { fetcher: async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }) }), { code: 'invalid_json' });
  await assert.rejects(fetchLiveJson(origin, { fetcher: async () => ({ ok: true, redirected: true }) }), { code: 'http_redirect' });
});

test('incomplete, wrong identity, unsafe coverage and stale index never become empty data', () => {
  for (const change of [{ complete: false }, { unknownReason: 'gap' }, { factory: addr(99) }, { market: addr(99) },
    { startBlock: 9 }, { indexedThrough: 9 }, { confirmations: 0 }, { indexedBlockHash: '0xab' },
    { checkedAt: new Date(now - 120001).toISOString() }]) assert.throws(() => validateIndexSource({ ...source, ...change }, manifest, { now }));
});

test('deployment verifies all code hashes and bindings at a canonical pinned block', async () => {
  const rpc = provider(); const c = createLiveDataClient(config, { provider: rpc });
  const verified = await c.verifyDeployment({ blockNumber: 10n });
  assert.equal(verified.blockNumber, 10n);
  assert.equal(rpc.calls.filter(c => c.method === 'eth_getCode').length, 5);
  for (const [options, error] of [[{ wrongChain: true }, 'wrong_chain'], [{ wrongBinding: true }, 'deployment_binding'],
    [{ badCode: true }, 'deployment_code'], [{ deploymentReorg: true }, 'deployment_reorg'], [{ lensVersion: 2n }, 'lens_version']]) {
    await assert.rejects(client({}, options).verifyDeployment({ blockNumber: 10n }), { code: error });
  }
  await assert.rejects(c.verifyDeployment({ blockNumber: 8n }), { code: 'deployment_block' });
});

for (const failedMethod of ['eth_chainId', 'eth_getBlockByNumber']) {
  test(`header failure in ${failedMethod} drains the other in-flight read before rejecting`, async () => {
    const base = provider(), failure = new Error('header transport failed');
    const started = []; let releaseSlow, finishedSlow = false, settled = false;
    const slow = new Promise(resolve => { releaseSlow = resolve; });
    const rpc = { async request(request) {
      started.push(request.method);
      if (request.method === failedMethod) throw failure;
      await slow;
      finishedSlow = true;
      return base.request(request);
    } };
    const result = createLiveDataClient(config, { provider: rpc }).verifyDeployment({ blockNumber: 10n });
    const rejected = assert.rejects(result, error => error === failure);
    result.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    try {
      assert.deepEqual(started, ['eth_chainId', 'eth_getBlockByNumber']);
      assert.equal(settled, false);
      assert.equal(finishedSlow, false);
    } finally { releaseSlow(); }
    await rejected;
    assert.equal(finishedSlow, true);
    assert.equal(started.length, 2, 'no code or binding reads may start after an invalid header');
  });
}

for (const [invalidMethod, expectedCode] of [['eth_chainId', 'wrong_chain'], ['eth_getBlockByNumber', 'rpc_block']]) {
  test(`parallel header still rejects ${expectedCode} after its slower companion completes`, async () => {
    const base = provider(), started = []; let releaseSlow, settled = false;
    const slow = new Promise(resolve => { releaseSlow = resolve; });
    const rpc = { async request(request) {
      started.push(request.method);
      if (request.method === invalidMethod)
        return invalidMethod === 'eth_chainId' ? '0x1' : { number: '0xb', timestamp: toQuantity(timestamp), hash: blockHash };
      await slow;
      return base.request(request);
    } };
    const result = createLiveDataClient(config, { provider: rpc }).verifyDeployment({ blockNumber: 10n });
    const rejected = assert.rejects(result, { code: expectedCode });
    result.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    try {
      assert.deepEqual(started, ['eth_chainId', 'eth_getBlockByNumber']);
      assert.equal(settled, false);
    } finally { releaseSlow(); }
    await rejected;
    assert.equal(started.length, 2);
  });
}

test('same-block deployment callers share bounded reads and cached success still checks the canonical block', async () => {
  const base = provider(); let active = 0, peak = 0;
  const rpc = { async request(request) {
    if (!['eth_getCode', 'eth_call'].includes(request.method)) return base.request(request);
    active++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setImmediate(resolve)); return await base.request(request); }
    finally { active--; }
  } };
  const c = createLiveDataClient(config, { provider: rpc });
  const results = await Promise.all(Array.from({ length: 3 }, () => c.verifyDeployment({ blockNumber: 10n })));
  assert(results.every(result => result.blockHash === blockHash));
  assert.equal(peak, 4); assert.equal(active, 0);
  assert.equal(base.calls.filter(c => c.method === 'eth_getCode').length, 5);
  assert.equal(base.calls.filter(c => c.method === 'eth_call').length, 9);
  assert.equal(base.calls.filter(c => c.method === 'eth_getBlockByNumber' && c.params[0] === '0x8').length, 1);
  const before = base.calls.length;
  await c.verifyDeployment({ blockNumber: 10n });
  assert.deepEqual(base.calls.slice(before).map(c => c.method), ['eth_chainId', 'eth_getBlockByNumber', 'eth_chainId', 'eth_getBlockByNumber']);
});

test('a shared failed deployment verification drains all started reads and is retried without a cached failure', async () => {
  const base = provider(), failure = new Error('temporary code read failure');
  let fail = true, active = 0, started = 0, settled = false, releaseReads, allStarted;
  const release = new Promise(resolve => { releaseReads = resolve; });
  const startedFour = new Promise(resolve => { allStarted = resolve; });
  const rpc = { async request(request) {
    if (!fail || request.method !== 'eth_getCode') return base.request(request);
    started++; active++; if (started === 4) allStarted();
    try {
      if (request.params[0] === factory) throw failure;
      await release; return await base.request(request);
    } finally { active--; }
  } };
  const c = createLiveDataClient(config, { provider: rpc });
  const waiting = Promise.allSettled([c.verifyDeployment({ blockNumber: 10n }), c.verifyDeployment({ blockNumber: 10n })]);
  waiting.then(() => { settled = true; });
  await startedFour; await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, 4); assert.equal(active, 3); assert.equal(settled, false);
  releaseReads();
  const failed = await waiting;
  assert(failed.every(result => result.status === 'rejected' && result.reason === failure));
  assert.equal(active, 0); assert.equal(base.calls.filter(c => c.method === 'eth_call').length, 0);
  fail = false;
  const before = base.calls.length;
  await c.verifyDeployment({ blockNumber: 10n });
  assert.equal(base.calls.slice(before).filter(c => c.method === 'eth_getCode').length, 5);
  assert.equal(base.calls.slice(before).filter(c => c.method === 'eth_call').length, 9);
});

test('deployment cache keys include the block hash and a final reorg check must pass before caching', async () => {
  const base = provider(); let sourceHash = blockHash, targetHeaders = 0, changeAfterRead = true;
  const changedHash = `0x${'d4'.repeat(32)}`;
  const rpc = { async request(request) {
    const result = await base.request(request);
    if (request.method !== 'eth_getBlockByNumber' || request.params[0] === '0x8') return result;
    targetHeaders++;
    return { ...result, hash: changeAfterRead && targetHeaders % 2 === 0 ? changedHash : sourceHash };
  } };
  const c = createLiveDataClient(config, { provider: rpc });
  await assert.rejects(c.verifyDeployment({ blockNumber: 10n }), { code: 'source_reorg' });
  changeAfterRead = false;
  let before = base.calls.length;
  await c.verifyDeployment({ blockNumber: 10n });
  assert.equal(base.calls.slice(before).filter(c => c.method === 'eth_getCode').length, 5);
  sourceHash = changedHash; before = base.calls.length;
  const changed = await c.verifyDeployment({ blockNumber: 10n });
  assert.equal(changed.blockHash, changedHash);
  assert.equal(base.calls.slice(before).filter(c => c.method === 'eth_getCode').length, 5);
  // Even the old cached hash must fail if the block changes during that invocation.
  sourceHash = blockHash; changeAfterRead = true; before = base.calls.length;
  await assert.rejects(c.verifyDeployment({ blockNumber: 10n }), { code: 'source_reorg' });
  assert.equal(base.calls.slice(before).filter(c => c.method === 'eth_getCode').length, 0);
  changeAfterRead = false; before = base.calls.length;
  await c.verifyDeployment({ blockNumber: 10n });
  assert.equal(base.calls.slice(before).filter(c => c.method === 'eth_getCode').length, 5);
});

test('deployment success cache retains at most eight exact block identities', async () => {
  const options = { blockNumber: 10n }, rpc = provider(options), c = createLiveDataClient(config, { provider: rpc });
  for (let number = 10n; number <= 18n; number++) {
    options.blockNumber = number; await c.verifyDeployment({ blockNumber: number });
  }
  assert.equal(rpc.calls.filter(c => c.method === 'eth_getCode').length, 45);
  options.blockNumber = 11n; await c.verifyDeployment({ blockNumber: 11n });
  assert.equal(rpc.calls.filter(c => c.method === 'eth_getCode').length, 45);
  options.blockNumber = 10n; await c.verifyDeployment({ blockNumber: 10n });
  assert.equal(rpc.calls.filter(c => c.method === 'eth_getCode').length, 50);
  options.wrongChain = true;
  await assert.rejects(c.verifyDeployment({ blockNumber: 10n }), { code: 'wrong_chain' });
});

test('display reads reuse a recent deployment proof across clients without bypassing direct verification', async () => {
  const entries = new Map(), verificationStorage = {
    getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value),
  };
  let clock = now;
  const make = (rpc, indexedSource = source) => createLiveDataClient(config, { provider: rpc, verificationStorage,
    fetcher: indexFetcher({ '/v1/pools': poolsData }, { ...indexedSource, checkedAt: new Date(clock).toISOString() }),
    now: () => clock });
  const cold = provider();
  await make(cold).readPools();
  assert.equal(cold.calls.filter(call => call.method === 'eth_getCode').length, 5);
  const warm = provider();
  await make(warm).readPools();
  assert.equal(warm.calls.filter(call => call.method === 'eth_getCode').length, 0);
  const newerSource = { ...source, indexedThrough: 11, observedSafeHead: 11 };
  const canonicalProof = provider({ blockNumber: 11n });
  await make(canonicalProof, newerSource).readPools();
  assert(canonicalProof.calls.some(call => call.method === 'eth_getBlockByNumber' && call.params[0] === '0xa'));
  assert.equal(canonicalProof.calls.filter(call => call.method === 'eth_getCode').length, 0);
  const reorganizedProof = provider({ blockNumber: 11n, reorgBlockNumber: 10n });
  await make(reorganizedProof, newerSource).readPools();
  assert(reorganizedProof.calls.some(call => call.method === 'eth_getBlockByNumber' && call.params[0] === '0xa'));
  assert.equal(reorganizedProof.calls.filter(call => call.method === 'eth_getCode').length, 5,
    'a reorg of the earlier proof block must force fresh deployment verification at the newer source');
  const warmNewer = provider({ blockNumber: 11n });
  await make(warmNewer, newerSource).readPools();
  assert.equal(warmNewer.calls.filter(call => call.method === 'eth_getCode').length, 0);
  await assert.rejects(make(provider({ reorg: true })).readPools(), { code: 'source_reorg' });
  const direct = provider();
  await make(direct).verifyDeployment({ blockNumber: 10n });
  assert.equal(direct.calls.filter(call => call.method === 'eth_getCode').length, 5);
  clock += 10 * 60 * 1000 + 1;
  const expired = provider();
  await make(expired).readPools();
  assert.equal(expired.calls.filter(call => call.method === 'eth_getCode').length, 5);
});

test('pools combine index discovery and same-block Lens; exact amounts and unknown mining stay exact', async () => {
  const { items, source: seen, snapshot } = await client({ '/v1/pools': poolsData }).readPools();
  assert.equal(items.length, 1); assert.equal(items[0].id, pool); assert.equal(items[0].tokenId, params.circuitId.toString());
  assert.equal(items[0].targetRaiseWei, params.targetRaise); assert.equal(items[0].members, 3n); assert.equal(items[0].age, 2n);
  assert.equal(items[0].daily, null); assert.equal(items[0].participants, null); assert.equal(items[0].history, null);
  assert.equal(snapshot.blockNumber, BigInt(seen.indexedThrough));
  await assert.rejects(client({ '/v1/pools': { items: [], nextCursor: null } }).readPools(), { code: 'index_coverage' });
  await assert.rejects(client({ '/v1/pools': poolsData }, { reorg: true }).readPools(), { code: 'source_reorg' });
});

test('same-origin HTTP Date permits current index reads with a slow or fast client clock', async () => {
  const fetcher = async () => new Response(JSON.stringify({ source, data: poolsData }), {
    headers: { 'content-type': 'application/json', Date: new Date(now).toUTCString() },
  });
  for (const localNow of [now - 120_000, now + 10 * 60_000]) {
    const catalog = await createLiveDataClient(config, { provider: provider(), fetcher,
      now: () => localNow }).readPools();
    assert.equal(catalog.source.readMode, undefined);
    assert.equal(catalog.items[0].pool, pool);
  }
});

test('server time cannot make a future timestamp or stale canonical block look current', () => {
  const timeProof = { serverNow: now, localReceivedAt: now - 120_000 };
  const localNow = timeProof.localReceivedAt;
  assert.equal(validateIndexSource(source, manifest, { now: localNow, timeProof }).indexedThrough, 10);
  assert.throws(() => validateIndexSource({ ...source,
    checkedAt: new Date(now + 30_001).toISOString() }, manifest, { now: localNow, timeProof }),
  { code: 'index_stale' });
  assert.throws(() => validateIndexSource({ ...source,
    indexedTimestamp: timestamp - 300 }, manifest, { now: localNow, timeProof }),
  { code: 'index_stale' });
  assert.throws(() => validateIndexSource(source, manifest, { now: localNow - 1, timeProof }),
  { code: 'index_stale' }, 'a backward client clock change must not extend the proof lifetime');
});

test('missing server Date falls back to local time and cannot bypass freshness', async () => {
  const fetcher = async () => response({ source, data: poolsData });
  const result = await fetchLiveJsonWithClock(`${origin}/api/chain-index/v1/pools`, {
    fetcher, now: () => now - 120_000 });
  assert.equal(result.serverNow, null);
  assert.throws(() => validateIndexSource(result.body.source, manifest, { now: now - 120_000 }),
  { code: 'index_stale' });
});

test('shared pool can be resolved directly without enumerating a project page; unregistered pool rejected', async () => {
  const { item } = await client({}).readPool({ pool }); assert.equal(item.id, pool);
  await assert.rejects(client({}, { rows: [row({ status: { validMask: 0n, errorMask: 1n, trustError: 2n } })] }).readPool({ pool }), { code: 'untrusted_pool' });
});

test('source changes invalidate pagination; no mixing snapshots or duplicate rows', async () => {
  await assert.rejects(client({ '/v1/pools': poolsData }).readPools({ source: { ...source, indexedThrough: 9, observedSafeHead: 9 } }), { code: 'source_changed' });
  await assert.rejects(client({ '/v1/pools': { items: [...poolsData.items, ...poolsData.items], nextCursor: null } }).readPools(), { code: 'duplicate_pool' });
  await assert.rejects(client({ '/v1/pools': { ...poolsData, nextCursor: 4 } }).readPools(), { code: 'invalid_cursor' });
});

test('same canonical block can cross live and display read modes without becoming actionable', async () => {
  const historical = { ...source, readMode: 'verified_snapshot', stale: true,
    refreshing: true, transactionReady: false };
  const fromCurrent = await client({ '/v1/pools': poolsData }, {}, historical).readPools({ source });
  const fromHistory = await client({ '/v1/pools': poolsData }).readPools({ source: historical });
  for (const result of [fromCurrent, fromHistory]) {
    assert.equal(result.source.indexedBlockHash, blockHash);
    assert.equal(result.source.readMode, 'verified_snapshot');
    assert.equal(result.source.stale, true);
    assert.equal(result.source.transactionReady, false);
  }
});

test('health prefers a complete current source over a simultaneous displaySource', async () => {
  const historical = { ...source, readMode: 'verified_snapshot', stale: true,
    refreshing: true, transactionReady: false };
  const c = createLiveDataClient(config, { provider: provider(), now: () => now,
    fetcher: async () => response({ source, displaySource: historical }) });
  const detail = await c.readPool({ pool, account });
  assert.notEqual(detail.source.readMode, 'verified_snapshot');
  assert.notEqual(detail.source.stale, true);
});

test('positions retain zero-share rewards and unknown balances, separating market BNB claims', async () => {
  const route = { [`/v1/accounts/${account}/pools`]: { items: [pool], nextCursor: null } };
  const result = await client(route, { rows: [row({ claimableBEM: 123n })] }).readPositions({ account });
  assert.equal(result.items[0].shares, 0n); assert.equal(result.items[0].claimableBEM, 123n);
  assert.equal(result.items[0].bnbOwed, 0n); assert.equal(result.marketBnbOwed, 123456789012345678901234n);
  const unknown = await client(route, { rows: [row({ status: { validMask: 1n, errorMask: 1n << 14n, trustError: 0n } })] }).readPositions({ account });
  assert.equal(unknown.items.length, 1); assert.equal(unknown.items[0].claimableBEM, null);
});

test('temporary index 503 reads confirmed Factory/Lens for pools and wallet shares without inventing an empty page', async () => {
  const unavailable = async () => response({ error: 'index unavailable' }, 503);
  const rpc = provider({ latestBlockNumber: 22n, rows: [row({ shares: 99n, lockedShares: 99n, availableShares: 0n })] });
  const c = createLiveDataClient(config, { provider: rpc, fetcher: unavailable, now: () => now });
  const catalog = await c.readPools({ account });
  assert.equal(catalog.source.readMode, 'direct_chain');
  assert.equal(catalog.items[0].pool, pool);
  const positions = await c.readPositions({ account });
  assert.equal(positions.source.readMode, 'direct_chain');
  assert.equal(positions.items[0].shares, 99n);
  assert.equal(positions.items[0].lockedShares, 99n);
  assert.equal(positions.items[0].availableShares, 0n);
  assert.equal(positions.marketBnbOwed, 123456789012345678901234n);
  const detail = await c.readPool({ pool, account });
  assert.equal(detail.item.shares, 99n);
  const myOrders = await c.readOrders({ seller: account });
  assert.equal(myOrders.source.readMode, 'direct_chain');
  assert.equal(myOrders.items[0].orderId, 1n);
  assert.equal(myOrders.items[0].remaining, 5n);
  assert(rpc.calls.every(call => !/send|sign/i.test(call.method)));
  await assert.rejects(c.readPools({ account, cursor: 1 }), { code: 'http_unavailable' });
});

test('a recent saved index snapshot discovers pools during sync, but Lens still verifies the pinned block', async () => {
  const snapshotSource = { ...source, readMode: 'verified_snapshot', stale: true, refreshing: true, transactionReady: false };
  const fetcher = async url => new URL(url).pathname.endsWith('/v1/snapshot/pools')
    ? response({ source: snapshotSource, data: poolsData }) : response({ error: 'syncing' }, 503);
  const c = createLiveDataClient(config, { provider: provider(), fetcher, now: () => now });
  const catalog = await c.readPools({ account });
  assert.equal(catalog.source.readMode, 'verified_snapshot');
  assert.equal(catalog.source.stale, true);
  assert.equal(catalog.source.transactionReady, false);
  assert.equal(catalog.items[0].pool, pool);
  const wrong = createLiveDataClient(config, { provider: provider(), fetcher: async url =>
    new URL(url).pathname.endsWith('/v1/snapshot/pools')
      ? response({ source: { ...snapshotSource, indexedBlockHash: deploymentHash }, data: poolsData })
      : response({ error: 'syncing' }, 503), now: () => now });
  await assert.rejects(wrong.readPools({ account }), { code: 'source_reorg' });
});

test('detail and governance use health displaySource only after pinned-chain verification', async () => {
  const liveStatus = { ...source, complete: false, unknownReason: 'sync_failed', observedSafeHead: 11 };
  const displaySource = { ...source, checkedAt: new Date(now - 10 * 60_000).toISOString(),
    readMode: 'verified_snapshot', stale: true, refreshing: false, transactionReady: false };
  const rpc = provider();
  const fetcher = async url => response(new URL(url).pathname.endsWith('/health')
    ? { source: liveStatus, displaySource } : { error: 'unavailable' },
  new URL(url).pathname.endsWith('/health') ? 200 : 503);
  const c = createLiveDataClient(config, { provider: rpc, fetcher, now: () => now });
  const [detail, governance] = await Promise.all([
    c.readPool({ pool, account }), c.readGovernance({ pool, account }),
  ]);
  for (const result of [detail, governance]) {
    assert.equal(result.source.readMode, 'verified_snapshot');
    assert.equal(result.source.stale, true);
    assert.equal(result.source.transactionReady, false);
    assert.equal(result.source.indexedThrough, source.indexedThrough);
  }
  assert(rpc.calls.some(call => call.method === 'eth_getBlockByNumber' && call.params[0] === '0xa'),
    'the historical block hash is independently checked on chain');
  const bad = createLiveDataClient(config, { provider: provider({ reorg: true }), fetcher, now: () => now });
  await assert.rejects(bad.readGovernance({ pool, account }), { code: 'source_reorg' });
  const invalid = createLiveDataClient(config, { provider: provider(), fetcher: async () => response({
    source: liveStatus, displaySource: { ...displaySource, transactionReady: true },
  }), now: () => now });
  await assert.rejects(invalid.readGovernance({ pool, account }), { code: 'index_stale' });
});

test('automatic snapshot responses keep their historical checkedAt and never gain live transaction status', async () => {
  const historical = { ...source, checkedAt: new Date(now - 60_000).toISOString(),
    readMode: 'verified_snapshot', stale: true, refreshing: false, transactionReady: false };
  const c = client({ '/v1/pools': poolsData, '/v1/orders': ordersData, '/v1/stats': {
    scope: 'confirmed_indexed_history', registeredPoolCount: '1', everParticipantAddressCount: '0',
    purchasedCostWei: '0', shareMarketFilledGrossWei: '0', harvestedToMembersBemAtomic: '0',
  } }, {}, historical);
  const [catalog, orders, stats] = await Promise.all([c.readPools({ account }), c.readOrders({ active: true }), c.readStats()]);
  for (const result of [catalog, orders, stats]) {
    assert.equal(result.source.checkedAt, historical.checkedAt);
    assert.equal(result.source.stale, true);
    assert.equal(result.source.transactionReady, false);
  }
  for (const bad of [{ stale: false }, { transactionReady: true }, { refreshing: undefined },
    { readMode: undefined }, { checkedAt: new Date(now - 30 * 60_000 - 1).toISOString() }])
    assert.throws(() => validateIndexSource({ ...historical, ...bad }, manifest, { now }), { code: 'index_stale' });
});

test('snapshot state reads are bounded by the RPC head, not merely their recent checkedAt', async () => {
  const recent = { ...source, readMode: 'verified_snapshot', stale: true,
    refreshing: false, transactionReady: false, indexedTimestamp: timestamp - 90 };
  await requireRecentSnapshotState(provider(), recent);
  const old = { ...recent, indexedTimestamp: timestamp - 91, checkedAt: new Date(now).toISOString() };
  const rpc = provider();
  await assert.rejects(requireRecentSnapshotState(rpc, old), { code: 'index_stale' });
  assert.equal(rpc.calls.filter(call => call.method === 'eth_call').length, 0);
  await assert.rejects(requireRecentSnapshotState(provider({ latestBlockNumber: 139 }), recent),
    { code: 'index_stale' }, 'block-depth guard also bounds RPCs with inaccurate timestamps');
});

test('an old historical catalog skips old-state calls and uses fresh direct chain fallback', async () => {
  const rpc = provider({ latestBlockNumber: 22n });
  const historical = { ...source, indexedThrough: 11, observedSafeHead: 11,
    indexedTimestamp: timestamp - 1000, checkedAt: new Date(now - 1000).toISOString(),
    readMode: 'verified_snapshot', stale: true, refreshing: false, transactionReady: false };
  const fetcher = async () => response({ source: historical, data: poolsData });
  const result = await createLiveDataClient(config, { provider: rpc, fetcher, now: () => now }).readPools({ account });
  assert.equal(result.source.readMode, 'direct_chain');
  assert.equal(result.items[0].pool, pool);
  assert.equal(rpc.calls.some(call => call.method === 'eth_getBlockByNumber' && call.params[0] === '0xb'), false,
    'the old snapshot block must not be requested for proof or state reads');
});

test('an older index without the snapshot route falls through to confirmed direct reads', async () => {
  const fetcher = async url => new URL(url).pathname.endsWith('/v1/snapshot/pools')
    ? response({ error: 'route missing' }, 404) : response({ error: 'syncing' }, 503);
  const result = await createLiveDataClient(config, { provider: provider({ latestBlockNumber: 22n }), fetcher, now: () => now }).readPools({ account });
  assert.equal(result.source.readMode, 'direct_chain');
  assert.equal(result.items[0].pool, pool);
});

test('legacy Factory reads never request the integrated-only child reservation selector', async () => {
  const base = provider({ latestBlockNumber: 22n });
  const selector = abi.PoolFactory.getFunction('designatedSubscriber').selector;
  const rpc = { calls: base.calls, request: async request => {
    if (request.method === 'eth_call' && request.params[0].to === factory
      && request.params[0].data.startsWith(selector)) throw new Error('legacy Factory has no selector');
    return base.request(request);
  } };
  const c = createLiveDataClient(config, { provider: rpc,
    fetcher: async url => new URL(url).pathname.endsWith('/v1/pools')
      ? response({ source, data: poolsData }) : response({ error: 'unavailable' }, 503), now: () => now });
  assert.equal((await c.readPools({ account })).items[0].pool, pool);
  const direct = createLiveDataClient(config, { provider: rpc,
    fetcher: async () => response({ error: 'unavailable' }, 503), now: () => now });
  assert.equal((await direct.readPools({ account })).items[0].pool, pool);
  assert.equal(base.calls.filter(request => request.method === 'eth_call'
    && request.params[0].to === factory && request.params[0].data.startsWith(selector)).length, 0);
});

test('genesis integrated-v2 graph does not assume its old Factory has designatedSubscriber', async () => {
  const old = { ...integratedConfig, stage: 'genesis',
    manifest: { ...integratedManifest, artifactDigest: GENESIS_ARTIFACT_DIGEST } };
  const base = provider({ latestBlockNumber: 22n });
  const selector = abi.PoolFactory.getFunction('designatedSubscriber').selector;
  const rpc = { calls: base.calls, request: async request => {
    if (request.method === 'eth_call' && request.params[0].to === factory
      && request.params[0].data.startsWith(selector)) throw new Error('old integrated Factory has no selector');
    return base.request(request);
  } };
  const directory = { ...poolsData, registeredPoolCount: '1', childPoolCount: '0', standalonePoolCount: '1' };
  const indexed = createLiveDataClient(old, { provider: rpc,
    fetcher: indexFetcher({ '/v1/pools': directory }), now: () => now });
  assert.equal((await indexed.readPools({ account })).items[0].pool, pool);
  const direct = createLiveDataClient(old, { provider: rpc,
    fetcher: async () => response({ error: 'unavailable' }, 503), now: () => now });
  assert.equal((await direct.readPools({ account })).items[0].pool, pool);
  assert.equal(base.calls.filter(request => request.method === 'eth_call'
    && request.params[0].to === factory && request.params[0].data.startsWith(selector)).length, 0);
});

test('pool directory counts exclude portfolio children without reporting missing Factory registrations', async () => {
  const directory = { ...poolsData, registeredPoolCount: '2', childPoolCount: '1', standalonePoolCount: '1',
    reservedChildPoolCount: '0', reservedChildPoolAddresses: [], reservedChildPoolAddressesComplete: true };
  const budgetOptions = { totalPools: 2, portfolios: [portfolio], childCounts: { [portfolio]: 1 } };
  const result = await createLiveDataClient(integratedConfig, { provider: provider(budgetOptions),
    fetcher: indexFetcher({ '/v1/pools': directory }), now: () => now }).readPools({ account });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].pool, pool);
  await assert.rejects(createLiveDataClient(integratedConfig, { provider: provider(budgetOptions),
    fetcher: indexFetcher({ '/v1/pools': { ...directory, childPoolCount: '0' } }), now: () => now }).readPools({ account }),
    { code: 'index_coverage' });
  await assert.rejects(createLiveDataClient(integratedConfig, { provider: provider(budgetOptions),
    fetcher: indexFetcher({ '/v1/pools': { ...directory, childPoolCount: '2', standalonePoolCount: '0' } }), now: () => now }).readPools({ account }),
    { code: 'index_coverage' });
});

test('pending budget child never appears as a public project through index or direct chain fallback', async () => {
  const reserved = addr(117), rows = [row({ pool: reserved, state: 0n }), row()];
  const options = { latestBlockNumber: 22n, rows, subscribers: { [reserved]: portfolio } };
  const directory = { items: [
    { address: reserved, collection, circuitId: '11', createdBlock: 9 },
    { address: pool, collection, circuitId: params.circuitId.toString(), createdBlock: 9 },
  ], nextCursor: null, registeredPoolCount: '2', childPoolCount: '0', standalonePoolCount: '1',
    reservedChildPoolCount: '1', reservedChildPoolAddresses: [reserved], reservedChildPoolAddressesComplete: true };
  const indexed = await createLiveDataClient(integratedConfig, { provider: provider(options),
    fetcher: indexFetcher({ '/v1/pools': directory }), now: () => now }).readPools({ account });
  assert.equal(indexed.source.readMode, 'direct_chain', 'a page containing a reserved child falls back to verified direct discovery');
  assert.deepEqual(indexed.items.map(item => item.pool), [pool]);
  assert.equal(indexed.nextCursor, null);

  const direct = await createLiveDataClient(integratedConfig, { provider: provider(options),
    fetcher: async () => response({ error: 'unavailable' }, 503), now: () => now }).readPools({ account });
  assert.deepEqual(direct.items.map(item => item.pool), [pool]);

  const later = await createLiveDataClient(integratedConfig, { provider: provider({ ...options,
    rows: [...Array.from({ length: 20 }, (_, index) => row({ pool: addr(200 + index), state: 0n })), row()],
    subscribers: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [addr(200 + index), portfolio])) }),
    fetcher: async () => response({ error: 'unavailable' }, 503), now: () => now }).readPools({ account });
  assert.deepEqual(later.items.map(item => item.pool), [pool], 'all-child first batch must scan onward');
  assert.equal(later.nextCursor, null);

  const secondPublic = addr(250);
  const pagedRpc = provider({ ...options,
    rows: [...Array.from({ length: 20 }, (_, index) => row({ pool: addr(200 + index), state: 0n })),
      row(), row({ pool: secondPublic })],
    subscribers: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [addr(200 + index), portfolio])) });
  const paged = createLiveDataClient(integratedConfig, { provider: pagedRpc,
    fetcher: async () => response({ error: 'unavailable' }, 503), now: () => now });
  const first = await paged.readPools({ account, limit: 1 });
  assert.deepEqual(first.items.map(item => item.pool), [pool]);
  assert.equal(first.nextCursor, 21);
  const second = await paged.readPools({ account, limit: 1, cursor: first.nextCursor, source: first.source });
  assert.deepEqual(second.items.map(item => item.pool), [secondPublic]);
  assert.equal(second.nextCursor, null);
});

test('canonical reservation checks are reused on refresh without repeating pool calls', async () => {
  const rpc = provider(), directory = { ...poolsData, registeredPoolCount: '1', childPoolCount: '0',
    standalonePoolCount: '1', reservedChildPoolCount: '0', reservedChildPoolAddresses: [],
    reservedChildPoolAddressesComplete: true };
  const c = createLiveDataClient(integratedConfig, { provider: rpc,
    fetcher: indexFetcher({ '/v1/pools': directory }), now: () => now });
  await c.readPools({ account });
  const first = rpc.calls.filter(call => call.method === 'eth_call'
    && call.params[0].data.startsWith(abi.PoolFactory.getFunction('designatedSubscriber').selector)).length;
  assert.equal(first, 1);
  await c.readPools({ account });
  const second = rpc.calls.filter(call => call.method === 'eth_call'
    && call.params[0].data.startsWith(abi.PoolFactory.getFunction('designatedSubscriber').selector)).length;
  assert.equal(second, first);
});

test('a changed proof block invalidates cached child classification before a newer source is shown', async () => {
  const options = { blockNumber: 10n }, base = provider(options);
  let indexed = source, changedOldBlock = false;
  const rpc = { calls: base.calls, async request(request) {
    const value = await base.request(request);
    if (changedOldBlock && request.method === 'eth_getBlockByNumber' && request.params[0] === '0xa')
      return { ...value, hash: deploymentHash };
    return value;
  } };
  const directory = { ...poolsData, registeredPoolCount: '1', childPoolCount: '0',
    standalonePoolCount: '1', reservedChildPoolCount: '0', reservedChildPoolAddresses: [],
    reservedChildPoolAddressesComplete: true };
  const c = createLiveDataClient(integratedConfig, { provider: rpc,
    fetcher: async () => response({ source: indexed, data: directory }), now: () => now });
  const reservationReads = () => rpc.calls.filter(call => call.method === 'eth_call'
    && call.params[0].data.startsWith(abi.PoolFactory.getFunction('designatedSubscriber').selector)).length;
  await c.readPools({ account });
  assert.equal(reservationReads(), 1);
  indexed = { ...source, indexedThrough: 11, observedSafeHead: 11 };
  options.blockNumber = 11n;
  changedOldBlock = true;
  await c.readPools({ account });
  assert.equal(reservationReads(), 2, 'a reorged proof block must force a fresh same-block classification');
  indexed = { ...source, indexedThrough: 12, observedSafeHead: 12 };
  options.blockNumber = 12n;
  changedOldBlock = false;
  await c.readPools({ account });
  assert.equal(reservationReads(), 2, 'a canonical proof may be reused on a later verified block');
});

test('indexed statistics use server-verified child count without enumerating budget vaults per page', async () => {
  const stats = { scope: 'confirmed_indexed_history', registeredPoolCount: '2', standalonePoolCount: '1',
    childPoolCount: '1', reservedChildPoolCount: '0', reservedChildPoolAddresses: [], reservedChildPoolAddressesComplete: true,
    portfolioCount: '1', topLevelProjectCount: '2', everParticipantAddressCount: '2',
    purchasedCostWei: '0', shareMarketFilledGrossWei: '0', harvestedToMembersBemAtomic: '0' };
  const budgetOptions = { totalPools: 2, portfolios: [portfolio], childCounts: { [portfolio]: 1 } };
  const fetcher = indexFetcher({ '/v1/stats': stats });
  const rpc = provider(budgetOptions);
  const result = await createLiveDataClient(integratedConfig, { provider: rpc,
    fetcher, now: () => now }).readStats();
  assert.equal(result.data.childPoolCount, 1n);
  assert.equal(rpc.calls.filter(request => request.method === 'eth_call'
    && request.params[0].data.startsWith(abi.BudgetPortfolioVault.getFunction('childCount').selector)).length, 0);
});

test('500 budget projects and 500 reservations do not cause fleet-wide browser RPC reads', async () => {
  const budgetPools = Array.from({ length: 500 }, (_, index) => addr(1000 + index));
  const reservations = Array.from({ length: 500 }, (_, index) => addr(2000 + index));
  const options = { totalPools: 1001, portfolios: budgetPools };
  const directory = { ...poolsData, registeredPoolCount: '1001', childPoolCount: '500',
    reservedChildPoolCount: '500', reservedChildPoolAddresses: reservations,
    reservedChildPoolAddressesComplete: true, standalonePoolCount: '1' };
  const stats = { scope: 'confirmed_indexed_history', registeredPoolCount: '1001', standalonePoolCount: '1',
    childPoolCount: '500', reservedChildPoolCount: '500', reservedChildPoolAddresses: reservations,
    reservedChildPoolAddressesComplete: true, portfolioCount: '500', topLevelProjectCount: '501',
    everParticipantAddressCount: '1', purchasedCostWei: '0', shareMarketFilledGrossWei: '0',
    harvestedToMembersBemAtomic: '0' };
  const rpc = provider(options);
  const c = createLiveDataClient(integratedConfig, { provider: rpc,
    fetcher: indexFetcher({ '/v1/pools': directory, '/v1/stats': stats }), now: () => now });
  assert.equal((await c.readPools({ account })).items.length, 1);
  assert.equal((await c.readStats()).data.childPoolCount, 500n);
  assert(rpc.calls.length < 100, 'browser reads must stay bounded independently of the number of budget projects');
  const globalSelectors = [abi.BudgetPortfolioFactory.getFunction('portfolioAt').selector,
    abi.BudgetPortfolioFactory.getFunction('isPool').selector,
    abi.BudgetPortfolioVault.getFunction('childCount').selector,
    abi.BudgetPortfolioVault.getFunction('childInfo').selector];
  assert.equal(rpc.calls.filter(request => request.method === 'eth_call'
    && globalSelectors.some(selector => request.params[0].data.startsWith(selector))).length, 0);
});

test('indexed reserved child list is complete, distinct and disjoint from visible rows', async () => {
  const reserved = addr(118), options = { totalPools: 2, portfolios: [portfolio],
    subscribers: { [reserved]: portfolio } };
  const directory = { ...poolsData, registeredPoolCount: '2', childPoolCount: '0',
    reservedChildPoolCount: '1', reservedChildPoolAddresses: [reserved], reservedChildPoolAddressesComplete: true,
    standalonePoolCount: '1' };
  const read = data => createLiveDataClient(integratedConfig, { provider: provider(options),
    fetcher: indexFetcher({ '/v1/pools': data }), now: () => now }).readPools({ account });
  const good = await read(directory);
  assert.deepEqual(good.items.map(item => item.pool), [pool]);
  await assert.rejects(read({ ...directory, reservedChildPoolAddresses: [pool] }), { code: 'index_coverage' });
  await assert.rejects(read({ ...directory, reservedChildPoolCount: '2',
    reservedChildPoolAddresses: [reserved, reserved] }), { code: 'index_coverage' });
  await assert.rejects(read({ ...directory, reservedChildPoolAddressesComplete: false }), { code: 'index_coverage' });
  await assert.rejects(createLiveDataClient(integratedConfig, { provider: provider({ ...options,
    acquiredChildren: [reserved], childCounts: { [portfolio]: 1 } }),
    fetcher: indexFetcher({ '/v1/pools': { ...directory, childPoolCount: '1', standalonePoolCount: '0' } }),
    now: () => now }).readPools({ account }), { code: 'index_coverage' });

  const stats = { scope: 'confirmed_indexed_history', registeredPoolCount: '2', standalonePoolCount: '1',
    childPoolCount: '0', reservedChildPoolCount: '1', reservedChildPoolAddresses: [reserved], reservedChildPoolAddressesComplete: true,
    portfolioCount: '1', topLevelProjectCount: '2', everParticipantAddressCount: '0',
    purchasedCostWei: '0', shareMarketFilledGrossWei: '0', harvestedToMembersBemAtomic: '0' };
  const result = await createLiveDataClient(integratedConfig, { provider: provider(options),
    fetcher: indexFetcher({ '/v1/stats': stats }), now: () => now }).readStats();
  assert.equal(result.data.reservedChildPoolCount, 1n);
  await assert.rejects(createLiveDataClient(integratedConfig, { provider: provider(options),
    fetcher: indexFetcher({ '/v1/stats': { ...stats, reservedChildPoolAddressesComplete: false } }),
    now: () => now }).readStats(), { code: 'index_coverage' });
});

test('index identity mismatch cannot trigger direct chain fallback', async () => {
  const wrong = client({ '/v1/pools': poolsData }, { latestBlockNumber: 22n }, { ...source, factory: addr(99) });
  await assert.rejects(wrong.readPools({ account }), { code: 'index_identity' });
});

test('statistics preserve the indexed history definition and check on-chain registration count', async () => {
  const stats = { scope: 'confirmed_indexed_history', registeredPoolCount: '1', everParticipantAddressCount: '2',
    purchasedCostWei: '123456789012345678901234', shareMarketFilledGrossWei: '5', harvestedToMembersBemAtomic: '6' };
  const result = await client({ '/v1/stats': stats }).readStats(); assert.equal(result.data.purchasedCostWei, 123456789012345678901234n);
  assert.equal(result.data.currentlyActivePoolCount, null); assert.equal(result.data.estimatedDailyBemAtomic, null);
  await assert.rejects(client({ '/v1/stats': { ...stats, registeredPoolCount: '2' } }).readStats(), { code: 'index_coverage' });
});

test('orders are re-read on chain and remain non-executable history candidates', async () => {
  const result = await client({ '/v1/orders': ordersData }).readOrders({ pool, seller: account, active: true });
  assert.equal(result.items[0].orderId, 7n); assert.equal(result.items[0].pricePerUnitWei, 123456789012345678901234n);
  assert.equal(result.items[0].executable, false); assert.equal(result.items[0].requiresLatestSimulation, true);
  await assert.rejects(client({ '/v1/orders': ordersData }, { wrongOrder: true }).readOrders(), { code: 'order_mismatch' });
  await assert.rejects(client({ '/v1/orders': ordersData }).readOrders({ active: false }), { code: 'order_mismatch' });
});

test('indexed order checks use bounded concurrent same-block reads and preserve page order', async () => {
  const data = { items: Array.from({ length: 20 }, (_, i) =>
    ({ ...ordersData.items[0], orderId: String(30 - i) })), nextCursor: null };
  const base = provider(); let active = 0, peak = 0;
  const marketSelectors = new Set(['orders', 'orderExpiresAt']
    .map(name => abi.ShareMarket.getFunction(name).selector));
  const marketBlocks = [];
  const rpc = { async request(request) {
    const marketRead = request.method === 'eth_call' && request.params[0].to === shareMarket
      && marketSelectors.has(request.params[0].data.slice(0, 10));
    if (!marketRead) return base.request(request);
    marketBlocks.push(request.params[1]);
    active++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setImmediate(resolve)); return await base.request(request); }
    finally { active--; }
  } };
  const c = createLiveDataClient(config, { provider: rpc,
    fetcher: indexFetcher({ '/v1/orders': data }), now: () => now });
  const result = await c.readOrders({ active: true });
  assert.deepEqual(result.items.map(item => item.orderId), data.items.map(item => BigInt(item.orderId)));
  assert.equal(marketBlocks.length, 40);
  assert(marketBlocks.every(block => block === '0xa'), 'every order check must use the source block');
  assert(peak > 2 && peak <= 16, 'at most eight orders may be checked simultaneously');
  assert.equal(active, 0);
  assert(result.items.every(item => item.executable === false));
});

test('a failed concurrent order check drains in-flight RPCs and never returns a partial page', async () => {
  const data = { items: Array.from({ length: 12 }, (_, i) =>
    ({ ...ordersData.items[0], orderId: String(20 - i) })), nextCursor: null };
  const base = provider({ wrongOrder: true });
  const marketSelectors = new Set(['orders', 'orderExpiresAt']
    .map(name => abi.ShareMarket.getFunction(name).selector));
  let active = 0, started = 0, release, allStarted;
  const gate = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { allStarted = resolve; });
  const rpc = { async request(request) {
    const marketRead = request.method === 'eth_call' && request.params[0].to === shareMarket
      && marketSelectors.has(request.params[0].data.slice(0, 10));
    if (!marketRead) return base.request(request);
    active++; started++;
    if (started === 16) allStarted();
    try { await gate; return await base.request(request); }
    finally { active--; }
  } };
  const c = createLiveDataClient(config, { provider: rpc,
    fetcher: indexFetcher({ '/v1/orders': data }), now: () => now });
  const pending = c.readOrders({ active: true });
  const rejected = assert.rejects(pending, { code: 'order_mismatch' });
  try {
    await reached;
    assert.equal(active, 16);
  } finally { release(); }
  await rejected;
  assert.equal(started, 16, 'a failed cohort cannot schedule later orders');
  assert.equal(active, 0, 'all reads started before failure must complete');
});

test('a pruned index block falls back to a fresh confirmed order read', async () => {
  const base = provider({ latestBlockNumber: 30n, blockNumber: 18n });
  const rpc = { request(input) {
    if (input.method === 'eth_getCode' && input.params[1] === '0xa')
      throw new LiveDataError('rpc_error', '只读 RPC 返回错误或不匹配的响应。');
    return base.request(input);
  } };
  const fetcher = async url => new URL(url).pathname.endsWith('/v1/orders')
    ? response({ source, data: ordersData }) : response({ error: 'index unavailable' }, 503);
  const result = await createLiveDataClient(config, { provider: rpc, fetcher, now: () => now }).readOrders({ active: true });
  assert.equal(result.source.readMode, 'direct_chain');
  assert.equal(result.source.indexedThrough, 18);
  assert.equal(result.items[0].orderId, 1n);
  assert.equal(result.items[0].executable, false);
});

test('governance reads masks, so unknown eligibility cannot silently be treated as eligible', async () => {
  const result = await client({}).readGovernance({ pool, account });
  assert.equal(result.data.canVote, true); assert.equal(result.data.canExecute, true); assert.equal(result.data.requiredYesCount, 2n);
  assert.equal(result.data.discounted, false);
  const unknown = await client({}, { governance: { status: { validMask: 1n, errorMask: 1n << 11n, trustError: 0n } } }).readGovernance({ pool, account });
  assert.equal(unknown.data.canVote, null); assert.equal(unknown.data.proposal, null);
  assert.equal(unknown.data.discounted, null); assert.equal(unknown.data.canExecute, null);
  const noProposal = await client({}, { governance: { activeProposalId: 0n, canExecute: true,
    discounted: true, passed: true } }).readGovernance({ pool, account });
  assert.equal(noProposal.data.discounted, null);
  assert.equal(noProposal.data.passed, null);
  assert.equal(noProposal.data.canExecute, null);
});

test('fresh direct governance reads active proposals and exact review via latest business calls only', async () => {
  const directConfig = { ...config, productFamily: 'fresh-v4', displayOnly: true, stage: 'fresh-active' };
  const directNow = now + 60000, below = { ...proposal, price: 8000n, yesShares: 51n };
  const rpc = provider({ directLatest: true, governance: { proposal: below, canExecute: false },
    referenceAt: BigInt(timestamp + 50), reviewStatus: 1n, reviewPrice: 8000n });
  const result = await createLiveDataClient(directConfig, { provider: rpc, fetcher: indexFetcher(),
    now: () => directNow }).readGovernance({ pool, account });
  assert.equal(result.source.displayOnly, true); assert.equal(result.source.transactionReady, false);
  assert.equal(result.data.pool, pool); assert.equal(result.data.account, account);
  assert.equal(result.data.passed, true); assert.equal(result.data.discounted, true);
  assert.equal(result.data.requiredYesShares, 51n); assert.equal(result.data.reviewApproved, true);
  assert.equal(result.data.canExecute, true);
  assert.equal(result.data.saleReference.observedAt, BigInt(timestamp + 50),
    'Latest business rules use the current clock rather than the older indexed block timestamp');
  assert.equal(rpc.calls.length, 5);
  const names = rpc.calls.map(input => {
    assert.equal(input.method, 'eth_call', 'No chain identity, code, storage or canonical block proofs');
    assert.equal(input.params[1], 'latest');
    const iface = input.params[0].data === thresholdView.encodeFunctionData('saleReviewThresholdBps') ? thresholdView
      : input.params[0].to === lens ? abi.PoolLens
      : input.params[0].to === pool ? abi.PoolVault : saleViews;
    return iface.parseTransaction(input.params[0]).name;
  });
  assert.deepEqual(names, ['governance', 'proposalPassed', 'saleReviewThresholdBps', 'saleReference', 'saleReview']);
});

test('fresh direct governance preserves missing Lens fields and required business review gates', async () => {
  const directConfig = { ...config, productFamily: 'fresh-v4', displayOnly: true, stage: 'fresh-active' };
  const below = { ...proposal, price: 8000n, yesShares: 51n };
  for (const change of [{ reviewStatus: 1n, reviewPrice: 7999n }, { reviewStatus: 2n, reviewPrice: 8000n },
    { referenceAt: BigInt(timestamp - 901) }, { reviewReadError: true }]) {
    const rpc = provider({ directLatest: true, governance: { proposal: below, canExecute: true }, ...change });
    const result = await createLiveDataClient(directConfig, { provider: rpc, fetcher: indexFetcher(),
      now: () => now }).readGovernance({ pool, account });
    assert.equal(result.data.canExecute, false);
    assert(rpc.calls.every(input => input.method === 'eth_call' && input.params[1] === 'latest'));
  }
  const rpc = provider({ directLatest: true, governance: { status: { validMask: 1n,
    errorMask: 1n << 11n, trustError: 0n } } });
  const unknown = await createLiveDataClient(directConfig, { provider: rpc, fetcher: indexFetcher(),
    now: () => now }).readGovernance({ pool, account });
  assert.equal(unknown.data.proposal, null); assert.equal(unknown.data.canVote, null);
  assert.equal(unknown.data.canExecute, null); assert.equal(rpc.calls.length, 1);
});

test('governance ignores the fixed old Lens sale threshold after the dual-majority Vault upgrade', async () => {
  const discounted = { ...proposal, price: 9000n, yesShares: 51n };
  const result = await client({}, { governance: { proposal: discounted, discounted: true,
    requiredYesShares: 60n, passed: false, canExecute: false } }).readGovernance({ pool, account });
  assert.equal(result.data.requiredYesShares, 51n);
  assert.equal(result.data.passed, true);
  assert.equal(result.data.discounted, false, 'the current Firsto reference, not purchase cost, sets review need');
  assert.equal(result.data.canExecute, true);
  await assert.rejects(client({}, { governance: { proposal: discounted }, proposalPassed: false })
    .readGovernance({ pool, account }), { code: 'governance_mismatch' });
});

test('genesis governance retains its on-chain 60-share discount rule until activation', async () => {
  const oldConfig = { ...config, stage: 'genesis', manifest: { ...manifest, artifactDigest: GENESIS_ARTIFACT_DIGEST } };
  const discounted = { ...proposal, price: 9000n, yesShares: 55n };
  const c = createLiveDataClient(oldConfig, { provider: provider({ proposalPassed: false,
    governance: { proposal: discounted, discounted: true, requiredYesShares: 60n,
      passed: false, canExecute: false } }), fetcher: indexFetcher(), now: () => now });
  const result = await c.readGovernance({ pool, account });
  assert.equal(result.data.requiredYesShares, 60n);
  assert.equal(result.data.passed, false);
  assert.equal(result.data.canExecute, false);
  assert.equal(result.data.saleReference, null);
});

test('governance never carries Lens canExecute through a missing reference or mismatched review', async () => {
  const below = { ...proposal, price: 8000n, yesShares: 51n };
  for (const options of [{ referenceAt: BigInt(timestamp - 901) },
    { referenceDigest: `0x${'00'.repeat(32)}` }, { referenceReadError: true },
    { reviewStatus: 0n }, { reviewStatus: 1n, reviewPrice: 7999n },
    { reviewStatus: 2n, reviewPrice: 8000n }, { reviewReadError: true }]) {
    const result = await client({}, { ...options, governance: { proposal: below, canExecute: true } }).readGovernance({ pool, account });
    assert.equal(result.data.passed, true);
    assert.equal(result.data.canExecute, false);
  }
  const approved = await client({}, { governance: { proposal: below, canExecute: false },
    reviewStatus: 1n, reviewPrice: 8000n }).readGovernance({ pool, account });
  assert.equal(approved.data.discounted, true);
  assert.equal(approved.data.reviewApproved, true);
  assert.equal(approved.data.canExecute, true);
});

test('activity pagination validates tuple order and keeps event amounts as exact strings', async () => {
  const event = { blockNumber: 10, blockHash, timestamp, transactionHash: txHash, transactionIndex: 1, logIndex: 2,
    contract: pool, pool, source: 'pool', event: 'Deposited', fields: { amount: '123456789012345678901234' } };
  const result = await client({ '/v1/activity': { items: [event], nextCursor: '10:1:2' } }).readActivity({ pool });
  assert.equal(result.items[0].fields.amount, event.fields.amount);
  await assert.rejects(client({ '/v1/activity': { items: [event, event], nextCursor: null } }).readActivity(), { code: 'invalid_activity' });
  const counted = await client({ '/v1/activity': { items: [event], nextCursor: '10:1:2', totalCount: 28, overviewTotalCount: 14 } }).readActivity({ limit: 50 });
  assert.equal(counted.totalCount, 28); assert.equal(counted.overviewTotalCount, 14);
  await assert.rejects(client({ '/v1/activity': { items: [event], nextCursor: null, totalCount: 0, overviewTotalCount: 1 } }).readActivity(), { code: 'invalid_activity' });
  await assert.rejects(client({ '/v1/activity': { items: [event], nextCursor: null, totalCount: 1.2 } }).readActivity(), { code: 'invalid_data' });
});

test('yield exposes harvested/claimed amounts without inventing daily unpaid accrual', async () => {
  const data = { scope: 'pool', pool, account, timezone: 'Asia/Shanghai', token: 'BEM', tokenDecimals: 8,
    buckets: [{ date: new Date((timestamp + 8 * 3600) * 1000).toISOString().slice(0, 10), poolHarvestNetAtomic: '123456789012345678901234', accountClaimedAtomic: '5' }], accountUnclaimedDailyAccrual: null };
  const result = await client({ '/v1/yield': data }).readYield({ pool, account, days: 1 });
  assert.equal(result.data.buckets[0].poolHarvestNetAtomic, 123456789012345678901234n); assert.equal(result.data.accountUnclaimedDailyAccrual, null);
  await assert.rejects(client({ '/v1/yield': { ...data, buckets: [{ ...data.buckets[0], date: '2000-01-01' }] } }).readYield({ pool, account, days: 1 }), { code: 'invalid_yield' });
});

test('portfolio yield accepts the explicit parent scope and preserves receipt and actual claim amounts', async () => {
  const data = { scope: 'portfolio', pool: portfolio, account, timezone: 'Asia/Shanghai', token: 'BEM', tokenDecimals: 8,
    buckets: [{ date: new Date((timestamp + 8 * 3600) * 1000).toISOString().slice(0, 10),
      poolHarvestNetAtomic: '123456789012345678901234', accountClaimedAtomic: '100000005' }], accountUnclaimedDailyAccrual: null };
  const parentClient = (value, inputSource = { ...source, portfolioFactory, portfolioMarket }) => createLiveDataClient(integratedConfig,
    { provider: provider(), fetcher: indexFetcher({ '/v1/yield': value }, inputSource), now: () => now });
  const query = { pool: portfolio, account, days: 1, scope: 'portfolio' };
  const result = await parentClient(data).readYield(query);
  assert.equal(result.data.scope, 'portfolio');
  assert.equal(result.data.buckets[0].poolHarvestNetAtomic, 123456789012345678901234n);
  assert.equal(result.data.buckets[0].accountClaimedAtomic, 100000005n);
  assert.equal(result.data.accountUnclaimedDailyAccrual, null);
  const anonymous = { ...data, account: null, buckets: [{ ...data.buckets[0], accountClaimedAtomic: null }] };
  assert.equal((await parentClient(anonymous).readYield({ ...query, account: undefined })).data.buckets[0].accountClaimedAtomic, null);
  // Scope is a caller requirement, not a permissive union of unrelated ledgers.
  await assert.rejects(parentClient(data).readYield({ ...query, scope: undefined }), { code: 'invalid_yield' });
  await assert.rejects(parentClient({ ...data, scope: 'pool' }).readYield(query), { code: 'invalid_yield' });
  await assert.rejects(parentClient(data).readYield({ ...query, scope: 'all' }), { code: 'invalid_query' });
  for (const field of ['portfolioFactory', 'portfolioMarket']) {
    await assert.rejects(parentClient(data, { ...source, portfolioFactory, portfolioMarket, [field]: addr(999) }).readYield(query), { code: 'index_identity' });
  }
  for (const change of [{ pool }, { account: addr(888) }, { tokenDecimals: 18 }, { timezone: 'UTC' },
    { accountUnclaimedDailyAccrual: '1' }, { buckets: [{ ...data.buckets[0], date: '2000-01-01' }] }]) {
    await assert.rejects(parentClient({ ...data, ...change }).readYield(query), { code: 'invalid_yield' });
  }
  await assert.rejects(parentClient({ ...data, buckets: [{ ...data.buckets[0], poolHarvestNetAtomic: 1 }] }).readYield(query), { code: 'invalid_data' });
  await assert.rejects(parentClient({ ...data, buckets: [{ ...data.buckets[0], accountClaimedAtomic: '-1' }] }).readYield(query), { code: 'invalid_data' });
  await assert.rejects(client({ '/v1/yield': data }).readYield(query), { code: 'index_identity' });
});


test('server materialized display reads return exact page values without any browser RPC request', async()=>{
  const rpc={request:async()=>{throw new Error('display must not call RPC');}}, requests=[];
  const cachedSource={...source,readMode:'verified_snapshot',stale:true,refreshing:false,transactionReady:false,cacheOrigin:'server'};
  const cachedRow={...row({shares:50n,bnbOwed:11n}),trusted:true};
  const fetcher=async url=>{
    const path=new URL(url).pathname;requests.push(path);
    let data;
    if(path.endsWith('/pools/'+pool))data={item:cachedRow};
    else if(path.includes('/positions/'))data={items:[cachedRow],nextCursor:null,marketBnbOwed:13n};
    else if(path.endsWith('/pools'))data={items:[cachedRow],nextCursor:null};
    else if(path.endsWith('/orders'))data={items:[],nextCursor:null};
    else if(path.endsWith('/stats'))data={scope:'confirmed_indexed_history',registeredPoolCount:'1'};
    else throw new Error('unexpected request '+path);
    return new Response(JSON.stringify({source:cachedSource,data},(_key,value)=>typeof value==='bigint'?{$bemineBigInt:value.toString()}:value),
      {status:200,headers:{'content-type':'application/json'}});
  };
  const client=createLiveDataClient({...config,productFamily:'fresh-v4'},{provider:rpc,fetcher,now:()=>now});
  const detail=await client.readDisplayPool({pool,account});assert.equal(detail.item.params.targetRaise,params.targetRaise);
  assert.equal(detail.item.shares,50n);assert.equal(detail.source.transactionReady,false);
  const list=await client.readDisplayPools({account});assert.equal(list.items[0].purchaseCostWei,params.priceCap);
  const holdings=await client.readDisplayPositions({account});assert.equal(holdings.items[0].bnbOwed,11n);assert.equal(holdings.marketBnbOwed,13n);
  assert.deepEqual((await client.readDisplayOrders()).items,[]);
  assert.equal((await client.readDisplayStats()).data.registeredPoolCount,1n);
  assert.equal(requests.length,5);assert(requests.every(path=>path.includes('/v1/display/')));
});

test('display cache outage cannot escalate into chain RPC or legacy index fallback', async () => {
  for (const failure of ['network', 'http']) {
    const requests = []; let rpcCalls = 0;
    const client = createLiveDataClient({ ...config, productFamily: 'fresh-v4', displayOnly: true }, {
      provider: { request: async () => { rpcCalls++; throw new Error('unexpected RPC'); } },
      now: () => now,
      fetcher: async url => {
        requests.push(new URL(url).pathname);
        if (failure === 'network') throw new Error('connection reset');
        return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
      },
    });
    await assert.rejects(client.readDisplayPools(), { code: failure === 'network' ? 'network_unavailable' : 'http_unavailable' });
    assert.equal(requests.length, failure === 'network' ? 2 : 1);
    assert(requests.every(path => path.endsWith('/v1/display/pools')));
    assert.equal(rpcCalls, 0);
  }
});

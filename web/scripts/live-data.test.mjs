import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface, ZeroAddress, getAddress, keccak256, toQuantity } from 'ethers';
import { abi, ARTIFACT_DIGEST } from '../lib/chain-client.mjs';
import { loadLiveConfig, validateManifest, createReadProvider, fetchLiveJson, MANIFEST_KEYS } from '../lib/live-config.mjs';
import { createLiveDataClient, validateIndexSource } from '../lib/live-data.mjs';

const addr = n => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const factory = addr(1), shareMarket = addr(2), lens = addr(3), beacon = addr(4), timelock = addr(5);
const pool = addr(6), account = addr(7), collection = addr(8), origin = 'https://example.test';
const blockHash = `0x${'a1'.repeat(32)}`, deploymentHash = `0x${'b2'.repeat(32)}`, txHash = `0x${'c3'.repeat(32)}`;
const timestamp = 1800000000, now = timestamp * 1000, code = '0x60006000';
const manifest = { schemaVersion: 1, chainId: 56, factory, shareMarket, lens, beacon, timelock,
  deployment: { txHash, blockNumber: 8, blockHash: deploymentHash }, artifactDigest: ARTIFACT_DIGEST,
  sourceCommit: 'a'.repeat(40), verifiedAt: new Date(now).toISOString(), verifiedBlockNumber: 9,
  codehash: Object.fromEntries(MANIFEST_KEYS.map(key => [key, keccak256(code)])) };
const config = { status: 'ready', manifest, origin, basePath: '/bemine',
  indexBaseUrl: `${origin}/api/chain-index`, rpcUrl: `${origin}/api/rpc` };
const source = { chainId: 56, factory, market: shareMarket, startBlock: 8, confirmations: 12,
  indexedThrough: 10, indexedBlockHash: blockHash, indexedTimestamp: timestamp, observedSafeHead: 10,
  complete: true, checkedAt: new Date(now).toISOString(), unknownReason: null };
const params = { circuits: collection, circuitId: 900719925474099312345n,
  targetRaise: 11000000000000000100n, priceCap: 10000000000000000000n,
  directSeller: ZeroAddress, directPrice: 0n, fundingDeadline: BigInt(timestamp + 500), purchaseDeadline: BigInt(timestamp + 1000) };
const bindings = new Interface(['function owner() view returns(address)', 'function factory() view returns(address)',
  'function timelock() view returns(address)', 'function lens() view returns(address)', 'function shareMarket() view returns(address)',
  'function beacon() view returns(address)', 'function VERSION() view returns(uint256)']);
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
      const n = args[0] === 'latest' ? 10n : BigInt(args[0]);
      return { number: toQuantity(n), timestamp: toQuantity(n === 8n ? timestamp - 2 : timestamp),
        hash: n === 8n ? (options.deploymentReorg ? blockHash : deploymentHash) : options.reorg ? deploymentHash : blockHash };
    }
    if (method === 'eth_getCode') return options.badCode ? '0x6001' : code;
    assert.equal(method, 'eth_call'); assert.equal(args[1], toQuantity(options.blockNumber ?? 10n));
    const { to, data } = args[0];
    let iface = to === factory ? abi.PoolFactory : to === lens ? abi.PoolLens : to === shareMarket ? abi.ShareMarket : bindings;
    let parsed = iface.parseTransaction({ data });
    if (!parsed) { iface = bindings; parsed = iface.parseTransaction({ data }); }
    const name = parsed.name; let value;
    if (name === 'lens') value = options.wrongBinding ? addr(99) : lens;
    else if (name === 'factory') value = factory;
    else if (name === 'timelock' || name === 'owner') value = timelock;
    else if (name === 'shareMarket') value = shareMarket;
    else if (name === 'beacon') value = beacon;
    else if (name === 'VERSION') value = options.lensVersion ?? 1n;
    else if (name === 'poolCount') value = BigInt(options.totalPools ?? rows.length);
    else if (name === 'positions') value = { blockNumber: 10n, timestamp: BigInt(timestamp),
      totalPools: BigInt(options.totalPools ?? rows.length), nextCursor: 0n, registryCountValid: true,
      pools: parsed.args[0].map(address => rows.find(r => r.pool === address) ?? row({ pool: address })) };
    else if (name === 'bnbOwed') value = 123456789012345678901234n;
    else if (name === 'orders') value = { seller: account, pool, remaining: options.wrongOrder ? 3n : 5n,
      pricePerUnit: 123456789012345678901234n, active: true };
    else if (name === 'orderExpiresAt') value = BigInt(timestamp + 500);
    else if (name === 'governance') value = governance(options.governance ?? {});
    else throw new Error(`unexpected call ${name}`);
    return iface.encodeFunctionResult(name, [value]);
  } };
}
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
function indexFetcher(routes = {}, inputSource = source) {
  return async url => { const u = new URL(url); assert.equal(u.origin, origin); assert(u.pathname.startsWith('/api/chain-index/'));
    return response({ source: inputSource, data: routes[u.pathname.slice('/api/chain-index'.length)] }); };
}
const poolsData = { items: [{ address: pool, collection, circuitId: params.circuitId.toString(), createdBlock: 9 }], nextCursor: null };
const ordersData = { items: [{ orderId: '7', seller: account, pool, remaining: '5', pricePerUnitWei: '123456789012345678901234',
  expiresAt: String(timestamp + 500), listedBlock: 9, openAtSourceBlock: true, executable: false }], nextCursor: null };
const client = (routes, options, inputSource = source) => createLiveDataClient(config,
  { provider: provider(options), fetcher: indexFetcher(routes, inputSource), now: () => now });

test('standard manifest loads only from same-origin file; prefixed API paths and no demo fallback', async () => {
  const urls = [];
  const ready = await loadLiveConfig({ origin, basePath: '/bemine/', fetcher: async url => { urls.push(url); return response(manifest); } });
  assert.deepEqual(urls, [`${origin}/bemine/data/frontend-manifest.json`]);
  assert.equal(ready.status, 'ready'); assert.equal(ready.rpcUrl, `${origin}/bemine/api/rpc`); assert.equal(ready.indexBaseUrl, `${origin}/bemine/api/chain-index`); assert.equal(ready.journalBase, '/bemine/api/journal');
  const empty = await loadLiveConfig({ origin, fetcher: async () => response({}, 404) });
  assert.equal(empty.status, 'unconfigured'); assert.equal(empty.manifest, undefined);
  assert.throws(() => createLiveDataClient(empty), { code: 'unconfigured' });
});

test('manifest identity, artifact, blocks, addresses and RPC allowlist fail closed', async () => {
  for (const change of [{ chainId: 1 }, { schemaVersion: 2 }, { sourceCommit: '' }, { verifiedBlockNumber: 7 },
    { artifactDigest: blockHash }, { codehash: {} }, { lens: factory }]) assert.throws(() => validateManifest({ ...manifest, ...change }));
  const args = { origin, fetcher: async () => response(manifest), rpcUrl: 'https://unapproved.test/rpc' };
  await assert.rejects(loadLiveConfig(args), { code: 'rpc_not_allowed' });
  const allowed = await loadLiveConfig({ ...args, allowedRpcOrigins: ['https://unapproved.test'] });
  assert.equal(allowed.rpcUrl, args.rpcUrl);
  await assert.rejects(loadLiveConfig({ ...args, rpcUrl: 'http://unapproved.test/rpc', allowedRpcOrigins: ['http://unapproved.test'] }), { code: 'rpc_not_allowed' });
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

test('pools combine index discovery and same-block Lens; exact amounts and unknown mining stay exact', async () => {
  const { items, source: seen, snapshot } = await client({ '/v1/pools': poolsData }).readPools();
  assert.equal(items.length, 1); assert.equal(items[0].id, pool); assert.equal(items[0].tokenId, params.circuitId.toString());
  assert.equal(items[0].targetRaiseWei, params.targetRaise); assert.equal(items[0].members, 3n); assert.equal(items[0].age, 2n);
  assert.equal(items[0].daily, null); assert.equal(items[0].participants, null); assert.equal(items[0].history, null);
  assert.equal(snapshot.blockNumber, BigInt(seen.indexedThrough));
  await assert.rejects(client({ '/v1/pools': { items: [], nextCursor: null } }).readPools(), { code: 'index_coverage' });
  await assert.rejects(client({ '/v1/pools': poolsData }, { reorg: true }).readPools(), { code: 'source_reorg' });
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

test('positions retain zero-share rewards and unknown balances, separating market BNB claims', async () => {
  const route = { [`/v1/accounts/${account}/pools`]: { items: [pool], nextCursor: null } };
  const result = await client(route, { rows: [row({ claimableBEM: 123n })] }).readPositions({ account });
  assert.equal(result.items[0].shares, 0n); assert.equal(result.items[0].claimableBEM, 123n);
  assert.equal(result.items[0].bnbOwed, 0n); assert.equal(result.marketBnbOwed, 123456789012345678901234n);
  const unknown = await client(route, { rows: [row({ status: { validMask: 1n, errorMask: 1n << 14n, trustError: 0n } })] }).readPositions({ account });
  assert.equal(unknown.items.length, 1); assert.equal(unknown.items[0].claimableBEM, null);
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

test('governance reads masks, so unknown eligibility cannot silently be treated as eligible', async () => {
  const result = await client({}).readGovernance({ pool, account });
  assert.equal(result.data.canVote, true); assert.equal(result.data.canExecute, true); assert.equal(result.data.requiredYesCount, 2n);
  const unknown = await client({}, { governance: { status: { validMask: 1n, errorMask: 1n << 11n, trustError: 0n } } }).readGovernance({ pool, account });
  assert.equal(unknown.data.canVote, null); assert.equal(unknown.data.proposal, null);
});

test('activity pagination validates tuple order and keeps event amounts as exact strings', async () => {
  const event = { blockNumber: 10, blockHash, timestamp, transactionHash: txHash, transactionIndex: 1, logIndex: 2,
    contract: pool, pool, source: 'pool', event: 'Deposited', fields: { amount: '123456789012345678901234' } };
  const result = await client({ '/v1/activity': { items: [event], nextCursor: '10:1:2' } }).readActivity({ pool });
  assert.equal(result.items[0].fields.amount, event.fields.amount);
  await assert.rejects(client({ '/v1/activity': { items: [event, event], nextCursor: null } }).readActivity(), { code: 'invalid_activity' });
});

test('yield exposes harvested/claimed amounts without inventing daily unpaid accrual', async () => {
  const data = { scope: 'pool', pool, account, timezone: 'Asia/Shanghai', token: 'BEM', tokenDecimals: 8,
    buckets: [{ date: new Date((timestamp + 8 * 3600) * 1000).toISOString().slice(0, 10), poolHarvestNetAtomic: '123456789012345678901234', accountClaimedAtomic: '5' }], accountUnclaimedDailyAccrual: null };
  const result = await client({ '/v1/yield': data }).readYield({ pool, account, days: 1 });
  assert.equal(result.data.buckets[0].poolHarvestNetAtomic, 123456789012345678901234n); assert.equal(result.data.accountUnclaimedDailyAccrual, null);
  await assert.rejects(client({ '/v1/yield': { ...data, buckets: [{ ...data.buckets[0], date: '2000-01-01' }] } }).readYield({ pool, account, days: 1 }), { code: 'invalid_yield' });
});

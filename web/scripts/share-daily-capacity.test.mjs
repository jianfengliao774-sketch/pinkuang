import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface, getAddress, toQuantity } from 'ethers';
import { fetchMineDetail } from '../../deploy/src/pricing.ts';
import { abi } from '../lib/chain-client.mjs';
import { parseMinerDisplayMetadata, readShareDailyCapacityPrice, shareDailyCapacityPriceWei,
  minerAskPriceWei, minerDailyCapacityPriceWei, poolDailyCapacityPriceWei } from '../lib/share-daily-capacity.mjs';
import { displayPreciseAmount } from '../lib/amount-display.mjs';
import { projectDirectory } from '../lib/project-directory.mjs';

const address = n => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const factory = address(1), pool = address(2), original = '16210', replacement = '16481';
const collection = getAddress('0xb1024b89886b9a34aa4ff5f31c411d708b20a14c');
const otherCollection = getAddress('0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c');
const NFT = new Interface(['function ownerOf(uint256) view returns(address)']);
const hash = `0x${'ab'.repeat(32)}`, sourceHash = `0x${'ef'.repeat(32)}`;
const now = 1_780_000_000_000;
const sharePrice = 68_000_000_000_000_000n;
const pinnedAt = now - 1000, sourceAt = now - 2000;

function detail(overrides = {}) {
  const { mining: miningChanges = {}, ...assetChanges } = overrides;
  return { asset: { collection, tokenId: replacement, owner: pool, category: 'official_mining',
    classification: 'official_mining', ...assetChanges,
    mining: { tokenSymbol: 'BEM', tokenDecimals: 8, status: 'verified',
      estimated24hAtomic: '95000000', sourceBlock: '9', ...miningChanges } } };
}

function rpc(overrides = {}) {
  const calls = [];
  let pinnedReads = 0, sourceReads = 0, chainReads = 0;
  return { calls, async request({ method, params = [] }) {
    calls.push({ method, params });
    assert(['eth_chainId', 'eth_getBlockByNumber', 'eth_call'].includes(method), `Unexpected RPC ${method}`);
    if (method === 'eth_chainId') return ++chainReads > 1 && overrides.finalChain ? overrides.finalChain : overrides.chain ?? '0x38';
    if (method === 'eth_getBlockByNumber') {
      if (params[0] === '0x9') {
        sourceReads++;
        return { number: overrides.sourceNumber ?? '0x9',
          hash: sourceReads > 1 && overrides.sourceReorg ? `0x${'cd'.repeat(32)}` : overrides.sourceHash ?? sourceHash,
          timestamp: overrides.sourceTimestamp ?? toQuantity(BigInt(sourceAt / 1000)) };
      }
      assert(['latest', '0xa', '0xb'].includes(params[0]));
      pinnedReads++;
      return { number: '0xa', hash: pinnedReads > 1 && overrides.reorg ? `0x${'cd'.repeat(32)}` : hash,
        timestamp: overrides.pinnedTimestamp ?? toQuantity(BigInt(pinnedAt / 1000)) };
    }
    assert.equal(params[1], '0xa', 'all identity calls use the pinned block');
    const target = getAddress(params[0].to);
    const iface = target === factory ? abi.PoolFactory : target === pool ? abi.PoolVault : NFT;
    const parsed = iface.parseTransaction(params[0]);
    assert(parsed, `Unknown selector for ${target}`);
    if (parsed.name === 'isPool') return iface.encodeFunctionResult('isPool', [overrides.registered ?? true]);
    if (parsed.name === 'factory') return iface.encodeFunctionResult('factory', [overrides.backlink ?? factory]);
    if (parsed.name === 'params') {
      const value = { circuits: overrides.collection ?? collection, circuitId: overrides.tokenId ?? replacement,
        targetRaise: 1n, priceCap: 1n, directSeller: address(3), directPrice: 0n,
        fundingDeadline: 100n, purchaseDeadline: 200n };
      return iface.encodeFunctionResult('params', [value]);
    }
    assert.equal(parsed.name, 'ownerOf');
    assert.equal(parsed.args[0], BigInt(overrides.tokenId ?? replacement));
    return iface.encodeFunctionResult('ownerOf', [overrides.owner ?? pool]);
  } };
}

const input = (provider, options = {}) => readShareDailyCapacityPrice(provider, {
  factory, pool, pricePerUnitWei: sharePrice, now,
  quoteLoader: async () => detail(), ...options,
});

test('daily capacity price uses exact BigInt and Firsto integer floor rounding', () => {
  assert.equal(shareDailyCapacityPriceWei(sharePrice, '95000000'),
    sharePrice * 100n * 100_000_000n / 95_000_000n);
  const huge = (1n << 255n) + 123n;
  assert.equal(shareDailyCapacityPriceWei(huge, 3n),
    huge * 100n * 100_000_000n / 3n);
  assert.equal(shareDailyCapacityPriceWei(0n, 1n), 0n);
  assert.throws(() => shareDailyCapacityPriceWei(1n, 0n), /unavailable/);
  assert.throws(() => shareDailyCapacityPriceWei(1.1, 1n), /exact bigint/);
});

test('TapeOut 16736 proposed price uses its gross daily BEM output without adding fees', () => {
  // Firsto's current Task 4 / verified weight 1 estimate is 432000 atomic BEM.
  const daily = 432_000n, sale = 15_000_000_000_000_000n;
  const capacity = minerDailyCapacityPriceWei(sale, daily);
  assert.equal(capacity, 3_472_222_222_222_222_222n);
  assert.equal(displayPreciseAmount(capacity), '3.47222');
  assert.equal(shareDailyCapacityPriceWei(sale / 100n, daily), capacity);
  assert.notEqual(capacity, minerDailyCapacityPriceWei(sale * 101n / 100n, daily),
    'buyer fees do not increase the proposal capacity price');
  assert.notEqual(capacity, minerDailyCapacityPriceWei(sale * 99n / 100n, daily),
    'holder settlement fees do not reduce the proposal capacity price');
});

test('fractional wei is truncated instead of overstating either miner or share capacity price', () => {
  assert.equal(minerDailyCapacityPriceWei(1n, 3n), 33_333_333n);
  assert.equal(shareDailyCapacityPriceWei(1n, 3n), 3_333_333_333n);
  assert.equal(minerDailyCapacityPriceWei(3n, 3n), 100_000_000n);
  assert.equal(shareDailyCapacityPriceWei(3n, 3n), 10_000_000_000n);
});

test('TapeOut 12962 uses its 0.1 BNB ask / 0.00432 BEM, not the class reference or funding reserve', async () => {
  const seller = address(12), ask = { status: 'open', maker: seller, collection, tokenId: replacement,
    priceWei: '100000000000000000', buyerCostWei: '101000000000000000', expiry: String(now / 1000 + 3600) };
  const result = await input(rpc({ owner: seller }), { allowUnownedTarget: true,
    pricePerUnitWei: 1_111_000_000_000_000n,
    quoteLoader: async () => ({ ...detail({ owner: seller, mining: { estimated24hAtomic: '432000' },
      listingReference: { priceWei: '33724590960000000', dailyCapacityPriceWei: '7806530000000000000' } }),
      orders: { signedAsks: [ask], asksAndOnchainBids: [] } }) });
  assert.equal(result.available, true);
  assert.equal(result.minerAskPriceWei, 100_000_000_000_000_000n);
  const funding = { status: 'Funding', unitPriceWei: 1_111_000_000_000_000n };
  const capacity = poolDailyCapacityPriceWei(funding, result);
  assert.equal(displayPreciseAmount(capacity), '23.14815');
  assert.notEqual(capacity, result.marketReferencePriceWei);
  assert.notEqual(capacity, result.priceWeiPerDailyBem, 'share-order economics still include their own price');
  assert.equal(poolDailyCapacityPriceWei({ ...funding, status: 'Funded' }, result), capacity);
  assert.equal(displayPreciseAmount(poolDailyCapacityPriceWei({ ...funding, status: 'Listed',
    salePrice: 40_000_000_000_000_000n }, result)), '9.25926');
  assert.equal(displayPreciseAmount(poolDailyCapacityPriceWei({ status: 'Active',
    purchaseCost: 101_000_000_000_000_000n }, result)), '23.37963');
  const other = { pool: address(22), status: 'Funding', funded: 0 };
  const rows = projectDirectory([{ ...funding, pool, funded: 0 }, other], [], {
    sort: 'capacity', capacityFor: row => poolDailyCapacityPriceWei(row,
      row.pool === pool ? result : { ...result, minerAskPriceWei: 50_000_000_000_000_000n }) }).rows;
  assert.equal(rows[0].pool, other.pool, 'sort by miner-specific price rather than the shared class reference');
});

test('own miner price rejects bids, other NFTs/owners/chains, expired and malformed orders', () => {
  const ask = { status: 'open', maker: pool, collection, tokenId: replacement,
    priceWei: '100000000000000000', expiry: String(now / 1000 + 60) };
  const asset = detail().asset;
  for (const change of [{ side: 'bid' }, { tokenId: original }, { collection: otherCollection },
    { maker: address(12) }, { status: 'filled' }, { chainId: 1 },
    { expiry: String(now / 1000) }, { priceWei: '1e17' }, { priceWei: '0' }]) {
    assert.equal(minerAskPriceWei({ asset, orders: { signedAsks: [{ ...ask, ...change }] } }, now), null);
  }
  assert.equal(minerAskPriceWei({ asset, orders: { signedAsks: [ask, { ...ask, priceWei: '200000000000000000' }] } }, now), 100_000_000_000_000_000n);
  assert.equal(minerAskPriceWei({ asset, orders: { asksAndOnchainBids: [{ ...ask, side: 'ask' }] } }, now), 100_000_000_000_000_000n);
  assert.equal(minerAskPriceWei({ asset, orders: { asksAndOnchainBids: [ask] } }, now), null);
});

test('no own ask does not substitute a class average, funding target or price cap', () => {
  const quote = { available: true, estimated24hAtomic: 432000n, minerAskPriceWei: null,
    marketReferencePriceWei: 7806530000000000000n };
  assert.equal(poolDailyCapacityPriceWei({ status: 'Funding', unitPriceWei: 1111000000000000n,
    params: { priceCap: 101000000000000000n } }, quote), null);
  assert.equal(poolDailyCapacityPriceWei({ status: 'Active', purchaseCost: 0n }, quote), null);
  assert.equal(displayPreciseAmount(poolDailyCapacityPriceWei({ status: 'Listed',
    salePrice: 40_000_000_000_000_000n }, quote)), '9.25926', 'a local approved sale does not require a Firsto external ask');
  assert.equal(poolDailyCapacityPriceWei({ status: 'Listed', purchaseCost: 40_000_000_000_000_000n }, quote), null);
  assert.equal(poolDailyCapacityPriceWei({ kind: 'portfolio', status: 'Active', purchaseCost: 1n }, quote), null);
  assert.equal(minerDailyCapacityPriceWei(100000000000000000n, 432000n), 23148148148148148148n);
});

test('uses the actual replacement NFT and its source block, with no sell order required', async () => {
  const provider = rpc();
  let requested;
  const result = await input(provider, { blockNumber: '10', quoteLoader: async (...args) => {
    requested = args; return detail();
  } });
  assert.equal(result.available, true);
  assert.deepEqual(requested, [collection, replacement]);
  assert.notEqual(result.tokenId, original);
  assert.equal(result.estimated24hAtomic, 95_000_000n);
  assert.equal(result.observedAt, sourceAt);
  assert.equal(result.validUntil, sourceAt + 300_000);
  assert.equal(result.miningSourceBlock, 9n);
  assert.equal(result.priceWeiPerDailyBem, sharePrice * 100n * 100_000_000n / 95_000_000n);
  assert.equal(result.basis, 'gross_estimated_output');
  assert(provider.calls.every(call => ['eth_call', 'eth_chainId', 'eth_getBlockByNumber'].includes(call.method)));
});

test('independent RPC and Firsto reads overlap without skipping final chain or block checks', async () => {
  const base = rpc();
  const deferred = () => {
    let resolve;
    return { promise: new Promise(done => { resolve = done; }), resolve: () => resolve() };
  };
  const groups = Object.fromEntries(['initial', 'identity', 'final'].map(name => [name, {
    gate: deferred(), started: deferred(), seen: new Set(),
  }]));
  const mark = async (name, value, expected) => {
    const group = groups[name];
    group.seen.add(value);
    if (group.seen.size === expected) group.started.resolve();
    await group.gate.promise;
  };
  let chainReads = 0, sourceReads = 0;
  const provider = { async request({ method, params = [] }) {
    if (method === 'eth_chainId') {
      chainReads++;
      await mark(chainReads === 1 ? 'initial' : 'final', 'chain', chainReads === 1 ? 2 : 3);
    } else if (method === 'eth_getBlockByNumber') {
      if (params[0] === 'latest') await mark('initial', 'block', 2);
      if (params[0] === '0x9' && ++sourceReads === 2) await mark('final', 'source', 3);
      if (params[0] === '0xa') await mark('final', 'pinned', 3);
    } else if (method === 'eth_call' && getAddress(params[0].to) === collection) {
      await mark('identity', 'owner', 2);
    }
    return base.request({ method, params });
  } };
  const quoteLoader = async () => {
    await mark('identity', 'quote', 2);
    return detail();
  };
  const run = input(provider, { quoteLoader });
  const startedWithin = async group => {
    let timer;
    try {
      await Promise.race([groups[group].started.promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${group} reads did not overlap`)), 1000);
      })]);
    } finally { clearTimeout(timer); }
  };
  try {
    await startedWithin('initial');
    groups.initial.gate.resolve();
    await startedWithin('identity');
    groups.identity.gate.resolve();
    await startedWithin('final');
    groups.final.gate.resolve();
    const result = await run;
    assert.equal(result.available, true);
    assert.equal(chainReads, 2, 'chain identity is checked again after the quote');
    assert.equal(sourceReads, 2, 'source block is read before and after the quote');
  } finally {
    for (const group of Object.values(groups)) group.gate.resolve();
    await run;
  }
});

test('funding pool may display its exact external target with chain-matched owner and Firsto reference', async () => {
  const seller = address(12);
  const result = await input(rpc({ owner: seller }), { allowUnownedTarget: true,
    quoteLoader: async () => detail({ owner: seller, listingReference: { dailyCapacityPriceWei: '8100000000000000000' } }) });
  assert.equal(result.available, true);
  assert.equal(result.marketReferencePriceWei, 8100000000000000000n);
  assert.deepEqual(await input(rpc({ owner: seller }), { allowUnownedTarget: true,
    quoteLoader: async () => detail({ owner: address(13) }) }), { available: false, reason: 'quote_identity' });
});

test('default loader fetches only the bounded exact Firsto detail, never text search pages', async () => {
  const originalFetch = globalThis.fetch, seen = [];
  globalThis.fetch = async (url, init) => { seen.push({ url, init }); return Response.json(detail()); };
  try {
    const result = await readShareDailyCapacityPrice(rpc(), { factory, pool, pricePerUnitWei: sharePrice, now });
    assert.equal(result.available, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, `/pinkuang-deploy/firsto-api/v1/circuit/${collection.toLowerCase()}/${replacement}?display=1`);
    assert.equal(seen[0].init.method, 'GET');
    assert.equal(seen[0].init.credentials, 'omit');
    assert.equal(seen[0].init.redirect, 'error');
  } finally { globalThis.fetch = originalFetch; }
});

test('exact detail reader rejects counterfeit assets and oversized responses', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return new Response(' '.repeat(2_000_001),
    { headers: { 'content-type': 'application/json' } }); };
  await assert.rejects(fetchMineDetail(address(8), replacement, { fetcher }), /官方/);
  assert.equal(calls, 0);
  await assert.rejects(fetchMineDetail(collection, replacement, { baseUrl: '/pinkuang-deploy/firsto-api', fetcher }), /读取上限/);
  assert.equal(calls, 1);
});

test('unknown/stale/wrong Firsto capacity stays unavailable without changing order price', async () => {
  const order = Object.freeze({ pricePerUnitWei: sharePrice, remaining: 7n });
  const cases = [
    [{ tokenId: original }, 'quote_identity'],
    [{ collection: otherCollection }, 'quote_identity'],
    [{ owner: address(9) }, 'quote_identity'],
    [{ category: 'other' }, 'quote_identity'],
    [{ classification: 'other' }, 'quote_identity'],
    [{ mining: { tokenSymbol: 'OTHER' } }, 'quote_identity'],
    [{ mining: { tokenDecimals: 18 } }, 'quote_identity'],
    [{ mining: { status: 'inactive' } }, 'quote_identity'],
    [{ mining: { sourceBlock: null } }, 'stale_quote'],
    [{ mining: { sourceBlock: '11' } }, 'stale_quote'],
    [{ mining: { estimated24hAtomic: '0' } }, 'missing_output'],
    [{ mining: { estimated24hAtomic: 95_000_000 } }, 'missing_output'],
  ];
  for (const [change, reason] of cases) {
    const result = await input(rpc(), { pricePerUnitWei: order.pricePerUnitWei,
      quoteLoader: async () => detail(change) });
    assert.deepEqual(result, { available: false, reason });
    assert.equal(order.pricePerUnitWei, sharePrice);
    assert.equal(order.remaining, 7n);
  }
  assert.deepEqual(await input(rpc(), { quoteLoader: async () => { throw new Error('API outage'); } }),
    { available: false, reason: 'unavailable' });
});

test('source block must be canonical, present and no more than five minutes old', async () => {
  for (const [change, reason] of [
    [{ sourceTimestamp: toQuantity(BigInt(Math.floor((now - 300_001) / 1000))) }, 'stale_quote'],
    [{ sourceTimestamp: toQuantity(BigInt((now + 1000) / 1000)) }, 'stale_quote'],
    [{ sourceNumber: '0x8' }, 'stale_quote'],
    [{ sourceHash: '0x0' }, 'stale_quote'],
    [{ sourceReorg: true }, 'chain_changed'],
  ]) assert.deepEqual(await input(rpc(change)), { available: false, reason });
});

test('rejects invalid pool, NFT ownership, chain and reorg before exposing a price', async () => {
  for (const [change, reason] of [
    [{ chain: '0x1' }, 'wrong_chain'],
    [{ registered: false }, 'untrusted_pool'],
    [{ backlink: address(8) }, 'untrusted_pool'],
    [{ collection: address(11) }, 'unsupported_miner'],
    [{ owner: address(12) }, 'miner_not_in_pool'],
    [{ reorg: true }, 'chain_changed'],
    [{ finalChain: '0x1' }, 'chain_changed'],
    [{ pinnedTimestamp: toQuantity(BigInt((now - 301_000) / 1000)) }, 'invalid_block'],
  ]) {
    assert.deepEqual(await input(rpc(change)), { available: false, reason });
  }
  assert.deepEqual(await input(rpc(), { blockNumber: '11' }), { available: false, reason: 'invalid_block' });
});

test('live capacity read repins and rechecks identity when the quote overtakes its first block', async () => {
  const base = rpc(); let latestReads = 0; const identityTags = [];
  const advanced = { number: '0xb', hash: `0x${'12'.repeat(32)}`, timestamp: toQuantity(BigInt(now / 1000)) };
  const provider = { async request({ method, params = [] }) {
    if (method === 'eth_getBlockByNumber' && ((params[0] === 'latest' && ++latestReads > 1) || params[0] === '0xb')) return advanced;
    if (method === 'eth_call' && params[1] === '0xb') {
      identityTags.push(params[0].to);
      return base.request({ method, params: [params[0], '0xa'] });
    }
    return base.request({ method, params });
  } };
  const result = await input(provider, { quoteLoader: async () => detail({ mining: { sourceBlock: '11' } }) });
  assert.equal(result.available, true);
  assert.equal(result.sourceBlock, 11n);
  assert.equal(result.miningSourceBlock, 11n);
  assert.equal(result.observedAt, now);
  assert.equal(identityTags.length, 4, 'registration, factory, target and ownership are rechecked');
});

test('a historical read never advances to a newer external quote', async () => {
  const result = await input(rpc(), { blockNumber: '10',
    quoteLoader: async () => detail({ mining: { sourceBlock: '11' } }) });
  assert.deepEqual(result, { available: false, reason: 'stale_quote' });
});

test('repinning rejects a changed owner instead of attaching capacity to an outdated miner', async () => {
  const base = rpc(); let latestReads = 0;
  const advanced = { number: '0xb', hash: `0x${'12'.repeat(32)}`, timestamp: toQuantity(BigInt(now / 1000)) };
  const provider = { async request({ method, params = [] }) {
    if (method === 'eth_getBlockByNumber' && params[0] === 'latest' && ++latestReads > 1) return advanced;
    if (method === 'eth_call' && params[1] === '0xb') {
      if (getAddress(params[0].to) === collection) return NFT.encodeFunctionResult('ownerOf', [address(20)]);
      return base.request({ method, params: [params[0], '0xa'] });
    }
    return base.request({ method, params });
  } };
  const result = await input(provider, { quoteLoader: async () => detail({ mining: { sourceBlock: '11' } }) });
  assert.deepEqual(result, { available: false, reason: 'quote_identity' });
});

test('display metadata requires an identity-checked and internally consistent Firsto snapshot', async () => {
  assert.deepEqual(parseMinerDisplayMetadata({ status: 'verified', taskId: '4', weight: '12', verifiedWeight: '12', unverifiedWeight: '0' }),
    { taskId: '4', miningClassification: 'verified', hashPower: '12' });
  assert.deepEqual(parseMinerDisplayMetadata({ status: 'unverified', taskId: '0', weight: '6', verifiedWeight: '0', unverifiedWeight: '6' }),
    { taskId: '0', miningClassification: 'unverified', hashPower: '6' });
  for (const changes of [{ status: 'unknown' }, { weight: '13' }, { unverifiedWeight: '1' },
    { verifiedWeight: null }, { taskId: '0' }, { taskId: '4294967296' }]) {
    const value = parseMinerDisplayMetadata({ status: 'verified', taskId: '4', weight: '12',
      verifiedWeight: '12', unverifiedWeight: '0', ...changes });
    assert.equal(value.miningClassification, null);
  }
  const data = detail({ mining: { taskId: '4', weight: '12', verifiedWeight: '12', unverifiedWeight: '0' } });
  const result = await input(rpc(), { quoteLoader: async () => data });
  assert.equal(result.metadataAvailable, true);
  assert.equal(result.taskId, '4');
  assert.equal(result.hashPower, '12');
  const stale = await input(rpc({ sourceTimestamp: toQuantity(BigInt((now - 301_000) / 1000)) }),
    { quoteLoader: async () => data });
  assert.equal(stale.metadataAvailable, undefined);
});

test('unverified metadata never creates a verified output estimate', async () => {
  const result = await input(rpc(), { quoteLoader: async () => detail({ mining: {
    status: 'unverified', taskId: '0', weight: '1', verifiedWeight: '0', unverifiedWeight: '1',
    estimated24hAtomic: null,
  } }) });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'unverified_output');
  assert.equal(result.metadataAvailable, true);
  assert.equal(result.miningClassification, 'unverified');
  assert.equal(result.hashPower, '1');
  assert.equal(result.estimated24hAtomic, undefined);
});

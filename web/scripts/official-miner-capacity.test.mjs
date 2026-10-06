import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Interface, getAddress, toQuantity, ZeroAddress } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { readShareDailyCapacityPrice, poolDailyCapacityPriceWei } from '../lib/share-daily-capacity.mjs';
import { createCapacityRequestCache } from '../lib/capacity-request-cache.mjs';
import { readCapacityDisplay, writeCapacityDisplay } from '../lib/capacity-display-cache.mjs';

const addr = n => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const factory = addr(1), pool = addr(2), seller = addr(3);
const collection = getAddress('0xb1024b89886b9a34aa4ff5f31c411d708b20a14c');
const behemoth = getAddress('0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c');
const market = getAddress('0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f');
const MARKET = new Interface(['function listingFor(address,uint256) view returns(uint256 id,address seller,uint96 price,bool valid)']);
const NFT = new Interface(['function ownerOf(uint256) view returns(address)']);
const initialNow = 1_780_000_000_000, ask = 100_000_000_000_000_000n, daily = 432_000n;
const params = { circuits: collection, circuitId: 14281n, targetRaise: 888n, priceCap: 999n,
  directSeller: seller, directPrice: 777n, fundingDeadline: 100n, purchaseDeadline: 200n };
const manifest = { artifactDigest: `0x${'ab'.repeat(32)}`, factory, chainId: 56, shareMarket: addr(4) };
const input = { factory, pool, params, pricePerUnitWei: 10n, displayOnly: true,
  allowUnownedTarget: true, includeOfficialAsk: true, now: initialNow };
function detail({ owner = seller, circuits = collection, tokenId = '14281', mining = {}, orders = [] } = {}) {
  return { asset: { collection: circuits, tokenId, owner, category: 'official_mining', classification: 'official_mining',
    mining: { tokenSymbol: 'BEM', tokenDecimals: 8, status: 'verified', estimated24hAtomic: daily.toString(),
      sourceBlock: '9', taskId: '4', weight: '1', verifiedWeight: '1', unverifiedWeight: '0', ...mining } },
    orders: { signedAsks: orders } };
}
const firsto = (changes = {}) => ({ status: 'open', side: 'ask', chainId: 56, collection,
  tokenId: '14281', maker: seller, priceWei: (ask / 2n).toString(), expiry: String(initialNow / 1000 + 3600), ...changes });
function rpc({ listing = [1n, seller, ask, true], owner = seller, listingError = false,
  ownerError = false, malformed = false, repin = false, reorg = false } = {}) {
  const calls = []; let latest = 0, finalReads = 0;
  return { calls, async request(request) {
    calls.push(request); const { method, params: args = [] } = request;
    if (method === 'eth_chainId') return '0x38';
    if (method === 'eth_getBlockByNumber') {
      const number = args[0] === 'latest' ? (repin && ++latest > 1 ? 11n : 10n) : BigInt(args[0]);
      const timestamp = initialNow / 1000 - (number === 9n ? 2 : number === 10n ? 1 : 0);
      if (args[0] !== 'latest' && number >= 10n) finalReads++;
      return { number: toQuantity(number), timestamp: toQuantity(timestamp),
        hash: `0x${(reorg && finalReads > 0 ? 'cd' : number === 9n ? 'ef' : 'ab').repeat(32)}` };
    }
    assert.equal(method, 'eth_call');
    assert(['latest', '0xa', '0xb'].includes(args[1]));
    const to = getAddress(args[0].to);
    const iface = to === market ? MARKET : to === factory ? abi.PoolFactory : to === pool ? abi.PoolVault : NFT;
    const call = iface.parseTransaction(args[0]);
    if (call.name === 'listingFor') {
      assert.equal(call.args[0], collection); assert.equal(call.args[1], params.circuitId);
      if (listingError) throw new Error('read unavailable');
      return malformed ? '0x00' : iface.encodeFunctionResult('listingFor', listing);
    }
    if (call.name === 'ownerOf') {
      assert.equal(to, collection); assert.equal(call.args[0], params.circuitId);
      if (ownerError) throw new Error('owner unavailable');
      return iface.encodeFunctionResult('ownerOf', [owner]);
    }
    if (call.name === 'isPool') return iface.encodeFunctionResult('isPool', [true]);
    if (call.name === 'factory') return iface.encodeFunctionResult('factory', [factory]);
    assert.equal(call.name, 'params'); return iface.encodeFunctionResult('params', [params]);
  } };
}
async function load(provider, options = {}) {
  let detailCalls = 0;
  const quote = await readShareDailyCapacityPrice(provider, { ...input,
    quoteLoader: async (circuits, tokenId) => { detailCalls++; assert.equal(circuits, collection);
      assert.equal(tokenId, '14281'); return detail(); }, ...options });
  return { quote, detailCalls };
}

test('official-only listing supplies Funding/Funded capacity with two reads and one exact detail', async () => {
  const provider = rpc(); const { quote, detailCalls } = await load(provider);
  assert.equal(quote.available, true); assert.equal(quote.estimated24hAtomic, daily);
  assert.equal(quote.minerAskPriceWei, ask); assert.equal(quote.minerAskSource, 'official');
  assert.equal(quote.officialAskStatus, 'ready'); assert.match(quote.sourceUrl, /^https:\/\/bscscan.com\/address\//);
  assert.equal(quote.miningSourceUrl, 'https://tapeout.firsto.ai/circuits');
  for (const status of ['Funding', 'Funded']) assert.equal(poolDailyCapacityPriceWei({ status }, quote), ask * 100_000_000n / daily);
  assert.equal(detailCalls, 1); assert.equal(provider.calls.length, 2);
  assert(provider.calls.every(row => row.method === 'eth_call' && row.params[1] === 'latest'));
});

test('official ask has priority over a cheaper lawful Firsto ask', async () => {
  const { quote } = await load(rpc(), { quoteLoader: async () => detail({ orders: [firsto()] }) });
  assert.equal(quote.minerAskPriceWei, ask); assert.equal(quote.minerAskSource, 'official');
});

test('absent official listing uses only an unexpired same-NFT Firsto ask of the current owner', async () => {
  for (const bad of [{ maker: addr(9) }, { tokenId: '14277' }, { collection: behemoth },
    { side: 'bid' }, { chainId: 1 }, { expiry: String(initialNow / 1000) }, { priceWei: '0' }]) {
    const { quote } = await load(rpc({ listing: [0n, ZeroAddress, 0n, false] }),
      { quoteLoader: async () => detail({ orders: [firsto(bad), firsto()] }) });
    assert.equal(quote.minerAskSource, 'firsto'); assert.equal(quote.minerAskPriceWei, ask / 2n);
    assert.equal(quote.officialAskStatus, 'absent'); assert.equal(quote.sourceUrl, quote.miningSourceUrl);
  }
});

test('sold, zero and invalid official listings retain daily output but never use funding parameters as price', async () => {
  for (const listing of [[0n, seller, ask, true], [1n, seller, 0n, true], [1n, seller, ask, false],
    [1n, addr(7), ask, true], [0n, ZeroAddress, 0n, false]]) {
    const { quote } = await load(rpc({ listing }));
    assert.equal(quote.available, true); assert.equal(quote.estimated24hAtomic, daily);
    assert.equal(quote.minerAskPriceWei, null); assert.equal(quote.minerAskSource, null);
    assert.equal(quote.officialAskStatus, 'absent');
    assert.equal(poolDailyCapacityPriceWei({ status: 'Funding', ...params }, quote), null);
    assert.equal(quote.metadataAvailable, true); assert.equal(quote.taskId, '4');
  }
});

test('changed ownership rejects stale Firsto asks even when the daily detail still describes the same NFT', async () => {
  const { quote } = await load(rpc({ owner: addr(10), listing: [1n, seller, ask, true] }),
    { quoteLoader: async () => detail({ orders: [firsto()] }) });
  assert.equal(quote.available, true); assert.equal(quote.minerAskPriceWei, null);
  assert.equal(quote.officialAskStatus, 'absent'); assert.equal(quote.estimated24hAtomic, daily);
});

test('official failure and malformed replies do not erase output or reuse an official price', async () => {
  for (const changes of [{ listingError: true }, { malformed: true }, { ownerError: true }, { owner: ZeroAddress }]) {
    const provider = rpc(changes); const { quote } = await load(provider);
    assert.equal(quote.available, true); assert.equal(quote.estimated24hAtomic, daily);
    assert.equal(quote.minerAskPriceWei, null); assert.equal(quote.officialAskStatus, 'unavailable');
    assert.equal(provider.calls.length, 2);
  }
  const quote = (await load({ request() { throw new Error('sync unavailable'); } })).quote;
  assert.equal(quote.available, true); assert.equal(quote.officialAskStatus, 'unavailable');
});

test('a failed official listing read can use Firsto only after a successful current-owner read', async () => {
  const options = { quoteLoader: async () => detail({ orders: [firsto()] }) };
  const fallback = (await load(rpc({ listingError: true }), options)).quote;
  assert.equal(fallback.minerAskSource, 'firsto'); assert.equal(fallback.officialAskStatus, 'unavailable');
  const unknown = (await load(rpc({ ownerError: true }), options)).quote;
  assert.equal(unknown.available, true); assert.equal(unknown.minerAskPriceWei, null);
});

test('display ask is bound to the official current target and exact BEM detail identity', async () => {
  for (const wrong of [{ tokenId: '14277' }, { circuits: behemoth }, { mining: { tokenSymbol: 'OTHER' } },
    { mining: { tokenDecimals: 18 } }]) {
    const provider = rpc();
    const { quote } = await load(provider, { quoteLoader: async () => detail(wrong) });
    assert.equal(quote.available, false); assert.equal(quote.reason, 'quote_identity');
    assert.equal(provider.calls.length, 0, 'invalid external identity must not spend ask RPC quota');
  }
  let requests = 0;
  const { quote } = await load({ request() { requests++; } }, { params: { ...params, circuits: addr(8) } });
  assert.equal(quote.reason, 'unsupported_miner'); assert.equal(requests, 0);
});

test('daily-only holdings/share-order quotes make zero optional official-market reads', async () => {
  const provider = rpc(); const { quote } = await load(provider, { includeOfficialAsk: false });
  assert.equal(quote.available, true); assert.equal(quote.includeOfficialAsk, false);
  assert.equal(quote.officialAskStatus, 'not_requested'); assert.equal(provider.calls.length, 0);
  // Active and Listed continue to use their own verified acquisition/sale amounts.
  assert.equal(poolDailyCapacityPriceWei({ status: 'Active', purchaseCost: 20n }, quote), 20n * 100_000_000n / daily);
  assert.equal(poolDailyCapacityPriceWei({ status: 'Listed', salePrice: 30n }, quote), 30n * 100_000_000n / daily);
});

test('strict quotes reuse verified ownership, adding one final pinned official listing read', async () => {
  const provider = rpc(); const { quote } = await load(provider, { displayOnly: false });
  assert.equal(quote.available, true); assert.equal(quote.sourceBlock, 10n); assert.equal(quote.minerAskSource, 'official');
  const calls = provider.calls.filter(row => row.method === 'eth_call');
  assert.equal(calls.length, 5); assert(calls.every(row => row.params[1] === '0xa'));
  assert.equal(calls.filter(row => getAddress(row.params[0].to) === collection).length, 1);
});

test('strict mining-source repin reads the listing only at the final block', async () => {
  const provider = rpc({ repin: true });
  const { quote } = await load(provider, { displayOnly: false, quoteLoader: async () => detail({ mining: { sourceBlock: '11' } }) });
  assert.equal(quote.available, true); assert.equal(quote.sourceBlock, 11n);
  const official = provider.calls.filter(row => row.method === 'eth_call' && getAddress(row.params[0].to) === market);
  assert.equal(official.length, 1); assert.equal(official[0].params[1], '0xb');
});

test('strict official read failure preserves a valid daily estimate but stale/reorg sources stay rejected', async () => {
  const good = (await load(rpc({ listingError: true }), { displayOnly: false })).quote;
  assert.equal(good.available, true); assert.equal(good.officialAskStatus, 'unavailable'); assert.equal(good.minerAskPriceWei, null);
  const stale = (await load(rpc(), { displayOnly: false, quoteLoader: async () => detail({ mining: { sourceBlock: '11' } }), blockNumber: 10n })).quote;
  assert.equal(stale.available, false); assert.equal(stale.reason, 'stale_quote');
  const changed = (await load(rpc({ reorg: true }), { displayOnly: false })).quote;
  assert.equal(changed.available, false); assert.equal(changed.reason, 'chain_changed');
});

test('30-second redraws share one exact Firsto request and two optional RPC reads per five-minute interval', async () => {
  let now = initialNow, quotes = 0;
  const provider = rpc(), context = { ...input, manifest };
  const cache = createCapacityRequestCache({ now: () => now });
  const loader = () => readShareDailyCapacityPrice(provider, { ...context, now,
    quoteLoader: async () => { quotes++; return detail(); } });
  const first = await cache.read(context, loader);
  for (let tick = 1; tick < 10; tick++) {
    now = initialNow + tick * 30_000;
    assert.equal(await cache.read(context, loader), first);
  }
  assert.equal(quotes, 1); assert.equal(provider.calls.length, 2);
  now = first.validUntil;
  await Promise.all([cache.read(context, loader), cache.read(context, loader, { force: true })]);
  assert.equal(quotes, 2); assert.equal(provider.calls.length, 4);
});

test('manual retry replaces a previously official ask with unavailable instead of retaining its old price', async () => {
  let now = initialNow;
  const context = { ...input, manifest }, storage = new Map();
  const store = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const cache = createCapacityRequestCache({ now: () => now });
  const first = await cache.read(context, () => readShareDailyCapacityPrice(rpc(), { ...context, now, quoteLoader: async () => detail() }));
  assert.equal(writeCapacityDisplay(store, manifest, first, { now }), true);
  now += 10_000;
  const failed = await cache.read(context, () => readShareDailyCapacityPrice(rpc({ listingError: true }),
    { ...context, now, quoteLoader: async () => detail() }), { force: true });
  assert.equal(failed.available, true); assert.equal(failed.minerAskPriceWei, null);
  assert.equal(writeCapacityDisplay(store, manifest, failed, { now }), true);
  const saved = readCapacityDisplay(store, manifest, pool, context.pricePerUnitWei, { now, includeOfficialAsk: true });
  assert.equal(saved.minerAskPriceWei, null); assert.equal(saved.officialAskStatus, 'unavailable');
});

test('actual page input opts in only for fundraising catalog/detail and never share market or holdings', async () => {
  const source = await readFile(new URL('../components/LivePlatform.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const poolCapacityInput = row =>');
  const end = source.indexOf('  const capacityCell =', start);
  assert(start >= 0 && end > start);
  const create = new Function('client', 'config', 'route', `${source.slice(start, end)}; return { poolCapacityInput, orderCapacityInput };`);
  for (const route of ['pools', 'detail', 'overview', 'rewards', 'market', 'home']) {
    const fns = create({ manifest }, { factory, displayOnly: true }, { route });
    for (const status of ['Funding', 'Funded', 'Active', 'Listed', 'Refunding']) {
      assert.equal(fns.poolCapacityInput({ ...params, params, pool, unitPriceWei: 10n, status }).includeOfficialAsk,
        ['pools', 'detail'].includes(route) && ['Funding', 'Funded'].includes(status));
    }
    assert.equal(fns.orderCapacityInput({ pool, pricePerUnitWei: 10n }).includeOfficialAsk, false);
  }
});


test('missing, unverified or failed Firsto daily estimates never spend optional official ask RPC quota', async () => {
  for (const mining of [{ estimated24hAtomic: '0' }, { estimated24hAtomic: null },
    { estimated24hAtomic: 'not-an-integer' }, { status: 'unverified' }]) {
    const provider = rpc(); const { quote } = await load(provider, { quoteLoader: async () => detail({ mining }) });
    assert.equal(quote.available, false); assert.equal(quote.reason, 'missing_output');
    assert.equal(quote.metadataAvailable, true); assert.equal(provider.calls.length, 0);
  }
  const provider = rpc();
  const { quote } = await load(provider, { quoteLoader: async () => { throw new Error('Firsto unavailable'); } });
  assert.equal(quote.available, false); assert.equal(provider.calls.length, 0);
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Interface, ZeroAddress } from 'ethers';
import { DESIGNATED_MINING_ABI, DESIGNATED_NFT_ABI } from '../shared/designated-purchase-runtime.mjs';
import { firstoProvider, signedSource } from './fixtures/firsto-order.mjs';
import { KEEPER_POOL_ABI, LISTING_ABI, OFFICIAL_COLLECTIONS, OFFICIAL_MARKET,
  MINING, createKeeperRuntime, parseArguments, runKeeperCycle } from './purchase-keeper.mjs';

const factory = '0x1111111111111111111111111111111111111111';
const pool = '0x2222222222222222222222222222222222222222';
const seller = '0x3333333333333333333333333333333333333333';
const candidateSeller = '0x4444444444444444444444444444444444444444';
const newOriginalOwner = '0x5555555555555555555555555555555555555555';
const collection = OFFICIAL_COLLECTIONS[0];
const digest = `0x${'ab'.repeat(32)}`;

const minerResult = tokenId => [collection, tokenId, 7, 0, 0, 0, 0, 0, 0, 1,
  seller, 0, 0, 0, 0, false, 0, 0, 0, 1, 0, 0];
const feed = () => Response.json({ rows: [{ collection, tokenId: '2', category: 'official_mining',
  mining: { taskId: 7, status: 'verified', verifiedWeight: '1', unverifiedWeight: '0',
    estimated24hAtomic: '999999999999999999' },
  bestAsk: { venue: 'official', priceWei: '1', buyerCostWei: '999999999999999999' } }],
  sourceBlock: '49', totalPages: 1 });

function mockChain(referenceId = 1n, blockNumber = 50, chainTime = 1000) {
  const poolAbi = new Interface(KEEPER_POOL_ABI), marketAbi = new Interface(LISTING_ABI);
  const miningAbi = new Interface(DESIGNATED_MINING_ABI), nftAbi = new Interface(DESIGNATED_NFT_ABI);
  const factoryAbi = new Interface(['function isPool(address) view returns(bool)']);
  const data = { owner: seller, referenceSeller: seller, originalListed: true, originalMarketApproved: true,
    originalListingMismatch: false, originalSimulationFails: false,
    miningWeight: 1n, candidateAsk: 1000n, reads: [], estimates: [] };
  const provider = {
    getNetwork: async () => ({ chainId: 56n }),
    getBlock: async () => ({ number: blockNumber, timestamp: chainTime, gasLimit: 30_000_000n }),
    getCode: async () => '0x6000', getBalance: async () => 1200n,
    call: async transaction => {
      const to = transaction.to.toLowerCase();
      const abi = to === pool.toLowerCase() ? poolAbi : to === factory.toLowerCase() ? factoryAbi
        : to === OFFICIAL_MARKET.toLowerCase() ? marketAbi : to === MINING.toLowerCase() ? miningAbi : nftAbi;
      const decoded = abi.parseTransaction({ data: transaction.data });
      const name = decoded.name; data.reads.push(name);
      let result;
      if (name === 'isPool') result = [true];
      else if (name === 'factory' || name === 'OFFICIAL_FACTORY') result = [factory];
      else if (name === 'state') result = [1];
      else if (name === 'params') result = [[collection, referenceId, 1200, 1155, ZeroAddress, 0, chainTime + 500, chainTime + 1000]];
      else if (name === 'flexiblePurchase') result = [false, 0, [0, 0, 0, 0, 0, 0, digest]];
      else if (name === 'purchaseModel') result = [false, 0];
      else if (name === 'purchaseReferenceWeight') result = [0];
      else if (name === 'designatedPurchase') result = [true, referenceId, 7, 1,
        [data.referenceSeller, 1000, 1050, 864000, chainTime - 100, 40, digest]];
      else if (name === 'totalRaised') result = [1200];
      else if (name === 'totalBnbOwed') result = [0];
      else if (name === 'ownerOf') result = [BigInt(decoded.args[0]) === referenceId ? data.owner : candidateSeller];
      else if (name === 'getApproved') result = [data.originalMarketApproved ? OFFICIAL_MARKET : ZeroAddress];
      else if (name === 'isApprovedForAll') result = [false];
      else if (name === 'listingFor') {
        const id = BigInt(decoded.args[1]);
        result = id === referenceId ? data.originalListed ? [101, data.owner, 1000, true]
          : [0, ZeroAddress, 0, false] : [102, candidateSeller, data.candidateAsk, true];
      } else if (name === 'listingView') {
        const id = BigInt(decoded.args[0]);
        result = id === 101n ? [data.originalListingMismatch ? candidateSeller : data.owner,
          collection, referenceId, 1000, 100, data.originalListed]
          : [candidateSeller, collection, 2, data.candidateAsk, 100, true];
      } else if (name === 'minerKey') result = [`0x${BigInt(decoded.args[1]).toString(16).padStart(64, '0')}`];
      else if (name === 'getMiner') {
        const tokenId = BigInt(decoded.args[0]);
        const miner = minerResult(tokenId);
        miner[19] = data.miningWeight;
        result = [miner];
      } else if (name === 'currentRate') result = [100];
      else if (name === 'UNVERIFIED_BPS') result = [0];
      else if (name === 'totalVerifWeight') result = [10];
      else throw new Error(`Unexpected read ${name}`);
      return abi.encodeFunctionResult(name, result);
    },
    estimateGas: async transaction => {
      const decoded = poolAbi.parseTransaction({ data: transaction.data });
      data.estimates.push(decoded.name);
      if (data.originalSimulationFails && decoded.name === 'buyFromMarket') throw new Error('simulation unavailable');
      return 100_000n;
    },
  };
  return { provider, data };
}

function options(t) {
  const dir = mkdtempSync(join(tmpdir(), 'designated-keeper-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { factory, pool, journal: join(dir, 'journal.json'), send: false, once: true,
    venue: 'auto', designatedFallback: true, pages: 1, sort: 'price', refreshInterval: 30 };
}

test('designated mode is explicit and cannot skip official priority through direct Firsto send', () => {
  const base = ['--factory', factory, '--pool', pool];
  assert.equal(parseArguments(base).designatedFallback, false);
  assert.equal(parseArguments([...base, '--designated-fallback', '--venue', 'auto']).designatedFallback, true);
  assert.throws(() => parseArguments([...base, '--designated-fallback']), /requires --venue auto/);
  assert.throws(() => parseArguments([...base, '--designated-fallback', '--venue', 'firsto-signed']), /requires --venue auto/);
});

test('available original is simulated before any candidate API access', async t => {
  const { provider, data } = mockChain(); let apiCalls = 0;
  const result = await runKeeperCycle(provider, options(t), null, () => { apiCalls += 1; return feed(); }, createKeeperRuntime());
  assert.equal(result.status, 'dry-run-ready'); assert.equal(result.mode, 'designated-fallback');
  assert.equal(result.purchaseRoute, 'buyFromMarket'); assert.equal(result.tokenId, 1n);
  assert.equal(apiCalls, 0); assert.deepEqual(data.estimates, ['buyFromMarket']);
});

test('owner unchanged blocks fallback even when original listing disappears; ambiguous original simulation also blocks', async t => {
  const { provider, data } = mockChain(); let apiCalls = 0;
  const fetcher = () => { apiCalls += 1; return feed(); };
  data.originalListed = false;
  assert.equal((await runKeeperCycle(provider, options(t), null, fetcher)).status, 'designated-original-owner-unchanged');
  data.originalListed = true; data.originalSimulationFails = true;
  assert.equal((await runKeeperCycle(provider, options(t), null, fetcher)).status, 'designated-original-simulation-unresolved');
  assert.equal(apiCalls, 1, 'only the original signed-order lookup is permitted');
});

test('owner change enables one chain-priced alternative; API buyer cost and daily totals remain hints', async t => {
  const { provider, data } = mockChain(); let apiCalls = 0;
  data.owner = newOriginalOwner; data.originalListed = false;
  const result = await runKeeperCycle(provider, options(t), null,
    () => { apiCalls += 1; return feed(); }, createKeeperRuntime());
  assert.equal(result.status, 'dry-run-ready'); assert.equal(result.purchaseRoute, 'buyAlternativeFromMarket');
  assert.equal(result.tokenId, 2n); assert.equal(result.sellerAskWei, 1000n);
  assert.equal(result.grossCostWei, 1000n); assert.equal(result.dailyOutputAtomic, 864000n);
  assert.equal(result.indexerBuyerCostWei, 999999999999999999n);
  assert.equal(apiCalls, 2); assert.deepEqual(data.estimates, ['buyAlternativeFromMarket']);
});

test('auto mode searches only the exact original Firsto ID before deciding whether alternatives may be scanned', async t => {
  const { provider, data } = mockChain(); const queries = [];
  data.originalListed = false;
  const config = { ...options(t), venue: 'auto' };
  const fetcher = url => { queries.push(url.searchParams.get('query')); return feed(); };
  const unchanged = await runKeeperCycle(provider, config, null, fetcher, createKeeperRuntime());
  assert.equal(unchanged.status, 'designated-original-owner-unchanged');
  assert.deepEqual(queries, ['1']);
  assert.deepEqual(data.estimates, []);

  data.owner = newOriginalOwner;
  const changed = await runKeeperCycle(provider, config, null, fetcher, createKeeperRuntime());
  assert.equal(changed.status, 'dry-run-ready');
  assert.equal(changed.purchaseRoute, 'buyAlternativeFromMarket');
  assert.deepEqual(queries, ['1', '1', null]);
  assert.deepEqual(data.estimates, ['buyAlternativeFromMarket']);
});

test('auto mode executes a pinned, canonically verified original Firsto V2 ask before alternatives', async t => {
  const source = await signedSource({ price: '1000' });
  const { provider, data } = mockChain(7n, 100, 1_800_000_000);
  data.owner = source.account; data.referenceSeller = source.account; data.originalListed = false;
  const canonical = firstoProvider(source);
  provider.send = (method, params) => canonical.provider.request({ method, params });
  const queries = [];
  const result = await runKeeperCycle(provider, { ...options(t), venue: 'auto' }, null, url => {
    queries.push(url.searchParams.get('query'));
    return Response.json({ rows: [{ collection, tokenId: '7', owner: source.account,
      category: 'official_mining', mining: { taskId: 7, status: 'verified',
        verifiedWeight: '1', unverifiedWeight: '0' }, bestAsk: source }],
    sourceBlock: '99', totalPages: 1 });
  }, createKeeperRuntime());
  assert.equal(result.status, 'dry-run-ready');
  assert.equal(result.purchaseRoute, 'buyFromFirsto');
  assert.equal(result.tokenId, 7n);
  assert.equal(result.firstoOrderHash, source.id);
  assert.deepEqual(queries, ['7']);
  assert.deepEqual(data.estimates, ['buyFromFirsto']);
  assert(canonical.calls.some(call => call.method === 'eth_getStorageAt'));
});

test('auto mode fails closed when original signed-order discovery fails', async t => {
  const { provider, data } = mockChain(); let apiCalls = 0;
  data.owner = newOriginalOwner; data.originalListed = false;
  const result = await runKeeperCycle(provider, { ...options(t), venue: 'auto' }, null,
    () => { apiCalls += 1; throw new Error('indexer transport unavailable'); }, createKeeperRuntime());
  assert.equal(result.status, 'designated-original-firsto-unresolved');
  assert.equal(apiCalls, 1); assert.deepEqual(data.estimates, []);
});

test('an inconsistent official original listing blocks all fallback discovery', async t => {
  const { provider, data } = mockChain(); let apiCalls = 0;
  data.owner = newOriginalOwner; data.originalListingMismatch = true;
  await assert.rejects(runKeeperCycle(provider, options(t), null,
    () => { apiCalls += 1; return feed(); }, createKeeperRuntime()), /Original official listing read is inconsistent/);
  assert.equal(apiCalls, 0); assert.deepEqual(data.estimates, []);
});

test('revoked market approval makes the original official listing non-executable', async t => {
  const { provider, data } = mockChain(); const queries = [];
  data.owner = newOriginalOwner; data.originalMarketApproved = false;
  const result = await runKeeperCycle(provider, options(t), null, url => {
    queries.push(url.searchParams.get('query')); return feed();
  }, createKeeperRuntime());
  assert.equal(result.status, 'dry-run-ready');
  assert.equal(result.purchaseRoute, 'buyAlternativeFromMarket');
  assert.deepEqual(queries, ['1', null]);
  assert.deepEqual(data.estimates, ['buyAlternativeFromMarket']);
});

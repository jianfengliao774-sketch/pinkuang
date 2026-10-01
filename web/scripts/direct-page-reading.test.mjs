import test from 'node:test';
import assert from 'node:assert/strict';
import { abi } from '../lib/chain-client.mjs';
import { currentDetailActionReady, currentPositionsActionReady } from '../lib/live-view.mjs';
import { readCurrentPoolMembers } from '../lib/live-members.mjs';
import { readShareDailyCapacityPrice } from '../lib/share-daily-capacity.mjs';

const factory = '0x1111111111111111111111111111111111111111';
const pool = '0x2222222222222222222222222222222222222222';
const owner = '0x3333333333333333333333333333333333333333';
const config = { status: 'ready', productFamily: 'fresh-v4', displayOnly: true,
  readMode: 'display', operationalReady: false, transactionReady: false };

test('fixed-release browsing opens a preview without waiting for a graph or historical proof', () => {
  const base = { client: {}, config, source: { readMode: 'verified_snapshot', stale: true },
    cachedPage: true, loading: false, busy: false, loadedRoute: `detail/${pool}`, routePool: pool,
    detailPool: pool, loadedAccount: owner, account: owner };
  assert.equal(currentDetailActionReady(base), true);
  assert.equal(currentDetailActionReady({ ...base, account: factory }), false);
  assert.equal(currentDetailActionReady({ ...base, config: { ...config, walletSessionReady: false } }), false);
  assert.equal(currentPositionsActionReady({ ...base, wallet: {}, positionsAccount: owner,
    positionsLoaded: true, error: '' }), true);
});

test('direct holder display reads only the addresses used by the page', async () => {
  const calls = [];
  const provider = { async request(input) {
    calls.push(input); assert.equal(input.method, 'eth_call'); assert.equal(input.params[1], 'latest');
    assert.equal(abi.PoolVault.parseTransaction(input.params[0]).name, 'activeMembers');
    return abi.PoolVault.encodeFunctionResult('activeMembers', [[owner]]);
  } };
  const result = await readCurrentPoolMembers(provider, { factory, pool, displayOnly: true });
  assert.deepEqual(result.members, [owner]); assert.equal(result.blockNumber, null);
  assert.equal(calls.length, 1);
});

test('daily output reuses the loaded miner identity and makes no RPC verification requests', async () => {
  let quotes = 0;
  const result = await readShareDailyCapacityPrice({ request() { throw new Error('Unexpected RPC'); } }, {
    factory, pool, displayOnly: true, pricePerUnitWei: 10000000000000000n,
    params: { circuits: factory, circuitId: 9n }, now: 1800000000000,
    quoteLoader: async (collection, tokenId) => {
      quotes++; assert.equal(collection, factory); assert.equal(tokenId, '9');
      return { asset: { mining: { status: 'verified', estimated24hAtomic: '100000000',
        sourceBlock: '12', taskId: '1', verifiedWeight: '2', unverifiedWeight: '0', weight: '2' } } };
    },
  });
  assert.equal(quotes, 1); assert.equal(result.available, true);
  assert.equal(result.priceWeiPerDailyBem, 1000000000000000000n);
  assert.equal(result.sourceBlock, null); assert.equal(result.displayOnly, true);
});

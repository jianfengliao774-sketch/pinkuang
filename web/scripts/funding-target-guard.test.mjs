import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, getAddress, ZeroAddress } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { assertFundingTargetAvailable } from '../lib/funding-target-guard.mjs';
import { prepareProductAction } from '../lib/live-actions.mjs';

const address = n => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const pool = address(10), seller = address(11), buyer = address(12), collection = address(13);
const factory = address(14), lens = address(15), market = address(16), account = address(17);
const nft = new Interface(['function ownerOf(uint256) view returns(address)']);
const config = { status: 'ready', chainId: 56, displayOnly: true, factory, lens, shareMarket: market,
  origin: 'https://bemine.cc.cd', indexBaseUrl: 'https://bemine.cc.cd/bemine-v5/api/chain-index', fundingTargetGuard: true };
const params = { circuits: collection, circuitId: 100n, targetRaise: 10000n, priceCap: 9000n,
  directSeller: ZeroAddress, directPrice: 0n, fundingDeadline: 9000000000n, purchaseDeadline: 9000001000n };
const flexibleConfig = { minVerifiedWeight: 1n, referencePriceWei: 9000n, targetDailyYieldAtomic: 1n,
  extraBps: 1000n, referenceObservedAt: 1n, referenceBlock: 1n, referenceDigest: `0x${'aa'.repeat(32)}` };
const proof = { status: 'available', purchaseMode: 'fixed', originalOwner: seller, currentOwner: seller,
  creationBlock: 100, creationBlockHash: `0x${'cc'.repeat(32)}`, observedBlock: 200,
  creationOwnerProof: 'block_end_owner_and_ordered_transfers' };
function fixture({ owner = seller, flexible = false, availability = proof, rowPool = pool, rowParams = params,
  sourceFactory = factory, failOwner = false } = {}) {
  const calls = [], http = [];
  const provider = { request: async ({ method, params: rpcParams }) => {
    assert.equal(method, 'eth_call'); assert.equal(rpcParams[1], 'latest');
    const to = getAddress(rpcParams[0].to), iface = to === collection ? nft : abi.PoolVault;
    const call = iface.parseTransaction(rpcParams[0]); calls.push(call.name);
    assert(to === pool || to === collection);
    if (call.name === 'ownerOf') {
      assert.equal(call.args[0], 100n); if (failOwner) throw new Error('RPC timeout');
      return nft.encodeFunctionResult(call.fragment, [owner]);
    }
    const values = { flexiblePurchase: [flexible, 100n, flexibleConfig], params: [params], unitPriceWei: [100n] };
    assert(values[call.name], `Unexpected RPC: ${call.name}`);
    return iface.encodeFunctionResult(call.fragment, values[call.name]);
  } };
  const fetcher = async url => {
    http.push(url); assert.equal(url, `${config.indexBaseUrl}/v1/display/pools/${pool}`);
    return new Response(JSON.stringify({ source: { chainId: 56, factory: sourceFactory, market,
      cacheOrigin: 'server', readMode: 'verified_snapshot' },
    data: { item: { trusted: true, pool: rowPool, params: rowParams, targetAvailability: availability } } },
    (_key, value) => typeof value === 'bigint' ? { $bemineBigInt: String(value) } : value),
    { headers: { 'content-type': 'application/json' } });
  };
  return { provider, fetcher, calls, http };
}
test('a selected fixed target is checked at the latest chain before exact deposit calldata is returned', async () => {
  const f = fixture();
  const action = await prepareProductAction({ ...f, config, account, pool, kind: 'deposit', quantity: '2' });
  assert.equal(action.transaction.value, '0xc8');
  assert.deepEqual(f.calls, ['flexiblePurchase', 'params', 'ownerOf', 'unitPriceWei']);
  assert.equal(f.http.length, 1);
});
test('cached available cannot authorize a deposit after an external buyer takes the target', async () => {
  const f = fixture({ owner: buyer });
  await assert.rejects(prepareProductAction({ ...f, config, account, pool, kind: 'deposit', quantity: '1' }), /指定矿机已转移/);
  assert(!f.calls.includes('unitPriceWei'));
});
test('a sale after preview is detected by the next preparation before wallet submission', async () => {
  await prepareProductAction({ ...fixture(), config, account, pool, kind: 'deposit', quantity: '1' });
  await assert.rejects(prepareProductAction({ ...fixture({ owner: buyer }), config, account, pool, kind: 'deposit', quantity: '1' }), /已转移/);
});
test('explicit flexible consent continues without reading its former reference target or historical cache', async () => {
  const f = fixture({ flexible: true, owner: buyer });
  await prepareProductAction({ ...f, config, account, pool, kind: 'deposit', quantity: '1' });
  assert.deepEqual(f.calls, ['flexiblePurchase', 'unitPriceWei']); assert.equal(f.http.length, 0);
});
test('unknown or unproven history fails closed for new subscriptions without saying the miner was sold', async () => {
  for (const availability of [null, { ...proof, status: 'unknown' }, { ...proof, creationOwnerProof: null }, { ...proof, originalOwner: ZeroAddress }]) {
    await assert.rejects(assertFundingTargetAvailable({ ...fixture({ availability }), config, pool }), /尚未确认/);
  }
  await assert.rejects(assertFundingTargetAvailable({ ...fixture({ failOwner: true }), config, pool }), /RPC timeout/);
});
test('wrong cache pool, collection, token and factory never authorize a subscription', async () => {
  for (const options of [{ rowPool: buyer }, { rowParams: { ...params, circuitId: 101n } },
    { rowParams: { ...params, circuits: buyer } }, { sourceFactory: buyer }])
    await assert.rejects(assertFundingTargetAvailable({ ...fixture(options), config, pool }), /不一致/);
});
test('an NFT held by the pool cannot be sold to new subscribers as an available funding target', async () => {
  await assert.rejects(assertFundingTargetAvailable({ ...fixture({ owner: pool }), config, pool }), /停止开放认购/);
});
test('refund and withdrawal entry points remain independent of target owner, cache and paid API', async () => {
  const provider = { request: () => { throw new Error('Unexpected RPC'); } };
  const fetcher = () => { throw new Error('Unexpected HTTP'); };
  for (const kind of ['withdrawDeposit', 'withdrawBnb', 'finalizeFailure', 'claim']) {
    const action = await prepareProductAction({ provider, fetcher, config, account, pool, kind });
    assert.equal(abi.PoolVault.parseTransaction(action.transaction).name, kind);
  }
});

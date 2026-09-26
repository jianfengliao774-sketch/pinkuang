import assert from 'node:assert/strict';
import test from 'node:test';
import { ZeroAddress, getAddress } from 'ethers';
import { abi, uint, poolKey, assetKey, referenceQuote, decodePoolRow, hasPosition,
  readPoolSnapshot, personalPoolAction, personalClaimQueue, checkedPoolCreation } from '../lib/chain-client.mjs';

const addr = n => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const factory = addr(1), lens = addr(2), pool = addr(3), account = addr(4), collection = addr(5);
const params = { circuits: collection, circuitId: 900719925474099312345n, targetRaise: 11000n, priceCap: 10000n,
  directSeller: ZeroAddress, directPrice: 0n, fundingDeadline: 2000n, purchaseDeadline: 3000n };
const config = { minVerifiedWeight: 500n, referencePriceWei: 10000n, targetDailyYieldAtomic: 1000000000000000001n,
  extraBps: 1000n, referenceObservedAt: 900n, referenceBlock: 8n, referenceDigest: `0x${'34'.repeat(32)}` };
function rawRow(changes = {}) {
  return { pool, status: { validMask: (1n << 17n) - 1n, errorMask: 0n, trustError: 0n }, params,
    state: 0n, unitPriceWei: 110n, totalRaised: 5390n, totalSupply: 49n, memberCount: 1n,
    depositPaused: false, purchaseCost: 0n, activatedAt: 0n, shareTradingAllowed: false,
    shares: 0n, lockedShares: 0n, availableShares: 0n, claimableBEM: 0n, bnbOwed: 0n,
    initialContributedWei: 0n, ...changes };
}
function localSnapshot(row = rawRow()) {
  return { chainId: 56n, factory, account, timestamp: 1000n, pools: [decodePoolRow(row, factory)] };
}
function provider({ chain = '0x38', wrongLens = false, reorg = false, badBlock = false, rows = [rawRow()] } = {}) {
  const calls = []; let blockReads = 0;
  return { calls, async request(request) {
    calls.push(request);
    const { method, params: args } = request;
    if (method === 'eth_chainId') return chain;
    if (method === 'eth_getBlockByNumber') return { number: '0xa', timestamp: '0x3e8', hash: reorg && blockReads++ ? '0xbeef' : '0xabcd' };
    assert.equal(method, 'eth_call'); assert.equal(args[1], '0xa');
    const iface = args[0].to === factory ? abi.PoolFactory : abi.PoolLens;
    const transaction = iface.parseTransaction(args[0]);
    const name = transaction.name;
    let value;
    if (name === 'lens') value = lens;
    else if (name === 'factory') value = wrongLens ? addr(999) : factory;
    else if (name === 'VERSION') value = 1n;
    else {
      assert(['poolPage', 'positions'].includes(name));
      value = { blockNumber: badBlock ? 9n : 10n, timestamp: 1000n, totalPools: 1n, nextCursor: 1n, registryCountValid: true, pools: rows };
    }
    return iface.encodeFunctionResult(name, [value]);
  } };
}

test('funding uses exact ceil twice, 10% reserve and independent procurement cap', () => {
  for (const price of [1n, 90n, 91n, 99n, 100n, 101n, 900719925474099312345n]) {
    const quote = referenceQuote(price);
    assert.equal(quote.targetRaise % 100n, 0n);
    assert(quote.targetRaise * 10000n >= price * 11000n);
    assert((quote.targetRaise - 100n) * 10000n < price * 11000n);
    assert.equal(quote.priceCap, price);
    assert.equal(quote.unitPriceWei * 100n, quote.targetRaise);
  }
  assert.throws(() => uint(1), /exact/);
  assert.throws(() => uint('1.1'), /exact/);
  assert.throws(() => uint('-1'), /exact/);
  assert.throws(() => referenceQuote(0n), /positive/);
  assert.throws(() => referenceQuote(1n, 65536n), /uint16/);
  assert.throws(() => referenceQuote((1n << 256n) - 1n), /overflow/);
});

test('identity includes Factory/pool or collection/token, without Number conversion', () => {
  assert.notEqual(poolKey(factory, pool), poolKey(addr(10), pool));
  assert.notEqual(assetKey(collection, params.circuitId), assetKey(addr(10), params.circuitId));
  assert(assetKey(collection, params.circuitId).endsWith('900719925474099312345'));
});

test('failed and unattempted reads stay unknown; zero-share claims stay in holdings', () => {
  assert.equal(hasPosition(decodePoolRow(rawRow(), factory)), false);
  assert.equal(hasPosition(decodePoolRow(rawRow({ claimableBEM: 1n }), factory)), true);
  assert.equal(hasPosition(decodePoolRow(rawRow({ bnbOwed: 1n }), factory)), true);
  const unknown = decodePoolRow(rawRow({ status: { validMask: 1n, errorMask: 1n << 14n, trustError: 0n } }), factory);
  assert.equal(unknown.claimableBEM, null); assert.equal(unknown.shares, null); assert(hasPosition(unknown));
  const untrusted = decodePoolRow(rawRow({ status: { validMask: 0n, errorMask: 1n, trustError: 2n } }), factory);
  assert.equal(untrusted.trusted, false); assert.equal(untrusted.params, null);
});

test('read adapter binds Lens, pins all calls, preserves large IDs and masks', async () => {
  const rpc = provider();
  const snapshot = await readPoolSnapshot(rpc, { factory, account });
  assert.equal(snapshot.pools[0].params.circuitId, params.circuitId);
  assert.equal(snapshot.pools[0].unitPriceWei, 110n);
  assert.equal(snapshot.blockNumber, 10n); assert.equal(snapshot.account, account);
  assert(rpc.calls.every(call => !['eth_sendTransaction', 'eth_requestAccounts', 'personal_sign'].includes(call.method)));
  const pinned = provider();
  await readPoolSnapshot(pinned, { factory, account, pools: [pool, pool.toLowerCase()], blockNumber: 10n });
  assert.equal(pinned.calls.find(call => call.method === 'eth_getBlockByNumber').params[0], '0xa');
  const positionsCall = pinned.calls.filter(call => call.method === 'eth_call').map(call => abi.PoolLens.parseTransaction(call.params[0])).find(call => call?.name === 'positions');
  assert.equal(positionsCall.args[0].length, 1);
});

test('wrong chain, swapped Lens, inconsistent block and reorg fail closed', async () => {
  await assert.rejects(readPoolSnapshot(provider({ chain: '0x1' }), { factory }), /BSC/);
  await assert.rejects(readPoolSnapshot(provider({ wrongLens: true }), { factory }), /different Factory/);
  await assert.rejects(readPoolSnapshot(provider({ badBlock: true }), { factory }), /block mismatch/);
  await assert.rejects(readPoolSnapshot(provider({ reorg: true }), { factory }), /Chain changed/);
  await assert.rejects(readPoolSnapshot(provider(), { factory, limit: 21n }), /At most/);
  await assert.rejects(readPoolSnapshot(provider(), { factory, blockNumber: 11n }), /requested block/);
});

test('subscription uses exact wallet/amount and blocks unavailable state or quantity', () => {
  const snap = localSnapshot();
  const tx = personalPoolAction(snap, pool, account, 'deposit', 49n);
  assert.equal(tx.value, '0x150e'); assert.equal(tx.from, account); assert.equal(tx.to, pool);
  assert.equal(abi.PoolVault.parseTransaction(tx).args[0], 49n);
  assert.throws(() => personalPoolAction(snap, pool, addr(99), 'deposit', 1n), /another wallet/);
  assert.throws(() => personalPoolAction(snap, pool, account, 'deposit', 50n), /quantity/);
  assert.throws(() => personalPoolAction(localSnapshot(rawRow({ shares: 49n })), pool, account, 'deposit', 1n), /quantity/);
  assert.throws(() => personalPoolAction(localSnapshot(rawRow({ state: 1n })), pool, account, 'deposit', 1n), /not open/);
  assert.throws(() => personalPoolAction(localSnapshot(rawRow({ depositPaused: true })), pool, account, 'deposit', 1n), /not open/);
});

test('harvest and self claim stay separate, including former holders; no claimFor/router', () => {
  const snapshot = localSnapshot(rawRow({ state: 4n, claimableBEM: 33n }));
  const queue = personalClaimQueue(snapshot, account);
  assert.equal(queue.length, 1); assert.equal(queue[0].from, account); assert.equal(queue[0].to, pool);
  assert.equal(personalClaimQueue({ ...snapshot, pools: [...snapshot.pools, ...snapshot.pools] }, account).length, 1);
  assert.equal(abi.PoolVault.parseTransaction(queue[0]).name, 'claim');
  for (const state of [2n, 3n]) {
    assert.equal(abi.PoolVault.parseTransaction(personalPoolAction(localSnapshot(rawRow({ state })), pool, account, 'harvest')).name, 'harvest');
  }
  for (const state of [0n, 1n, 4n, 5n]) {
    assert.throws(() => personalPoolAction(localSnapshot(rawRow({ state })), pool, account, 'harvest'), /cannot harvest/);
  }
  const unknownState = localSnapshot(rawRow({ status: { validMask: 1n, errorMask: 4n, trustError: 0n } }));
  assert.throws(() => personalPoolAction(unknownState, pool, account, 'harvest'), /cannot harvest/);
  assert.throws(() => personalPoolAction(snapshot, pool, account, 'claimFor'), /Unsupported/);
  assert.equal(abi.PoolVault.getFunction('claimFor'), null);
  assert.equal(personalClaimQueue(localSnapshot(), account).length, 0);
});

test('checked creation encodes reviewed task/weight and rejects reserve-as-price-cap', () => {
  const args = { factory, from: account, params, config, expectedTaskId: 170n, expectedReferenceWeight: 700n };
  const tx = checkedPoolCreation(args), parsed = abi.PoolFactory.parseTransaction(tx);
  assert.equal(parsed.name, 'createFlexiblePoolChecked');
  assert.equal(parsed.args[0].circuitId, params.circuitId); assert.equal(parsed.args[2], 170n); assert.equal(parsed.args[3], 700n);
  assert.throws(() => checkedPoolCreation({ ...args, params: { ...params, priceCap: 11000n } }), /contradict/);
  assert.throws(() => checkedPoolCreation({ ...args, expectedReferenceWeight: 499n }), /incompatible/);
  assert.throws(() => checkedPoolCreation({ ...args, params: { ...params, circuitId: 123 } }), /exact/);
});

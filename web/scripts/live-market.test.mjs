import assert from 'node:assert/strict';
import test from 'node:test';
import { getAddress } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { marketAction, prepareMarketAction, readMarketSnapshot } from '../lib/live-market.mjs';

const addr = n => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const factory = addr(1), market = addr(2), timelock = addr(3), pool = addr(4), alice = addr(5), seller = addr(6);
const blockHash = `0x${'12'.repeat(32)}`;
const price = 900719925474099312345n;
const minPrice = 10000000000000n;
const order = { seller, pool, remaining: 3n, pricePerUnit: price, active: true };

function rpc(changes = {}) {
  const calls = [], options = { chain: '0x38', timestamp: 1000n, hash: blockHash,
    linkedMarket: market, marketFactory: factory, factoryTimelock: timelock, marketTimelock: timelock,
    feeBps: 100n, buyerFeeBps: 100n, nextOrderId: 8n, credit: 123n, registered: true, poolFactory: factory,
    officialFactory: factory, state: 2n, tradingAllowed: true, balance: 6n, locked: 2n,
    available: 4n, order, expiresAt: 2000n, ...changes };
  let blockReads = 0;
  return { calls, async request({ method, params = [] }) {
    calls.push({ method, params });
    if (method === 'eth_chainId') return options.chain;
    if (method === 'eth_getBlockByNumber') {
      blockReads++;
      return { number: '0xa', timestamp: `0x${options.timestamp.toString(16)}`,
        hash: options.reorg && blockReads > 1 ? `0x${'34'.repeat(32)}` : options.hash };
    }
    if (method === 'eth_getCode') {
      assert.equal(params[1], '0xa');
      return options.noCode === params[0] ? '0x' : '0x1234';
    }
    assert.equal(method, 'eth_call');
    assert.equal(params[1], '0xa');
    const to = getAddress(params[0].to);
    const iface = to === factory ? abi.PoolFactory : to === market ? abi.ShareMarket : abi.PoolVault;
    const parsed = iface.parseTransaction(params[0]);
    assert(parsed, `Unknown call to ${to}`);
    if (parsed.name === 'buyerFeeBps' && options.buyerFeeBps === null) throw new Error('Old Market has no buyer fee getter.');
    const values = {
      shareMarket: options.linkedMarket, timelock: to === market ? options.marketTimelock : options.factoryTimelock,
      isPool: options.registered, factory: to === market ? options.marketFactory : options.poolFactory,
      OFFICIAL_FACTORY: options.officialFactory, feeBps: options.feeBps, buyerFeeBps: options.buyerFeeBps,
      nextOrderId: options.nextOrderId, bnbOwed: options.credit,
      orders: [options.order.seller, options.order.pool, options.order.remaining,
        options.order.pricePerUnit, options.order.active], orderExpiresAt: options.expiresAt,
      state: options.state, shareTradingAllowed: options.tradingAllowed,
      balanceOf: options.balance, lockedShares: options.locked, availableShares: options.available,
    };
    assert(Object.hasOwn(values, parsed.name), `Unexpected call ${parsed.name}`);
    return iface.encodeFunctionResult(parsed.name, [values[parsed.name]]);
  } };
}

const params = (changes = {}) => ({ factory, market, account: alice, orderIds: ['7'], pools: [pool], ...changes });
const fill = (changes = {}) => ({ kind: 'fill', orderId: '7', amount: '2', expectedPool: pool,
  expectedSeller: seller, expectedPricePerUnitWei: price.toString(), ...changes });

test('one pinned BSC block binds Factory, Market and registered pools with exact bigint state', async () => {
  const provider = rpc();
  const snapshot = await readMarketSnapshot(provider, params());
  assert.equal(snapshot.market, market);
  assert.equal(snapshot.orders[0].pricePerUnitWei, price);
  assert.equal(snapshot.orders[0].expiresAt, 2000n);
  assert.equal(snapshot.pools[0].available, 4n);
  assert.equal(snapshot.bnbOwed, 123n);
  assert.equal(snapshot.buyerFeeBps, 100n);
  assert.equal(snapshot.blockHash, blockHash);
  assert(provider.calls.filter(item => ['eth_call', 'eth_getCode'].includes(item.method))
    .every(item => item.params[1] === '0xa'));
  assert(provider.calls.every(item => !['eth_sendTransaction', 'eth_requestAccounts', 'personal_sign'].includes(item.method)));
});

test('chain, deployment graph, fee, registry, accounting and reorg changes fail closed', async () => {
  for (const [change, expected] of [
    [{ chain: '0x1' }, /BSC/], [{ linkedMarket: addr(99) }, /bindings/],
    [{ marketFactory: addr(99) }, /bindings/], [{ marketTimelock: addr(99) }, /bindings/],
    [{ feeBps: 200n }, /fee/], [{ registered: false }, /registered/],
    [{ officialFactory: addr(99) }, /registered/], [{ available: 5n }, /inconsistent/],
    [{ reorg: true }, /Chain changed/], [{ noCode: market }, /no code/],
  ]) await assert.rejects(readMarketSnapshot(rpc(change), params()), expected);
  await assert.rejects(readMarketSnapshot(rpc(), params({ orderIds: ['8'] })), /not registered/);
  await assert.rejects(readMarketSnapshot(rpc(), params({ blockNumber: '11' })), /wrong market block/);
});

test('list allows all 100 unlocked shares, rejects sub-minimum prices and checks freeze', async () => {
  const snapshot = await readMarketSnapshot(rpc({ balance: 100n, locked: 0n, available: 100n }), params({ orderIds: [] }));
  const listed = marketAction(snapshot, alice, { kind: 'list', pool, amount: '100', pricePerUnitWei: minPrice.toString() });
  assert.equal(listed.transaction.to, market);
  assert.equal(listed.transaction.value, '0x0');
  assert.equal(listed.quote.unitPriceWei, minPrice);
  assert.equal(abi.ShareMarket.parseTransaction(listed.transaction).name, 'list');
  assert.equal(abi.ShareMarket.parseTransaction(listed.transaction).args[1], 100n);
  assert.throws(() => marketAction(snapshot, alice, { kind: 'list', pool, amount: '101', pricePerUnitWei: minPrice.toString() }), /1–100/);
  for (const tooLow of [0n, 1n, minPrice - 1n])
    assert.throws(() => marketAction(snapshot, alice, { kind: 'list', pool, amount: '1', pricePerUnitWei: tooLow.toString() }), /at least 0.00001/);
  assert.throws(() => marketAction(snapshot, alice, { kind: 'list', pool, amount: '100',
    pricePerUnitWei: (((1n << 256n) - 1n) / 100n).toString() }), /buyer fee overflows/);
  const frozen = await readMarketSnapshot(rpc({ tradingAllowed: false }), params({ orderIds: [] }));
  assert.throws(() => marketAction(frozen, alice, { kind: 'list', pool, amount: '1', pricePerUnitWei: minPrice.toString() }), /frozen/);
  const locked = await readMarketSnapshot(rpc(), params({ orderIds: [] }));
  assert.throws(() => marketAction(locked, alice, { kind: 'list', pool, amount: '5', pricePerUnitWei: minPrice.toString() }), /unlocked/);
});

test('partial fill uses exact current price and independent buyer and seller 1% fees', async () => {
  const result = await prepareMarketAction(rpc(), { factory, market, account: alice, action: fill() });
  assert.equal(result.transaction.value, `0x${(2n * price + 2n * price / 100n).toString(16)}`);
  assert.equal(result.quote.grossWei, 2n * price);
  assert.equal(result.quote.unitPriceWei, price);
  assert.equal(result.quote.buyerFeeWei, result.quote.grossWei / 100n);
  assert.equal(result.quote.sellerFeeWei, result.quote.grossWei / 100n);
  assert.equal(result.quote.buyerPaymentWei, result.quote.grossWei + result.quote.buyerFeeWei);
  assert.equal(result.quote.sellerNetWei, result.quote.grossWei - result.quote.sellerFeeWei);
  assert.deepEqual([...abi.ShareMarket.parseTransaction(result.transaction).args], [7n, 2n]);
  const snapshot = result.snapshot;
  assert.throws(() => marketAction(snapshot, alice, fill({ expectedPricePerUnitWei: '1' })), /price changed/);
  assert.throws(() => marketAction(snapshot, alice, fill({ expectedPool: addr(88) })), /pool, seller or price/);
  assert.throws(() => marketAction(snapshot, alice, fill({ expectedSeller: addr(88) })), /pool, seller or price/);
  assert.throws(() => marketAction(snapshot, seller, fill()), /another wallet/);
  const whale = await readMarketSnapshot(rpc({ balance: 100n, locked: 0n, available: 100n }), params());
  assert.equal(marketAction(whale, alice, fill()).quote.grossWei, 2n * price); // No personal holding limit.
  const own = await readMarketSnapshot(rpc(), params({ account: seller }));
  assert.throws(() => marketAction(own, seller, fill()), /own order/);
  assert.throws(() => marketAction(snapshot, alice, fill({ amount: '4' })), /fewer shares/);
  const sold = await readMarketSnapshot(rpc({ order: { ...order, active: false, remaining: 0n } }), params());
  assert.throws(() => marketAction(sold, alice, fill()), /filled, cancelled/);
  const expired = await readMarketSnapshot(rpc({ expiresAt: 1000n }), params());
  assert.throws(() => marketAction(expired, alice, fill()), /expired/);
  const frozen = await readMarketSnapshot(rpc({ tradingAllowed: false }), params());
  assert.throws(() => marketAction(frozen, alice, fill()), /frozen/);
});

test('old one-sided Market remains readable and withdrawable but cannot list or fill', async () => {
  const snapshot = await readMarketSnapshot(rpc({ buyerFeeBps: null }), params());
  assert.equal(snapshot.buyerFeeBps, null);
  assert.throws(() => marketAction(snapshot, alice, fill()), /Bilateral 1% market upgrade/);
  assert.throws(() => marketAction(snapshot, alice, { kind: 'list', pool, amount: '1', pricePerUnitWei: '101' }), /Bilateral 1% market upgrade/);
  assert.equal(marketAction(snapshot, alice, { kind: 'withdrawBnb' }).transaction.value, '0x0');
});

test('cancel stays available when trading is frozen; anyone may expire only after deadline', async () => {
  const frozen = await readMarketSnapshot(rpc({ tradingAllowed: false }), params({ account: seller }));
  assert.equal(abi.ShareMarket.parseTransaction(marketAction(frozen, seller, { kind: 'cancel', orderId: '7' }).transaction).name, 'cancel');
  assert.throws(() => marketAction(frozen, alice, { kind: 'cancel', orderId: '7' }), /another wallet/);
  assert.throws(() => marketAction(frozen, seller, { kind: 'expire', orderId: '7' }), /not yet expired/);
  const expired = await readMarketSnapshot(rpc({ expiresAt: 1000n }), params());
  assert.equal(abi.ShareMarket.parseTransaction(marketAction(expired, alice, { kind: 'expire', orderId: '7' }).transaction).name, 'expire');
  const legacy = await readMarketSnapshot(rpc({ expiresAt: 0n }), params());
  assert.equal(abi.ShareMarket.parseTransaction(marketAction(legacy, alice, { kind: 'expire', orderId: '7' }).transaction).name, 'expire');
  const tooCheap = await readMarketSnapshot(rpc({ order: { ...order, pricePerUnit: 1n } }), params());
  assert.throws(() => marketAction(tooCheap, alice, fill({ expectedPricePerUnitWei: '1' })), /below the minimum/);
  const sellerView = await readMarketSnapshot(rpc({ order: { ...order, pricePerUnit: 1n } }), params({ account: seller }));
  assert.equal(abi.ShareMarket.parseTransaction(marketAction(sellerView, seller, { kind: 'cancel', orderId: '7' }).transaction).name, 'cancel');
});

test('Market BNB withdrawal is separate and never mixes pool credit', async () => {
  const snapshot = await readMarketSnapshot(rpc(), params({ orderIds: [], pools: [] }));
  const withdrawal = marketAction(snapshot, alice, { kind: 'withdrawBnb' });
  assert.equal(withdrawal.transaction.to, market);
  assert.equal(withdrawal.transaction.value, '0x0');
  assert.equal(withdrawal.quote.marketCreditWei, 123n);
  assert.equal(withdrawal.quote.unitPriceWei, null);
  assert.equal(abi.ShareMarket.parseTransaction(withdrawal.transaction).name, 'withdrawBnb');
  const none = await readMarketSnapshot(rpc({ credit: 0n }), params({ orderIds: [], pools: [] }));
  assert.throws(() => marketAction(none, alice, { kind: 'withdrawBnb' }), /No Market BNB/);
});

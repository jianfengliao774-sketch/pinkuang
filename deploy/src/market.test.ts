import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Interface, parseEther, type Provider } from 'ethers';
import {
  FACTORY_ABI, MARKET_ABI, MARKET_PAGE_SIZE, address, pageIds, readMarketIdentity,
  requireFill, requireList, requireWallet, parseMarketPending, migrateLegacyMarketPending, recordMarketBroadcast,
  sameMarketIntent, shareAmount, tradeAmounts, unitPrice, withObservedMarketHash, recoverMarketReceipt, sendMarketAction,
  verifyMarketQuoteForSend, type MarketJournalStorage, type MarketOrder, type MarketQuote, type PendingMarketTransaction,
  withMarketTransactionLock,
} from './market';
import type { WalletProvider } from './wallet';

const seller = '0x1111111111111111111111111111111111111111';
const buyer = '0x2222222222222222222222222222222222222222';
const pool = '0x3333333333333333333333333333333333333333';
const factory = '0x4444444444444444444444444444444444444444';
const market = '0x5555555555555555555555555555555555555555';
const timelock = '0x6666666666666666666666666666666666666666';
const order: MarketOrder = { id: 1n, seller, pool, remaining: 17n, pricePerUnit: 101n, active: true, expiresAt: 2n ** 63n };

test('shares are whole units 1–49, never ether-denominated or fractional', () => {
  for (const [input, expected] of [['1', 1n], ['49', 49n]] as const) assert.equal(shareAmount(input), expected);
  for (const invalid of ['', '0', '50', '1.5', '1e1', '-1', ' 1', '01', '1000000000000000000']) assert.throws(() => shareAmount(invalid));
});
test('BNB unit prices retain wei precision, accept free transfers, and reject ambiguous inputs', () => {
  assert.equal(unitPrice('0'), 0n);
  assert.equal(unitPrice('0.000000000000000001'), 1n);
  assert.equal(unitPrice('0.125'), parseEther('0.125'));
  for (const invalid of ['', '-1', '.1', '1e3', '1,000', '0.0000000000000000001', '01', 'Infinity']) assert.throws(() => unitPrice(invalid));
});
test('partial fill exact gross, 1% fee rounding and seller proceeds conserve every wei', () => {
  assert.deepEqual(tradeAmounts(3n, 101n), { gross: 303n, fee: 3n, sellerProceeds: 300n });
  assert.deepEqual(tradeAmounts(1n, 99n), { gross: 99n, fee: 0n, sellerProceeds: 99n });
  assert.deepEqual(tradeAmounts(49n, 0n), { gross: 0n, fee: 0n, sellerProceeds: 0n });
  const huge = tradeAmounts(49n, 900719925474099300n);
  assert.equal(huge.gross, 44135276348230865700n);
  assert.equal(huge.fee + huge.sellerProceeds, huge.gross);
  assert.throws(() => tradeAmounts(0n, 1n));
  assert.throws(() => tradeAmounts(50n, 1n));
  assert.throws(() => tradeAmounts(49n, 2n ** 256n));
});
test('listing requires Active and unlocked shares while buying checks remaining and total holdings', () => {
  assert.doesNotThrow(() => requireList({ state: 2, tradingAllowed: true, available: 4n }, 4n));
  assert.throws(() => requireList({ state: 2, tradingAllowed: true, available: 4n }, 5n), /可用份额不足/);
  for (const state of [0, 1, 3, 4, 5]) {
    assert.throws(() => requireList({ state, tradingAllowed: true, available: 49n }, 1n), /Active/);
    assert.throws(() => requireFill(order, { state, tradingAllowed: true, balance: 0n }, buyer, 1n), /暂停/);
  }
  assert.doesNotThrow(() => requireFill(order, { state: 2, tradingAllowed: true, balance: 32n }, buyer, 17n));
  assert.throws(() => requireFill(order, { state: 2, tradingAllowed: true, balance: 33n }, buyer, 17n), /最多持有 49/);
  assert.throws(() => requireFill(order, { state: 2, tradingAllowed: true, balance: 0n }, buyer, 18n), /剩余/);
  assert.throws(() => requireFill(order, { state: 2, tradingAllowed: true, balance: 17n }, seller, 1n), /你的挂单/);
  assert.throws(() => requireFill({ ...order, active: false }, { state: 2, tradingAllowed: true, balance: 0n }, buyer, 1n), /已成交或撤销/);
});
test('orders paginate latest-first and never enumerate more than 20 ids per request', () => {
  assert.deepEqual(pageIds(1n), []);
  assert.deepEqual(pageIds(4n), [3n, 2n, 1n]);
  const first = pageIds(1001n);
  assert.equal(first.length, MARKET_PAGE_SIZE);
  assert.equal(first[0], 1000n); assert.equal(first.at(-1), 981n);
  assert.equal(pageIds(1001n, 980n)[0], 980n);
  assert.throws(() => pageIds(0n)); assert.throws(() => pageIds(4n, 4n));
});
test('wallet validation rejects chain changes or account changes before creating a transaction', async () => {
  const makeWallet = (chain: string, account: string): WalletProvider => ({ request: async ({ method }) => method === 'eth_chainId' ? chain : [account] });
  await assert.rejects(requireWallet(makeWallet('0x1', buyer), buyer), /BSC 主网/);
  await assert.rejects(requireWallet(makeWallet('0x38', seller), buyer), /账户已变化/);
  await assert.doesNotReject(requireWallet(makeWallet('0x38', buyer), buyer));
});
test('ABI encodes exact integer share quantity and zero-price list without allowances', () => {
  const abi = new Interface(MARKET_ABI);
  const data = abi.encodeFunctionData('list', [pool, 2n, 0n]);
  assert.equal(abi.decodeFunctionData('list', data)[1], 2n);
  assert.equal(abi.decodeFunctionData('list', data)[2], 0n);
  assert.equal(abi.getFunction('approve'), null);
  assert(abi.getFunction('withdrawBnb'));
});
test('unknown send intents survive reload and malformed server records block another send', () => {
  const pending: PendingMarketTransaction = { version: 1, chainId: 56, account: buyer, factory, market, nonce: 7, action: { kind: 'withdraw' }, data: '0x1234', value: '0', submittedAt: '2026-09-26T00:00:00.000Z' };
  assert.deepEqual(parseMarketPending(JSON.stringify(pending)), pending);
  assert.equal(parseMarketPending(null), null);
  assert.throws(() => parseMarketPending('{not json'), /无法读取/);
  assert.throws(() => parseMarketPending(JSON.stringify({ ...pending, chainId: 1 })), /异常/);
  assert.throws(() => address('0x0000000000000000000000000000000000000000'), /零地址/);
});
test('legacy market intent migrates once after server ACK; conflicting and other-wallet records are preserved', async () => {
  const pending: PendingMarketTransaction = { version: 1, chainId: 56, account: buyer, factory, market, nonce: 7,
    action: { kind: 'list', pool, amount: '1', price: '0.1' }, data: '0x1234', value: '0', submittedAt: '2026-09-26T00:00:00.000Z' };
  let server: string | null = null, legacy: string | null = JSON.stringify(pending), writes = 0;
  const canonical = (value: string) => JSON.stringify(JSON.parse(value), (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, (item as Record<string, unknown>)[key]])) : item);
  const storage: MarketJournalStorage = { getItem: async () => server, setItem: async (_key, value) => { writes += 1; server = canonical(value); }, removeItem: async () => {} };
  const browser = { getItem: () => legacy, removeItem: () => { legacy = null; } };
  assert.deepEqual(await migrateLegacyMarketPending(storage, buyer, browser), pending);
  assert.equal(writes, 1); assert.equal(legacy, null);
  legacy = JSON.stringify(pending);
  assert.deepEqual(await migrateLegacyMarketPending(storage, buyer, browser), pending);
  assert.equal(legacy, null, 'canonical key ordering must not look like a conflict');
  legacy = JSON.stringify({ ...pending, nonce: 8 });
  await assert.rejects(migrateLegacyMarketPending(storage, buyer, browser), /冲突/);
  assert(legacy, 'conflicting browser record must remain');
  legacy = JSON.stringify({ ...pending, account: seller });
  assert.deepEqual(await migrateLegacyMarketPending(storage, buyer, browser), pending);
  assert(legacy, 'another wallet history must remain');
  assert.deepEqual(await migrateLegacyMarketPending(storage, buyer, { getItem: () => { throw new Error('disabled'); }, removeItem: () => {} }), pending);
  server = null; legacy = JSON.stringify(pending);
  const rejected: MarketJournalStorage = { ...storage, setItem: async () => { throw new Error('ACK failed'); } };
  await assert.rejects(migrateLegacyMarketPending(rejected, buyer, browser), /ACK failed/);
  assert(legacy, 'a failed server write must not delete the old browser record');
});

test('post-broadcast server failure preserves the wallet hash before throwing and never clears the intent', async () => {
  const hash = `0x${'ab'.repeat(32)}`;
  const pending: PendingMarketTransaction = { version: 1, chainId: 56, account: buyer, factory, market, nonce: 7,
    action: { kind: 'withdraw' }, data: '0x1234', value: '0', submittedAt: '2026-09-26T00:00:00.000Z' };
  const visible: { current: PendingMarketTransaction | null } = { current: null };
  let deletions = 0;
  const storage: MarketJournalStorage = { getItem: async () => JSON.stringify(pending),
    setItem: async () => { throw new Error('disk unavailable'); }, removeItem: async () => { deletions += 1; } };
  await assert.rejects(recordMarketBroadcast(storage, pending, hash, value => { visible.current = value; }),
    error => { assert.match(String(error), new RegExp(hash)); assert.match(String(error), /勿重发/); return true; });
  assert.equal(visible.current?.hash, hash);
  assert.equal(deletions, 0);
  assert(sameMarketIntent(pending, { ...pending, action: { kind: 'withdraw' }, hash: undefined }));
  const serverCopy = { ...pending, hash: undefined };
  assert.equal(withObservedMarketHash(serverCopy, visible.current)?.hash, hash);
  assert.equal(withObservedMarketHash({ ...serverCopy, nonce: 8 }, visible.current)?.hash, undefined);
});
test('receipt recovery verifies original from/to/nonce/calldata/value and never broadcasts', async () => {
  const hash = `0x${'ab'.repeat(32)}`;
  const pending: PendingMarketTransaction = { version: 1, chainId: 56, account: buyer, factory, market, nonce: 7, action: { kind: 'withdraw' }, data: '0x1234', value: '0', submittedAt: '2026-09-26T00:00:00.000Z' };
  const transaction = { hash, from: buyer, to: market, nonce: 7, data: '0x1234', value: 0n, chainId: 56n };
  const provider = (tx = transaction, chain = 56n) => ({
    getNetwork: async () => ({ chainId: chain }), getTransaction: async () => tx, getTransactionReceipt: async () => null,
    getBlock: async () => ({ number: 1, hash: `0x${'12'.repeat(32)}` }), getTransactionCount: async () => 7,
  }) as unknown as Provider;
  const result = await recoverMarketReceipt(provider(), pending, hash);
  assert.equal(result.pending.hash, hash); assert.equal(result.receipt, null);
  await assert.rejects(recoverMarketReceipt(provider({ ...transaction, from: seller }), pending, hash), /不匹配/);
  await assert.rejects(recoverMarketReceipt(provider({ ...transaction, value: 1n }), { ...pending, hash }, hash), /不匹配/);
  await assert.rejects(recoverMarketReceipt(provider(transaction, 1n), pending, hash), /BSC 主网/);
});
test('manual factory verification requires a coded address on BSC, not only a valid hex string', async () => {
  const provider = { getNetwork: async () => ({ chainId: 56n }), getBlockNumber: async () => 123, getCode: async () => '0x' } as unknown as Provider;
  await assert.rejects(readMarketIdentity(provider, factory), /没有 Factory 合约代码/);
});

test('final market check uses only routing, fee, exact order and execution reads', async () => {
  const marketAbi = new Interface(MARKET_ABI), factoryAbi = new Interface(FACTORY_ABI);
  const quote: MarketQuote = {
    action: { kind: 'fill', orderId: '1', amount: '2', expectedPrice: '101' }, account: buyer,
    identity: { factory, market, timelock, blockNumber: 100 }, title: '购买', pool, amount: 2n,
    gross: 202n, fee: 2n, sellerProceeds: 200n, withdrawal: 0n,
    gasLimit: 200000n, gasPrice: 1000000000n, gasCost: 200000000000000n,
    total: 200000000000202n, data: marketAbi.encodeFunctionData('fill', [1n, 2n]),
  };
  let routed = market, fee = 100n, price = 101n, expires = 2n ** 63n, simulated = true;
  const calls: string[] = [];
  const provider = {
    getNetwork: async () => ({ chainId: 56n }),
    getBlockNumber: async () => 101,
    call: async ({ to, data, blockTag, value, gasLimit }: { to: string; data: string; blockTag?: number; value?: bigint; gasLimit?: bigint }) => {
      assert.equal(blockTag, 101, 'final checks use one chain snapshot');
      calls.push(data.slice(0, 10));
      if (to.toLowerCase() === factory.toLowerCase()) return factoryAbi.encodeFunctionResult('shareMarket', [routed]);
      if (data.startsWith(marketAbi.getFunction('feeBps')!.selector)) return marketAbi.encodeFunctionResult('feeBps', [fee]);
      if (data.startsWith(marketAbi.getFunction('orders')!.selector)) return marketAbi.encodeFunctionResult('orders', [[seller, pool, 17n, price, true]]);
      if (data.startsWith(marketAbi.getFunction('orderExpiresAt')!.selector)) return marketAbi.encodeFunctionResult('orderExpiresAt', [expires]);
      assert.equal(to.toLowerCase(), market.toLowerCase());
      assert.equal(data, quote.data); assert.equal(value, quote.gross);
      assert.equal(gasLimit, quote.gasLimit, 'final execution uses the approved gas ceiling');
      if (!simulated) throw new Error('execution reverted');
      return '0x';
    },
  } as unknown as Provider;
  await assert.doesNotReject(verifyMarketQuoteForSend(provider, quote));
  assert.equal(calls.length, 5, 'no duplicate identity, pool, gas, balance, or simulation preflight');
  routed = seller;
  await assert.rejects(verifyMarketQuoteForSend(provider, quote), /市场地址已变化/);
  routed = market; fee = 200n;
  await assert.rejects(verifyMarketQuoteForSend(provider, quote), /手续费已变化/);
  fee = 100n; price = 102n;
  await assert.rejects(verifyMarketQuoteForSend(provider, quote), /价格或可购买份额已变化/);
  price = 101n; expires = 1n;
  await assert.rejects(verifyMarketQuoteForSend(provider, quote), /价格或可购买份额已变化/);
  expires = 2n ** 63n; simulated = false;
  await assert.rejects(verifyMarketQuoteForSend(provider, quote), /execution reverted/);
});

test('fast market send still stops before wallet submission when the server intent write fails', async () => {
  const marketAbi = new Interface(MARKET_ABI), factoryAbi = new Interface(FACTORY_ABI);
  const quote: MarketQuote = {
    action: { kind: 'withdraw' }, account: buyer, identity: { factory, market, timelock, blockNumber: 100 },
    title: '领取', gross: 0n, fee: 0n, sellerProceeds: 0n, withdrawal: 123n,
    gasLimit: 100000n, gasPrice: 1000000000n, gasCost: 100000000000000n,
    total: 100000000000000n, data: marketAbi.encodeFunctionData('withdrawBnb'),
  };
  const methods: string[] = [];
  let submittedTx: Record<string, string> | null = null;
  const hash = `0x${'ac'.repeat(32)}`;
  const wallet: WalletProvider = { request: async ({ method, params }) => {
    methods.push(method);
    if (method === 'eth_chainId') return '0x38';
    if (method === 'eth_accounts') return [buyer];
    if (method === 'eth_blockNumber') return '0x65';
    if (method === 'eth_getTransactionCount') return '0x7';
    if (method === 'eth_sendTransaction') {
      submittedTx = (params as [Record<string, string>])[0];
      return hash;
    }
    if (method === 'eth_call') {
      const tx = (params as [{ to: string; data: string }])[0];
      if (tx.to.toLowerCase() === factory.toLowerCase()) return factoryAbi.encodeFunctionResult('shareMarket', [market]);
      if (tx.data.startsWith(marketAbi.getFunction('feeBps')!.selector)) return marketAbi.encodeFunctionResult('feeBps', [100n]);
      return '0x';
    }
    throw new Error(`unexpected wallet request: ${method}`);
  } };
  const storage: MarketJournalStorage = {
    getItem: async () => null,
    setItem: async () => { throw new Error('server disk unavailable'); },
    removeItem: async () => { throw new Error('unexpected delete'); },
  };
  await assert.rejects(sendMarketAction(wallet, quote, storage, () => {}), /server disk unavailable/);
  assert(!methods.includes('eth_sendTransaction'));
  assert(!methods.includes('eth_estimateGas'), 'preview gas estimate is not repeated at submission');
  assert.equal(methods.filter(method => method === 'eth_call').length, 3);
  methods.length = 0;
  let serverRecord: string | null = null, writes = 0;
  const successful: MarketJournalStorage = {
    getItem: async () => serverRecord,
    setItem: async (_key, value) => { writes += 1; serverRecord = value; },
    removeItem: async () => { throw new Error('unexpected delete'); },
  };
  const result = await sendMarketAction(wallet, quote, successful, () => {});
  assert.equal(result.hash, hash);
  assert.equal(writes, 2, 'server intent ACK precedes send, then returned hash is saved');
  assert.equal(methods.filter(method => method === 'eth_sendTransaction').length, 1);
  assert(!methods.includes('eth_estimateGas'));
  const sent = submittedTx as Record<string, string> | null;
  assert(sent);
  assert.equal(sent.from.toLowerCase(), buyer.toLowerCase());
  assert.equal(sent.to.toLowerCase(), market.toLowerCase());
  assert.equal(sent.data, quote.data);
  assert.equal(sent.value, '0x0');
  assert.equal(sent.nonce, '0x7');
  assert.equal(sent.chainId, '0x38');
  assert.equal(sent.gas, '0x186a0');
});

test('cross-tab lock rejects concurrent market submission and releases after the first request', async () => {
  let locked = false, requests = 0, actions = 0;
  const locks = { request: async (name: string, options: { ifAvailable: boolean }, callback: (lock: { name: string } | null) => Promise<unknown>) => {
    assert.equal(name, 'pinkuang-market-chain56'); assert.equal(options.ifAvailable, true); requests += 1;
    if (locked) return callback(null);
    locked = true;
    try { return await callback({ name }); } finally { locked = false; }
  } } as unknown as Pick<LockManager, 'request'>;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const first = withMarketTransactionLock(async () => { actions += 1; await held; return 'confirmed request'; }, locks);
  await assert.rejects(withMarketTransactionLock(async () => { actions += 1; }, locks), /另一个页面/);
  assert.equal(actions, 1, 'competing tab must not simulate, change the journal, or request a signature');
  release(); assert.equal(await first, 'confirmed request');
  assert.equal(await withMarketTransactionLock(async () => 'subsequent explicit request', locks), 'subsequent explicit request');
  assert.equal(requests, 3);
});

test('a persisted unknown intent blocks a subsequent tab before any wallet request or journal overwrite', async () => {
  const pending: PendingMarketTransaction = { version: 1, chainId: 56, account: buyer, factory, market, nonce: 7,
    action: { kind: 'withdraw' }, data: '0x1234', value: '0', submittedAt: '2026-09-26T00:00:00.000Z' };
  let requests = 0, writes = 0;
  const wallet: WalletProvider = { request: async () => { requests += 1; throw new Error('Unexpected wallet request.'); } };
  const storage = { getItem: async () => JSON.stringify(pending), setItem: async () => { writes += 1; }, removeItem: async () => { writes += 1; } };
  await assert.rejects(sendMarketAction(wallet, {} as MarketQuote, storage, () => { writes += 1; }), /待确认/);
  assert.equal(requests, 0); assert.equal(writes, 0);
});

test('unavailable server journal blocks a market send before any wallet request', async () => {
  let requests = 0;
  const wallet: WalletProvider = { request: async () => { requests += 1; throw new Error('Unexpected wallet request.'); } };
  const storage = { getItem: async () => { throw new Error('Server unavailable.'); },
    setItem: async () => { throw new Error('Must not write.'); }, removeItem: async () => { throw new Error('Must not delete.'); } };
  await assert.rejects(sendMarketAction(wallet, {} as MarketQuote, storage, () => {}), /Server unavailable/);
  assert.equal(requests, 0);
});

test('open sale votes block new orders and fills, and expiry rejects its exact boundary and legacy orders', () => {
  assert.throws(() => requireList({ state: 2, tradingAllowed: false, available: 49n }, 1n), /表决/);
  assert.throws(() => requireFill(order, { state: 2, tradingAllowed: false, balance: 0n }, buyer, 1n), /暂停/);
  const position = { state: 2, tradingAllowed: true, balance: 0n };
  assert.doesNotThrow(() => requireFill({ ...order, expiresAt: 100n }, position, buyer, 1n, 99n));
  assert.throws(() => requireFill({ ...order, expiresAt: 100n }, position, buyer, 1n, 100n), /到期/);
  assert.throws(() => requireFill({ ...order, expiresAt: 0n }, position, buyer, 1n, 1n), /到期/);
});

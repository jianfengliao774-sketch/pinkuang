import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { JsonRpcProvider, getAddress, type Provider } from 'ethers';
import { PENDING_MARKET_KEY, reconcileMarketPending, recoverMarketReceipt, restoreMarketPending, sendMarketAction,
  type PendingMarketTransaction, type MarketQuote } from './market';

const account = '0x1111111111111111111111111111111111111111';
const market = '0x2222222222222222222222222222222222222222';
const factory = '0x3333333333333333333333333333333333333333';
const txHash = `0x${'aa'.repeat(32)}`, otherHash = `0x${'bb'.repeat(32)}`;
const blockHash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const intent = (): PendingMarketTransaction => ({ version: 1, chainId: 56, account, factory, market, nonce: 7,
  action: { kind: 'withdraw' }, data: '0x1234', value: '0', hash: txHash, submittedAt: '2026-09-26T00:00:00Z' });
function memoryStorage(pending = intent()): Storage {
  const values = new Map([[PENDING_MARKET_KEY, JSON.stringify(pending)]]);
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key) } as unknown as Storage;
}
function fake(options: { finalized?: number; latest?: number; canonical?: boolean; unsupported?: boolean; nonce?: number; receiptFrom?: string; cancel?: boolean; receiptStatus?: number } = {}): Provider {
  const hash = options.cancel ? otherHash : txHash, to = options.cancel ? account : market;
  const transaction = { hash, from: account, to, nonce: 7, data: options.cancel ? '0x' : '0x1234', value: 0n, chainId: 56n, blockNumber: 10, blockHash: blockHash(10) };
  const receipt = { hash, from: options.receiptFrom ?? account, to, blockNumber: 10, blockHash: blockHash(10), status: options.receiptStatus ?? 1, fee: 123n };
  return {
    getNetwork: async () => ({ chainId: 56n }), getTransaction: async (value: string) => value === hash ? transaction : null,
    getTransactionReceipt: async (value: string) => value === hash ? receipt : null,
    getTransactionCount: async () => options.nonce ?? 8,
    getBlock: async (tag: string | number) => {
      if (tag === 'finalized' && options.unsupported) throw new Error('unsupported finalized');
      const n = tag === 'finalized' ? options.finalized ?? 20 : tag === 'latest' ? options.latest ?? 21 : Number(tag);
      return { number: n, hash: options.canonical === false && n === 10 ? blockHash(999) : blockHash(n) };
    },
  } as unknown as Provider;
}

test('one receipt and two confirmations without finalized both keep the UI journal locked', async () => {
  for (const latest of [10, 11]) {
    const saved = intent(), storage = memoryStorage(saved);
    const result = await reconcileMarketPending(fake({ finalized: 9, latest }), saved, storage);
    assert.equal(result.receipt?.status, 1); assert.equal(result.resolution, null);
    assert(restoreMarketPending(storage), 'the same helper used by MarketPage must retain pending intent');
    let walletCalls = 0;
    await assert.rejects(sendMarketAction({ request: async () => { walletCalls++; throw new Error('must not send'); } }, {} as MarketQuote, storage, () => {}), /待确认/);
    assert.equal(walletCalls, 0);
  }
});

test('unsupported finality, orphaned receipts and an unconsumed finalized nonce never clear pending', async () => {
  for (const options of [{ unsupported: true }, { canonical: false }, { nonce: 7 }]) {
    const saved = intent(), storage = memoryStorage(saved);
    const result = await reconcileMarketPending(fake(options), saved, storage);
    assert.equal(result.resolution, null); assert(restoreMarketPending(storage));
  }
  await assert.rejects(recoverMarketReceipt(fake({ receiptFrom: market }), intent()), /身份不一致/);
});

test('a canonical anchor changing during finality checks does not resolve the journal', async () => {
  const provider = fake(), getBlock = provider.getBlock.bind(provider);
  let reads = 0;
  provider.getBlock = async (tag, prefetch) => {
    const block = await getBlock(tag, prefetch);
    if (tag === 10 && ++reads === 2) return { ...block, hash: blockHash(999) } as typeof block;
    return block;
  };
  const saved = intent(), storage = memoryStorage(saved);
  assert.equal((await reconcileMarketPending(provider, saved, storage)).resolution, null);
  assert(restoreMarketPending(storage));
});

test('finalized original success/revert or cancellation resolves exactly the matching journal', async () => {
  for (const [options, resolution, hash] of [
    [{}, 'confirmed', undefined], [{ receiptStatus: 0 }, 'reverted', undefined], [{ cancel: true }, 'cancelled', otherHash],
  ] as const) {
    const saved = intent(), storage = memoryStorage(saved);
    const result = await reconcileMarketPending(fake(options), saved, storage, hash);
    assert.equal(result.resolution, resolution); assert.equal(restoreMarketPending(storage), null);
  }
  const newer = { ...intent(), nonce: 8 }, storage = memoryStorage(newer);
  await assert.rejects(reconcileMarketPending(fake(), intent(), storage), /其他页面更新/);
  assert.deepEqual(restoreMarketPending(storage), newer, 'stale tab cannot erase a newer transaction');
});

test('a replacement hash is retained across reload before finality and foreign hashes are rejected', async () => {
  const saved = intent(), storage = memoryStorage(saved);
  await reconcileMarketPending(fake({ cancel: true, finalized: 9 }), saved, storage, otherHash);
  const restored = restoreMarketPending(storage)!;
  assert.equal(restored.hash, txHash); assert.deepEqual(restored.recoveryHashes, [otherHash]);
  assert.equal((await reconcileMarketPending(fake({ cancel: true }), restored, storage)).resolution, 'cancelled');
  const wrong = fake(); wrong.getTransaction = async () => ({ hash: otherHash, from: account, nonce: 8, chainId: 56n }) as Awaited<ReturnType<Provider['getTransaction']>>;
  await assert.rejects(recoverMarketReceipt(wrong, { ...intent(), hash: undefined }, otherHash), /不匹配/);
});

test('an original transaction that wins the nonce is recognized even after a cancellation hash was recorded', async () => {
  const saved = { ...intent(), recoveryHashes: [otherHash] }, storage = memoryStorage(saved);
  const result = await reconcileMarketPending(fake(), saved, storage);
  assert.equal(result.resolution, 'confirmed'); assert.equal(result.receipt!.hash, txHash);
  assert.equal(restoreMarketPending(storage), null);
});

test('a finalized consumed nonce without any known canonical receipt remains blocked for explicit hash recovery', async () => {
  const provider = fake(); provider.getTransaction = async () => null;
  const saved = intent(), storage = memoryStorage(saved);
  const result = await reconcileMarketPending(provider, saved, storage);
  assert.equal(result.resolution, null); assert.match(result.message, /nonce 已在最终区块中使用/);
  assert(restoreMarketPending(storage));
});

// Loopback-only Anvil, disposable unlocked accounts, no secrets and no external RPC.
let node: ReturnType<typeof spawn>, provider: JsonRpcProvider, accounts: string[];
before(async () => {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  node = spawn(fileURLToPath(new URL('../node_modules/.bin/anvil', import.meta.url)),
    ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '56', '--no-mining', '--base-fee', '0', '--silent'], { stdio: 'ignore' });
  provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, undefined, { cacheTimeout: -1 });
  for (let n = 0; n < 50; n++) {
    try { accounts = (await provider.send('eth_accounts', [])).map(getAddress); break; } catch { await delay(100); }
  }
  assert(accounts?.length);
});
after(() => { provider?.destroy(); node?.kill('SIGTERM'); });
async function mine(n: number) { await provider.send('anvil_mine', [`0x${n.toString(16)}`]); }
async function sent(accountIndex: number) {
  const account = accounts[accountIndex], market = accounts[8], nonce = await provider.getTransactionCount(account);
  const original = { from: account, to: market, data: '0x1234', value: '0x0', gas: '0x186a0', gasPrice: '0x3b9aca00', nonce: `0x${nonce.toString(16)}` };
  const hash = await provider.send('eth_sendTransaction', [original]);
  const pending = { ...intent(), account, market, nonce, hash };
  return { original, pending, storage: memoryStorage(pending) };
}

test('Anvil: finalized same-nonce wallet cancellation unlocks the market without resending', async () => {
  const { original, pending, storage } = await sent(0);
  const cancellation = await provider.send('eth_sendTransaction', [{ ...original, to: pending.account, data: '0x', gas: '0x5208', gasPrice: '0x77359400' }]);
  await mine(2);
  assert.equal((await reconcileMarketPending(provider, pending, storage, cancellation)).resolution, null);
  const restored = restoreMarketPending(storage)!;
  await mine(66);
  assert.equal(await provider.getTransactionReceipt(pending.hash!), null);
  const result = await reconcileMarketPending(provider, restored, storage);
  assert.equal(result.resolution, 'cancelled'); assert.equal(result.receipt!.hash, cancellation);
  assert.equal(restoreMarketPending(storage), null);
  assert.equal(await provider.getTransactionCount(pending.account, 'latest'), pending.nonce + 1);
});

test('Anvil: exact-payload acceleration succeeds, different-payload replacement is never reported as market success', async () => {
  for (const [index, change, expected] of [[1, false, 'confirmed'], [2, true, 'replaced']] as const) {
    const { original, pending, storage } = await sent(index);
    const replacement = await provider.send('eth_sendTransaction', [{ ...original, data: change ? '0xabcd' : original.data, gasPrice: '0x77359400' }]);
    await mine(66);
    const result = await reconcileMarketPending(provider, pending, storage, replacement);
    assert.equal(result.resolution, expected); assert.equal(result.receipt!.hash, replacement);
    assert.equal(restoreMarketPending(storage), null);
  }
});

test('Anvil: a one-block receipt disappearing after reorg preserves the original intent and never resends', async () => {
  const checkpoint = await provider.send('evm_snapshot', []);
  const { pending, storage } = await sent(3);
  await mine(1);
  const first = await reconcileMarketPending(provider, pending, storage);
  assert.equal(first.receipt!.status, 1); assert.equal(first.resolution, null);
  await provider.send('evm_revert', [checkpoint]);
  assert.equal(await provider.getTransactionReceipt(pending.hash!), null);
  const afterReorg = await reconcileMarketPending(provider, restoreMarketPending(storage)!, storage);
  assert.equal(afterReorg.resolution, null); assert(restoreMarketPending(storage));
  assert.equal(await provider.getTransactionCount(pending.account, 'latest'), pending.nonce);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { getCreateAddress, keccak256, toQuantity, type Provider } from 'ethers';
import { prepareGovernance24Intent, assertGovernance24IntentCurrent, discoverGovernance24Transaction,
  verifyGovernance24RecoveryReceipt, validateGovernance24Intent, parseGovernance24Journal, newGovernance24Journal,
  submitGovernance24Upgrade, type Governance24Intent } from './governance24-upgrade-ui';

const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const from = a(6), data = '0x60006000', dataHash = keccak256(data), txHash = h(900);
const intent: Governance24Intent = { schemaVersion: 1, chainId: 56, nonce: 7, anchor: { blockNumber: 100, blockHash: h(100) } };
function fixture() {
  const calls: { method: string; tag?: unknown; full?: boolean }[] = [];
  const state = { mined: true, block: 100500, finalized: 100000000, chain: '0x38', status: 1,
    latest: null as number | null, pending: null as number | null, historicalFailure: false,
    badCount: false, fullAvailable: true, fullSeen: false, reorg: false, anchorReorg: false,
    wrongCreateAddress: false, receiptMissing: false, fullHashMismatch: false, rawCount: null as string | null };
  const tx = { hash: txHash, from, to: null as string | null, chainId: 56n, nonce: 7, value: 0n, data,
    blockNumber: state.block, blockHash: h(state.block) };
  const countAt = (height: number) => state.mined && height >= state.block ? 8 : 7;
  const provider = {
    send: async (method: string, params: any[]) => {
      if (method === 'eth_chainId') { calls.push({ method }); return state.chain; }
      if (method === 'eth_getTransactionCount') {
        const tag = ['latest', 'pending'].includes(params[1]) ? params[1] : Number(BigInt(params[1]));
        return state.rawCount ?? toQuantity(await provider.getTransactionCount(params[0], tag));
      }
      assert.equal(method, 'eth_getBlockByNumber'); assert.equal(params[1], true);
      const block = await provider.getBlock(Number(BigInt(params[0])), true);
      return { ...block, number: toQuantity(block!.number), hash: state.fullHashMismatch ? h(555) : block!.hash,
        transactions: state.fullAvailable ? [{ ...tx, nonce: toQuantity(tx.nonce), chainId: toQuantity(tx.chainId),
          value: toQuantity(tx.value), input: tx.data, blockNumber: toQuantity(tx.blockNumber) }] : [tx.hash] };
    },
    getTransactionCount: async (_from: string, tag: number | string) => {
      assert.equal(_from.toLowerCase(), from.toLowerCase()); calls.push({ method: 'nonce', tag });
      if (tag === 'latest') return state.latest ?? countAt(state.finalized);
      if (tag === 'pending') return state.pending ?? state.latest ?? countAt(state.finalized);
      if (state.historicalFailure) throw Error('historical count unsupported');
      if (state.badCount && Number(tag) > 100 && Number(tag) < state.finalized) return 6;
      return countAt(Number(tag));
    },
    getBlock: async (tag: number | string, full = false) => {
      calls.push({ method: 'block', tag, full }); if (full) state.fullSeen = true;
      const height = tag === 'finalized' ? state.finalized : Number(tag);
      const changed = state.fullSeen && (state.reorg && height === state.finalized || state.anchorReorg && height === 100);
      const transactions = state.mined && height === state.block ? [txHash] : [];
      return { number: height, hash: changed ? h(999) : h(height), timestamp: 1000 + height,
        transactions, ...(full && state.fullAvailable ? { prefetchedTransactions: [tx] } : {}) };
    },
    getTransaction: async (hash: string) => { assert.equal(hash, txHash); calls.push({ method: 'transaction' }); return tx; },
    getTransactionReceipt: async (hash: string) => {
      assert.equal(hash, txHash); calls.push({ method: 'receipt' });
      return state.receiptMissing ? null : { hash: txHash, from: tx.from, to: tx.to, status: state.status,
        blockNumber: state.block, blockHash: h(state.block), index: 0, gasUsed: 21000n,
        contractAddress: state.status === 1 && !tx.to ? state.wrongCreateAddress ? a(99) : getCreateAddress({ from, nonce: tx.nonce }) : null };
    },
  } as unknown as Provider;
  return { provider, state, tx, calls, expected: { from, dataHash, intent } };
}
test('new intent pins a canonical finalized anchor and an idle wallet nonce; submission passes that exact nonce', async () => {
  const f = fixture(); f.state.mined = false;
  const prepared = await prepareGovernance24Intent(f.provider, from);
  assert.deepEqual(prepared, { ...intent, anchor: { blockNumber: f.state.finalized, blockHash: h(f.state.finalized) } });
  const sent: any[] = [], trace: string[] = [];
  const wallet = { request: async ({ method, params }: any) => {
    if (method === 'eth_chainId') return '0x38'; if (method === 'eth_accounts') return [from];
    assert.equal(method, 'eth_sendTransaction'); trace.push('wallet'); sent.push(params[0]); return txHash;
  } };
  await submitGovernance24Upgrade(wallet, { from, data, gasLimit: '2500000', intent: prepared }, {
    beforeRequest: () => { trace.push('durable'); }, submitted: hash => { assert.equal(hash, txHash); trace.push('hash'); }, definitelyRejected: () => assert.fail(),
  });
  assert.deepEqual(trace, ['durable', 'wallet', 'hash']);
  assert.equal(sent.length, 1); assert.equal(sent[0].nonce, '0x7'); assert.equal(sent[0].gas, '0x2625a0'); assert.equal(sent[0].value, '0x0');
});
test('pending nonce and last-moment nonce changes block new sends', async () => {
  const pending = fixture(); pending.state.mined = false; pending.state.pending = 8;
  await assert.rejects(prepareGovernance24Intent(pending.provider, from), /待处理/);
  const changed = fixture(); changed.state.mined = false; changed.state.latest = 8;
  await assert.rejects(assertGovernance24IntentCurrent(changed.provider, from, intent), /nonce 已变化/);
});
test('old v1 remains readable and cannot discover or infer a missing original nonce', async () => {
  const context = { factory: a(1), genesisRecordDigest: h(2), genesisManifestDigest: h(3), candidateArtifactDigest: h(4), catalogDigest: h(5), predecessorInputDigest: h(16) };
  const old = newGovernance24Journal(context, h(8)); old.deployments.FlexiblePurchase = { status: 'uncertain', from, dataHash };
  assert.deepEqual(parseGovernance24Journal(old, context), old);
  const f = fixture(); assert.equal(await discoverGovernance24Transaction(f.provider, { from, dataHash }), null); assert.equal(f.calls.length, 0);
  const next = { ...old, deployments: { FlexiblePurchase: { ...old.deployments.FlexiblePurchase, intent } } };
  assert.deepEqual(parseGovernance24Journal(next, context), next);
  for (const bad of [{ ...intent, nonce: -1 }, { ...intent, nonce: 1.1 }, { ...intent, chainId: 1 },
    { ...intent, nonce: Number.MAX_SAFE_INTEGER + 1 }, { ...intent, anchor: { blockNumber: 100, blockHash: 'wrong' } }])
    assert.throws(() => validateGovernance24Intent(bad));
});
test('bounded bisection finds a finalized hashless CREATE and verifies exact CREATE address, without wallet methods', async () => {
  const f = fixture(); assert.equal(await discoverGovernance24Transaction(f.provider, f.expected), txHash);
  assert.equal(f.calls.filter(call => call.method === 'block' && call.full).length, 1);
  assert(f.calls.filter(call => call.method === 'nonce').length <= 40, 'Logarithmic historical nonce reads');
  assert(!f.calls.some(call => /send|sign/i.test(call.method)));
});
test('broadcast then wallet callback timeout keeps the intent and recovers exactly that hash with zero additional sends', async () => {
  const f = fixture(); f.state.mined = false;
  const prepared = await prepareGovernance24Intent(f.provider, from);
  let stored: { status: string; intent: Governance24Intent } | null = null, sends = 0;
  const wallet = { request: async ({ method, params }: any) => {
    if (method === 'eth_chainId') return '0x38'; if (method === 'eth_accounts') return [from];
    assert.equal(method, 'eth_sendTransaction'); assert(stored); assert.equal(params[0].nonce, '0x7'); sends++;
    f.state.block = f.state.finalized + 1; f.tx.blockNumber = f.state.block; f.tx.blockHash = h(f.state.block);
    f.state.finalized += 10; f.state.mined = true;
    throw Error('Wallet transport timed out after the transaction was accepted');
  } };
  await assert.rejects(submitGovernance24Upgrade(wallet, { from, data, intent: prepared }, {
    beforeRequest: () => { stored = { status: 'uncertain', intent: prepared }; },
    submitted: () => assert.fail('No returned hash'), definitelyRejected: () => assert.fail('Broadcast is ambiguous'),
  }), /发送结果未确定/);
  assert(stored);
  assert.equal(await discoverGovernance24Transaction(f.provider, { ...f.expected, intent: prepared }), txHash);
  assert.equal(sends, 1); assert.equal((stored as { status: string }).status, 'uncertain', 'The caller must persist the proven hash explicitly');
});
test('matching finalized failed transactions can be found for existing failure verification; discovery itself does not archive', async () => {
  const f = fixture(); f.state.status = 0;
  assert.equal(await discoverGovernance24Transaction(f.provider, f.expected), txHash);
  assert.equal(f.state.status, 0);
});
test('pending, absent receipt, or not-yet-finalized nonce never returns a hash or authorizes a retry', async () => {
  const pending = fixture(); pending.state.mined = false; pending.state.pending = 8;
  assert.equal(await discoverGovernance24Transaction(pending.provider, pending.expected), null);
  assert.equal(pending.calls.filter(call => call.full).length, 0);
  const future = fixture(); future.state.finalized = future.state.block - 1;
  assert.equal(await discoverGovernance24Transaction(future.provider, future.expected), null);
  const missing = fixture(); missing.state.receiptMissing = true;
  assert.equal(await discoverGovernance24Transaction(missing.provider, missing.expected), null);
});
test('same initcode with an old nonce cannot recover a new intent, including a supplied hash', async () => {
  const f = fixture(); f.tx.nonce = 6;
  await assert.rejects(discoverGovernance24Transaction(f.provider, f.expected), /nonce 已消费/);
  await assert.rejects(verifyGovernance24RecoveryReceipt(f.provider, txHash, f.expected), /不匹配/);
});
test('same-nonce cancellation, replacement, wrong chain, or changed deployment data stays blocked', async () => {
  for (const change of [(f: ReturnType<typeof fixture>) => { f.tx.to = from; f.tx.data = '0x'; },
    (f: ReturnType<typeof fixture>) => { f.tx.data = '0x6001'; },
    (f: ReturnType<typeof fixture>) => { f.tx.value = 1n; },
    (f: ReturnType<typeof fixture>) => { f.tx.chainId = 1n; },
    (f: ReturnType<typeof fixture>) => { f.tx.from = a(7); }]) {
    const f = fixture(); change(f); await assert.rejects(discoverGovernance24Transaction(f.provider, f.expected));
  }
});
test('matching timelock transaction needs exact target and nonce', async () => {
  const f = fixture(); f.tx.to = a(20);
  assert.equal(await discoverGovernance24Transaction(f.provider, { ...f.expected, to: a(20) }), txHash);
  await assert.rejects(discoverGovernance24Transaction(f.provider, { ...f.expected, to: a(21) }), /另一笔交易/);
});
test('anchor/finality reorg, bad historical count, unavailable full block, and unsupported history fail closed', async () => {
  for (const property of ['anchorReorg', 'reorg', 'badCount', 'historicalFailure', 'wrongCreateAddress', 'fullHashMismatch'] as const) {
    const f = fixture(); f.state[property] = true;
    await assert.rejects(discoverGovernance24Transaction(f.provider, f.expected));
  }
  const noFull = fixture(); noFull.state.fullAvailable = false;
  await assert.rejects(discoverGovernance24Transaction(noFull.provider, noFull.expected), /完整区块交易/);
  const wrong = fixture(); wrong.state.chain = '0x1'; await assert.rejects(discoverGovernance24Transaction(wrong.provider, wrong.expected), /BSC/);
});
test('raw count quantities must be canonical and exact; wallet full-block proofs cannot replace public headers', async () => {
  for (const value of ['7', '0x07', '-1', '0x20000000000000']) {
    const f = fixture(); f.state.rawCount = value; await assert.rejects(discoverGovernance24Transaction(f.provider, f.expected));
  }
  const f = fixture(); f.state.fullHashMismatch = true;
  await assert.rejects(discoverGovernance24Transaction(f.provider, f.expected), /公开节点规范区块/);
});
test('a nonce already consumed at the alleged pre-send anchor cannot be adopted', async () => {
  const f = fixture(); f.state.block = 99;
  await assert.rejects(discoverGovernance24Transaction(f.provider, f.expected), /发送前已被消费/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAddress } from 'ethers';
import formal from '../../deploy/ops/v5/latest-20261003/frontend-manifest.json' with { type: 'json' };
import { abi } from '../lib/chain-client.mjs';
import { freshManifestDigest, loadFreshDisplayConfig } from '../lib/fresh-product-config.mjs';
import { prepareProductAction } from '../lib/live-actions.mjs';
import { readMemberReceipt, readMemberTransactions, saveMemberTransactions,
  sendMemberWalletTransaction } from '../lib/member-wallet-transactions.mjs';
import { buildRewardCollectionPlan, readRewardBalances, runRewardCollection } from '../lib/reward-collection.mjs';
import { clearRewardCollectionRecovery, readRewardCollectionRecovery,
  saveRewardCollectionRecovery } from '../lib/reward-collection-session.mjs';

const account = getAddress('0x0000000000000000000000000000000000000123');
const pool = getAddress('0x0000000000000000000000000000000000000456');
const txHash = index => `0x${index.toString(16).padStart(64, '0')}`;
const blockHash = index => `0x${(index + 1000).toString(16).padStart(64, '0')}`;
const storage = () => {
  const entries = new Map();
  return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key) };
};
const row = () => ({ pool, trusted: true, state: 0n, shares: 25n,
  claimableBEM: 0n, bnbOwed: 0n });

async function fixture(walletReply = null) {
  const config = await loadFreshDisplayConfig({ origin: 'https://example.test', basePath: '/bemine-v5',
    manifestSha256: freshManifestDigest(formal), pinnedManifest: formal,
    fetcher: () => { throw Error('Unexpected fetch or journal request.'); } });
  const calls = [], sent = [], receipts = new Map();
  const snapshots = new Map([[100n, { state: 2n, claimableBEM: 0n, shares: 25n, bnbOwed: 0n }]]);
  let head = 100n;
  const header = number => ({ number: `0x${number.toString(16)}`, hash: blockHash(Number(number)) });
  const provider = { request: async ({ method, params = [] }) => {
    calls.push({ method, params });
    if (method === 'eth_chainId') return '0x38';
    if (method === 'eth_getBlockByNumber') return header(params[0] === 'latest' ? head : BigInt(params[0]));
    if (method === 'eth_getTransactionReceipt') return receipts.get(params[0]) ?? null;
    if (method === 'eth_call') {
      const contract = params[0].to.toLowerCase() === formal.factory.toLowerCase() ? abi.PoolFactory : abi.PoolVault;
      const decoded = contract.parseTransaction({ data: params[0].data });
      const selected = snapshots.get(BigInt(params[1]));
      assert(selected, 'All reads must pin an available snapshot block.');
      const value = decoded.name === 'isPool' ? true : decoded.name === 'factory' ? formal.factory
        : decoded.name === 'balanceOf' ? selected.shares
          : decoded.name === 'claimable' ? selected.claimableBEM
            : decoded.name === 'bnbOwed' ? selected.bnbOwed : selected.state;
      assert(['isPool', 'factory', 'state', 'balanceOf', 'claimable', 'bnbOwed'].includes(decoded.name));
      return contract.encodeFunctionResult(decoded.fragment, [value]);
    }
    throw Error(`Forbidden read method: ${method}`);
  } };
  const wallet = { request: async ({ method, params = [] }) => {
    assert.equal(method, 'eth_sendTransaction', 'No signing/login/nonce/fee/simulation request is allowed.');
    const tx = params[0];
    assert.equal(tx.to, pool);
    assert.equal(tx.from, account);
    assert.equal(tx.value, '0x0');
    assert.equal(tx.chainId, '0x38');
    const decoded = abi.PoolVault.parseTransaction({ data: tx.data });
    assert(['harvest', 'claim'].includes(decoded.name));
    sent.push(decoded.name);
    if (walletReply === 'rejected') throw Object.assign(Error('User rejected.'), { code: 4001 });
    if (walletReply === 'unknown') return undefined;
    const hash = txHash(sent.length);
    head += 1n;
    const prior = snapshots.get(head - 1n);
    snapshots.set(head, { ...prior, claimableBEM: decoded.name === 'harvest' ? 50n : 0n });
    receipts.set(hash, { transactionHash: hash, from: account, to: pool,
      blockNumber: `0x${head.toString(16)}`, blockHash: blockHash(Number(head)), status: '0x1' });
    return hash;
  } };
  return { config, provider, wallet, calls, sent };
}

async function runIntegrated({ config, provider, wallet, sent }, store, mode = 'collect-and-claim') {
  const plan = buildRewardCollectionPlan({ positions: [row()], account, config });
  assert.equal(plan.items.length, 1, 'The real Number(56) manifest must form an actionable plan.');
  let activeJob = null;
  const record = value => {
    const old = readMemberTransactions(config, account, store);
    const normalized = { ...value, account, target: value.pool, action: value.kind,
      data: abi.PoolVault.encodeFunctionData(value.kind), value: '0',
      ...(typeof value.blockNumber === 'bigint' ? { blockNumber: value.blockNumber.toString() } : {}) };
    saveMemberTransactions(config, account, [...old.filter(item => item.hash !== value.hash),
      { ...old.find(item => item.hash === value.hash), ...normalized }], store);
    if (['confirmed', 'failed'].includes(value.status)) {
      clearRewardCollectionRecovery(config, account, store, activeJob);
      activeJob = null;
    }
  };
  const result = await runRewardCollection({ plan, mode,
    readBalances: ({ pool: target, minBlockNumber }) => readRewardBalances({
      provider, pool: target, account, factory: plan.factory, minBlockNumber }),
    send: async ({ kind, balances }) => {
      const prepared = await prepareProductAction({ provider, config, account, pool, kind });
      const job = { account, factory: plan.factory, pool, kind, status: 'submitting', hash: null,
        data: prepared.transaction.data, value: '0', notBeforeBlock: balances.blockNumber.toString() };
      saveRewardCollectionRecovery(config, account, job, store);
      activeJob = job;
      try {
        const reply = await sendMemberWalletTransaction({ provider: wallet, config,
          transaction: prepared.transaction, action: { kind } });
        activeJob = { ...job, status: 'pending', hash: reply.hash };
        saveRewardCollectionRecovery(config, account, activeJob, store);
        return reply;
      } catch (error) {
        if (error?.code === 4001) {
          clearRewardCollectionRecovery(config, account, store, activeJob);
          activeJob = null;
        }
        throw error;
      }
    },
    waitReceipt: ({ hash }) => readMemberReceipt(provider, { hash, account, target: pool }),
    onRecord: record });
  return { result, recovery: readRewardCollectionRecovery(config, account, store),
    history: readMemberTransactions(config, account, store), sent };
}

test('real formal config drives harvest then fresh claim through wallet, guard and canonical receipts', async () => {
  const originalStorage = globalThis.localStorage;
  const store = storage(); globalThis.localStorage = store;
  try {
    const f = await fixture();
    const done = await runIntegrated(f, store);
    assert.equal(done.result.status, 'completed');
    assert.deepEqual(done.sent, ['harvest', 'claim']);
    assert.equal(done.result.stats.confirmed, 2);
    assert.equal(done.result.stats.skippedZero, 1);
    assert.equal(done.recovery, null);
    assert.deepEqual(done.history.map(item => item.status), ['confirmed', 'confirmed']);
    assert.deepEqual(done.history.map(item => item.blockNumber), ['101', '102']);
    assert(f.calls.filter(call => call.method === 'eth_call').every(call =>
      ['isPool', 'factory', 'state', 'balanceOf', 'claimable', 'bnbOwed'].some(name =>
        call.params[0].data.startsWith((call.params[0].to.toLowerCase() === formal.factory.toLowerCase()
          ? abi.PoolFactory : abi.PoolVault).getFunction(name)?.selector ?? 'never'))));
    assert(!f.calls.some(call => ['eth_estimateGas', 'eth_getTransactionCount', 'eth_gasPrice',
      'eth_feeHistory', 'personal_sign'].includes(call.method)));
  } finally { globalThis.localStorage = originalStorage; }
});

test('wallet refusal clears exact hashless guard; unknown wallet result keeps it and never resends', async () => {
  const originalStorage = globalThis.localStorage;
  try {
    for (const [reply, expected] of [['rejected', 'wallet_rejected'], ['unknown', 'send_unknown']]) {
      const store = storage(); globalThis.localStorage = store;
      const f = await fixture(reply);
      const stopped = await runIntegrated(f, store);
      assert.equal(stopped.result.status, 'stopped');
      assert.equal(stopped.result.reason, expected);
      assert.deepEqual(stopped.sent, ['harvest']);
      assert.equal(stopped.recovery === null, reply === 'rejected');
      assert.deepEqual(stopped.history, []);
    }
  } finally { globalThis.localStorage = originalStorage; }
});

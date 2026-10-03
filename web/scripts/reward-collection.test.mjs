import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAddress } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { buildRewardCollectionPlan, readRewardBalances, runRewardCollection } from '../lib/reward-collection.mjs';

const address = number => getAddress(`0x${BigInt(number).toString(16).padStart(40, '0')}`);
const FACTORY = address(101), ACCOUNT = address(102), POOL = address(103), POOL2 = address(104);
const HASH = `0x${'a'.repeat(64)}`, BLOCK_HASH = `0x${'b'.repeat(64)}`;
const row = changes => ({ pool: POOL, trusted: true, kind: 'single', state: 2n,
  shares: 20n, claimableBEM: 0n, bnbOwed: 0n, ...changes });
const build = positions => buildRewardCollectionPlan({ positions, account: ACCOUNT,
  config: { status: 'ready', manifest: { factory: FACTORY }, chainId: 56n } });
const plan = changes => Object.freeze({ account: ACCOUNT, factory: FACTORY, chainId: 56n,
  scope: 'loaded-single-pools', items: [Object.freeze({ pool: POOL, harvest: true })], ...changes });
const balances = changes => ({ pool: POOL, account: ACCOUNT, factory: FACTORY,
  chainId: 56n, blockNumber: 12n, blockHash: BLOCK_HASH,
  state: 2n, shares: 20n, claimableBEM: 0n, bnbOwed: 0n, ...changes });
const receipt = { status: 'confirmed', blockNumber: 13n };

test('plan deduplicates loaded singles, preserves zero-share historical credits and ignores portfolios', () => {
  const planned = build([row(), row({ pool: POOL.toLowerCase() }),
    row({ pool: POOL2, state: 4n, shares: 0n, claimableBEM: 1n, bnbOwed: 2n }),
    row({ pool: address(105), kind: 'portfolio' }), row({ pool: address(106), shares: 0n })]);
  assert.equal(planned.scope, 'loaded-single-pools');
  assert.deepEqual(planned.items.map(item => [item.pool, item.harvest]), [[POOL, true], [POOL2, false]]);
  assert.equal(build([row({ shares: 0n, state: 4n, claimableBEM: null, bnbOwed: null })]).items.length, 1);
  assert.throws(() => build([row(), row({ shares: 21n })]), /Conflicting duplicate/);
  assert.throws(() => build([row({ trusted: false })]), /not trusted/);
  assert.throws(() => build([row({ shares: 20.5 })]), /exact unsigned/);
  assert.equal(buildRewardCollectionPlan({ positions: [row()], account: ACCOUNT,
    config: { status: 'ready', manifest: { factory: FACTORY, chainId: 56 }, chainId: 56 } }).items.length, 1);
  assert.throws(() => buildRewardCollectionPlan({ positions: [row()], account: ACCOUNT,
    config: { status: 'ready', manifest: { factory: FACTORY, chainId: 1 } } }), /configured chain/);
});

test('all known zero balances and no eligible harvest produce no wallet calls', async () => {
  const empty = build([row({ state: 4n, shares: 0n }), row({ pool: POOL2, state: 0n, shares: 0n })]);
  assert.equal(empty.items.length, 0);
  const result = await runRewardCollection({ plan: empty, readBalances: () => { throw Error('unexpected'); },
    send: () => { throw Error('unexpected'); }, waitReceipt: () => { throw Error('unexpected'); } });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.records, []);
});

test('cached Funding shares remain candidates; fresh Active harvest and new refund credit are acted on', async () => {
  const planned = build([row({ state: 0n, claimableBEM: 0n, bnbOwed: 0n })]);
  assert.deepEqual(planned.items.map(item => item.harvest), [true]);
  const sent = [];
  const collected = await runRewardCollection({ plan: planned, mode: 'collect-only',
    readBalances: async () => balances({ state: 2n }),
    send: ({ kind }) => { sent.push(kind); return HASH; }, waitReceipt: () => receipt });
  assert.equal(collected.status, 'completed');
  assert.deepEqual(sent, ['harvest']);
  const claimed = await runRewardCollection({ plan: planned, mode: 'claim-only',
    readBalances: async () => balances({ state: 5n, bnbOwed: 12n }),
    send: ({ kind }) => { sent.push(kind); return HASH; }, waitReceipt: () => receipt });
  assert.equal(claimed.status, 'completed');
  assert.deepEqual(sent, ['harvest', 'withdrawBnb']);
});

test('harvest settles before fresh positive claim and BNB reads, with no zero sends', async () => {
  const sends = [], reads = [], writes = [], progress = [];
  const variants = [balances(), balances({ blockNumber: 13n, claimableBEM: 7n, bnbOwed: 3n }),
    balances({ blockNumber: 14n, bnbOwed: 3n })];
  const result = await runRewardCollection({ plan: plan(),
    readBalances: async input => { reads.push(input); return variants[reads.length - 1]; },
    send: async input => { sends.push(input.kind); return { hash: `0x${String(sends.length).padStart(64, '0')}` }; },
    waitReceipt: async input => ({ status: 'confirmed', blockNumber: 12n + BigInt(sends.length), hash: input.hash }),
    onProgress: value => progress.push(value), onRecord: value => writes.push([value.kind, value.status]) });
  assert.equal(result.status, 'completed');
  assert.deepEqual(sends, ['harvest', 'claim', 'withdrawBnb']);
  assert.deepEqual(reads.map(input => input.minBlockNumber), [0n, 13n, 14n]);
  assert.deepEqual(writes, [['harvest', 'pending'], ['harvest', 'confirmed'],
    ['claim', 'pending'], ['claim', 'confirmed'], ['withdrawBnb', 'pending'], ['withdrawBnb', 'confirmed']]);
  assert.deepEqual(progress.map(value => value.status), ['reading', 'submitting', 'waiting', 'settled',
    'reading', 'submitting', 'waiting', 'settled',
    'reading', 'submitting', 'waiting', 'settled']);
  assert(progress.every(value => value.index === 0 && value.total === 1));
  assert.deepEqual(progress.filter(value => value.phase === 'settled').map(value => value.stats.confirmed), [1, 2, 3]);
  assert.equal(progress.find(value => value.phase === 'waiting').hash,
    `0x${String(1).padStart(64, '0')}`);
});

test('a failed harvest receipt is recorded once; old verified claims may continue', async () => {
  const sent = [], readBlocks = [];
  const result = await runRewardCollection({ plan: plan(),
    readBalances: async input => {
      readBlocks.push(input.minBlockNumber);
      return balances({ blockNumber: input.minBlockNumber > 12n ? input.minBlockNumber : 12n,
        claimableBEM: 9n });
    },
    send: ({ kind }) => { sent.push(kind); return HASH; },
    waitReceipt: ({ kind }) => kind === 'harvest' ? { status: 'failed', blockNumber: 13n } : receipt });
  assert.equal(result.status, 'completed');
  assert.deepEqual(sent, ['harvest', 'claim']);
  assert.deepEqual(result.records.map(value => value.status), ['failed', 'confirmed']);
  assert.deepEqual(readBlocks, [0n, 13n, 13n]);
});

test('failed claim does not block an independently owed BNB withdrawal', async () => {
  const sent = [];
  const result = await runRewardCollection({ plan: plan({ items: [{ pool: POOL, harvest: false }] }),
    readBalances: async ({ minBlockNumber }) => balances({ blockNumber: minBlockNumber || 12n,
      claimableBEM: 5n, bnbOwed: 8n }),
    send: ({ kind }) => { sent.push(kind); return HASH; },
    waitReceipt: ({ kind }) => kind === 'claim'
      ? { status: 'failed', blockNumber: 13n } : { status: 'confirmed', blockNumber: 14n } });
  assert.equal(result.status, 'completed');
  assert.deepEqual(sent, ['claim', 'withdrawBnb']);
  assert.deepEqual(result.stats, { confirmed: 1, reverted: 1, skippedZero: 0 });
});

test('known zero claim balances are counted only after a fresh read', async () => {
  const result = await runRewardCollection({ plan: plan({ items: [{ pool: POOL, harvest: false }] }),
    readBalances: async () => balances({ state: 4n, shares: 0n }),
    send: () => { throw Error('zero amount was sent'); }, waitReceipt: () => receipt });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.stats, { confirmed: 0, reverted: 0, skippedZero: 2 });
  assert.deepEqual(result.steps.map(step => step.reason), ['zero_balance', 'zero_balance']);
});

test('modes keep collect-only and claim-only independent', async () => {
  for (const [mode, expected] of [['collect-only', ['harvest']],
    ['claim-only', ['claim', 'withdrawBnb']]]) {
    const sent = [];
    const result = await runRewardCollection({ plan: plan(), mode,
      readBalances: async ({ minBlockNumber }) => balances({
        blockNumber: minBlockNumber > 12n ? minBlockNumber : 12n, claimableBEM: 2n, bnbOwed: 3n }),
      send: async ({ kind }) => { sent.push(kind); return HASH; }, waitReceipt: async () => receipt });
    assert.equal(result.status, 'completed');
    assert.deepEqual(sent, expected);
  }
});

test('pending receipt stops the queue and preserves the known hash', async () => {
  let sent = 0;
  const result = await runRewardCollection({ plan: plan(), readBalances: async () => balances(),
    send: async () => { sent++; return HASH; }, waitReceipt: async () => ({ status: 'pending' }) });
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'receipt_pending');
  assert.equal(result.records[0].hash, HASH);
  assert.equal(result.records[0].status, 'pending');
  assert.equal(sent, 1);
});

test('a progress persistence error after broadcast keeps the hash and prevents the next read', async () => {
  let reads = 0, receipts = 0;
  const result = await runRewardCollection({ plan: plan(),
    readBalances: async () => { reads++; return balances(); },
    send: async () => HASH,
    waitReceipt: async () => { receipts++; return receipt; },
    onProgress: value => { if (value.phase === 'waiting') throw Error('display storage unavailable'); } });
  assert.equal(result.reason, 'record_failed');
  assert.equal(result.records[0].status, 'pending');
  assert.equal(result.records[0].hash, HASH);
  assert.equal(reads, 1);
  assert.equal(receipts, 0);
});

test('confirmed canonical RPC receipt may carry a hex block number', async () => {
  const result = await runRewardCollection({ plan: plan(), mode: 'collect-only',
    readBalances: async () => balances(), send: async () => HASH,
    waitReceipt: async () => ({ status: 'confirmed', blockNumber: '0xd' }) });
  assert.equal(result.status, 'completed');
  assert.equal(result.records[0].blockNumber, 13n);
});

test('wallet refusal, hashless submit and pre-send progress failure stop without retry', async () => {
  for (const [send, reason] of [
    [() => { throw Object.assign(Error('user rejected'), { code: 4001 }); }, 'wallet_rejected'],
    [() => undefined, 'send_unknown'],
  ]) {
    let calls = 0;
    const result = await runRewardCollection({ plan: plan(), readBalances: async () => balances(),
      send: async () => { calls++; return send(); }, waitReceipt: () => { throw Error('unreachable'); } });
    assert.equal(result.status, 'stopped'); assert.equal(result.reason, reason); assert.equal(calls, 1);
  }
  let calls = 0;
  const blocked = await runRewardCollection({ plan: plan(), readBalances: async () => balances(),
    send: () => { calls++; return HASH; }, waitReceipt: () => receipt,
    onProgress: () => { throw Error('cannot store submitting state'); } });
  assert.equal(blocked.reason, 'record_failed'); assert.equal(calls, 0);
  const preflight = await runRewardCollection({ plan: plan(), readBalances: async () => balances(),
    send: () => { throw Object.assign(Error('wallet changed before submission'), { beforeWalletSubmission: true }); },
    waitReceipt: () => { throw Error('unreachable'); } });
  assert.equal(preflight.reason, 'preflight_failed');
  assert.deepEqual(preflight.records, []);
});

test('wallet epoch changes and stale or failed fresh reads stop later actions', async () => {
  let current = true, called = 0;
  const changed = await runRewardCollection({ plan: plan(), isCurrent: () => current,
    readBalances: async () => balances(),
    send: () => { called++; current = false; return HASH; }, waitReceipt: () => { throw Error('unreachable'); } });
  assert.equal(changed.reason, 'wallet_changed'); assert.equal(called, 1);
  assert.equal(changed.records[0].status, 'pending');
  const stale = await runRewardCollection({ plan: plan(),
    readBalances: async ({ minBlockNumber }) => balances({ blockNumber: minBlockNumber > 0n ? 12n : 12n }),
    send: () => HASH, waitReceipt: () => receipt });
  assert.equal(stale.reason, 'read_failed');
  assert.equal(stale.records.length, 1);
  const failed = await runRewardCollection({ plan: plan(), readBalances: () => { throw Error('offline'); },
    send: () => { throw Error('unreachable'); }, waitReceipt: () => receipt });
  assert.equal(failed.reason, 'read_failed');
  assert.deepEqual(failed.records, []);
});

test('pinned read requires official registration, same-block balances and a canonical final header', async () => {
  const calls = [], head = { number: '0x14', hash: BLOCK_HASH };
  const values = { isPool: true, factory: FACTORY, state: 2n, balanceOf: 15n,
    claimable: 100n, bnbOwed: 40n };
  const provider = { request: async ({ method, params }) => {
    calls.push([method, params]);
    if (method === 'eth_chainId') return '0x38';
    if (method === 'eth_getBlockByNumber') return head;
    if (method === 'eth_call') {
      const iface = params[0].to.toLowerCase() === FACTORY.toLowerCase() ? abi.PoolFactory : abi.PoolVault;
      const parsed = iface.parseTransaction({ data: params[0].data });
      return iface.encodeFunctionResult(parsed.fragment, [values[parsed.name]]);
    }
    throw Error('unexpected method');
  } };
  const result = await readRewardBalances({ provider, pool: POOL, account: ACCOUNT,
    factory: FACTORY, minBlockNumber: 19n });
  assert.deepEqual([result.state, result.shares, result.claimableBEM, result.bnbOwed], [2n, 15n, 100n, 40n]);
  assert(calls.filter(([method]) => method === 'eth_call').every(([, params]) => params[1] === '0x14'));
  await assert.rejects(readRewardBalances({ provider, pool: POOL, account: ACCOUNT,
    factory: FACTORY, minBlockNumber: 21n }), /not reached/);
  values.isPool = false;
  await assert.rejects(readRewardBalances({ provider, pool: POOL, account: ACCOUNT,
    factory: FACTORY }), /not registered/);
  values.isPool = true;
  let headers = 0;
  const reorganizing = { request: input => input.method === 'eth_getBlockByNumber' && ++headers === 2
    ? { ...head, hash: `0x${'c'.repeat(64)}` } : provider.request(input) };
  await assert.rejects(readRewardBalances({ provider: reorganizing, pool: POOL, account: ACCOUNT,
    factory: FACTORY }), /Chain changed/);
});

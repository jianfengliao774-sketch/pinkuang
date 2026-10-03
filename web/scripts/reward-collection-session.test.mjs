import assert from 'node:assert/strict';
import test from 'node:test';
import { getAddress } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { RewardCollectionRecoveryError, saveRewardCollectionRecovery,
  readRewardCollectionRecovery, clearRewardCollectionRecovery, readRecoveryTransaction,
  withRewardCollectionLock }
  from '../lib/reward-collection-session.mjs';

const address = n => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const account = address(1), factory = address(2), portfolioFactory = address(3), pool = address(4);
const config = { chainId: 56, manifest: { chainId: 56, factory, portfolioFactory, artifactDigest: hash(90) } };
const data = kind => abi.PoolVault.encodeFunctionData(kind);
const job = (kind = 'harvest', extra = {}) => ({ pool, kind, hash: null,
  status: 'submitting', account, factory, data: data(kind), value: '0', notBeforeBlock: '99', ...extra });
function memoryStorage() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
const recoveryCode = code => error => error instanceof RewardCollectionRecoveryError && error.code === code;

function fakeLocks() {
  const held = new Set(), names = [];
  return { names, held, async request(name, options, callback) {
    names.push(name);
    assert.deepEqual(options, { mode: 'exclusive', ifAvailable: true });
    if (held.has(name)) return callback(null);
    held.add(name);
    try { return await callback({ name }); }
    finally { held.delete(name); }
  } };
}

test('browser-wide lock blocks a second tab and releases after success or failure', async () => {
  const locks = fakeLocks();
  let release;
  const first = withRewardCollectionLock(config, account,
    () => new Promise(resolve => { release = resolve; }), { locks });
  await Promise.resolve();
  let competingRan = false;
  await assert.rejects(withRewardCollectionLock(config, account,
    () => { competingRan = true; }, { locks }), recoveryCode('active_recovery'));
  assert.equal(competingRan, false);
  release('done');
  assert.equal(await first, 'done');
  await assert.rejects(withRewardCollectionLock(config, account,
    () => { throw Error('wallet read failed'); }, { locks }), /wallet read failed/);
  assert.equal(await withRewardCollectionLock(config, account, () => 'retry', { locks }), 'retry');
  assert.equal(locks.held.size, 0);
});

test('browser lock isolates deployment identity and fails closed without Web Locks', async () => {
  const locks = fakeLocks();
  let release;
  const first = withRewardCollectionLock(config, account,
    () => new Promise(resolve => { release = resolve; }), { locks });
  await Promise.resolve();
  assert.equal(await withRewardCollectionLock(config, address(11), () => 'wallet B', { locks }), 'wallet B');
  assert.equal(await withRewardCollectionLock({ ...config,
    manifest: { ...config.manifest, portfolioFactory: address(12) } }, account,
  () => 'other deployment', { locks }), 'other deployment');
  assert.equal(new Set(locks.names).size, 3);
  let ran = false;
  await assert.rejects(withRewardCollectionLock(config, account,
    () => { ran = true; }, { locks: null }), recoveryCode('lock_unavailable'));
  assert.equal(ran, false);
  release();
  await first;
});

test('hashless intent is durable before wallet use and may only acquire its own hash', () => {
  const storage = memoryStorage();
  assert.equal(readRewardCollectionRecovery(config, account, storage), null);
  assert.equal(saveRewardCollectionRecovery(config, account, job(), storage), true);
  assert.deepEqual(readRewardCollectionRecovery(config, account, storage), job());
  assert.throws(() => saveRewardCollectionRecovery(config, account, job(), storage), recoveryCode('active_recovery'));
  assert.equal(saveRewardCollectionRecovery(config, account, job('harvest', { hash: hash(7), status: 'pending' }), storage), true);
  assert.deepEqual(readRewardCollectionRecovery(config, account, storage), job('harvest', { hash: hash(7), status: 'pending' }));
  assert.equal(saveRewardCollectionRecovery(config, account, job('harvest', { hash: hash(7), status: 'pending' }), storage), true);
  assert.throws(() => saveRewardCollectionRecovery(config, account,
    job('harvest', { hash: hash(8), status: 'pending' }), storage), recoveryCode('active_recovery'));
  assert.throws(() => saveRewardCollectionRecovery(config, account, job('claim'), storage), recoveryCode('active_recovery'));
  assert.throws(() => saveRewardCollectionRecovery(config, account,
    job('harvest', { hash: hash(7), status: 'pending', notBeforeBlock: '100' }), storage), recoveryCode('active_recovery'));
  assert.throws(() => saveRewardCollectionRecovery(config, account, job(), storage), recoveryCode('active_recovery'));
  const resolved = job('harvest', { hash: hash(7), status: 'pending' });
  assert.equal(clearRewardCollectionRecovery(config, account, storage, resolved), true);
  assert.equal(clearRewardCollectionRecovery(config, account, storage, resolved), false);
  assert.equal(readRewardCollectionRecovery(config, account, storage), null);
});

test('an older terminal receipt cannot clear a newer active pool guard', () => {
  const storage = memoryStorage();
  const old = job('harvest', { hash: hash(7), status: 'pending' });
  saveRewardCollectionRecovery(config, account, job(), storage);
  saveRewardCollectionRecovery(config, account, old, storage);
  assert.equal(clearRewardCollectionRecovery(config, account, storage, old), true);
  const newer = job('claim', { pool: address(15), notBeforeBlock: '101' });
  saveRewardCollectionRecovery(config, account, newer, storage);
  assert.throws(() => clearRewardCollectionRecovery(config, account, storage, old), recoveryCode('active_recovery'));
  assert.deepEqual(readRewardCollectionRecovery(config, account, storage), newer);
  assert.equal(clearRewardCollectionRecovery(config, account, storage, newer), true);
});

test('clear compares a snapshot of the expected job including hash and block floor', () => {
  const storage = memoryStorage();
  const original = job();
  saveRewardCollectionRecovery(config, account, original, storage);
  const captured = Object.freeze({ ...original });
  saveRewardCollectionRecovery(config, account,
    job('harvest', { hash: hash(7), status: 'pending' }), storage);
  assert.throws(() => clearRewardCollectionRecovery(config, account, storage, captured), recoveryCode('active_recovery'));
  assert.throws(() => clearRewardCollectionRecovery(config, account, storage,
    job('harvest', { hash: hash(7), status: 'pending', notBeforeBlock: '100' })), recoveryCode('active_recovery'));
  assert.deepEqual(readRewardCollectionRecovery(config, account, storage),
    job('harvest', { hash: hash(7), status: 'pending' }));
});

test('guard is isolated by chain, artifact, both factories and wallet', () => {
  const storage = memoryStorage();
  saveRewardCollectionRecovery(config, account, job(), storage);
  assert.equal(storage.values.size, 1);
  for (const [changed, owner] of [
    [config, address(11)],
    [{ ...config, manifest: { ...config.manifest, artifactDigest: hash(91) } }, account],
    [{ ...config, manifest: { ...config.manifest, factory: address(12) } }, account],
    [{ ...config, manifest: { ...config.manifest, portfolioFactory: address(13) } }, account],
  ]) assert.equal(readRewardCollectionRecovery(changed, owner, storage), null);
  assert.throws(() => readRewardCollectionRecovery({ ...config, chainId: 1 }, account, storage), recoveryCode('invalid_identity'));
  assert.throws(() => readRewardCollectionRecovery({ ...config, factory: address(12) }, account, storage), recoveryCode('invalid_identity'));
  assert.deepEqual(readRewardCollectionRecovery(config, account, storage), job());
});

test('corrupt or mismatched active storage fails closed, including save and clear', () => {
  const storage = memoryStorage();
  saveRewardCollectionRecovery(config, account, job(), storage);
  const key = [...storage.values.keys()][0];
  for (const raw of ['{', 'null', '[]', JSON.stringify(job('harvest', { account: address(11) })),
    JSON.stringify(job('harvest', { data: data('claim') })),
    JSON.stringify(job('harvest', { notBeforeBlock: '099' }))]) {
    storage.values.set(key, raw);
    assert.throws(() => readRewardCollectionRecovery(config, account, storage), recoveryCode('invalid_storage'));
    assert.throws(() => saveRewardCollectionRecovery(config, account, job(), storage), recoveryCode('invalid_storage'));
    assert.throws(() => clearRewardCollectionRecovery(config, account, storage, job()), recoveryCode('invalid_storage'));
    assert.equal(storage.values.get(key), raw);
  }
});

test('storage writes must really persist and unavailable storage never permits a send', () => {
  const noOp = { getItem: () => null, setItem() {}, removeItem() {} };
  assert.throws(() => saveRewardCollectionRecovery(config, account, job(), noOp), recoveryCode('storage_unavailable'));
  const denied = { getItem: () => { throw Error('denied'); }, setItem() {}, removeItem() {} };
  assert.throws(() => readRewardCollectionRecovery(config, account, denied), recoveryCode('storage_unavailable'));
  assert.throws(() => saveRewardCollectionRecovery(config, account, job(), denied), recoveryCode('storage_unavailable'));
  assert.throws(() => saveRewardCollectionRecovery(config, account, job(), {}), recoveryCode('storage_unavailable'));
});

test('only exact no-argument PoolVault selectors and zero value can be stored', () => {
  const storage = memoryStorage();
  for (const bad of [job('harvest', { data: data('claim') }), job('claim', { data: '0x' }),
    job('withdrawBnb', { value: '1' }), job('harvest', { account: address(11) }),
    job('harvest', { factory: address(12) }), job('harvest', { hash: '0x1234' }),
    job('harvest', { status: 'confirmed' }), job('harvest', { notBeforeBlock: '099' }),
    job('harvest', { notBeforeBlock: undefined }), { ...job(), kind: 'claimBem' }]) {
    assert.throws(() => saveRewardCollectionRecovery(config, account, bad, storage), RewardCollectionRecoveryError);
    assert.equal(storage.values.size, 0);
  }
  assert.equal(saveRewardCollectionRecovery(config, account, { ...job(), data: undefined }, storage), true);
  assert.equal(readRewardCollectionRecovery(config, account, storage).data, data('harvest'));
});

function rpcFixture({ tx = {}, receipt = {}, block = {} } = {}) {
  const h = hash(7), b = hash(8);
  const transaction = { hash: h, from: account, to: pool, input: data('harvest'), data: data('harvest'),
    value: '0x0', chainId: '0x38', blockHash: b, blockNumber: '0x64', ...tx };
  const mined = { transactionHash: h, from: account, to: pool, status: '0x1',
    blockHash: b, blockNumber: '0x64', ...receipt };
  const calls = [];
  const provider = { async request(input) {
    calls.push(input);
    if (input.method === 'eth_getTransactionByHash') return transaction;
    if (input.method === 'eth_getTransactionReceipt') return mined;
    if (input.method === 'eth_getBlockByNumber') return { hash: b, ...block };
    assert.fail(`Recovery must not send or request ${input.method}`);
  } };
  return { provider, calls, transaction, receipt: mined, hash: h };
}

test('hashless recovery waits for a manual hash, then proves exact call and canonical success', async () => {
  const fixture = rpcFixture();
  assert.deepEqual(await readRecoveryTransaction({ provider: fixture.provider, job: job() }),
    { status: 'pending', hash: null, reason: 'hash_required' });
  assert.equal(fixture.calls.length, 0);
  const result = await readRecoveryTransaction({ provider: fixture.provider, job: job(), hash: fixture.hash });
  assert.deepEqual(result, { status: 'confirmed', blockNumber: '0x64', hash: fixture.hash, pool, kind: 'harvest' });
  assert.deepEqual(fixture.calls.map(call => call.method),
    ['eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber']);
});

test('hashless manual recovery rejects wrong calldata, sender, destination, value and chain', async () => {
  for (const tx of [{ input: data('claim') }, { data: data('claim') }, { from: address(11) },
    { to: address(12) }, { value: '0x1' }, { chainId: '0x1' }, { hash: hash(17) }]) {
    const fixture = rpcFixture({ tx });
    await assert.rejects(readRecoveryTransaction({ provider: fixture.provider, job: job(), hash: fixture.hash }),
      recoveryCode('transaction_mismatch'));
    assert.deepEqual(fixture.calls.map(call => call.method), ['eth_getTransactionByHash']);
  }
  const fixture = rpcFixture();
  await assert.rejects(readRecoveryTransaction({ provider: fixture.provider,
    job: job('harvest', { hash: hash(17), status: 'pending' }), hash: fixture.hash }), recoveryCode('hash_mismatch'));
  assert.equal(fixture.calls.length, 0);
});

test('missing transaction, missing receipt and noncanonical receipt remain pending; canonical revert is failed', async () => {
  const fixture = rpcFixture();
  const base = fixture.provider.request.bind(fixture.provider);
  fixture.provider.request = async input => input.method === 'eth_getTransactionByHash' ? null : base(input);
  assert.equal((await readRecoveryTransaction({ provider: fixture.provider, job: job('harvest',
    { hash: fixture.hash, status: 'pending' }) })).status, 'pending');
  assert.deepEqual(fixture.calls, []);
  for (const [receipt, block, expected] of [[null, null, 'pending'],
    [{}, { hash: hash(19) }, 'pending'], [{ status: '0x0' }, {}, 'failed']]) {
    const f = rpcFixture({ receipt: receipt ?? {}, block: block ?? {} });
    if (receipt === null) {
      const original = f.provider.request.bind(f.provider);
      f.provider.request = async input => input.method === 'eth_getTransactionReceipt' ? null : original(input);
    }
    const result = await readRecoveryTransaction({ provider: f.provider,
      job: job('harvest', { hash: f.hash, status: 'pending' }) });
    assert.equal(result.status, expected);
  }
});

test('receipt must belong to the same exact transaction block and canonical chain', async () => {
  for (const overrides of [{ tx: { blockHash: hash(19) } }, { tx: { blockNumber: '0x65' } },
    { receipt: { from: address(11) } }, { receipt: { to: address(12) } },
    { receipt: { transactionHash: hash(18) } }]) {
    const fixture = rpcFixture(overrides);
    await assert.rejects(readRecoveryTransaction({ provider: fixture.provider,
      job: job('harvest', { hash: fixture.hash, status: 'pending' }) }));
    assert.equal(fixture.calls.some(call => call.method === 'eth_sendTransaction'), false);
  }
  const fixture = rpcFixture();
  fixture.provider.request = async () => { throw Error('RPC offline'); };
  await assert.rejects(readRecoveryTransaction({ provider: fixture.provider,
    job: job('harvest', { hash: fixture.hash, status: 'pending' }) }), /RPC offline/);
});

test('manual or saved hash from the snapshot block or earlier cannot unlock the guard', async () => {
  for (const old of ['0x63', '0x62']) {
    const fixture = rpcFixture({ tx: { blockNumber: old }, receipt: { blockNumber: old } });
    await assert.rejects(readRecoveryTransaction({ provider: fixture.provider,
      job: job('harvest', { hash: fixture.hash, status: 'pending' }) }), recoveryCode('old_transaction'));
    assert.deepEqual(fixture.calls.map(call => call.method), ['eth_getTransactionByHash']);
  }
  const oldReceipt = rpcFixture({ receipt: { blockNumber: '0x63' } });
  await assert.rejects(readRecoveryTransaction({ provider: oldReceipt.provider,
    job: job('harvest', { hash: oldReceipt.hash, status: 'pending' }) }), recoveryCode('old_transaction'));
  const pending = rpcFixture({ tx: { blockNumber: null, blockHash: null } });
  const original = pending.provider.request.bind(pending.provider);
  pending.provider.request = async input => input.method === 'eth_getTransactionReceipt' ? null : original(input);
  assert.equal((await readRecoveryTransaction({ provider: pending.provider,
    job: job('harvest', { hash: pending.hash, status: 'pending' }) })).status, 'pending');
});

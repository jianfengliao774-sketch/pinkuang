import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface } from 'ethers';
import { acquireWalletLock, readJournal, writeJournal } from './purchase-keeper.mjs';
import { awaitingWallet, parseSupervisorArguments, poolReviewRequired, prioritizePools, publishSupervisorReadiness, reportOperatorReview,
  runSupervisorCycle, walletReviewRequired } from './mining-supervisor.mjs';

const factory = '0x1111111111111111111111111111111111111111';
const pools = ['0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333'];
function setup(t) {
  const journalDir = mkdtempSync(join(tmpdir(), 'mining-supervisor-test-'));
  t.after(() => rmSync(journalDir, { recursive: true, force: true }));
  return { options: { factory, journalDir, batch: 10, send: true }, state: { pools: [], cursor: 0 },
    signer: { address: '0x4444444444444444444444444444444444444444' },
    dependencies: { refreshPools: async (_provider, _options, known) => { known.splice(0, known.length, ...pools); return known; },
      readMiningState: async () => ({ status: 'restart-eligible' }),
      acquireKeeperLock: () => () => {}, acquireWalletLock: () => () => {} } };
}

test('supervisor scans pools in bounded round-robin batches and prioritizes a pending arm/start', () => {
  const pools = ['a', 'b', 'c', 'd'];
  let journals = {};
  const journalFor = pool => journals[pool] ?? {};
  let next = prioritizePools(pools, journalFor, 0, 2);
  assert.deepEqual(next.selected, ['a', 'b']);
  next = prioritizePools(pools, journalFor, next.nextCursor, 2);
  assert.deepEqual(next.selected, ['c', 'd']);
  journals = { c: { miningStage: 'arming', transaction: { phase: 'confirmed' } } };
  next = prioritizePools(pools, journalFor, 0, 2);
  assert.deepEqual(next.selected, ['c']);
  journals = { d: { miningStage: 'starting', transaction: { phase: 'confirmed' } } };
  assert.deepEqual(prioritizePools(pools, journalFor, 0, 2).selected, ['d']);
  journals = { a: { miningStage: 'arming', transaction: { phase: 'reverted' } } };
  assert.deepEqual(prioritizePools(pools, journalFor, 0, 2).selected, ['a', 'b'], 'finalized failures do not reserve a nonce');
  journals.b = { miningStage: 'starting', transaction: { phase: 'broadcast' } };
  assert.deepEqual(prioritizePools(pools, journalFor, 0, 2).selected, ['b']);
  journals.c = { miningStage: 'starting', transaction: { phase: 'broadcast' } };
  assert.throws(() => prioritizePools(pools, journalFor, 0, 2), /Multiple mining journals/);
});

test('one pool review is alerted and quarantined while another pool keeps mining', async t => {
  const { options, state, signer, dependencies } = setup(t);
  const calls = [];
  dependencies.runMiningCycle = async (_provider, current) => {
    calls.push(current.pool);
    return { status: current.pool === pools[0] ? 'arm-simulation-failed-review-required' : 'mining-active' };
  };
  const result = await runSupervisorCycle({}, options, signer, state, dependencies);
  assert.deepEqual(calls, pools);
  assert.equal(result.checked, 2);
  assert.equal(result.quarantinedCount, 1);
  assert.equal(state.quarantined.get(pools[0]), 'arm-simulation-failed-review-required');
  await runSupervisorCycle({}, options, signer, state, dependencies);
  assert.deepEqual(calls, [...pools, pools[1]], 'the reviewed pool cannot block subsequent cycles');
  assert.equal(poolReviewRequired('arm-simulation-failed-review-required'), true);
  assert.equal(walletReviewRequired('arm-simulation-failed-review-required'), false);
  state.quarantined.set(pools[1], 'manual-review');
  const exhausted = await runSupervisorCycle({}, options, signer, state, dependencies);
  assert.equal(exhausted.status, 'all-pools-quarantined');
  const original = process.exitCode;
  try {
    assert.equal(reportOperatorReview(exhausted, true, () => {}), true);
    assert.equal(process.exitCode, 2);
  } finally { process.exitCode = original; }
});

test('a transient pool error gets a bounded retry delay, not a global stop', async t => {
  const { options, state, signer, dependencies } = setup(t);
  let now = 1000, fail = true;
  dependencies.now = () => now;
  dependencies.runMiningCycle = async (_provider, current) => {
    if (current.pool === pools[0] && fail) throw new Error('temporary pool RPC failure');
    return { status: 'mining-active' };
  };
  const first = await runSupervisorCycle({}, options, signer, state, dependencies);
  assert.deepEqual(first.results.map(item => item.status), ['pool-cycle-error', 'mining-active']);
  assert.equal(state.cooldowns.get(pools[0]), 31_000);
  assert.deepEqual((await runSupervisorCycle({}, options, signer, state, dependencies)).results.map(item => item.pool), [pools[1]]);
  fail = false; now = 31_000;
  assert.deepEqual((await runSupervisorCycle({}, options, signer, state, dependencies)).results.map(item => item.pool), pools);
});

test('unknown signed mining result blocks another pool and requires wallet-wide review', async t => {
  const { options, state, signer, dependencies } = setup(t);
  const calls = [];
  dependencies.runMiningCycle = async (_provider, current) => {
    calls.push(current.pool);
    return { status: 'broadcast-result-unknown' };
  };
  const result = await runSupervisorCycle({}, options, signer, state, dependencies);
  assert.deepEqual(calls, [pools[0]]);
  assert.equal(result.results[0].status, 'broadcast-result-unknown');
  assert.equal(walletReviewRequired(result.results[0].status), true);
});

test('a review result with an unresolved signed journal blocks the shared wallet', async t => {
  const { options, state, signer, dependencies } = setup(t);
  let pending = false;
  dependencies.readJournal = (_path, binding) => ({ version: 1, chainId: 56, ...binding,
    transaction: binding.pool === pools[0] && pending ? { phase: 'signed' } : null,
    gasSpentWei: '0', gasReceipts: {} });
  const calls = [];
  dependencies.runMiningCycle = async (_provider, current) => {
    calls.push(current.pool); pending = true;
    return { status: 'arm-simulation-failed-review-required' };
  };
  const result = await runSupervisorCycle({}, options, signer, state, dependencies);
  assert.deepEqual(calls, [pools[0]]);
  assert.equal(result.results[0].walletBlocked, true);
  assert.equal(result.quarantinedCount, 0, 'the signer remains globally blocked, not merely pool-quarantined');
  const original = process.exitCode;
  try {
    let alert;
    assert.equal(reportOperatorReview(result, true, message => { alert = JSON.parse(message); }), true);
    assert.equal(process.exitCode, 2);
    assert.equal(alert.status, 'operator-review-required');
    assert.equal(alert.pool, pools[0]);
  } finally { process.exitCode = original; }
});

test('supervisor requires a private journal directory before signing', () => {
  const args = ['--factory', '0x0000000000000000000000000000000000000001'];
  assert.throws(() => parseSupervisorArguments([...args, '--send']), /journal-dir/);
  assert.throws(() => parseSupervisorArguments([...args, '--rpc', 'http://example.com']), /HTTPS/);
  const options = parseSupervisorArguments([...args, '--journal-dir', '/tmp/private-mining', '--send']);
  assert.equal(options.send, true);
  assert.equal(options.batch, 10);
});

test('Funding pools do not reserve the shared wallet or create a mining journal', async t => {
  const { options, state, signer, dependencies } = setup(t);
  dependencies.readMiningState = async () => ({ status: 'pool-not-active', state: 0n, blockNumber: 123 });
  dependencies.acquireWalletLock = () => assert.fail('Funding must not take the send lane');
  dependencies.runMiningCycle = () => assert.fail('Funding requires no mining action');
  const result = await runSupervisorCycle({}, options, signer, state, dependencies);
  assert.deepEqual(result.results.map(row => row.status), ['pool-not-active', 'pool-not-active']);
  assert.equal(awaitingWallet(result), false);
  for (const pool of pools) assert.equal(existsSync(join(options.journalDir, `${pool}.json`)), false);
});

test('already-mining pools still run identity checks without obtaining a signing lane', async t => {
  const { options, state, signer, dependencies } = setup(t);
  dependencies.readMiningState = async () => ({ status: 'mining-active' });
  dependencies.acquireWalletLock = () => assert.fail('No mining transaction is needed');
  dependencies.runMiningCycle = async (_provider, current, currentSigner) => {
    assert.equal(current.send, false);
    assert.equal(currentSigner, null);
    return { status: 'mining-active' };
  };
  assert.equal((await runSupervisorCycle({}, options, signer, state, dependencies)).checked, 2);
  dependencies.runMiningCycle = async () => { throw new Error('Authority is not bound to this Factory.'); };
  await assert.rejects(runSupervisorCycle({}, options, signer, state, dependencies), /Authority is not bound/);
});

function pendingJournal(path, pool, signer, data = '0x12345678') {
  const journal = readJournal(path, { factory, pool });
  journal.miningStage = 'arming';
  journal.transaction = { phase: 'broadcast', nonce: 1, data, value: '0', from: signer.address,
    to: pool, hash: '0x' + 'ab'.repeat(32), createdAt: new Date().toISOString() };
  writeJournal(path, journal);
  return journal;
}

test('real foreign pending wallet reservation is retained while mining skips and later recovers', async t => {
  const { options, state, signer, dependencies } = setup(t);
  const walletRoot = join(options.journalDir, 'wallets');
  const otherJournal = join(options.journalDir, 'purchase.json');
  const pending = pendingJournal(otherJournal, pools[0], signer);
  acquireWalletLock(signer.address, otherJournal, walletRoot)();
  const pointerPath = join(walletRoot, `56-${signer.address}.json`);
  const originalPointer = readFileSync(pointerPath, 'utf8');
  const originalPending = readFileSync(otherJournal, 'utf8');
  let walletAttempts = 0, cycles = 0;
  dependencies.acquireWalletLock = (address, path) => {
    walletAttempts++;
    return acquireWalletLock(address, path, walletRoot);
  };
  dependencies.runMiningCycle = async () => { cycles++; return { status: 'mining-active' }; };
  const first = await runSupervisorCycle({}, options, signer, state, dependencies);
  assert.equal(awaitingWallet(first), true);
  assert.deepEqual(first.results.map(row => row.status), ['wallet-lane-busy', 'wallet-lane-busy']);
  assert.equal(walletAttempts, 1, 'one blocked lane is not reacquired for every pool in this scan');
  assert.equal(cycles, 0, 'a foreign reservation never enters the signing cycle');
  assert.equal(readFileSync(pointerPath, 'utf8'), originalPointer);
  assert.equal(readFileSync(otherJournal, 'utf8'), originalPending);
  assert.equal(reportOperatorReview(first, true, () => assert.fail('ordinary contention is not manual review')), false);
  assert.equal(existsSync(join(options.journalDir, `${pools[0]}.json`)), false);

  // Only the owning worker's finalized ledger permits the next scan to use
  // this nonce lane. This is a local fixture, never a production journal.
  Object.assign(pending.transaction, { phase: 'confirmed', finality: 'bsc-finalized', blockNumber: 100,
    finalizedBlockNumber: 102, blockHash: '0x' + 'cd'.repeat(32), finalizedBlockHash: '0x' + 'ef'.repeat(32) });
  writeJournal(otherJournal, pending);
  const recovered = await runSupervisorCycle({}, options, signer, state, dependencies);
  assert.equal(awaitingWallet(recovered), false);
  assert.equal(cycles, 2);
});

test('a pending mining journal uses actual receipt-only reconciliation repeatedly without rebroadcast', async t => {
  const { options, state, signer, dependencies } = setup(t);
  const path = join(options.journalDir, `${pools[0]}.json`);
  const arm = new Interface(['function mine(bytes)']).encodeFunctionData('mine', [
    new Interface(['function arm(address,uint256)']).encodeFunctionData('arm',
      ['0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C', 1])]);
  pendingJournal(path, pools[0], signer, arm);
  const before = readFileSync(path, 'utf8');
  const walletRoot = join(options.journalDir, 'wallets');
  dependencies.acquireWalletLock = (address, journal) => acquireWalletLock(address, journal, walletRoot);
  dependencies.readMiningState = () => assert.fail('pending receipts take priority over new work');
  signer.signTransaction = () => assert.fail('pending transaction must not be signed again');
  let receiptReads = 0;
  const provider = { getNetwork: async () => ({ chainId: 56n }),
    getTransaction: async () => null,
    getTransactionReceipt: async () => { receiptReads++; return null; },
    getTransactionCount: async () => 1,
    broadcastTransaction: () => assert.fail('pending transaction must not be rebroadcast') };
  for (let pass = 0; pass < 2; pass++) {
    const result = await runSupervisorCycle(provider, options, signer, state, dependencies);
    assert.equal(result.checked, 1, 'another pool cannot start a transaction while this one is pending');
    assert.equal(result.results[0].status, 'pending-not-indexed');
    assert.equal(awaitingWallet(result), true);
    assert.equal(reportOperatorReview(result, true, () => assert.fail('receipt wait is recoverable')), false);
  }
  assert.equal(receiptReads, 2);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('only actual lock contention is recoverable; corrupt ownership and chain identity remain fatal', async t => {
  const { options, state, signer, dependencies } = setup(t);
  dependencies.acquireWalletLock = () => { throw new Error('Keeper lock already exists: /private/test.lock. Another process holds it.'); };
  const waiting = await runSupervisorCycle({}, options, signer, state, dependencies);
  assert.equal(awaitingWallet(waiting), true);
  dependencies.acquireWalletLock = () => { throw new Error('Wallet has an unavailable previous journal; preserve the pointer and recover that journal before sending.'); };
  await assert.rejects(runSupervisorCycle({}, options, signer, state, dependencies), /unavailable previous journal/);
  dependencies.readMiningState = async () => { throw new Error('Pool is not registered with this factory.'); };
  await assert.rejects(runSupervisorCycle({}, options, signer, state, dependencies), /not registered/);
});

test('recoverable wallet waits preserve but never extend the last verified readiness heartbeat', () => {
  let published = 0;
  const heartbeat = { publish: () => published++, clear: () => assert.fail('wallet waits must not clear readiness') };
  const proof = { graph: {}, block: {} };
  const previousExitCode = process.exitCode;
  for (const status of ['wallet-lane-busy', 'pending-receipt', 'operator-wallet-has-pending-transaction']) {
    const result = { status: 'scanned', results: [{ pool: pools[0], status, walletWait: true }] };
    assert.equal(reportOperatorReview(result, true, () => assert.fail('do not exit on ordinary wallet waits')), false);
    assert.equal(publishSupervisorReadiness(heartbeat, proof, result), false);
  }
  assert.equal(process.exitCode, previousExitCode);
  assert.equal(published, 0);
  assert.equal(publishSupervisorReadiness(heartbeat, proof, { status: 'scanned', results: [] }), true);
  assert.equal(published, 1);
});

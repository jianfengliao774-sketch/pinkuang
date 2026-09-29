import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSupervisorArguments, poolReviewRequired, prioritizePools, reportOperatorReview,
  runSupervisorCycle, walletReviewRequired } from './mining-supervisor.mjs';

const factory = '0x1111111111111111111111111111111111111111';
const pools = ['0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333'];
function setup(t) {
  const journalDir = mkdtempSync(join(tmpdir(), 'mining-supervisor-test-'));
  t.after(() => rmSync(journalDir, { recursive: true, force: true }));
  return { options: { factory, journalDir, batch: 10, send: true }, state: { pools: [], cursor: 0 },
    signer: { address: '0x4444444444444444444444444444444444444444' },
    dependencies: { refreshPools: async (_provider, _options, known) => { known.splice(0, known.length, ...pools); return known; },
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
    assert.equal(process.exitCode, 1);
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
    assert.equal(process.exitCode, 1);
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

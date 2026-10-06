import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireKeeperLock, acquireWalletLock, readJournal, writeJournal } from './purchase-keeper.mjs';
import { awaitingWallet, isPrivateCredential, needsOperatorReview, parseSupervisorArguments, publishSupervisorReadiness, reportOperatorReview,
  runSupervisorCycle, selectPools, stopsOtherPurchases } from './purchase-supervisor.mjs';

const factory = '0x1111111111111111111111111111111111111111';
const pools = ['0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333'];

test('purchase supervisor is read-only unless explicitly given send mode and a durable journal directory', () => {
  const base = ['--factory', factory];
  const options = parseSupervisorArguments(base);
  assert.equal(options.send, false);
  assert.equal(options.interval, 2);
  assert.equal(options.maxPools, 1000);
  assert.throws(() => parseSupervisorArguments([...base, '--send']), /journal-dir/);
  assert.equal(parseSupervisorArguments([...base, '--send', '--journal-dir', '/private/purchase']).send, true);
  assert.throws(() => parseSupervisorArguments([...base, '--max-gas-bnb', '0']), /positive/);
});

test('pending purchase has priority over another funded pool and cannot coexist with a second pending journal', () => {
  const states = new Map(pools.map(pool => [pool, 1n]));
  const journalFor = pool => ({ transaction: pool === pools[1] ? { phase: 'signed' } : null });
  assert.deepEqual(selectPools(pools, journalFor, states, 0).selected, [pools[1]]);
  assert.throws(() => selectPools(pools, () => ({ transaction: { phase: 'signed' } }), states), /More than one unresolved/);
});

test('funded pools rotate fairly; funding and completed pools are never sent to the executor', () => {
  const funded = new Map(pools.map(pool => [pool, 1n]));
  const empty = () => ({ transaction: null });
  assert.deepEqual(selectPools(pools, empty, funded, 0).selected, pools);
  assert.deepEqual(selectPools(pools, empty, funded, 1).selected, [...pools].reverse());
  funded.set(pools[0], 0n);
  assert.deepEqual(selectPools(pools, empty, funded, 0).selected, [pools[1]]);
  funded.set(pools[1], 2n);
  assert.deepEqual(selectPools(pools, empty, funded, 0).selected, []);
});

test('one terminal Funded pool does not delay another, but a signed nonce still stops the wallet', () => {
  assert.equal(stopsOtherPurchases(true, { transaction: null },
    { status: 'funding-expired', terminal: true }), false);
  assert.equal(stopsOtherPurchases(true, { transaction: { phase: 'confirmed' } },
    { status: 'purchase-transaction-already-confirmed', terminal: true }), false);
  assert.equal(stopsOtherPurchases(true, { transaction: { phase: 'signed' } },
    { status: 'pending-not-indexed', terminal: false }), true);
  assert.equal(stopsOtherPurchases(false, { transaction: { phase: 'signed' } },
    { status: 'pending-not-indexed', terminal: false }), false);
});

test('systemd credential group read is accepted only inside its private credential directory',
  { skip: process.platform === 'win32' ? 'systemd credential paths require POSIX path resolution.' : false }, () => {
  const stat = (mode, uid = 0, symbolic = false) => ({ mode, uid, isFile: () => true, isSymbolicLink: () => symbolic });
  const directory = '/run/credentials/pinkuang-purchase-v2.service';
  const path = `${directory}/keeper.key`;
  assert.equal(isPrivateCredential('/etc/pinkuang/keeper.key', stat(0o600), undefined), true);
  assert.equal(isPrivateCredential(path, stat(0o440), directory), true);
  assert.equal(isPrivateCredential(path, stat(0o440, 1000), directory), false);
  assert.equal(isPrivateCredential('/tmp/keeper.key', stat(0o440), directory), false);
  assert.equal(isPrivateCredential(path, stat(0o444), directory), false);
  assert.equal(isPrivateCredential(path, stat(0o440, 0, true), directory), false);
});

test('fresh supervisor treats ambiguous purchase status as operator review, not success', () => {
  for (const status of ['unknown-wallet-nonce-manual-review', 'broadcast-result-unknown',
    'nonce-or-chain-changed-before-broadcast', 'nonce-changed-before-broadcast-manual-review',
    'chain-changed-before-broadcast', 'proof-review-required']) {
    assert.equal(needsOperatorReview(status), true, status);
  }
  assert.equal(needsOperatorReview('pending-not-indexed'), false,'status alone cannot prove an overdue or unbroadcast transaction');
  assert.equal(needsOperatorReview({status:'pending-not-indexed',phase:'broadcast',broadcastCount:1,
    pendingSeconds:2,overdue:false}),false,'a newly broadcast hash may be absent from a load-balanced RPC');
  assert.equal(needsOperatorReview({status:'pending-not-indexed',phase:'broadcast',broadcastCount:1,
    pendingSeconds:120,overdue:true}),true,'an overdue absent hash requires review');
  assert.equal(needsOperatorReview({status:'pending-not-indexed',phase:'signed',broadcastCount:0,
    pendingSeconds:2,overdue:false}),true,'a durable signature that was never sent requires review');
  assert.equal(needsOperatorReview('broadcast'), false);
  assert.equal(needsOperatorReview('confirmed'), false);
  const original = process.exitCode;
  try {
    let alert;
    assert.equal(reportOperatorReview([{ pool: pools[0], status: 'confirmed' }], message => { alert = message; }), false);
    assert.equal(alert, undefined);
    assert.equal(reportOperatorReview([{pool:pools[0],status:'pending-not-indexed',phase:'broadcast',
      broadcastCount:1,overdue:false,pendingSeconds:2}],message=>{alert=message;}),false);
    assert.equal(alert,undefined);assert.equal(process.exitCode,original,'transient propagation must not stop systemd');
    assert.equal(reportOperatorReview([{ pool: pools[0], status: 'broadcast-result-unknown' }], message => { alert = JSON.parse(message); }), true);
    assert.equal(process.exitCode, 2);
    assert.equal(alert.status, 'operator-review-required');
    assert.equal(alert.pool, pools[0]);
  } finally { process.exitCode = original; }
});

test('v2 unit stops on operator review and rate-limits transient crash retries', () => {
  const unit=readFileSync(new URL('../ops/v2/pinkuang-purchase-v2.service',import.meta.url),'utf8');
  assert.match(unit,/StartLimitIntervalSec=10min\nStartLimitBurst=3/);
  assert.match(unit,/Restart=on-failure\nRestartPreventExitStatus=2/);
});

function cycleFixture(t) {
  const journalDir = mkdtempSync(join(tmpdir(), 'purchase-supervisor-test-'));
  t.after(() => rmSync(journalDir, { recursive: true, force: true }));
  const signer = { address: '0x4444444444444444444444444444444444444444',
    getAddress: async () => signer.address, signTransaction: () => assert.fail('waiting must never sign') };
  return { options: { factory, journalDir, send: true }, signer,
    state: { pools: [], cursor: 0, runtimes: new Map() },
    dependencies: { refreshPools: async (_provider, _options, known) => { known.splice(0, known.length, ...pools); return known; },
      readPoolState: async () => 1n, acquireKeeperLock: () => () => {} } };
}

test('foreign wallet contention waits once per scan and does not report operator failure or renew readiness', async t => {
  const { options, signer, state, dependencies } = cycleFixture(t);
  let attempts = 0, journalLocks = 0, released = 0;
  dependencies.acquireKeeperLock = () => { journalLocks++; return () => { released++; }; };
  dependencies.acquireWalletLock = () => {
    attempts++;
    throw new Error('Wallet has an unresolved transaction in another pool journal. Reconcile that journal first.');
  };
  dependencies.runKeeperCycle = () => assert.fail('the foreign reservation forbids the purchase cycle');
  for (let pass = 0; pass < 2; pass++) {
    const result = await runSupervisorCycle({}, options, signer, state, dependencies);
    assert.equal(awaitingWallet(result), true);
    assert.deepEqual(result.results.map(row => row.status), ['wallet-lane-busy', 'wallet-lane-busy']);
    assert.equal(reportOperatorReview(result.results, () => assert.fail('ordinary wallet wait is not manual review')), false);
    assert.equal(publishSupervisorReadiness({ publish: () => assert.fail('waiting cannot renew readiness') }, {}, result), false);
  }
  assert.equal(attempts, 2, 'one wallet attempt per scan, with automatic waiting on the next scan');
  assert.equal(journalLocks, 2, 'another selected pool does not contend for the same blocked lane');
  assert.equal(released, 2, 'the purchase journal lock is released even when the wallet lane is busy');
  for (const pool of pools) assert.equal(existsSync(join(options.journalDir, `${pool}.json`)), false);
});

test('only wallet acquisition contention is recoverable; ownership corruption and executor errors remain fatal', async t => {
  const { options, signer, state, dependencies } = cycleFixture(t);
  dependencies.acquireWalletLock = () => { throw new Error('Keeper lock already exists: /private/test.lock. Another process holds it.'); };
  assert.equal(awaitingWallet(await runSupervisorCycle({}, options, signer, state, dependencies)), true);
  dependencies.acquireWalletLock = () => { throw new Error('Wallet has an unavailable previous journal; preserve the pointer and recover that journal before sending.'); };
  await assert.rejects(runSupervisorCycle({}, options, signer, state, dependencies), /unavailable previous journal/);
  dependencies.acquireWalletLock = () => () => {};
  for (const pool of pools) {
    const path = join(options.journalDir, `${pool}.json`);
    writeFileSync(path, JSON.stringify(readJournal(path, { factory, pool })));
  }
  dependencies.runKeeperCycle = () => { throw new Error('Wallet has an unresolved transaction in another pool journal. Reconcile that journal first.'); };
  await assert.rejects(runSupervisorCycle({}, options, signer, state, dependencies), /unresolved transaction/,
    'a similarly worded executor error must not be swallowed after acquisition');
});

test('real foreign reservation is preserved until its owning journal records a finalized receipt',
  { skip: process.platform === 'win32' ? 'Private fsync and kernel flock fixture requires the Linux deployment host.' : false }, async t => {
    const { options, signer, state, dependencies } = cycleFixture(t);
    const ownerPath = join(options.journalDir, 'authority.json');
    const journal = readJournal(ownerPath, { factory, pool: factory });
    journal.transaction = { phase: 'broadcast', nonce: 1, from: signer.address, to: factory, data: '0x1234',
      value: '0', hash: '0x' + 'ab'.repeat(32), createdAt: new Date().toISOString() };
    writeJournal(ownerPath, journal);
    const walletRoot = join(options.journalDir, 'wallets');
    acquireWalletLock(signer.address, ownerPath, walletRoot)();
    const pointerPath = join(walletRoot, `56-${signer.address}.json`);
    const pointerBefore = readFileSync(pointerPath, 'utf8'), journalBefore = readFileSync(ownerPath, 'utf8');
    let attempts = 0, cycles = 0;
    dependencies.acquireKeeperLock = path => acquireKeeperLock(path, join(options.journalDir, 'locks'));
    dependencies.acquireWalletLock = (address, path) => { attempts++; return acquireWalletLock(address, path, walletRoot); };
    dependencies.runKeeperCycle = async () => { cycles++; return { status: 'no-executable-official-candidate-in-prepared-queue' }; };
    for (let pass = 0; pass < 2; pass++) {
      assert.equal(awaitingWallet(await runSupervisorCycle({}, options, signer, state, dependencies)), true);
      assert.equal(readFileSync(ownerPath, 'utf8'), journalBefore);
      assert.equal(readFileSync(pointerPath, 'utf8'), pointerBefore);
    }
    assert.equal(attempts, 2);
    assert.equal(cycles, 0);
    for (const pool of pools) assert.equal(existsSync(join(options.journalDir, `${pool}.json`)), false);
    // Only the owner records the finality proof; the purchase supervisor does
    // not acknowledge, delete, rebroadcast, or repair that journal itself.
    Object.assign(journal.transaction, { phase: 'reverted', finality: 'bsc-finalized', blockNumber: 100,
      finalizedBlockNumber: 102, blockHash: '0x' + 'cd'.repeat(32), finalizedBlockHash: '0x' + 'ef'.repeat(32) });
    writeJournal(ownerPath, journal);
    const resumed = await runSupervisorCycle({}, options, signer, state, dependencies);
    assert.equal(awaitingWallet(resumed), false);
    assert.equal(cycles, 2, 'the next regular scan resumes both eligible pools after owner reconciliation');
    let published = 0;
    assert.equal(publishSupervisorReadiness({ publish: () => { published++; } }, { graph: {}, block: {} }, resumed), true);
    assert.equal(published, 1);
  });

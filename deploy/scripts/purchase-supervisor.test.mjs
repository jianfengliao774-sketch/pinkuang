import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isPrivateCredential, needsOperatorReview, parseSupervisorArguments, reportOperatorReview,
  selectPools, stopsOtherPurchases } from './purchase-supervisor.mjs';

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

test('systemd credential group read is accepted only inside its private credential directory', () => {
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
    'chain-changed-before-broadcast', 'proof-review-required', 'pending-not-indexed']) {
    assert.equal(needsOperatorReview(status), true, status);
  }
  assert.equal(needsOperatorReview('broadcast'), false);
  assert.equal(needsOperatorReview('confirmed'), false);
  const original = process.exitCode;
  try {
    let alert;
    assert.equal(reportOperatorReview([{ pool: pools[0], status: 'confirmed' }], message => { alert = message; }), false);
    assert.equal(alert, undefined);
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

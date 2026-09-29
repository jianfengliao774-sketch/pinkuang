import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPrivateCredential, parseSupervisorArguments, selectPools } from './purchase-supervisor.mjs';

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

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSupervisorArguments, prioritizePools } from './mining-supervisor.mjs';

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
  assert.deepEqual(prioritizePools(pools, journalFor, 0, 2).selected, ['a']);
  journals.b = { miningStage: 'starting', transaction: { phase: 'broadcast' } };
  assert.throws(() => prioritizePools(pools, journalFor, 0, 2), /Multiple mining journals/);
});

test('supervisor requires a private journal directory before signing', () => {
  const args = ['--factory', '0x0000000000000000000000000000000000000001'];
  assert.throws(() => parseSupervisorArguments([...args, '--send']), /journal-dir/);
  assert.throws(() => parseSupervisorArguments([...args, '--rpc', 'http://example.com']), /HTTPS/);
  const options = parseSupervisorArguments([...args, '--journal-dir', '/tmp/private-mining', '--send']);
  assert.equal(options.send, true);
  assert.equal(options.batch, 10);
});

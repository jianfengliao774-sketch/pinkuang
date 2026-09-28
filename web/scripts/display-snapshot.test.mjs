import test from 'node:test';
import assert from 'node:assert/strict';
import { readDisplaySnapshot, writeDisplaySnapshot } from '../lib/display-snapshot.mjs';

const manifest = { artifactDigest: `0x${'ab'.repeat(32)}`, factory: `0x${'11'.repeat(20)}`, shareMarket: `0x${'22'.repeat(20)}` };
const source = { complete: true, unknownReason: null, chainId: 56, factory: manifest.factory,
  market: manifest.shareMarket, indexedThrough: 100, indexedTimestamp: 1700000000,
  indexedBlockHash: `0x${'cd'.repeat(32)}` };
const storage = () => {
  const map = new Map();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
};

test('persists only identity-bound, verified display data and preserves exact amounts', () => {
  const cache = storage(), result = { detail: { source, item: { pool: manifest.factory, shares: 99n, cost: 40_000_000_000_000_000n } } };
  assert.equal(writeDisplaySnapshot(cache, manifest, 'detail:wallet', result, { now: 1000 }), true);
  assert.deepEqual(readDisplaySnapshot(cache, manifest, 'detail:wallet', { now: 2000 }), result);
  assert.equal(readDisplaySnapshot(cache, { ...manifest, factory: `0x${'33'.repeat(20)}` }, 'detail:wallet', { now: 2000 }), null);
  assert.equal(readDisplaySnapshot(cache, manifest, 'detail:wallet', { now: 3_601_001 }), null);
  assert.equal(writeDisplaySnapshot(cache, manifest, 'unverified', { detail: { source: { ...source, complete: false } } }), false);
});

test('section snapshots stay separate for each account and reject unverified data', () => {
  const cache = storage();
  const first = { source, items: [{ shares: 99n }] };
  const accountA = `positions:0x${'aa'.repeat(20)}`;
  const accountB = `positions:0x${'bb'.repeat(20)}`;
  assert.equal(writeDisplaySnapshot(cache, manifest, accountA, first, { now: 1000 }), true);
  assert.deepEqual(readDisplaySnapshot(cache, manifest, accountA, { now: 2000 }), first);
  assert.equal(readDisplaySnapshot(cache, manifest, accountB, { now: 2000 }), null);
  assert.equal(writeDisplaySnapshot(cache, manifest, accountB, { ...first, source: { ...source, complete: false } }), false);
});

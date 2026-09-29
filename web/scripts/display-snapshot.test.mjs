import test from 'node:test';
import assert from 'node:assert/strict';
import { displayOnlySnapshot, pageDisplayKey, readDisplaySnapshot, writeDisplaySnapshot } from '../lib/display-snapshot.mjs';

const manifest = { artifactDigest: `0x${'ab'.repeat(32)}`, factory: `0x${'11'.repeat(20)}`, shareMarket: `0x${'22'.repeat(20)}` };
const source = { complete: true, unknownReason: null, chainId: 56, factory: manifest.factory,
  market: manifest.shareMarket, indexedThrough: 100, indexedTimestamp: 1700000000,
  indexedBlockHash: `0x${'cd'.repeat(32)}` };
const storage = (map = new Map()) => {
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
};

test('pre-boot and live display keys isolate routes, wallets and market tabs', () => {
  const route = { route: 'market', pool: null };
  assert.equal(pageDisplayKey(route, null, 'whole'), '["market","","","whole"]');
  assert.notEqual(pageDisplayKey(route, null, 'whole'), pageDisplayKey(route, null, 'shares'));
  assert.notEqual(pageDisplayKey(route, null, 'whole'), pageDisplayKey(route, `0x${'aa'.repeat(20)}`, 'whole'));
  assert.notEqual(pageDisplayKey(route, null, 'whole'), pageDisplayKey({ route: 'detail', pool: manifest.factory }, null));
});

test('persists only identity-bound, verified display data and preserves exact amounts', () => {
  const cache = storage(), result = { detail: { source, item: { pool: manifest.factory, shares: 99n, cost: 40_000_000_000_000_000n } } };
  assert.equal(writeDisplaySnapshot(cache, manifest, 'detail:wallet', result, { now: 1000 }), true);
  const persisted = readDisplaySnapshot(cache, manifest, 'detail:wallet', { now: 2000 });
  assert.deepEqual(persisted.detail.item, result.detail.item);
  assert.deepEqual(persisted.detail.source, { ...source, readMode: 'verified_snapshot', stale: true,
    transactionReady: false, refreshing: true, cacheOrigin: 'local', checkedAt: new Date(1000).toISOString() });
  assert.deepEqual(result.detail.source, source, 'marking the cache must not mutate the original verified read');
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
  assert.deepEqual(readDisplaySnapshot(cache, manifest, accountA, { now: 2000 }).items, first.items);
  assert.equal(readDisplaySnapshot(cache, manifest, accountB, { now: 2000 }), null);
  assert.equal(writeDisplaySnapshot(cache, manifest, accountB, { ...first, source: { ...source, complete: false } }), false);
});

test('display-only server snapshots retain stale markers and expire from the original verification time', () => {
  const cache = storage();
  const checkedAt = new Date(1000).toISOString();
  const result = { source: { ...source, readMode: 'verified_snapshot', stale: true,
    refreshing: true, transactionReady: false, checkedAt }, items: [] };
  assert.equal(writeDisplaySnapshot(cache, manifest, 'historical', result, { now: 1000 }), true);
  const restored = readDisplaySnapshot(cache, manifest, 'historical', { now: 30 * 60_000 });
  assert.equal(restored.source.checkedAt, checkedAt);
  assert.equal(restored.source.cacheOrigin, 'local');
  assert.equal(restored.source.transactionReady, false);
  assert.equal(readDisplaySnapshot(cache, manifest, 'historical', { now: 30 * 60_000 + 1001 }), null);
  assert.equal(writeDisplaySnapshot(cache, manifest, 'future', { ...result,
    source: { ...result.source, checkedAt: new Date(40_000).toISOString() } }, { now: 1000 }), true);
  assert.equal(readDisplaySnapshot(cache, manifest, 'future', { now: 2000 }), null);
  assert.equal(writeDisplaySnapshot(cache, manifest, 'unmarked', {
    ...result, source: { ...result.source, transactionReady: true },
  }, { now: 1000 }), false);
});

test('a recent in-memory copy is display-only and cannot refresh a persisted snapshot age', () => {
  const result = { catalog: { source, items: [{ shares: 7n }] } };
  const display = displayOnlySnapshot(result, manifest, 1000);
  assert.equal(display.catalog.source.stale, true);
  assert.equal(display.catalog.source.transactionReady, false);
  assert.equal(display.catalog.source.checkedAt, new Date(1000).toISOString());
  const cache = storage();
  assert.equal(writeDisplaySnapshot(cache, manifest, 'catalog', result, { now: 1000 }), true);
  assert.equal(readDisplaySnapshot(cache, manifest, 'catalog', { now: 3_601_001 }), null);
  assert.equal(writeDisplaySnapshot(cache, manifest, 'untrusted', { ...result,
    catalog: { ...result.catalog, source: { ...source, indexedBlockHash: 'bad' } } }), false);
});

test('a new page instance restores only its own wallet snapshot from persistent storage', () => {
  const backing = new Map();
  const walletA = `0x${'aa'.repeat(20)}`, walletB = `0x${'bb'.repeat(20)}`;
  const result = { source, items: [{ owner: walletA, shares: 11n }] };
  assert.equal(writeDisplaySnapshot(storage(backing), manifest, `positions:${walletA}`, result, { now: 1000 }), true);
  const restored = readDisplaySnapshot(storage(backing), manifest, `positions:${walletA}`, { now: 2000 });
  assert.equal(restored.items[0].shares, 11n);
  assert.equal(restored.source.transactionReady, false);
  assert.equal(readDisplaySnapshot(storage(backing), manifest, `positions:${walletB}`, { now: 2000 }), null);
});

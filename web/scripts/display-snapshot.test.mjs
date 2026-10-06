import test from 'node:test';
import assert from 'node:assert/strict';
import { Result } from 'ethers';
import { displayListSnapshot, displayOnlySnapshot, invalidateDisplaySnapshots, pageDisplayKey,
  readDisplaySnapshot, readPoolDisplaySnapshot, writeDisplaySnapshot, writePoolDisplaySnapshots } from '../lib/display-snapshot.mjs';

const manifest = { artifactDigest: `0x${'ab'.repeat(32)}`, factory: `0x${'11'.repeat(20)}`, shareMarket: `0x${'22'.repeat(20)}` };
const source = { complete: true, unknownReason: null, chainId: 56, factory: manifest.factory,
  market: manifest.shareMarket, indexedThrough: 100, indexedTimestamp: 1700000000,
  indexedBlockHash: `0x${'cd'.repeat(32)}` };
const storage = (map = new Map()) => {
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value),
    removeItem: key => map.delete(key), key: index => [...map.keys()][index] ?? null,
    get length() { return map.size; } };
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

test('old list caches with missing or malformed items cannot reach page list rendering', () => {
  const backing = new Map(), cache = storage(backing);
  const page = `positions:0x${'aa'.repeat(20)}`;
  assert.equal(writeDisplaySnapshot(cache, manifest, page, { source, items: [] }, { now: 1000 }), true);
  assert.deepEqual(displayListSnapshot(readDisplaySnapshot(cache, manifest, page, { now: 2000 })).items, []);
  const cacheKey = [...backing.keys()][0];
  const oldRecord = JSON.parse(backing.get(cacheKey));
  delete oldRecord.result.items;
  backing.set(cacheKey, JSON.stringify(oldRecord));
  assert.equal(displayListSnapshot(readDisplaySnapshot(cache, manifest, page, { now: 2000 })), null);
  assert.equal(displayListSnapshot({ source }), null, 'a cache from an older schema may omit items');
  assert.equal(displayListSnapshot({ source, items: {} }), null);
  assert.equal(displayOnlySnapshot({ source, items: {} }, manifest, 1000), null);
  assert.equal(displayOnlySnapshot({ catalog: { source, items: null } }, manifest, 1000), null);
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
  assert.equal(displayOnlySnapshot(result, manifest, 30 * 60_000, 30 * 60_000 + 1001), null,
    'a recent memory entry cannot extend the original server snapshot age');
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

test('reorg invalidation retires every page for one deployment without touching another', () => {
  const backing = new Map(), cache = storage(backing), other = { ...manifest, factory: `0x${'33'.repeat(20)}` };
  assert.equal(writeDisplaySnapshot(cache, manifest, 'home', { source, items: [] }, { now: 1000 }), true);
  assert.equal(writeDisplaySnapshot(cache, manifest, 'detail', { source, items: [] }, { now: 1000 }), true);
  const otherSource = { ...source, factory: other.factory };
  assert.equal(writeDisplaySnapshot(cache, other, 'home', { source: otherSource, items: [] }, { now: 1000 }), true);
  cache.setItem('unrelated', 'keep');
  assert.equal(invalidateDisplaySnapshots(cache, manifest), 2);
  assert.equal(readDisplaySnapshot(cache, manifest, 'home', { now: 2000 }), null);
  assert.equal(readDisplaySnapshot(cache, manifest, 'detail', { now: 2000 }), null);
  assert.equal(readDisplaySnapshot(cache, other, 'home', { now: 2000 })?.items.length, 0);
  assert.equal(cache.getItem('unrelated'), 'keep');
  assert.equal(invalidateDisplaySnapshots(cache, manifest), 0);
});

test('catalog reads seed deep-link details and public fallback never exposes a different wallet balance', () => {
  const cache = storage(), walletA = `0x${'aa'.repeat(20)}`, walletB = `0x${'bb'.repeat(20)}`;
  const row = { pool: manifest.factory, trusted: true, unitPriceWei: 1111000000000000n,
    totalSupply: 100n, memberCount: 2n, shares: 50n, lockedShares: 3n, availableShares: 47n,
    claimableBEM: 9n, bnbOwed: 5050000000000000n, initialContributedWei: 55550000000000000n };
  const result = { catalog: { source, items: [row], nextCursor: null } };
  const route = { route: 'detail', pool: row.pool.toUpperCase().replace('0X', '0x') };
  assert.equal(writePoolDisplaySnapshots(cache, manifest, result, walletA, { now: 1000 }), 2);
  const own = readPoolDisplaySnapshot(cache, manifest, route, walletA, { now: 2000 });
  assert.equal(own.detail.item.shares, 50n);
  assert.equal(own.detail.item.bnbOwed, row.bnbOwed);
  for (const wallet of [null, walletB]) {
    const shared = readPoolDisplaySnapshot(cache, manifest, route, wallet, { now: 2000 });
    assert.equal(shared.detail.item.unitPriceWei, row.unitPriceWei);
    assert.equal(shared.detail.item.totalSupply, 100n);
    for (const field of ['shares', 'lockedShares', 'availableShares', 'claimableBEM', 'bnbOwed', 'initialContributedWei'])
      assert.equal(shared.detail.item[field], null);
    assert.equal(shared.detail.source.transactionReady, false);
    assert.equal(shared.detail.source.stale, true);
  }
  assert.equal(row.shares, 50n, 'saving a public copy must not mutate the live wallet result');
  assert.equal(readPoolDisplaySnapshot(cache, manifest, { route: 'detail', pool: `0x${'55'.repeat(20)}` }, walletB, { now: 2000 }), null);
  assert.equal(readPoolDisplaySnapshot(cache, manifest, route, walletA, { now: 3_601_001 }), null);
  assert.equal(writePoolDisplaySnapshots(cache, manifest, { catalog: { ...result.catalog, source: { ...source, complete: false } } }, walletB), 0);
});

test('compact details persist even when the combined page exceeds the browser snapshot size limit', () => {
  const cache = storage(), route = { route: 'detail', pool: manifest.factory };
  const result = { detail: { source, item: { pool: manifest.factory, trusted: true, unitPriceWei: 123n } },
    snapshot: { irrelevantPagePayload: 'x'.repeat(400_000) } };
  assert.equal(writeDisplaySnapshot(cache, manifest, pageDisplayKey(route, null), result, { now: 1000 }), false);
  assert.equal(writePoolDisplaySnapshots(cache, manifest, result, null, { now: 1000 }), 1);
  const restored = readPoolDisplaySnapshot(cache, manifest, route, null, { now: 2000 });
  assert.equal(restored.detail.item.unitPriceWei, 123n);
  assert.equal(restored.snapshot, undefined);
});

test('RPC tuple parameters retain named amounts, addresses and deadlines across cache restores', () => {
  const cache = storage(), route = { route: 'detail', pool: manifest.factory };
  const names = ['circuits', 'circuitId', 'targetRaise', 'priceCap', 'directSeller', 'directPrice', 'fundingDeadline', 'purchaseDeadline'];
  const values = [manifest.shareMarket, 12962n, 111100000000000000n, 101000000000000000n,
    `0x${'44'.repeat(20)}`, 100000000000000000n, 1790860226n, 1791033026n];
  const params = Result.fromItems(values, names);
  const result = { detail: { source, item: { pool: route.pool, trusted: true, params } } };
  assert.equal(writePoolDisplaySnapshots(cache, manifest, result, null, { now: 1000 }), 1);
  const restored = readPoolDisplaySnapshot(cache, manifest, route, null, { now: 2000 });
  assert.deepEqual(restored.detail.item.params, Object.fromEntries(names.map((name, i) => [name, values[i]])));
  assert.equal(params.targetRaise, values[2], 'normalizing the display must not mutate the RPC tuple');
  // Existing caches written before tuple normalization are repaired when read.
  assert.equal(writeDisplaySnapshot(cache, manifest, pageDisplayKey(route, null), result, { now: 1000 }), true);
  assert.deepEqual(readPoolDisplaySnapshot(cache, manifest, route, null, { now: 2000 }).detail.item.params,
    restored.detail.item.params);
});

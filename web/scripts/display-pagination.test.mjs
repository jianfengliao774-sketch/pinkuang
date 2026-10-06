import test from 'node:test';
import assert from 'node:assert/strict';
import { appendDisplayPage, loadedDisplayPages, refreshDisplayPages } from '../lib/display-pagination.mjs';

const address = n => `0x${String(n).padStart(40, '0')}`;
const source = { chainId: 56, factory: address(1), market: address(2), indexedThrough: 100,
  indexedTimestamp: 1800000000, indexedBlockHash: `0x${'a'.repeat(64)}` };
const page = (ids, nextCursor, overrides = {}) => ({ items: ids.map(n => ({ pool: address(n), value: n })),
  nextCursor, marketBnbOwed: 5n, source, ...overrides });

test('refreshes exactly the loaded window on a new source, keeping its latest cursor and removing obsolete rows', async () => {
  const first = page([11, 12], 20), requests = [];
  const result = await refreshDisplayPages(first, { pageCount: 2, options: { account: address(3) },
    read: async options => { requests.push(options); return page([13, 14], 40); } });
  assert.deepEqual(result.items.map(row => row.pool), [11, 12, 13, 14].map(address));
  assert.equal(result.loadedPages, 2); assert.equal(result.nextCursor, 40);
  assert.deepEqual(requests, [{ account: address(3), cursor: 20, source }]);
  assert.equal(first.items.length, 2, 'The prior page is not mutated during background reads.');
});

test('a partial terminal page does not query new unloaded pages', async () => {
  let reads = 0;
  const result = await refreshDisplayPages(page([11], 20), { pageCount: 4,
    read: async () => { reads++; return page([12], null); } });
  assert.equal(reads, 1); assert.equal(result.nextCursor, null); assert.equal(result.loadedPages, 2);
});

test('rejects mixed blocks, deployments, duplicate rows and inconsistent account credit', () => {
  const first = page([11], 20);
  for (const next of [page([12], null, { source: { ...source, indexedThrough: 101 } }),
    page([12], null, { source: { ...source, indexedBlockHash: `0x${'b'.repeat(64)}` } }),
    page([12], null, { source: { ...source, factory: address(3) } }),
    page([11], null), page([12], null, { marketBnbOwed: 6n })]) {
    assert.throws(() => appendDisplayPage(first, next));
    assert.equal(first.items.length, 1);
  }
});

test('supports order identities and cancels before starting another cached GET', async () => {
  const first = { source, items: [{ orderId: 1n, pool: address(11) }], nextCursor: 20 };
  const merged = appendDisplayPage(first, { source, items: [{ orderId: 2n, pool: address(11) }], nextCursor: null });
  assert.equal(merged.items.length, 2);
  assert.throws(() => appendDisplayPage(first, { source, items: [{ orderId: 1n, pool: address(11) }], nextCursor: null }));
  let reads = 0;
  assert.equal(await refreshDisplayPages(first, { pageCount: 2, isCurrent: () => false,
    read: () => { reads++; } }), first);
  assert.equal(reads, 0);
});

test('stored page counts preserve short pages; legacy expanded windows infer their count without extra reads', () => {
  assert.equal(loadedDisplayPages({ loadedPages: 3, items: [1] }), 3);
  assert.equal(loadedDisplayPages({}, 40), 2);
  assert.equal(loadedDisplayPages({ loadedPages: NaN }, 21), 2);
  assert.equal(loadedDisplayPages(null), 1);
});

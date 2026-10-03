import test from 'node:test';
import assert from 'node:assert/strict';
import { activityPage, activityPaginationEnabled, appendActivityPage, loadActivityPage } from '../lib/activity-pagination.mjs';

const address = value => `0x${String(value).padStart(40, '0')}`;
const subscription = index => {
  const transactionHash = `0x${BigInt(index + 1).toString(16).padStart(64, '0')}`;
  const common = { transactionHash, contract: address(1), blockNumber: 100 - index };
  return [
    { ...common, event: 'Deposited', logIndex: 1, fields: { user: address(2), shares: '1', amount: '1000' } },
    { ...common, event: 'Transfer', logIndex: 0, fields: { from: address(0), to: address(2), value: '1' } },
  ];
};

test('overview pages five operations after combining deposit and mint logs', () => {
  const rows = Array.from({ length: 7 }, (_, index) => subscription(index)).flat();
  const original = structuredClone(rows);
  const first = activityPage(rows, { route: 'overview', page: 0 });
  const second = activityPage(rows, { route: 'overview', page: 1 });
  assert.equal(first.paginated, true);
  assert.equal(first.visibleRows.length, 5);
  assert.equal(first.hasLoadedNextPage, true);
  assert.deepEqual(first.visibleRows, rows.filter(row => row.event === 'Deposited').slice(0, 5));
  assert.deepEqual(second.visibleRows, rows.filter(row => row.event === 'Deposited').slice(5));
  assert.equal(second.hasLoadedNextPage, false);
  assert.deepEqual(rows, original, 'Paging cannot change raw logs or export contents');
});

test('public, rewards and pool detail keep every raw log with five per page', () => {
  const rows = Array.from({ length: 4 }, (_, index) => subscription(index)).flat();
  for (const route of ['records', 'rewards', 'detail']) {
    const first = activityPage(rows, { route, page: 0 });
    const second = activityPage(rows, { route, page: 1 });
    assert.deepEqual(first.visibleRows, rows.slice(0, 5));
    assert.deepEqual(second.visibleRows, rows.slice(5));
    assert.equal(first.hasLoadedNextPage, true);
    assert.equal(second.hasLoadedNextPage, false);
  }
});

test('an appended cursor page becomes available without changing the current page', () => {
  const rows = Array.from({ length: 5 }, (_, index) => subscription(index)).flat();
  const before = activityPage(rows, { route: 'overview', page: 0 });
  assert.equal(before.hasLoadedNextPage, false);
  const appended = [...rows, ...subscription(5)];
  const current = activityPage(appended, { route: 'overview', page: 0 });
  assert.equal(current.hasLoadedNextPage, true);
  assert.deepEqual(current.visibleRows, before.visibleRows);
  assert.deepEqual(activityPage(appended, { route: 'overview', page: 1 }).visibleRows, [appended[10]]);
  assert.deepEqual(activityPage(appended, { route: 'overview', page: 0 }).visibleRows, before.visibleRows);
});

test('empty or shortened history clamps to an existing page', () => {
  const empty = activityPage([], { route: 'overview', page: 3 });
  assert.deepEqual(empty.visibleRows, []);
  assert.equal(empty.pageIndex, 0);
  assert.equal(empty.hasLoadedNextPage, false);
  const rows = subscription(0);
  assert.equal(activityPage(rows, { route: 'overview', page: 3 }).pageIndex, 0);
  assert.deepEqual(activityPage(rows, { route: 'overview', page: -1 }).visibleRows, [rows[0]]);
});

test('pool detail uses full history totals and clamps page jumps', () => {
  const rows = Array.from({ length: 4 }, (_, index) => subscription(index)).flat();
  const detail = activityPage(rows, { route: 'detail', page: 99, totalCount: 8 });
  assert.equal(detail.paginated, true);
  assert.equal(detail.totalPages, 2);
  assert.equal(detail.pageIndex, 1);
  assert.deepEqual(detail.visibleRows, rows.slice(5));
  for (const route of ['overview', 'records', 'rewards', 'detail']) assert.equal(activityPaginationEnabled(route), true);
  for (const route of ['home', 'market']) assert.equal(activityPaginationEnabled(route), false);
});

test('total pages come from the full server count, with the overview count kept separate', () => {
  const rows = Array.from({ length: 5 }, (_, index) => subscription(index)).flat();
  const metadata = { totalCount: 60, overviewTotalCount: 30, hasMore: true };
  assert.equal(activityPage(rows, { route: 'records', ...metadata }).totalPages, 12);
  const overview = activityPage(rows, { route: 'overview', ...metadata });
  assert.equal(overview.totalPages, 6);
  assert.equal(overview.totalCount, 30);
  assert.equal(overview.loadedCount, 5);
  assert.equal(activityPage(rows, { route: 'records', hasMore: true }).totalPages, null,
    'Loaded rows cannot stand in for a missing server total');
});

test('jumping to an unloaded page reads only the required cursor chunks and cached jumps read none', async () => {
  const all = Array.from({ length: 70 }, (_, index) => subscription(index)).flat();
  const requests = [];
  const initial = { items: all.slice(0, 20), nextCursor: '20', totalCount: 140, overviewTotalCount: 70 };
  const readPage = async ({ cursor, limit }) => {
    requests.push({ cursor, limit }); const start = Number(cursor), end = Math.min(start + limit, all.length);
    return { ...initial, items: all.slice(start, end), nextCursor: end < all.length ? String(end) : null };
  };
  const result = await loadActivityPage(initial, { route: 'overview', page: 8, readPage });
  assert.equal(result.pageIndex, 8);
  assert.deepEqual(requests, [{ cursor: '20', limit: 50 }, { cursor: '70', limit: 50 }]);
  assert.equal(result.items.length, 120);
  assert.deepEqual(activityPage(result.items, { route: 'overview', page: 8, ...result }).visibleRows,
    all.filter(row => row.event === 'Deposited').slice(40, 45));
  const cached = await loadActivityPage(result, { route: 'overview', page: 1, readPage });
  assert.equal(cached.pageIndex, 1); assert.equal(requests.length, 2);
});

test('the last page uses the real partial size and stale page requests stop without publishing data', async () => {
  const all = Array.from({ length: 7 }, (_, index) => subscription(index)).flat();
  const initial = { items: all.slice(0, 5), nextCursor: '5', totalCount: 14, overviewTotalCount: 7 };
  const result = await loadActivityPage(initial, { route: 'overview', page: 99,
    readPage: async () => ({ ...initial, items: all.slice(5), nextCursor: null }) });
  assert.equal(result.pageIndex, 1);
  assert.equal(activityPage(result.items, { route: 'overview', page: result.pageIndex, ...result }).visibleRows.length, 2);
  let current = true;
  assert.equal(await loadActivityPage(initial, { route: 'records', page: 2, isCurrent: () => current,
    readPage: async () => { current = false; return { ...initial, items: all.slice(5), nextCursor: null }; } }), null);
});

test('an absent total remains unknown while a legacy cursor still supports the next page', async () => {
  const all = Array.from({ length: 7 }, (_, index) => subscription(index)).flat();
  const result = await loadActivityPage({ items: all.slice(0, 5), nextCursor: '5' }, { route: 'records', page: 1,
    readPage: async () => ({ items: all.slice(5), nextCursor: null }) });
  assert.equal(result.pageIndex, 1);
  assert.equal(activityPage(result.items, { route: 'records', page: 1, ...result }).visibleRows.length, 5);
});

test('five newer head records cannot add an empty last page to the original 100-record history', async () => {
  const all = Array.from({ length: 50 }, (_, index) => subscription(index)).flat();
  const firstSource = { indexedThrough: 100, indexedBlockHash: '0xabc' };
  const initial = { items: all.slice(0, 50), nextCursor: '50', totalCount: 100, overviewTotalCount: 50, source: firstSource };
  let requests = 0;
  const readPage = async ({ source }) => {
    requests++; assert.strictEqual(source, firstSource);
    return { items: all.slice(50), nextCursor: null, totalCount: 105, overviewTotalCount: 55,
      source: { indexedThrough: 101, indexedBlockHash: '0xdef' } };
  };
  const result = await loadActivityPage(initial, { route: 'records', page: 20, readPage });
  const view = activityPage(result.items, { route: 'records', page: result.pageIndex, ...result });
  assert.equal(view.totalCount, 100); assert.equal(view.totalPages, 20); assert.equal(view.pageIndex, 19);
  assert.deepEqual(view.visibleRows, all.slice(-5)); assert.equal(result.overviewTotalCount, 50);
  assert.strictEqual(result.source, firstSource); assert.deepEqual(result.items, all);
  assert.deepEqual(initial.items, all.slice(0, 50));
  const cached = await loadActivityPage(result, { route: 'records', page: 7, readPage });
  assert.equal(cached.pageIndex, 7); assert.equal(requests, 1);
});

test('manual cursor append and overview paging preserve the same first-page counts and raw logs', () => {
  const all = Array.from({ length: 10 }, (_, index) => subscription(index)).flat();
  const source = { indexedThrough: 100, indexedBlockHash: '0xabc' };
  const snapshot = { items: all.slice(0, 10), nextCursor: '10', totalCount: 20, overviewTotalCount: 10, source };
  const appended = appendActivityPage(snapshot, { items: all.slice(10), nextCursor: null, totalCount: 30,
    overviewTotalCount: 15, source: { indexedThrough: 101, indexedBlockHash: '0xdef' } });
  assert.equal(appended.totalCount, 20); assert.equal(appended.overviewTotalCount, 10);
  assert.strictEqual(appended.source, source); assert.deepEqual(appended.items, all);
  const view = activityPage(appended.items, { route: 'overview', page: 1, ...appended });
  assert.equal(view.totalPages, 2); assert.equal(view.visibleRows.length, 5);
  assert.equal(appended.items.length, 20, 'Summary paging cannot remove mint logs from exported raw history');
});

test('legacy unknown counts may be filled once and remain fixed on later appends', () => {
  const snapshot = { items: [], totalCount: null, overviewTotalCount: null };
  const source = { indexedThrough: 100, indexedBlockHash: '0xabc' };
  const first = appendActivityPage(snapshot, { items: subscription(0), totalCount: 20, overviewTotalCount: 10, source });
  const next = appendActivityPage(first, { items: subscription(1), totalCount: 25, overviewTotalCount: 15,
    source: { indexedThrough: 101, indexedBlockHash: '0xdef' } });
  assert.equal(next.totalCount, 20); assert.equal(next.overviewTotalCount, 10); assert.strictEqual(next.source, source);
  assert.deepEqual(next.items, [...subscription(0), ...subscription(1)]);
});

test('shrinking totals, source rollback and a changed hash at the anchor height require a fresh first page', async () => {
  const initial = { items: subscription(0), nextCursor: '2', totalCount: 20, overviewTotalCount: 10,
    source: { indexedThrough: 100, indexedBlockHash: '0xabc' } };
  const stable = { items: subscription(1), nextCursor: null, totalCount: 20, overviewTotalCount: 10,
    source: { indexedThrough: 100, indexedBlockHash: '0xABC' } };
  assert.equal(appendActivityPage(initial, stable).items.length, 4, 'Hash letter case is not a source change');
  for (const changes of [{ totalCount: 19 }, { overviewTotalCount: 9 },
    { source: { indexedThrough: 99, indexedBlockHash: '0xolder' } },
    { source: { indexedThrough: 100, indexedBlockHash: '0xdifferent' } }]) {
    const part = { ...stable, ...changes };
    assert.throws(() => appendActivityPage(initial, part), { code: 'source_reorg' });
    await assert.rejects(loadActivityPage(initial, { route: 'records', page: 3, readPage: async () => part }), { code: 'source_reorg' });
  }
  assert.equal(initial.items.length, 2, 'A rejected cursor read cannot alter already displayed history');
});

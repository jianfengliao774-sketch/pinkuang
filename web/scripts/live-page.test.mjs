import test from 'node:test';
import assert from 'node:assert/strict';
import { ZeroAddress } from 'ethers';
import { readPageRound } from '../lib/live-page.mjs';
import { LiveDataError } from '../lib/live-config.mjs';
import { READ_CANCELLED, retryReadRound } from '../lib/read-retry.mjs';

const addr = n => `0x${String(n).padStart(40, '0')}`;
const account = addr(7), pool = addr(8);
const source = Object.freeze({ chainId: 56, factory: addr(1), market: addr(2), startBlock: 8,
  confirmations: 12, indexedThrough: 10, indexedTimestamp: 1_800_000_000, observedSafeHead: 10,
  indexedBlockHash: `0x${'ab'.repeat(32)}`, complete: true, unknownReason: null });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fixture(read) {
  const calls = [];
  const client = Object.fromEntries(['readPools', 'readPool', 'readStats', 'readPositions', 'readActivity', 'readOrders']
    .map(method => [method, async options => { calls.push({ method, options }); return read(method, options); }]));
  return { client, calls };
}

test('each page starts only its catalog and never waits for unrelated sections', async () => {
  const gate = deferred();
  const f = fixture(async method => {
    if (method !== 'readPools') throw new Error('unrelated read must not start');
    await gate.promise;
    return { source, items: [], nextCursor: null };
  });
  const waiting = readPageRound(f.client, { route: 'market', account });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.map(call => call.method), ['readPools']);
  gate.resolve();
  assert.deepEqual(Object.keys(await waiting), ['catalog']);
  for (const route of ['home', 'pools', 'market']) {
    const result = await readPageRound(f.client, { route, account });
    assert.deepEqual(Object.keys(result), ['catalog']);
  }
  assert(f.calls.every(call => call.options.account === account));
  const count = f.calls.length;
  for (const route of ['overview', 'rewards', 'records', 'portfolio', 'governance'])
    assert.deepEqual(await readPageRound(f.client, { route, account }), { catalog: null });
  assert.equal(f.calls.length, count);
  await readPageRound(f.client, { route: 'market' });
  assert.equal(f.calls.at(-1).options.account, ZeroAddress);
  const marketCalls = f.calls.length;
  for (const marketTab of ['shares', 'mine'])
    assert.deepEqual(await readPageRound(f.client, { route: 'market', marketTab, account }), { catalog: null });
  assert.equal(f.calls.length, marketCalls);
  await readPageRound(f.client, { route: 'governance' });
  assert.equal(f.calls.at(-1).options.account, ZeroAddress);
});

test('detail is verified on its own and operator does not start public reads', async () => {
  const f = fixture(async method => {
    if (method !== 'readPool') throw new Error('unexpected route read');
    return { source, item: { pool } };
  });
  assert.deepEqual(await readPageRound(f.client, { route: 'operator', account }), { catalog: null });
  assert.equal(f.calls.length, 0);
  const result = await readPageRound(f.client, { route: { route: 'detail', pool }, account });
  assert.equal(result.detail.item.pool, pool);
  assert.deepEqual(f.calls, [{ method: 'readPool', options: { pool, account } }]);
});

test('a page accepts its own valid source and rejects incomplete or malformed data', async () => {
  for (const bad of [null, { ...source, complete: false }, { ...source, unknownReason: 'gap' }]) {
    const f = fixture(async () => ({ source: bad, items: [] }));
    await assert.rejects(readPageRound(f.client, { route: 'market', account }), { code: 'index_incomplete' });
  }
  for (const bad of [{ chainId: 1 }, { observedSafeHead: 11 }, { indexedThrough: '10' }, { indexedBlockHash: 'bad' }]) {
    const f = fixture(async () => ({ source: { ...source, ...bad }, items: [] }));
    await assert.rejects(readPageRound(f.client, { route: 'market', account }), { code: 'invalid_data' });
  }
  const newer = { ...source, indexedThrough: 11, observedSafeHead: 11 };
  const f = fixture(async () => ({ source: newer, items: [] }));
  assert.equal((await readPageRound(f.client, { route: 'market', account })).catalog.source.indexedThrough, 11);
  const display = { ...source, readMode: 'verified_snapshot', stale: true, refreshing: true, transactionReady: false };
  const stale = fixture(async () => ({ source: display, items: [] }));
  assert.equal((await readPageRound(stale.client, { route: 'pools' })).catalog.source.transactionReady, false);
  for (const bad of [{ ...display, stale: false }, { ...display, transactionReady: true },
    { ...source, stale: true }, { ...source, transactionReady: false }]) {
    const malformed = fixture(async () => ({ source: bad, items: [] }));
    await assert.rejects(readPageRound(malformed.client, { route: 'pools' }), { code: 'index_stale' });
  }
});

test('catalog failure cannot become a successful empty list', async () => {
  const f = fixture(async () => { throw new LiveDataError('http_unavailable', 'Index unavailable', { status: 503 }); });
  await assert.rejects(readPageRound(f.client, { route: 'pools' }), { code: 'http_unavailable' });
});

test('route change cancels an old page read without publishing its result', async () => {
  const gate = deferred();
  let current = true;
  const f = fixture(async () => { await gate.promise; return { source, items: [] }; });
  const waiting = retryReadRound(() => readPageRound(f.client, { route: 'pools' }), { isCurrent: () => current });
  await new Promise(resolve => setImmediate(resolve));
  current = false;
  gate.resolve();
  assert.equal(await waiting, READ_CANCELLED);
  assert.equal(f.calls.length, 1);
});

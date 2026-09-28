import test from 'node:test';
import assert from 'node:assert/strict';
import { ZeroAddress } from 'ethers';
import { readPageRound } from '../lib/live-page.mjs';
import { LiveDataError } from '../lib/live-config.mjs';
import { READ_CANCELLED, retryReadRound } from '../lib/read-retry.mjs';
import { amount, sumKnown } from '../lib/live-view.mjs';

const addr = n => `0x${String(n).padStart(40, '0')}`;
const account = addr(7), pool = addr(8);
const source = Object.freeze({ chainId: 56, factory: addr(1), market: addr(2), startBlock: 8,
  confirmations: 12, indexedThrough: 10, indexedTimestamp: 1_800_000_000, observedSafeHead: 10,
  indexedBlockHash: `0x${'ab'.repeat(32)}`, complete: true, unknownReason: null,
  checkedAt: '2027-01-15T08:00:00.000Z' });
const methods = ['readPools', 'readStats', 'readPositions', 'readPool', 'readGovernance', 'readActivity', 'readOrders'];
const empty = inputSource => ({ source: inputSource, items: [], nextCursor: null });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(read = async () => empty(source)) {
  const calls = [];
  const client = Object.fromEntries(methods.map(method => [method, async options => {
    calls.push({ method, options }); return read(method, options);
  }]));
  return { client, calls };
}

test('portfolio starts catalog, positions and history together, then returns one complete source', async () => {
  const gate = deferred(), started = deferred(); let count = 0, complete = false;
  const f = fixture(async () => { if (++count === 3) started.resolve(); await gate.promise; return empty(source); });
  const loading = readPageRound(f.client, { route: { route: 'overview' }, account }).then(result => { complete = true; return result; });
  const timer = setTimeout(gate.resolve, 1500);
  try {
    await started.promise;
    assert.deepEqual(f.calls.map(row => row.method), ['readPools', 'readPositions', 'readActivity']);
    assert(f.calls.every(row => row.options.account === account && !Object.hasOwn(row.options, 'source')));
    assert.equal(complete, false);
    gate.resolve();
    const result = await loading;
    assert.deepEqual(Object.keys(result), ['catalog', 'positions', 'activity']);
    assert.equal(result.positions.source, source);
  } finally { clearTimeout(timer); gate.resolve(); await loading; }
});

test('route plan preserves public/private filters and only the required branches', async () => {
  const cases = [
    ['home', undefined, undefined, ['readPools', 'readStats']],
    ['pools', account, undefined, ['readPools']],
    ['overview', undefined, undefined, ['readPools', 'readActivity']],
    ['rewards', account, undefined, ['readPools', 'readPositions', 'readActivity']],
    ['records', account, undefined, ['readPools', 'readActivity']],
    ['market', account, 'mine', ['readPools', 'readPositions', 'readOrders']],
    ['market', undefined, 'mine', ['readPools']],
    ['market', undefined, 'all', ['readPools', 'readOrders']],
    ['governance', account, undefined, ['readPools', 'readPositions']],
    ['operator', account, undefined, []],
  ];
  for (const [route, owner, marketTab, expected] of cases) {
    const f = fixture(); await readPageRound(f.client, { route, account: owner, marketTab });
    assert.deepEqual(f.calls.map(row => row.method), expected, route);
    if (route === 'operator') continue;
    assert.equal(f.calls[0].options.account, owner || ZeroAddress);
    const orders = f.calls.find(row => row.method === 'readOrders');
    if (orders) assert.deepEqual(orders.options, marketTab === 'mine' ? { seller: owner } : { active: true });
    if (route === 'records') assert.equal(f.calls.at(-1).options.account, undefined);
  }
  const f = fixture(); await readPageRound(f.client, { route: { route: 'detail', pool }, account });
  assert.deepEqual(f.calls.map(row => row.method), ['readPools', 'readPool', 'readGovernance', 'readActivity']);
  assert(f.calls.slice(1).every(row => row.options.pool === pool));
});

test('operator page remains usable when the unrelated public index returns 503', async () => {
  const f = fixture(async () => { throw new LiveDataError('http_unavailable', 'Index unavailable', { status: 503 }); });
  assert.deepEqual(await readPageRound(f.client, { route: 'operator', account }), { catalog: null });
  assert.equal(f.calls.length, 0);
  await assert.rejects(readPageRound(f.client, { route: 'pools', account }), { code: 'http_unavailable' });
});

test('every identity, coverage and block/time disagreement rejects the entire round', async () => {
  for (const change of [{ factory: addr(4) }, { market: addr(4) }, { startBlock: 7 }, { confirmations: 13 },
    { indexedThrough: 11, observedSafeHead: 11 }, { indexedTimestamp: source.indexedTimestamp + 1 },
    { indexedBlockHash: `0x${'cd'.repeat(32)}` }]) {
    const f = fixture(async method => empty(method === 'readPositions' ? { ...source, ...change } : source));
    await assert.rejects(readPageRound(f.client, { route: 'overview', account }), { code: 'source_changed' });
  }
  for (const change of [{ chainId: 1 }, { observedSafeHead: 11 }, { indexedThrough: '10' }, { indexedBlockHash: 'bad' }]) {
    const f = fixture(async method => empty(method === 'readPositions' ? { ...source, ...change } : source));
    await assert.rejects(readPageRound(f.client, { route: 'overview', account }), { code: 'invalid_data' });
  }
  const f = fixture(async method => empty(method === 'readActivity' ? { ...source, checkedAt: '2027-01-15T08:00:01.000Z' } : source));
  assert((await readPageRound(f.client, { route: 'overview', account })).activity);
});

test('unknown source and rejected reads cannot become a successful empty portfolio', async () => {
  for (const unknown of [null, { ...source, complete: false }, { ...source, unknownReason: 'gap' }]) {
    const f = fixture(async method => empty(method === 'readPositions' ? unknown : source));
    await assert.rejects(readPageRound(f.client, { route: 'overview', account }), { code: 'index_incomplete' });
  }
  const failed = fixture(async method => { if (method === 'readPositions') throw new Error('RPC down'); return empty(source); });
  await assert.rejects(readPageRound(failed.client, { route: 'overview', account }), /RPC down/);
  const verified = await readPageRound(fixture().client, { route: 'overview', account });
  assert.equal(amount(sumKnown(verified.positions.items, 'claimableBEM'), 8), '0.000');
  assert.equal(amount(sumKnown(verified.positions.items, 'bnbOwed')), '0.000');
  assert.equal(sumKnown(verified.positions.items, 'shares'), 0n);
  assert.equal(verified.positions.items.filter(row => row.shares > 0n).length, 0);
  assert.equal(amount(null), '—');
  assert.equal(sumKnown([{ shares: null }], 'shares'), null);
});

test('permission failures take precedence and every pending branch drains before rejection', async () => {
  const gate = deferred(), allStarted = deferred(); let started = 0, settled = false, active = 0;
  const denied = new LiveDataError('permission_denied', 'Denied');
  const f = fixture(async method => {
    started++; active++; if (started === 3) allStarted.resolve();
    try {
      if (method === 'readPools') throw new LiveDataError('source_changed', 'Moving index');
      if (method === 'readPositions') throw denied;
      await gate.promise; return empty(source);
    } finally { active--; }
  });
  const work = readPageRound(f.client, { route: 'overview', account }).then(() => assert.fail('must reject'), error => { settled = true; assert.equal(error, denied); });
  try {
    await allStarted.promise; await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false); assert.equal(active, 1);
  } finally { gate.resolve(); await work; }
  assert.equal(active, 0);
});

test('outer retry discards obsolete wallet/route results and retries source changes as complete rounds', async () => {
  const gate = deferred(), started = deferred(); let current = true, count = 0;
  const f = fixture(async () => { if (++count === 3) started.resolve(); await gate.promise; return empty(source); });
  const route = { route: 'overview' };
  const waiting = retryReadRound(() => readPageRound(f.client, { route, account }), { isCurrent: () => current });
  await started.promise; route.route = 'pools'; current = false; gate.resolve();
  assert.equal(await waiting, READ_CANCELLED);
  assert.equal(f.calls.length, 3);
  assert(f.calls.every(row => row.options.account === account));
  let attempts = 0;
  const retry = fixture(async method => empty(attempts === 1 && method === 'readActivity'
    ? { ...source, indexedThrough: 11, observedSafeHead: 11 } : source));
  const recovered = await retryReadRound(() => { attempts++; return readPageRound(retry.client, { route: 'overview', account: addr(9) }); }, { wait: async () => {} });
  assert.equal(attempts, 2); assert.equal(retry.calls.length, 6);
  assert.equal(recovered.positions.source, source);
  assert(retry.calls.every(row => row.options.account === addr(9)));
});

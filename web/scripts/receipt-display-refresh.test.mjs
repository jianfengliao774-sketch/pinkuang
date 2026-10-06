import test from 'node:test';
import assert from 'node:assert/strict';
import { receiptDisplayTarget, receiptDisplaySources, receiptDisplayBehind,
  startReceiptDisplayCatchup, RECEIPT_DISPLAY_INTERVAL_MS } from '../lib/receipt-display-refresh.mjs';
const account = '0x' + 'aa'.repeat(20), other = '0x' + 'bb'.repeat(20), factory = '0x' + 'cc'.repeat(20);
const receipt = (overrides = {}) => ({ status: 'confirmed', account, confirmedAt: 1000,
  blockNumber: '0x64', ...overrides });
const source = (height = 99, overrides = {}) => ({ factory, indexedThrough: height, ...overrides });

test('catchup targets only recent successful receipts from this wallet, with exact block numbers', () => {
  assert.equal(receiptDisplayTarget([receipt(), receipt({ blockNumber: '0x65' })], account, 2000), 101n);
  for (const record of [receipt({ status: 'pending' }), receipt({ status: 'failed' }), receipt({ account: other }),
    receipt({ confirmedAt: 3000 }), receipt({ confirmedAt: undefined }), receipt({ blockNumber: '-1' }),
    receipt({ blockNumber: Number.MAX_SAFE_INTEGER + 1 }), receipt({ blockNumber: 'garbage' })])
    assert.equal(receiptDisplayTarget([record], account, 2000), null);
  assert.equal(receiptDisplayTarget([receipt()], account, 121000), null);
  assert.equal(receiptDisplayTarget([receipt({ blockNumber: '9007199254740993' })], account, 2000), 9007199254740993n);
});

test('each route tracks its mounted display sections, including budget details and share orders', () => {
  const state = { source: 'catalog', statsSource: 'stats', positionsSource: 'positions',
    ordersSource: 'orders', activitySource: 'activity', portfolioSource: 'portfolio' };
  assert.deepEqual(receiptDisplaySources({ ...state, route: 'detail' }), ['catalog']);
  assert.deepEqual(receiptDisplaySources({ ...state, route: 'portfolio' }), ['portfolio']);
  assert.deepEqual(receiptDisplaySources({ ...state, route: 'home' }), ['catalog', 'stats']);
  assert.deepEqual(receiptDisplaySources({ ...state, route: 'pools' }), ['catalog', 'portfolio']);
  assert.deepEqual(receiptDisplaySources({ ...state, route: 'overview' }), ['positions', 'portfolio', 'activity']);
  assert.deepEqual(receiptDisplaySources({ ...state, route: 'market', marketTab: 'shares' }), ['orders', 'positions', 'portfolio']);
  assert.deepEqual(receiptDisplaySources({ ...state, route: 'market', marketTab: 'whole' }), ['catalog', 'positions', 'portfolio']);
  assert.deepEqual(receiptDisplaySources({ ...state, route: 'records' }), ['activity']);
  assert.deepEqual(receiptDisplaySources({ ...state, route: 'operator' }), []);
});

test('a fresh unrelated section or previous deployment cannot stop display catchup', () => {
  const state = { account, factory, now: 2000, route: 'home', source: source(101), statsSource: source(99) };
  assert.equal(receiptDisplayBehind([receipt()], state), true);
  assert.equal(receiptDisplayBehind([receipt()], { ...state, statsSource: source(100) }), false);
  assert.equal(receiptDisplayBehind([receipt()], { ...state, statsSource: source(101, { factory: other }) }), true);
  assert.equal(receiptDisplayBehind([receipt()], { ...state, statsSource: null }), true);
  assert.equal(receiptDisplayBehind([receipt()], { ...state, account: other }), false);
});

function fixture(state = {}) {
  let time = 1000, updates = 0, id = 0;
  const jobs = new Map();
  const display = { visible: true, busy: false, route: 'detail', source: source(), ...state };
  const stop = startReceiptDisplayCatchup([receipt()], { account, factory, now: () => time,
    getState: () => display, onRefresh: () => updates++,
    schedule: (callback, delay) => { assert.equal(delay, RECEIPT_DISPLAY_INTERVAL_MS); jobs.set(++id, callback); return id; },
    unschedule: key => jobs.delete(key) });
  return { display, jobs, stop, updates: () => updates, advance: ms => { time += ms; },
    tick() { time += RECEIPT_DISPLAY_INTERVAL_MS; const [key, callback] = jobs.entries().next().value;
      jobs.delete(key); callback(); } };
}

test('mined receipt followed by old cache keeps refreshing display until that cache includes its block', () => {
  const f = fixture(); assert.equal(f.updates(), 0);
  f.tick(); f.tick(); assert.equal(f.updates(), 2, 'One old response must not end catchup.');
  f.display.source = source(100); f.tick();
  assert.equal(f.updates(), 2); assert.equal(f.jobs.size, 0);
  f.stop();
});

test('hidden, pending/confirmation/loading and later record pages pause reads but keep a bounded retry', () => {
  const f = fixture({ visible: false }); f.tick(); assert.equal(f.updates(), 0);
  f.display.visible = true; f.display.busy = true; f.tick(); assert.equal(f.updates(), 0);
  f.display.busy = false; f.display.pastFirstRecordsPage = true; f.tick(); assert.equal(f.updates(), 0);
  f.display.pastFirstRecordsPage = false; f.tick(); assert.equal(f.updates(), 1);
  f.advance(120000); f.tick(); assert.equal(f.updates(), 1); assert.equal(f.jobs.size, 0);
});

test('account, route and deployment cleanup prevents queued late display work', () => {
  const f = fixture(); const late = f.jobs.values().next().value;
  f.stop(); assert.equal(f.jobs.size, 0); late(); assert.equal(f.updates(), 0);
});

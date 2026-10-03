import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { automaticDisplayRefreshDue, canReuseDisplayRead, displayRefreshPageKey, displayRefreshPaused } from '../lib/display-refresh-policy.mjs';
import { pageRefreshDue, refreshIntervalMs } from '../lib/page-refresh.mjs';
import { startDisplayUpdates } from '../lib/display-updates.mjs';
import { displayListSnapshot, displayOnlySnapshot } from '../lib/display-snapshot.mjs';
import { viewPool } from '../lib/live-view.mjs';
import { createLiveBrowserFixture } from './live-browser-fixture.mjs';

// Execute the component's actual effects/callbacks with local display fixtures.
// No wallet, live server or paid node is available in this harness.
const source = await readFile(new URL('../components/LivePlatform.jsx', import.meta.url), 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
function effect(marker, context) {
  const start = source.indexOf(`  useEffect(() => {\n    ${marker}`);
  const end = source.indexOf('\n  useEffect(', start + 1);
  assert(start >= 0 && end > start, marker);
  let cleanup;
  const scope = { ...context, useEffect: fn => { cleanup = fn(); } };
  new Function(...Object.keys(scope), source.slice(start, end))(...Object.values(scope));
  return cleanup;
}

function automaticRefreshFixture() {
  let now = 1000, check, stream, refreshes = 0, nextTimer = 0;
  const scheduled = new Map();
  const owner = '0x' + 'aa'.repeat(20), route = { route: 'overview' };
  class Source {
    constructor() { stream = this; }
    addEventListener(name, callback) { this[name] = callback; }
    removeEventListener() {} close() {}
    emit(revision) { this.update({ data: JSON.stringify({ revision }) }); }
  }
  const doc = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  const config = { displayOnly: true, status: 'ready', origin: 'https://bemine.cc.cd',
    indexBaseUrl: 'https://bemine.cc.cd/bemine-v5/api/chain-index' };
  const context = { client: {}, boot: config, config, route, account: owner, recordsPage: 0,
    routeIdentity: { current: route }, recordsPageRef: { current: 0 },
    refreshState: { current: { loading: false, busy: false, inputModal: false } },
    portfolioRead: { current: { busy: false } }, lastPageRefresh: { current: new Map() },
    displayRefreshPage: { current: displayRefreshPageKey(route, owner) },
    refreshIntervalMs, pageRefreshDue, displayRefreshPaused, displayRefreshPageKey, automaticDisplayRefreshDue,
    Date: { now: () => now }, document: doc, window: { addEventListener() {}, removeEventListener() {} },
    setInterval: callback => { check = callback; return 1; }, clearInterval() {},
    setReceiptDisplayRefresh: () => refreshes++, setRefresh: () => assert.fail('No verified-chain generation changes.'),
    submissionLock: { current: null }, setBootAttempt: () => assert.fail('No rebootstrap.'),
    fetchLiveJson: () => assert.fail('No product graph/RPC requests.'),
    startDisplayUpdates: (options, callbacks) => startDisplayUpdates(options, { ...callbacks,
      EventSourceImpl: Source, documentObject: doc,
      schedule: (callback, delay) => { const id = ++nextTimer; scheduled.set(id, { at: now + delay, callback }); return id; },
      unschedule: id => scheduled.delete(id),
    }),
  };
  let stopPage = effect('if (!client || refreshIntervalMs', context);
  const stopPush = effect('if (!client || !boot.displayOnly)', context);
  stream.emit('initial');
  const advance = time => {
    while (true) {
      const due = [...scheduled].filter(([, timer]) => timer.at <= time).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      scheduled.delete(due[0]); now = due[1].at; due[1].callback();
    }
    now = time;
  };
  return { context, scheduled, advance, push: revision => stream.emit(revision),
    periodic: () => check(), count: () => refreshes,
    navigate(nextRoute, nextOwner = context.account) {
      stopPage?.(); context.route = nextRoute; context.account = nextOwner;
      context.routeIdentity.current = nextRoute;
      context.displayRefreshPage.current = displayRefreshPageKey(nextRoute, nextOwner);
      stopPage = effect('if (!client || refreshIntervalMs', context);
    },
    manual() {
      const start = source.indexOf('      onClick={() => {', source.indexOf('  const refreshButton = ('));
      const end = source.indexOf('\n      }}\n      disabled=', start);
      assert(start > 0 && end > start);
      new Function(...Object.keys(context), source.slice(start + '      onClick={() => {'.length, end))(...Object.values(context));
    },
    close() { stopPage?.(); stopPush?.(); assert.equal(scheduled.size, 0); },
  };
}

test('periodic/focus and push share one automatic budget while the latest dirty push remains pending', () => {
  const f = automaticRefreshFixture();
  f.advance(16_000); f.periodic(); f.periodic(); assert.equal(f.count(), 1);
  f.advance(16_010); f.push('after-periodic');
  f.advance(16_770); assert.equal(f.count(), 1, 'A push 760ms after the periodic read cannot duplicate GETs.');
  assert.equal(f.scheduled.size, 1, 'The latest dirty revision is retained for a later flush.');
  f.advance(20_000); f.push('newer-while-throttled');
  f.advance(31_759); assert.equal(f.count(), 1);
  f.advance(31_760); assert.equal(f.count(), 2, 'The coalesced latest push refreshes after the shared 15-second budget.');
  f.periodic(); assert.equal(f.count(), 2, 'A focus/timer at the push time uses the same budget.');
  assert.equal(f.scheduled.size, 0); f.close();
});

test('a push before the due timer records the shared timestamp and manual refresh remains immediate', () => {
  const f = automaticRefreshFixture();
  f.advance(16_000); f.push('before-timer'); f.advance(16_750); assert.equal(f.count(), 1);
  f.periodic(); assert.equal(f.count(), 1, 'The due timer must observe the preceding push.');
  f.advance(17_000); f.manual(); assert.equal(f.count(), 2, 'Deliberate refresh bypasses automatic throttling.');
  assert.equal(f.context.lastPageRefresh.current.get(f.context.displayRefreshPage.current), 17_000);
  f.push('after-manual'); f.advance(17_750); assert.equal(f.count(), 2);
  f.advance(32_750); assert.equal(f.count(), 3, 'A manual refresh delays but does not discard a later dirty event.');
  f.close();
});

test('automatic push throttling backs off after failure without discarding the dirty event', () => {
  const f = automaticRefreshFixture();
  f.advance(16_000); f.periodic(); f.context.refreshState.current.failed = true;
  f.advance(16_010); f.push('failed-then-updated');
  f.advance(136_759); assert.equal(f.count(), 1);
  f.advance(136_760); assert.equal(f.count(), 2, 'A failed page uses the same 120-second retry budget for push and timer.');
  f.periodic(); assert.equal(f.count(), 2); f.close();
});

test('one push stream follows the current page and wallet while each identity keeps its own budget', () => {
  const f = automaticRefreshFixture(), first = f.context.displayRefreshPage.current;
  f.advance(16_000); f.periodic(); assert.equal(f.count(), 1);
  const nextOwner = '0x' + 'bb'.repeat(20);
  f.navigate({ route: 'overview' }, nextOwner);
  const second = f.context.displayRefreshPage.current;
  assert.notEqual(first, second); assert.equal(f.context.lastPageRefresh.current.get(first), 16_000);
  f.push('wallet-changed'); f.advance(16_750); assert.equal(f.count(), 1);
  f.advance(31_750); assert.equal(f.count(), 2);
  assert.equal(f.context.lastPageRefresh.current.get(second), 31_750);
  f.navigate({ route: 'operator' });
  const operator = f.context.displayRefreshPage.current;
  f.push('operator-change'); f.advance(32_500); assert.equal(f.count(), 3, 'A route without periodic reads admits its first push.');
  assert.equal(f.context.lastPageRefresh.current.get(operator), 32_500);
  f.advance(32_510); f.push('newer-operator-change'); f.advance(33_260); assert.equal(f.count(), 3);
  f.advance(48_260); assert.equal(f.count(), 4, 'Routes without a timer still enforce the 15-second push interval.');
  f.close();
});

test('display cache reuse expires promptly while pending/result status does not suppress a materialized GET', () => {
  assert(canReuseDisplayRead({ savedAt: 1000, refresh: '0:1' }, '0:1', 15_999));
  assert(!canReuseDisplayRead({ savedAt: 1000, refresh: '0:1' }, '0:1', 16_000));
  assert(!canReuseDisplayRead({ savedAt: 1000, refresh: '0:1' }, '0:2', 2000));
  assert(!canReuseDisplayRead({ savedAt: 1000, refresh: '0:1' }, '0:1', 999));
  assert(!displayRefreshPaused({ pending: true, modal: true, inputModal: false }, { displayOnly: true }));
  assert(displayRefreshPaused({ pending: true }, { displayOnly: false }));
  for (const state of [{ loading: true }, { busy: true }, { inputModal: true }])
    assert(displayRefreshPaused(state, { displayOnly: true }));
});

test('the actual visible overview timer refreshes only cache generations, with pending status and no chain/quote refresh', () => {
  let now = 1000, check, cacheRefreshes = 0, legacyRefreshes = 0;
  const state = { current: { pending: true, modal: true, inputModal: false, loading: false } };
  const doc = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  const cleanup = effect('if (!client || refreshIntervalMs', {
    client: {}, config: { displayOnly: true }, route: { route: 'overview' }, account: 'fixture', recordsPage: 0,
    refreshIntervalMs, pageRefreshDue, displayRefreshPageKey, displayRefreshPaused, refreshState: state,
    portfolioRead: { current: { busy: false } }, lastPageRefresh: { current: new Map() },
    Date: { now: () => now }, document: doc,
    window: { addEventListener() {}, removeEventListener() {} },
    setInterval: fn => { check = fn; return 1; }, clearInterval() {},
    setReceiptDisplayRefresh: () => cacheRefreshes++, setRefresh: () => legacyRefreshes++,
  });
  now = 15_999; check(); assert.equal(cacheRefreshes, 0);
  now = 16_000; check(); assert.equal(cacheRefreshes, 1);
  check(); assert.equal(cacheRefreshes, 1, 'Focus/timer at the same instant cannot duplicate the refresh.');
  state.current.loading = true; now = 31_000; check(); assert.equal(cacheRefreshes, 1);
  state.current.loading = false; doc.visibilityState = 'hidden'; check(); assert.equal(cacheRefreshes, 1);
  doc.visibilityState = 'visible'; check(); assert.equal(cacheRefreshes, 2);
  assert.equal(legacyRefreshes, 0, 'Cached overview refreshes cannot invalidate chain/quote readers.');
  cleanup();
});

test('the actual push callback invalidates display GETs and preserves an active input preview', () => {
  let handlers, refreshes = 0;
  const state = { current: { pending: true, modal: true, inputModal: false } };
  effect('if (!client || !boot.displayOnly)', {
    client: {}, boot: { displayOnly: true }, refreshState: state, displayRefreshPaused,
    automaticDisplayRefreshDue, lastPageRefresh: { current: new Map() }, displayRefreshPage: { current: 'overview-owner' },
    portfolioRead: { current: {} }, routeIdentity: { current: { route: 'overview' } }, recordsPageRef: { current: 0 },
    startDisplayUpdates: (_config, options) => { handlers = options; return () => {}; },
    setReceiptDisplayRefresh: () => refreshes++, setRefresh: () => assert.fail('Push must not refresh chain readers.'),
  });
  assert.equal(handlers.isPaused(), false); handlers.onUpdate(); assert.equal(refreshes, 1);
  state.current.inputModal = true; assert.equal(handlers.isPaused(), true);
});

test('the actual manual overview refresh works with a pending receipt and refuses overlapping reads', () => {
  const start = source.indexOf('      onClick={() => {', source.indexOf('  const refreshButton = ('));
  const end = source.indexOf('\n      }}\n      disabled=', start);
  assert(start > 0 && end > start);
  const code = source.slice(start + '      onClick={() => {'.length, end);
  let refreshes = 0;
  const state = { current: { loading: false } };
  const context = { boot: { status: 'ready', displayOnly: true }, route: { route: 'overview' }, account: 'fixture',
    refreshState: state, portfolioRead: { current: {} }, submissionLock: { current: null },
    lastPageRefresh: { current: new Map() },
    displayRefreshPageKey,
    setReceiptDisplayRefresh: () => refreshes++, setRefresh: () => assert.fail('Overview only uses cache GETs.'),
    setBootAttempt: () => assert.fail('A ready page does not rebootstrap.'),
    fetchLiveJson: () => assert.fail('No graph/RPC preflight on a cached refresh.'),
  };
  const click = new Function(...Object.keys(context), `return () => {${code}\n};`)(...Object.values(context));
  click(); assert.equal(refreshes, 1);
  state.current.loading = true; click(); assert.equal(refreshes, 1);
});

test('the actual positions effect paints old rows immediately, then replaces waiting purchase with the server Active row', async () => {
  const fixture = createLiveBrowserFixture(), owner = fixture.account.toLowerCase();
  const chainSource = { chainId: 56, factory: fixture.manifest.factory, market: fixture.manifest.shareMarket,
    displayOnly: true, indexedThrough: 101, indexedTimestamp: Math.floor(Date.now() / 1000) };
  const before = { items: [{ ...fixture.rows[0], state: 1n, totalSupply: 100n, shares: 51n }],
    marketBnbOwed: 0n, nextCursor: null, source: chainSource };
  const after = { ...before, items: [{ ...before.items[0], state: 2n, shareTradingAllowed: true }],
    source: { ...chainSource, indexedThrough: 102 } };
  let release, reads = 0;
  const client = { manifest: fixture.manifest, provider: { request: () => assert.fail('No RPC on overview refresh.') },
    readDisplayPositions: () => { reads++; return new Promise(resolve => { release = () => resolve(after); }); } };
  const readCache = { current: new WeakMap([[client, new Map([[`positions:${owner}`,
    { savedAt: Date.now() - 30_000, refresh: '0:0', result: before }]])]]) };
  const state = {};
  const context = { client, account: fixture.account, route: { route: 'overview' }, config: { displayOnly: true },
    displayRefreshKey: '0:0', readCache, positionsReadEpoch: { current: 0 },
    displayOnlySnapshot, displayListSnapshot, canReuseDisplayRead, viewPool,
    readPageSnapshot: () => null, displayStorage: () => null, writeDisplaySnapshot: () => true,
    READ_CANCELLED: Symbol('cancelled'), textError: e => e.message, invalidateDisplayOnReorg: () => {},
    retryReadRound: fn => Promise.resolve().then(fn),
  };
  for (const name of ['PositionsReadError', 'PositionsReadSource', 'Positions', 'PositionCursor', 'PositionsLoaded',
    'PositionsAccount', 'PositionsReadLoading', 'MarketCredit', 'Source']) context[`set${name}`] = value => { state[name] = value; };
  const cleanup = effect("if (!client || !['overview', 'rewards', 'governance', 'market'].includes", context);
  assert.equal(state.Positions[0].status, 'Funded'); assert.equal(state.Positions[0].shares, 51n);
  assert.equal(state.PositionsReadLoading, true);
  await turn(); assert.equal(reads, 1); release(); await turn();
  assert.equal(state.Positions[0].status, 'Active'); assert.equal(state.PositionsReadLoading, false);
  assert.equal(readCache.current.get(client).get(`positions:${owner}`).result, after);
  cleanup();
});

test('automatic cache generations do not invalidate cached governance or member RPC sections', async () => {
  const start = source.indexOf('  function readCachedSection('), end = source.indexOf('\n  useEffect(', start);
  const client = {}, cache = { current: new WeakMap() }; let reads = 0;
  const context = { config: { displayOnly: true }, refresh: 0, client, readCache: cache };
  const read = new Function(...Object.keys(context), source.slice(start, end) + '\nreturn readCachedSection;')(...Object.values(context));
  const chainReader = async () => { reads++; return 'chain-proof'; };
  assert.equal(await read('governance', chainReader), 'chain-proof');
  assert.equal(await read('governance', chainReader), 'chain-proof'); assert.equal(reads, 1);
  await read('activity', chainReader, { refreshToken: '0:0' });
  await read('activity', chainReader, { refreshToken: '0:1' }); assert.equal(reads, 3);
});

test('the actual members effect ignores display block advances after cache expiry but honors explicit refresh', async () => {
  const cacheStart = source.indexOf('  function readCachedSection(');
  const cacheEnd = source.indexOf('\n  useEffect(', cacheStart);
  const membersStart = source.indexOf('  async function readMembers()');
  const membersEnd = source.indexOf('  const heading =', membersStart);
  assert(cacheStart > 0 && cacheEnd > cacheStart && membersStart > 0 && membersEnd > membersStart);
  const body = source.slice(cacheStart, cacheEnd) + source.slice(membersStart, membersEnd);
  let now = 1_800_000_000_000, prior, rpcReads = 0;
  const pool = '0x' + 'aa'.repeat(20), factory = '0x' + 'bb'.repeat(20);
  const client = { provider: {}, manifest: {} };
  const state = {}, context = { client, config: { displayOnly: true, factory },
    route: { route: 'detail' }, detail: { pool }, detailTab: 'members',
    source: { indexedThrough: 100 }, loading: false, refresh: 0,
    readCache: { current: new WeakMap() }, Date: { now: () => now }, epoch: { current: 0 },
    readCurrentPoolMembers: async () => { rpcReads++; return { members: [factory], blockNumber: null }; },
    setMembers: value => { state.members = value; }, setMembersRead: value => { state.read = value; },
    textError: error => error.message,
    useEffect(fn, deps) {
      if (!prior || deps.some((value, index) => !Object.is(value, prior.deps[index]))) {
        prior?.cleanup?.(); prior = { deps, cleanup: fn() };
      }
    },
  };
  const render = changes => { Object.assign(context, changes);
    new Function(...Object.keys(context), body)(...Object.values(context)); };
  render(); await turn(); assert.equal(rpcReads, 1);
  now += 121_000;
  for (const indexedThrough of [101, 102, 103]) {
    render({ source: { indexedThrough } }); await turn();
  }
  assert.equal(rpcReads, 1, 'SSE block advances cannot initiate another activeMembers eth_call.');
  render({ refresh: 1 }); await turn();
  assert.equal(rpcReads, 2, 'A deliberate refresh still rereads current members.');
  render({ config: { displayOnly: false, factory }, source: { indexedThrough: 104 } }); await turn();
  assert.equal(rpcReads, 3, 'Legacy verified-chain mode still follows its indexed block.');
  prior?.cleanup?.();
});

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
  const scope = { displayReads: { current: new Set() }, ...context, useEffect: fn => { cleanup = fn(); } };
  new Function(...Object.keys(scope), source.slice(start, end))(...Object.values(scope));
  return cleanup;
}

function automaticRefreshFixture() {
  let now = 1000, check, stream, refreshes = 0, rewardRefreshes = 0, nextTimer = 0;
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
    setReceiptDisplayRefresh: () => refreshes++, setRefresh: () => {},
    setRewardsRefresh: update => { rewardRefreshes = update(rewardRefreshes); },
    displayReads: { current: new Set() }, pageCache: { current: new WeakMap() }, readCache: { current: new WeakMap() }, pageDisplayKey: () => 'fixture', marketTab: 'shares',
    submissionLock: { current: null }, setRecordsPage: () => {}, setBootAttempt: () => assert.fail('No rebootstrap.'),
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
    periodic: () => check(), count: () => refreshes, rewardCount: () => rewardRefreshes,
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
  f.advance(31_000); f.periodic(); f.periodic(); assert.equal(f.count(), 1);
  f.advance(31_010); f.push('after-periodic');
  f.advance(31_770); assert.equal(f.count(), 1, 'A push 760ms after the periodic read cannot duplicate GETs.');
  assert.equal(f.scheduled.size, 1, 'The latest dirty revision is retained for a later flush.');
  f.advance(35_000); f.push('newer-while-throttled');
  f.advance(61_759); assert.equal(f.count(), 1);
  f.advance(61_760); assert.equal(f.count(), 2, 'The coalesced latest push refreshes after the shared 30-second budget.');
  f.periodic(); assert.equal(f.count(), 2, 'A focus/timer at the push time uses the same budget.');
  assert.equal(f.scheduled.size, 0); f.close();
});

test('a push before the due timer records the shared timestamp and manual refresh remains immediate', () => {
  const f = automaticRefreshFixture();
  f.advance(31_000); f.push('before-timer'); f.advance(31_750); assert.equal(f.count(), 1);
  assert.equal(f.rewardCount(), 0, 'Push must leave the per-miner read revision unchanged.');
  f.periodic(); assert.equal(f.count(), 1, 'The due timer must observe the preceding push.');
  assert.equal(f.rewardCount(), 0);
  f.advance(32_000); f.manual(); assert.equal(f.count(), 2, 'Deliberate refresh bypasses automatic throttling.');
  assert.equal(f.rewardCount(), 1, 'Manual overview refresh must also refresh estimated rewards.');
  assert.equal(f.context.lastPageRefresh.current.get(f.context.displayRefreshPage.current), 32_000);
  f.push('after-manual'); f.advance(32_750); assert.equal(f.count(), 2);
  f.advance(62_750); assert.equal(f.count(), 3, 'A manual refresh delays but does not discard a later dirty event.');
  assert.equal(f.rewardCount(), 1, 'Later index/SSE events cannot start another per-miner read.');
  f.close();
});

test('automatic push throttling backs off after failure without discarding the dirty event', () => {
  const f = automaticRefreshFixture();
  f.advance(31_000); f.periodic(); f.context.refreshState.current.failed = true;
  f.advance(31_010); f.push('failed-then-updated');
  f.advance(151_759); assert.equal(f.count(), 1);
  f.advance(151_760); assert.equal(f.count(), 2, 'A failed page uses the same 120-second retry budget for push and timer.');
  f.periodic(); assert.equal(f.count(), 2); f.close();
});

test('one push stream follows the current page and wallet while each identity keeps its own budget', () => {
  const f = automaticRefreshFixture(), first = f.context.displayRefreshPage.current;
  f.advance(31_000); f.periodic(); assert.equal(f.count(), 1);
  const nextOwner = '0x' + 'bb'.repeat(20);
  f.navigate({ route: 'overview' }, nextOwner);
  const second = f.context.displayRefreshPage.current;
  assert.notEqual(first, second); assert.equal(f.context.lastPageRefresh.current.get(first), 31_000);
  f.push('wallet-changed'); f.advance(31_750); assert.equal(f.count(), 1);
  f.advance(61_750); assert.equal(f.count(), 2);
  assert.equal(f.context.lastPageRefresh.current.get(second), 61_750);
  f.navigate({ route: 'operator' });
  const operator = f.context.displayRefreshPage.current;
  f.push('operator-change'); f.advance(62_500); assert.equal(f.count(), 3, 'A route without periodic reads admits its first push.');
  assert.equal(f.context.lastPageRefresh.current.get(operator), 62_500);
  f.advance(62_510); f.push('newer-operator-change'); f.advance(63_260); assert.equal(f.count(), 3);
  f.advance(93_260); assert.equal(f.count(), 4, 'Routes without a timer still enforce the 30-second push interval.');
  f.close();
});

test('display cache reuse expires promptly while pending/result status does not suppress a materialized GET', () => {
  assert(canReuseDisplayRead({ savedAt: 1000, refresh: '0:1' }, '0:1', 30_999));
  assert(!canReuseDisplayRead({ savedAt: 1000, refresh: '0:1' }, '0:1', 31_000));
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
  now = 30_999; check(); assert.equal(cacheRefreshes, 0);
  now = 31_000; check(); assert.equal(cacheRefreshes, 1);
  check(); assert.equal(cacheRefreshes, 1, 'Focus/timer at the same instant cannot duplicate the refresh.');
  state.current.loading = true; now = 61_000; check(); assert.equal(cacheRefreshes, 1);
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
  let refreshes = 0, rewardRefreshes = 0;
  const state = { current: { loading: false } };
  const context = { boot: { status: 'ready', displayOnly: true }, route: { route: 'overview' }, account: 'fixture',
    refreshState: state, portfolioRead: { current: {} }, submissionLock: { current: null },
    displayReads: { current: new Set() }, pageCache: { current: new WeakMap() }, readCache: { current: new WeakMap() }, client: {}, marketTab: 'shares', pageDisplayKey: () => 'fixture',
    lastPageRefresh: { current: new Map() },
    displayRefreshPageKey,
    setReceiptDisplayRefresh: () => refreshes++, setRefresh: () => {},
    setRewardsRefresh: update => { rewardRefreshes = update(rewardRefreshes); },
    setRecordsPage: () => {}, setBootAttempt: () => assert.fail('A ready page does not rebootstrap.'),
    fetchLiveJson: () => assert.fail('No graph/RPC preflight on a cached refresh.'),
  };
  const click = new Function(...Object.keys(context), `return () => {${code}\n};`)(...Object.values(context));
  click(); assert.equal(refreshes, 1); assert.equal(rewardRefreshes, 1);
  state.current.loading = true; click(); assert.equal(refreshes, 1); assert.equal(rewardRefreshes, 1);
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
  const cleanup = effect("if (!client) return;\n    const personalPage", context);
  assert.equal(state.Positions[0].status, 'Funded'); assert.equal(state.Positions[0].shares, 51n);
  assert.equal(state.PositionsReadLoading, false, 'A cached background read does not disable claim controls.');
  await turn(); assert.equal(reads, 1); release(); await turn();
  assert.equal(state.Positions[0].status, 'Active'); assert.equal(state.PositionsReadLoading, false);
  assert.equal(readCache.current.get(client).get(`positions:${owner}`).result, after);
  cleanup();
});

test('home notices reuse personal cache for 60 seconds, honor manual refresh and never poll the paid node', async () => {
  const fixture = createLiveBrowserFixture(), owner = fixture.account.toLowerCase();
  const result = { items: fixture.rows, marketBnbOwed: 0n, nextCursor: null,
    source: { chainId: 56, factory: fixture.manifest.factory, market: fixture.manifest.shareMarket,
      displayOnly: true, indexedThrough: 101, indexedTimestamp: 1800000000 } };
  let reads = 0, now = Date.now();
  const client = { manifest: fixture.manifest, provider: { request: () => assert.fail('No node request for participant notices.') },
    readPositions: () => assert.fail('No per-pool fallback on the formal homepage.'),
    readDisplayPositions: async () => { reads++; return result; } };
  const state = {}, context = { client, account: fixture.account, positionsAccount: null,
    route: { route: 'home' }, config: { displayOnly: true }, displayRefreshKey: '0:0', Date: { now: () => now },
    readCache: { current: new WeakMap() }, positionsReadEpoch: { current: 0 },
    displayOnlySnapshot, displayListSnapshot, canReuseDisplayRead, viewPool,
    same: (a, b) => Boolean(a && b && a.toLowerCase() === b.toLowerCase()),
    readPageSnapshot: () => null, displayStorage: () => null, writeDisplaySnapshot: () => true,
    READ_CANCELLED: Symbol('cancelled'), textError: e => e.message, invalidateDisplayOnReorg: () => {},
    retryReadRound: fn => Promise.resolve().then(fn),
  };
  for (const name of ['PositionsReadError', 'PositionsReadSource', 'Positions', 'PositionCursor', 'PositionsLoaded',
    'PositionsAccount', 'PositionsReadLoading', 'MarketCredit', 'Source']) context[`set${name}`] = value => { state[name] = value; };
  let cleanup = effect("if (!client) return;\n    const personalPage", context);
  await turn(); assert.equal(reads, 1); assert.equal(state.PositionsAccount, fixture.account); assert.equal(state.Positions.length, result.items.length);
  cleanup(); context.positionsAccount = state.PositionsAccount;
  const firstSavedAt = context.readCache.current.get(client).get(`positions:${owner}`).savedAt;
  for (const [route, age] of [['home', 35_000], ['detail', 40_000], ['pools', 59_999]]) {
    now = firstSavedAt + age; context.route = { route }; context.displayRefreshKey = `0:${age}`;
    cleanup = effect("if (!client) return;\n    const personalPage", context); await turn();
    assert.equal(reads, 1, 'Receipt/push opportunities reuse the first cache GET for at most 60 seconds.');
    assert.equal(state.PositionsReadSource.stale, true); cleanup();
  }
  now = firstSavedAt + 60_000; context.route = { route: 'home' }; context.displayRefreshKey = '0:60000';
  cleanup = effect("if (!client) return;\n    const personalPage", context); await turn();
  assert.equal(reads, 2, 'An existing display refresh rechecks the cached positions at exactly 60 seconds.'); cleanup();
  now++; context.displayRefreshKey = '1:60000';
  cleanup = effect("if (!client) return;\n    const personalPage", context); await turn();
  assert.equal(reads, 3, 'A manual refresh generation bypasses the 60-second reuse window immediately.'); cleanup();
  context.displayRefreshKey = '1:60001';
  cleanup = effect("if (!client) return;\n    const personalPage", context); await turn();
  assert.equal(reads, 3, 'A following receipt/push does not duplicate the manual cache GET.'); cleanup();
  context.account = null; context.positionsAccount = fixture.account;
  effect("if (!client) return;\n    const personalPage", context);
  assert.deepEqual(state.Positions, []); assert.equal(state.PositionsAccount, null);
});

test('the notifications route cannot introduce legacy per-pool RPC reads when the display cache endpoint is unavailable', () => {
  let reads = 0;
  for (const displayOnly of [false, true]) {
    const context = { client: { readPositions: () => { reads++; } }, account: '0x' + 'ab'.repeat(20),
      route: { route: 'notifications' }, config: { displayOnly }, displayRefreshKey: '0:0' };
    effect("if (!client) return;\n    const personalPage", context);
  }
  assert.equal(reads, 0);
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


test('a same-account detail refresh preserves its mounted data, preview, action epoch and controls until the GET resolves', async () => {
  const fixture = createLiveBrowserFixture(), owner = fixture.account;
  const before = { detail: { item: fixture.rows[0], source: { chainId: 56, factory: fixture.manifest.factory,
    market: fixture.manifest.shareMarket, displayOnly: true, indexedThrough: 101, indexedTimestamp: 1000 } } };
  const route = { route: 'detail', pool: fixture.rows[0].pool }, pageKey = 'detail-owner';
  const state = { LoadedRoute: `detail/${route.pool}`, LoadedAccount: owner, Loading: false,
    Prepared: { action: 'deposit', quantity: '17' }, DetailPreview: { selected: true }, Detail: viewPool(before.detail.item) };
  let release, reads = 0;
  const client = { manifest: fixture.manifest };
  const refs = { epoch: { current: 77 }, pageReadEpoch: { current: 0 }, displayReads: { current: new Set() },
    pageCache: { current: new WeakMap([[client, new Map([[pageKey, { savedAt: Date.now(), refresh: '0:0', result: before }]])]]) } };
  const context = { ...refs, client, route, account: owner, marketTab: 'whole', config: { displayOnly: true },
    loadedRoute: state.LoadedRoute, loadedAccount: owner, displayRefreshKey: '0:1',
    pageDisplayKey: () => pageKey, displayOnlySnapshot, canReuseDisplayRead, viewPool,
    same: (a,b) => a?.toLowerCase() === b?.toLowerCase(), positionsAccount: owner, positions: [],
    readPageSnapshot: () => null, readPoolDisplaySnapshot: () => null, displayStorage: () => null,
    publishedProjects: { current: [] }, mergePublishedProjects: rows => rows,
    writeDisplaySnapshot() {}, writePoolDisplaySnapshots() {},
    READ_CANCELLED: Symbol('cancel'), ZeroAddress: '0x' + '0'.repeat(40), textError: problem => problem.message,
    invalidateDisplayOnReorg: () => assert.fail('Ordinary display success is not a reorg.'),
    readPageRound: async () => { reads++; return new Promise(resolve => { release = resolve; }); },
    retryReadRound: (read, options) => { options.onAttempt({ attempt: 1 }); return Promise.resolve().then(read); },
  };
  for (const name of ['LoadedRoute','LoadedAccount','Loading','Revalidating','Prepared','DetailPreview','Detail','Source',
    'ReadRetry','ReadFailed','CachedPage','Error','Pools','PoolCursor','Governance','GovernanceProof','Members','MembersRead','YieldData'])
    context[`set${name}`] = value => { state[name] = value; };
  const cleanup = effect("if (!client) return;\n    if (route.route === 'notifications')", context);
  assert.equal(state.LoadedAccount, owner); assert.equal(state.LoadedRoute, `detail/${route.pool}`);
  assert.equal(state.Loading, false); assert.deepEqual(state.Prepared, { action: 'deposit', quantity: '17' });
  assert.deepEqual(state.DetailPreview, { selected: true }); assert.equal(refs.epoch.current, 77);
  assert.equal(refs.displayReads.current.size, 1, 'A slow silent GET owns the automatic/manual concurrency budget.');
  await turn(); assert.equal(reads, 1);
  release(before); await turn();
  assert.equal(refs.displayReads.current.size, 0); assert.equal(state.ReadFailed, false);
  assert.equal(refs.epoch.current, 77, 'An explicit members read keeps its action epoch across a block refresh.');
  cleanup(); assert.equal(refs.epoch.current, 77);
});

test('a real client/deployment switch retires action and members work, independently of display ticks', () => {
  const epoch = { current: 4 };
  const cleanup = effect('// Only a real client, wallet account or page identity change retires user-action and members reads.',
    { epoch, client: {}, account:'owner', route:{ route:'detail', pool:'pool' } });
  assert.equal(epoch.current, 5); cleanup(); assert.equal(epoch.current, 6);
});

test('a slow displayed GET pauses timer, dirty SSE and manual refresh until that owned read finishes', () => {
  const f = automaticRefreshFixture(), ticket = {};
  f.context.displayReads.current.add(ticket);
  f.advance(31_000); f.periodic(); f.push('slow-read'); f.advance(35_000); f.manual();
  assert.equal(f.count(), 0); assert.equal(f.rewardCount(), 0);
  f.context.displayReads.current.delete(ticket);
  f.advance(36_250); assert.equal(f.count(), 1, 'The coalesced push resumes after the slow GET releases its lock.');
  f.periodic(); assert.equal(f.count(), 1); f.close();
});

test('a home stats read releases its shared lock on success and on failure so the next 30-second tick can run', async () => {
  for (const failed of [false, true]) {
    const client = { manifest: {} }, displayReads = { current: new Set() }, state = {};
    let release;
    const context = { client, route: { route: 'home' }, config: { displayOnly: true },
      displayRefreshKey: '0:1', readCache: { current: new WeakMap() }, displayReads,
      readPageSnapshot: () => null, displayStorage: () => null, displayOnlySnapshot, canReuseDisplayRead,
      READ_CANCELLED: Symbol('cancel'), writeDisplaySnapshot() {}, invalidateDisplayOnReorg() {}, textError: e => e.message,
      retryReadRound: read => Promise.resolve().then(read) };
    client.readDisplayStats = () => new Promise((resolve, reject) => { release = failed
      ? () => reject(new Error('temporarily unavailable')) : () => resolve({ data: { total: 2 }, source: {} }); });
    for (const name of ['Stats','StatsSource','StatsReadError']) context[`set${name}`] = value => { state[name] = value; };
    const cleanup = effect("if (!client || route.route !== 'home') return;", context);
    assert.equal(displayReads.current.size, 1); await turn(); release(); await turn();
    assert.equal(displayReads.current.size, 0, 'Every terminal path releases its own lock.');
    assert.equal(displayRefreshPaused({}, { displayOnly: true, displayReading: displayReads.current.size > 0 }), false);
    cleanup();
  }
});

test('expanded personal pages stay pinned only while the same account still owns that displayed window', async () => {
  const fixture = createLiveBrowserFixture(), owner = fixture.account, row = fixture.rows[0];
  const client = { manifest: fixture.manifest }, state = {}, memory = { expanded: true, savedAt: Date.now(),
    refresh: '0:0', result: { items: [row], nextCursor: 'old-cursor', marketBnbOwed: 0n, source: {} } };
  let reads = 0;
  client.readDisplayPositions = async () => { reads++; return memory.result; };
  const context = { client, account: owner, route: { route: 'overview' }, config: { displayOnly: true },
    positionsAccount: owner, positions: [row, row], same: (a,b) => a?.toLowerCase() === b?.toLowerCase(),
    displayRefreshKey: '0:1', readCache: { current: new WeakMap([[client,new Map([[`positions:${owner.toLowerCase()}`,memory]])]]) },
    positionsReadEpoch: { current: 0 }, displayReads: { current: new Set() }, displayListSnapshot, viewPool,
    displayOnlySnapshot: value => value, readPageSnapshot: () => null, displayStorage: () => null,
    canReuseDisplayRead, READ_CANCELLED: Symbol('cancel'), writeDisplaySnapshot() {},
    invalidateDisplayOnReorg() {}, textError: e => e.message, retryReadRound: read => Promise.resolve().then(read) };
  for (const name of ['PositionsReadError','PositionsReadSource','Positions','PositionCursor','PositionsLoaded',
    'PositionsAccount','PositionsReadLoading','MarketCredit','Source']) context[`set${name}`] = value => { state[name] = value; };
  const pinned = effect("if (!client) return;\n    const personalPage", context); await turn();
  assert.equal(reads, 0); assert.equal(state.Positions, undefined); pinned?.();
  assert.equal(context.positionsReadEpoch.current, 0, 'Deferring a display tick preserves any already-started next-page read.');
  context.displayRefreshKey = '1:1';
  const settled = effect("if (!client) return;\n    const personalPage", context); await turn();
  assert.equal(reads, 1, 'A confirmed transaction generation must reload balances even on an expanded window.');
  const settledRevision = context.positionsReadEpoch.current; settled?.();
  assert.equal(context.positionsReadEpoch.current, settledRevision, 'Completed display cleanup does not cancel later pagination.');
  // A -> B -> A clears the visible account, even though A's historical cache is still expanded.
  context.positionsAccount = null; context.positions = [];
  const restored = effect("if (!client) return;\n    const personalPage", context); await turn();
  assert.equal(reads, 1, 'Returning to this account may restore its now-current first page without another GET.');
  assert.equal(state.PositionsAccount, owner); assert.equal(state.Positions.length, 1);
  restored?.();
});

test('an expanded orders cache cannot keep the prior tab orders under a new tab identity', async () => {
  const owner = '0x' + 'aa'.repeat(20), client = { manifest: {} }, state = {};
  const result = { items: [{ id: 'mine' }], source: {}, nextCursor: null };
  client.readDisplayOrders = async () => result;
  const context = { client, account: owner, route: { route: 'market' }, config: { displayOnly: true },
    marketTab: 'mine', marketOrderIdentity: 'shares:', orders: [{ id:'active' },{ id:'active2' }], displayRefreshKey: '0:1',
    marketOrdersEpoch: { current: 0 }, displayReads: { current: new Set() },
    readCache: { current: new WeakMap([[client,new Map([[`orders:${owner}`, { savedAt: Date.now(), expanded: true, refresh:'0:0', result }]])]]) },
    displayListSnapshot, displayOnlySnapshot: value => value, readPageSnapshot: () => null, displayStorage: () => null,
    canReuseDisplayRead, READ_CANCELLED: Symbol('cancel'), writeDisplaySnapshot() {},
    invalidateDisplayOnReorg() {}, textError: e => e.message, retryReadRound: read => Promise.resolve().then(read) };
  for (const name of ['MarketOrdersError','MarketOrderSource','MarketOrderIdentity','Orders','OrderCursor','MarketOrdersLoading'])
    context[`set${name}`] = value => { state[name] = value; };
  const cleanup = effect("if (!client || route.route !== 'market') return;", context); await turn();
  assert.deepEqual(state.Orders, [{ id:'mine' }]); assert.equal(state.MarketOrderIdentity, `mine:${owner}`); cleanup();
});

test('detail records keep a later page during automatic ticks and a first-page silent read owns a lock without disabling controls', async () => {
  const pool='0x'+'11'.repeat(20),client={manifest:{}},result={items:[{id:'record'}],nextCursor:null,source:{displayOnly:true}};
  const context={client,route:{route:'detail',pool},account:'owner',detail:{},loading:false,config:{displayOnly:true},
    displayRefreshKey:'0:1',recordsPageRef:{current:2},loadedRoute:`detail/${pool}`,loadedAccount:'owner',activityReadEpoch:{current:7},displayReads:{current:new Set()},
    readCache:{current:new WeakMap([[client,new Map([[`pool-activity:${pool}`,{savedAt:Date.now(),refresh:'0:0',result}]])]])},
    displayOnlySnapshot:value=>value,readPageSnapshot:()=>null,displayStorage:()=>null,writeDisplaySnapshot(){},
    invalidateDisplayOnReorg:()=>assert.fail('No reorg'),textError:error=>error.message};
  let reads=0,release;const state={ActivityReadLoading:false,Activity:[{id:'later-page-record'}]};
  context.readCachedSection=()=>{reads++;return new Promise(resolve=>{release=()=>resolve(result);});};
  for(const name of ['ActivityReadError','ActivityReadLoading','Activity','ActivityCursor','ActivityReadSource','ActivityTotals'])
    context[`set${name}`]=value=>{state[name]=value;};
  const marker="if (!client || route.route !== 'detail' || !route.pool || !detail || loading) return;\n    let cancelled = false;\n    const pool = route.pool;\n    const activityKey";
  effect(marker,context);assert.equal(reads,0);assert.deepEqual(state.Activity,[{id:'later-page-record'}]);
  assert.equal(context.activityReadEpoch.current,7,'An auto display tick cannot retire an active later-page records read.');
  context.recordsPageRef.current=0;const cleanup=effect(marker,context);
  assert.equal(reads,1);assert.equal(state.ActivityReadLoading,false);assert.equal(context.displayReads.current.size,1);
  release();await turn();assert.equal(context.displayReads.current.size,0);assert.deepEqual(state.Activity,result.items);
  const finishedRevision=context.activityReadEpoch.current;cleanup();assert.equal(context.activityReadEpoch.current,finishedRevision);
});

test('activity page deferral belongs only to the same loaded account and client cache identity', async () => {
  const owner='0x'+'aa'.repeat(20),client={manifest:{}},result={items:[{id:'latest'}],nextCursor:null,source:{displayOnly:true}};
  let reads=0;
  const context={client,config:{displayOnly:true},account:owner,route:{route:'overview'},loadedRoute:'overview',loadedAccount:owner,
    recordsPageRef:{current:2},displayRefreshKey:'0:1',activityReadEpoch:{current:0},displayReads:{current:new Set()},
    readCache:{current:new WeakMap([[client,new Map([[`activity:${owner}`,{savedAt:Date.now(),refresh:'0:0',result}]])]])},
    displayListSnapshot,displayOnlySnapshot:value=>value,readPageSnapshot:()=>null,displayStorage:()=>null,writeDisplaySnapshot(){},
    canReuseDisplayRead,READ_CANCELLED:Symbol('cancel'),textError:error=>error.message,invalidateDisplayOnReorg(){},
    retryReadRound:read=>Promise.resolve().then(read)};
  const state={Activity:[{id:'page-two'}],ActivityTotals:{totalCount:40}};
  for(const name of ['RecordsPage','ActivityReadError','ActivityTotals','Activity','ActivityCursor','ActivityReadLoading','ActivityReadSource','Source'])
    context[`set${name}`]=value=>{state[name]=value;};
  client.readActivity=async()=>{reads++;return result;};
  const marker="if (!client || !['records', 'overview', 'rewards'].includes(route.route)) return;";
  const pinned=effect(marker,context);await turn();assert.equal(reads,0);assert.equal(state.Activity[0].id,'page-two');
  assert.deepEqual(state.ActivityTotals,{totalCount:40});pinned?.();
  assert.equal(context.activityReadEpoch.current,0,'A deferred page-two tick never cancels later-page reads.');
  context.account='0x'+'bb'.repeat(20);
  const switched=effect(marker,context);await turn();assert.equal(reads,1,'A new account reads immediately, before page-reset rerender.');switched?.();
  const nextClient={manifest:{},readActivity:client.readActivity};
  context.client=nextClient;context.loadedAccount=context.account;
  const graphChanged=effect(marker,context);await turn();assert.equal(reads,2,'A new client/deployment never inherits old client page deferral.');graphChanged?.();
});

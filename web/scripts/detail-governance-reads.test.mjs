import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { ZeroAddress } from 'ethers';
import { loadBindings, transform } from 'next/dist/build/swc/index.js';
import * as capacity from '../lib/capacity-input.mjs';
import { displayOnlySnapshot } from '../lib/display-snapshot.mjs';

const require = createRequire(import.meta.url);
await loadBindings();
const platform = await readFile(new URL('../components/LivePlatform.jsx', import.meta.url), 'utf8');
const cacheStart = platform.indexOf('  function readCachedSection(');
const effectEnd = platform.indexOf('  useEffect(() => { setRecordsPage', cacheStart);
const callbackStart = platform.indexOf('  function renderGovernance()');
const callbackEnd = platform.indexOf('  const pageSource =', callbackStart);
assert(cacheStart >= 0 && effectEnd > cacheStart && callbackStart >= 0 && callbackEnd > callbackStart);
const contextNames = ['useEffect', 'client', 'config', 'route', 'detail', 'loading', 'account', 'ZeroAddress',
  'activityReadEpoch', 'readCache', 'displayRefreshKey', 'displayStorage', 'readPageSnapshot', 'writeDisplaySnapshot',
  'Date', 'recordsPageRef', 'loadedRoute', 'loadedAccount', 'displayReads', 'displayOnlySnapshot',
  'invalidateDisplayOnReorg', 'textError', 'setGovernance', 'setGovernanceProof', 'setActivityReadError',
  'setActivityReadLoading', 'setActivity', 'setActivityCursor', 'setActivityReadSource', 'setActivityTotals',
  'detailTab', 'LiveGovernance', 'currentPoolQuote', 'wallet', 'refresh', 'busy', 'pending', 'connect',
  'setError', 'same', 'setDetail', 'sendGovernanceAction'];
const compile = async (source, filename) => (await transform(source, { filename,
  jsc: { parser: { syntax: 'ecmascript', jsx: true }, target: 'es2022',
    transform: { react: { runtime: 'automatic' } } }, module: { type: 'commonjs' },
})).code;
const probeCode = await compile(`export default function probe(context) {
  const { ${contextNames.join(', ')} } = context;
  ${platform.slice(cacheStart, effectEnd)}
  ${platform.slice(callbackStart, callbackEnd)}
  return renderGovernance;
}`, 'LivePlatform-detail-sections.jsx');
const exported = { exports: {} };
new Function('require', 'module', 'exports', probeCode)(require, exported, exported.exports);
const probe = exported.exports.default;
const childCode = await compile(await readFile(new URL('../components/LiveGovernance.jsx', import.meta.url), 'utf8'),
  'LiveGovernance.jsx');
const turn = () => new Promise(resolve => setImmediate(resolve));
const pool = '0x' + 'aa'.repeat(20), owner = '0x' + 'bb'.repeat(20), factory = '0x' + 'cc'.repeat(20);
const shareMarket = '0x' + 'dd'.repeat(20);
const config = { factory, shareMarket, stage: 'fresh-active', displayOnly: true, testProfile: false };

function detailSections({ status = 'Active', tab = 'asset', account = owner } = {}) {
  const state = {}, reads = { governance: [], activity: [] }, writes = [];
  const readCache = { current: new WeakMap() }, effects = [];
  const previous = [];
  let context, renderGovernance, effectIndex = 0, clockNow = 1_800_000_000_000;
  const data = { pool, account: account || ZeroAddress, salePrice: 40_000_000_000_000_000n };
  const result = { data, source: { readMode: 'current', stale: false } };
  const client = { manifest: {}, provider: {},
    async readGovernance(options) { reads.governance.push(options); return result; },
    async readActivity(options) { reads.activity.push(options); return { items: [], nextCursor: null,
      source: result.source, totalCount: 0, overviewTotalCount: 0 }; },
  };
  context = { client, config, route: { route: 'detail', pool }, detail: { pool, status, shares: 50n },
    detailTab: tab, loading: false, account, ZeroAddress, activityReadEpoch: { current: 0 }, readCache,
    displayRefreshKey: 0, refresh: 0, displayStorage: () => null, readPageSnapshot: () => null,
    recordsPageRef: { current: 0 }, loadedRoute: `detail/${pool}`, loadedAccount: account,
    displayReads: { current: new Set() }, displayOnlySnapshot,
    Date: { now: () => clockNow },
    writeDisplaySnapshot: (...args) => writes.push(args), invalidateDisplayOnReorg: () => {}, textError: e => e.message,
    LiveGovernance: () => null, currentPoolQuote: () => null, wallet: null, busy: false, pending: null,
    connect: () => assert.fail('No wallet connection is needed for display reads'),
    sendGovernanceAction: () => assert.fail('No transaction is sent by display reads'),
    same: (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase(),
    useEffect(fn, deps) {
      const at = effectIndex++, prior = previous[at];
      if (!prior || deps.some((dep, index) => !Object.is(dep, prior.deps[index]))) {
        effects.push(() => { prior?.cleanup?.(); previous[at] = { deps, cleanup: fn() }; });
      }
    },
  };
  for (const key of ['Governance', 'GovernanceProof', 'ActivityReadError', 'ActivityReadLoading', 'Activity',
    'ActivityCursor', 'ActivityReadSource', 'ActivityTotals', 'Error', 'Detail']) {
    const name = key[0].toLowerCase() + key.slice(1);
    context['set' + key] = value => {
      state[name] = typeof value === 'function' ? value(name === 'detail' ? context.detail : state[name]) : value;
      if (name === 'detail') context.detail = state.detail;
    };
  }
  const render = updates => {
    Object.assign(context, updates); effectIndex = 0; renderGovernance = probe(context);
    while (effects.length) effects.shift()();
  };
  const settle = async () => { for (let i = 0; i < 4; i++) await turn(); };
  render();
  return { state, reads, writes, context, result, render, settle,
    advance: duration => { clockNow += duration; },
    childProps: () => renderGovernance().props.children.props,
    cache: () => readCache.current.get(client), dispose: () => previous.forEach(entry => entry?.cleanup?.()) };
}

test('ordinary Funding, Funded and Active detail tabs do not request unused governance snapshots', async () => {
  for (const status of ['Funding', 'Funded', 'Active']) {
    for (const tab of ['asset', 'records', 'members']) {
      const ui = detailSections({ status, tab });
      try {
        await ui.settle();
        assert.equal(ui.reads.governance.length, 0, `${status}/${tab} has no governance price consumer`);
        assert.equal(ui.reads.activity.length, 1, 'Activity loading remains independent');
        assert.equal(ui.state.activityReadLoading, false);
      } finally { ui.dispose(); }
    }
  }
});

test('Listed detail still fetches its sale price, binds it to the owner and reuses the result', async () => {
  for (const account of [owner, null]) {
    const ui = detailSections({ status: 'Listed', account });
    try {
      await ui.settle();
      assert.deepEqual(ui.reads.governance, [{ pool, account: account || ZeroAddress }]);
      assert.equal(ui.state.governance.salePrice, ui.result.data.salePrice);
      assert.deepEqual(ui.state.governanceProof, { pool, account: account || ZeroAddress, source: ui.result.source });
      ui.render({ detailTab: 'records' }); await ui.settle();
      assert.equal(ui.reads.governance.length, 1, 'Moving between ordinary tabs reuses the price snapshot');
      assert.equal(ui.reads.activity.length, 1);
    } finally { ui.dispose(); }
  }
});

test('a refreshed Active detail becoming Listed triggers the needed sale-price read without a page reload', async () => {
  const ui = detailSections();
  try {
    await ui.settle(); assert.equal(ui.reads.governance.length, 0);
    ui.render({ detail: { ...ui.context.detail, status: 'Listed' } }); await ui.settle();
    assert.equal(ui.reads.governance.length, 1);
    assert.equal(ui.state.governance.salePrice, ui.result.data.salePrice);
    assert.equal(ui.state.governanceProof.pool, pool);
    assert.equal(ui.reads.activity.length, 1);
  } finally { ui.dispose(); }
});

test('many display generations past the old two-minute TTL refresh activity without rereading listed governance', async () => {
  const ui = detailSections({ status: 'Listed' });
  try {
    await ui.settle(); assert.equal(ui.reads.governance.length, 1); assert.equal(ui.reads.activity.length, 1);
    ui.advance(121_000);
    for (const generation of ['0:1', '0:2', '0:3']) {
      ui.render({ detail: { ...ui.context.detail }, displayRefreshKey: generation });
      await ui.settle();
    }
    assert.equal(ui.reads.activity.length, 4, 'The visible activity GET follows the display generation.');
    assert.equal(ui.reads.governance.length, 1, 'The old governance TTL cannot cause an SSE-triggered eth_call.');
    ui.render({ refresh: 1 }); await ui.settle();
    assert.equal(ui.reads.governance.length, 2, 'An explicit refresh still rereads the Listed price.');
    assert.equal(ui.reads.activity.length, 4);
  } finally { ui.dispose(); }
});

test('the actual vote component owns its read and its real parent callback supplies the Listed price cache', async () => {
  const ui = detailSections({ status: 'Listed', tab: 'vote' });
  const slots = [], effects = [], childReads = []; let position = 0;
  const hooks = {
    useState(initial) {
      const at = position++; if (!slots[at]) slots[at] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[at].value, value => { slots[at].value = typeof value === 'function' ? value(slots[at].value) : value; }];
    },
    useRef(initial) { const at = position++; return slots[at] ??= { current: initial }; },
    useEffect(fn, deps) {
      const at = position++, prior = slots[at];
      if (!prior || deps.some((dep, index) => !Object.is(dep, prior.deps[index])))
        effects.push(() => { prior?.cleanup?.(); slots[at] = { deps, cleanup: fn() }; });
    },
  };
  const snapshot = { pool, account: owner, factory, shareMarket, stage: config.stage, displayOnly: true,
    testProfile: false, state: 3n, timestamp: 1_700_000_000n, activatedAt: 1_600_000_000n, shares: 50n,
    snapshotShares: 0n, purchaseCost: 40_400_000_000_000_000n, candidates: [], activeProposalId: 0n,
    listedProposalId: 0n, salePrice: ui.result.data.salePrice, saleReference: { available: false } };
  const child = { exports: {} };
  const modules = { react: hooks, '../lib/capacity-input.mjs': capacity, '../app/live-governance.css': {}, './LiveGovernanceLayout.css': {},
    './FirstoSaleReferenceAction': { __esModule: true, default: () => null },
    '../lib/live-governance.mjs': {
      readGovernanceSnapshot: async (_provider, options) => { childReads.push(options); return snapshot; },
      prepareGovernanceAction: () => assert.fail('No action is prepared by an initial vote view'),
    } };
  new Function('require', 'module', 'exports', childCode)(name => modules[name] ?? require(name), child, child.exports);
  const renderChild = () => {
    position = 0; child.exports.default(ui.childProps()); while (effects.length) effects.shift()();
  };
  try {
    await ui.settle(); assert.equal(ui.reads.governance.length, 0, 'The parent never duplicates the vote reader');
    renderChild(); await ui.settle(); renderChild();
    assert.equal(childReads.length, 1);
    assert.equal(childReads[0].pool.toLowerCase(), pool);
    assert.equal(childReads[0].account, owner);
    assert.equal(ui.state.governance, snapshot, 'The production onSnapshot callback accepts the actual child result');
    assert.deepEqual(ui.state.governanceProof, { pool, account: owner, source: null, displayOnly: true });
    ui.render({ detailTab: 'asset' }); await ui.settle();
    assert.equal(ui.state.governance.salePrice, snapshot.salePrice);
    assert.equal(ui.reads.governance.length, 0, 'Returning to the Listed price card reuses the vote snapshot');
    assert.equal(ui.cache().get(`pool-governance:${pool}:${owner}`).result.data, snapshot);
  } finally { for (const slot of slots) slot?.cleanup?.(); ui.dispose(); }
});

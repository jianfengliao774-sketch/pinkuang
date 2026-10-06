import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { transform, loadBindings } from 'next/dist/build/swc/index.js';

const require = createRequire(import.meta.url);
const turn = () => new Promise(resolve => setImmediate(resolve));
const address = digit => `0x${digit.repeat(40)}`;

async function portfolioUi(readPortfolioPage) {
  await loadBindings();
  const code = (await transform(await readFile(new URL('../components/LivePortfolios.jsx', import.meta.url), 'utf8'), {
    filename: 'LivePortfolios.jsx', jsc: { parser: { syntax: 'ecmascript', jsx: true }, target: 'es2022',
      transform: { react: { runtime: 'automatic' } } }, module: { type: 'commonjs' },
  })).code;
  let active;
  const hooks = {
    useState(initial) { const instance = active, at = instance.position++;
      if (!instance.slots[at]) instance.slots[at] = { value: typeof initial === 'function' ? initial() : initial };
      return [instance.slots[at].value, value => { if (!instance.disposed)
        instance.slots[at].value = typeof value === 'function' ? value(instance.slots[at].value) : value; }]; },
    useRef(initial) { const instance = active, at = instance.position++; return instance.slots[at] ??= { current: initial }; },
    useEffect(fn, deps) { const instance = active, at = instance.position++, previous = instance.slots[at];
      if (!previous || deps.some((value, index) => value !== previous.deps[index]))
        instance.effects.push(() => { previous?.cleanup?.(); instance.slots[at] = { deps, cleanup: fn() }; }); },
  };
  const modules = {
    react: hooks,
    '../lib/live-portfolios.mjs': { portfolioPageActionReady: () => false, portfolioCreateActionReady: () => false,
      portfolioSelectedActionReady: () => false, portfolioOrderActionReady: () => false,
      readPortfolioPage, readPortfolioDisplayRow: () => assert.fail('Overview must not start a detail read.') },
    '../lib/display-snapshot.mjs': { readDisplaySnapshot: () => null,
      displayOnlySnapshot: result => ({ ...result, source: { ...result.source, stale: true, transactionReady: false } }),
      writeDisplaySnapshot: () => true },
    './LivePortfolios.css': {},
  };
  for (const name of ['./LiveYieldChart', './ActivityOperation', './PortfolioCapacity', './BudgetPurchaseQueue'])
    modules[name] = { __esModule: true, default: () => null };
  const exported = { exports: {} };
  new Function('require', 'module', 'exports', 'window', code)(name => modules[name] ?? require(name),
    exported, exported.exports, { sessionStorage: {} });
  const Component = exported.exports.default;
  const provider = { request: () => assert.fail('A displayed overview must not read wallet or RPC state.') };
  const config = { kind: 'integrated-v2', productFamily: 'fresh-v4', displayOnly: true,
    artifactDigest: 'cache-ui-fixture', stage: 'fresh-active', factory: address('a'),
    portfolioFactory: address('b'), portfolioMarket: address('c') };
  function mount({ generation = '0:0', account = address('d') } = {}) {
    const instance = { slots: [], effects: [], position: 0, disposed: false, latest: null };
    const props = { config, provider, account, locale: 'zh', mode: 'overview',
      refreshKey: 0, displayRefreshKey: generation,
      renderDirectory: value => { instance.latest = value; return null; } };
    instance.render = () => { active = instance; instance.position = 0; Component(props); active = null;
      while (instance.effects.length) instance.effects.shift()(); };
    instance.settle = async () => { await turn(); instance.render(); await turn(); instance.render(); };
    instance.unmount = () => { for (const slot of instance.slots) slot?.cleanup?.(); instance.disposed = true; };
    instance.render(); return instance;
  }
  return { mount, provider, config };
}

test('the overview paints its previous verified rows while a new generation refreshes in the background', async () => {
  const oldNow = Date.now; let now = 1_800_000_000_000;
  Date.now = () => now;
  try {
    const firstRow = { pool: address('1') }, nextRow = { pool: address('2') };
    const source = { displayOnly: true, indexedThrough: 100 };
    let release, reads = 0;
    const ui = await portfolioUi(async () => {
      reads++;
      if (reads === 1) return { items: [firstRow], nextCursor: null, source, operator: null };
      if (reads === 2) return new Promise(resolve => { release = () => resolve({ items: [nextRow], nextCursor: null,
        source: { ...source, indexedThrough: 101 }, operator: null }); });
      return { items: [nextRow], nextCursor: null, source, operator: null };
    });
    const first = ui.mount(); await first.settle();
    assert.equal(reads, 1); assert.deepEqual(first.latest.rows, [firstRow]); first.unmount();

    const refreshed = ui.mount({ generation: '0:1' }); await refreshed.settle();
    assert.equal(reads, 2); assert.deepEqual(refreshed.latest.rows, [firstRow]);
    assert.equal(refreshed.latest.loaded, true); assert.equal(refreshed.latest.loading, true);
    assert.equal(refreshed.latest.current, false, 'Cached display does not grant a current page read.');
    refreshed.render(); await turn(); assert.equal(reads, 2, 'Re-rendering cannot start a parallel copy.');
    release(); await refreshed.settle();
    assert.deepEqual(refreshed.latest.rows, [nextRow]); assert.equal(refreshed.latest.loading, false);
    refreshed.unmount();

    const sameGeneration = ui.mount({ generation: '0:1' }); await sameGeneration.settle();
    assert.equal(reads, 2, 'A just completed visible page is reused within the short GET cadence.');
    sameGeneration.unmount();

    now += 15_001;
    const older = ui.mount({ generation: '0:1' }); await older.settle();
    assert.deepEqual(older.latest.rows, [nextRow]); assert.equal(reads, 3);
    older.unmount();
  } finally { Date.now = oldNow; }
});

test('two visible mounts share one in-flight overview read for the same provider and wallet', async () => {
  let release, reads = 0;
  const ui = await portfolioUi(async () => { reads++; return new Promise(resolve => { release = () => resolve({
    items: [{ pool: address('1') }], nextCursor: null, operator: null,
    source: { displayOnly: true, indexedThrough: 100 },
  }); }); });
  const first = ui.mount(), second = ui.mount();
  await turn(); first.render(); second.render();
  assert.equal(reads, 1, 'The concurrent page mounts share the existing GET.');
  release(); await first.settle(); await second.settle();
  assert.equal(first.latest.rows.length, 1); assert.equal(second.latest.rows.length, 1);
  first.unmount(); second.unmount();
});

test('a wallet switch cannot paint or share the prior account overview', async () => {
  let release, reads = 0;
  const ui = await portfolioUi(async () => {
    reads++;
    if (reads === 1) return { items: [{ pool: address('1') }], nextCursor: null, operator: null,
      source: { displayOnly: true, indexedThrough: 100 } };
    return new Promise(resolve => { release = () => resolve({ items: [], nextCursor: null, operator: null,
      source: { displayOnly: true, indexedThrough: 101 } }); });
  });
  const owner = ui.mount({ account: address('d') }); await owner.settle(); owner.unmount();
  const other = ui.mount({ account: address('e') }); await other.settle();
  assert.equal(reads, 2); assert.deepEqual(other.latest.rows, []);
  assert.equal(other.latest.loaded, false);
  release(); await other.settle(); other.unmount();
});

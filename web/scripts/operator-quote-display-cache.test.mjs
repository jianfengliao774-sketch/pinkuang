import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { transform, loadBindings } from 'next/dist/build/swc/index.js';

// Run the shipped JSX and its cache, with fixture-only public reads and hook lifecycles.
const require = createRequire(import.meta.url), turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const source = await readFile(new URL('../components/OperatorQuotePicker.jsx', import.meta.url), 'utf8');
await loadBindings();
const { code } = await transform(`${source}\nexport { createQuotePageDisplayCache };`, {
  filename: 'OperatorQuotePicker.jsx', jsc: { parser: { syntax: 'ecmascript', jsx: true }, target: 'es2022',
    transform: { react: { runtime: 'automatic' } } }, module: { type: 'commonjs' },
});
const address = `0x${'11'.repeat(20)}`, other = `0x${'22'.repeat(20)}`;
const row = id => ({ collection: address, tokenId: String(id), series: 'TapeOut', status: 'verified',
  estimated24hAtomic: '100000000', ask: { priceWei: '10000000000000000', venue: 'official' } });
const page = id => ({ rows: [row(id)], page: 1, totalPages: 1, total: 1, viewId: `view-${id}` });

function moduleFixture(loader = async () => page(1)) {
  let active, selectedReads = 0;
  const hooks = {
    useState(value) { const i = active.position++; if (!active.slots[i]) active.slots[i] = { value: typeof value === 'function' ? value() : value };
      const slot = active.slots[i], target = active; return [slot.value, value => { if (!target.disposed) slot.value = typeof value === 'function' ? value(slot.value) : value; }]; },
    useRef(value) { const i = active.position++; return active.slots[i] ??= { current: value }; },
    useEffect(fn, deps) { const i = active.position++, old = active.slots[i];
      if (!old || deps.some((dep, at) => dep !== old.deps[at])) active.effects.push(() => { old?.cleanup?.(); active.slots[i] = { deps, cleanup: fn() }; }); },
  };
  const quotes = { listOperatorQuotes: loader, QUOTE_BASE: '/fixture-quotes', QUOTE_SOURCE: 'https://example.test/quotes',
    listingDailyCapacityPrice: () => '0.01000', operatorQuoteError: error => error.message, operatorQuoteDraft: () => assert.fail('No transaction draft requested'),
    loadVerifiedCapacityHint: () => assert.fail('No selected-capacity fallback requested'),
    loadOperatorQuote: async input => { selectedReads++; return { chain: { collection: input.collection, tokenId: input.tokenId,
      registry: null, official: { id: '1', priceWei: '10000000000000000' } }, quote: { estimated24hAtomic: '100000000',
      source: { observedAt: Date.now() } }, reference: { dailyCapacityPriceWei: '10000000000000000', observedAt: Date.now() } }; },
  };
  const exports = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => name === 'react' ? hooks
    : name === '../lib/operator-quotes.mjs' ? quotes
      : name === '../../deploy/src/pricing.ts' ? { OFFICIAL_COLLECTIONS: { TapeOut: address, Behemoth: other },
        referenceIssue: () => null, fetchCapacityReference: () => assert.fail('No selected reference fallback requested') }
        : require(name), exports, exports.exports);
  const Component = exports.exports.default;
  function host(props) {
    const state = { slots: [], effects: [], position: 0, disposed: false, tree: null };
    const ui = { get tree() { return state.tree; },
      render(next = props) { props = next; active = state; state.position = 0; state.tree = Component(props);
        while (state.effects.length) state.effects.shift()(); return state.tree; },
      async settle() { for (let i = 0; i < 4; i++) { await turn(); ui.render(); } },
      unmount() { state.disposed = true; for (const slot of state.slots) slot?.cleanup?.(); },
    };
    ui.render(); return ui;
  }
  return { host, cache: exports.exports.createQuotePageDisplayCache, selectedReads: () => selectedReads };
}
const elements = tree => tree == null || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(elements)
  : [tree, ...elements(tree.props?.children)];
const text = tree => tree == null || typeof tree === 'boolean' ? '' : Array.isArray(tree) ? tree.map(text).join('')
  : typeof tree === 'object' ? text(tree.props?.children) : String(tree);
function button(ui, label) { const item = elements(ui.tree).find(item => item.type === 'button' && text(item) === label);
  assert(item, `Missing button ${label}`); return item.props; }
const props = { config: { factory: address, displayOnly: true }, mode: 'createPool', refreshKey: 0, onApply: () => assert.fail('No transaction selected') };

test('quote directory GET is shared across cleanup/remount and returning to the operator page', async () => {
  const pending = deferred(), calls = [], f = moduleFixture((input, options) => { calls.push({ input, options }); return pending.promise; });
  const first = f.host(props); first.unmount();
  const second = f.host(props); await turn();
  assert.equal(calls.length, 1, 'StrictMode cleanup must not cancel and duplicate a public GET');
  assert.equal(calls[0].options.signal, undefined);
  pending.resolve(page(3)); await second.settle();
  assert.match(text(second.tree), /TapeOut #3/); second.unmount();
  const returned = f.host(props);
  assert.match(text(returned.tree), /TapeOut #3/, 'Cached rows are displayed on the first render');
  await returned.settle(); assert.equal(calls.length, 1); returned.unmount();
});

test('SSE and manual refresh update rows without hiding the last page; selections are never cached', async () => {
  const reads = [], pending = [], f = moduleFixture(() => { const read = deferred(); reads.push(read); pending.push(read); return read.promise; });
  const ui = f.host(props); await turn(); pending.shift().resolve(page(4)); await ui.settle();
  ui.render({ ...props, refreshKey: 1 }); await turn(); ui.render();
  assert.match(text(ui.tree), /TapeOut #4/, 'Refreshing preserves the existing table');
  pending.shift().resolve(page(5)); await ui.settle(); assert.match(text(ui.tree), /TapeOut #5/);
  button(ui, '刷新日产能价候选').onClick(); await turn(); ui.render();
  assert.match(text(ui.tree), /TapeOut #5/); pending.shift().reject(new Error('Temporary public API failure'));
  await ui.settle(); assert.match(text(ui.tree), /TapeOut #5/);
  assert.match(text(ui.tree), /Temporary public API failure/); assert.equal(reads.length, 3);
  button(ui, '选择矿机').onClick(); await ui.settle(); button(ui, '选择矿机').onClick(); await ui.settle();
  assert.equal(f.selectedReads(), 2, 'Actual selected-order reads are independent from the directory cache'); ui.unmount();
});

test('public quote cache isolates filters, source, page and revision; expiry and eviction trigger reads', async () => {
  let clock = 1000, reads = 0;
  const cache = moduleFixture().cache({ now: () => clock, loader: async () => { reads++; return page(reads); } });
  const input = { query: ' 7 ', series: 'TapeOut', sort: 'price_low', page: 1 }, options = { baseUrl: '/one', refreshKey: 1 };
  await cache.read(input, options); await cache.read({ ...input, query: '7' }, options); assert.equal(reads, 1);
  for (const [next, config] of [[{ ...input, series: 'Behemoth' }, options], [{ ...input, query: '8' }, options],
    [{ ...input, sort: 'daily_capacity_price_low' }, options], [{ ...input, page: 2, viewId: 'view-a' }, options],
    [{ ...input, page: 2, viewId: 'view-b' }, options], [input, { ...options, baseUrl: '/two' }],
    [input, { ...options, refreshKey: 2 }]]) await cache.read(next, config);
  assert.equal(reads, 8); clock += 120001; await cache.read(input, options); assert.equal(reads, 9);
  for (let page = 2; page <= 66; page++) await cache.read({ ...input, page }, options);
  const before = reads; await cache.read(input, options); assert.equal(reads, before + 1, 'Oldest entries are evicted after 64 keys');
});

test('known miner ID selects exact official identity directly without relying on a directory match', async () => {
  let listReads = 0;
  const f = moduleFixture(async () => { listReads++; return { ...page(1), rows: [] }; });
  const ui = f.host(props); await ui.settle();
  const field = label => elements(ui.tree).find(item => item.props?.['aria-label'] === label).props;
  field('搜索报价矿机编号').onChange({ target: { value: ' 016736 ' } }); ui.render();
  field('报价矿机系列').onChange({ target: { value: 'TapeOut' } }); ui.render();
  elements(ui.tree).find(item => item.type === 'form').props.onSubmit({ preventDefault() {} });
  await ui.settle();
  assert.equal(f.selectedReads(), 1); assert.equal(listReads, 1, 'Only the initial directory GET is needed');
  assert.match(text(ui.tree), /TapeOut #16736/);
  assert.doesNotMatch(text(ui.tree), /列表未找到/);
  assert.equal(button(ui, '填入建池表单').disabled, false);
  ui.unmount();
});

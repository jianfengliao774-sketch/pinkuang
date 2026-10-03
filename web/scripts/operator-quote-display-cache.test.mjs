import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { transform, loadBindings } from 'next/dist/build/swc/index.js';
import { listingDailyCapacityPrice } from '../lib/operator-quotes.mjs';
import { quoteIssue, minerReferenceIssue, referenceIssue } from '../../deploy/src/pricing.ts';

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

function moduleFixture(loader = async () => page(1), { loadSelected, draftBuilder, fetchReference } = {}) {
  let active, selectedReads = 0;
  const hooks = {
    useState(value) { const i = active.position++; if (!active.slots[i]) active.slots[i] = { value: typeof value === 'function' ? value() : value };
      const slot = active.slots[i], target = active; return [slot.value, value => { if (!target.disposed) slot.value = typeof value === 'function' ? value(slot.value) : value; }]; },
    useRef(value) { const i = active.position++; return active.slots[i] ??= { current: value }; },
    useEffect(fn, deps) { const i = active.position++, old = active.slots[i];
      if (!old || deps.some((dep, at) => dep !== old.deps[at])) active.effects.push(() => { old?.cleanup?.(); active.slots[i] = { deps, cleanup: fn() }; }); },
  };
  const quotes = { listOperatorQuotes: loader, QUOTE_BASE: '/fixture-quotes', QUOTE_SOURCE: 'https://example.test/quotes',
    listingDailyCapacityPrice, operatorQuoteError: error => error.message,
    operatorQuoteDraft: (...args) => draftBuilder ? draftBuilder(...args) : assert.fail('No transaction draft requested'),
    loadVerifiedCapacityHint: () => assert.fail('No selected-capacity fallback requested'),
    loadOperatorQuote: async input => { selectedReads++; return loadSelected ? loadSelected(input) : { chain: { collection: input.collection, tokenId: input.tokenId,
      registry: null, official: { id: '1', priceWei: '10000000000000000' } }, quote: {
      collection: input.collection, tokenId: input.tokenId, series: input.collection === other ? 'Behemoth' : 'TapeOut',
      status: 'verified', estimated24hAtomic: '100000000',
      issues: [], ask: { priceWei: '10000000000000000', venue: 'official', kind: 'official', status: 'open', expiresAt: Date.now() + 60000 },
      source: { observedAt: Date.now() } }, reference: { dailyCapacityPriceWei: '10000000000000000', observedAt: Date.now() } }; },
  };
  const exports = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => name === 'react' ? hooks
    : name === '../lib/operator-quotes.mjs' ? quotes
      : name === '../../deploy/src/pricing.ts' ? { OFFICIAL_COLLECTIONS: { TapeOut: address, Behemoth: other },
        quoteIssue, minerReferenceIssue, referenceIssue,
        fetchCapacityReference: (...args) => fetchReference ? fetchReference(...args) : assert.fail('No selected reference fallback requested') }
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

// Same public price/yield combination as the reported #5181 batch listing.
// The injected selection represents a successful identity/freshness check;
// no mocked batch order is ever made into an executable purchase route.
const batchSelection = () => ({ chain: { collection: address, tokenId: '5181', official: null, firsto: null,
  registry: { supported: true, ready: true, pool: `0x${'00'.repeat(20)}` },
  firstoError: '仅支持 Firsto 单笔签名挂单；批量挂单尚未开放。' },
  quote: { collection: address, tokenId: '5181', series: 'TapeOut', status: 'verified',
    estimated24hAtomic: '18490000', issues: [], source: { observedAt: Date.now() },
    ask: { priceWei: '1373777280000000000', buyerCostWei: '1387515052800000000', venue: 'firsto',
      kind: 'circuit_batch_ask', status: 'open', expiresAt: Date.now() + 60000 } },
  reference: { dailyCapacityPriceWei: '7500000000000000000', observedAt: Date.now() } });

test('selected batch ask retains its own daily price and explains why fixed creation is unavailable', async () => {
  const f = moduleFixture(undefined, { loadSelected: batchSelection }), ui = f.host(props);
  await ui.settle(); button(ui, '选择矿机').onClick(); await ui.settle();
  assert.match(text(ui.tree), /Firsto挂单日产能价：7\.42984 BNB \/ \(BEM \/ 天\)（挂牌参考/);
  assert.match(text(ui.tree), /全市场参考日产能价：7\.50000 BNB/);
  assert.match(text(ui.tree), /Firsto 确有这台矿机的批量挂单/);
  assert.match(text(ui.tree), /上方选择“单台矿机灵活替代”/);
  assert.doesNotMatch(text(ui.tree), /当前没有本项目可采购的官网挂单/);
  const apply = button(ui, '填入建池表单');
  assert.equal(apply.disabled, true);
  const reason = elements(ui.tree).find(item => item.props?.id === apply['aria-describedby']);
  assert.match(text(reason), /Firsto 批量订单.*当前矿池合约不支持采购/);
  ui.unmount();
});

test('batch reference does not replace an available official purchase price or disable its fixed draft', async () => {
  const selected = batchSelection(); selected.chain.official = { id: '45', priceWei: '40000000000000000' };
  selected.chain.firstoError = null;
  const f = moduleFixture(undefined, { loadSelected: () => selected }), ui = f.host(props);
  await ui.settle(); button(ui, '选择矿机').onClick(); await ui.settle();
  assert.match(text(ui.tree), /官网挂单日产能价：0\.21633 BNB/);
  assert.doesNotMatch(text(ui.tree), /挂牌参考，尚无可执行采购路线|不能用于“指定单台矿机”/);
  assert.equal(button(ui, '填入建池表单').disabled, false);
  ui.unmount();
});

test('official index reference keeps its actual market label when the chain has no executable listing', async () => {
  const selected = batchSelection(); selected.quote.ask.venue = 'official'; selected.chain.firstoError = null;
  const f = moduleFixture(undefined, { loadSelected: () => selected }), ui = f.host(props);
  await ui.settle(); button(ui, '选择矿机').onClick(); await ui.settle();
  assert.match(text(ui.tree), /官网挂单日产能价：7\.42984 BNB/);
  assert.match(text(ui.tree), /官网已返回这台矿机的挂单，但当前没有可执行的采购路线/);
  assert.doesNotMatch(text(ui.tree), /Firsto挂单日产能价|Firsto 确有这台矿机的批量挂单/);
  assert.equal(button(ui, '填入建池表单').disabled, true);
  ui.unmount();
});

test('flexible reference remains available for batch metadata while unfinished registry retains its real reason', async () => {
  const flexibleProps = { ...props, mode: 'createFlexiblePoolChecked' };
  const allowed = moduleFixture(undefined, { loadSelected: batchSelection }), ui = allowed.host(flexibleProps);
  await ui.settle(); button(ui, '选择矿机').onClick(); await ui.settle();
  assert.equal(button(ui, '填入建池表单').disabled, false);
  assert.match(text(ui.tree), /当前矿池合约不支持采购该批量订单/);
  ui.unmount();
  const selected = batchSelection(); selected.chain.registry.ready = false;
  const blocked = moduleFixture(undefined, { loadSelected: () => selected });
  const blockedUi = blocked.host({ ...flexibleProps, config: { ...props.config, displayOnly: false } });
  await blockedUi.settle(); button(blockedUi, '链上核对并选择').onClick(); await blockedUi.settle();
  const apply = button(blockedUi, '填入建池表单'); assert.equal(apply.disabled, true);
  const reason = elements(blockedUi.tree).find(item => item.props?.id === apply['aria-describedby']);
  assert.match(text(reason), /矿机唯一性登记尚未完成/);
  blockedUi.unmount();
});

test('expired batch reference is not presented as the current miner listing price', async () => {
  const selected = batchSelection(); selected.quote.ask.expiresAt = Date.now() - 1;
  const f = moduleFixture(undefined, { loadSelected: () => selected }), ui = f.host(props);
  await ui.settle(); button(ui, '选择矿机').onClick(); await ui.settle();
  assert.match(text(ui.tree), /当前市场挂单日产能价：—/);
  assert.doesNotMatch(text(ui.tree), /7\.42984/);
  assert.equal(button(ui, '填入建池表单').disabled, true);
  ui.unmount();
});

const unlistedSelection = () => ({
  chain: { collection: address, tokenId: '10042', official: null, firsto: null, firstoError: null,
    eligible: true, taskId: '220', verifiedWeight: '61', checkedAt: Date.now(), displayOnly: true, registry: null },
  quote: { collection: address, tokenId: '10042', series: 'TapeOut', status: 'verified', owner: other,
    taskId: '220', verifiedWeight: '61', unverifiedWeight: '0', estimated24hAtomic: '123456789',
    ask: null, detailChecked: true, issues: [], source: { observedAt: Date.now() } },
  reference: { dailyCapacityPriceWei: '3000000000000000001', observedAt: Date.now() }, referenceError: null,
});
const unlistedPage = () => ({ ...page(10042), rows: [{ ...row(10042), ask: null }], totalPages: 2 });

test('viewing unlisted #10042 shows its model and daily yield without an error or fixed procurement permission', async () => {
  const f = moduleFixture(unlistedPage, { loadSelected: unlistedSelection }), ui = f.host(props);
  await ui.settle(); assert.match(text(ui.tree), /未挂单 · 仅作参考/);
  button(ui, '查看矿机').onClick(); await ui.settle();
  assert.match(text(ui.tree), /TapeOut #10042 · 矿机资料已读取/);
  assert.match(text(ui.tree), /预计日产出：1\.23457 BEM \/ 天/);
  assert.match(text(ui.tree), /这台矿机当前未挂单，不能用于指定购机/);
  assert.equal(elements(ui.tree).some(item => item.props?.role === 'alert'), false);
  assert.equal(button(ui, '填入建池表单').disabled, true);
  assert.equal(f.selectedReads(), 1); ui.unmount();
});

test('a fresh unlisted reference may fill only the flexible form and retains the checked metadata', async () => {
  let applied, draftOptions;
  const selected = unlistedSelection();
  const f = moduleFixture(unlistedPage, { loadSelected: () => selected,
    draftBuilder: (checked, options) => { assert.equal(checked, selected); draftOptions = options;
      return { kind: options.mode, params: { circuitId: '10042' } }; } });
  const ui = f.host({ ...props, mode: 'createFlexiblePoolChecked', onApply: result => { applied = result; } });
  await ui.settle(); button(ui, '选择参考矿机').onClick(); await ui.settle();
  const apply = button(ui, '填入建池表单'); assert.equal(apply.disabled, false);
  assert.equal(elements(ui.tree).some(item => item.props?.role === 'alert'), false);
  apply.onClick(); await ui.settle();
  assert.equal(applied.checked, selected); assert.equal(applied.draft.kind, 'createFlexiblePoolChecked');
  assert.equal(draftOptions.mode, 'createFlexiblePoolChecked'); assert.equal(draftOptions.extraBps, 1000);
  ui.render(props); await ui.settle();
  assert.equal(elements(ui.tree).some(item => item.props?.className === 'operator-quote-selected'), false,
    'A flexible selection is retired when switching back to fixed procurement.');
  ui.unmount();
});

test('fresh selected metadata replaces only the same NFT directory row and removes its obsolete signed ask', async () => {
  const old = { ...row(10042), ask: { priceWei: '999000000000000000000', venue: 'firsto', kind: 'signed_ask' } };
  const untouched = row(10043);
  const f = moduleFixture(async () => ({ ...unlistedPage(), rows: [old, untouched] }), { loadSelected: unlistedSelection });
  const ui = f.host(props); await ui.settle();
  assert.match(text(ui.tree), /Firsto 签名挂单/); assert.match(text(ui.tree), /999\.00000 BNB/);
  button(ui, '选择矿机').onClick(); await ui.settle();
  const rows = elements(ui.tree).filter(item => item.type === 'tr');
  const selectedRow = rows.find(item => /TapeOut #10042/.test(text(item)));
  const otherRow = rows.find(item => /TapeOut #10043/.test(text(item)));
  const selectedCells = elements(selectedRow).filter(item => item.type === 'td');
  assert.equal(text(selectedCells[1]), '— BNB'); assert.match(text(selectedCells[2]), /1\.23457 BEM/);
  assert.equal(text(selectedCells[5]), '未挂单 · 仅作参考');
  assert.match(text(otherRow), /0\.01000 BNB/); assert.match(text(otherRow), /官网挂单/);
  assert.doesNotMatch(text(ui.tree), /999\.00000 BNB|Firsto 签名挂单/);
  assert.match(text(ui.tree), /第 1 \/ 2 页/);
  assert.equal(elements(ui.tree).some(item => item.props?.role === 'alert'), false);
  assert.equal(button(ui, '填入建池表单').disabled, true); ui.unmount();
});

test('a stale market reference cannot enable flexible unlisted creation', async () => {
  const selected = unlistedSelection(); selected.reference.observedAt = Date.now() - 300001;
  const f = moduleFixture(unlistedPage, { loadSelected: () => selected });
  const ui = f.host({ ...props, mode: 'createFlexiblePoolChecked' }); await ui.settle();
  button(ui, '选择参考矿机').onClick(); await ui.settle();
  const apply = button(ui, '填入建池表单'); assert.equal(apply.disabled, true);
  const reason = elements(ui.tree).find(item => item.props?.id === apply['aria-describedby']);
  assert.match(text(reason), /有效的全市场参考价暂不可用/);
  assert.equal(elements(ui.tree).some(item => item.props?.role === 'alert'), false); ui.unmount();
});

test('failed capacity reference remains visible without immediately repeating the paid GET', async () => {
  let referenceReads = 0;
  const selected = unlistedSelection(); selected.reference = null; selected.referenceError = 'Firsto HTTP 503';
  const f = moduleFixture(unlistedPage, { loadSelected: () => selected,
    fetchReference: async () => { referenceReads++; return unlistedSelection().reference; } });
  const ui = f.host({ ...props, mode: 'createFlexiblePoolChecked' }); await ui.settle();
  button(ui, '选择参考矿机').onClick(); await ui.settle();
  assert.equal(referenceReads, 0, 'loadOperatorQuote already attempted the reference request.');
  assert.equal(button(ui, '填入建池表单').disabled, true);
  assert.match(text(ui.tree), /Firsto HTTP 503/);
  assert.equal(elements(ui.tree).some(item => item.props?.role === 'alert'), false); ui.unmount();
});

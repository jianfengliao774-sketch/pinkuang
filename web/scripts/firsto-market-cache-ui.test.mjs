import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { transform, loadBindings } from 'next/dist/build/swc/index.js';

const require = createRequire(import.meta.url);
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const elements = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree)
  ? tree.flatMap(elements) : [tree, ...elements(tree.props?.children)];
const text = tree => tree == null || typeof tree === 'boolean' ? '' : Array.isArray(tree)
  ? tree.map(text).join('') : typeof tree === 'object' ? text(tree.props?.children) : String(tree);
await loadBindings();
const { code } = await transform(await readFile(new URL('../components/FirstoMarketBoard.jsx', import.meta.url), 'utf8'), {
  filename: 'FirstoMarketBoard.jsx', jsc: { parser: { syntax: 'ecmascript', jsx: true }, target: 'es2022',
    transform: { react: { runtime: 'automatic' } } }, module: { type: 'commonjs' },
});

function runtime(read, locale = 'zh') {
  let current;
  const hooks = Object.fromEntries(['useState', 'useRef', 'useEffect'].map(name => [name, (...args) => current.hooks[name](...args)]));
  const exported = { exports: {} };
  const modules = { react: hooks, '../lib/i18n': { useI18n: () => ({ locale }) },
    '../../deploy/src/pricing.ts': { MAX_QUOTE_AGE_MS: 600_000 }, './FirstoMarketBoard.css': {},
    './firsto-market-board.mjs': { FIRSTO_MARKET_SOURCE: 'https://tapeout.firsto.ai',
      formatMarketAmount: value => String(value), readFirstoMarketBoard: read } };
  new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', code)(
    name => modules[name] ?? require(name), exported, exported.exports, () => ({}), () => {}, () => ({}), () => {});
  return props => {
    const slots = [], effects = []; let at = 0, stopped = false;
    const ui = { props, tree: null, hooks: {
      useState(initial) { const index = at++; if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
        return [slots[index].value, value => { if (!stopped) slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; }]; },
      useRef(initial) { const index = at++; return slots[index] ??= { current: initial }; },
      useEffect(work, deps) { const index = at++, old = slots[index];
        if (!old || deps.some((value, position) => value !== old.deps[position])) effects.push(() => {
          old?.cleanup?.(); slots[index] = { deps, cleanup: work() }; }); },
    },
      render(next = ui.props) { ui.props = next; at = 0; current = ui;
        ui.tree = exported.exports.default(next); while (effects.length) effects.shift()(); return ui.tree; },
      async settle() { for (let i = 0; i < 4; i++) { await turn(); ui.render(); } },
      unmount() { stopped = true; for (const slot of slots) slot?.cleanup?.(); },
    };
    ui.render(); return ui;
  };
}
function board() {
  const observedAt = Date.now();
  return { page: 1, totalPages: 1, viewId: 'view', excluded: [], reference: {
    observedAt, sourceBlock: 100, dailyCapacityPriceWei: '123' }, rows: [{ key: 'one', series: 'TapeOut', tokenId: '1',
    venue: 'Firsto', sourceBlock: 100, observedAt, validUntil: observedAt + 600_000, unavailable: null,
    sellerPriceWei: '100', buyerCostWei: '101', estimated24hAtomic: '200', dailyCapacityPriceWei: '300', buyerDailyCapacityPriceWei: '301' }] };
}

test('returning to the market reuses a fresh board, while updates keep the existing table visible', async () => {
  const pending = deferred(); let calls = 0;
  const mount = runtime(async () => ++calls === 1 ? board() : pending.promise);
  const first = mount({ refreshKey: 0 }); await first.settle(); assert.equal(calls, 1); first.unmount();
  const second = mount({ refreshKey: 0 }); await second.settle(); assert.equal(calls, 1, 'same revision remount is served from memory');
  second.render({ refreshKey: 1 }); second.render(); assert.equal(calls, 2);
  assert(elements(second.tree).some(node => node.type === 'table'), 'the loaded market table remains during refresh');
  assert.match(text(second.tree), /正在读取市场报价/);
  pending.resolve(board()); await second.settle(); second.unmount();
});

test('manual market refresh bypasses reusable data', async () => {
  let calls = 0; const mount = runtime(async () => { calls++; return board(); });
  const ui = mount({ refreshKey: 0 }); await ui.settle();
  const refresh = elements(ui.tree).find(node => node.type === 'button' && text(node) === '刷新');
  refresh.props.onClick(); await ui.settle(); assert.equal(calls, 2); ui.unmount();
});

test('market rows show a single seller-basis daily capacity price in both languages', async () => {
  for (const locale of ['zh', 'en']) {
    for (const [sourceVenue, englishVenue] of [['Firsto 挂单', 'Firsto listing'], ['TapeOut 官网挂单', 'TapeOut listing']]) {
      const data = board(); data.rows[0].venue = sourceVenue;
      const ui = runtime(async () => data, locale)({ refreshKey: 0 });
      await ui.settle();
      const headers = elements(ui.tree).filter(node => node.type === 'th');
      assert.equal(headers.length, 5, 'the buyer-total column is omitted');
      assert(text(headers[2]).includes(locale === 'zh' ? '预计日产BEM' : 'Expected daily BEM'));
      assert(text(headers[3]).startsWith(locale === 'zh' ? '日产能价' : 'Price per daily BEM'));
      const cells = elements(ui.tree).filter(node => node.type === 'td');
      assert.equal(cells.length, 5);
      assert(text(cells[0]).includes(locale === 'zh' ? sourceVenue : englishVenue));
      if (locale === 'en') assert.doesNotMatch(text(cells[0]), /挂单|官网/);
      assert.equal(text(cells[1]), '100');
      assert.equal(text(cells[2]), '200');
      assert.equal(text(cells[3]), '300', 'only the existing seller-ask / daily-BEM value is rendered');
      assert.equal(elements(cells[3]).filter(node => node.type === 'small').length, 0);
      const unit = elements(ui.tree).find(node => node.props?.className === 'firsto-board-unit');
      assert.equal(text(unit), '300');
      assert(elements(ui.tree).some(node => node.type === 'a'
        && text(node).trim() === (locale === 'zh' ? 'Firsto 网站' : 'Firsto website')));
      assert.doesNotMatch(text(ui.tree), /买方总价|Buyer-total basis|Firsto buyer total|不请求钱包签名|never requests a wallet signature/);
      ui.unmount();
    }
  }
});

test('simplified market rows still hide amounts after a quote expires', async () => {
  const expired = board(); expired.rows[0].validUntil = Date.now() - 1;
  const ui = runtime(async () => expired)({ refreshKey: 0 });
  await ui.settle();
  const cells = elements(ui.tree).filter(node => node.type === 'td');
  assert.equal(text(cells[1]), '—');
  assert.equal(text(cells[2]), '—');
  assert.equal(text(cells[3]), '暂不可用');
  assert.match(text(cells[4]), /报价已过期/);
  ui.unmount();
});

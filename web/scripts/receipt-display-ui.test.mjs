import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { transform, loadBindings } from 'next/dist/build/swc/index.js';
const require = createRequire(import.meta.url);
await loadBindings();
const compile = async name => (await transform(await readFile(new URL(`../components/${name}.jsx`, import.meta.url), 'utf8'), {
  filename: `${name}.jsx`, jsc: { parser: { syntax: 'ecmascript', jsx: true }, target: 'es2022',
    transform: { react: { runtime: 'automatic' } } }, module: { type: 'commonjs' },
})).code;
const code = await compile('LivePortfolios');
const turn = () => new Promise(resolve => setImmediate(resolve));

test('budget directory receipt generation refreshes its server GET without wallet or quote reads', async () => {
  const slots = [], effects = []; let position = 0, reads = 0, latest, disposed = false;
  const hooks = {
    useState(initial) { const at = position++; if (!slots[at]) slots[at] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[at].value, value => { if (!disposed) slots[at].value = typeof value === 'function' ? value(slots[at].value) : value; }]; },
    useRef(initial) { const at = position++; return slots[at] ??= { current: initial }; },
    useEffect(fn, deps) { const at = position++, previous = slots[at];
      if (!previous || deps.some((dep, index) => dep !== previous.deps[index]))
        effects.push(() => { previous?.cleanup?.(); slots[at] = { deps, cleanup: fn() }; }); },
  };
  const address = '0x' + 'aa'.repeat(20);
  const config = { kind: 'integrated-v2', factory: address, portfolioFactory: address, displayOnly: true, artifactDigest: 'fixture' };
  const modules = {
    react: hooks,
    '../lib/live-portfolios.mjs': { portfolioPageActionReady: () => true, portfolioCreateActionReady: () => true,
      portfolioSelectedActionReady: () => true, portfolioOrderActionReady: () => true,
      readPortfolioPage: async () => { reads++; return { items: [], nextCursor: null, operator: null,
        source: { factory: address, indexedThrough: reads === 1 ? 99 : 100, displayOnly: true } }; } },
    '../lib/display-snapshot.mjs': { readDisplaySnapshot: () => null, displayOnlySnapshot: value => value,
      writeDisplaySnapshot: () => true },
    '../../deploy/src/pricing.ts': { fetchCapacityReference: () => assert.fail('Receipt catchup must not request quotes'),
      fetchQuotePage: () => assert.fail('Receipt catchup must not request quotes') },
    './LivePortfolios.css': {},
  };
  for (const name of ['./LiveYieldChart', './ActivityOperation', './PortfolioCapacity', './BudgetPurchaseQueue'])
    modules[name] = { __esModule: true, default: () => null };
  const exported = { exports: {} };
  new Function('require', 'module', 'exports', 'window', code)(name => modules[name] ?? require(name),
    exported, exported.exports, { sessionStorage: {} });
  const Component = exported.exports.default;
  let props = { config, provider: { request: () => assert.fail('Directory cache must not request wallet/RPC data') },
    locale: 'zh', mode: 'pools', refreshKey: 0, displayRefreshKey: '0:0',
    renderDirectory: value => { latest = value; return null; } };
  const render = () => { position = 0; Component(props); while (effects.length) effects.shift()(); };
  const settle = async () => { for (let i = 0; i < 5; i++) { await turn(); render(); } };
  render(); await settle(); assert.equal(reads, 1); assert.equal(latest.source.indexedThrough, 99);
  props = { ...props, displayRefreshKey: '0:1' }; render(); await settle();
  assert.equal(reads, 2); assert.equal(latest.source.indexedThrough, 100); assert.equal(props.refreshKey, 0);
  render(); await settle(); assert.equal(reads, 2, 'A render with the same generation reuses its completed GET.');
  disposed = true; for (const slot of slots) slot?.cleanup?.();
});

test('LivePlatform receipt integration compiles with the client display generation', async () => {
  const output = await compile('LivePlatform');
  assert(output.includes('startReceiptDisplayCatchup'));
});

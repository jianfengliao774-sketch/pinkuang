import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { transform, loadBindings } from 'next/dist/build/swc/index.js';
import * as view from '../lib/live-view.mjs';

// Run real JSX handlers and effects with deterministic reads and timers. These
// fixtures never connect a wallet or make an RPC, signature or transaction.
const require = createRequire(import.meta.url);
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
await loadBindings();
const { code } = await transform(await readFile(new URL('../components/FeeCollectionHistory.jsx', import.meta.url), 'utf8'), {
  filename: 'FeeCollectionHistory.jsx',
  jsc: { parser: { syntax: 'ecmascript', jsx: true }, target: 'es2022', transform: { react: { runtime: 'automatic' } } },
  module: { type: 'commonjs' },
});

function host(props, read) {
  const slots = [], effects = [], intervals = new Map(), reads = [];
  let position = 0, tree, disposed = false;
  const hooks = {
    useState(initial) {
      const at = position++;
      if (!slots[at]) slots[at] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[at].value, next => { if (!disposed) slots[at].value = typeof next === 'function' ? next(slots[at].value) : next; }];
    },
    useRef(initial) { return slots[position++] ??= { current: initial }; },
    useEffect(fn, deps) {
      const at = position++, previous = slots[at];
      if (!previous || deps.some((dep, index) => dep !== previous.deps[index]))
        effects.push(() => { previous?.cleanup?.(); slots[at] = { deps, cleanup: fn() }; });
    },
  };
  const exported = { exports: {} }, document = { visibilityState: 'visible' };
  const modules = { react: hooks, '../lib/live-view.mjs': view,
    '../lib/fee-collection-history.mjs': { readFeeCollectionHistory: async args => { reads.push(args); return read(args, reads.length); } } };
  new Function('require', 'module', 'exports', 'document', 'setInterval', 'clearInterval', code)(
    name => modules[name] ?? require(name), exported, exported.exports, document,
    (fn, ms) => { const id = {}; intervals.set(id, { fn, ms }); return id; }, id => intervals.delete(id));
  const Component = exported.exports.default;
  const ui = {
    get tree() { return tree; }, get intervals() { return [...intervals.values()]; }, reads, document,
    render(next = props) { props = next; position = 0; tree = Component(props); while (effects.length) effects.shift()(); return tree; },
    async settle() { for (let i = 0; i < 4; i++) { await turn(); ui.render(); } },
    unmount() { disposed = true; for (const slot of slots) slot?.cleanup?.(); },
  };
  ui.render(); return ui;
}
const elements = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree)
  ? tree.flatMap(elements) : [tree, ...elements(tree.props?.children)];
const text = tree => tree == null || typeof tree === 'boolean' ? '' : Array.isArray(tree)
  ? tree.map(text).join('') : typeof tree === 'object' ? text(tree.props?.children) : String(tree);
function button(ui, label) {
  const found = elements(ui.tree).find(item => item.type === 'button' && text(item) === label);
  assert(found, `Missing button: ${label}`); return found.props;
}
const address = index => `0x${BigInt(index).toString(16).padStart(40, '0')}`;
const hash = index => `0x${BigInt(index).toString(16).padStart(64, '0')}`;
const config = { stage: 'fresh-active', artifactDigest: 'fixture', authority: address(1), gasWallet: address(2), factory: address(3),
  shareMarket: address(4), portfolioFactory: address(5), portfolioMarket: address(6),
  manifest: { freshAuthority: { codehash: hash(1) }, codehash: { [address(3)]: hash(3) }, verifiedBlockNumber: '12345' } };
const row = (index = 1, overrides = {}) => ({ administrator: address(index + 10), bnbAmountWei: 5000000000000001n,
  bemAmountWei: 450000000000000001n, transactionHash: hash(index), blockNumber: 20000n - BigInt(index),
  timestamp: 1790000000n, logIndex: index, ...overrides });
const page = (rows = [row()], overrides = {}) => ({ rows, nextCursor: null, complete: true, fromBlock: 12345n,
  toBlock: 20000n, safeBlockNumber: 20000n, checkedAt: 1790000000000, ...overrides });
const baseProps = () => ({ config, provider: { request: async () => assert.fail('Unexpected RPC') },
  wallet: { request: async () => assert.fail('Unexpected wallet use') }, account: address(7), refreshKey: 0 });

test('history shows receiving administrator, separate five-decimal amounts and receipt links without inputs', async () => {
  const props = baseProps(), ui = host(props, () => page([row(), row(2, { timestamp: null, bnbAmountWei: 0n, bemAmountWei: 0n })]));
  await ui.settle();
  assert.equal(ui.reads.length, 1, 'initial effects issue a single read');
  assert.equal(ui.reads[0].limit, 20); assert.equal(ui.reads[0].cursor, null);
  assert.equal(ui.reads[0].refresh, false);
  assert.equal(ui.reads[0].logsProvider, undefined, 'history uses the scoped server RPC instead of the wallet node'); assert.equal(ui.reads[0].provider, props.provider);
  assert(ui.reads[0].signal instanceof AbortSignal);
  const nodes = elements(ui.tree), links = nodes.filter(node => node.type === 'a');
  assert(links.some(link => link.props.href === view.explorerAddress(row().administrator) && text(link) === row().administrator));
  assert(links.some(link => link.props.href === view.explorerTransaction(row().transactionHash) && link.props.title === row().transactionHash));
  assert.match(text(ui.tree), /0\.00500/); assert.match(text(ui.tree), /0\.45000/); assert.match(text(ui.tree), /0\.00000/);
  assert.match(text(ui.tree), /—/); assert.match(text(ui.tree), /20000/);
  assert.equal(nodes.some(node => ['input', 'select', 'textarea'].includes(node.type)), false); ui.unmount();
});

test('opaque pagination preserves cursors, reads only twenty records and previous returns to newest', async () => {
  const next = { block: '18000', offset: 2 }, ui = host(baseProps(), args => args.cursor === next
    ? page([row(2)]) : page([row()], { nextCursor: next, complete: false }));
  await ui.settle(); button(ui, '更早记录').onClick(); await ui.settle();
  assert.equal(ui.reads.at(-1).cursor, next); assert.match(text(ui.tree), /第 2 页/);
  assert.equal(button(ui, '更早记录').disabled, true); assert.equal(button(ui, '上一页').disabled, false);
  button(ui, '上一页').onClick(); await ui.settle();
  assert.equal(ui.reads.at(-1).cursor, null); assert.match(text(ui.tree), /第 1 页/);
  assert(ui.reads.every(args => args.limit === 20)); ui.unmount();
});

test('manual refresh bypasses the cache for only the currently selected history page', async () => {
  const next = {}, ui = host(baseProps(), args => args.cursor === next ? page([row(2)]) : page([row()], { nextCursor: next }));
  await ui.settle(); button(ui, '更早记录').onClick(); await ui.settle();
  button(ui, '刷新领取记录').onClick(); await ui.settle();
  assert.equal(ui.reads.at(-1).cursor, next); assert.equal(ui.reads.at(-1).refresh, true);
  assert.equal(ui.reads.length, 3); assert.match(text(ui.tree), /第 2 页/); ui.unmount();
});

test('empty scanned range with continuation never says the deployment has no withdrawal history', async () => {
  const next = { before: 15000 }, ui = host(baseProps(), args => args.cursor ? page([row(3)]) : page([], { nextCursor: next, complete: false }));
  await ui.settle(); assert.match(text(ui.tree), /本次扫描范围内暂无领取记录/);
  assert.doesNotMatch(text(ui.tree), /当前正式部署暂无/); assert.equal(button(ui, '更早记录').disabled, false);
  button(ui, '更早记录').onClick(); await ui.settle(); assert.match(text(ui.tree), new RegExp(row(3).administrator)); ui.unmount();
});

test('read failure retains displayed records, does not advance page and retries the failed cursor', async () => {
  const next = { block: 18000 }, pending = deferred(); let failed = false;
  const ui = host(baseProps(), args => {
    if (args.cursor === null) return page([row()], { nextCursor: next, complete: false });
    if (!failed) { failed = true; return pending.promise; }
    return page([row(2)]);
  });
  await ui.settle(); button(ui, '更早记录').onClick(); ui.render();
  assert.equal(button(ui, '更早记录').disabled, true); assert.equal(button(ui, '刷新领取记录').disabled, true);
  assert.match(text(ui.tree), new RegExp(row().administrator));
  pending.reject(Error('RPC busy')); await ui.settle();
  assert.match(text(ui.tree), /RPC busy/); assert.match(text(ui.tree), /已显示的记录仍保留/); assert.match(text(ui.tree), /第 1 页/);
  button(ui, '重试读取').onClick(); await ui.settle();
  assert.equal(ui.reads.at(-1).cursor, next); assert.match(text(ui.tree), /第 2 页/);
  assert.equal(ui.reads.at(-1).refresh, true);
  assert.doesNotMatch(text(ui.tree), /RPC busy/); ui.unmount();
});

test('automatic refresh is visible-first-page only and never overlaps an active read', async () => {
  const next = {}, pending = deferred(); let hold = false;
  const ui = host(baseProps(), args => hold ? pending.promise : args.cursor === next ? page([row(2)]) : page([row()], { nextCursor: next }));
  await ui.settle(); const timer = ui.intervals[0]; assert.equal(ui.intervals.length, 1); assert.equal(timer.ms, 30000);
  ui.document.visibilityState = 'hidden'; timer.fn(); await ui.settle(); assert.equal(ui.reads.length, 1);
  ui.document.visibilityState = 'visible'; timer.fn(); await ui.settle(); assert.equal(ui.reads.length, 2);
  button(ui, '更早记录').onClick(); await ui.settle(); const olderReads = ui.reads.length;
  timer.fn(); await ui.settle(); assert.equal(ui.reads.length, olderReads, 'historical page is stable');
  button(ui, '返回最新').onClick(); await ui.settle(); hold = true;
  timer.fn(); ui.render(); const firstPending = ui.reads.length; timer.fn(); timer.fn();
  assert.equal(ui.reads.length, firstPending); pending.resolve(page([row()])); await ui.settle();
  ui.unmount(); assert.equal(ui.intervals.length, 0);
});

test('equivalent cloned deployment config and parent busy changes preserve the current read', async () => {
  const pending = deferred(), props = baseProps(), ui = host(props, () => pending.promise);
  ui.render({ ...props, disabled: true, config: { ...config, manifest: { ...config.manifest,
    codehash: { ...config.manifest.codehash }, freshAuthority: { ...config.manifest.freshAuthority } } } });
  assert.equal(ui.reads.length, 1); assert.equal(ui.reads[0].signal.aborted, false);
  pending.resolve(page([row()])); await ui.settle(); assert.match(text(ui.tree), new RegExp(row().administrator));
  assert.equal(button(ui, '刷新领取记录').disabled, false, 'parent fee-action state does not lock history'); ui.unmount();
});

test('deployment, authority code, account, wallet and provider changes abort old reads and isolate late results', async () => {
  const updates = [
    props => ({ ...props, config: { ...config, factory: address(30) } }),
    props => ({ ...props, config: { ...config, manifest: { ...config.manifest, freshAuthority: { codehash: hash(30) } } } }),
    props => ({ ...props, account: address(31) }),
    props => ({ ...props, wallet: {} }),
    props => ({ ...props, provider: {} }),
  ];
  for (const update of updates) {
    const stale = deferred(), props = baseProps(), ui = host(props, (_args, count) => count === 1 ? stale.promise : page([row(2)]));
    ui.render(update(props)); await ui.settle();
    assert.equal(ui.reads[0].signal.aborted, true); assert.equal(ui.reads.length, 2);
    stale.resolve(page([row()])); await ui.settle();
    assert.match(text(ui.tree), new RegExp(row(2).administrator)); assert.doesNotMatch(text(ui.tree), new RegExp(row().administrator));
    assert.equal(button(ui, '刷新领取记录').disabled, false); ui.unmount();
  }
});

test('confirmed collection refresh jumps to newest and supersedes a pending older page', async () => {
  const old = deferred(), newest = deferred(), next = {}, props = baseProps();
  const ui = host(props, (args, count) => count === 1 ? page([row()], { nextCursor: next }) : args.cursor === next ? old.promise : newest.promise);
  await ui.settle(); button(ui, '更早记录').onClick(); ui.render();
  ui.render({ ...props, refreshKey: 1 }); assert.equal(ui.reads.at(-1).cursor, null);
  assert.equal(ui.reads.at(-1).refresh, true, 'a verified collection bypasses the cached newest page');
  assert.equal(ui.reads[1].signal.aborted, true);
  old.resolve(page([row(2)])); await ui.settle();
  assert.equal(button(ui, '刷新领取记录').disabled, true, 'old finally cannot release the newest read');
  newest.resolve(page([row(3)])); await ui.settle();
  assert.match(text(ui.tree), /第 1 页/); assert.match(text(ui.tree), new RegExp(row(3).administrator));
  assert.doesNotMatch(text(ui.tree), new RegExp(row(2).administrator)); ui.unmount();
});

test('unmount aborts pending work and obsolete timers cannot launch another read', async () => {
  const pending = deferred(), ui = host(baseProps(), () => pending.promise), timer = ui.intervals[0];
  ui.unmount(); assert.equal(ui.reads[0].signal.aborted, true); assert.equal(ui.intervals.length, 0);
  timer.fn(); pending.resolve(page([row()])); await turn(); await turn(); assert.equal(ui.reads.length, 1);
});

test('initial error and verified empty history have distinct states', async () => {
  const props = baseProps(); let failure = true;
  const ui = host(props, () => { if (failure) throw Error('history unavailable'); return page([]); });
  await ui.settle(); assert.match(text(ui.tree), /领取记录尚未读取成功/); assert.match(text(ui.tree), /history unavailable/);
  assert.doesNotMatch(text(ui.tree), /当前正式部署暂无/);
  failure = false; button(ui, '重试读取').onClick(); await ui.settle();
  assert.match(text(ui.tree), /当前正式部署暂无已确认的手续费领取记录/); assert.equal(button(ui, '更早记录').disabled, true); ui.unmount();
});

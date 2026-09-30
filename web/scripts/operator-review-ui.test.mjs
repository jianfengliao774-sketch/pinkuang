import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { transform, loadBindings } from 'next/dist/build/swc/index.js';
import * as ethers from 'ethers';
import * as view from '../lib/live-view.mjs';

// Exercise the actual JSX event handlers with deterministic hook lifecycle and
// deferred read fixtures. No browser, wallet, RPC or signature is used here.
const require = createRequire(import.meta.url);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const source = name => readFile(new URL(`../components/${name}.jsx`, import.meta.url), 'utf8');
async function compile(name, extra = '') {
  const result = await transform(await source(name) + extra, { filename: `${name}.jsx`,
    jsc: { parser: { syntax: 'ecmascript', jsx: true }, target: 'es2022', transform: { react: { runtime: 'automatic' } } },
    module: { type: 'commonjs' } });
  return result.code;
}
await loadBindings();
const [requestsCode, consoleCode] = await Promise.all([
  compile('SaleReviewRequests', '\nexport { RequestsPage };'), compile('FreshAuthorityConsole'),
]);

function host(code, exportName, props, modules = {}) {
  const slots = [], effects = [], intervals = new Map(); let position = 0, tree, disposed = false;
  const hooks = {
    useState(initial) {
      const at = position++;
      if (!slots[at]) slots[at] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[at].value, value => { if (!disposed) slots[at].value = typeof value === 'function' ? value(slots[at].value) : value; }];
    },
    useRef(initial) { const at = position++; return slots[at] ??= { current: initial }; },
    useEffect(fn, deps) {
      const at = position++, previous = slots[at];
      if (!previous || deps.some((dep, index) => dep !== previous.deps[index])) {
        effects.push(() => { previous?.cleanup?.(); slots[at] = { deps, cleanup: fn() }; });
      }
    },
  };
  const exported = { exports: {} };
  const defaults = { react: hooks, ethers, '../lib/live-view.mjs': view,
    '../lib/display-snapshot.mjs': { readDisplaySnapshot: () => null, writeDisplaySnapshot: () => true },
    '../lib/authority-client.mjs': { authorityActionStatus: async () => ({ status: 'idle' }) },
    './SaleReviewRequests': { __esModule: true, default: function RequestList() {} } };
  new Function('require', 'module', 'exports', 'window', 'document', 'setInterval', 'clearInterval', code)(
    name => modules[name] ?? defaults[name] ?? require(name), exported, exported.exports,
    { sessionStorage: {} }, { visibilityState: 'visible' },
    (fn, ms) => { const id = {}; intervals.set(id, { fn, ms }); return id; }, id => intervals.delete(id));
  const Component = exported.exports[exportName];
  const result = {
    get tree() { return tree; }, get intervals() { return [...intervals.values()]; },
    render(next = props) { props = next; position = 0; tree = Component(props); while (effects.length) effects.shift()(); return tree; },
    async settle() { for (let i = 0; i < 4; i++) { await turn(); result.render(); } },
    unmount() { disposed = true; for (const slot of slots) slot?.cleanup?.(); },
  };
  result.render(); return result;
}
const elements = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree)
  ? tree.flatMap(elements) : [tree, ...elements(tree.props?.children)];
const text = tree => tree == null || typeof tree === 'boolean' ? '' : Array.isArray(tree)
  ? tree.map(text).join('') : typeof tree === 'object' ? text(tree.props?.children) : String(tree);
function button(ui, label) {
  const found = elements(ui.tree).find(item => item.type === 'button' && text(item) === label);
  assert(found, `Missing button: ${label}`); return found.props;
}
const address = end => `0x${end.toString(16).padStart(40, '0')}`;
const config = { stage: 'fresh-active', factory: address(1), shareMarket: address(2), portfolioMarket: address(3), authority: address(4) };
const application = overrides => ({ key: 'pool:one:3', kind: 'pool', project: address(5), pool: address(5),
  proposalId: 3n, tokenId: 13043n, proposer: address(6), priceWei: 5000000000000001n,
  referencePriceWei: 9000000000000001n, recordedReferencePriceWei: 9000000000000000n,
  yesShares: 60n, requiredYesShares: 51n, yesCount: 2n, requiredYesCount: 2n,
  endsAt: 1900000000n, passed: true, status: 'pending', canReview: true, ...overrides });
const page = (items, overrides = {}) => ({ items, projectsRead: 1, nextCursor: null, errors: [], cursor: 0, ...overrides });
function requestHost(options = {}) {
  const row = options.row || application(), calls = [], reads = [], select = [];
  const props = { config, provider: { request: async () => assert.fail('Unexpected real RPC') }, account: address(7),
    scope: 'pool', identity: 'fixture', disabled: false, refreshKey: 0,
    onReview: async (...args) => { calls.push(args); return { status: 'confirmed' }; },
    onSelect: item => select.push(item), ...options.props };
  const ui = host(requestsCode, 'RequestsPage', props, {
    '../lib/sale-review-requests.mjs': {
      readSaleReviewRequests: async args => { reads.push(args); return options.read ? options.read(args) : page([row]); },
      refreshSaleReviewRequest: async args => options.refresh ? options.refresh(args) : row,
    },
    ...(options.cache ? { '../lib/display-snapshot.mjs': { readDisplaySnapshot: () => options.cache, writeDisplaySnapshot: () => true } } : {}),
  });
  return { ui, calls, reads, props, select, row };
}

test('review and fee panels mount only their own forms and reads', async () => {
  for (const mode of ['review', 'fees']) {
    const ui = host(consoleCode, 'default', { config, account: address(7), wallet: {}, mode });
    await ui.settle();
    const nodes = elements(ui.tree), hasInbox = nodes.some(node => node.type?.name === 'RequestList');
    assert.equal(hasInbox, mode === 'review');
    assert.equal(nodes.some(node => node.type === 'textarea'), mode === 'fees');
    assert.equal(text(ui.tree).includes('更新 Firsto 市场参考价'), mode === 'review');
    assert.equal(text(ui.tree).includes('签名领取到当前管理员钱包'), mode === 'fees');
    ui.unmount();
  }
});

test('inbox displays exact application identity and five-decimal amounts; approval preserves original Wei', async () => {
  const { ui, calls, select } = requestHost(); await ui.settle();
  assert.match(text(ui.tree), /#13043/); assert.match(text(ui.tree), /0\.00500 BNB/);
  button(ui, '查看申请').onClick(); ui.render();
  assert.equal(select.length, 1); assert.equal(button(ui, '签名批准').disabled, false);
  button(ui, '签名批准').onClick(); await ui.settle();
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'reviewSale');
  assert.equal(calls[0][1].priceWei, '5000000000000001');
  assert.equal(calls[0][1].proposalId, '3'); assert.equal(calls[0][1].pool, address(5));
  assert.equal(calls[0][1].approved, true); ui.unmount();
});

test('display cache is immediately visible but never enables review before current data arrives', async () => {
  const pending = deferred();
  const { ui, calls } = requestHost({ cache: page([application()]), read: () => pending.promise });
  assert.match(text(ui.tree), /#13043/); assert.match(text(ui.tree), /上次读取/);
  button(ui, '查看申请').onClick(); ui.render();
  assert.equal(button(ui, '签名批准').disabled, true);
  button(ui, '签名批准').onClick(); await turn(); assert.equal(calls.length, 0);
  pending.resolve(page([application()])); await ui.settle(); ui.unmount();
});

test('changed reference is shown for renewed review instead of signing stale terms', async () => {
  const { ui, calls } = requestHost({ refresh: () => application({ referencePriceWei: 10000000000000000n }) });
  await ui.settle(); button(ui, '查看申请').onClick(); ui.render();
  button(ui, '签名批准').onClick(); await ui.settle();
  assert.equal(calls.length, 0); assert.match(text(ui.tree), /已更新详情/); assert.match(text(ui.tree), /0\.01000 BNB/); ui.unmount();
});

test('wallet/page unmount cancels a pending approval read without calling the signing action', async () => {
  const pending = deferred(); const { ui, calls } = requestHost({ refresh: () => pending.promise });
  await ui.settle(); button(ui, '查看申请').onClick(); ui.render();
  button(ui, '签名批准').onClick(); ui.unmount(); pending.resolve(application());
  await turn(); await turn(); assert.equal(calls.length, 0); assert.equal(ui.intervals.length, 0);
});

test('permissions changing during approval read prevent action', async () => {
  const pending = deferred(); const { ui, calls, props } = requestHost({ refresh: () => pending.promise });
  await ui.settle(); button(ui, '查看申请').onClick(); ui.render();
  button(ui, '签名批准').onClick(); ui.render({ ...props, disabled: true });
  pending.resolve(application()); await ui.settle();
  assert.equal(calls.length, 0); assert.match(text(ui.tree), /管理员或交易状态已变化/); ui.unmount();
});

test('a delayed old page read cannot replace a newer refresh', async () => {
  const pending = deferred(); let count = 0;
  const { ui, props } = requestHost({ read: () => ++count === 1 ? pending.promise : page([application({ tokenId: 42n })]) });
  ui.render({ ...props, refreshKey: 1 }); await ui.settle(); assert.match(text(ui.tree), /#42/);
  pending.resolve(page([application()])); await ui.settle();
  assert.match(text(ui.tree), /#42/); assert.doesNotMatch(text(ui.tree), /#13043/); ui.unmount();
});

test('status refresh cancels an approval preflight and its late completion cannot unlock a newer action', async () => {
  const first = deferred(), second = deferred(); let attempts = 0;
  const { ui, props, calls, reads } = requestHost({ refresh: () => ++attempts === 1 ? first.promise : second.promise });
  await ui.settle(); button(ui, '查看申请').onClick(); ui.render();
  button(ui, '签名批准').onClick(); ui.render();
  assert.equal(button(ui, '正在处理…').disabled, true);
  ui.render({ ...props, refreshKey: 1 }); await ui.settle();
  assert.equal(reads.length, 2, 'a fresh directory read starts without the abandoned action lock');
  assert.equal(button(ui, '查看申请').disabled, false);
  button(ui, '查看申请').onClick(); ui.render();
  assert.equal(button(ui, '签名批准').disabled, false);
  button(ui, '签名批准').onClick(); ui.render(); assert.equal(attempts, 2);
  first.resolve(application()); await ui.settle();
  assert.equal(calls.length, 0, 'the cancelled preflight never calls signing');
  assert.equal(button(ui, '正在处理…').disabled, true, 'old finally cannot unlock the new preflight');
  assert.equal(button(ui, '查看申请').disabled, true);
  second.resolve(application()); await ui.settle();
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'reviewSale');
  assert.equal(button(ui, '查看申请').disabled, false); ui.unmount();
});

test('pagination and 30-second refresh stay on the selected directory page', async () => {
  const { ui, reads } = requestHost({ read: args => page([application()], { cursor: args.cursor, nextCursor: args.cursor === 0 ? 10 : null }) });
  await ui.settle(); button(ui, '查看后续项目申请').onClick(); await ui.settle();
  assert.equal(reads.at(-1).cursor, 10); assert.equal(ui.intervals[0].ms, 30000);
  ui.intervals[0].fn(); await ui.settle(); assert.equal(reads.at(-1).cursor, 10);
  button(ui, '刷新申请').onClick(); await ui.settle(); assert.equal(reads.at(-1).cursor, 10); ui.unmount();
});

test('read failures preserve cached records and are distinct from no applications', async () => {
  const { ui, calls } = requestHost({ cache: page([application()]), read: async () => { throw Error('temporary RPC failure'); } });
  await ui.settle(); assert.match(text(ui.tree), /#13043/); assert.match(text(ui.tree), /temporary RPC failure/);
  button(ui, '查看申请').onClick(); ui.render(); assert.equal(button(ui, '签名批准').disabled, true);
  assert.equal(calls.length, 0); ui.unmount();
});

test('wallet, deployment and application scope changes produce distinct inbox identities', () => {
  const props = { config, account: address(7), provider: {}, disabled: false };
  const ui = host(requestsCode, 'default', props, { '../lib/sale-review-requests.mjs': {} });
  const key = () => elements(ui.tree).find(node => node.type?.name === 'RequestsPage').key;
  const first = key();
  ui.render({ ...props, account: address(8) }); assert.notEqual(key(), first);
  ui.render({ ...props, config: { ...config, factory: address(9) } }); assert.notEqual(key(), first);
  ui.render(props); assert.equal(key(), first);
  button(ui, '预算项目出售申请').onClick(); ui.render(props); assert.notEqual(key(), first); ui.unmount();
});

test('repeated clicks while the selected application is being re-read submit once', async () => {
  const pending = deferred(); let refreshes = 0;
  const { ui, calls } = requestHost({ refresh: () => { refreshes++; return pending.promise; } });
  await ui.settle(); button(ui, '查看申请').onClick(); ui.render();
  const approve = button(ui, '签名批准').onClick;
  approve(); approve(); assert.equal(refreshes, 1);
  pending.resolve(application()); await ui.settle(); assert.equal(calls.length, 1); ui.unmount();
});

test('expired, rejected and above-reference applications are visible but not reviewable', async () => {
  for (const status of ['expired', 'rejected', 'no-review', 'reference-missing', 'review-unavailable']) {
    const { ui, calls } = requestHost({ row: application({ status, canReview: false }) });
    await ui.settle(); button(ui, '查看申请').onClick(); ui.render();
    assert.equal(button(ui, '签名批准').disabled, true);
    assert.equal(button(ui, '签名驳回').disabled, true); assert.equal(calls.length, 0); ui.unmount();
  }
});

test('leaving the review console during relay-status lookup cannot invoke its action', async () => {
  const pending = deferred(), actions = []; let reads = 0;
  const ui = host(consoleCode, 'default', { config, account: address(7), wallet: {}, mode: 'review',
    onAction: async (...args) => actions.push(args) }, {
    '../lib/authority-client.mjs': { authorityActionStatus: () => ++reads === 1 ? Promise.resolve({ status: 'idle' }) : pending.promise },
  });
  await ui.settle();
  const inbox = elements(ui.tree).find(node => node.type?.name === 'RequestList');
  const processing = inbox.props.onReview('reviewSale', { proposalId: '3' });
  ui.unmount(); pending.resolve({ status: 'idle' }); await processing; assert.equal(actions.length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { transform, loadBindings } from 'next/dist/build/swc/index.js';
import * as ethers from 'ethers';
import * as view from '../lib/live-view.mjs';
import { collectFeeBatches } from '../lib/fee-collection-flow.mjs';

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
const [requestsCode, consoleCode, feeCode] = await Promise.all([
  compile('SaleReviewRequests', '\nexport { RequestsPage };'), compile('FreshAuthorityConsole'), compile('FeeCollection'),
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
  const exported = { exports: {} }, document = { visibilityState: 'visible' };
  const defaults = { react: hooks, ethers, '../lib/live-view.mjs': view,
    '../lib/display-snapshot.mjs': { readDisplaySnapshot: () => null, writeDisplaySnapshot: () => true },
    '../lib/authority-client.mjs': { authorityActionStatus: async () => ({ status: 'idle' }) },
    './SaleReviewRequests': { __esModule: true, default: function RequestList() {} },
    './FirstoSaleReferenceAction': { __esModule: true, default: function ReferenceAction() {} },
    './FeeCollectionHistory.jsx': { __esModule: true, default: function HistoryPane() {} },
    './FeeCollection': { __esModule: true, default: function FeePane() {} } };
  new Function('require', 'module', 'exports', 'window', 'document', 'setInterval', 'clearInterval', code)(
    name => modules[name] ?? defaults[name] ?? require(name), exported, exported.exports,
    { sessionStorage: {} }, document,
    (fn, ms) => { const id = {}; intervals.set(id, { fn, ms }); return id; }, id => intervals.delete(id));
  const Component = exported.exports[exportName];
  const result = {
    get tree() { return tree; }, get intervals() { return [...intervals.values()]; }, document,
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
    assert.equal(nodes.some(node => node.type?.name === 'FeePane'), mode === 'fees');
    assert.equal(nodes.some(node => node.type === 'textarea'), false);
    assert.equal(text(ui.tree).includes('后台自动市场参考价'), mode === 'review');
    assert.equal(nodes.some(node => node.type?.name === 'ReferenceAction'), false);
    if (mode === 'review') {
      nodes.find(node => node.type?.name === 'RequestList').props.onSelect({ pool: address(5) });
      ui.render();
      assert.equal(elements(ui.tree).some(node => node.type?.name === 'ReferenceAction'), true);
    }
    assert.equal(text(ui.tree).includes('签名领取到当前管理员钱包'), false);
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

const feeReceipt = (value, status = 'confirmed') => ({ kind: 'claimFees', hash: `0x${BigInt(value).toString(16).padStart(64, '0')}`, status });
const feePlan = () => ({ totalBnbWei: 5000000000000001n, totalBemWei: 40000000000000001n,
  sourceCount: 5, blockNumber: 123456n,
  batches: [{ markets: [address(2), address(3)], pools: [address(21), address(22)] }, { markets: [], pools: [address(23)] }] });
function feeHost(options = {}) {
  let clock = 0;
  const calls = [], reads = [], statuses = [], waits = [];
  const props = { config, provider: { request: async () => assert.fail('Unexpected real RPC') },
    account: address(7), wallet: {}, disabled: false, status: { status: 'idle' }, refreshKey: 0,
    onAction: async (...args) => { calls.push(args); return options.action ? options.action(...args) : feeReceipt(calls.length); },
    onStatus: value => statuses.push(value), ...options.props };
  const ui = host(feeCode, 'default', props, {
    '../lib/fee-collection.mjs': { readFeeCollection: async args => { reads.push(args); return options.read ? options.read(args) : feePlan(); } },
    '../lib/fee-collection-flow.mjs': { collectFeeBatches: input => collectFeeBatches({ ...input,
      now: () => clock, wait: async (ms, signal) => { waits.push(ms); clock += ms; if (options.wait) await options.wait(ms, signal); } }) },
    '../lib/authority-client.mjs': { authorityActionStatus: async (...args) => options.status ? options.status(...args) : assert.fail('Unexpected status poll') },
  });
  return { ui, props, calls, reads, statuses, waits };
}

test('fee pane discovers all supplied sources automatically, without address input, and formats five decimals', async () => {
  const { ui, calls, reads } = feeHost(); await ui.settle();
  assert.equal(reads.length, 1, 'initial refresh effects share one read');
  assert.equal(elements(ui.tree).some(node => ['input', 'select', 'textarea'].includes(node.type)), false);
  assert.match(text(ui.tree), /0\.00500 BNB/); assert.match(text(ui.tree), /0\.04000 BEM/);
  assert.match(text(ui.tree), /5 个有余额来源/);
  const history = () => elements(ui.tree).find(node => node.type?.name === 'HistoryPane')?.props;
  assert.equal(history().refreshKey, '0:0');
  assert.equal(history().account, address(7));
  button(ui, '一键归集手续费').onClick(); await ui.settle();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call[1]), feePlan().batches.map(batch => ({ ...batch, recipient: address(7) })));
  assert.equal(history().refreshKey, '0:1', 'confirmed collection refreshes its independent history');
  assert.match(text(ui.tree), /已完成 2 批归集/); ui.unmount();
});

test('fee balance polling runs every 30 seconds only while the pane is visible and mounted', async () => {
  const { ui, reads } = feeHost(); await ui.settle();
  assert.equal(ui.intervals.length, 1); assert.equal(ui.intervals[0].ms, 30000);
  ui.document.visibilityState = 'hidden'; ui.intervals[0].fn(); await ui.settle(); assert.equal(reads.length, 1);
  ui.document.visibilityState = 'visible'; ui.intervals[0].fn(); await ui.settle(); assert.equal(reads.length, 2);
  ui.unmount(); assert.equal(ui.intervals.length, 0);
});

test('double-clicking one-click collection cannot start a second current-balance scan or action', async () => {
  const pending = deferred(); let reading = 0;
  const { ui, calls, reads } = feeHost({ read: () => ++reading === 1 ? feePlan() : reading === 2 ? pending.promise : feePlan() });
  await ui.settle(); const click = button(ui, '一键归集手续费').onClick;
  click(); click(); ui.render(); assert.equal(reads.length, 2); assert.equal(button(ui, '正在归集…').disabled, true);
  pending.resolve(feePlan()); await ui.settle(); assert.equal(calls.length, 2); ui.unmount();
});

test('leaving fee pane or changing permissions before current balances arrive prevents signatures', async () => {
  for (const leave of [false, true]) {
    const pending = deferred(); let reading = 0;
    const { ui, props, calls } = feeHost({ read: () => ++reading === 2 ? pending.promise : feePlan() });
    await ui.settle(); button(ui, '一键归集手续费').onClick();
    if (leave) ui.unmount(); else ui.render({ ...props, disabled: true });
    pending.resolve(feePlan()); if (leave) { await turn(); await turn(); } else await ui.settle();
    assert.equal(calls.length, 0); ui.unmount();
  }
});

test('a permission change between confirmed batches prevents the next signature', async () => {
  let context;
  context = feeHost({ wait: async () => context.ui.render({ ...context.props, disabled: true }) });
  await context.ui.settle(); button(context.ui, '一键归集手续费').onClick(); await context.ui.settle();
  assert.equal(context.calls.length, 1); assert.match(text(context.ui.tree), /已完成 1 \/ 2 批/);
  context.ui.unmount();
});

test('cloned config and own parent busy preserve collection and later batches use the latest action callback', async () => {
  const response = deferred(), laterCalls = []; let context;
  context = feeHost({ action: () => response.promise });
  await context.ui.settle(); button(context.ui, '一键归集手续费').onClick(); await context.ui.settle();
  assert.equal(context.calls.length, 1);
  const signal = context.reads[1].signal;
  context.ui.render({ ...context.props, config: { ...context.props.config }, disabled: true }); await context.ui.settle();
  assert.equal(signal.aborted, false); assert.equal(context.reads.length, 2);
  context.ui.render({ ...context.props, config: { ...context.props.config }, disabled: false,
    onAction: async (...args) => { laterCalls.push(args); return feeReceipt(2); } });
  response.resolve(feeReceipt(1)); await context.ui.settle();
  assert.equal(context.calls.length, 1, 'the initial callback is not reused after a parent render');
  assert.deepEqual(laterCalls, [['claimFees', { ...feePlan().batches[1], recipient: address(7) }]]);
  assert.match(text(context.ui.tree), /已完成 2 批归集/);
  context.ui.unmount();
});

test('equivalent config reconstruction does not abort or duplicate an in-flight fee balance read', async () => {
  const pending = deferred(); const { ui, props, reads } = feeHost({ read: () => pending.promise });
  ui.render({ ...props, config: { ...props.config } }); ui.render({ ...props, config: { ...props.config } });
  assert.equal(reads.length, 1); assert.equal(reads[0].signal.aborted, false);
  pending.resolve(feePlan()); await ui.settle(); assert.match(text(ui.tree), /0\.00500 BNB/);
  assert.equal(reads.length, 1); ui.unmount();
});

test('semantic factory change aborts the old signed batch sequence and immediately reads the new deployment', async () => {
  const response = deferred();
  const { ui, props, calls, reads, statuses } = feeHost({ action: () => response.promise });
  await ui.settle(); button(ui, '一键归集手续费').onClick(); await ui.settle();
  assert.equal(calls.length, 1); const signal = reads[1].signal;
  ui.render({ ...props, config: { ...props.config, factory: address(88) } }); await ui.settle();
  assert.equal(signal.aborted, true); assert.equal(reads.length, 3);
  assert.equal(reads[2].config.factory, address(88));
  response.resolve(feeReceipt(1)); await ui.settle();
  assert.equal(calls.length, 1, 'a previous deployment must not request a second batch');
  assert.equal(statuses.length, 0, 'its late receipt must not update new deployment state');
  assert.doesNotMatch(text(ui.tree), /已完成 2 批归集/);
  assert.equal(button(ui, '一键归集手续费').disabled, false); ui.unmount();
});

test('later collection failure retains its explanation and prior receipts after balance refresh', async () => {
  let actions = 0;
  const { ui, calls, reads } = feeHost({ action: () => feeReceipt(++actions, actions === 1 ? 'confirmed' : 'failed') });
  await ui.settle(); button(ui, '一键归集手续费').onClick(); await ui.settle();
  assert.equal(calls.length, 2); assert.equal(reads.length, 3);
  assert.match(text(ui.tree), /第 2 批归集失败/); assert.match(text(ui.tree), /已完成 1 \/ 2 批/);
  assert(elements(ui.tree).some(node => node.type === 'a' && node.props.href.endsWith(feeReceipt(1).hash)));
  ui.unmount();
});

test('identity change during cancelled balance scan starts new pane read immediately and ignores old results', async () => {
  const pending = deferred(); let reading = 0;
  const { ui, props, calls, reads } = feeHost({ read: () => ++reading === 2 ? pending.promise : feePlan() });
  await ui.settle(); button(ui, '一键归集手续费').onClick(); ui.render();
  ui.render({ ...props, account: address(8) }); await ui.settle();
  assert.equal(reads.length, 3); assert.match(text(ui.tree), /0\.00500 BNB/);
  pending.resolve({ ...feePlan(), totalBnbWei: 999000000000000000000n }); await ui.settle();
  assert.doesNotMatch(text(ui.tree), /999\.00000/); assert.equal(calls.length, 0);
  assert.equal(button(ui, '一键归集手续费').disabled, false); ui.unmount();
});

test('status refresh during collection cannot duplicate the balance read or cancel the active sequence', async () => {
  const pending = deferred(); let reading = 0;
  const { ui, props, calls, reads } = feeHost({ read: () => ++reading === 2 ? pending.promise : feePlan() });
  await ui.settle(); button(ui, '一键归集手续费').onClick();
  ui.render({ ...props, refreshKey: 1 }); await ui.settle(); assert.equal(reads.length, 2);
  pending.resolve(feePlan()); await ui.settle(); assert.equal(calls.length, 2); ui.unmount();
});

test('direct fee refresh propagates revision and manual/confirmed invalidation only to business reads', async () => {
  const { ui, props, reads } = feeHost({ props: { config: { ...config, displayOnly: true } } });
  await ui.settle();
  assert.equal(reads[0].account, props.account); assert.equal(reads[0].refreshToken, 0); assert.equal(reads[0].force, false);
  button(ui, '刷新手续费余额').onClick(); await ui.settle(); assert.equal(reads[1].force, true);
  ui.render({ ...props, refreshKey: 7 }); await ui.settle();
  assert.equal(reads[2].refreshToken, 7); assert.equal(reads[2].force, true);
  button(ui, '一键归集手续费').onClick(); await ui.settle();
  assert.equal(reads.at(-1).force, true, 'confirmed collection refreshes business balances'); ui.unmount();
});

test('direct review refresh carries the account/revision and manual or completed review bypasses display reuse', async () => {
  const { ui, props, reads } = requestHost({ props: { config: { ...config, displayOnly: true } } });
  await ui.settle();
  assert.equal(reads[0].account, props.account); assert.equal(reads[0].refreshToken, 0); assert.equal(reads[0].force, false);
  button(ui, '刷新申请').onClick(); await ui.settle(); assert.equal(reads[1].force, true);
  ui.render({ ...props, refreshKey: 7 }); await ui.settle(); assert.equal(reads[2].refreshToken, 7);
  button(ui, '查看申请').onClick(); await ui.settle(); button(ui, '签名批准').onClick(); await ui.settle();
  assert.equal(reads.at(-1).force, true); ui.unmount();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { loadBindings, transform } from 'next/dist/build/swc/index.js';
import * as refund from '../lib/funding-refund.mjs';
import * as amounts from '../lib/amount-display.mjs';
const require = createRequire(import.meta.url); await loadBindings();
const compile = async (file, modules) => {
  const { code } = await transform(await readFile(new URL(`../components/${file}`, import.meta.url), 'utf8'), {
    filename: file, jsc: { parser: { syntax: 'ecmascript', jsx: true }, target: 'es2022', transform: { react: { runtime: 'automatic' } } }, module: { type: 'commonjs' } });
  const module = { exports: {} }; new Function('require', 'module', 'exports', code)(name => modules[name] ?? require(name), module, module.exports);
  return module.exports.default;
};
const Notice = await compile('FundingRefundNotice.jsx', { '../lib/funding-refund.mjs': refund, '../lib/amount-display.mjs': amounts });
const a = n => `0x${n.toString(16).padStart(40, '0')}`;
const p = state => ({ pool: a(1), kind: 'single', name: 'TapeOut', tokenId: '7223', state, status: state === 0n ? 'Funding' : 'Funded',
  trusted: true, shares: 50n, bnbOwed: 0n, initialContributedWei: 17000000000000003n, params: { purchaseDeadline: 1500n }, targetAvailability: {
    status: 'unavailable', purchaseMode: 'fixed', chainState: state, originalOwner: a(2), currentOwner: a(3),
    observedBlock: 110, observedBlockHash: `0x${'a'.repeat(64)}`, creationBlock: 100, creationBlockHash: `0x${'b'.repeat(64)}` } });
const nodes = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
const text = node => !node || typeof node !== 'object' ? String(node ?? '') : Array.isArray(node) ? node.map(text).join(' ') : text(node.props?.children);
test('visible refund card preserves exact selected pool and existing transaction readiness gates', () => {
  const calls = [], row = p(0n), props = { row, source: { indexedTimestamp: 1200 }, L: (zh, en) => zh,
    readyFor: () => true, onAction: (...args) => calls.push(args) };
  const tree = Notice(props), button = nodes(tree).find(node => node.type === 'button');
  assert.match(text(tree), /当前认购本金.*0\.0170 BNB/);
  assert.equal(nodes(tree).find(node => node.type === 'b').props.title, '0.017000000000000003 BNB');
  assert.match(text(Notice({ ...props, row: { ...row, initialContributedWei: null } })), /当前认购本金.*—/);
  assert.match(text(Notice({ ...props, source: { stale: true } })), /缓存记录.*核对最新余额/);
  assert.equal(tree.props['data-refund-pool'], row.pool); assert.equal(button.props.disabled, false);
  button.props.onClick(); assert.deepEqual(calls, [['withdrawDeposit', row]]); assert.match(text(tree), /确认后再点击领取 BNB/);
  assert.equal(nodes(Notice({ ...props, blocked: true })).find(node => node.type === 'button').props.disabled, true);
  assert.equal(nodes(Notice({ ...props, readyFor: () => false })).find(node => node.type === 'button').props.disabled, true);
});
test('English Funded card shows deadline and disables early opening, then enables only at the indexed deadline', () => {
  const props = { row: p(1n), source: { indexedTimestamp: 1499 }, L: (zh, en) => en, readyFor: () => true, onAction: () => {} };
  const before = Notice(props); assert.match(text(before), /not automatic or immediate/); assert.match(text(before), /Refund deadline not reached/);
  assert.equal(nodes(before).find(node => node.type === 'button').props.disabled, true);
  assert.equal(nodes(Notice({ ...props, source: { indexedTimestamp: 1500 } })).find(node => node.type === 'button').props.disabled, false);
});
test('notifications expose loaded personal transfer/refund reminders without Telegram binding or signing', async () => {
  let actions = 0;
  const hooks = { useState: initial => [initial, () => {}], useRef: initial => ({ current: initial }), useEffect: () => {} };
  const Notifications = await compile('Notifications.jsx', { react: hooks, './Notifications.module.css': {},
    '../lib/live-transactions.mjs': { authenticate: () => { actions++; throw new Error('must not sign'); } },
    '../lib/notifications.mjs': { notificationHistoryKey: () => null, ownsPurchasedMiner: () => false,
      notificationRequest: () => { actions++; throw new Error('must not request API for local notices'); } } });
  const participantNotices = refund.participantFundingNotices([p(0n)], { account: a(9), positionsAccount: a(9) });
  const tree = Notifications({ account: a(9), locale: 'zh', route: 'notifications', participantNotices,
    positionsHaveMore: true, positionsSource: { stale: true }, onMorePositions: () => {} });
  const local = nodes(tree).find(node => node.props?.['data-participant-notices']); assert(local);
  assert.match(text(local), /不需要绑定 Telegram/); assert.match(text(local), /目标矿机已转移给其他持有人/);
  assert.equal(nodes(local).find(node => node.type === 'a' && node.props.href === `#detail/${a(1)}`).props.href, `#detail/${a(1)}`);
  assert.match(text(local), /加载更多个人项目/); assert.match(text(local), /当前提醒来自缓存记录/); assert.equal(actions, 0);
});

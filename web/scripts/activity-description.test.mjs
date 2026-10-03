import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DESCRIBED_ACTIVITY_EVENTS, describeActivity } from '../lib/activity-description.mjs';
import { activityAmounts } from '../lib/activity-summary.mjs';
import { exportActivityCsv } from '../lib/live-view.mjs';
const account = `0x${'12'.repeat(20)}`, pool = `0x${'34'.repeat(20)}`, tx = `0x${'ab'.repeat(32)}`;
const row = (event, fields = {}) => ({ event, fields, contract: pool, blockNumber: 124, transactionHash: tx });
const fact = (entry, label) => entry.facts.find(item => item.label === label)?.value;

test('all actual public index event types have both language descriptions', () => {
  const source = readFileSync(new URL('../../deploy/server/chain-index/indexer.mjs', import.meta.url), 'utf8');
  const allowlist = source.slice(source.indexOf('const indexedEvents ='), source.indexOf('const topicSets ='));
  const events = [...new Set([...allowlist.matchAll(/'([A-Z][A-Za-z]+)'/g)].map(match => match[1]))].sort();
  assert.deepEqual([...DESCRIBED_ACTIVITY_EVENTS].sort(), events);
  for (const event of events) for (const language of ['zh', 'en']) {
    const entry = describeActivity(row(event), language);
    assert.equal(entry.rawEvent, event);
    assert(entry.description.length > 0, `${event} ${language} must have an explanation`);
    assert.notEqual(entry.description, entry.label);
    assert.notEqual(entry.label, event);
    assert.deepEqual(entry.facts, []); // No made-up actor, amount or timestamp.
    if (language === 'en') assert(!/[\u4e00-\u9fff]/u.test(entry.label + entry.description));
  }
});
test('project creation shows real budget and project identity, not an invented creator or paid balance', () => {
  const entry = describeActivity(row('PortfolioCreated', { portfolio: pool, budgetWei: '1200000000000000000', absoluteCapWei: '300000000000000000', unitCapWei: '100000000000' }));
  assert.equal(entry.label, '创建多矿机项目');
  assert.equal(fact(entry, '募集预算'), '1.20000 BNB');
  assert.equal(fact(entry, '单机总价上限'), '0.30000 BNB');
  assert.match(entry.description, /不是认购付款/);
  assert.deepEqual(entry.facts.map(item => item.label), ['项目', '募集预算', '单机总价上限']);
  const single = describeActivity(row('PoolCreated', { circuitId: '9007199254740993', targetRaise: '1000000000000000000' }));
  assert.equal(fact(single, '矿机编号'), '9007199254740993');
});
test('both member/user ABIs retain exact integers and display BNB / BEM separately', () => {
  for (const key of ['member', 'user']) {
    const subscription = describeActivity(row('Deposited', { [key]: account, shares: '7', amount: '12345000000000000' }));
    assert.equal(fact(subscription, '份数'), '7');
    assert.equal(fact(subscription, '认购款'), '0.01235 BNB');
    const claim = describeActivity(row('BemClaimed', { [key]: account, amount: '123450000' }));
    assert.equal(fact(claim, '已领取'), '1.23450 BEM');
    assert.match(claim.description, /转入领取账户/);
  }
  const trade = describeActivity(row('OrderFilled', { buyer: account, amount: '3', gross: '2000000000000000000', fee: '20000000000000000' }));
  assert.equal(fact(trade, '成交份数'), '3');
  assert.equal(fact(trade, '成交基价'), '2.00000 BNB');
  assert.equal(fact(trade, '卖方费用'), '0.02000 BNB');
});
test('refund, surplus and sale credits are never described as paid to the wallet', () => {
  for (const event of ['DepositWithdrawn', 'PurchaseSurplusSettled', 'SaleProceedsSettled']) {
    const entry = describeActivity(row(event, { user: account, amount: '1000000000000000' }));
    assert.match(entry.description, /尚不代表钱包收到款项/);
    assert.match(describeActivity(row(event), 'en').description, /does not itself pay the wallet/);
  }
  assert.match(describeActivity(row('Failed', { reason: '0' })).description, /未满募/);
  assert.match(describeActivity(row('Failed', { reason: '1' })).description, /未完成采购/);
  assert.match(describeActivity(row('BnbWithdrawn', { user: account, amount: '1000000000000000' })).description, /转入账户/);
  assert.match(describeActivity(row('BnbWithdrawn')).description, /未单独区分/);
});
test('parent allocations and receipts are not personal claims or an assumed successful purchase', () => {
  const acquisition = describeActivity(row('AcquisitionFinalized', { children: '0', spent: '0', officialFee: '0', refundableToMembers: '5000000000000000' }));
  assert.equal(fact(acquisition, '已购矿机数'), '0');
  assert.equal(fact(acquisition, '成员可退余款'), '0.00500 BNB');
  assert.match(acquisition.description, /成员仍需领取/);
  assert(!/购机成功/.test(acquisition.description));
  assert.match(describeActivity(row('BemCollected', { child: pool, received: '500000000' })).description, /转入预算项目/);
  assert.equal(fact(describeActivity(row('BemCollected', { received: '500000000' })), '项目收到'), '5.00000 BEM');
  assert.match(describeActivity(row('ChildSaleSettled')).description, /成员再按权益领取/);
});
test('purchase/sale detail logs identify the same trade and do not double-count or mislabel fees', () => {
  const sale = describeActivity(row('SaleCompleted', { gross: '1000000000000000000', toPlatform: '10000000000000000', toMembers: '990000000000000000', burnedBem: '123450000' }));
  assert.equal(fact(sale, '成交基价'), '1.00000 BNB');
  assert.equal(fact(sale, '销毁'), '1.23450 BEM');
  const firsto = describeActivity(row('FirstoSaleCompleted', { gross: '1000000000000000000', takerFee: '10000000000000000' }));
  assert.equal(fact(firsto, 'Firsto 买方费用'), '0.01000 BNB');
  assert.match(firsto.description, /不是第二次出售/);
  assert.match(describeActivity(row('FirstoPurchased')).description, /不是另一次付款/);
  assert.match(describeActivity(row('Funded')).description, /进入购机阶段/);
  assert.match(describeActivity(row('Purchased')).description, /不代表挖矿已启动/);
});
test('governance decisions require actual boolean values; expiry/cancellation trigger is not guessed', () => {
  assert.equal(fact(describeActivity(row('Voted', { support: false })), '表决'), '反对');
  assert.equal(fact(describeActivity(row('ChildSaleReviewed', { approved: true })), '审核结果'), '通过');
  assert.equal(fact(describeActivity(row('ChildPurchased', { official: false })), '采购来源'), 'Firsto');
  for (const value of ['false', 'true', 0, 1, null]) assert.equal(fact(describeActivity(row('Voted', { support: value })), '表决'), undefined);
  assert.match(describeActivity(row('OrderCancelled')).description, /不区分两种触发方式/);
});
test('share mint/burn logs explain the share change without inventing BNB refunds', () => {
  const zero = `0x${'0'.repeat(40)}`;
  const minted = describeActivity(row('Transfer', { from: zero, to: account, value: '100' }));
  assert.equal(fact(minted, '份数'), '100');
  assert.match(minted.description, /不重复计算/);
  const burned = describeActivity(row('Transfer', { from: account, to: zero, value: '100' }));
  assert.match(burned.description, /未记录退款金额/);
  assert.deepEqual(activityAmounts(row('Transfer', { value: '100' })), []);
});
test('missing, fractional, unsafe, negative and oversized amount fields are not manufactured as zero', () => {
  for (const amount of [undefined, null, '1.2', 9007199254740992, 1, '-1', '01', '1e18', 2n ** 256n]) {
    const entry = describeActivity(row('Deposited', { amount, shares: '2', member: 'not-an-address' }));
    assert.equal(fact(entry, '认购款'), undefined);
    assert.equal(fact(entry, '账户'), undefined);
    assert.equal(fact(entry, '份数'), '2');
  }
  assert.equal(fact(describeActivity(row('Deposited', { amount: 0n })), '认购款'), '0.00000 BNB');
});
test('unknown events stay inspectable and raw CSV retains every original log and exact field', () => {
  for (const event of ['FutureUnknown', 'toString', '__proto__']) assert.equal(describeActivity(row(event)).rawEvent, event);
  const rows = [row('PortfolioCreated', { portfolio: pool, budgetWei: '123456789123456789' }), row('FutureUnknown', { exact: '999999999999999999999' })];
  const before = JSON.stringify(rows);
  rows.forEach(item => describeActivity(item));
  assert.equal(JSON.stringify(rows), before);
  const csv = exportActivityCsv(rows);
  for (const value of ['PortfolioCreated', 'FutureUnknown', pool, tx, '123456789123456789', '999999999999999999999']) assert(csv.includes(value));
});

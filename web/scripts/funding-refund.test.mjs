import test from 'node:test';
import assert from 'node:assert/strict';
import { fundingRefundView, participantFundingNotices } from '../lib/funding-refund.mjs';
import { assetOverview } from '../lib/asset-overview.mjs';
import { projectDirectory } from '../lib/project-directory.mjs';
const a = n => `0x${n.toString(16).padStart(40, '0')}`;
const proof = state => ({ status: 'unavailable', purchaseMode: 'fixed', chainState: state,
  originalOwner: a(2), currentOwner: a(3), observedBlock: 110, observedBlockHash: `0x${'a'.repeat(64)}`,
  creationBlock: 100, creationBlockHash: `0x${'b'.repeat(64)}` });
const row = (changes = {}) => ({ pool: a(1), kind: 'single', name: 'TapeOut', tokenId: '7223', trusted: true,
  state: 0n, status: 'Funding', shares: 40n, bnbOwed: 0n, claimableBEM: 0n, unitPriceWei: 400000000000000n, initialContributedWei: 17000000000000003n,
  params: { fundingDeadline: 1000n, purchaseDeadline: 1500n }, targetAvailability: proof(0n), ...changes });
const source = { indexedTimestamp: 1200, indexedThrough: 110 };
const notices = (rows, extra = {}) => participantFundingNotices(rows, { account: a(9), positionsAccount: a(9), source, ...extra });
test('delisted Funding target preserves personal shares, credits and withdrawal after the funding deadline', () => {
  const p = row(), view = fundingRefundView(p, source);
  assert.equal(projectDirectory([p], []).rows.length, 0);
  const personal = assetOverview({ singlePositions: [p], singleLoaded: true, portfolioLoaded: true });
  assert.equal(personal.rows.length, 1); assert.equal(personal.rows[0].shares, 40n); assert.equal(personal.rows[0].bnbOwed, 0n);
  assert.equal(view.unavailable, true); assert.equal(view.principal, 17000000000000003n); assert.deepEqual(view.actions.map(action => [action.kind, action.ready]), [['withdrawDeposit', true]]);
  assert.match(view.explanation[0], /确认后再点击领取/); assert.match(view.explanation[1], /After confirmation, claim BNB/);
  assert.doesNotMatch(view.title[0], /买走|已售/); assert.equal(notices([p]).length, 1);
});
test('fully funded old pool waits for its exact chain purchase deadline; local clock does not authorize early refunds', () => {
  const p = row({ state: 1n, status: 'Funded', shares: 50n, targetAvailability: proof(1n) });
  const before = fundingRefundView(p, { indexedTimestamp: 1499 });
  assert.equal(before.deadlineReached, false); assert.equal(before.actions[0].kind, 'finalizeFailure'); assert.equal(before.actions[0].ready, false);
  const at = fundingRefundView(p, { indexedTimestamp: 1500 }); assert.equal(at.deadlineReached, true); assert.equal(at.actions[0].ready, true);
  for (const timestamp of [undefined, null, -1, 1.1, 'unknown']) {
    const view = fundingRefundView(p, { indexedTimestamp: timestamp }); assert.equal(view.deadlineReached, null); assert.equal(view.actions[0].ready, false);
  }
  assert.match(before.explanation[0], /不会自动或即时退款/); assert.match(before.explanation[1], /not automatic or immediate/);
  assert.equal(p.state, 1n); assert.equal(p.bnbOwed, 0n); assert.equal(projectDirectory([p], []).rows.length, 0);
});
test('exited zero-share participant retains exact BNB even if remaining subscribers fully fund the pool', () => {
  const wei = 90071992547409930001n;
  for (const [state, status] of [[0n, 'Funding'], [1n, 'Funded']]) {
    const p = row({ state, status, targetAvailability: proof(state), shares: 0n, bnbOwed: wei });
    const view = fundingRefundView(p, source); assert.equal(view.relevant, true); assert.equal(view.bnb, wei);
    assert.deepEqual(view.actions.map(action => action.kind), ['withdrawBnb']); assert.equal(notices([p]).length, 1);
    const personal = assetOverview({ singlePositions: [p], singleLoaded: true, portfolioLoaded: true });
    assert.equal(personal.rows.length, 1); assert.equal(personal.totals.bnbOwed, wei); assert.equal(personal.totals.projectsHeld, 0n);
  }
});
test('refund opening changes the notice to refunds-open and actual BNB claim clears it despite retained historic shares', () => {
  const p = row({ state: 5n, status: 'Refunding', shares: 100n, bnbOwed: 250000000000000001n, targetAvailability: null });
  const view = fundingRefundView(p, source); assert.equal(view.unavailable, false); assert.equal(view.refunding, true);
  assert.equal(view.title[0], '项目已开启退款'); assert.deepEqual(view.actions.map(action => action.kind), ['withdrawBnb']);
  assert.equal(notices([p]).length, 1);
  const claimed = { ...p, bnbOwed: 0n }; assert.equal(fundingRefundView(claimed, source).relevant, false);
  assert.equal(notices([claimed]).length, 0); assert.equal(claimed.shares, 100n);
  assert.equal(fundingRefundView(claimed, source).actions.length, 0, 'never reconstruct a second refund from historic shares × price');
});
test('unknown or inconsistent target evidence never claims a transfer or creates a delisting reminder', () => {
  for (const patch of [null, { ...proof(0n), status: 'unknown' }, { ...proof(0n), currentOwner: a(2) },
    { ...proof(0n), observedBlockHash: null }, { ...proof(0n), chainState: 1n },
    { ...proof(0n), purchaseMode: 'flexible', status: 'not_applicable' }]) {
    const p = row({ targetAvailability: patch }); assert.equal(fundingRefundView(p, source).unavailable, false); assert.equal(notices([p]).length, 0);
  }
  assert.equal(fundingRefundView(row({ trusted: false }), source).relevant, false);
  assert.equal(notices([row({ trusted: false })]).length, 0);
});
test('in-app reminders are account-bound and deduplicated; unknown BNB is never represented as zero', () => {
  const p = row({ bnbOwed: null }); assert.equal(fundingRefundView(p, source).bnb, null);
  assert.equal(notices([p, p]).length, 1); assert.equal(notices([p], { positionsAccount: a(10) }).length, 0);
  assert.equal(notices([p], { account: null }).length, 0); assert.equal(notices([p], { positionsAccount: null }).length, 0);
  assert.equal(notices([row({ shares: 0n, bnbOwed: 0n })]).length, 0);
});

test('subscription principal uses the exact current contract field, never a shares × price estimate', () => {
  const p = row({ initialContributedWei: '90071992547409930001' });
  assert.equal(fundingRefundView(p, source).principal, 90071992547409930001n);
  assert.notEqual(fundingRefundView(p, source).principal, p.shares * p.unitPriceWei);
  for (const value of [undefined, null, -1n, 1.1, 'unknown'])
    assert.equal(fundingRefundView(row({ initialContributedWei: value }), source).principal, null);
  assert.equal(fundingRefundView(row({ shares: 0n, initialContributedWei: 0n, bnbOwed: 100n }), source).principal, 0n);
});

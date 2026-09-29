import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeOverviewActivity, activityAmounts } from '../lib/activity-summary.mjs';
import { exportActivityCsv } from '../lib/live-view.mjs';
const addr = n => `0x${String(n).padStart(40, '0')}`;
const tx = `0x${'ab'.repeat(32)}`;
const row = (event, logIndex, fields, extra = {}) => ({ event, logIndex, fields, blockNumber: 12,
  transactionHash: tx, contract: addr(1), ...extra });
const mint = row('Transfer', 10, { from: addr(0), to: addr(2), value: '5' });
const deposit = row('Deposited', 11, { user: addr(2), shares: '5', amount: '440000000000000' });

test('overview summarizes exact subscription mint; raw logs and CSV stay intact', () => {
  const rows = [deposit, mint];
  assert.deepEqual(summarizeOverviewActivity(rows), [deposit]);
  assert.equal(rows.length, 2);
  assert.match(exportActivityCsv(rows), /Transfer/);
  assert.deepEqual(activityAmounts(deposit), [{ kind: 'amount', amount: 440000000000000n, symbol: 'BNB', decimals: 18 }]);
});
test('standalone transfers and independently paid operations in one tx are not deduplicated', () => {
  const transfer = row('Transfer', 12, { from: addr(2), to: addr(3), value: '5' });
  const sale = row('OrderFilled', 13, { gross: '13', fee: '2' });
  assert.deepEqual(summarizeOverviewActivity([sale, transfer, deposit, mint]), [sale, transfer, deposit]);
  assert.deepEqual(summarizeOverviewActivity([mint]), [mint]);
});
test('mint pairing requires matching contract, recipient, value, tx and preceding log', () => {
  for (const changed of [
    { contract: addr(7) }, { transactionHash: `0x${'cd'.repeat(32)}` }, { blockNumber: 13 }, { logIndex: 12 },
    { fields: { ...mint.fields, to: addr(3) } }, { fields: { ...mint.fields, value: '4' } }, { logIndex: undefined },
  ]) assert.equal(summarizeOverviewActivity([deposit, { ...mint, ...changed }]).length, 2);
});
test('each deposit absorbs one matching mint; budget member field is supported', () => {
  const secondMint = { ...mint, logIndex: 14 };
  const secondDeposit = row('Deposited', 15, { member: addr(2), shares: '5', amount: '440000000000000' });
  assert.deepEqual(summarizeOverviewActivity([secondDeposit, secondMint, deposit, mint]), [secondDeposit, deposit]);
  assert.equal(summarizeOverviewActivity([deposit, mint, { ...mint, logIndex: 9 }]).length, 2);
});
test('amounts use exact known fields/token decimals, with fees kept distinct', () => {
  assert.deepEqual(activityAmounts(row('OrderFilled', 1, { gross: '0', fee: '1' })), [
    { kind: 'gross', amount: 0n, symbol: 'BNB', decimals: 18 }, { kind: 'sellerFee', amount: 1n, symbol: 'BNB', decimals: 18 }]);
  assert.deepEqual(activityAmounts(row('BemClaimed', 1, { amount: '100000001' })), [
    { kind: 'amount', amount: 100000001n, symbol: 'BEM', decimals: 8 }]);
  assert.deepEqual(activityAmounts(row('Transfer', 1, { value: '1' })), []);
  for (const value of [1.2, 5, '-1', '1e18', null]) assert.deepEqual(activityAmounts(row('Deposited', 1, { amount: value })), []);
});

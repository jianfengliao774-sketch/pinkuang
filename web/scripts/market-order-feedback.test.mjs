import test from 'node:test';
import assert from 'node:assert/strict';
import { abi } from '../lib/chain-client.mjs';
import { marketOrderFeedback, applyMarketOrderFeedback } from '../lib/market-order-feedback.mjs';

const account = '0x0000000000000000000000000000000000000001';
const market = '0x0000000000000000000000000000000000000002';
const other = '0x0000000000000000000000000000000000000003';
const hash = `0x${'a'.repeat(64)}`, now = 1_800_000_000_000;
const record = (id = 2n, overrides = {}) => ({ account, target: market, hash, status: 'pending',
  data: abi.ShareMarket.encodeFunctionData('cancel', [id]), ...overrides });
const orders = [{ id: 2n, remaining: 5n }, { orderId: '3', remaining: 8n }];

test('a pending cancellation retains the matching order and only disables that order', () => {
  const feedback = marketOrderFeedback([record()], market, account, now);
  assert.deepEqual(applyMarketOrderFeedback(orders, feedback), [
    { ...orders[0], cancellationPending: true }, { ...orders[1], cancellationPending: false },
  ]);
  assert.equal(orders[0].cancellationPending, undefined);
});

test('a freshly confirmed cancellation hides only the corresponding stale cached order', () => {
  const feedback = marketOrderFeedback([record(2n, { status: 'confirmed', confirmedAt: now })], market, account, now);
  assert.deepEqual(applyMarketOrderFeedback(orders, feedback), [{ ...orders[1], cancellationPending: false }]);
});

test('failed or unconfirmed receipts never hide an order', () => {
  for (const status of ['failed', 'reverted', 'cancelled', 'awaiting-signature', 'unknown']) {
    const feedback = marketOrderFeedback([record(2n, { status, confirmedAt: now })], market, account, now);
    assert.equal(feedback.size, 0);
    assert.equal(applyMarketOrderFeedback(orders, feedback).length, orders.length);
  }
});

test('feedback must match the exact account, market, valid hash and cancellation calldata', () => {
  for (const overrides of [{ account: other }, { target: other }, { hash: '0x1234' }, { data: undefined },
    { data: '0xbad' }, { data: abi.ShareMarket.encodeFunctionData('fill', [2n, 1n]) }]) {
    assert.equal(marketOrderFeedback([record(2n, overrides)], market, account, now).size, 0);
  }
  assert.equal(marketOrderFeedback([record()], null, account, now).size, 0);
  assert.equal(marketOrderFeedback([record()], market, null, now).size, 0);
  assert.equal(marketOrderFeedback([record()], market.toUpperCase(), account.toUpperCase(), now).size, 1);
});

test('expired-order release decodes the complete integer id without numeric rounding', () => {
  const id = (1n << 128n) + 17n;
  const feedback = marketOrderFeedback([record(id, { data: abi.ShareMarket.encodeFunctionData('expire', [id]) })], market, account, now);
  assert.equal(feedback.get(id.toString()).status, 'pending');
  assert.equal(applyMarketOrderFeedback([{ orderId: id.toString() }], feedback)[0].cancellationPending, true);
});

test('old restored confirmations expire and cannot indefinitely hide an indexed order', () => {
  for (const confirmedAt of [undefined, NaN, String(now), now - 600_001]) {
    assert.equal(marketOrderFeedback([record(2n, { status: 'confirmed', confirmedAt })], market, account, now).size, 0);
  }
  assert.equal(marketOrderFeedback([record(2n, { status: 'confirmed', confirmedAt: now - 600_000 })], market, account, now).size, 1);
});

test('a successful receipt wins over another pending request in either record order', () => {
  const pending = record(), confirmed = record(2n, { status: 'confirmed', confirmedAt: now });
  for (const records of [[pending, confirmed], [confirmed, pending]]) {
    const feedback = marketOrderFeedback(records, market, account, now);
    assert.equal(feedback.get('2').status, 'confirmed');
    assert.equal(applyMarketOrderFeedback(orders, feedback).length, 1);
  }
});

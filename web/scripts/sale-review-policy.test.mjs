import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSaleReviewThresholdBps, effectiveSaleReviewThresholdBps,
  readSaleReviewThresholdBps, requiresSaleReview } from '../../deploy/shared/sale-review-policy.mjs';
import { saleExecutionGate } from '../lib/sale-governance-gate.mjs';

test('80 percent is a strict atomic boundary; old deployments retain the full reference rule', () => {
  const reference = 10n ** 18n;
  for (const [price, expected] of [
    [799990000000000000n, true], [800000000000000000n, false],
    [800010000000000000n, false], [990000000000000000n, false],
  ]) {
    assert.equal(requiresSaleReview(price, reference, 8000n), expected);
    assert.equal(requiresSaleReview(price, reference), true);
  }
  assert.equal(requiresSaleReview(reference, reference), false);
  assert.equal(requiresSaleReview(80n, 101n, 8000n), true, 'do not round a fractional wei threshold down');
  assert.equal(requiresSaleReview(81n, 101n, 8000n), false);
  assert.equal(requiresSaleReview(0n, 1n, 8000n), true);
  assert.throws(() => requiresSaleReview(1, 1n), /exact atomic/);
  assert.throws(() => requiresSaleReview(1n, 0n), /exact atomic/);
});

test('only an exact supported business getter opts in; missing or unknown versions remain at 100 percent', async () => {
  assert.equal(await readSaleReviewThresholdBps(async () => 8000n), 8000n);
  assert.equal(await readSaleReviewThresholdBps(async () => { throw Error('old implementation'); }), 10000n);
  for (const value of [undefined, null, '8000', 8000, 0n, 7999n, 8001n, 10000n]) {
    assert.equal(normalizeSaleReviewThresholdBps(value), 10000n);
    assert.equal(await readSaleReviewThresholdBps(async () => value), 10000n);
  }
});

test('mixed parent and child versions retain the stricter execution rule', () => {
  assert.equal(effectiveSaleReviewThresholdBps(8000n, 8000n), 8000n);
  for (const versions of [[8000n, 10000n], [10000n, 8000n], [8000n, undefined]]) {
    assert.equal(effectiveSaleReviewThresholdBps(...versions), 10000n);
    assert.equal(requiresSaleReview(90n, 100n, effectiveSaleReviewThresholdBps(...versions)), true);
  }
});

test('discount remains a fact while only the actual review requirement controls execution', () => {
  const input = { proposal: { price: 80n, endsAt: 20n, executed: false }, passed: true, state: 2n,
    timestamp: 10n, reference: { available: true, priceWei: 100n }, review: { status: 2n, priceWei: 80n } };
  const current = saleExecutionGate({ ...input, saleReviewThresholdBps: 8000n });
  assert.equal(current.discounted, true); assert.equal(current.reviewRequired, false); assert.equal(current.canExecute, true);
  assert.equal(saleExecutionGate(input).canExecute, false);
  const below = { ...input, proposal: { ...input.proposal, price: 79n }, saleReviewThresholdBps: 8000n };
  assert.equal(saleExecutionGate(below).canExecute, false);
  assert.equal(saleExecutionGate({ ...below, review: { status: 1n, priceWei: 80n } }).canExecute, false);
  assert.equal(saleExecutionGate({ ...below, review: { status: 1n, priceWei: 79n } }).canExecute, true);
  assert.equal(saleExecutionGate({ ...input, reference: { available: false } }).reviewRequired, null);
});

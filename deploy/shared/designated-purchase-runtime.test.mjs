import assert from 'node:assert/strict';
import { test } from 'node:test';
import { designatedDailyOutputAtomic, designatedFundingAmounts,
  designatedPurchaseBounds, estimateDesignatedDailyOutput } from './designated-purchase-runtime.mjs';

test('chain daily output follows both per-second integer floors', () => {
  // U=floor(101*100/10000)=1; V=100; miner receives floor(100*1/3)=33 per second.
  assert.equal(estimateDesignatedDailyOutput({ currentRate: '101', unverifiedBps: '100',
    totalVerifiedWeight: '3', verifiedWeight: '1' }), 33n * 86_400n);
  assert.equal(designatedDailyOutputAtomic(8_333_333n, 100n, 1_524_590n, 1204n),
    ((8_333_333n - 8_333_333n * 100n / 10_000n) * 1204n / 1_524_590n) * 86_400n);
  assert.throws(() => designatedDailyOutputAtomic(1n, 0n, 10n, 1n), /daily mining output/);
  assert.throws(() => designatedDailyOutputAtomic(1, 0n, 1n, 1n), /exact/);
  assert.throws(() => designatedDailyOutputAtomic(1n, 10_001n, 1n, 1n), /unverified/);
  assert.throws(() => designatedDailyOutputAtomic(100n, 0n, 1n, 2n), /exceeds total/);
  assert.throws(() => designatedDailyOutputAtomic(1n << 256n, 0n, 1n, 1n), /Invalid current mining rate/);
  assert.throws(() => designatedDailyOutputAtomic((1n << 256n) - 1n, 0n, 1n, 1n), /daily mining output/);
});

test('funding reserves gross 110 percent and rounds 100-share target up without float', () => {
  assert.deepEqual(designatedFundingAmounts('1001'), { priceCapWei: 1102n, targetRaiseWei: 1200n });
  assert.deepEqual(designatedFundingAmounts(1000n), { priceCapWei: 1100n, targetRaiseWei: 1100n });
  assert.throws(() => designatedFundingAmounts(1000), /exact/);
  assert.throws(() => designatedFundingAmounts((1n << 256n) - 1n), /funding amount/);
});

const basis = { originalAskWei: 1000n, originalCostWei: 1050n,
  originalDailyOutputAtomic: 100n, priceCapWei: 1155n,
  totalRaisedWei: 1200n, freeBalanceWei: 1200n };
const check = (ask, daily, gross = ask) => designatedPurchaseBounds({ ...basis,
  candidateAskWei: ask, candidateCostWei: gross, candidateDailyOutputAtomic: daily });

test('both ask and ask-per-daily-output bands include exact 90 and 110 percent bounds', () => {
  assert.equal(check(900n, 100n).allowed, true);
  assert.equal(check(1100n, 100n).allowed, true);
  assert(check(899n, 100n).reasons.includes('ask-below-90-percent'));
  assert(check(1101n, 100n).reasons.includes('ask-above-110-percent'));
  assert(check(900n, 101n).reasons.includes('daily-unit-below-90-percent'));
  assert(check(1100n, 99n).reasons.includes('daily-unit-above-110-percent'));
});

test('seller ask sets unit price; fee changes gross spending without changing the unit band', () => {
  assert.equal(check(1000n, 100n, 1155n).allowed, true);
  assert(check(1000n, 100n, 1156n).reasons.includes('gross-above-110-percent'));
  assert(check(1000n, 100n, 1050n).allowed);
  assert(designatedPurchaseBounds({ ...basis, candidateAskWei: 1000n,
    candidateCostWei: 1100n, candidateDailyOutputAtomic: 100n,
    freeBalanceWei: 1099n }).reasons.includes('over-free-pool-balance'));
  assert.throws(() => check(1000n, 0n), /daily output/);
  assert.throws(() => check(1n << 128n, 100n), /candidate ask/);
  assert.throws(() => designatedPurchaseBounds({ ...basis, candidateAskWei: 1000n,
    candidateCostWei: 1000n, candidateDailyOutputAtomic: 100n,
    priceCapWei: 1156n }), /configured cap/);
  assert.throws(() => designatedPurchaseBounds({ ...basis, originalCostWei: 2001n,
    candidateAskWei: 1000n, candidateCostWei: 1000n, candidateDailyOutputAtomic: 100n }), /configured cap/);
});

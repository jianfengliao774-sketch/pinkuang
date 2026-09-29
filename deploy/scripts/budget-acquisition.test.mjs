import test from 'node:test';
import assert from 'node:assert/strict';
import { planBudgetAcquisition } from './budget-acquisition.mjs';

const now = 1_780_000_000_000;
const snapshot = { complete: true, blockNumber: 123, blockHash: `0x${'ab'.repeat(32)}`, observedAt: now - 10_000 };
const firstoCoverage = { ...snapshot };
const collection = '0xb1024b89886b9a34aa4ff5f31c411d708b20a14c';
const seller = '0x2222222222222222222222222222222222222222';
const miner = (id, cost, venue = 'official', extra = {}) => ({ collection, tokenId: String(id), seller,
  venue, verified: true, mining: true, optimal: false, verifiedWeight: '100', unverifiedWeight: '0',
  askWei: String(cost), costWei: String(cost), machineCapWei: '1000',
  snapshotBlock: snapshot.blockNumber, snapshotHash: snapshot.blockHash,
  ...(venue === 'firsto' ? { signedAskVerified: true } : {}), ...extra });
const plan = (budgetWei, official, firsto = [], other = {}) => planBudgetAcquisition({
  budgetWei: String(budgetWei), absoluteCapWei: '1000', unitCapWei: '10',
  official, firsto, snapshot, firstoCoverage, now, ...other,
});

test('a fixed 100-share BNB budget buys cheapest official miners first, then Firsto, and refunds exact remainder', () => {
  const result = plan(1000, [miner(3, 300), miner(1, 200), miner(2, 150)],
    [miner(4, 100, 'firsto', { askWei: '99' }), miner(5, 400, 'firsto')]);
  assert.deepEqual(result.selected.map(item => item.tokenId), [2n, 1n, 3n, 4n]);
  assert.equal(result.spentWei, 750n);
  assert.equal(result.officialSpentWei, 650n);
  assert.equal(result.treasuryFeeWei, 6n);
  assert.equal(result.refundableWei, 244n);
  assert.equal(result.spentWei + result.treasuryFeeWei + result.refundableWei, result.budgetWei);
});

test('one NFT cannot be bought through both markets and a cheaper Firsto order does not displace official-first priority', () => {
  const result = plan(500, [miner(1, 400)], [miner(1, 1, 'firsto'), miner(2, 100, 'firsto')]);
  assert.deepEqual(result.selected.map(item => `${item.venue}:${item.tokenId}`), ['official:1', 'firsto:2']);
  assert.equal(result.refundableWei, 0n);
});

test('an unaffordable official ask does not hide an affordable signed ask for the same NFT', () => {
  const result = plan(500, [miner(1, 600)], [miner(1, 450, 'firsto', { askWei: '445' })]);
  assert.deepEqual(result.selected.map(item => `${item.venue}:${item.tokenId}`), ['firsto:1']);
  assert.equal(result.refundableWei, 50n);
});

test('unaffordable rows are skipped, and the official fee never consumes purchase funds', () => {
  const result = plan(300, [miner(1, 299), miner(2, 300)]);
  assert.deepEqual(result.selected.map(item => item.tokenId), [1n]);
  assert.equal(result.treasuryFeeWei, 1n, '1% service charge can only take the one unspent wei');
  assert.equal(result.refundableWei, 0n);
});

test('stale or partial discovery cannot be presented as the current cheapest plan', () => {
  for (const broken of [{ ...snapshot, complete: false }, { ...snapshot, observedAt: now - 300_001 },
    { ...snapshot, blockHash: `0x${'0'.repeat(63)}` }])
    assert.throws(() => plan(100, [miner(1, 50)], [], { snapshot: broken }), /snapshot/);
  assert.throws(() => plan(101, [miner(1, 50)]), /100 integer shares/);
  for (const incomplete of [undefined, { ...firstoCoverage, complete: false },
    { ...firstoCoverage, blockNumber: 124 }, { ...firstoCoverage, observedAt: now - 300_001 }]) {
    assert.throws(() => plan(100, [], [miner(1, 50, 'firsto')], { firstoCoverage: incomplete }),
      /Firsto candidate coverage/);
  }
});

test('unverified, mismatched, changed or over-cap miners block an actionable plan', () => {
  for (const changes of [{ verified: false }, { mining: false }, { optimal: true },
    { verifiedWeight: '0' }, { unverifiedWeight: '1' }, { costWei: '1001' },
    { snapshotBlock: 124 }, { snapshotHash: `0x${'cd'.repeat(32)}` },
    { collection: '0x3333333333333333333333333333333333333333' },
    { seller: `0x${'0'.repeat(40)}` }])
    assert.throws(() => plan(1000, [miner(1, 100, 'official', changes)]));
  assert.throws(() => plan(1000, [], [miner(1, 100, 'firsto', { signedAskVerified: false })]));
  assert.throws(() => plan(1000, [miner(1, 100, 'official', { askWei: '99' })]));
  assert.throws(() => plan(1000, [miner(1, 100, 'official', { machineCapWei: '100000' })]),
    /Unverified or over-cap/, 'a supplied cap cannot override the reviewed per-weight pricing policy');
});

test('large exact Wei values never pass through floating-point arithmetic', () => {
  const budget = (1n << 200n) / 100n * 100n;
  const cost = budget - 99n;
  const result = plan(budget, [miner(1, cost, 'official', { machineCapWei: cost.toString() })], [],
    { absoluteCapWei: cost.toString(), unitCapWei: cost.toString() });
  assert.equal(result.spentWei, cost);
  assert.equal(result.treasuryFeeWei, 99n);
  assert.equal(result.refundableWei, 0n);
});

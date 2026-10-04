import test from 'node:test';
import assert from 'node:assert/strict';
import { assetOverview } from '../lib/asset-overview.mjs';
import { assetPositionsWithBookedRewards, assetRewardPreview, rewardPreviewForPosition } from '../lib/asset-reward-preview.mjs';
import { claimDisplayState } from '../lib/claim-display.mjs';

const pool = n => `0x${n.toString(16).padStart(40, '0')}`;
const single = (n, bookedBEM = 5n) => ({ pool: pool(n), kind: 'single', claimableBEM: bookedBEM, shares: 50n });
const ready = (n, bookedBEM, uncollectedBEM) => ({ pool: pool(n), status: 'ready',
  bookedBEM, uncollectedBEM, totalEstimatedBEM: bookedBEM + uncollectedBEM });
const view = (...items) => ({ canonical: true, items });

function scoped({ indexedBlock = 101, rewardBlock = 100n, booked = 0n, shares = 50n, state = 2n } = {}) {
  const blockHash = `0x${'a'.repeat(64)}`, account = pool(9), factory = pool(8);
  return { context: { account, factory, source: { indexedThrough: indexedBlock, indexedBlockHash: blockHash } },
    snapshot: { canonical: true, account, factory, chainId: 56n, blockNumber: rewardBlock, blockHash,
      items: [{ ...ready(1, booked, 20n), blockNumber: rewardBlock, blockHash, shares, state }] } };
}

test('a newer indexed balance cannot be replaced by an older zero reward snapshot or disable its claim', () => {
  const { context, snapshot } = scoped();
  const row = { ...single(1, 100000000n), state: 2n };
  const projected = assetPositionsWithBookedRewards([row], snapshot, context)[0];
  assert.equal(projected.claimableBEM, 100000000n);
  assert.equal(claimDisplayState({ pool: row.pool, account: context.account, currency: 'BEM',
    balance: projected.claimableBEM, balanceBlock: context.source.indexedThrough }).canClaim, true);
  const preview = assetRewardPreview([row], snapshot, context);
  assert.equal(preview.totals.bookedBEM, 100000000n);
  assert.equal(preview.totals.uncollectedBEM, null, 'Old pending output is not added to a later harvest.');
});

test('a newer zero balance remains zero after a claim; unchanged historical pending keeps its old block', () => {
  const { context, snapshot } = scoped({ booked: 5n });
  const claimed = { ...single(1, 0n), state: 2n };
  assert.equal(assetPositionsWithBookedRewards([claimed], snapshot, context)[0].claimableBEM, 0n);
  const unchanged = { ...single(1, 5n), state: 2n };
  const reward = rewardPreviewForPosition(unchanged, snapshot, context);
  assert.equal(reward.blockNumber, 100n); assert.equal(reward.balanceBlock, 101n);
  assert.equal(reward.uncollectedBEM, 20n);
});

test('reward identity, same-height fork, shares, state and unknown new balances fail without substituting zero', () => {
  const row = { ...single(1, 5n), state: 2n };
  const { context, snapshot } = scoped({ booked: 5n });
  const cases = [
    { snapshot: { ...snapshot, account: pool(10) } },
    { snapshot: { ...snapshot, factory: pool(10) } },
    { snapshot: { ...snapshot, blockHash: `0x${'b'.repeat(64)}` } },
    { row: { ...row, shares: 51n } }, { row: { ...row, state: 4n } }, { row: { ...row, claimableBEM: null } },
    { row: { ...row, shares: null } },
    { context: { ...context, source: { ...context.source, indexedThrough: 100, indexedBlockHash: `0x${'b'.repeat(64)}` } } },
    { row: { ...row, claimableBEM: 8n }, context: { ...context, source: { ...context.source, indexedThrough: 100 } } },
  ];
  for (const poison of cases) {
    const current = poison.row ?? row;
    const preview = assetRewardPreview([current], poison.snapshot ?? snapshot, poison.context ?? context);
    assert.equal(preview.items[0].status, 'unknown');
    assert.equal(preview.items[0].bookedBEM, current.claimableBEM);
    assert.equal(preview.items[0].uncollectedBEM, null);
  }
});

test('canonical preview replaces stale booked balances instead of double-counting a later harvest', () => {
  const rows = [single(1, 30n)];
  const snapshot = view(ready(1, 10n, 20n));
  const result = assetRewardPreview(rows, snapshot);
  assert.deepEqual(result.items[0], { pool: pool(1), kind: 'single', status: 'ready',
    bookedBEM: 10n, uncollectedBEM: 20n, totalEstimatedBEM: 30n });
  assert.deepEqual(result.totals, { bookedBEM: 10n, uncollectedBEM: 20n, totalEstimatedBEM: 30n });
  assert.equal(result.includesPortfolio, false);
  const harvested = assetRewardPreview(rows, view(ready(1, 30n, 0n)));
  assert.equal(harvested.totals.totalEstimatedBEM, 30n);
});

test('unknown and partially failed reads preserve known booked display but never convert pending to zero', () => {
  const rows = [single(1, 5n), single(2, 6n)];
  for (const snapshot of [undefined, view(), { canonical: false, items: [ready(1, 5n, 10n)] },
    view({ pool: pool(1), status: 'unknown' })]) {
    const result = assetRewardPreview(rows, snapshot);
    assert.deepEqual(result.totals, { bookedBEM: 11n, uncollectedBEM: null, totalEstimatedBEM: null });
    assert(result.items.every(item => item.status === 'unknown' && item.uncollectedBEM === null));
  }
  const partial = assetRewardPreview(rows, view(ready(1, 7n, 10n), { pool: pool(2), status: 'unknown' }));
  assert.equal(partial.items[0].status, 'ready'); assert.equal(partial.items[1].status, 'unknown');
  assert.deepEqual(partial.totals, { bookedBEM: 13n, uncollectedBEM: null, totalEstimatedBEM: null });
});

test('malformed ready snapshots fail unknown instead of accepting strings, floats, negative values or inconsistent sums', () => {
  const poisons = [
    { bookedBEM: '5' }, { bookedBEM: 5 }, { bookedBEM: -1n },
    { uncollectedBEM: '7' }, { uncollectedBEM: 1.5 }, { uncollectedBEM: -1n },
    { totalEstimatedBEM: null }, { totalEstimatedBEM: 99n }, { status: 'pending' },
  ];
  for (const poison of poisons) {
    const result = assetRewardPreview([single(1, 4n)], view({ ...ready(1, 5n, 7n), ...poison }));
    assert.equal(result.items[0].status, 'unknown'); assert.equal(result.items[0].bookedBEM, 4n);
    assert.equal(result.totals.uncollectedBEM, null); assert.equal(result.totals.totalEstimatedBEM, null);
  }
});

test('portfolio includes only parent booked rewards, never the single-pool reader or child pending', () => {
  const overview = assetOverview({ singleLoaded: true, portfolioLoaded: true,
    singlePositions: [{ pool: pool(1), shares: 50n, claimableBEM: 1n, bnbOwed: 0n, state: 2n },
      { pool: pool(3), shares: 100n, claimableBEM: 999n, bnbOwed: 0n, state: 2n }],
    portfolioRows: [{ pool: pool(2), shares: 50n, claimableBem: 8n, withdrawableBnb: 0n,
      state: 2n, activeChildCount: 1n, children: [{ pool: pool(3) }] }] });
  assert.equal(overview.rows.length, 2);
  const result = assetRewardPreview(overview.rows, view(ready(1, 2n, 5n), ready(2, 999n, 999n), ready(3, 999n, 999n)));
  assert.equal(result.includesPortfolio, true);
  assert.deepEqual(result.items[1], { pool: pool(2), kind: 'portfolio', status: 'booked',
    bookedBEM: 8n, uncollectedBEM: null, totalEstimatedBEM: 8n });
  assert.deepEqual(result.totals, { bookedBEM: 10n, uncollectedBEM: 5n, totalEstimatedBEM: 15n });
  assert.deepEqual(assetRewardPreview([overview.rows[1]], undefined).totals,
    { bookedBEM: 8n, uncollectedBEM: 0n, totalEstimatedBEM: 8n });
});

test('zero-share historical booked rewards remain visible and exact beyond Number range', () => {
  const big = 10n ** 80n;
  const rows = [Object.freeze({ ...single(1, big), shares: 0n }), single(2, big)];
  const result = assetRewardPreview(rows, view(ready(1, big, 0n), ready(2, big, big)));
  assert.equal(result.totals.bookedBEM, 2n * big);
  assert.equal(result.totals.uncollectedBEM, big);
  assert.equal(result.totals.totalEstimatedBEM, 3n * big);
  assert.equal(result.items.length, 2);
});

test('empty loaded scope returns exact zero totals and no portfolio', () => {
  assert.deepEqual(assetRewardPreview([], view(ready(1, 999n, 999n))), { items: [],
    totals: { bookedBEM: 0n, uncollectedBEM: 0n, totalEstimatedBEM: 0n }, includesPortfolio: false });
});

test('same pool repeated with different address case is counted once; conflicting duplicate evidence remains unknown', () => {
  const row = single(171, 5n), otherCase = { ...row, pool: row.pool.toUpperCase().replace('0X', '0x') };
  assert.deepEqual(assetRewardPreview([row, otherCase], view(ready(171, 5n, 10n))).totals,
    { bookedBEM: 5n, uncollectedBEM: 10n, totalEstimatedBEM: 15n });
  const conflict = assetRewardPreview([row], view(ready(171, 5n, 10n), ready(171, 5n, 11n)));
  assert.equal(conflict.items[0].status, 'unknown'); assert.equal(conflict.totals.totalEstimatedBEM, null);
  const duplicateRows = assetRewardPreview([row, { ...row, claimableBEM: 6n }], undefined);
  assert.equal(duplicateRows.items.length, 1); assert.equal(duplicateRows.totals.bookedBEM, null);
});

test('unknown booked data propagates independently; malformed pools and kinds do not gain ready status', () => {
  for (const row of [{ ...single(1), claimableBEM: -1n }, { ...single(1), claimableBEM: '5' },
    { pool: pool(1), kind: 'portfolio', claimableBEM: null }]) {
    const result = assetRewardPreview([row], undefined);
    assert.equal(result.totals.bookedBEM, null); assert.equal(result.totals.totalEstimatedBEM, null);
  }
  assert.equal(assetRewardPreview([{ ...single(1), pool: 'bad' }], view(ready(1, 5n, 10n))).items[0].status, 'unknown');
  assert.equal(assetRewardPreview([{ ...single(1), kind: 'other' }], view(ready(1, 5n, 10n))).items[0].status, 'unknown');
});

test('projection never overwrites input rows or the canonical reader snapshot', () => {
  const row = Object.freeze(single(1, 30n)), reward = Object.freeze(ready(1, 10n, 20n));
  const rows = Object.freeze([row, row]), snapshot = Object.freeze({ canonical: true, items: Object.freeze([reward]) });
  const before = structuredClone({ rows, snapshot });
  assetRewardPreview(rows, snapshot);
  assert.deepEqual({ rows, snapshot }, before);
  assert.equal(row.claimableBEM, 30n); assert.equal(reward.bookedBEM, 10n);
});

test('fresh booked rewards retain a zero-share historical position through overview filtering and preview', () => {
  const actions = Object.freeze({ claim: 'original-action-gate' });
  const original = Object.freeze({ pool: pool(1), shares: 0n, claimableBEM: 0n,
    bnbOwed: 0n, state: 6n, status: 'Closed', actions });
  const snapshot = view(ready(1, 8n, 0n));
  assert.equal(assetOverview({ singlePositions: [original], singleLoaded: true, portfolioLoaded: true }).rows.length, 0);
  const projected = assetPositionsWithBookedRewards([original], snapshot);
  assert.notEqual(projected[0], original); assert.equal(projected[0].claimableBEM, 8n);
  assert.equal(projected[0].shares, 0n); assert.equal(projected[0].status, 'Closed');
  assert.equal(projected[0].actions, actions); assert.equal(projected[0].kind, undefined);
  const overview = assetOverview({ singlePositions: projected, singleLoaded: true, portfolioLoaded: true });
  assert.equal(overview.rows.length, 1); assert.equal(overview.rows[0].shares, 0n);
  assert.deepEqual(assetRewardPreview(overview.rows, snapshot).totals,
    { bookedBEM: 8n, uncollectedBEM: 0n, totalEstimatedBEM: 8n });
  assert.equal(original.claimableBEM, 0n);
});

test('booked projection leaves non-ready or portfolio rows untouched, including every action and raw field', () => {
  const original = Object.freeze({ ...single(1, 0n), bnbOwed: 0n, arbitraryRawField: 'retained' });
  for (const snapshot of [undefined, { ...view(ready(1, 10n, 2n)), canonical: false },
    view({ ...ready(1, 10n, 2n), status: 'unknown' }), view({ ...ready(1, 10n, 2n), totalEstimatedBEM: 99n })]) {
    assert.equal(assetPositionsWithBookedRewards([original], snapshot)[0], original);
  }
  const portfolio = Object.freeze({ pool: pool(2), kind: 'portfolio', claimableBEM: 5n, shares: 0n });
  assert.equal(assetPositionsWithBookedRewards([portfolio], view(ready(2, 99n, 99n)))[0], portfolio);
  assert.equal(original.claimableBEM, 0n); assert.equal(original.arbitraryRawField, 'retained');
});

test('unfiltered unknown zero-balance scope does not become a known-zero account preview', () => {
  const zero = { ...single(1, 0n), shares: 0n, bnbOwed: 0n, state: 6n };
  const projected = assetPositionsWithBookedRewards([zero], undefined);
  assert.equal(projected[0], zero);
  const filtered = assetOverview({ singlePositions: projected, singleLoaded: true, portfolioLoaded: true });
  assert.equal(filtered.rows.length, 0);
  const scopeRows = [{ ...projected[0], kind: 'single' }];
  assert.deepEqual(assetRewardPreview(scopeRows, undefined).totals,
    { bookedBEM: 0n, uncollectedBEM: null, totalEstimatedBEM: null });
  assert.deepEqual(assetRewardPreview([], undefined).totals,
    { bookedBEM: 0n, uncollectedBEM: 0n, totalEstimatedBEM: 0n });
});

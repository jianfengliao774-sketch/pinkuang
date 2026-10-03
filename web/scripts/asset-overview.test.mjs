import test from 'node:test';
import assert from 'node:assert/strict';
import { assetOverview } from '../lib/asset-overview.mjs';
import { viewPool } from '../lib/live-view.mjs';

const address = suffix => `0x${String(suffix).padStart(40, '0')}`;
const single = (changes = {}) => viewPool({ pool: address(1), state: 2n, trusted: true,
  shares: 10n, claimableBEM: 250000000n, bnbOwed: 90071992547409930000000000001n, ...changes });
const parent = (changes = {}) => ({ kind: 'portfolio', pool: address(2), state: 2n,
  shares: 20n, claimableBem: 175000001n, withdrawableBnb: 800000000000000001n,
  bnbOwed: 1n, activeChildCount: 8n, childCount: 12n, children: [], ...changes });
const ready = (changes = {}) => assetOverview({ singlePositions: [single()], portfolioRows: [parent()],
  singleLoaded: true, portfolioLoaded: true, ...changes });

test('unified positions count parent balances and shares once, preserving exact atomic values', () => {
  const result = ready();
  assert.equal(result.complete, true);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.totals, { claimableBem: 425000001n, bnbOwed: 90071992548209930000000000002n,
    shares: 30n, projectsHeld: 2n, minersHeld: 9n });
  assert.equal(result.rows[1].claimableBEM, 175000001n);
  assert.equal(result.rows[1].bnbOwed, 800000000000000001n);
  assert.equal(result.rows[1].tokenId, null);
});

test('funding commitments remain positions but are not already purchased miners or proceeds', () => {
  const result = ready({ singlePositions: [single({ state: 0n, claimableBEM: 0n, bnbOwed: 0n })],
    portfolioRows: [parent({ state: 0n, activeChildCount: 0n, claimableBem: 0n, withdrawableBnb: 0n })] });
  assert.equal(result.rows.length, 2); assert.equal(result.totals.shares, 30n);
  assert.equal(result.totals.projectsHeld, 2n); assert.equal(result.totals.minersHeld, 0n);
  assert.equal(result.totals.bnbOwed, 0n);
});

test('sold-out historical BNB and BEM credits remain visible with zero held projects', () => {
  const result = ready({ singlePositions: [single({ shares: 0n })], portfolioRows: [parent({ shares: 0n })] });
  assert.equal(result.rows.length, 2); assert.equal(result.totals.shares, 0n);
  assert.equal(result.totals.projectsHeld, 0n); assert.equal(result.totals.minersHeld, 0n);
  assert.equal(result.totals.claimableBem, 425000001n);
});

test('parent child rows and duplicate parent addresses do not double count rewards or 100-share units', () => {
  const child = single({ pool: address(3), shares: 100n, claimableBEM: 999999999n });
  const result = ready({ singlePositions: [single(), child, single({ pool: address(2) })],
    portfolioRows: [parent({ children: [{ pool: address(3), sold: false }] })] });
  assert.equal(result.rows.length, 2); assert.equal(result.totals.claimableBem, 425000001n);
  assert.equal(result.totals.shares, 30n); assert.equal(result.totals.minersHeld, 9n);
});

test('unknown claims remain visible and propagate null independently of other known totals', () => {
  const result = ready({ portfolioRows: [parent({ shares: 0n, claimableBem: null, withdrawableBnb: 0n })] });
  assert.equal(result.rows.length, 2); assert.equal(result.totals.claimableBem, null);
  assert.equal(result.totals.shares, 10n); assert.equal(result.totals.bnbOwed, single().bnbOwed);
});

test('an untrusted single row cannot contribute apparently verified balances', () => {
  const result = ready({ singlePositions: [single({ trusted: false })] });
  assert.equal(result.rows.length, 2);
  for (const value of Object.values(result.totals)) assert.equal(value, null);
});

test('missing sources, remaining pages and read failures never report full totals as zero', () => {
  for (const changed of [{ singleLoaded: false }, { portfolioLoaded: false }, { singleCursor: 20 },
    { portfolioCursor: 1 }, { singleError: true }, { portfolioError: 'timeout' }]) {
    const result = ready(changed);
    assert.equal(result.complete, false); assert.equal(result.partial, true);
    for (const value of Object.values(result.totals)) assert.equal(value, null);
  }
  assert.equal(ready({ portfolioCursor: 20 }).loadedTotals.shares, 30n);
  for (const value of Object.values(assetOverview().loadedTotals)) assert.equal(value, null);
});

test('only fully read empty scopes produce exact zero totals', () => {
  const result = ready({ singlePositions: [], portfolioRows: [] });
  assert.equal(result.complete, true); assert.deepEqual(result.rows, []);
  for (const value of Object.values(result.totals)) assert.equal(value, 0n);
  const cleared = ready({ singlePositions: [single({ shares: 0n, claimableBEM: 0n, bnbOwed: 0n })], portfolioRows: [] });
  assert.equal(cleared.rows.length, 0);
});

test('atomic numeric strings remain exact; unsafe numbers and missing state do not become zero', () => {
  const result = ready({ singlePositions: [], portfolioRows: [parent({ shares: '20',
    claimableBem: '9007199254740993123456789', withdrawableBnb: 9007199254740992 })] });
  assert.equal(result.totals.claimableBem, 9007199254740993123456789n);
  assert.equal(result.totals.bnbOwed, null);
  const unknown = ready({ singlePositions: [], portfolioRows: [parent({ state: null, activeChildCount: null })] });
  assert.equal(unknown.rows[0].status, 'Unknown'); assert.equal(unknown.totals.minersHeld, null);
});

test('overlapping pages count identical positions once and conflicting fields stay unknown', () => {
  assert.equal(ready({ singlePositions: [single(), single()] }).totals.shares, 30n);
  const result = ready({ singlePositions: [single(), single({ shares: 15n, claimableBEM: 1n })] });
  assert.equal(result.rows.length, 2); assert.equal(result.totals.shares, null);
  assert.equal(result.totals.claimableBem, null); assert.equal(result.rows[0].claimableBEM, null);
});

test('projection does not mutate raw read rows or their children', () => {
  const child = Object.freeze({ pool: address(3), sold: false });
  const raw = Object.freeze(parent({ children: Object.freeze([child]) }));
  const s = Object.freeze(single());
  const result = ready({ singlePositions: Object.freeze([s]), portfolioRows: Object.freeze([raw]) });
  assert.equal(raw.bnbOwed, 1n); assert.equal(raw.claimableBEM, undefined);
  assert.notEqual(result.rows[1], raw); assert.equal(result.rows[1].children[0], child);
});

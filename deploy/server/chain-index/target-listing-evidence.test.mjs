import test from 'node:test';
import assert from 'node:assert/strict';
import { ZeroAddress } from 'ethers';
import { firstoListingEvidence } from './target-listing-evidence.mjs';

// Exact detail shape observed on 2026-10-04 for TapeOut #14281. These tests
// never fetch an external API and never request a chain or wallet operation.
const now = Date.parse('2026-10-04T14:31:12.500Z');
const collection = '0xb1024b89886b9a34aa4ff5f31c411d708b20a14c';
const owner = '0x642fab3b5557031a67bf611db19f64205f7fd3a1';
const other = '0x0000000000000000000000000000000000000001';
const identity = { collection, owner, tokenId: '14281' };
const seconds = offset => String(Math.floor((now + offset) / 1000));
const iso = offset => new Date(now + offset).toISOString();
const fresh = detail => ({
  fetchedAt: iso(-500), responseDate: new Date(now - 500).toUTCString(),
  detail: detail ?? { asset: { collection, tokenId: identity.tokenId, owner,
    category: 'official_mining', classification: 'official_mining' },
    orders: { signedAsks: [], asksAndOnchainBids: [], signedBids: [] } },
});
const ask = changes => ({ collection, tokenId: identity.tokenId, maker: owner,
  status: 'open', priceWei: '1784326600000000000', expiry: seconds(60_000), ...changes });
const withOrders = (signedAsks = [], asksAndOnchainBids = []) => {
  const delivery = fresh(); delivery.detail.orders = { signedAsks, asksAndOnchainBids }; return delivery;
};
const status = (delivery, at = now) => firstoListingEvidence(delivery, identity, at).status;

test('fresh exact-owner detail with both explicitly empty ask arrays proves absence', () => {
  const result = firstoListingEvidence(fresh(), identity, now);
  assert.equal(result.status, 'absent');
  assert.equal(result.observedAt, iso(-500), 'observation time is original fetch, not current capture time');
  const before = fresh(); before.detail.asset.listingReference = { dailyCapacityPriceWei: '7090000000000000000' };
  before.detail.orders.signedBids = [ask({ side: 'bid' })];
  assert.equal(status(before), 'absent', 'reference averages and purchase bids are not sell listings');
});

test('one matching current-owner open ask preserves availability in either supported book', () => {
  for (const delivery of [withOrders([ask()]), withOrders([ask({ side: 'ask' })]),
    withOrders([], [ask({ side: 'ask', chainId: 56 })]),
    withOrders([ask({ chainId: '56' })])]) {
    const result = firstoListingEvidence(delivery, identity, now);
    assert.equal(result.status, 'available');
    assert.equal(result.observedAt, iso(-500));
    assert.equal(result.expiresAt, seconds(60_000), 'cache must retain short order expiry');
  }
});

test('open asks with no expiry retain availability without inventing a deadline', () => {
  const row = ask(); delete row.expiry;
  const result = firstoListingEvidence(withOrders([row]), identity, now);
  assert.equal(result.status, 'available'); assert.equal(result.expiresAt, null);
});

test('a short-lived ask expires at the exact second boundary', () => {
  const delivery = withOrders([ask({ expiry: seconds(1000) })]);
  const expiryMs = Number(seconds(1000)) * 1000;
  assert.equal(status(delivery, expiryMs - 1), 'available');
  assert.equal(status(delivery, expiryMs), 'absent');
});

test('transport metadata must be present and retain its own freshness window', () => {
  for (const change of [{ fetchedAt: undefined }, { responseDate: undefined },
    { fetchedAt: 'invalid' }, { responseDate: 'invalid' },
    { fetchedAt: iso(-60_001) }, { responseDate: iso(-120_001) },
    { fetchedAt: iso(30_001) }, { responseDate: iso(30_001) }]) {
    assert.equal(status({ ...fresh(), ...change }), 'unknown', JSON.stringify(change));
  }
  assert.equal(status(undefined), 'unknown');
  assert.equal(status(fresh(), now + 60_001), 'unknown', 'reading a cached body later cannot refresh the proof');
});

test('an invalid capture clock cannot manufacture fresh absent evidence', () => {
  for (const at of [NaN, Infinity, -1, now + 0.1, '1791124272500'])
    assert.equal(status(fresh(), at), 'unknown', String(at));
});

test('asset identity and owner conflicts stay unknown instead of empty', () => {
  for (const change of [{ collection: other }, { tokenId: '14277' }, { tokenId: 14281 },
    { tokenId: '014281' }, { owner: other }, { owner: ZeroAddress }, { owner: null },
    { category: 'other' }, { classification: 'foreign' }]) {
    const delivery = fresh(); Object.assign(delivery.detail.asset, change);
    assert.equal(status(delivery), 'unknown', JSON.stringify(change));
  }
  const pendingEnrichment = fresh(); pendingEnrichment.detail.asset.classification = 'unknown';
  assert.equal(status(pendingEnrichment), 'absent', 'official classification enrichment can lag a known NFT');
});

test('both order arrays must be present and bounded to prove an empty book', () => {
  for (const orders of [{}, { signedAsks: [] }, { asksAndOnchainBids: [] },
    { signedAsks: null, asksAndOnchainBids: [] },
    { signedAsks: {}, asksAndOnchainBids: [] },
    { signedAsks: [], asksAndOnchainBids: Array(501).fill(ask({ status: 'filled' })) },
    { signedAsks: Array(501).fill(ask({ status: 'filled' })), asksAndOnchainBids: [] }]) {
    const delivery = fresh(); delivery.detail.orders = orders;
    assert.equal(status(delivery), 'unknown');
  }
});

test('known closed order states, bids and expired or wrong-owner asks are absent', () => {
  for (const change of [{ status: 'pending_approval' }, { status: 'filled' }, { status: 'cancelled' },
    { status: 'expired' }, { status: 'asset_transferred' }, { status: 'approval_revoked' },
    { status: 'invalid' }, { side: 'bid' }, { expiry: seconds(0) },
    { tokenId: '14277' }, { collection: other }, { maker: other }, { priceWei: '0' }]) {
    assert.equal(status(withOrders([ask(change)])), 'absent', JSON.stringify(change));
  }
});

test('unrecognized states or malformed open asks are unknown and cannot trigger delisting', () => {
  for (const row of [null, [], 'open', ask({ status: undefined }), ask({ status: 'unknown' }),
    ask({ status: 'loading' }), ask({ status: 'backend_error' }), ask({ side: 'unsupported' }),
    ask({ maker: null }), ask({ collection: 'invalid' }), ask({ tokenId: '1e4' }),
    ask({ priceWei: '1e18' }), ask({ priceWei: '-1' }), ask({ priceWei: String(2n ** 256n) }),
    ask({ chainId: 1 }), ask({ chainId: '0x38' }), ask({ expiry: 'invalid' }),
    ask({ expiry: '1e10' }), ask({ expiry: 1791124332 })]) {
    assert.equal(status(withOrders([row])), 'unknown', JSON.stringify(row));
  }
  assert.equal(status(withOrders([], [ask()])), 'unknown', 'a mixed asks/bids book requires explicit side');
});

test('one known valid ask is enough even when other rows are malformed or stale', () => {
  assert.equal(status(withOrders([null, ask({ status: 'backend_error' }), ask()])), 'available');
});

test('contradicting order expiry fields are unknown instead of picking the convenient one', () => {
  assert.equal(status(withOrders([ask({ expiresAt: seconds(-60_000) })])), 'unknown');
  assert.equal(status(withOrders([ask({ expiresAt: iso(-60_000) })])), 'unknown');
});

test('an open bestAsk conflicting with an empty detail book is not absence proof', () => {
  const delivery = fresh(); delivery.detail.asset.bestAsk = { status: 'open', priceWei: '1' };
  assert.equal(status(delivery), 'unknown');
});

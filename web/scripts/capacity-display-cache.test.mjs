import test from 'node:test';
import assert from 'node:assert/strict';
import { readCapacityDisplay, writeCapacityDisplay } from '../lib/capacity-display-cache.mjs';

const manifest = { artifactDigest: `0x${'ab'.repeat(32)}`, factory: `0x${'11'.repeat(20)}` };
const pool = `0x${'22'.repeat(20)}`, collection = `0x${'33'.repeat(20)}`;
const now = 1_780_000_000_000;
const store = () => { const entries = new Map(); return {
  getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value),
}; };
const quote = { available: true, pool, collection, tokenId: '16480', pricePerUnitWei: 10_000_000_000_000_000n,
  forPriceWei: '10000000000000000', sourceBlock: 123n, miningSourceBlock: 122n,
  estimated24hAtomic: 123_456_789n, marketReferencePriceWei: 8_100_000_000_000_000_000n,
  minerAskPriceWei: 100_000_000_000_000_000n, includeOfficialAsk: false, allowUnownedTarget: false,
  minerAskSource: 'firsto', officialAskStatus: 'not_requested',
  observedAt: now - 1000, validUntil: now + 299_000 };

test('restores only a fresh, exact-price, deployment-bound capacity display', () => {
  const storage = store();
  assert.equal(writeCapacityDisplay(storage, manifest, quote, { now }), true);
  assert.deepEqual(readCapacityDisplay(storage, manifest, pool, quote.pricePerUnitWei, { now: now + 1000 }),
    { ...quote, cached: true });
  assert.equal(readCapacityDisplay(storage, manifest, pool, quote.pricePerUnitWei + 1n, { now }), null);
  assert.equal(readCapacityDisplay(storage, { ...manifest, factory: `0x${'44'.repeat(20)}` }, pool,
    quote.pricePerUnitWei, { now }), null);
  assert.equal(readCapacityDisplay(storage, manifest, pool, quote.pricePerUnitWei,
    { now: quote.validUntil }), null);
});

test('unavailable, malformed, and expired estimates are never persisted', () => {
  const storage = store();
  for (const change of [{ available: false }, { estimated24hAtomic: 0n },
    { marketReferencePriceWei: -1n }, { minerAskPriceWei: undefined }, { minerAskPriceWei: -1n },
    { validUntil: now }, { pool: `0x${'44'.repeat(20)}`,
      forPriceWei: 'wrong' }]) {
    assert.equal(writeCapacityDisplay(storage, manifest, { ...quote, ...change }, { now }), false);
  }
});

test('old class-reference cache cannot populate the miner-specific price', () => {
  const storage = store();
  assert.equal(writeCapacityDisplay(storage, manifest, quote, { now }), true);
  const newKey = `bemine:capacity-display:v3:${manifest.artifactDigest}:${manifest.factory}:${pool}:output`;
  const oldKey = `bemine:capacity-display:v1:${manifest.artifactDigest}:${manifest.factory}:${pool}`;
  storage.setItem(oldKey, storage.getItem(newKey));
  storage.setItem(newKey, null);
  assert.equal(readCapacityDisplay(storage, manifest, pool, quote.pricePerUnitWei, { now }), null);
});


test('v3 official ask records are separate from output-only and old v2 records', () => {
  const storage = store();
  assert.equal(writeCapacityDisplay(storage, manifest, quote, { now }), true);
  assert.equal(readCapacityDisplay(storage, manifest, pool, quote.pricePerUnitWei, { now, includeOfficialAsk: true }), null);
  const official = { ...quote, includeOfficialAsk: true, allowUnownedTarget: true,
    minerAskSource: 'official', officialAskStatus: 'ready', minerAskPriceWei: 2n };
  assert.equal(writeCapacityDisplay(storage, manifest, official, { now }), true);
  assert.equal(readCapacityDisplay(storage, manifest, pool, quote.pricePerUnitWei, { now, includeOfficialAsk: true }).minerAskPriceWei, 2n);
  assert.equal(readCapacityDisplay(storage, manifest, pool, quote.pricePerUnitWei, { now }).minerAskPriceWei, quote.minerAskPriceWei);
  const oldOnly = store();
  const v3key = `bemine:capacity-display:v3:${manifest.artifactDigest}:${manifest.factory}:${pool}:official-ask`;
  oldOnly.setItem(`bemine:capacity-display:v2:${manifest.artifactDigest}:${manifest.factory}:${pool}`, storage.getItem(v3key));
  assert.equal(readCapacityDisplay(oldOnly, manifest, pool, quote.pricePerUnitWei, { now, includeOfficialAsk: true }), null);
});

test('persistent ask policy rejects missing markers and inconsistent official provenance', () => {
  const storage = store();
  for (const changes of [{ includeOfficialAsk: undefined }, { allowUnownedTarget: undefined },
    { includeOfficialAsk: true }, { includeOfficialAsk: true, officialAskStatus: 'ready', minerAskSource: 'firsto' },
    { includeOfficialAsk: true, officialAskStatus: 'absent', minerAskSource: 'official' },
    { includeOfficialAsk: true, officialAskStatus: 'ready', minerAskSource: 'official', minerAskPriceWei: null }]) {
    assert.equal(writeCapacityDisplay(storage, manifest, { ...quote, ...changes }, { now }), false);
  }
  assert.equal(writeCapacityDisplay(storage, manifest, { ...quote, includeOfficialAsk: true,
    officialAskStatus: 'unavailable', minerAskSource: null, minerAskPriceWei: null }, { now }), true);
});

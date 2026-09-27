import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Interface } from 'ethers';
import {
  OFFICIAL_MARKET, OFFICIAL_SNAPSHOT_URL, discoverOfficialMarketCandidates,
  fetchOfficialCandidates, fetchOfficialSnapshot, parseOfficialSnapshot,
  verifyOfficialSnapshotBoundary,
} from './official-market-discovery.mjs';

const now = Date.parse('2026-09-27T14:00:00Z');
const collection = '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C';
const otherCollection = '0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C';
const seller = '0x1111111111111111111111111111111111111111';
const constraints = {
  circuits: collection, taskId: 42n, minVerifiedWeight: 100n,
  referenceVerifiedWeight: 200n, referencePriceWei: 1000n, priceCap: 1000n,
};
const listing = (id, tokenId = id, price = '900', circuits = collection) => ({
  id, seller, circuits, circuitId: String(tokenId), price, feeBps: 100, valid: true,
});
const fixture = (listings = [listing(1), listing(2, 2, '800'), listing(3, 3, '900', otherCollection)],
  overrides = {}) => ({ generatedAt: new Date(now - 60_000).toISOString(), block: 100,
    marketAddr: OFFICIAL_MARKET, maxId: 3, listings, ...overrides });
const response = raw => Response.json(raw);
const miner = (tokenId, overrides = {}) => ({ circuits: collection, circuitId: BigInt(tokenId),
  taskId: 42n, status: 1n, optimal: false, verifWeight: 200n, unverWeight: 0n, ...overrides });

test('official snapshot requires current address, bounded age and a real source block', () => {
  const parsed = parseOfficialSnapshot(fixture(), { now });
  assert.equal(parsed.maxId, 3);
  assert.equal(parsed.listings.length, 3);
  assert.throws(() => parseOfficialSnapshot(fixture([], { marketAddr: seller }), { now }), /address mismatch/);
  assert.throws(() => parseOfficialSnapshot(fixture([], { generatedAt: new Date(now - 361_000).toISOString() }), { now }), /stale/);
  assert.throws(() => parseOfficialSnapshot(fixture([], { generatedAt: new Date(now + 31_000).toISOString() }), { now }), /stale/);
  assert.throws(() => parseOfficialSnapshot(fixture([], { block: null }), { now }), /source block/);
  assert.throws(() => parseOfficialSnapshot(fixture([], { listings: null }), { now }), /listings/);
});

test('HTTP reader rejects non-JSON, redirects and oversized streamed snapshots', async () => {
  const valid = fixture();
  await assert.rejects(fetchOfficialSnapshot({ fetcher: async () => new Response('<html/>', { headers: { 'content-type': 'text/html' } }), now }), /not JSON/);
  await assert.rejects(fetchOfficialSnapshot({ fetcher: async () => Response.redirect(OFFICIAL_SNAPSHOT_URL), now }), /unavailable/);
  await assert.rejects(fetchOfficialSnapshot({ fetcher: async () => response(valid), now, maxBytes: 20 }), /byte limit/);
  let seen;
  const parsed = await fetchOfficialSnapshot({ fetcher: async (url, init) => { seen = { url, init }; return response(valid); }, now });
  assert.equal(parsed.blockNumber, 100);
  assert.equal(seen.url, OFFICIAL_SNAPSHOT_URL);
  assert.equal(seen.init.cache, 'no-store');
  assert.equal(seen.init.credentials, 'omit');
  assert.equal(seen.init.redirect, 'error');
});

test('official discovery resolves new listing IDs and checks exact miner model, quality and per-weight price', async () => {
  const reads = [];
  const onchain = {
    nextListingId: async () => 5n,
    listingView: async id => { reads.push(['listingView', id]); return listing(id, Number(id), id === 5n ? '500' : id === 2n ? '800' : '900'); },
    miner: async (_collection, tokenId) => {
      reads.push(['miner', tokenId]);
      if (tokenId === 2n) return miner(tokenId, { verifWeight: 100n }); // 800 > reference unit cap 500
      if (tokenId === 5n) return miner(tokenId, { taskId: 43n });
      return miner(tokenId, { verifWeight: tokenId === 4n ? 300n : 200n });
    },
  };
  const found = await fetchOfficialCandidates(null, { now, blockNumber: 101, read: onchain }, constraints,
    async () => response(fixture()));
  assert.equal(found.complete, true);
  assert.equal(found.scannedRows, 5);
  assert.equal(found.maxId, 5n);
  assert.equal(found.candidates.length, 2);
  assert.deepEqual(found.candidates.map(row => row.tokenId), [4n, 1n], 'lower price per verified weight ranks first');
  assert(found.candidates.every(row => row.discoverySource === 'TapeOut official snapshot'));
  assert(found.candidates.every(row => row.discoveryVenue === 'official'));
  assert.deepEqual(reads.filter(row => row[0] === 'listingView').map(row => row[1]), [1n, 2n, 4n, 5n]);
});

test('an existing official listing repriced below the cap is found even without a new listing ID', async () => {
  const found = await discoverOfficialMarketCandidates({
    blockNumber: 101, now, constraints,
    fetcher: async () => response(fixture([listing(1, 1, '1500')], { maxId: 1 })),
    read: { nextListingId: async () => 1n,
      listingView: async () => listing(1, 1, '900'),
      miner: async () => miner(1), },
  });
  assert.equal(found.liveListingsChecked, 1);
  assert.deepEqual(found.candidates.map(row => row.tokenId), [1n]);
});

test('official discovery never truncates before filtering the mining model', async () => {
  const rows = Array.from({ length: 45 }, (_, index) => listing(index + 1));
  const source = fixture(rows, { maxId: 45 });
  const found = await discoverOfficialMarketCandidates({
    blockNumber: 101, now, constraints, read: {
      nextListingId: async () => 45n,
      listingView: async id => listing(id),
      miner: async (_collection, tokenId) => miner(tokenId, { taskId: tokenId === 45n ? 42n : 43n }),
    }, fetcher: async () => response(source),
  });
  assert.equal(found.modelChecked, 45);
  assert.deepEqual(found.candidates.map(row => row.tokenId), [45n]);
});

test('official discovery fails closed on missing newest listings, source lag or incomplete miner RPC', async () => {
  const base = { now, blockNumber: 101, constraints, fetcher: async () => response(fixture()),
    read: { nextListingId: async () => 1000n, miner: async () => miner(1) } };
  await assert.rejects(discoverOfficialMarketCandidates(base), /too many recent listings/);
  await assert.rejects(discoverOfficialMarketCandidates({ ...base, blockNumber: 1301 }), /too far behind/);
  await assert.rejects(discoverOfficialMarketCandidates({ ...base, read: {
    nextListingId: async () => 3n, listingView: async id => listing(id),
    miner: async () => { throw new Error('RPC unavailable'); },
  } }), /RPC unavailable/);
  await assert.rejects(discoverOfficialMarketCandidates({ ...base, read: {
    nextListingId: async () => 3n, listingView: async () => { throw new Error('listing RPC unavailable'); },
  } }), /listing RPC unavailable/);
  await assert.rejects(discoverOfficialMarketCandidates({ ...base, fetcher: async () => response(fixture([listing(4)], { maxId: 4 })),
    read: { nextListingId: async () => 3n } }), /ahead of the chain/);
});

test('abort is checked after listing and miner RPC batches so a timed-out scan stops', async () => {
  const source = async () => response(fixture([listing(1)], { maxId: 1 }));
  const duringListing = new AbortController();
  let minerReads = 0;
  await assert.rejects(discoverOfficialMarketCandidates({ now, blockNumber: 101, constraints,
    fetcher: source, signal: duringListing.signal,
    read: { nextListingId: async () => 1n,
      listingView: async () => { duringListing.abort(); return listing(1); },
      miner: async () => { minerReads += 1; return miner(1); } },
  }), /aborted/);
  assert.equal(minerReads, 0, 'miner batch must not start after listing batch abort');
  const duringMiner = new AbortController();
  await assert.rejects(discoverOfficialMarketCandidates({ now, blockNumber: 101, constraints,
    fetcher: source, signal: duringMiner.signal,
    read: { nextListingId: async () => 1n, listingView: async () => listing(1),
      miner: async () => { duringMiner.abort(); return miner(1); } },
  }), /aborted/);
});

test('enumeration boundary uses the on-chain nextListingId at one block', async () => {
  const abi = new Interface(['function nextListingId() view returns(uint256)']);
  const provider = { getBlockNumber: async () => 101,
    call: async tx => {
      assert.equal(tx.to.toLowerCase(), OFFICIAL_MARKET.toLowerCase());
      assert.equal(tx.blockTag, 101);
      assert.equal(abi.parseTransaction({ data: tx.data }).name, 'nextListingId');
      return abi.encodeFunctionResult('nextListingId', [6n]);
    },
  };
  const boundary = await verifyOfficialSnapshotBoundary(provider, 6);
  assert.equal(boundary.complete, true);
  assert.equal(boundary.unseenListings, 0n);
  const lagged = await verifyOfficialSnapshotBoundary(provider, 3);
  assert.equal(lagged.complete, false);
  assert.equal(lagged.unseenListings, 3n);
});

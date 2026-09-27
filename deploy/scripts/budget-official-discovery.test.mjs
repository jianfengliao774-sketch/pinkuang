import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverOfficialBudgetCandidates } from './budget-official-discovery.mjs';
import { planBudgetAcquisition } from './budget-acquisition.mjs';
import { OFFICIAL_MARKET } from './official-market-discovery.mjs';

const now = Date.parse('2026-09-27T15:00:00Z');
const tapeout = '0xb1024b89886b9a34aa4ff5f31c411d708b20a14c';
const behemoth = '0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c';
const seller = '0x1111111111111111111111111111111111111111';
const hash = `0x${'ab'.repeat(32)}`;
const row = (id, tokenId = id, price = id * 100, collection = tapeout) => ({ id, circuitId: tokenId,
  circuits: collection, seller, price: String(price), valid: true });
const snapshot = rows => ({ marketAddr: OFFICIAL_MARKET, generatedAt: new Date(now - 30_000).toISOString(),
  block: 100, maxId: 3, listings: rows });
const mining = (listed, overrides = {}) => ({ circuits: listed.circuits, circuitId: BigInt(listed.circuitId),
  taskId: 42n, status: 1n, optimal: false, verifWeight: 100n, unverWeight: 0n, ...overrides });
const setup = (changes = {}) => {
  const rows = [row(1), row(2, 2, 220, behemoth), row(3, 3, 300)];
  const observed = [], canonical = new Map(rows.map(item => [`${item.circuits}:${item.circuitId}`, item]));
  let headerReads = 0;
  const read = {
    chainId: async () => changes.chainId ?? 56n,
    nextListingId: async () => changes.head ?? 4n,
    blockHash: async () => ++headerReads > 1 && changes.reorg ? `0x${'cd'.repeat(32)}` : hash,
    listingView: async id => {
      observed.push(id);
      return id === 4n ? row(4, 4, 50) : rows[Number(id) - 1];
    },
    listingFor: async (collection, tokenId) => {
      const selected = BigInt(tokenId) === 4n ? row(4, 4, 50) : canonical.get(`${collection.toLowerCase()}:${tokenId}`);
      return { id: BigInt(selected.id), seller: selected.seller, price: BigInt(selected.price), valid: true,
        ...changes.canonical };
    },
    ownerOf: async () => changes.owner ?? seller,
    miner: async (collection, tokenId) => mining({ circuits: collection, circuitId: tokenId },
      BigInt(tokenId) === 3n ? changes.miner3 : {}),
  };
  return { rows, observed, read };
};
const find = (fixture, extra = {}) => discoverOfficialBudgetCandidates({ now, blockNumber: 101,
  absoluteCapWei: '500', unitCapWei: '4', read: fixture.read,
  fetcher: async () => Response.json(snapshot(fixture.rows)), ...extra });

test('both official collections and recent IDs are pinned, rechecked and sorted by exact ask', async () => {
  const fixture = setup();
  const result = await find(fixture);
  assert.equal(result.snapshot.complete, true);
  assert.equal(result.snapshot.blockHash, hash);
  assert.deepEqual(result.candidates.map(item => item.tokenId), ['4', '1', '2', '3']);
  assert.deepEqual(fixture.observed, [1n, 2n, 3n, 4n]);
  const plan = planBudgetAcquisition({ budgetWei: '500', absoluteCapWei: '500', unitCapWei: '4',
    official: result.candidates, firsto: [],
    snapshot: result.snapshot, now });
  assert.deepEqual(plan.selected.map(item => item.tokenId), [4n, 1n, 2n]);
  assert.equal(plan.refundableWei + plan.treasuryFeeWei + plan.spentWei, 500n);
});

test('changed owner or invalid mining quality is excluded before reaching the planner', async () => {
  const fixture = setup({ miner3: { unverWeight: 1n } });
  const result = await find(fixture);
  assert.deepEqual(result.candidates.map(item => item.tokenId), ['4', '1', '2']);
  const ownerChanged = await find(setup({ owner: '0x2222222222222222222222222222222222222222' }));
  assert.equal(ownerChanged.candidates.length, 0);
});

test('repriced existing listing is read from chain, while missing or inconsistent coverage fails closed', async () => {
  const fixture = setup({ head: 3n });
  fixture.rows[0].price = '900';
  fixture.read.listingView = async id => id === 1n ? row(1, 1, 90) : fixture.rows[Number(id) - 1];
  fixture.read.listingFor = async (_collection, tokenId) => ({ id: BigInt(tokenId), seller, price: BigInt(tokenId) === 1n ? 90n
    : BigInt(fixture.rows[Number(tokenId) - 1].price), valid: true });
  assert.deepEqual((await find(fixture)).candidates.map(item => item.tokenId), ['1', '2', '3']);
  await assert.rejects(find(setup({ head: 300n })), /omitted too many/);
  await assert.rejects(find(setup(), { blockNumber: 1301 }), /outside the chain read window/);
  const invalid = await find(setup({ canonical: { valid: false } }));
  assert.equal(invalid.candidates.length, 0, 'invalid listings are filtered, not reported as verified');
  await assert.rejects(find(setup({ chainId: 1n })), /BSC mainnet/);
  await assert.rejects(find(setup({ reorg: true })), /block changed/);
});

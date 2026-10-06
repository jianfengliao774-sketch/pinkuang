import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Interface } from 'ethers';
import { communityPage, verifyCommunityPool } from './community.mjs';
import { chainIndexInterfaces } from './indexer.mjs';
import { createChainIndexServer } from './api.mjs';
import { validateIndexRequest } from '../live-data-proxy.mjs';

const addr = n => `0x${n.toString(16).padStart(40, '0')}`;
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const factory = addr(1), pool = addr(2), collection = addr(3), timestamp = 1_800_000_000;
const metadata = { address: pool, createdBlock: 1, collection, circuitId: '16210' };
const event = { address: factory, blockNumber: 1, timestamp, txHash: hash(1), logIndex: 0,
  args: { pool, circuits: collection, circuitId: '16210', targetRaise: '1100', priceCap: '1000' } };
const source = { complete: true, factory, indexedThrough: 100, indexedBlockHash: hash(100), indexedTimestamp: timestamp + 100 };
const params = { circuits: collection, circuitId: 16210n, targetRaise: 1100n, priceCap: 1000n,
  directSeller: addr(4), directPrice: 1000n, fundingDeadline: timestamp + 3600, purchaseDeadline: timestamp + 7200 };
const binding = new Interface(['function isPool(address) view returns(bool)', 'function factory() view returns(address)']);
function answers(overrides = {}) {
  return { params, state: 0n, unitPriceWei: 11n, totalSupply: 13n, totalRaised: 143n,
    isPool: true, factory, depositPaused: false, ...overrides };
}
const callFor = overrides => async name => answers(overrides)[name];

test('community pool verifies immutable identity and block-pinned contract terms with exact integer shares', async () => {
  const item = await verifyCommunityPool(metadata, event, callFor(), source);
  assert.deepEqual(item, { address: pool, createdBlock: 1, createdAt: timestamp, eventId: `${hash(1)}:0`, collection,
    circuitId: '16210', actualCircuitId: '16210', targetRaiseWei: '1100', unitPriceWei: '11', totalShares: 100,
    subscribedShares: 13, state: 'Funding', fundingDeadline: timestamp + 3600, depositPaused: false, verified: true });
  assert.equal((await verifyCommunityPool(metadata, event, callFor({ depositPaused: true }), source)).depositPaused, true);
});

test('all lifecycle states come from the contract; refunds preserve original totalRaised and supply', async () => {
  for (const [state, expected] of ['Funding', 'Funded', 'Active', 'Listed', 'Closed', 'Refunding'].entries()) {
    const overrides = state === 0 || state === 5 ? { state } : { state, totalSupply: 100n, totalRaised: 1100n };
    assert.equal((await verifyCommunityPool(metadata, event, callFor(overrides), source)).state, expected);
  }
  const acquired = await verifyCommunityPool(metadata, event, callFor({ state: 2, totalSupply: 100n, totalRaised: 1100n,
    params: { ...params, circuitId: 20000n } }), source);
  assert.equal(acquired.circuitId, '16210'); assert.equal(acquired.actualCircuitId, '20000');
});

test('unregistered pools, changed creation terms, bad enum and inconsistent funding totals fail closed', async () => {
  for (const overrides of [{ isPool: false }, { factory: addr(9) }, { state: 6 }, { totalSupply: 101 },
    { state: 1 }, { state: 0, totalSupply: 100n, totalRaised: 1100n }, { totalRaised: 142n }, { unitPriceWei: 10n },
    { depositPaused: undefined }, { params: { ...params, circuitId: 20000n } },
    ...[{ targetRaise: 1101n }, { circuits: addr(9) }, { priceCap: 999n }, { fundingDeadline: timestamp },
      { purchaseDeadline: timestamp }].map(change => ({ params: { ...params, ...change } }))]) {
    await assert.rejects(verifyCommunityPool(metadata, event, callFor(overrides), source), /unsupported/);
  }
  for (const change of [{ address: addr(9) }, { blockNumber: 2 }, { txHash: 'bad' }, { logIndex: -1 },
    { args: { ...event.args, pool: addr(9) } }, { args: { ...event.args, circuitId: '99' } }]) {
    await assert.rejects(verifyCommunityPool(metadata, { ...event, ...change }, callFor(), source));
  }
});

function fixture({ empty = false, overrides = {} } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE headers(number INTEGER PRIMARY KEY, timestamp INTEGER);
    CREATE TABLE logs(block_number INTEGER,log_index INTEGER,tx_index INTEGER,tx_hash TEXT,address TEXT,kind TEXT,name TEXT,args TEXT)`);
  db.prepare('INSERT INTO headers VALUES(?,?)').run(1, timestamp);
  db.prepare('INSERT INTO logs VALUES(?,?,?,?,?,?,?,?)').run(1, 0, 0, hash(1), factory, 'factory', 'PoolCreated', JSON.stringify(event.args));
  const reads = [], values = answers(overrides);
  const index = { db, status: () => ({ ...source }), _header: n => ({ hash: hash(n) }),
    pools: options => { assert.equal(options.limit, 5); return { items: empty ? [] : [metadata], nextCursor: null }; },
    provider: { getBlock: async number => ({ number, hash: hash(number) }), call: async request => {
      reads.push(request); assert.equal(request.blockTag, source.indexedThrough);
      const iface = request.to === factory || binding.getFunction('factory').selector === request.data ? binding : chainIndexInterfaces.pool;
      const parsed = iface.parseTransaction({ data: request.data });
      if (parsed.name === 'isPool') { assert.equal(request.to, factory); assert.equal(parsed.args[0].toLowerCase(), pool); }
      else assert.equal(request.to, pool);
      return iface.encodeFunctionResult(parsed.name, [values[parsed.name]]);
    } } };
  return { index, reads, close: () => db.close() };
}

test('community page pins every read, joins one exact creation log and verifies final canonical header', async () => {
  const f = fixture();
  try {
    const result = await communityPage(f.index, chainIndexInterfaces.pool, { atBlock: 100, atHash: hash(100), anchorBlock: 90, anchorHash: hash(90) });
    assert.equal(result.schemaVersion, 1); assert.equal(result.anchorVerified, true); assert.equal(result.items[0].verified, true);
    assert.equal(f.reads.length, 8);
    await communityPage(f.index, chainIndexInterfaces.pool); assert.equal(f.reads.length, 8, 'same confirmed source can use cache');
    f.index.provider.getBlock = async () => ({ number: 100, hash: hash(999) });
    await assert.rejects(communityPage(f.index, chainIndexInterfaces.pool));
  } finally { f.close(); }
});

test('missing or duplicated PoolCreated logs isolate the bad pool', async () => {
  for (const mutate of [db => db.exec('DELETE FROM logs'), db => db.exec('INSERT INTO logs SELECT * FROM logs')]) {
    const f = fixture();
    try { mutate(f.index.db); const page = await communityPage(f.index, chainIndexInterfaces.pool);
      assert.deepEqual(page.items, []); assert.deepEqual(page.invalidPools, [pool]); }
    finally { f.close(); }
  }
});

test('pagination rejects changed pins, missing reorg anchors, invalid counts and simultaneous reads', async () => {
  const f = fixture({ empty: true });
  try {
    for (const options of [{ atBlock: 99, atHash: hash(99) }, { anchorBlock: 90, anchorHash: hash(91) },
      { anchorBlock: -1, anchorHash: hash(0) }, { limit: 0 }, { limit: 11 }, { cursor: -1 }]) {
      await assert.rejects(communityPage(f.index, chainIndexInterfaces.pool, options));
    }
    let release;
    f.index.provider.getBlock = () => new Promise(resolve => { release = resolve; });
    const pending = communityPage(f.index, chainIndexInterfaces.pool);
    await Promise.resolve(); await assert.rejects(communityPage(f.index, chainIndexInterfaces.pool), /already running/);
    f.index.status = () => ({ ...source, indexedThrough: 101 });
    release({ number: 100, hash: hash(100) }); await assert.rejects(pending);
    assert.equal(f.index.communityReadInFlight, false);
  } finally { f.close(); }
});

test('a stalled RPC cannot hold the snapshot request beyond its 20-second budget', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100 });
  const f = fixture({ empty: true });
  try {
    f.index.provider.getBlock = () => new Promise(() => {});
    const pending = communityPage(f.index, chainIndexInterfaces.pool);
    const rejected = assert.rejects(pending, /deadline exceeded/);
    t.mock.timers.tick(20_001); await rejected;
    assert.equal(f.index.communityReadInFlight, false);
  } finally { f.close(); t.mock.timers.reset(); }
});

test('community HTTP route returns source+data and fails closed on source change or malformed query', async () => {
  const f = fixture({ empty: true });
  const server = createChainIndexServer(f.index);
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/v1/community`;
    let response = await fetch(url); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { source, data: { schemaVersion: 1, items: [], invalidPools: [], nextCursor: null, anchorVerified: null } });
    assert.equal((await fetch(`${url}?limit=11`)).status, 503);
    assert.equal((await fetch(url, { method: 'POST' })).status, 405);
    f.index.provider.getBlock = async number => { f.index.status = () => ({ ...source, indexedThrough: 101 });
      return { number, hash: hash(number) }; };
    assert.equal((await fetch(url)).status, 503);
  } finally { await new Promise(resolve => server.close(resolve)); f.close(); }
});

test('community feed remains private to the loopback index', () => {
  assert.throws(() => validateIndexRequest(new URL('https://example.test/api/chain-index/v1/community')),
    error => error.status === 404);
});

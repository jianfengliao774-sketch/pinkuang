import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import test from 'node:test';
import { Interface, ZeroAddress, getAddress } from 'ethers';
import { ChainIndex, chainIndexInterfaces } from './indexer.mjs';
import { createChainIndexServer } from './api.mjs';
import { startChainIndex } from './server.mjs';

const addr = n => getAddress(`0x${n.toString(16).padStart(40, '0')}`).toLowerCase();
const factory = addr(1), market = addr(2), pool = addr(3), collection = addr(4), alice = addr(5), bob = addr(6), carol = addr(7);
const hex = n => `0x${n.toString(16).padStart(64, '0')}`;
const binding = new Interface(['function shareMarket() view returns(address)', 'function isPool(address) view returns(bool)',
  'function factory() view returns(address)', 'function poolCount() view returns(uint256)', 'function nextOrderId() view returns(uint256)']);

class MockChain {
  constructor() { this.version = 1; this.events = []; this._makeBlocks(); }
  _makeBlocks() {
    this.blocks = new Map();
    for (let number = 0; number <= 8; number++) {
      const hash = hex(this.version * 1000 + number);
      const parentHash = number === 0 ? hex(0) : hex(this.version * 1000 + number - 1);
      this.blocks.set(number, { number, hash, parentHash, timestamp: 1_700_000_000 + number * 3 });
    }
  }
  reorg() {
    this.version = 2;
    for (let number = 5; number <= 8; number++) {
      this.blocks.set(number, { number, hash: hex(2000 + number),
        parentHash: number === 5 ? this.blocks.get(4).hash : hex(2000 + number - 1),
        timestamp: 1_700_000_000 + number * 3 });
    }
    this.events = this.events.filter(log => log.blockNumber < 5);
  }
  event(kind, name, args, blockNumber) {
    const iface = chainIndexInterfaces[kind];
    const encoded = iface.encodeEventLog(iface.getEvent(name), args);
    const index = this.events.filter(log => log.blockNumber === blockNumber).length;
    this.events.push({ ...encoded, address: kind === 'factory' ? factory : kind === 'market' ? market : pool,
      blockNumber, blockHash: this.blocks.get(blockNumber).hash,
      transactionHash: hex(this.version * 100_000 + blockNumber * 100 + index), transactionIndex: index, index });
  }
  getNetwork() { return Promise.resolve({ chainId: 56n }); }
  send(method) { return Promise.resolve(method === 'eth_chainId' ? '0x38' : null); }
  getCode() { return Promise.resolve('0x6001'); }
  getBlock(number) { return Promise.resolve(number === 'latest' ? this.blocks.get(8) : this.blocks.get(number) ?? null); }
  call({ to, data, blockTag }) {
    assert(Number.isSafeInteger(blockTag) && blockTag >= 1 && blockTag <= 6,
      'all contract reads must use the indexed source block, not latest');
    const parsed = binding.parseTransaction({ data });
    let result;
    if (parsed.name === 'shareMarket' && to.toLowerCase() === factory) result = market;
    else if (parsed.name === 'factory' && to.toLowerCase() === market) result = factory;
    else if (parsed.name === 'isPool' && to.toLowerCase() === factory) result = parsed.args[0].toLowerCase() === pool;
    else if (parsed.name === 'poolCount' && to.toLowerCase() === factory) result = 1n;
    else if (parsed.name === 'nextOrderId' && to.toLowerCase() === market) result = 2n;
    else throw new Error('Unexpected binding call.');
    return Promise.resolve(binding.encodeFunctionResult(parsed.name, [result]));
  }
  getLogs({ address, fromBlock, toBlock, topics }) {
    const addresses = (Array.isArray(address) ? address : [address]).map(x => x.toLowerCase());
    return Promise.resolve(this.events.filter(log => log.blockNumber >= fromBlock && log.blockNumber <= toBlock
      && addresses.includes(log.address) && topics[0].includes(log.topics[0])));
  }
}

function fixture(chain) {
  chain.event('factory', 'PoolCreated', [pool, collection, 16210n, 1100n, 1000n, alice], 1);
  chain.event('pool', 'Deposited', [alice, 49, 539n, 539n], 2);
  chain.event('pool', 'Transfer', [ZeroAddress, alice, 49n], 2);
  chain.event('pool', 'Harvested', [1000n, 10n, 0n, 990n], 3);
  chain.event('pool', 'Purchased', [500n, 0, 123n], 3);
  chain.event('pool', 'BemClaimed', [alice, 100n], 4);
  chain.event('market', 'OrderListed', [1n, alice, pool, 5n, 10n], 4);
  chain.event('market', 'OrderExpirySet', [1n, 1_800_000_000], 4);
  chain.event('market', 'OrderFilled', [1n, bob, 2n, 20n, 0n], 5);
  chain.event('pool', 'Transfer', [alice, bob, 2n], 5);
  chain.event('pool', 'Harvested', [1000n, 10n, 0n, 990n], 7); // Unconfirmed at the configured safe head.
}

function headerBatchFixture({ change = (_number, _count, header) => header, failAt } = {}) {
  let active = 0, peak = 0, calls = 0;
  const counts = new Map(), finished = [];
  const provider = {
    getLogs: async () => [], call: async () => { throw new Error('Unexpected contract read.'); }, send: async () => '0x38',
    async getBlock(number) {
      calls++; active++; peak = Math.max(peak, active);
      const count = (counts.get(number) || 0) + 1; counts.set(number, count);
      try {
        // Reverse completion order within each batch without changing chain order.
        await new Promise(resolve => setTimeout(resolve, 8 - number % 8));
        if (number === failAt) throw new Error('Header unavailable.');
        return change(number, count, { number, hash: hex(number), parentHash: hex(number - 1), timestamp: 1_800_000_000 + number });
      } finally { active--; finished.push(number); }
    },
  };
  const index = new ChainIndex(provider, { dbPath: ':memory:', factory, market, startBlock: 1, scanRange: 100 });
  return { index, counts, finished, metrics: () => ({ active, peak, calls }) };
}

test('header scan uses at most eight concurrent reads and commits all 100 ordered headers atomically', async () => {
  const f = headerBatchFixture();
  try {
    await f.index._scanChunk(1, 100);
    assert.deepEqual(f.metrics(), { active: 0, peak: 8, calls: 101 });
    assert.notEqual(f.finished[0], 1, 'fixture must exercise out-of-order responses');
    assert.equal(f.index.indexedThrough, 100);
    const headers = f.index.db.prepare('SELECT number, hash, parent_hash FROM headers ORDER BY number').all();
    assert.equal(headers.length, 100);
    for (const [offset, header] of headers.entries()) {
      assert.equal(header.number, offset + 1); assert.equal(header.hash, hex(offset + 1));
      assert.equal(header.parent_hash, hex(offset));
    }
  } finally { f.index.close(); }
});

test('missing, wrong-number, disconnected and changed final headers never partially commit', async () => {
  const cases = [
    (_number, _count, header) => header.number === 3 ? null : header,
    (_number, _count, header) => header.number === 4 ? { ...header, number: 5 } : header,
    (_number, _count, header) => header.number === 9 ? { ...header, parentHash: hex(999) } : header,
    (number, count, header) => number === 12 && count > 1 ? { ...header, hash: hex(999) } : header,
    (number, count, header) => number === 12 && count > 1 ? { ...header, number: 13 } : header,
  ];
  for (const change of cases) {
    const f = headerBatchFixture({ change });
    try {
      await assert.rejects(f.index._scanChunk(1, 12));
      assert.equal(f.metrics().active, 0, 'failed scan must drain in-flight reads');
      assert(f.metrics().peak <= 8);
      assert.equal(f.index.indexedThrough, 0);
      assert.equal(f.index.db.prepare('SELECT COUNT(*) AS count FROM headers').get().count, 0);
      assert.equal(f.index.db.prepare('SELECT COUNT(*) AS count FROM logs').get().count, 0);
    } finally { f.index.close(); }
  }
});

test('failed parallel batch drains reads and a broken next batch preserves the committed anchor', async () => {
  const unavailable = headerBatchFixture({ failAt: 3 });
  try {
    await assert.rejects(unavailable.index._scanChunk(1, 20), /Header unavailable/);
    assert.deepEqual(unavailable.metrics(), { active: 0, peak: 8, calls: 8 });
    assert.equal(unavailable.index.indexedThrough, 0);
  } finally { unavailable.index.close(); }
  const disconnected = headerBatchFixture({ change: (number, _count, header) => number === 9 ? { ...header, parentHash: hex(999) } : header });
  try {
    await disconnected.index._scanChunk(1, 8);
    await assert.rejects(disconnected.index._scanChunk(9, 16), /Chain changed during header scan/);
    assert.equal(disconnected.index.indexedThrough, 8);
    assert.equal(disconnected.index.db.prepare('SELECT COUNT(*) AS count FROM headers').get().count, 8);
    assert.equal(disconnected.index._header(8).hash, hex(8));
  } finally { disconnected.index.close(); }
});

test('bounded confirmed indexing, exact balances, historical positions and reorg rollback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pinkuang-chain-index-'));
  const dbPath = join(directory, 'index.sqlite');
  const chain = new MockChain(); fixture(chain);
  const config = { dbPath, factory, market, startBlock: 1, confirmations: 2, scanRange: 2, maxBlocksPerSync: 20 };
  let index;
  try {
    index = new ChainIndex(chain, config);
    const status = await index.sync();
    assert.equal(status.complete, true);
    assert.equal(status.indexedThrough, 6);
    assert.equal(index.pools().items[0].circuitId, '16210');
    assert.deepEqual(index.accountPools(alice).items, [pool]);
    assert.deepEqual(index.accountPools(bob).items, [pool]);
    assert.equal(index.orders({ active: true }).items[0].remaining, '3');
    const curve = index.yieldCurve({ pool, account: alice, days: 1 });
    assert.equal(curve.buckets[0].poolHarvestNetAtomic, '990');
    assert.equal(curve.buckets[0].accountClaimedAtomic, '100');
    assert.equal(curve.accountUnclaimedDailyAccrual, null);
    assert(index.activity({ account: bob }).items.some(row => row.event === 'OrderFilled'));
    assert.equal(index.activity({ pool }).items.filter(row => row.event === 'Harvested').length, 1);
    assert.equal(index.activity({ pool }).items.filter(row => row.event === 'PoolCreated').length, 1);
    assert.deepEqual(index.stats(), { scope: 'confirmed_indexed_history', registeredPoolCount: '1',
      everParticipantAddressCount: '2', purchasedCostWei: '500', shareMarketFilledGrossWei: '20',
      harvestedToMembersBemAtomic: '990', estimatedDailyBemAtomic: null, currentlyActivePoolCount: null });
    index.close(); index = null;

    // Restart from durable state, then remove a confirmed fill in a simulated deep reorg.
    chain.reorg();
    index = new ChainIndex(chain, config);
    assert.equal(index.status().complete, false); // Unverified disk is never served after restart.
    await index.sync();
    assert.equal(index.orders({ active: true }).items[0].remaining, '5');
    assert.deepEqual(index.accountPools(bob).items, []);
    assert.equal(index.activity({ account: bob }).items.length, 0);
    assert.equal(index.status().indexedBlockHash, chain.blocks.get(6).hash);
    assert.equal(index.stats().everParticipantAddressCount, '1');
    assert.equal(index.stats().shareMarketFilledGrossWei, '0');
  } finally { index?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('one wallet subscribes 20+80 then another buys 40+60 without duplicate positions or people', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pinkuang-chain-index-repeat-'));
  const chain = new MockChain();
  chain.event('factory', 'PoolCreated', [pool, collection, 16210n, 1100n, 1000n, alice], 1);
  chain.event('pool', 'Deposited', [alice, 20, 220n, 220n], 2);
  chain.event('pool', 'Transfer', [ZeroAddress, alice, 20n], 2);
  chain.event('pool', 'Deposited', [alice, 80, 880n, 1100n], 2);
  chain.event('pool', 'Transfer', [ZeroAddress, alice, 80n], 2);
  chain.event('pool', 'Purchased', [500n, 0, 123n], 3);
  chain.event('market', 'OrderListed', [1n, alice, pool, 100n, 10n], 4);
  chain.event('market', 'OrderExpirySet', [1n, 1_800_000_000], 4);
  chain.event('market', 'OrderFilled', [1n, bob, 40n, 400n, 4n], 5);
  chain.event('pool', 'Transfer', [alice, bob, 40n], 5);
  chain.event('market', 'OrderFilled', [1n, bob, 60n, 600n, 6n], 6);
  chain.event('pool', 'Transfer', [alice, bob, 60n], 6);
  const index = new ChainIndex(chain, { dbPath: join(directory, 'index.sqlite'), factory, market,
    startBlock: 1, confirmations: 2 });
  try {
    await index.sync();
    assert.equal(index.stats().everParticipantAddressCount, '2');
    assert.deepEqual(index.accountPools(alice).items, [pool]);
    assert.deepEqual(index.accountPools(bob).items, [pool]);
    assert.equal(index.activity({ pool, account: alice }).items.filter(row => row.event === 'Deposited').length, 2);
    assert.equal(index.activity({ pool, account: bob }).items.filter(row => row.event === 'OrderFilled').length, 2);
    assert.equal(index.orders({ active: true }).items.length, 0);
    assert.equal(index.orders({ active: false }).items[0].remaining, '0');
    assert.equal(index.stats().shareMarketFilledGrossWei, '1000');
  } finally { index.close(); await rm(directory, { recursive: true, force: true }); }
});

test('competing final-share fills index only the winner and replace it after a reorg', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pinkuang-chain-index-race-'));
  const chain = new MockChain();
  chain.event('factory', 'PoolCreated', [pool, collection, 16210n, 1100n, 1000n, alice], 1);
  chain.event('pool', 'Deposited', [alice, 1, 11n, 11n], 2);
  chain.event('pool', 'Transfer', [ZeroAddress, alice, 1n], 2);
  chain.event('pool', 'Purchased', [10n, 0, 123n], 3);
  chain.event('market', 'OrderListed', [1n, alice, pool, 1n, 10n], 4);
  chain.event('market', 'OrderExpirySet', [1n, 1_800_000_000], 4);
  chain.event('market', 'OrderFilled', [1n, bob, 1n, 10n, 0n], 5);
  chain.event('pool', 'Transfer', [alice, bob, 1n], 5);
  chain.events.reverse(); // An RPC may return the different contract log pages in arbitrary order.
  const index = new ChainIndex(chain, { dbPath: join(directory, 'index.sqlite'), factory, market,
    startBlock: 1, confirmations: 2 });
  try {
    await index.sync();
    assert.equal(index.orders({ active: false }).items[0].remaining, '0');
    assert.deepEqual(index.accountPools(bob).items, [pool]);
    assert.deepEqual(index.accountPools(carol).items, []);
    assert.equal(index.activity({ pool }).items.filter(row => row.event === 'OrderFilled').length, 1);
    assert.equal(index.stats().shareMarketFilledGrossWei, '10');

    chain.reorg();
    chain.event('market', 'OrderFilled', [1n, carol, 1n, 10n, 0n], 5);
    chain.event('pool', 'Transfer', [alice, carol, 1n], 5);
    await index.sync();
    assert.equal(index.orders({ active: false }).items[0].remaining, '0');
    assert.deepEqual(index.accountPools(bob).items, []);
    assert.deepEqual(index.accountPools(carol).items, [pool]);
    assert.equal(index.activity({ account: bob }).items.length, 0);
    assert.equal(index.activity({ pool }).items.filter(row => row.event === 'OrderFilled').length, 1);
    assert.equal(index.stats().everParticipantAddressCount, '2');
    assert.equal(index.stats().shareMarketFilledGrossWei, '10');
  } finally { index.close(); await rm(directory, { recursive: true, force: true }); }
});

test('wrong chain/binding or mismatched logs fail closed without advancing durable cursor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pinkuang-chain-index-bad-'));
  const dbPath = join(directory, 'index.sqlite');
  const chain = new MockChain(); fixture(chain);
  const index = new ChainIndex(chain, { dbPath, factory, market, startBlock: 1, confirmations: 2, scanRange: 2 });
  try {
    chain.send = () => Promise.resolve('0x1');
    await assert.rejects(index.sync(), /BSC mainnet/);
    assert.equal(index.indexedThrough, 0);
    assert.equal(index.status().unknownReason, 'wrong_chain');
    chain.send = () => Promise.resolve('0x38');
    const original = chain.getLogs.bind(chain);
    chain.getLogs = async filter => (await original(filter)).map(log => ({ ...log,
      blockHash: log.blockNumber === 3 ? hex(999999) : log.blockHash }));
    await assert.rejects(index.sync(), /canonical scanned headers/);
    assert.equal(index.indexedThrough, 2); // First two-block chunk committed; bad next chunk did not.
    assert.equal(index.status().complete, false);
  } finally { index.close(); await rm(directory, { recursive: true, force: true }); }
});

test('HTTP returns source block, bounded pages and 503 until verified', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pinkuang-chain-index-api-'));
  const dbPath = join(directory, 'index.sqlite');
  const chain = new MockChain(); fixture(chain);
  const index = new ChainIndex(chain, { dbPath, factory, market, startBlock: 1, confirmations: 2 });
  const server = createChainIndexServer(index);
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${url}/v1/pools`)).status, 503);
    const originalSend = chain.send.bind(chain);
    chain.send = () => Promise.reject(new Error('upstream https://rpc.example/?token=secret'));
    await assert.rejects(index.sync());
    const failedHealth = await (await fetch(`${url}/health`)).text();
    assert.equal(failedHealth.includes('secret'), false);
    assert.equal(JSON.parse(failedHealth).source.unknownReason, 'sync_failed');
    chain.send = originalSend;
    await index.sync();
    const response = await fetch(`${url}/v1/pools?limit=1`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.source.indexedBlockHash, chain.blocks.get(6).hash);
    assert.equal(body.data.items[0].address, pool);
    const stats = (await (await fetch(`${url}/v1/stats`)).json()).data;
    assert.equal(stats.purchasedCostWei, '500');
    assert.equal(stats.estimatedDailyBemAtomic, null);
    assert.equal((await fetch(`${url}/v1/pools?limit=51`)).status, 400);
    assert.equal((await fetch(`${url}/v1/yield?pool=${pool}&account=${alice}&days=1`)).status, 200);
    assert.equal((await fetch(`${url}/v1/orders?active=true`)).status, 200);
    assert.equal((await fetch(`${url}/v1/accounts/${bob}/pools`)).status, 200);
    assert.equal((await fetch(`${url}/v1/activity?account=${bob}`)).status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('listener startup fails cleanly when the port is occupied', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pinkuang-chain-index-listen-'));
  const occupied = createNetServer();
  try {
    await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
    await assert.rejects(startChainIndex({ rpc: 'https://example.org', host: '127.0.0.1',
      port: occupied.address().port, dbPath: join(directory, 'index.sqlite'), factory, market,
      startBlock: 1, confirmations: 2 }), { code: 'EADDRINUSE' });
  } finally {
    await new Promise(resolve => occupied.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('counter mismatch detects a late start block or incomplete event history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pinkuang-chain-index-gap-'));
  const chain = new MockChain(); fixture(chain);
  const index = new ChainIndex(chain, { dbPath: join(directory, 'index.sqlite'), factory, market,
    startBlock: 2, confirmations: 2 }); // Misses the PoolCreated event in block 1.
  try {
    await assert.rejects(index.sync(), /Event history is incomplete/);
    assert.equal(index.status().complete, false);
    assert.equal(index.pools().items.length, 0);
  } finally { index.close(); await rm(directory, { recursive: true, force: true }); }
});

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
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

const displayRoutes = ['/v1/pools', '/v1/portfolios', '/v1/stats', '/v1/orders'];

async function assertInvalidatedDisplay(index, baseUrl) {
  assert.equal(index.snapshotTrusted, false);
  assert.equal(index.verifiedDisplaySnapshot(), null);
  assert.equal(index.db.prepare('SELECT COUNT(*) AS count FROM verified_display_snapshot').get().count, 0);
  for (const route of displayRoutes) {
    assert.equal((await fetch(`${baseUrl}${route}`)).status, 503, `ordinary ${route} must fail closed`);
    const snapshotRoute = route.replace('/v1/', '/v1/snapshot/');
    assert.equal((await fetch(`${baseUrl}${snapshotRoute}`)).status, 503,
      `explicit ${snapshotRoute} must fail closed`);
  }
  assert.equal((await fetch(`${baseUrl}/v1/activity`)).status, 503);
  const health = await (await fetch(`${baseUrl}/health`)).json();
  assert.equal(health.source.complete, false);
  assert.equal(health.displaySource, undefined);
}

test('short index refresh returns a fresh page; unfinished refresh never makes its old tip actionable', async () => {
  let syncing = true, finishRefresh = true;
  const waits = [];
  const index = {
    get syncing() { return syncing; },
    status: () => ({ complete: true, unknownReason: null, indexedThrough: syncing ? 6 : 7,
      indexedBlockHash: syncing ? hex(6) : hex(7) }),
    async waitForSync(timeout) { waits.push(timeout); if (finishRefresh) syncing = false; },
    acquireVerifiedReadView: () => null,
    verifiedDisplaySnapshot: () => null,
    stats: () => ({ registeredPoolCount: '1' }),
  };
  const server = createChainIndexServer(index, { syncWaitMs: 75 });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const fresh = await (await fetch(`${base}/v1/stats`)).json();
    assert.equal(fresh.source.complete, true);
    assert.equal(fresh.source.indexedThrough, 7);
    assert.equal(fresh.source.readMode, undefined);
    assert.deepEqual(fresh.data, { registeredPoolCount: '1' });
    assert.deepEqual(waits, [75]);

    syncing = true; finishRefresh = false;
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.source.complete, false);
    assert.equal(health.source.unknownReason, 'index_refreshing');
    assert.equal(health.source.transactionReady, false);
    const pending = await fetch(`${base}/v1/stats`);
    assert.equal(pending.status, 503);
    const body = await pending.json();
    assert.equal(body.source.complete, false);
    assert.equal(body.source.transactionReady, false);
    assert.deepEqual(waits, [75, 75, 75]);

    syncing = false;
    index.stats = () => { syncing = true; return { registeredPoolCount: '1' }; };
    const changed = await fetch(`${base}/v1/stats`);
    assert.equal(changed.status, 503);
    assert.equal((await changed.json()).source.transactionReady, false,
      'a new sync starting during the read must not leave an actionable response');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

function headerBatchFixture({ change = (_number, _count, header) => header, failAt, headerConcurrency = 8 } = {}) {
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
  const index = new ChainIndex(provider, { dbPath: ':memory:', factory, market, startBlock: 1, scanRange: 100, headerConcurrency });
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

test('catch-up scans every header with bounded 64-read windows and drains a failed window without committing', async () => {
  const f = headerBatchFixture({headerConcurrency:64});
  try {
    await f.index._scanChunk(1,193);
    assert.deepEqual(f.metrics(),{active:0,peak:64,calls:194});
    const headers=f.index.db.prepare('SELECT number,hash,parent_hash FROM headers ORDER BY number').all();
    assert.equal(headers.length,193);
    for(const [i,header] of headers.entries())assert.deepEqual({...header},
      {number:i+1,hash:hex(i+1),parent_hash:hex(i)});
    assert.equal(f.counts.get(193),2,'final tip is still checked before commit');
  } finally {f.index.close();}
  const failed=headerBatchFixture({headerConcurrency:64,failAt:31});
  try {
    await assert.rejects(failed.index._scanChunk(1,193),/Header unavailable/);
    assert.deepEqual(failed.metrics(),{active:0,peak:64,calls:64});
    assert.equal(failed.index.indexedThrough,0);
    assert.equal(failed.index.db.prepare('SELECT COUNT(*) AS count FROM headers').get().count,0);
  } finally {failed.index.close();}
  assert.throws(()=>headerBatchFixture({headerConcurrency:65}),/Scan bounds/);
});

const newEventNames=['SaleDelistingProposed','SaleDelistingVoted','SaleDelisted'];
function markPreviousEventSchema(index) {
  const topics=JSON.parse(index.db.prepare("SELECT value FROM metadata WHERE key='indexedEventTopics'").get().value);
  const additions=newEventNames.map(name=>chainIndexInterfaces.pool.getEvent(name).topicHash);
  topics.pool=topics.pool.filter(topic=>!additions.includes(topic));
  const eventSchema=createHash('sha256').update(JSON.stringify(Object.entries(topics)
    .sort(([a],[b])=>a.localeCompare(b)).map(([kind,values])=>[kind,[...values].sort()]))).digest('hex');
  const identity=JSON.parse(index.db.prepare("SELECT value FROM metadata WHERE key='identity'").get().value);
  identity.eventSchema=eventSchema;
  index.db.prepare("UPDATE metadata SET value=? WHERE key='identity'").run(JSON.stringify(identity));
  index.db.prepare("DELETE FROM metadata WHERE key='indexedEventTopics'").run();
  index.db.prepare(`DELETE FROM logs WHERE name IN (${newEventNames.map(()=>'?').join(',')})`).run(...newEventNames);
  return additions;
}

test('additive event migration preserves history and resumes bounded new-topic backfill after restart', async()=>{
  const directory=await mkdtemp(join(tmpdir(),'index-additive-events-'));
  const chain=new MockChain();fixture(chain);
  chain.event('pool','SaleDelistingProposed',[2n,7n,alice,1_700_000_012,2n],4);
  chain.event('pool','SaleDelistingVoted',[2n,alice,true,49n],5);
  chain.event('pool','SaleDelisted',[7n,2n],6);
  const config={dbPath:join(directory,'index.sqlite'),factory,market,startBlock:1,confirmations:2,scanRange:2,maxBlocksPerSync:20};
  let index;
  try {
    index=new ChainIndex(chain,config);await index.sync();
    const additions=markPreviousEventSchema(index);
    const oldLogs=index.db.prepare('SELECT COUNT(*) AS n FROM logs').get().n;
    index.close();index=new ChainIndex(chain,{...config,maxBlocksPerSync:2});
    assert.equal(index.indexedThrough,6);
    assert.equal(index.db.prepare('SELECT COUNT(*) AS n FROM logs').get().n,oldLogs);
    assert.equal(index.db.prepare('SELECT COUNT(*) AS n FROM headers').get().n,6);
    assert.equal(index.orders({active:true}).items[0].remaining,'3');
    assert.equal(index.status().complete,false);assert.equal(index.status().unknownReason,'event_topic_backfill');
    const reads=[],filters=[],getBlock=chain.getBlock.bind(chain),getLogs=chain.getLogs.bind(chain);
    chain.getBlock=number=>{reads.push(number);return getBlock(number);};
    chain.getLogs=filter=>{filters.push(filter);return getLogs(filter);};
    await index.sync();
    assert.equal(index.eventTopicBackfill.nextBlock,3);
    assert.deepEqual(filters.map(row=>[row.fromBlock,row.toBlock]),[[1,2]]);
    assert.deepEqual(filters[0].topics,[additions]);
    assert(reads.every(number=>number==='latest'||number===6),'do not replay historical headers');
    index.close();index=new ChainIndex(chain,{...config,maxBlocksPerSync:2});
    assert.equal(index.eventTopicBackfill.nextBlock,3,'migration cursor survives restart');
    await index.sync();assert.equal(index.status().complete,false);
    assert.equal(index.eventTopicBackfill.nextBlock,5);
    assert.equal((await index.sync()).complete,true);
    assert.equal(index.eventTopicBackfill,null);
    assert.equal(index.db.prepare('SELECT COUNT(*) AS n FROM logs').get().n,oldLogs+3);
    assert.equal(index.orders({active:true}).items[0].remaining,'3');
    assert.deepEqual(index.accountPools(bob).items,[pool]);
    assert.deepEqual(filters.map(row=>[row.fromBlock,row.toBlock]),[[1,2],[3,4],[5,6]]);
    assert(filters.every(row=>JSON.stringify(row.topics)===JSON.stringify([additions])));
    assert.equal(index.db.prepare('SELECT COUNT(*) AS n FROM headers').get().n,6);
  } finally {index?.close();await rm(directory,{recursive:true,force:true});}
});

test('unknown or non-additive topic schemas fail without deleting existing history', async()=>{
  const directory=await mkdtemp(join(tmpdir(),'index-preserve-unknown-schema-'));
  const dbPath=join(directory,'index.sqlite');
  const chain=new MockChain();fixture(chain);
  let index=new ChainIndex(chain,{dbPath,factory,market,startBlock:1,confirmations:2});
  try {
    await index.sync();
    const count=index.db.prepare('SELECT COUNT(*) AS n FROM logs').get().n;
    const identity=JSON.parse(index.db.prepare("SELECT value FROM metadata WHERE key='identity'").get().value);
    identity.eventSchema='unknown';
    index.db.prepare("UPDATE metadata SET value=? WHERE key='identity'").run(JSON.stringify(identity));
    index.close();index=null;
    assert.throws(()=>new ChainIndex(chain,{dbPath,factory,market,startBlock:1,confirmations:2}),/explicit migration; existing history was preserved/);
    const db=new DatabaseSync(dbPath);
    try {
      const topics=JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='indexedEventTopics'").get().value);
      topics.market=topics.market.filter(topic=>topic!==chainIndexInterfaces.market.getEvent('SaleReviewed').topicHash);
      identity.eventSchema=createHash('sha256').update(JSON.stringify(Object.entries(topics)
        .sort(([a],[b])=>a.localeCompare(b)).map(([kind,values])=>[kind,[...values].sort()]))).digest('hex');
      db.prepare("UPDATE metadata SET value=? WHERE key='identity'").run(JSON.stringify(identity));
      db.prepare("UPDATE metadata SET value=? WHERE key='indexedEventTopics'").run(JSON.stringify(topics));
      assert.throws(()=>new ChainIndex(chain,{dbPath,factory,market,startBlock:1,confirmations:2}),/explicit migration; existing history was preserved/);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM logs').get().n,count);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM headers').get().n,6);
      assert.equal(db.prepare("SELECT value FROM metadata WHERE key='indexedThrough'").get().value,'6');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pools').get().n,1);
    } finally {db.close();}
  } finally {index?.close();await rm(directory,{recursive:true,force:true});}
});

test('backfill rejects forked logs and changed saved tips without advancing its durable checkpoint', async()=>{
  const directory=await mkdtemp(join(tmpdir(),'index-backfill-fork-'));
  const chain=new MockChain();fixture(chain);
  chain.event('pool','SaleDelisted',[7n,2n],4);
  const config={dbPath:join(directory,'index.sqlite'),factory,market,startBlock:1,confirmations:2,scanRange:2,maxBlocksPerSync:20};
  let index;
  try {
    index=new ChainIndex(chain,config);await index.sync();markPreviousEventSchema(index);
    index.close();index=new ChainIndex(chain,config);
    const getLogs=chain.getLogs.bind(chain);
    chain.getLogs=async filter=>(await getLogs(filter)).map(log=>({...log,blockHash:hex(9999)}));
    await assert.rejects(index.sync(),/backfill logs do not match/);
    assert.equal(index.indexedThrough,6);assert.equal(index.eventTopicBackfill.nextBlock,3);
    assert.equal(index.db.prepare("SELECT COUNT(*) AS n FROM logs WHERE name='SaleDelisted'").get().n,0);
    chain.getLogs=getLogs;
    const getBlock=chain.getBlock.bind(chain);let anchorReads=0;
    chain.getBlock=async number=>{const header=await getBlock(number);return number===6 && ++anchorReads>1?{...header,hash:hex(9999)}:header;};
    await assert.rejects(index.sync(),/Chain changed before additive event migration commit/);
    assert.equal(index.eventTopicBackfill.nextBlock,3);
    chain.getBlock=getBlock;chain.reorg();
    assert.equal((await index.sync()).complete,true,'reorg reconciles both historical data and migration checkpoint');
    assert.equal(index.db.prepare("SELECT COUNT(*) AS n FROM logs WHERE name='SaleDelisted'").get().n,1);
    assert.equal(index.eventTopicBackfill,null);
  } finally {index?.close();await rm(directory,{recursive:true,force:true});}
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
    assert.equal(index.verifiedDisplaySnapshot().source.indexedBlockHash, chain.blocks.get(6).hash);
    assert.equal(index.verifiedDisplaySnapshot().source.registeredPoolCount, '1');
    assert.equal(index.verifiedDisplaySnapshot().source.standalonePoolCount, '1');
    assert.equal(index.verifiedDisplaySnapshot().orders[0].remaining, '3');
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
      standalonePoolCount:'1',portfolioCount:'0',childPoolCount:'0',reservedChildPoolCount:'0',
      reservedChildPoolAddresses:[],reservedChildPoolAddressesComplete:true,topLevelProjectCount:'1',
      everParticipantAddressCount: '2', purchasedCostWei: '500', shareMarketFilledGrossWei: '20',
      harvestedToMembersBemAtomic: '990', estimatedDailyBemAtomic: null, currentlyActivePoolCount: null });
    index.close(); index = null;

    // Restart from durable state, then remove a confirmed fill in a simulated deep reorg.
    chain.reorg();
    index = new ChainIndex(chain, config);
    assert.equal(index.status().complete, false); // Unverified disk is never served after restart.
    assert.equal(index.verifiedDisplaySnapshot(), null);
    await index.sync();
    assert.equal(index.verifiedDisplaySnapshot().source.indexedBlockHash, chain.blocks.get(6).hash);
    assert.equal(index.orders({ active: true }).items[0].remaining, '5');
    assert.deepEqual(index.accountPools(bob).items, []);
    assert.equal(index.activity({ account: bob }).items.length, 0);
    assert.equal(index.status().indexedBlockHash, chain.blocks.get(6).hash);
    assert.equal(index.stats().everParticipantAddressCount, '1');
    assert.equal(index.stats().shareMarketFilledGrossWei, '0');
  } finally { index?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('native delisting events are indexed and refresh the confirmed display generation, with reorg rollback', async () => {
  const chain = new MockChain(); fixture(chain);
  chain.event('pool', 'SaleDelistingProposed', [2n, 7n, alice, 1_700_000_012, 2n], 4);
  chain.event('pool', 'SaleDelistingVoted', [2n, alice, true, 49n], 5);
  chain.event('pool', 'SaleDelisted', [7n, 2n], 6);
  const index = new ChainIndex(chain, { dbPath: ':memory:', factory, market, startBlock: 1,
    confirmations: 2, scanRange: 2, maxBlocksPerSync: 20 });
  try {
    await index.sync();
    const rows = index.activity({ pool }).items.filter(row => row.event.startsWith('SaleDelist'));
    assert.deepEqual(rows.map(row => row.event), ['SaleDelisted', 'SaleDelistingVoted', 'SaleDelistingProposed']);
    assert.equal(rows[0].fields.proposalId, '7'); assert.equal(rows[0].fields.cancellationId, '2');
    const oldDisplay = index.verifiedDisplaySnapshot();
    assert.equal(oldDisplay.source.indexedThrough, 6);
    chain.reorg(); await index.sync();
    assert.notStrictEqual(index.verifiedDisplaySnapshot(), oldDisplay);
    assert.deepEqual(index.activity({ pool }).items.filter(row => row.event.startsWith('SaleDelist')).map(row => row.event),
      ['SaleDelistingProposed']);
  } finally { index.close(); }
});

test('verified display snapshot is an immutable in-process hit until rollback or a new proof', async () => {
  const chain = new MockChain(); fixture(chain);
  const index = new ChainIndex(chain, { dbPath: ':memory:', factory, market, startBlock: 1, confirmations: 2 });
  try {
    await index.sync();
    const first = index.verifiedDisplaySnapshot();
    assert(first);
    assert(Object.isFrozen(first) && Object.isFrozen(first.source)
      && Object.isFrozen(first.pools) && Object.isFrozen(first.pools[0])
      && Object.isFrozen(first.orders[0]), 'callers cannot mutate a shared display row');
    const prepare = index.db.prepare.bind(index.db);
    let snapshotSelects = 0;
    index.db.prepare = sql => {
      if (sql.startsWith('SELECT source,pools,stats,portfolios,orders FROM verified_display_snapshot')) snapshotSelects++;
      return prepare(sql);
    };
    for (let attempt = 0; attempt < 10; attempt++)
      assert.strictEqual(index.verifiedDisplaySnapshot(), first);
    assert.equal(snapshotSelects, 0, 'a captured snapshot must not be fetched or parsed for each request');
    index.db.prepare = prepare;

    index._rollback(4);
    assert.equal(index.verifiedDisplaySnapshot(), null);
    assert.equal(index.db.prepare('SELECT COUNT(*) AS n FROM verified_display_snapshot').get().n, 0);
    await index.sync();
    const recaptured = index.verifiedDisplaySnapshot();
    assert(recaptured);
    assert.notStrictEqual(recaptured, first, 'a new full proof replaces the former parsed snapshot');
  } finally { index.close(); }
});

test('restart rechecks the persisted tip, then lazily parses a stale display copy only once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pinkuang-chain-index-cache-restart-'));
  const dbPath = join(directory, 'index.sqlite');
  const chain = new MockChain(); fixture(chain);
  const config = { dbPath, factory, market, startBlock: 1, confirmations: 2 };
  let index;
  try {
    index = new ChainIndex(chain, config);
    await index.sync();
    const originalHash = index.verifiedDisplaySnapshot().source.indexedBlockHash;
    index.close(); index = new ChainIndex(chain, config);
    assert.equal(index.verifiedDisplaySnapshot(), null, 'disk state is not trusted before chain recheck');
    const call = chain.call.bind(chain);
    chain.call = input => binding.parseTransaction({ data: input.data }).name === 'poolCount'
      ? Promise.reject(new Error('temporary count RPC outage')) : call(input);
    await assert.rejects(index.sync(), /temporary count RPC outage/);
    assert.equal(index.snapshotTrusted, true, 'the saved canonical block was rechecked before the transient failure');
    const prepare = index.db.prepare.bind(index.db);
    let snapshotSelects = 0;
    index.db.prepare = sql => {
      if (sql.startsWith('SELECT source,pools,stats,portfolios,orders FROM verified_display_snapshot')) snapshotSelects++;
      return prepare(sql);
    };
    const restored = index.verifiedDisplaySnapshot();
    assert.equal(restored.source.indexedBlockHash, originalHash);
    assert.strictEqual(index.verifiedDisplaySnapshot(), restored);
    assert.equal(snapshotSelects, 1, 'restart recovery reads and parses the persisted row once');
    index.db.prepare = prepare;
  } finally { index?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('verified statistics snapshot remains available after ten thousand historical logs', async () => {
  const chain = new MockChain(); fixture(chain);
  const index = new ChainIndex(chain, { dbPath: ':memory:', factory, market, startBlock: 1, confirmations: 2 });
  try {
    await index.sync();
    const before = index.stats();
    const insert = index.db.prepare('INSERT INTO logs(block_number,tx_index,log_index,tx_hash,address,kind,name,args) VALUES(?,?,?,?,?,?,?,?)');
    index.db.exec('BEGIN IMMEDIATE');
    try {
      for (let i = 0; i < 10_001; i++) {
        insert.run(6, 1, i, hex(1_000_000 + i), pool, 'pool', 'BemClaimed', '{}');
      }
      index.db.exec('COMMIT');
    } catch (error) { index.db.exec('ROLLBACK'); throw error; }
    index.statsGeneration++;
    index._captureVerifiedSnapshot();
    assert.equal(index.verifiedDisplaySnapshot().stats.purchasedCostWei, before.purchasedCostWei);
    assert.equal(index.verifiedDisplaySnapshot().stats.everParticipantAddressCount, before.everParticipantAddressCount);
  } finally { index.close(); }
});

test('new buyer-fee event is indexed while old OrderFilled history still replays', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pinkuang-chain-index-bilateral-fee-'));
  const chain = new MockChain(); fixture(chain);
  chain.event('market', 'BuyerFeeCharged', [1n, bob, carol, 1n], 5);
  const index = new ChainIndex(chain, { dbPath: join(directory, 'index.sqlite'), factory, market, startBlock: 1, confirmations: 2 });
  try {
    await index.sync();
    assert.equal(index.orders({ active: true }).items[0].remaining, '3', 'buyer-fee event must not count as another fill');
    assert.equal(index.stats().shareMarketFilledGrossWei, '20', 'gross amount remains the OrderFilled base price');
    const buyerFees = index.activity({ pool, account: bob }).items.filter(row => row.event === 'BuyerFeeCharged');
    assert.equal(buyerFees.length, 1);
    assert.deepEqual(buyerFees[0].fields, { orderId: '1', buyer: bob, treasury: carol, buyerFee: '1' });
    assert.equal(index.activity({ pool, account: carol }).items.filter(row => row.event === 'BuyerFeeCharged').length, 1,
      'treasury account history includes the buyer fee');
    assert.equal(index.activity({ pool, account: bob }).items.filter(row => row.event === 'OrderFilled').length, 1);
  } finally { index.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Firsto detail preserves order and fee evidence without double counting the Purchased cost',async()=>{
  const chain=new MockChain();
  chain.event('factory','PoolCreated',[pool,collection,16210n,1100n,1000n,alice],1);
  chain.event('pool','Purchased',[505n,2,0n],3);
  chain.event('pool','FirstoPurchased',[addr(90),hex(91),16210n,500n,5n,505n],3);
  chain.event('market','OrderListed',[1n,alice,pool,5n,10n],4);
  const index=new ChainIndex(chain,{dbPath:':memory:',factory,market,startBlock:1,confirmations:2,scanRange:2,maxBlocksPerSync:20});
  try{
    await index.sync();
    assert.equal(index.stats().purchasedCostWei,'505');
    const detail=index.activity({pool}).items.find(row=>row.event==='FirstoPurchased');
    assert.equal(detail.fields.orderHash,hex(91));assert.equal(detail.fields.exchange,addr(90));
    assert.equal(detail.fields.sellerPrice,'500');assert.equal(detail.fields.sourceFee,'5');assert.equal(detail.fields.totalCost,'505');
  }finally{index.close();}
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
    assert.equal((await fetch(`${url}/v1/snapshot/pools`)).status, 503);
    assert.equal(index.verifiedReadView, null, 'the first sync has no prior verified database to read');
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
    const saved = await (await fetch(`${url}/v1/snapshot/pools?limit=1`)).json();
    assert.equal(saved.source.readMode, 'verified_snapshot');
    assert.equal(saved.source.stale, true);
    assert.equal(saved.source.transactionReady, false);
    assert.equal(saved.source.poolsAvailable, true);
    assert.equal(saved.source.portfoliosAvailable, true);
    assert.equal(saved.source.ordersAvailable, true);
    assert.equal(typeof saved.source.checkedAt, 'string');
    assert.deepEqual(saved.block, { number: 6, hash: chain.blocks.get(6).hash,
      timestamp: chain.blocks.get(6).timestamp });
    assert.equal(saved.data.items[0].address, pool);
    assert.equal(saved.data.registeredPoolCount, '1');
    assert.equal(saved.data.childPoolCount, '0');
    assert.equal((await (await fetch(`${url}/v1/snapshot/stats`)).json()).data.purchasedCostWei, '500');
    const savedPortfolios = await (await fetch(`${url}/v1/snapshot/portfolios`)).json();
    assert.equal(savedPortfolios.source.readMode, 'verified_snapshot');
    assert.equal(savedPortfolios.source.portfolioCount, '0');
    assert.deepEqual(savedPortfolios.data.items, []);
    const savedOrders = await (await fetch(`${url}/v1/snapshot/orders?active=true&seller=${alice}`)).json();
    assert.equal(savedOrders.source.readMode, 'verified_snapshot');
    assert.equal(savedOrders.data.items[0].remaining, '3');
    assert.equal(savedOrders.data.ordersAvailable, true);
    assert(savedOrders.data.items.every(order => order.executable === false));
    assert.equal((await (await fetch(`${url}/v1/snapshot/orders?active=false`)).json()).data.items.length, 0);
    assert.equal(saved.source.factory, factory);
    assert.equal(saved.source.market, market);
    assert.deepEqual(savedPortfolios.block, saved.block);
    assert.deepEqual(savedOrders.block, saved.block);
    const savedStats = await (await fetch(`${url}/v1/snapshot/stats`)).json();
    assert.deepEqual(savedStats.block, saved.block);
    assert.deepEqual(savedStats.data, index.verifiedDisplaySnapshot().stats);
    const originalGetBlock = chain.getBlock.bind(chain);
    chain.getBlock = () => { throw new Error('The precomputed display request must not read RPC.'); };
    for (const section of ['pools', 'portfolios', 'stats', 'orders'])
      assert.equal((await fetch(`${url}/v1/snapshot/${section}`)).status, 200);
    chain.getBlock = originalGetBlock;
    assert.equal((await fetch(`${url}/v1/snapshot/pools?limit=51`)).status, 400);
    assert.equal((await fetch(`${url}/v1/snapshot/pools`, { method: 'POST' })).status, 405);
    const stats = (await (await fetch(`${url}/v1/stats`)).json()).data;
    assert.equal(stats.purchasedCostWei, '500');
    assert.equal(stats.estimatedDailyBemAtomic, null);
    assert.equal((await fetch(`${url}/v1/pools?limit=51`)).status, 400);
    assert.equal((await fetch(`${url}/v1/yield?pool=${pool}&account=${alice}&days=1`)).status, 200);
    assert.equal((await fetch(`${url}/v1/orders?active=true`)).status, 200);
    assert.equal((await fetch(`${url}/v1/accounts/${bob}/pools`)).status, 200);
    assert.equal((await fetch(`${url}/v1/activity?account=${bob}`)).status, 200);
    const currentTime = Date.now;
    try {
      Date.now = () => currentTime() + 31 * 60 * 1000;
      assert.equal((await fetch(`${url}/v1/snapshot/pools`)).status, 503,
        'the in-process display copy must expire 30 minutes after verification');
    } finally { Date.now = currentTime; }
    assert.equal(index.verifiedDisplaySnapshot(), null, 'an expired copy cannot reappear from the persisted row');
  } finally {
    await new Promise(resolve => server.close(resolve));
    index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('display snapshot capture failure does not close a verified live index', async () => {
  const chain = new MockChain(); fixture(chain);
  const index = new ChainIndex(chain, { dbPath: ':memory:', factory, market, startBlock: 1, confirmations: 2 });
  const server = createChainIndexServer(index);
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    await index.sync();
    assert(index.verifiedDisplaySnapshot());
    index._captureVerifiedSnapshot = () => { throw new Error('directory mismatch'); };
    const status = await index.sync();
    assert.equal(status.complete, true);
    assert.equal(status.unknownReason, null);
    assert.equal(index.lastSnapshotError, 'snapshot_failed');
    assert.equal(index.verifiedDisplaySnapshot(), null);
    assert.equal((await fetch(`${base}/v1/pools`)).status, 200);
    assert.equal((await fetch(`${base}/v1/snapshot/pools`)).status, 503);
  } finally {
    await new Promise(resolve => server.close(resolve));
    index.close();
  }
});

test('display snapshot lists newest pools first and finds an older pool by exact address', async () => {
  const chain=new MockChain(); fixture(chain);
  const newer=addr(99);
  chain.event('factory','PoolCreated',[newer,collection,16210n,1100n,1000n,bob],2);
  const originalCall=chain.call.bind(chain);
  chain.call=({to,data,...rest})=>{
    const parsed=binding.parseTransaction({data});
    if(parsed.name==='poolCount') return Promise.resolve(binding.encodeFunctionResult('poolCount',[2n]));
    if(parsed.name==='isPool') return Promise.resolve(binding.encodeFunctionResult('isPool',
      [[pool,newer].includes(parsed.args[0].toLowerCase())]));
    return originalCall({to,data,...rest});
  };
  const index=new ChainIndex(chain,{dbPath:':memory:',factory,market,startBlock:1,confirmations:2});
  const server=createChainIndexServer(index);
  try {
    await index.sync();
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    const newest=await (await fetch(`${base}/v1/snapshot/pools?limit=1`)).json();
    assert.equal(newest.data.items[0].address,newer);
    assert.equal(newest.data.nextCursor,1);
    const older=await (await fetch(`${base}/v1/snapshot/pools/${pool}`)).json();
    assert.equal(older.data.lookupAddress,pool);
    assert.equal(older.data.items[0].address,pool);
    assert.equal(older.data.nextCursor,null);
    assert.deepEqual(older.block,newest.block);
    assert.equal(older.source.standalonePoolCount,'2');
    const missing=await fetch(`${base}/v1/snapshot/pools/${addr(98)}`);
    assert.equal(missing.status,200);
    assert.deepEqual((await missing.json()).data.items,[]);
    assert.equal((await fetch(`${base}/v1/snapshot/pools/${pool}?limit=1`)).status,400);
  } finally { await new Promise(resolve=>server.close(resolve));index.close(); }
});

test('index API reports internal status and read failures as unavailable, not invalid user input', async () => {
  const index={status(){throw new Error('private database path');}};
  const server=createChainIndexServer(index);
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    const response=await fetch(`${base}/health`);
    assert.equal(response.status,503);
    assert.equal((await response.text()).includes('private database path'),false);
    index.status=()=>({complete:true,indexedThrough:1,indexedBlockHash:hex(1)});
    index.pools=()=>{throw new Error('private database path');};
    const broken=await fetch(`${base}/v1/pools`);
    assert.equal(broken.status,503);
    assert.equal((await broken.text()).includes('private database path'),false);
    assert.equal((await fetch(`${base}/v1/pools?limit=51`)).status,400);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('missing indexed events trigger one persisted full replay and recover automatically', async () => {
  const chain = new MockChain(); fixture(chain);
  const index = new ChainIndex(chain, { dbPath: ':memory:', factory, market, startBlock: 1,
    confirmations: 2, maxBlocksPerSync: 20 });
  try {
    await index.sync();
    index.db.prepare("DELETE FROM logs WHERE kind='market' AND name='OrderListed'").run();
    await assert.rejects(index.sync(), /Event history is incomplete/);
    assert.equal(index.status().unknownReason, 'incomplete_history');
    assert.equal(index.db.prepare("SELECT value FROM metadata WHERE key='historyRepair'").get().value,'pending');
    assert.equal(index.verifiedDisplaySnapshot(), null);
    const repaired = await index.sync();
    assert.equal(repaired.complete, true);
    assert.equal(index.db.prepare("SELECT value FROM metadata WHERE key='historyRepair'").get(),undefined);
    assert.equal(index.orders().items.length,1);
    assert(index.verifiedDisplaySnapshot());
  } finally { index.close(); }
});

test('over 500 lifetime orders disables only the verified order section', async () => {
  const chain = new MockChain(); fixture(chain);
  for (let id = 2; id <= 501; id++)
    chain.event('market', 'OrderListed', [BigInt(id), alice, pool, 1n, 10n], 4);
  const originalCall = chain.call.bind(chain);
  chain.call = input => binding.parseTransaction({ data: input.data }).name === 'nextOrderId'
    ? Promise.resolve(binding.encodeFunctionResult('nextOrderId', [502n])) : originalCall(input);
  const index = new ChainIndex(chain, { dbPath: ':memory:', factory, market, startBlock: 1,
    confirmations: 2 });
  const server = createChainIndexServer(index);
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await index.sync();
    assert.equal(index.status().complete, true);
    assert.equal(index.verifiedDisplaySnapshot().orders, null);
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/v1/snapshot/orders`);
    assert.equal(response.status, 503);
    const unavailable = await response.json();
    assert.equal(unavailable.source.ordersAvailable, false);
    assert.equal(unavailable.source.transactionReady, false);
    assert.equal(unavailable.source.stale, true);
    assert.equal(unavailable.data.ordersAvailable, false);
    assert.equal(unavailable.data.items, null, 'unavailable order history must not look like an empty market');
    assert.equal(unavailable.block.hash, chain.blocks.get(6).hash);
    const pools = await (await fetch(`${base}/v1/snapshot/pools`)).json();
    assert.equal(pools.data.items[0].address, pool);
    const stats = await (await fetch(`${base}/v1/snapshot/stats`)).json();
    assert.equal(stats.data.registeredPoolCount, '1');
    const portfolios = await (await fetch(`${base}/v1/snapshot/portfolios`)).json();
    assert.deepEqual(portfolios.data.items, []);
    assert.deepEqual(pools.block, unavailable.block);
    assert.deepEqual(stats.block, unavailable.block);
    assert.deepEqual(portfolios.block, unavailable.block);
    assert.equal((await fetch(`${base}/v1/pools`)).status, 200,
      'an unavailable order group must not disable independent fresh pages');
    assert.equal((await fetch(`${base}/v1/orders`)).status, 200,
      'the existing paginated order read must remain available');
  } finally { await new Promise(resolve => server.close(resolve)); index.close(); }
});

test('over 500 standalone pools disables only the verified pool section', async () => {
  const chain = new MockChain(); fixture(chain);
  for (let n = 0; n < 500; n++)
    chain.event('factory', 'PoolCreated', [addr(1000 + n), collection, BigInt(17000 + n), 1100n, 1000n, alice], 1);
  const originalCall = chain.call.bind(chain);
  chain.call = input => {
    const name = binding.parseTransaction({ data: input.data }).name;
    if (name === 'poolCount') return Promise.resolve(binding.encodeFunctionResult(name, [501n]));
    if (name === 'isPool') return Promise.resolve(binding.encodeFunctionResult(name, [true]));
    return originalCall(input);
  };
  const index = new ChainIndex(chain, { dbPath: ':memory:', factory, market, startBlock: 1, confirmations: 2 });
  const server = createChainIndexServer(index);
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await index.sync();
    assert.equal(index.status().complete, true);
    assert.equal(index.verifiedDisplaySnapshot().pools, null);
    const base = `http://127.0.0.1:${server.address().port}/v1/snapshot`;
    const unavailable = await fetch(`${base}/pools`);
    assert.equal(unavailable.status, 503);
    const poolBody = await unavailable.json();
    assert.equal(poolBody.source.poolsAvailable, false);
    assert.equal(poolBody.source.standalonePoolCount, '501');
    assert.equal(poolBody.source.transactionReady, false);
    assert.equal(poolBody.block.hash, chain.blocks.get(6).hash);
    const exact=await fetch(`${base}/pools/${pool}`);
    assert.equal(exact.status,200,'an exact deep link remains available after the directory ceiling');
    const exactBody=await exact.json();
    assert.equal(exactBody.data.lookupAddress,pool);
    assert.deepEqual(exactBody.data.items.map(item=>item.address),[pool]);
    assert.deepEqual(exactBody.block,poolBody.block);
    assert.equal((await fetch(`${base}/stats`)).status, 200);
    assert.equal((await fetch(`${base}/orders`)).status, 200);
    assert.equal((await fetch(`${base}/portfolios`)).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); index.close(); }
});

test('HTTP keeps prior verified read responses available during refresh and failed RPC reads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pinkuang-chain-index-wait-'));
  const chain = new MockChain(); fixture(chain);
  const index = new ChainIndex(chain, { dbPath: join(directory, 'index.sqlite'), factory, market, startBlock: 1, confirmations: 2 });
  const server = createChainIndexServer(index, { syncWaitMs: 80 });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/v1/pools`;
    await index.sync();
    const originalSend = chain.send.bind(chain);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    chain.send = async (...args) => { await gate; return originalSend(...args); };
    const syncing = index.sync();
    assert.equal(index.status().complete, true, 'the previously verified tip remains readable before the new head is observed');
    const pending = fetch(url);
    assert.equal((await pending).status, 200);
    release();
    await syncing;

    // Advance the observed safe head, then pause the new verification. The
    // mutable index must not be served as though it already covered that head.
    const originalBlock = chain.getBlock.bind(chain), originalCall = chain.call.bind(chain);
    chain.getBlock = number => number === 'latest'
      ? Promise.resolve({ number: 9, hash: hex(1009), parentHash: chain.blocks.get(8).hash, timestamp: 1_700_000_027 })
      : originalBlock(number);
    chain.call = input => originalCall({ ...input, blockTag: input.blockTag === 7 ? 6 : input.blockTag });
    let releaseSlow;
    const slow = new Promise(resolve => { releaseSlow = resolve; });
    chain.send = async (...args) => { await slow; return originalSend(...args); };
    const delayed = index.sync();
    while (index.status().observedSafeHead !== 7) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(index.status().complete, false);
    const displayed = await (await fetch(url)).json();
    assert.equal(displayed.source.readMode, 'verified_snapshot');
    assert.equal(displayed.source.refreshing, true);
    assert.equal(displayed.source.transactionReady, false);
    assert.equal(displayed.source.indexedThrough, 6);
    assert.equal(displayed.data.items[0].address, pool);
    const activity = await (await fetch(url.replace('/v1/pools', '/v1/activity'))).json();
    assert.equal(activity.source.readMode, 'verified_snapshot');
    assert.equal(activity.source.stale, true);
    assert.equal(activity.source.transactionReady, false);
    assert.equal(activity.source.indexedThrough, 6);
    assert(activity.data.items.every(item => item.blockNumber <= 6));
    assert.equal((await fetch(`${url}?limit=51`)).status, 400);
    const duringSync = await (await fetch(url.replace('/v1/pools', '/v1/snapshot/pools'))).json();
    assert.equal(duringSync.source.indexedBlockHash, chain.blocks.get(6).hash);
    assert.equal(duringSync.data.items[0].address, pool);
    assert.equal(duringSync.source.indexedThrough, 6);
    assert.equal(duringSync.source.refreshing, true);
    assert.equal(duringSync.source.transactionReady, false);
    assert.equal(duringSync.block.hash, chain.blocks.get(6).hash);
    releaseSlow(); await delayed;

    const lastVerifiedTip = index.status().indexedThrough;
    chain.send = async () => { throw new Error('upstream failure'); };
    const failed = assert.rejects(index.sync());
    await failed;
    assert.equal(index.status().unknownReason, 'sync_failed');
    assert.equal((await fetch(url)).status, 200);
    const failedActivity = await (await fetch(url.replace('/v1/pools', '/v1/activity'))).json();
    assert.equal(failedActivity.source.readMode, 'verified_snapshot');
    assert.equal(failedActivity.source.stale, true);
    assert.equal(failedActivity.source.transactionReady, false);
    assert.equal(failedActivity.source.indexedThrough, lastVerifiedTip);
    assert(failedActivity.data.items.every(item => item.blockNumber <= lastVerifiedTip));
    assert.equal((await fetch(url.replace('/v1/pools', '/v1/notifications'))).status, 503);
    assert.equal((await fetch(url.replace('/v1/pools', '/v1/snapshot/pools'))).status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('latest-header outage retains display history only until the verified view expires', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pinkuang-chain-index-latest-outage-'));
  const chain = new MockChain(); fixture(chain);
  const index = new ChainIndex(chain, { dbPath: join(directory, 'index.sqlite'), factory, market,
    startBlock: 1, confirmations: 2 });
  const server = createChainIndexServer(index, { syncWaitMs: 20 });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    await index.sync();
    const tip = index.status().indexedThrough;
    const getBlock = chain.getBlock.bind(chain);
    chain.getBlock = number => number === 'latest' ? Promise.reject(new Error('RPC timeout')) : getBlock(number);
    await assert.rejects(index.sync());
    const failedHealth = await (await fetch(`${url}/health`)).json();
    assert.equal(failedHealth.source.complete, false, 'operations still see the live failed status');
    assert.equal(failedHealth.source.unknownReason, 'sync_failed');
    assert.equal(failedHealth.displaySource.indexedThrough, tip);
    assert.equal(failedHealth.displaySource.readMode, 'verified_snapshot');
    assert.equal(failedHealth.displaySource.stale, true);
    assert.equal(failedHealth.displaySource.transactionReady, false);
    assert.equal(failedHealth.displaySource.refreshing, false);
    const activity = await (await fetch(`${url}/v1/activity`)).json();
    assert.equal(activity.source.indexedThrough, tip);
    assert.equal(activity.source.readMode, 'verified_snapshot');
    assert.equal(activity.source.transactionReady, false);
    assert.equal((await fetch(`${url}/v1/notifications`)).status, 503);
    index.verifiedReadView.source.checkedAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    assert.equal((await fetch(`${url}/v1/activity`)).status, 503);
    assert.equal(index.verifiedReadView, null, 'expired WAL reader is closed');
    assert.equal((await (await fetch(`${url}/health`)).json()).displaySource, undefined);
    chain.getBlock = getBlock;
    await index.sync();
    assert.equal(index.status().complete, true);
    chain.send = async () => '0x1';
    await assert.rejects(index.sync(), /BSC mainnet/);
    assert.equal(index.status().unknownReason, 'wrong_chain');
    assert.equal(index.verifiedReadView, null, 'a wrong-chain proof invalidates the retained history');
    await assertInvalidatedDisplay(index, url);
  } finally {
    await new Promise(resolve => server.close(resolve));
    index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    name: 'wrong chain', reason: 'wrong_chain', message: /BSC mainnet/,
    breakChain(chain) { chain.send = async () => '0x1'; },
  },
  {
    name: 'incomplete event history', reason: 'incomplete_history', message: /Event history is incomplete/,
    breakChain(chain) {
      const originalCall = chain.call.bind(chain);
      chain.call = input => binding.parseTransaction({ data: input.data }).name === 'poolCount'
        ? Promise.resolve(binding.encodeFunctionResult('poolCount', [2n])) : originalCall(input);
    },
  },
  {
    name: 'invalid deployment binding', reason: 'invalid_binding', message: /binding mismatch/,
    breakChain(chain) { chain.getCode = async () => '0x'; },
  },
]) {
  test(`${scenario.name} invalidates all prior verified display routes and the persisted snapshot`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pinkuang-chain-index-fatal-snapshot-'));
    const config = { dbPath: join(directory, 'index.sqlite'), factory, market, startBlock: 1, confirmations: 2 };
    const chain = new MockChain(); fixture(chain);
    const index = new ChainIndex(chain, config);
    const server = createChainIndexServer(index, { syncWaitMs: 20 });
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${server.address().port}`;
      await index.sync();
      assert.equal(index.db.prepare('SELECT COUNT(*) AS count FROM verified_display_snapshot').get().count, 1);
      for (const route of displayRoutes) {
        assert.equal((await fetch(`${url}${route}`)).status, 200);
        assert.equal((await fetch(`${url}${route.replace('/v1/', '/v1/snapshot/')}`)).status, 200);
      }
      scenario.breakChain(chain);
      await assert.rejects(index.sync(), scenario.message);
      assert.equal(index.status().unknownReason, scenario.reason);
      await assertInvalidatedDisplay(index, url);
      const reopened = new ChainIndex(chain, config);
      try {
        assert.equal(reopened.verifiedDisplaySnapshot(), null);
        assert.equal(reopened.db.prepare('SELECT COUNT(*) AS count FROM verified_display_snapshot').get().count, 0);
      } finally { reopened.close(); }
    } finally {
      await new Promise(resolve => server.close(resolve));
      index.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('read view stays at the verified tip after a later scan chunk commits, while private feeds pause', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pinkuang-chain-index-read-view-'));
  const chain = new MockChain(); fixture(chain);
  const index = new ChainIndex(chain, { dbPath: join(directory, 'index.sqlite'), factory, market,
    startBlock: 1, confirmations: 2, scanRange: 1 });
  const server = createChainIndexServer(index, { syncWaitMs: 20 });
  let release = () => {}, syncing;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    await index.sync();
    const oldActivity = index.activity().items.length;
    for (const number of [9, 10]) chain.blocks.set(number, { number, hash: hex(1000 + number),
      parentHash: chain.blocks.get(number - 1).hash, timestamp: 1_700_000_000 + number * 3 });
    const getBlock = chain.getBlock.bind(chain), call = chain.call.bind(chain);
    const gate = new Promise(resolve => { release = resolve; });
    chain.getBlock = number => number === 'latest' ? Promise.resolve(chain.blocks.get(10))
      : number === 8 ? gate.then(() => getBlock(number)) : getBlock(number);
    chain.call = input => call({ ...input, blockTag: Math.min(input.blockTag, 6) });
    syncing = index.sync();
    while (index.indexedThrough !== 7) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(index.verifiedReadView.transactional, true, 'disk indexes pin a WAL reader');
    assert.equal(index.verifiedReadView.directory, undefined, 'disk indexes do not copy the database');
    assert.equal(index.verifiedReadView.source.indexedThrough, 6);
    assert.equal(index.activity().items[0].blockNumber, 7, 'writer has already committed a newer event');
    const health = await (await fetch(`${url}/health`)).json();
    assert.equal(health.source.complete, false);
    assert.equal(health.source.observedSafeHead, 8);
    assert.equal(health.displaySource.indexedThrough, 6);
    assert.equal(health.displaySource.readMode, 'verified_snapshot');
    assert.equal(health.displaySource.stale, true);
    assert.equal(health.displaySource.transactionReady, false);
    assert.equal(health.displaySource.refreshing, true);
    const activity = await (await fetch(`${url}/v1/activity`)).json();
    assert.equal(activity.source.readMode, 'verified_snapshot');
    assert.equal(activity.source.indexedThrough, 6);
    assert.equal(activity.source.observedSafeHead, 6);
    assert.equal(activity.source.stale, true);
    assert.equal(activity.source.transactionReady, false);
    assert.equal(activity.data.items.length, oldActivity);
    assert(activity.data.items.every(item => item.blockNumber <= 6));
    const yieldResponse = await (await fetch(`${url}/v1/yield?pool=${pool}&days=1`)).json();
    assert.equal(yieldResponse.source.indexedThrough, 6);
    assert.equal(yieldResponse.data.buckets[0].poolHarvestNetAtomic, '990');
    index.db.exec('DELETE FROM verified_display_snapshot');
    index.snapshotTrusted = false;
    const directoryPage = await (await fetch(`${url}/v1/pools`)).json();
    assert.equal(directoryPage.source.readMode, 'verified_snapshot', 'the pinned DB works even without a serialized display page');
    assert.equal(directoryPage.data.items[0].address, pool);
    assert.equal((await fetch(`${url}/v1/notifications`)).status, 503);
    assert.equal((await fetch(`${url}/v1/community`)).status, 503);
    release();
    await syncing;
    assert.equal(index.status().complete, true);
    assert.equal(index.verifiedReadView, null, 'WAL reader is released after the sync');
    assert.equal((await (await fetch(`${url}/health`)).json()).displaySource, undefined);
    const fresh = await (await fetch(`${url}/v1/activity`)).json();
    assert.equal(fresh.source.indexedThrough, 8);
    assert.equal(fresh.data.items[0].blockNumber, 7);
  } finally {
    release();
    if (syncing) await syncing.catch(() => {});
    await new Promise(resolve => server.close(resolve));
    index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('detected reorg invalidates the previous read view before replacement history is scanned', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pinkuang-chain-index-read-reorg-'));
  const chain = new MockChain(); fixture(chain);
  const index = new ChainIndex(chain, { dbPath: join(directory, 'index.sqlite'), factory, market,
    startBlock: 1, confirmations: 2, scanRange: 2 });
  const server = createChainIndexServer(index, { syncWaitMs: 20 });
  let release = () => {}, releaseHistory = () => {}, syncing;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    await index.sync();
    chain.reorg();
    const gate = new Promise(resolve => { release = resolve; });
    const historyGate = new Promise(resolve => { releaseHistory = resolve; });
    const scan = index._scanChunk.bind(index);
    index._scanChunk = async (...args) => { await gate; return scan(...args); };
    const verifyHistory = index._verifyHistoryComplete.bind(index);
    index._verifyHistoryComplete = async (...args) => { await historyGate; return verifyHistory(...args); };
    syncing = index.sync();
    while (index.indexedThrough !== 4) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(index.verifiedReadView, null);
    await assertInvalidatedDisplay(index, url);
    release();
    while (index.indexedThrough !== 6) await new Promise(resolve => setTimeout(resolve, 1));
    // Reaching the former height cannot restore the old page or mark the new
    // history complete before the event-count proof finishes.
    await assertInvalidatedDisplay(index, url);
    releaseHistory();
    await syncing;
    assert.equal(index.status().indexedBlockHash, chain.blocks.get(6).hash);
  } finally {
    release();
    releaseHistory();
    if (syncing) await syncing.catch(() => {});
    await new Promise(resolve => server.close(resolve));
    index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a lagging latest RPC cannot roll back a verified index tip', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pinkuang-chain-index-lagging-'));
  const chain = new MockChain(); fixture(chain);
  const index = new ChainIndex(chain, { dbPath: join(directory, 'index.sqlite'), factory, market, startBlock: 1, confirmations: 2 });
  try {
    await index.sync();
    const originalBlock = chain.getBlock.bind(chain);
    chain.getBlock = number => number === 'latest' ? originalBlock(7) : originalBlock(number);
    await assert.rejects(index.sync(), /safe head regressed/);
    assert.equal(index.indexedThrough, 6);
    assert.equal(index.status().unknownReason, 'rpc_lagging');
    assert.equal(index.verifiedDisplaySnapshot().source.indexedThrough, 6);
    chain.getBlock = originalBlock;
    assert.equal((await index.sync()).complete, true);
  } finally { index.close(); await rm(directory, { recursive: true, force: true }); }
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

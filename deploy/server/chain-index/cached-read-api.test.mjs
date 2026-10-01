import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZeroAddress } from 'ethers';
import { abi } from '../../../web/lib/chain-client.mjs';
import { cacheDecode } from './pool-display-cache.mjs';
import { createChainIndexServer } from './api.mjs';
import { DisplayReadCache, PortfolioDisplayReads, DisplayEvents } from './cached-read-api.mjs';

const a = n => '0x' + n.toString(16).padStart(40, '0');
const factory = a(1), portfolioFactory = a(2), portfolioMarket = a(3), market = a(4), portfolio = a(5);
const account = a(6), other = a(7), child = a(8), collection = a(9), hash = '0x' + 'ab'.repeat(32);
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function fixture({ proposals = false, children = false } = {}) {
  let now = 1000_000, block = 10, calls = 0, active = 0, maxActive = 0, failed = false;
  let logCount = 1, logTip = { block_number: 10, tx_hash: hash, log_index: 0 };
  const source = () => ({ complete: true, chainId: 56, factory, market, portfolioFactory, portfolioMarket,
    startBlock: 1, indexedThrough: block, indexedTimestamp: 1000, indexedBlockHash: hash,
    checkedAt: new Date(now).toISOString(), confirmations: 12, observedSafeHead: block });
  const directory = [{ address: portfolio, kind: 'portfolio', factory: portfolioFactory, createdBlock: 1 }];
  const index = { factory, market, portfolioFactory, portfolioMarket, syncing: false, snapshotTrusted: true,
    status: source, verifiedDisplaySnapshot: () => ({ source: source(), portfolios: directory }),
    _header: () => ({ hash }),
    portfolios: ({ account: wallet, cursor = 0, limit = 50 }) => ({ items: wallet.toLowerCase() === account
      ? directory.slice(cursor, cursor + limit) : [], nextCursor: null }),
    db: { prepare: sql => ({ get: () => sql.includes('COUNT(*)') ? { count: logCount } : logTip }) } };
  const base = { OFFICIAL_FACTORY: portfolioFactory, legacyFactory: factory, state: 2n, budgetWei: 10000n,
    absoluteCapWei: 10000n, unitCapWei: 1000n, spentWei: 8000n, totalSupply: 100n, memberCount: 2n,
    childCount: children ? 1n : 0n, activeChildCount: children ? 1n : 0n, fundingDeadline: 2000n,
    purchaseDeadline: 3000n, fundingFailed: false, refundPerShareWei: 4n, salePerShareWei: 6n,
    activeProposalId: proposals ? 1n : 0n, nextProposalId: proposals ? 2n : 1n, shareTradingAllowed: true, nextRoundAt: 0n };
  const member = { balanceOf: 5n, claimableBem: 13n, bnbOwed: 11n, refundSettled: false, saleDebt: 20n, lockedShares: 1n };
  const provider = { send: async (method, params) => {
    assert.equal(method, 'eth_call', 'No chain, header, code, storage, simulation or proof requests.');
    assert.match(params[1], /^0x[\da-f]+$/i);
    calls++; active++; maxActive = Math.max(maxActive, active);
    try {
      await nextTurn(); if (failed) throw new Error('RPC is offline: https://private.invalid/secret');
      const iface = params[0].to.toLowerCase() === market ? abi.ShareMarket
        : params[0].to.toLowerCase() === child ? abi.PoolVault : abi.BudgetPortfolioVault;
      const call = iface.parseTransaction(params[0]); let value;
      if (Object.hasOwn(base, call.name)) value = [base[call.name]];
      else if (Object.hasOwn(member, call.name)) value = [call.args[0].toLowerCase() === account ? member[call.name]
        : typeof member[call.name] === 'boolean' ? false : 0n];
      else if (call.name === 'proposals') value = [child, 100n, 120n, 900n, 2000n, 2n, 2n, 60n, false];
      else if (call.name === 'saleReference') value = [120n, 900n, hash];
      else if (call.name === 'childSaleReview') value = [1n];
      else if (call.name === 'hasVoted') value = [call.args[1].toLowerCase() === account];
      else if (call.name === 'childAt') value = [child];
      else if (call.name === 'childInfo') value = [collection, 123n, 8000n, true, false];
      else if (call.name === 'state') value = [2n];
      else if (call.name === 'expiresAt') value = [4000n];
      else if (call.name === 'activatedAt') value = [500n];
      else assert.fail('Unexpected business getter: ' + call.name);
      return iface.encodeFunctionResult(call.name, value);
    } finally { active--; }
  } };
  return { index, provider, now: () => now, get calls() { return calls; }, get maxActive() { return maxActive; },
    advance: ms => { now += ms; block++; }, fail: () => { failed = true; },
    nextLog: () => { logCount++; logTip = { ...logTip, log_index: logCount }; } };
}

test('shared display cache has single-flight, immediate stale reads, failed-refresh retention and bounded memory', async () => {
  let time = 100, loads = 0, finish;
  const cache = new DisplayReadCache({ now: () => time, ttlMs: 20, staleMs: 100, maxEntries: 2 });
  const load = () => { loads++; return new Promise(resolve => { finish = resolve; }); };
  const first = cache.get('a', load), second = cache.get('a', load); await nextTurn(); assert.equal(loads, 1);
  finish(10n); assert.equal(await first, 10n); assert.equal(await second, 10n);
  time += 21; assert.equal(await cache.get('a', load), 10n); await nextTurn(); assert.equal(loads, 2);
  assert.equal(cache.metadata('a').refreshing, true); finish(20n); await nextTurn(); assert.equal(await cache.get('a', load), 20n);
  time += 21; assert.equal(await cache.get('a', async () => { throw new Error('offline'); }), 20n); await nextTurn();
  await cache.get('b', async () => 30n); time++; await cache.get('c', async () => 40n); assert.equal(cache.entries.size, 2);
  time += 101; await assert.rejects(cache.get('c', async () => { throw new Error('offline'); }), /offline/);
  await cache.close(); await assert.rejects(cache.get('x', async () => 1), /closing/);
});

test('portfolio pages share exact public getters across accounts; repeat reads use cache and never repeat proofs', async () => {
  const f = fixture(), reads = new PortfolioDisplayReads(f.index, f.provider, { now: f.now, concurrency: 4 });
  try {
    const [first, repeated] = await Promise.all([reads.page({ account }), reads.page({ account })]);
    assert.equal(f.calls, 26); assert.equal(first.data.items[0].shares, 5n); assert.equal(repeated.data.items[0].withdrawableBnb, 41n);
    assert.equal(first.data.items[0].availableShares, 4n); assert.equal(first.source.displayOnly, true);
    assert.equal(first.source.transactionReady, false); assert.equal(first.source.cacheOrigin, 'server');
    assert.equal(first.data.items[0].blockNumber, 10n); assert.equal(first.data.items[0].displaySource, first.source);
    const empty = await reads.page({ account: other }); assert.equal(f.calls, 32); assert.equal(empty.data.items[0].shares, 0n);
    await reads.detail(portfolio, { account, includeChildren: false }); assert.equal(f.calls, 32);
    assert.equal(f.maxActive, 4); assert.equal(first.data.items[0].operator, undefined);
    assert.deepEqual((await reads.page({ account: other, mine: true })).data.items, []);
    assert.equal((await reads.page({ account, mine: true })).data.items.length, 1);
  } finally { await reads.close(); }
});

test('detail returns full proposal, vote, child and amount model without runtime, code or canonical calls', async () => {
  const f = fixture({ proposals: true, children: true }), reads = new PortfolioDisplayReads(f.index, f.provider, { now: f.now });
  try {
    const result = await reads.detail(portfolio, { account }); const row = result.data.item;
    assert.equal(row.proposals.length, 1); assert.equal(row.proposal.hasVoted, true); assert.equal(row.proposal.canExecute, true);
    assert.equal(row.proposal.saleReview.status, 1n); assert.equal(row.children.length, 1);
    assert.equal(row.children[0].costWei, 8000n); assert.equal(row.children[0].collection, collection);
    const before = f.calls; await reads.detail(portfolio, { account }); assert.equal(f.calls, before);
  } finally { await reads.close(); }
});

test('cached rows return immediately during expiry; offline background reads preserve the last display snapshot', async () => {
  const f = fixture(), reads = new PortfolioDisplayReads(f.index, f.provider, { now: f.now });
  try {
    const first = await reads.page({ account }); f.advance(21_000); f.fail();
    const old = await reads.page({ account }); assert.equal(old.data.items[0].blockNumber, first.data.items[0].blockNumber);
    assert.equal(old.source.stale, true); assert.equal(old.source.refreshing, true);
    await reads.cache.entries.get(`page:${account}:0:20:false`).loading.catch(() => {});
    assert.equal((await reads.page({ account })).data.items[0].shares, 5n);
  } finally { await reads.close(); }
});

test('background refresh updates watched wallet data before a log invalidation even inside its TTL', async () => {
  const f = fixture(), reads = new PortfolioDisplayReads(f.index, f.provider, { now: f.now });
  try {
    await reads.page({ account }); await reads.refresh();
    const before = f.calls; f.advance(1_000); f.nextLog(); await reads.refresh();
    const refreshed = await reads.page({ account }); assert.equal(refreshed.data.items[0].blockNumber, 11n);
    assert.equal(refreshed.source.stale, false); assert.equal(refreshed.source.refreshing, false);
    assert(f.calls > before); const after = f.calls;
    await reads.page({ account }); assert.equal(f.calls, after);
  } finally { await reads.close(); }
});

test('persisted portfolio pages reopen with exact BigInt values and remain separated by wallet identity', async () => {
  const f = fixture(), dir = mkdtempSync(join(tmpdir(), 'portfolio-cache-')), path = join(dir, 'cache.json');
  const reads = new PortfolioDisplayReads(f.index, f.provider, { now: f.now, path }); let restored;
  try {
    await reads.page({ account }); reads.persist(); await reads.close();
    restored = new PortfolioDisplayReads(f.index, f.provider, { now: f.now, path }); const before = f.calls;
    assert.equal((await restored.page({ account })).data.items[0].withdrawableBnb, 41n); assert.equal(f.calls, before);
    assert.equal((await restored.page({ account: other })).data.items[0].shares, 0n); assert.equal(f.calls, before + 26);
  } finally { await reads.close(); await restored?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('portfolio HTTP cache routes bypass index sync wait, validate inputs and preserve exact serialized amounts', async () => {
  const f = fixture(), reads = new PortfolioDisplayReads(f.index, f.provider, { now: f.now });
  f.index.syncing = true; f.index.waitForSync = () => assert.fail('Display API cannot wait for proof or sync.');
  const server = createChainIndexServer(f.index, { portfolioReads: reads });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const route of [`/v1/display/portfolios?account=${account}`, `/v1/display/portfolios?account=${account}&mine=true`,
      `/v1/display/portfolios/${portfolio}?account=${account}&children=true`]) {
      const response = await fetch(base + route); assert.equal(response.status, 200);
      const body = JSON.parse(await response.text(), cacheDecode); assert.equal(body.source.transactionReady, false);
      assert.equal((body.data.item ?? body.data.items[0]).shares, 5n);
    }
    const before = f.calls; await fetch(base + `/v1/display/portfolios?account=${account}`); assert.equal(f.calls, before);
    for (const route of ['/v1/display/portfolios?limit=21', '/v1/display/portfolios?mine=true',
      '/v1/display/portfolios?account=bad', `/v1/display/portfolios?account=${account}&account=${other}`,
      `/v1/display/portfolios/${portfolio}?children=yes`, '/v1/display/portfolios?rpc=https://evil.invalid'])
      assert.equal((await fetch(base + route)).status, 400);
    assert.equal((await fetch(base + `/v1/display/portfolios/${other}`)).status, 404);
  } finally { await reads.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

function fakeClient({ blocked = false } = {}) {
  const req = new EventEmitter(); req.method = 'GET';
  const res = new EventEmitter(); res.headers = {}; res.frames = []; res.destroyed = false; res.writableLength = 0;
  res.setHeader = (name, value) => { res.headers[name] = value; }; res.flushHeaders = () => {};
  res.write = bytes => { res.frames.push(bytes); return !blocked; };
  res.end = bytes => { if (bytes) res.frames.push(bytes); res.ended = true; res.emit('close'); };
  res.destroy = () => { res.destroyed = true; res.emit('close'); };
  return { req, res };
}

test('SSE initial frame and heartbeat use no RPC; only changed business logs invalidate and updates coalesce', async () => {
  const f = fixture(), hub = new DisplayEvents(f.index, { now: f.now, heartbeatMs: 20, throttleMs: 50 });
  const client = fakeClient();
  try {
    hub.publish(); const revision = hub.revision;
    hub.subscribe(client.req, client.res); assert.match(client.res.frames[0], /event: update/);
    assert.equal(client.res.headers['X-Accel-Buffering'], 'no'); assert.equal(f.calls, 0);
    f.advance(5); hub.publish(); assert.equal(hub.revision, revision); assert.equal(client.res.frames.length, 1);
    f.nextLog(); hub.publish(); assert.equal(client.res.frames.length, 1);
    f.nextLog(); hub.publish(); const pending = hub.pending;
    f.advance(60); hub.flush(); assert.equal(hub.revision, pending);
    assert.match(client.res.frames[1], /"topics":\["pools","portfolios","orders","stats","activity"\]/);
    assert(!client.res.frames[1].includes(account)); assert.equal(f.calls, 0);
    await new Promise(resolve => setTimeout(resolve, 25)); assert(client.res.frames.some(frame => frame === ': heartbeat\n\n'));
    client.res.emit('close'); assert.equal(hub.clients.size, 0);
  } finally { hub.close(); }
});

test('SSE bounds connections and drops backpressure without accumulating private or unbounded buffers', () => {
  const f = fixture(), hub = new DisplayEvents(f.index, { maxClients: 1 });
  try {
    const first = fakeClient(), second = fakeClient(); hub.subscribe(first.req, first.res); hub.subscribe(second.req, second.res);
    assert.equal(second.res.statusCode, 503); assert.equal(hub.clients.size, 1);
    first.req.emit('aborted'); assert.equal(hub.clients.size, 0);
    const blocked = fakeClient({ blocked: true }); hub.subscribe(blocked.req, blocked.res);
    assert.equal(blocked.res.ended, true); assert.equal(hub.clients.size, 0);
    const healthy = fakeClient(); hub.subscribe(healthy.req, healthy.res); hub.close(); assert.equal(healthy.res.ended, true);
  } finally { hub.close(); }
});

test('SSE publishes changed display output without new logs and waits for materialization after a newer event', () => {
  const f = fixture(); let display = 'daily-output-432000';
  const hub = new DisplayEvents(f.index, { now: f.now, throttleMs: 0, displayRevision: () => display });
  const client = fakeClient();
  try {
    hub.publish(); hub.subscribe(client.req, client.res); const initial = hub.revision;
    f.advance(100); hub.publish(); assert.equal(hub.revision, initial); assert.equal(client.res.frames.length, 1);
    display = 'daily-output-864000'; hub.publish(); assert.notEqual(hub.revision, initial); assert.equal(client.res.frames.length, 2);
    const outputRevision = hub.revision; f.nextLog(); display = null; hub.publish(); assert.equal(hub.revision, outputRevision);
    display = 'new-event-materialized'; hub.publish(); assert.notEqual(hub.revision, outputRevision); assert.equal(client.res.frames.length, 3);
    assert.equal(f.calls, 0, 'display revisions never read RPC');
  } finally { hub.close(); }
});

test('real SSE HTTP connections are all ended before HTTP server shutdown without a wallet or RPC read', async () => {
  const f = fixture(), hub = new DisplayEvents(f.index), server = createChainIndexServer(f.index, { displayEvents: hub });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const sockets = [];
  try {
    const open = () => new Promise((resolve, reject) => {
      const req = request(`http://127.0.0.1:${server.address().port}/v1/display/events`, { headers: { Connection: 'keep-alive' } });
      req.on('error', reject); req.on('response', res => {
        sockets.push({ req, res }); res.once('data', () => resolve(res)); res.resume();
      }); req.end();
    });
    const responses = await Promise.all([open(), open()]); assert.equal(hub.clients.size, 2); assert.equal(f.calls, 0);
    const ended = responses.map(res => new Promise(resolve => res.once('end', resolve)));
    hub.close(); await Promise.all(ended); assert.equal(hub.clients.size, 0);
    await new Promise(resolve => server.close(resolve));
  } finally {
    hub.close(); for (const { req, res } of sockets) { req.destroy(); res.destroy(); }
    server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
  }
});

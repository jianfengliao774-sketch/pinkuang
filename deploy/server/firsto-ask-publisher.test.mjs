import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Interface } from 'ethers';
import { createFirstoNativeAsk } from '../shared/firsto-native-ask.mjs';
import { createFirstoAskPublisher, createFirstoAskApiWorker, firstoAskPublisherConfiguration, readNativeFirstoAsk, trackFirstoAsks,
  FIRSTO_ASK_API_ORIGIN, FIRSTO_NATIVE_SIGNATURE } from './firsto-ask-publisher.mjs';

const address = n => `0x${n.toString(16).padStart(40, '0')}`, factory = address(1), pool = address(3);
const collection = '0xb1024b89886b9a34aa4ff5f31c411d708b20a14c';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function fixture(options = {}) {
  let clock = 1790904988000, journal = { schemaVersion: 1, pools: {} }, nativeReads = 0, graphReads = 0, intentReads = 0;
  const ask = { maker: pool, collection, tokenId: 16736n, nonce: 1n, price: 40_000_000_000_000_000n,
    expiry: BigInt(Math.floor(clock / 1000) + 3600), payoutRecipient: pool, feeBps: 100n, feeEpoch: 1n, schemaVersion: 2n };
  const canonical = createFirstoNativeAsk(ask, { pool, collection, tokenId: ask.tokenId, nativeAuthorized: true, nativeVersion: 1 });
  const native = { nativeVersion: 1, active: true, state: 3n, orderHash: canonical.askHash, ask };
  const calls = [], writes = [], statuses = [];
  const config = { journal: '/private/native-asks.json', statusPath: '/public/native-asks.json', apiOrigin: FIRSTO_ASK_API_ORIGIN,
    timeoutMs: 100, maxResponseBytes: 65536, batch: 10, maxPools: 1000, ...options.config };
  const dependencies = {
    now: () => clock, lockJournal: () => () => {}, readJournal: () => structuredClone(journal),
    writeJournal: (_path, value) => { journal = structuredClone(value); writes.push(journal); },
    discoverPools: async () => [pool], readNativeAsk: async () => { nativeReads++; return structuredClone(native); },
    fetcher: async (url, init) => {
      assert.equal(new URL(url).origin, FIRSTO_ASK_API_ORIGIN);
      assert.equal(init.redirect, 'error'); assert(!Object.hasOwn(init.headers, 'Authorization'));
      calls.push({ url, init });
      if (init.method === 'GET') return options.lookup ? options.lookup({ native, canonical, calls })
        : json({ kind: 'listings', sourceBlock: '125200000', orders: [] });
      assert.equal(url, `${FIRSTO_ASK_API_ORIGIN}/v1/circuit-asks`);
      assert.equal(journal.pools[pool].phase, 'submitting', 'exact attempted bytes are durable before HTTP begins');
      const current = createFirstoNativeAsk(native.ask, { pool, collection, tokenId: native.ask.tokenId, nativeAuthorized: true, nativeVersion: 1 });
      assert.deepEqual(JSON.parse(init.body), current.payload);
      return options.post ? options.post({ native, canonical: current, calls }) : json({ askHash: current.askHash, status: 'open' });
    }, ...options.dependencies,
  };
  const provider = { send: async method => { assert.equal(method, 'eth_chainId'); return options.chainId ?? '0x38'; },
    broadcastTransaction: () => assert.fail('the publication worker cannot broadcast'),
    getSigner: () => assert.fail('the publication worker cannot sign') };
  const create = () => createFirstoAskPublisher({ config, provider, factory,
    verifyDeployment: async () => { graphReads++; if (options.graphError) throw new Error('unapproved graph');
      return options.oldGraph ? {} : { nativeSaleUpgrade: { version: 1 } }; },
    hasPendingSaleIntent: async () => { intentReads++; return options.pending?.(intentReads) ?? false; },
    publishStatus: (_path, value) => statuses.push(structuredClone(value)), dependencies });
  const publisher = create();
  return { publisher, create, native, canonical, calls, writes, statuses, config, provider, dependencies,
    get journal() { return journal; }, set journal(value) { journal = structuredClone(value); },
    get nativeReads() { return nativeReads; }, get graphReads() { return graphReads; }, get intentReads() { return intentReads; },
    get row() { return publisher.snapshot().pools[pool]; }, advance(ms) { clock += ms; } };
}
const posts = f => f.calls.filter(call => call.init.method === 'POST');
const indexed = (f, status = 'open') => json({ kind: 'listings', sourceBlock: '125200000',
  orders: [{ ...f.canonical.ask, askHash: f.canonical.askHash, status }] });

test('native publisher sends only exact official typed bytes after durable state and final buyer-intent gates', async () => {
  const f = fixture(); await f.publisher.tick();
  assert.equal(posts(f).length, 1); assert.equal(f.intentReads, 3); assert.equal(f.nativeReads, 2);
  assert.equal(f.graphReads, 1); assert.equal(f.row.status, 'publication-accepted'); assert.equal(f.row.verifiedInOfficialBook, false);
  assert.equal(f.journal.pools[pool].phase, 'published');
  assert.equal(JSON.parse(posts(f)[0].init.body).signature, FIRSTO_NATIVE_SIGNATURE);
  assert(f.writes.some(value => value.pools[pool]?.phase === 'submitting'));
  await f.publisher.close();
});

test('legacy capability and inactive native authorization never contact the publication API', async () => {
  for (const changes of [{ nativeVersion: 0, active: false }, { active: false, state: 4n }]) {
    const f = fixture(); Object.assign(f.native, changes); await f.publisher.tick();
    assert.equal(f.calls.length, 0); assert.equal(f.row.status, changes.nativeVersion === 0 ? 'upgrade-required' : 'inactive');
    assert.equal(f.publisher.snapshot().enabled, changes.nativeVersion !== 0); await f.publisher.close();
  }
  const old = fixture({ oldGraph: true }); await old.publisher.tick();
  assert.equal(old.calls.length, 0); assert.equal(old.nativeReads, 0); assert.equal(old.publisher.snapshot().enabled, false);
  await old.publisher.close();
});

test('expired native listings are marked expired without posting or pretending the pool closed', async () => {
  const f = fixture(); f.native.active = false; f.native.ask.expiry -= 3601n; await f.publisher.tick();
  assert.equal(f.row.status, 'expired'); assert.equal(f.calls.length, 0);
  assert(!Object.hasOwn(f.row, 'state')); await f.publisher.close();
});

test('an existing unresolved site purchase blocks lookup and publication, including unknown hashes', async () => {
  const f = fixture({ pending: () => true }); await f.publisher.tick();
  assert.equal(f.row.status, 'buyer-pending'); assert.equal(f.nativeReads, 0); assert.equal(f.calls.length, 0);
  assert.deepEqual(f.journal.pools, {}); await f.publisher.close();
});

test('a purchase armed during the official GET blocks the subsequent POST', async () => {
  const f = fixture({ pending: count => count > 1 }); await f.publisher.tick();
  assert.equal(f.row.status, 'buyer-pending'); assert.equal(posts(f).length, 0); assert.equal(f.nativeReads, 1);
  await f.publisher.close();
});

test('a purchase armed during the last authorization RPC blocks the subsequent POST', async () => {
  const f = fixture({ pending: count => count > 2 }); await f.publisher.tick();
  assert.equal(f.row.status, 'buyer-pending'); assert.equal(posts(f).length, 0); assert.equal(f.nativeReads, 2);
  assert.deepEqual(f.journal.pools, {}); await f.publisher.close();
});

test('sale completion or reauthorization during lookup prevents publication of old bytes', async () => {
  for (const changed of ['closed', 'nonce']) {
    const f = fixture({ lookup: ({ native }) => {
      if (changed === 'closed') { native.active = false; native.state = 4n; }
      else { native.ask.nonce = 2n; native.orderHash = createFirstoNativeAsk(native.ask,
        { pool, collection, tokenId: 16736, nativeAuthorized: true, nativeVersion: 1 }).askHash; }
      return json({ kind: 'listings', orders: [] });
    } });
    await f.publisher.tick(); assert.equal(posts(f).length, 0); assert.equal(f.row.status, 'authorization-changed');
    await f.publisher.close();
  }
});

test('wrong chain, unapproved graph or a mismatched contract hash never produces a POST', async () => {
  for (const fault of ['chain', 'graph', 'hash']) {
    const f = fixture({ chainId: fault === 'chain' ? '0x1' : '0x38', graphError: fault === 'graph' });
    if (fault === 'hash') f.native.orderHash = `0x${'11'.repeat(32)}`;
    if (fault === 'hash') { await f.publisher.tick(); assert.equal(f.row.status, 'source-unavailable'); }
    else await assert.rejects(f.publisher.tick());
    assert.equal(f.calls.length, 0); await f.publisher.close();
  }
});

test('an exact indexed open ask is reconciled without any POST while a pending approval stays unconfirmed', async () => {
  for (const state of ['open', 'pending_approval']) {
    let f; f = fixture({ lookup: () => indexed(f, state) }); await f.publisher.tick();
    assert.equal(posts(f).length, 0); assert.equal(f.row.status, state === 'open' ? 'published' : 'pending-approval');
    assert.equal(f.row.verifiedInOfficialBook, state === 'open');
    await f.publisher.close();
  }
});

test('terminal Firsto API hints never close the pool or republish its current nonce', async () => {
  let f; f = fixture({ lookup: () => indexed(f, 'filled') }); await f.publisher.tick();
  assert.equal(f.row.status, 'external-awaiting-chain'); assert.equal(f.row.apiStatus, 'filled');
  assert.equal(posts(f).length, 0); assert(!Object.hasOwn(f.row, 'state'));
  assert.deepEqual(f.journal.pools, {}); await f.publisher.close();
});

test('an ambiguous POST survives restart and only reconciles the exact original ask', async () => {
  let found = false, f;
  f = fixture({ post: () => { throw new Error('connection closed after request'); }, lookup: () => found ? indexed(f) : json({ kind: 'listings', orders: [] }) });
  await f.publisher.tick(); assert.equal(f.journal.pools[pool].phase, 'ambiguous'); assert.equal(f.row.status, 'publication-unknown');
  await f.publisher.tick(); assert.equal(posts(f).length, 1);
  await f.publisher.close(); const restarted = f.create(); await restarted.tick(); assert.equal(posts(f).length, 1);
  found = true; await restarted.tick(); assert.equal(f.journal.pools[pool].phase, 'published'); assert.equal(posts(f).length, 1);
  await restarted.close();
});

test('a rejected signature or mismatched acknowledgement cannot be reported as published or retried blindly', async () => {
  for (const fault of ['rejected', 'wrong_hash']) {
    const f = fixture({ post: () => fault === 'rejected' ? json({ message: 'invalid signature' }, 400)
      : json({ askHash: `0x${'22'.repeat(32)}`, status: 'open' }) });
    await f.publisher.tick(); assert.equal(f.row.status, fault === 'rejected' ? 'publication-rejected' : 'publication-unknown');
    await f.publisher.tick(); assert.equal(posts(f).length, 1); await f.publisher.close();
  }
});

test('an API pending approval acknowledgement is held as pending and not called an open listing', async () => {
  const f = fixture({ post: ({ canonical }) => json({ askHash: canonical.askHash, status: 'pending_approval' }) });
  await f.publisher.tick(); assert.equal(f.row.status, 'pending-approval'); assert.equal(f.journal.pools[pool].phase, 'pending-approval');
  await f.publisher.tick(); assert.equal(posts(f).length, 1); await f.publisher.close();
});

test('an open POST acknowledgement becomes publicly published only after the exact ask appears in the official book', async () => {
  let visible = false, f;
  f = fixture({ lookup: () => visible ? indexed(f) : json({ kind: 'listings', orders: [] }) });
  await f.publisher.tick(); assert.equal(f.row.status, 'publication-accepted'); assert.equal(f.row.verifiedInOfficialBook, false);
  await f.publisher.tick(); assert.equal(f.row.status, 'publication-accepted'); assert.equal(posts(f).length, 1);
  visible = true; await f.publisher.tick(); assert.equal(f.row.status, 'published'); assert.equal(f.row.verifiedInOfficialBook, true);
  visible = false; await f.publisher.tick(); assert.equal(f.row.status, 'publication-unknown'); assert.equal(f.row.verifiedInOfficialBook, false);
  assert.equal(posts(f).length, 1); await f.publisher.close();
});

test('transport timeouts, HTML, redirects and oversized replies are bounded and never blindly retried', async () => {
  for (const fault of ['timeout', 'html', 'redirect', 'oversized']) {
    const f = fixture({ config: { timeoutMs: 20 }, post: () => fault === 'timeout' ? new Promise(() => {})
      : fault === 'html' ? new Response('gateway', { status: 502, headers: { 'content-type': 'text/html' } })
      : fault === 'redirect' ? new Response(null, { status: 302, headers: { location: 'https://attacker.test' } })
      : json({ message: 'x'.repeat(70000) }) });
    await f.publisher.tick(); assert.equal(f.row.status, 'publication-unknown', fault);
    await f.publisher.tick(); assert.equal(posts(f).length, 1, fault); await f.publisher.close();
  }
});

test('a conflicting ask on the same nonce is held while a newly authorized relisting nonce is independent', async () => {
  const f = fixture(); await f.publisher.tick(); f.native.ask.price += 1n;
  f.native.orderHash = createFirstoNativeAsk(f.native.ask, { pool, collection, tokenId: 16736, nativeAuthorized: true, nativeVersion: 1 }).askHash;
  await f.publisher.tick(); assert.equal(f.row.status, 'order-conflict'); assert.equal(posts(f).length, 1);
  f.native.ask.nonce += 1n;
  f.native.orderHash = createFirstoNativeAsk(f.native.ask, { pool, collection, tokenId: 16736, nativeAuthorized: true, nativeVersion: 1 }).askHash;
  await f.publisher.tick(); assert.equal(posts(f).length, 2); assert.equal(f.row.status, 'publication-accepted');
  assert.equal(f.journal.pools[pool].nonce, '2'); assert.equal(f.journal.pools[pool].askHash, f.native.orderHash);
  await f.publisher.close();
});

test('overlapping ticks are coalesced and independent timer shutdown waits without scheduling new work', async () => {
  const f = fixture(); const first = f.publisher.tick(), second = f.publisher.tick(); assert.equal(first, second); await first;
  assert.equal(posts(f).length, 1); await f.publisher.close();
  let calls = 0, release;
  const work = new Promise(resolve => { release = resolve; });
  const stop = trackFirstoAsks({ tick: () => { calls++; return work; } }, { intervalMs: 1, onError: () => assert.fail() });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
  let closed = false; const closing = stop().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false); release(); await closing;
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(calls, 1);
});

test('native getter is read-only and returns the exact ABI tuple, with no signer access', async () => {
  const f = fixture(), iface = new Interface([
    'function nativeFirstoSaleVersion() returns(uint8)', 'function state() returns(uint8)',
    'function nativeFirstoAsk() returns(tuple(address maker,address collection,uint256 tokenId,uint256 nonce,uint128 price,uint64 expiry,address payoutRecipient,uint16 feeBps,uint256 feeEpoch,uint16 schemaVersion) ask,bytes32 orderHash,bool active)',
  ]), calls = [];
  const provider = { send: async (method, params) => {
    assert.equal(method, 'eth_call'); assert.equal(params[1], 'latest'); assert.equal(params[0].to, pool);
    const parsed = iface.parseTransaction(params[0]); calls.push(parsed.name);
    return iface.encodeFunctionResult(parsed.name, parsed.name === 'nativeFirstoSaleVersion' ? [1]
      : parsed.name === 'state' ? [3] : [f.native.ask, f.native.orderHash, f.native.active]);
  } };
  const value = await readNativeFirstoAsk(provider, pool); assert.equal(value.orderHash, f.canonical.askHash);
  assert.equal(value.ask.price, f.native.ask.price); assert.equal(value.active, true);
  assert.deepEqual(calls, ['nativeFirstoSaleVersion', 'nativeFirstoAsk']); await f.publisher.close();
});

test('configuration defaults off and only permits the fixed official API and isolated state paths', () => {
  const context = { dbPath: '/private/journal.sqlite' };
  const env = { BEMINE_NATIVE_FIRSTO_ASKS_ENABLE: '1', BEMINE_NATIVE_FIRSTO_ASKS_JOURNAL: '/private/native.json',
    BEMINE_NATIVE_FIRSTO_ASKS_STATUS_PATH: '/public/native.json' };
  assert.equal(firstoAskPublisherConfiguration({}, context), null);
  assert.equal(firstoAskPublisherConfiguration(env, context).apiOrigin, FIRSTO_ASK_API_ORIGIN);
  for (const override of [{ BEMINE_NATIVE_FIRSTO_ASKS_API_ORIGIN: 'https://attacker.test' },
    { BEMINE_NATIVE_FIRSTO_ASKS_JOURNAL: '/signer/authority/native.json' },
    { BEMINE_NATIVE_FIRSTO_ASKS_STATUS_PATH: '/private/journal.sqlite' }])
    assert.throws(() => firstoAskPublisherConfiguration({ ...env, ...override }, context));
});

test('API-owned publisher uses its existing private DB and never opens signer state or needs signer credentials', async () => {
  const f = fixture(), db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE market(account TEXT PRIMARY KEY,record TEXT)');
  db.prepare('INSERT INTO market VALUES(?,?)').run(address(9), JSON.stringify({ factory, target: pool, chainId: 56,
    targetType: 'pool', action: { kind: 'completeFirstoSale' }, hash: null }));
  const worker = createFirstoAskApiWorker({ config: f.config, provider: f.provider, factory, store: { db },
    verifyDeployment: async () => ({ nativeSaleUpgrade: { version: 1 } }), dependencies: f.dependencies,
    publishStatus: (_path, value) => f.statuses.push(structuredClone(value)) });
  try {
    await worker.tick(); assert.equal(f.calls.length, 0); assert.equal(worker.snapshot().pools[pool].status, 'buyer-pending');
    db.prepare('UPDATE market SET record=NULL').run();
    await worker.tick(); assert.equal(posts(f).length, 1);
    await worker.close();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market').get().n, 1, 'worker does not close or own API database lifecycle');
  } finally { await worker.close(); await f.publisher.close(); db.close(); }
  assert.throws(() => createFirstoAskApiWorker({ config: f.config, provider: f.provider, factory,
    verifyDeployment: async () => ({}), store: {} }), /API-owned/);
});

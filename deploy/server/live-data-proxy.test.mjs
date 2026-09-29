import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveDataProxy, liveDataProxyConfiguration, validateReadRpc } from './live-data-proxy.mjs';
import { createDeploymentServer } from './index.mjs';

const address = `0x${'11'.repeat(20)}`;
const rpc = (method = 'eth_chainId', params = []) => ({ jsonrpc: '2.0', id: 1, method, params });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
async function fixture(t, options = {}) {
  const calls = [];
  const liveDataProxy = createLiveDataProxy({ rpcUrl: 'https://operator-rpc.test/key', indexUrl: 'http://127.0.0.1:4180',
    fetcher: async (url, init) => { calls.push({ url, init }); return options.upstream ? options.upstream(url, init)
      : json(init.method === 'POST' ? { jsonrpc: '2.0', id: JSON.parse(init.body).id, result: '0x38' } : { source: { complete: true }, data: { items: [] } }); }, ...options });
  const server = createDeploymentServer({ liveDataProxy, journalService: { handle(req, res) { res.end('journal-ok'); } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { calls, base, get: path => fetch(`${base}${path}`), post: (payload, path = '/api/rpc', extra = {}) => fetch(`${base}${path}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), ...extra }) };
}

test('configuration uses only fixed operator destinations and existing journal RPC fallback', () => {
  assert.deepEqual(liveDataProxyConfiguration({}), { rpcUrl: null, indexUrl: 'http://127.0.0.1:4180/' });
  assert.equal(liveDataProxyConfiguration({ DEPLOYMENT_JOURNAL_RPC_URL: 'https://bsc.example/rpc' }).rpcUrl, 'https://bsc.example/rpc');
  assert.equal(liveDataProxyConfiguration({ BEMINE_READ_RPC_URL: 'https://a.test', DEPLOYMENT_JOURNAL_RPC_URL: 'https://b.test' }).rpcUrl, 'https://a.test/');
  for (const value of ['file:///etc/passwd', 'https://user:password@rpc.test', 'https://rpc.test/#secret']) assert.throws(() => liveDataProxyConfiguration({ BEMINE_READ_RPC_URL: value }));
  assert.throws(() => liveDataProxyConfiguration({ BEMINE_INDEX_URL: 'http://127.0.0.1:4180?url=http://evil.test' }));
});

test('all six read methods accept exact bounded parameters; unknown/write/batch/override routes fail closed', () => {
  const calls = [rpc(), rpc('eth_blockNumber'), rpc('eth_getBlockByNumber', ['0xa', false]), rpc('eth_getCode', [address, 'latest']),
    rpc('eth_getStorageAt', [address, '0x0', '0xa']), rpc('eth_call', [{ to: address, data: '0xab' }, '0xa'])];
  for (const input of calls) assert.equal(validateReadRpc(input).method, input.method);
  assert.equal(validateReadRpc(calls.at(-1)).params[0].gas, '0x1c9c380');
  for (const input of [rpc('eth_sendTransaction', [{}]), rpc('eth_sendRawTransaction', ['0xab']), rpc('personal_sign'), rpc('eth_requestAccounts'),
    rpc('debug_traceCall'), [rpc()], { ...rpc(), id: null }, { ...rpc(), url: 'https://evil.test' },
    rpc('eth_getBlockByNumber', ['latest', true]), rpc('eth_call', [{ to: address, data: '0x' }, 'latest', {}]),
    rpc('eth_call', [{ to: address, data: '0x', gas: '0x1c9c381' }, 'latest']), rpc('eth_call', [{ data: '0x' }, 'latest'])]) assert.throws(() => validateReadRpc(input));
});

test('same-origin routing retains journal/static behavior and proxies RPC without request headers', async t => {
  const f = await fixture(t); const res = await f.post(rpc(), '/api/rpc', { headers: { 'content-type': 'application/json', authorization: 'must-not-forward', cookie: 'secret' } });
  assert.equal(res.status, 200); assert.equal((await res.json()).result, '0x38'); assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(f.calls[0].url, 'https://operator-rpc.test/key'); assert.equal(f.calls[0].init.redirect, 'error');
  assert.equal(f.calls[0].init.headers.authorization, undefined); assert.equal(f.calls[0].init.headers.cookie, undefined);
  assert.equal(await (await f.get('/api/journal/health')).text(), 'journal-ok');
  assert.equal((await f.get('/missing-static-file')).status, 404);
  assert.equal((await f.post(rpc(), '/missing-static-file')).status, 405);
});

test('RPC rejects writes, URL override, malformed or oversized input before any upstream call', async t => {
  const f = await fixture(t, { maxRequestBytes: 256 });
  assert.equal((await f.post(rpc('eth_sendTransaction', [{}]))).status, 403);
  assert.equal((await f.post(rpc(), '/api/rpc?url=http://evil.test')).status, 400);
  assert.equal((await f.post([rpc()])).status, 400);
  assert.equal((await f.post(rpc(), '/api/rpc', { body: '{' })).status, 400);
  assert.equal((await f.post(rpc(), '/api/rpc', { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await f.post(rpc(), '/api/rpc', { body: 'x'.repeat(300) })).status, 413);
  assert.equal((await f.get('/api/rpc')).status, 405); assert.equal(f.calls.length, 0);
});

test('index allows only known GET endpoints and bounded unique query parameters', async t => {
  const f = await fixture(t);
  for (const path of ['/health', '/v1/stats', '/v1/pools?cursor=0&limit=20', `/v1/accounts/${address}/pools`,
    '/v1/snapshot/pools?cursor=0&limit=20', '/v1/snapshot/portfolios?limit=20', '/v1/snapshot/stats',
    `/v1/snapshot/orders?active=true&seller=${address}&limit=20`,
    `/v1/orders?pool=${address}&seller=${address}&active=true&cursor=8`, `/v1/activity?cursor=10:2:1&account=${address}`,
    `/v1/yield?pool=${address}&days=30`]) assert.equal((await f.get(`/api/chain-index${path}`)).status, 200);
  assert(f.calls.every(call => call.url.startsWith('http://127.0.0.1:4180/') && call.init.method === 'GET'));
  const count = f.calls.length;
  for (const path of ['/v1/private', '/v1/notifications', '/v1/pools?url=http://evil.test', '/v1/pools?limit=1&limit=2', '/v1/pools?limit=51',
    '/v1/orders?cursor=0', '/v1/orders?active=maybe', '/v1/activity?cursor=1:2:Infinity', '/v1/yield?days=30']) assert((await f.get(`/api/chain-index${path}`)).status >= 400);
  assert.equal((await f.post(rpc(), '/api/chain-index/v1/pools')).status, 405); assert.equal(f.calls.length, count);
});

test('missing RPC configuration is explicit 503, not dummy chain data', async t => {
  const f = await fixture(t, { rpcUrl: null }); assert.equal((await f.post(rpc())).status, 503); assert.equal(f.calls.length, 0);
});

test('proxy preserves incomplete index 503 and refuses redirected/HTML/mismatched upstream results', async t => {
  const incomplete = await fixture(t, { upstream: () => json({ source: { complete: false }, data: null }, 503) });
  const result = await incomplete.get('/api/chain-index/v1/pools'); assert.equal(result.status, 503); assert.equal((await result.json()).data, null);
  for (const upstream of [() => new Response('', { status: 302, headers: { location: 'https://evil.test' } }),
    () => new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    () => json({ jsonrpc: '2.0', id: 9, result: '0x38' }), () => json({ jsonrpc: '2.0', id: 1, result: '0x38', error: {} })]) {
    const f = await fixture(t, { upstream }); assert.equal((await f.post(rpc())).status, 502);
  }
});

test('server reuses only a recent complete public source; browser and private reads stay uncached', async t => {
  let clock = Date.now(), indexCalls = 0;
  const source = { chainId: 56, complete: true, unknownReason: null, indexedThrough: 100,
    indexedBlockHash: `0x${'ab'.repeat(32)}`, checkedAt: new Date(clock).toISOString() };
  const f = await fixture(t, { now: () => clock, publicSourceTtlMs: 30000,
    upstream: (_url, init) => {
      if (init.method === 'POST') return json({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: '0x38' });
      indexCalls++;
      return indexCalls === 1 ? json({ source, data: { items: [] } })
        : json({ source: { ...source, complete: false, unknownReason: 'index_not_caught_up' }, data: null }, 503);
    } });
  assert.equal((await f.get('/api/chain-index/v1/pools')).status, 200);
  const cached = await f.get('/api/chain-index/health');
  assert.equal(cached.status, 200);
  assert.equal(cached.headers.get('x-bemine-server-cache'), 'hit');
  assert.deepEqual(await cached.json(), { source });
  assert.equal(indexCalls, 1, 'the server answers health from its own cache');
  assert.equal((await f.get('/api/chain-index/v1/pools')).status, 503, 'catalog is never served stale');
  assert.equal((await f.post(rpc())).status, 200, 'RPC is never served stale');
  clock += 30000;
  assert.equal((await f.get('/api/chain-index/health')).status, 503, 'expired source is not served');
});

test('verified history responses never seed or preserve the fresh health cache', async t => {
  const source = { chainId: 56, complete: true, unknownReason: null, indexedThrough: 100,
    indexedBlockHash: `0x${'ab'.repeat(32)}`, checkedAt: new Date().toISOString() };
  const historical = { ...source, readMode: 'verified_snapshot', stale: true,
    refreshing: true, transactionReady: false };
  let calls = 0;
  const f = await fixture(t, { upstream: url => {
    calls++;
    if (url.includes('/v1/pools')) return json({ source, data: { items: [] } });
    if (url.includes('/v1/activity')) return json({ source: historical, data: { items: [] } });
    return json({ source: { ...source, complete: false, unknownReason: 'index_not_caught_up' } });
  } });
  assert.equal((await f.get('/api/chain-index/v1/pools')).status, 200);
  assert.equal((await f.get('/api/chain-index/v1/activity')).status, 200);
  const health = await f.get('/api/chain-index/health');
  assert.equal(health.headers.get('x-bemine-server-cache'), null);
  assert.equal((await health.json()).source.complete, false);
  assert.equal(calls, 3);

  let coldCalls = 0;
  const cold = await fixture(t, { upstream: url => {
    coldCalls++;
    return url.includes('/v1/activity') ? json({ source: historical, data: { items: [] } })
      : json({ source: { ...source, complete: false, unknownReason: 'index_not_caught_up' } });
  } });
  assert.equal((await cold.get('/api/chain-index/v1/activity')).status, 200);
  const coldHealth = await cold.get('/api/chain-index/health');
  assert.equal(coldHealth.headers.get('x-bemine-server-cache'), null);
  assert.equal((await coldHealth.json()).source.complete, false);
  assert.equal(coldCalls, 2);
});

test('cached public health remains readable while the upstream RPC capacity is occupied', async t => {
  let releaseRpc, rpcStarted = false;
  const gate = new Promise(resolve => { releaseRpc = resolve; });
  const source = { chainId: 56, complete: true, unknownReason: null, indexedThrough: 100,
    indexedBlockHash: `0x${'ab'.repeat(32)}`, checkedAt: new Date().toISOString() };
  const f = await fixture(t, { maxConcurrent: 1, maxQueued: 0,
    upstream: async (_url, init) => {
      if (init.method === 'GET') return json({ source, data: { items: [] } });
      rpcStarted = true;
      await gate;
      return json({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: '0x38' });
    } });
  assert.equal((await f.get('/api/chain-index/v1/pools')).status, 200);
  const rpcRead = f.post(rpc());
  while (!rpcStarted) await new Promise(resolve => setTimeout(resolve, 1));
  const health = await f.get('/api/chain-index/health');
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('x-bemine-server-cache'), 'hit');
  releaseRpc();
  assert.equal((await rpcRead).status, 200);
});

test('server reuses exact pinned reads while live headers and latest simulations stay fresh', async t => {
  let clock = Date.now(), reads = 0;
  const f = await fixture(t, { now: () => clock, pinnedRpcTtlMs: 1000,
    upstream: (_url, init) => {
      const request = JSON.parse(init.body); reads++;
      return json({ jsonrpc: '2.0', id: request.id, result: '0x6001' });
    } });
  const pinned = rpc('eth_getCode', [address, '0xa']);
  assert.equal((await (await f.post(pinned)).json()).result, '0x6001');
  const hit = await f.post({ ...pinned, id: 2 });
  assert.equal(hit.headers.get('x-bemine-server-cache'), 'hit');
  assert.equal((await hit.json()).id, 2);
  assert.equal(reads, 1);
  await f.post(rpc('eth_getBlockByNumber', ['0xa', false]));
  await f.post(rpc('eth_getBlockByNumber', ['0xa', false]));
  await f.post(rpc('eth_call', [{ to: address, data: '0x' }, 'latest']));
  await f.post(rpc('eth_call', [{ to: address, data: '0x' }, 'latest']));
  assert.equal(reads, 5, 'canonical header checks and latest simulations are never cached');
  clock += 1000;
  await f.post(pinned);
  assert.equal(reads, 6, 'a pinned result expires at its TTL');
});

test('oversized upstream bodies, timeout and exhausted concurrency are bounded', async t => {
  const huge = await fixture(t, { maxResponseBytes: 64, upstream: () => json({ oversized: 'x'.repeat(100) }) });
  assert.equal((await huge.post(rpc())).status, 502);
  const stalled = await fixture(t, { timeoutMs: 50, maxConcurrent: 1, maxQueued: 0,
    upstream: () => new Promise(() => {}) });
  const first = stalled.post(rpc());
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await stalled.post(rpc())).status, 503); assert.equal((await first).status, 504);
});

test('short bounded queue absorbs read bursts above the active RPC limit without skipping validation', async t => {
  let releaseFirst, active = 0, peak = 0, calls = 0;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const f = await fixture(t, { maxConcurrent: 1, maxQueued: 2, queueTimeoutMs: 500,
    upstream: async (_url, init) => {
      active++; peak = Math.max(peak, active); calls++;
      if (calls === 1) await gate;
      active--;
      return json({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: '0x38' });
    } });
  const first = f.post(rpc());
  while (calls === 0) await new Promise(resolve => setTimeout(resolve, 1));
  const second = f.post({ ...rpc(), id: 2 });
  const third = f.post({ ...rpc(), id: 3 });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await f.get('/api/chain-index/v1/private')).status, 404,
    'invalid routes must be rejected before they can occupy the queue');
  assert.equal((await f.post({ ...rpc(), id: 4 })).status, 503,
    'the queue remains bounded under overload');
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second, third].map(async request => (await request).status)), [200, 200, 200]);
  assert.equal(peak, 1);
  assert.equal(calls, 3);
});

test('queued reads expire instead of waiting behind a stalled upstream', async t => {
  let releaseFirst, calls = 0;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const f = await fixture(t, { maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 20, timeoutMs: 1000,
    upstream: async (_url, init) => {
      calls++;
      if (calls === 1) await gate;
      return json({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: '0x38' });
    } });
  const first = f.post(rpc());
  while (calls === 0) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal((await f.post({ ...rpc(), id: 2 })).status, 503);
  releaseFirst();
  assert.equal((await first).status, 200);
  assert.equal((await f.post({ ...rpc(), id: 3 })).status, 200);
  assert.equal(calls, 2, 'expired request must never reach the RPC upstream');
});

test('upstream error details are not reflected to visitors', async t => {
  const f = await fixture(t, { upstream: () => json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'private-key-or-secret-url' } }) });
  const result = await f.post(rpc()); assert.equal(result.status, 200); assert(!(await result.text()).includes('private-key-or-secret-url'));
});

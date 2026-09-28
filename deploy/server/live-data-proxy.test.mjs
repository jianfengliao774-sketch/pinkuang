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
    `/v1/orders?pool=${address}&seller=${address}&active=true&cursor=8`, `/v1/activity?cursor=10:2:1&account=${address}`,
    `/v1/yield?pool=${address}&days=30`]) assert.equal((await f.get(`/api/chain-index${path}`)).status, 200);
  assert(f.calls.every(call => call.url.startsWith('http://127.0.0.1:4180/') && call.init.method === 'GET'));
  const count = f.calls.length;
  for (const path of ['/v1/private', '/v1/notifications', '/v1/community', '/v1/pools?url=http://evil.test', '/v1/pools?limit=1&limit=2', '/v1/pools?limit=51',
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

test('oversized upstream bodies, timeout and exhausted concurrency are bounded', async t => {
  const huge = await fixture(t, { maxResponseBytes: 64, upstream: () => json({ oversized: 'x'.repeat(100) }) });
  assert.equal((await huge.post(rpc())).status, 502);
  const stalled = await fixture(t, { timeoutMs: 50, maxConcurrent: 1, upstream: () => new Promise(() => {}) });
  const first = stalled.post(rpc());
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await stalled.post(rpc())).status, 503); assert.equal((await first).status, 504);
});

test('upstream error details are not reflected to visitors', async t => {
  const f = await fixture(t, { upstream: () => json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'private-key-or-secret-url' } }) });
  const result = await f.post(rpc()); assert.equal(result.status, 200); assert(!(await result.text()).includes('private-key-or-secret-url'));
});

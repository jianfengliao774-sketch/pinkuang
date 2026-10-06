import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveDataProxy } from './live-data-proxy.mjs';
import { createTargetOwnerReadServer, targetOwnerReadServerConfiguration } from './target-owner-read-server.mjs';

const transactionHash = `0x${'ab'.repeat(32)}`;
const rpc = (method, params = []) => ({ jsonrpc: '2.0', id: 7, method, params });

test('target-owner read server binds loopback and accepts only a strict positive port', () => {
  assert.deepEqual(targetOwnerReadServerConfiguration({}), { host: '127.0.0.1', port: 4228 });
  assert.deepEqual(targetOwnerReadServerConfiguration({ HOST: '0.0.0.0', TARGET_OWNER_READ_PORT: '4321' }),
    { host: '127.0.0.1', port: 4321 });
  for (const value of ['0', '-1', '1.5', '1e2', '0001', '65536', '', ' 4228', 4228])
    assert.throws(() => targetOwnerReadServerConfiguration({ TARGET_OWNER_READ_PORT: value }));
});

test('target-owner server exposes one read route and never dispatches journal, index, static or wallet writes', async t => {
  const calls = [];
  const archive = 'https://archive.test/fixed';
  const transactions = 'https://transactions.test/fixed';
  const proxy = createLiveDataProxy({ rpcUrl: archive, transactionRpcUrl: transactions,
    fetcher: async (url, init) => {
      const request = JSON.parse(init.body); calls.push({ url, method: request.method });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        result: request.method === 'eth_chainId' ? '0x38' : { transactionHash } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    } });
  const server = createTargetOwnerReadServer(proxy);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body) });
  for (const path of ['/api/journal/health', '/api/journal/authority-relay', '/api/chain-index/health',
    '/firsto-api/order', '/assets/app.js', '/', '/api/rpc/extra']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
    assert.equal((await post(path, rpc('eth_getTransactionReceipt', [transactionHash]))).status, 404, path);
  }
  assert.equal((await fetch(`${base}/api/rpc`)).status, 405);
  assert.equal((await post('/api/rpc', rpc('eth_sendTransaction', [{ to: '0x' + '11'.repeat(20) }]))).status, 403);
  assert.equal((await post('/api/rpc', rpc('eth_getBlockByNumber', ['0xa', true]))).status, 400);
  assert.deepEqual(calls, []);
  const receipt = await post('/api/rpc', rpc('eth_getTransactionReceipt', [transactionHash]));
  assert.equal(receipt.status, 200);
  assert.equal((await receipt.json()).result.transactionHash, transactionHash);
  assert.deepEqual(calls, [{ url: transactions, method: 'eth_chainId' },
    { url: transactions, method: 'eth_getTransactionReceipt' }]);
});

test('target-owner HTTP route recovers a null-id CUPS refusal while preserving the caller id and bounded diagnostics', async t => {
  const calls = [], diagnostics = [];
  const archive = 'https://archive.test/fixed', transactions = 'https://transactions.test/fixed';
  let attempts = 0;
  const proxy = createLiveDataProxy({ rpcUrl: archive, transactionRpcUrl: transactions,
    maxConcurrent: 4, maxConcurrentPerClient: 2, retryArchiveRateLimit: true, rateLimitRetryDelayMs: 1,
    onRpcDiagnostic: item => diagnostics.push(item), fetcher: async (url, init) => {
      const request = JSON.parse(init.body); calls.push({ url, method: request.method });
      if (request.method === 'eth_call' && ++attempts === 1) return new Response(JSON.stringify({
        jsonrpc: '2.0', id: null, error: { code: -32005, message: 'Compute units per second capacity exceeded: secret' },
      }), { status: 429, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        result: request.method === 'eth_chainId' ? '0x38' : '0x6000' }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    } });
  const server = createTargetOwnerReadServer(proxy);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(rpc('eth_call', [{ to: '0x' + '11'.repeat(20), data: '0xab' }, 'latest'])),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { jsonrpc: '2.0', id: 7, result: '0x6000' });
  assert.deepEqual(calls, ['eth_chainId', 'eth_call', 'eth_chainId', 'eth_call'].map(method => ({ url: archive, method })));
  assert(diagnostics.some(item => item.errorKind === 'cups' && item.idMatches === false));
  assert(!JSON.stringify(diagnostics).includes('secret'));
  assert(!JSON.stringify(diagnostics).includes('archive.test'));
});

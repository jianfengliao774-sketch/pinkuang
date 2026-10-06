import assert from 'node:assert/strict';
import test from 'node:test';
import { createTargetOwnerReadServer } from './target-owner-read-server.mjs';
import { createLiveDataProxy } from './live-data-proxy.mjs';

const archive = 'https://archive.test/fixed';
const transactions = 'https://transactions.test/fixed';
const header = hash => ({ number: '0xa', hash: `0x${hash.repeat(64)}`, timestamp: '0x1', transactions: [] });
const refusal = id => ({ jsonrpc: '2.0', id, error: { code: -32005, message: 'rate exceeded' } });
const envelope = (id, result) => ({ jsonrpc: '2.0', id, result });
async function fixture(t, { wrongChain = false, wrongHash = false, prunedState = false, rememberAnchor = false } = {}) {
  let identities = 0, headers = 0;
  const calls = [];
  const proxy = createLiveDataProxy({ rpcUrl: archive, transactionRpcUrl: transactions,
    retryArchiveRateLimit: true, rateLimitRetryDelayMs: 1, headerTtlMs: 1,
    fetcher: async (url, init) => {
      const request = JSON.parse(init.body); calls.push({ destination: url === archive ? 'archive' : 'transactions', method: request.method });
      let status = 200, value;
      if (url === archive) {
        if (request.method === 'eth_chainId' && ++identities === 1) value = envelope(request.id, '0x38');
        else if (request.method === 'eth_getBlockByNumber' && ++headers === 1 && rememberAnchor)
          value = envelope(request.id, header('a'));
        else { status = 429; value = refusal(null); }
      } else if (request.method === 'eth_chainId') value = envelope(request.id, wrongChain ? '0x1' : '0x38');
      else if (request.method === 'eth_getBlockByNumber') value = envelope(request.id, header(wrongHash ? 'b' : 'a'));
      else if (request.method === 'eth_call' && prunedState) value = { jsonrpc: '2.0', id: request.id,
        error: { code: -32000, message: 'missing trie node' } };
      else throw new Error(`Unexpected fixture read: ${request.method}`);
      return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    } });
  const server = createTargetOwnerReadServer(proxy);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const post = (method = 'eth_getBlockByNumber', params = ['0xa', false]) => fetch(`http://127.0.0.1:${server.address().port}/api/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }),
  });
  return { post, calls };
}

test('header throttle plus retry identity throttle can use only an independently proven canonical read fallback', async t => {
  const f = await fixture(t);
  const response = await f.post(); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), envelope(7, header('a')));
  assert.deepEqual(f.calls.filter(call => call.destination === 'transactions').map(call => call.method),
    ['eth_chainId', 'eth_getBlockByNumber', 'eth_getBlockByNumber']);
  assert(f.calls.every(call => !call.method.startsWith('eth_send')));
});

test('header throttle recovery refuses a wrong-chain fallback', async t => {
  const f = await fixture(t, { wrongChain: true }); assert.equal((await f.post()).status, 502);
  assert.equal(f.calls.filter(call => call.destination === 'transactions' && call.method === 'eth_getBlockByNumber').length, 0);
});

test('header throttle recovery refuses disagreement with a previously observed canonical anchor', async t => {
  const f = await fixture(t, { rememberAnchor: true, wrongHash: true });
  assert.equal((await f.post()).status, 200);
  await new Promise(resolve => setTimeout(resolve, 4));
  assert.equal((await f.post()).status, 502);
});

test('archive state throttle never accepts a pruned fallback as a valid historical state result', async t => {
  const f = await fixture(t, { prunedState: true });
  assert.equal((await f.post('eth_call', [{ to: `0x${'11'.repeat(20)}`, data: '0x1234' }, '0xa'])).status, 502);
  assert(f.calls.every(call => !call.method.startsWith('eth_send')));
});

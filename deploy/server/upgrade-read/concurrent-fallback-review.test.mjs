import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveDataProxy } from './live-data-proxy.mjs';
import { createTargetOwnerReadServer } from './target-owner-read-server.mjs';

const archive = 'https://review-archive.test/fixed';
const alternate = 'https://review-alternate.test/fixed';
const address = `0x${'11'.repeat(20)}`;
const header = hash => ({ number: '0xa', hash: `0x${hash.repeat(64)}`, timestamp: '0x1', transactions: [] });
const response = (id, result, status = 200) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }),
  { status, headers: { 'content-type': 'application/json' } });
const refusal = () => new Response(JSON.stringify({ jsonrpc: '2.0', id: null,
  error: { code: -32005, message: 'opaque rate refusal' } }),
  { status: 429, headers: { 'content-type': 'application/json' } });
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t, failedIdentity, { holdAt = 'eth_chainId', forkAfterStart = false } = {}) {
  let identities = 0;
  const entered = gate(), release = gate(), calls = [];
  const proxy = createLiveDataProxy({ rpcUrl: archive, transactionRpcUrl: alternate,
    retryArchiveRateLimit: true, rateLimitRetryDelayMs: 1, maxConcurrent: 4, maxConcurrentPerClient: 4,
    fetcher: async (url, init) => {
      const request = JSON.parse(init.body); calls.push({ url, method: request.method });
      if (url === alternate) {
        if (request.method === holdAt) { entered.resolve(); await release.promise; }
        if (request.method === 'eth_chainId') return response(request.id, '0x38');
        if (request.method === 'eth_getBlockByNumber') return response(request.id, header('a'));
        if (request.method === 'eth_call') return response(request.id, '0x6000');
        throw new Error('Unexpected alternate read.');
      }
      if (request.method === 'eth_chainId') {
        identities++;
        if (identities === 1) return response(request.id, '0x38');
        if (identities === 2) return refusal();
        return failedIdentity(request);
      }
      if (forkAfterStart && request.method === 'eth_getBlockByNumber') return response(request.id, header('b'));
      return refusal();
    } });
  const server = createTargetOwnerReadServer(proxy);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const post = (method, params) => fetch(`http://127.0.0.1:${server.address().port}/api/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }),
  });
  return { post, entered, release, calls };
}

for (const [name, failedIdentity] of [
  ['actual wrong chain', request => response(request.id, '0x1')],
  ['malformed identity envelope', () => response(null, '0x38')],
]) test(`alternate proof cannot absorb a concurrent ${name} during its identity proof`, async t => {
  const f = await fixture(t, failedIdentity);
  const candidate = f.post('eth_call', [{ to: address, data: '0x1234' }, '0xa']);
  await f.entered.promise;
  const excluded = await f.post('eth_getTransactionCount', [address, 'pending']);
  assert.equal(excluded.status, 502);
  f.release.resolve();
  const recovered = await candidate;
  const body = await recovered.json();
  assert.equal(recovered.status, 502, JSON.stringify(body));
});

for (const holdAt of ['eth_call', 'eth_getBlockByNumber'])
test(`alternate proof fails a concurrent wrong-chain primary while held at ${holdAt}`, async t => {
  const f = await fixture(t, request => response(request.id, '0x1'), { holdAt });
  const candidate = f.post('eth_call', [{ to: address, data: '0x1234' }, '0xa']);
  await f.entered.promise;
  assert.equal((await f.post('eth_getTransactionCount', [address, 'pending'])).status, 502);
  f.release.resolve();
  assert.equal((await candidate).status, 502);
});

test('a same-height changed primary hash observed during alternate data prevents returning historical state', async t => {
  const f = await fixture(t, request => response(request.id, '0x38'), { holdAt: 'eth_call', forkAfterStart: true });
  const candidate = f.post('eth_call', [{ to: address, data: '0x1234' }, '0xa']);
  await f.entered.promise;
  const changed = await f.post('eth_getBlockByNumber', ['0xa', false]);
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).result.hash, header('b').hash);
  f.release.resolve();
  assert.equal((await candidate).status, 502);
  assert(f.calls.every(call => !call.method.startsWith('eth_send')));
});

for (const injectAt of ['first refusal', 'retry identity refusal'])
test(`alternate proof refuses an excluded identity failure already completed at ${injectAt}`, async t => {
  let clock = 100000, identities = 0, mode = 'good', injected = false, post;
  const calls = [];
  const inject = async () => {
    injected = true; clock += 6000; mode = 'wrong';
    assert.equal((await post('eth_getTransactionCount', [address, 'pending'])).status, 502);
    mode = 'refuse';
  };
  const proxy = createLiveDataProxy({ rpcUrl: archive, transactionRpcUrl: alternate,
    now: () => clock, retryArchiveRateLimit: true, rateLimitRetryDelayMs: 1,
    maxConcurrent: 4, maxConcurrentPerClient: 4,
    fetcher: async (url, init) => {
      const request = JSON.parse(init.body); calls.push({ url, method: request.method });
      if (url === alternate) return response(request.id,
        request.method === 'eth_chainId' ? '0x38' : request.method === 'eth_getBlockByNumber' ? header('a') : '0x6000');
      if (request.method === 'eth_chainId') {
        identities++;
        if (identities === 1) return response(request.id, '0x38');
        if (mode === 'wrong') return response(request.id, '0x1');
        if (injectAt === 'retry identity refusal' && !injected) await inject();
        return refusal();
      }
      if (injectAt === 'first refusal' && !injected) await inject();
      return refusal();
    } });
  const server = createTargetOwnerReadServer(proxy);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  post = (method, params) => fetch(`http://127.0.0.1:${server.address().port}/api/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }),
  });
  assert.equal((await post('eth_call', [{ to: address, data: '0x1234' }, '0xa'])).status, 502);
  assert(injected);
  assert.equal(calls.filter(call => call.url === alternate).length, 0,
    'an unrelated completed epoch change cannot be certified as the current request single refusal clear');
});

test('a handled refusal invalidates a legitimate sibling read; one new pure read can recover', async t => {
  const siblingStarted = gate(), siblingRelease = gate();
  const siblingAddress = `0x${'22'.repeat(20)}`;
  let identities = 0, siblingReads = 0;
  const proxy = createLiveDataProxy({ rpcUrl: archive, transactionRpcUrl: alternate,
    retryArchiveRateLimit: true, rateLimitRetryDelayMs: 1, maxConcurrent: 4, maxConcurrentPerClient: 4,
    fetcher: async (url, init) => {
      const request = JSON.parse(init.body);
      if (url === alternate) return response(request.id,
        request.method === 'eth_chainId' ? '0x38' : request.method === 'eth_getBlockByNumber' ? header('a') : '0x6000');
      if (request.method === 'eth_chainId') return ++identities === 2 ? refusal() : response(request.id, '0x38');
      if (request.params[0] === siblingAddress) {
        if (++siblingReads === 1) { siblingStarted.resolve(); await siblingRelease.promise; }
        return response(request.id, '0x6000');
      }
      return refusal();
    } });
  const server = createTargetOwnerReadServer(proxy);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const post = target => fetch(`http://127.0.0.1:${server.address().port}/api/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'eth_getCode', params: [target, '0xa'] }),
  });
  const sibling = post(siblingAddress); await siblingStarted.promise;
  assert.equal((await post(address)).status, 200);
  siblingRelease.resolve();
  assert.equal((await sibling).status, 502);
  assert.equal((await post(siblingAddress)).status, 200);
  assert.equal(siblingReads, 2);
});

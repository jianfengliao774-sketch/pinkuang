import test from 'node:test';
import assert from 'node:assert/strict';
import { id } from 'ethers';
import { createDeploymentServer } from './index.mjs';
import { createLiveDataProxy, liveDataProxyConfiguration, validateReadRpc, FEES_CLAIMED_TOPIC } from './live-data-proxy.mjs';

const address = n => `0x${n.toString(16).padStart(40, '0')}`;
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const authority = address(0xabc), scope = { authority, deploymentBlock: 100 };
const filter = patch => ({ address: authority, topics: [FEES_CLAIMED_TOPIC], fromBlock: '0x64', toBlock: '0xc8', ...patch });
const rpc = (patch = {}, requestId = 1) => ({ jsonrpc: '2.0', id: requestId, method: 'eth_getLogs', params: [filter(patch)] });
const log = patch => ({ address: authority, topics: [FEES_CLAIMED_TOPIC, hash(123)], data: `0x${'0'.repeat(127)}1`,
  blockNumber: '0x65', blockHash: hash(101), transactionHash: hash(55), logIndex: '0x0', transactionIndex: '0x1', removed: false, ...patch });
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function fixture(t, { read = () => [log()], ...options } = {}) {
  const seen = [];
  const liveDataProxy = createLiveDataProxy({ rpcUrl: 'https://fixed-rpc.test/read', feeHistoryLogScope: scope,
    fetcher: async (_url, init) => {
      const request = JSON.parse(init.body); seen.push(request);
      const result = request.method === 'eth_chainId' ? '0x38' : await read(request);
      return json({ jsonrpc: '2.0', id: request.id, result });
    }, ...options });
  const server = createDeploymentServer({ liveDataProxy });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const post = body => fetch(`http://127.0.0.1:${server.address().port}/api/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { post, seen };
}

test('fee log scope comes only from the already loaded fresh manifest, never request or extra environment fields', () => {
  assert.equal(FEES_CLAIMED_TOPIC, id('FeesClaimed(address,uint256,uint256)'));
  const freshProduct = { manifest: { authority, deployment: { blockNumber: 100 } } };
  const config = liveDataProxyConfiguration({ BEMINE_READ_RPC_URL: 'https://fixed-rpc.test/read',
    BEMINE_FEE_HISTORY_AUTHORITY: address(999), BEMINE_FEE_HISTORY_START: '0' }, { freshProduct });
  assert.deepEqual(config.feeHistoryLogScope, scope);
  assert(Object.isFrozen(config.feeHistoryLogScope));
  assert.equal(liveDataProxyConfiguration({ BEMINE_FEE_HISTORY_AUTHORITY: authority }).feeHistoryLogScope, undefined);
  for (const bad of [{}, { authority }, { authority, deploymentBlock: '100' }, { authority, deploymentBlock: -1 },
    { authority, deploymentBlock: 0 }, { authority: address(0), deploymentBlock: 100 },
    { authority: [authority], deploymentBlock: 100 }, { authority, deploymentBlock: 1.5 },
    { authority, deploymentBlock: Number.MAX_SAFE_INTEGER + 1 }, { ...scope, topic: hash(1) }])
    assert.throws(() => createLiveDataProxy({ feeHistoryLogScope: bad }), /pinned fresh Authority/);
  assert.throws(() => liveDataProxyConfiguration({}, { freshProduct: { manifest: {} } }), /pinned fresh Authority/);
});

test('fee logs allow exactly one pinned address and event topic over at most 5000 explicit blocks', () => {
  const options = { feeHistoryLogScope: scope };
  assert.equal(validateReadRpc(rpc(), options).method, 'eth_getLogs');
  assert.equal(validateReadRpc(rpc({ toBlock: '0x13eb' }), options).params[0].toBlock, '0x13eb'); // 100..5099
  assert.deepEqual(validateReadRpc(rpc({ address: authority.toUpperCase().replace('0X', '0x'),
    topics: [FEES_CLAIMED_TOPIC.toUpperCase().replace('0X', '0x')], toBlock: '0xC8' }), options).params, [filter()]);
  for (const request of [rpc({ toBlock: '0x13ec' }), rpc({ toBlock: '0x63' }),
    rpc({ address: address(999) }), rpc({ address: [authority] }), rpc({ address: undefined }),
    rpc({ topics: [] }), rpc({ topics: [null] }), rpc({ topics: [[FEES_CLAIMED_TOPIC]] }),
    rpc({ topics: [FEES_CLAIMED_TOPIC, null] }), rpc({ topics: [hash(1)] }), rpc({ topics: undefined }),
    rpc({ fromBlock: 'latest' }), rpc({ fromBlock: 'earliest' }), rpc({ toBlock: 'finalized' }),
    rpc({ toBlock: 'pending' }), rpc({ toBlock: undefined }), rpc({ fromBlock: 100 }), rpc({ fromBlock: '0x064' }),
    rpc({ blockHash: hash(100) }), rpc({ limit: 20 }), { ...rpc(), params: [] }, { ...rpc(), params: [filter(), filter()] }])
    assert.throws(() => validateReadRpc(request, options), /Invalid read-only RPC/);
  assert.throws(() => validateReadRpc(rpc()), /not enabled/);
});

test('Authority history predating the later Factory genesis remains readable without extra upstream proofs', async t => {
  // Authority was created at 100 and emitted at 101; the independent Factory
  // genesis was finalized at 200. These are intentionally different anchors.
  const freshProduct = { manifest: { authority, deployment: { blockNumber: 200 } } };
  const pinned = liveDataProxyConfiguration({}, { freshProduct }).feeHistoryLogScope;
  const f = await fixture(t, { feeHistoryLogScope: pinned });
  const response = await f.post(rpc({ fromBlock: '0x64', toBlock: '0x96' }));
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).result, [log()]);
  assert.deepEqual(f.seen.map(request => request.method), ['eth_chainId', 'eth_getLogs']);
  assert.deepEqual(f.seen[1].params, [filter({ fromBlock: '0x64', toBlock: '0x96' })]);
  assert.equal(validateReadRpc(rpc({ fromBlock: '0x0', toBlock: '0x0' }), { feeHistoryLogScope: pinned }).method, 'eth_getLogs');
  assert.equal((await f.post(rpc({ address: address(999), fromBlock: '0x64', toBlock: '0x96' }))).status, 400);
  assert.equal(f.seen.length, 2, 'loosening the unrelated genesis floor never widens the Authority scope');
});

test('unscoped or malformed log reads and every write method stop before contacting upstream', async t => {
  const f = await fixture(t);
  for (const body of [rpc({ address: address(99) }), rpc({ topics: [] }), rpc({ fromBlock: 'latest' }),
    rpc({ blockHash: hash(1) }), { ...rpc(), method: 'eth_sendTransaction' }, { ...rpc(), method: 'eth_sendRawTransaction' },
    { ...rpc(), method: 'personal_sign' }, { ...rpc(), method: 'eth_signTypedData_v4' }, [rpc()]])
    assert((await f.post(body)).status >= 400);
  assert.equal(f.seen.length, 0);
  const unconfigured = await fixture(t, { feeHistoryLogScope: null });
  assert.equal((await unconfigured.post(rpc())).status, 403); assert.equal(unconfigured.seen.length, 0);
});

test('exact successful fee ranges cache for 30 seconds and preserve each caller RPC id', async t => {
  let clock = 100_000, logs = 0;
  const f = await fixture(t, { now: () => clock, read: () => { logs++; return [log()]; } });
  const first = await f.post(rpc()); assert.equal(first.status, 200); assert.deepEqual((await first.json()).result, [log()]);
  const cached = await f.post(rpc({}, 2)); assert.equal(cached.headers.get('x-bemine-server-cache'), 'hit');
  assert.equal((await cached.json()).id, 2); assert.equal(logs, 1);
  clock += 29_999; await f.post(rpc({}, 3)); assert.equal(logs, 1);
  clock++; await f.post(rpc({}, 4)); assert.equal(logs, 2);
  await f.post(rpc({ toBlock: '0xc9' }, 5)); assert.equal(logs, 3, 'a different exact range cannot reuse another result');
});

test('only successful scoped log arrays are cached, including verified empty ranges', async t => {
  let mode = 'error', count = 0;
  const f = await fixture(t, { fetcher: async (_url, init) => {
    const request = JSON.parse(init.body);
    if (request.method === 'eth_chainId') return json({ jsonrpc: '2.0', id: request.id, result: '0x38' });
    count++;
    return json({ jsonrpc: '2.0', id: request.id, ...(mode === 'error' ? { error: { code: -32005, message: 'limit exceeded' } }
      : { result: mode === 'malformed' ? [log({ address: address(99) })] : [] }) });
  } });
  for (let i = 0; i < 2; i++) assert((await (await f.post(rpc())).json()).error);
  assert.equal(count, 2);
  mode = 'malformed'; for (let i = 0; i < 2; i++) assert.equal((await f.post(rpc())).status, 502);
  assert.equal(count, 4);
  mode = 'empty'; assert.deepEqual((await (await f.post(rpc())).json()).result, []);
  const hit = await f.post(rpc()); assert.equal(hit.headers.get('x-bemine-server-cache'), 'hit'); assert.equal(count, 5);
});

test('out-of-range, removed or malformed upstream fee logs cannot escape or populate caches', async t => {
  const invalid = [null, '0x', {}, [log({ address: address(99) })], [log({ topics: [hash(1), hash(2)] })],
    [log({ topics: [FEES_CLAIMED_TOPIC] })], [log({ blockNumber: '0x63' })], [log({ blockNumber: '0xc9' })],
    [log({ removed: true })], [log({ blockHash: null })], [log({ transactionHash: null })],
    [log({ data: '0x00' })], [log({ logIndex: 'latest' })]];
  for (const result of invalid) {
    let reads = 0; const f = await fixture(t, { read: () => { reads++; return result; } });
    assert.equal((await f.post(rpc())).status, 502); assert.equal((await f.post(rpc())).status, 502);
    assert.equal(reads, 2);
  }
});

test('same fixed range coalesces in-flight reads without sharing response ids', async t => {
  const waiting = deferred(), started = deferred(); let count = 0;
  const f = await fixture(t, { read: async () => { count++; started.resolve(); await waiting.promise; return [log()]; } });
  const first = f.post(rpc({}, 5)); await started.promise;
  const second = f.post(rpc({}, 6)); await new Promise(resolve => setTimeout(resolve, 10)); waiting.resolve();
  const results = await Promise.all([first, second].map(async response => (await response).json()));
  assert.deepEqual(results.map(value => value.id), [5, 6]); assert.equal(count, 1);
});

test('log cache is bounded to 64 successful ranges', async t => {
  let count = 0;
  const f = await fixture(t, { read: () => { count++; return []; } });
  for (let end = 100; end < 165; end++) assert.equal((await f.post(rpc({ toBlock: `0x${end.toString(16)}` }))).status, 200);
  assert.equal(count, 65);
  assert.equal((await f.post(rpc({ toBlock: '0xa4' }))).headers.get('x-bemine-server-cache'), 'hit');
  assert.equal((await f.post(rpc({ toBlock: '0x64' }))).headers.get('x-bemine-server-cache'), null);
  assert.equal(count, 66);
});

test('observed reorg evicts fee ranges and rejects old-fork log reads still in flight', async t => {
  let fork = 1, count = 0;
  const waiting = deferred(), started = deferred();
  const f = await fixture(t, { read: async request => {
    if (request.method === 'eth_getBlockByNumber') return { number: '0xc8', hash: hash(fork), timestamp: '0x123' };
    const captured = fork; count++;
    if (count === 2) { started.resolve(); await waiting.promise; }
    return [log({ blockHash: hash(captured) })];
  } });
  const header = { jsonrpc: '2.0', id: 9, method: 'eth_getBlockByNumber', params: ['latest', false] };
  await f.post(header); await f.post(rpc());
  const pending = f.post(rpc({ toBlock: '0xc9' })); await started.promise;
  fork = 2; await f.post(header); waiting.resolve();
  assert.equal((await pending).status, 502);
  const fresh = await f.post(rpc()); assert.equal(fresh.headers.get('x-bemine-server-cache'), null);
  assert.equal((await fresh.json()).result[0].blockHash, hash(2)); assert.equal(count, 3);
});

test('failed BSC reproof clears log caches and invalidates pending fee reads', async t => {
  let clock = 100_000, chain = '0x38', count = 0;
  const waiting = deferred(), started = deferred();
  const f = await fixture(t, { now: () => clock, chainIdTtlMs: 1000, fetcher: async (_url, init) => {
    const request = JSON.parse(init.body);
    if (request.method === 'eth_chainId') return json({ jsonrpc: '2.0', id: request.id, result: chain });
    if (++count === 2) { started.resolve(); await waiting.promise; }
    return json({ jsonrpc: '2.0', id: request.id, result: [log()] });
  } });
  await f.post(rpc()); const pending = f.post(rpc({ toBlock: '0xc9' })); await started.promise;
  chain = '0x1'; clock += 1000;
  assert.equal((await f.post(rpc())).status, 502); waiting.resolve(); assert.equal((await pending).status, 502);
  chain = '0x38'; const recovered = await f.post(rpc()); assert.equal(recovered.headers.get('x-bemine-server-cache'), null);
  assert.equal(recovered.status, 200); assert.equal(count, 3);
});

test('a fee read prevents an older cached safe header from serving its post-read canonical check', async t => {
  let head = 1, headers = 0;
  const f = await fixture(t, { read: request => {
    if (request.method === 'eth_getBlockByNumber') { headers++; return { number: '0xc8', hash: hash(head), timestamp: '0x123' }; }
    return [];
  } });
  const header = { jsonrpc: '2.0', id: 9, method: 'eth_getBlockByNumber', params: ['0xc8', false] };
  await f.post(header); head = 2; await f.post(rpc());
  const after = await f.post(header); assert.equal(after.headers.get('x-bemine-server-cache'), null);
  assert.equal((await after.json()).result.hash, hash(2)); assert.equal(headers, 2);
});

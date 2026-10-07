import assert from 'node:assert/strict';
import test from 'node:test';
import { id } from 'ethers';
import { createLiveDataProxy } from '../upgrade-read/live-data-proxy.mjs';
import { createGovernance24ReadServer, governance24ReadServerConfiguration, GOVERNANCE24_REVIEW_ANCHOR_BLOCK as anchor } from './governance24-read-server.mjs';
import { createGovernance24ScheduledLogs, validateGovernance24Logs, normalizeGovernance24Logs,
  GOVERNANCE24_OLD_TIMELOCK as timelock, GOVERNANCE24_CALL_SCHEDULED_TOPIC as topic } from './scheduled-logs.mjs';

const hash = byte => `0x${byte.repeat(64)}`, operationId = hash('1'), blockHash = hash('2'), transactionHash = hash('3');
const rpc = (method, params = []) => ({ jsonrpc: '2.0', id: 7, method, params });
const filter = overrides => ({ address: timelock, topics: [topic], fromBlock: '0x65', toBlock: '0x66', ...overrides });
const request = overrides => rpc('eth_getLogs', [filter(overrides)]);
const row = overrides => ({ address: timelock, topics: [topic, operationId, hash('0')], data: '0x1234',
  blockNumber: '0x65', blockHash, transactionHash, transactionIndex: '0x0', logIndex: '0x0', removed: false, ...overrides });
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const envelope = (payload, result) => json({ jsonrpc: '2.0', id: payload.id, result });
const archive = 'https://archive.invalid/protected-key', transactions = 'https://transactions.invalid/protected-key';
const env = overrides => ({ GOVERNANCE24_REVIEW_ANCHOR_BLOCK: String(anchor), GOVERNANCE24_READ_RPC_URL: archive,
  GOVERNANCE24_READ_TRANSACTION_RPC_URL: transactions, ...overrides });

test('isolated configuration binds loopback4230, separate operator destinations and an explicit reviewed anchor', () => {
  assert.deepEqual(governance24ReadServerConfiguration(env()), { host: '127.0.0.1', port: 4230,
    reviewAnchorBlock: anchor, rpcUrl: archive, transactionRpcUrl: transactions });
  assert.equal(governance24ReadServerConfiguration(env({ GOVERNANCE24_READ_PORT: '4330' })).port, 4330);
  for (const value of ['0', '01', '-1', '65536', '4.2', '', '9007199254740992'])
    assert.throws(() => governance24ReadServerConfiguration(env({ GOVERNANCE24_READ_PORT: value })), /PORT/);
  for (const value of [undefined, '100', String(anchor - 1), '0', '01', '-1', '1.1', '9007199254740992'])
    assert.throws(() => governance24ReadServerConfiguration(env({ GOVERNANCE24_REVIEW_ANCHOR_BLOCK: value })), /ANCHOR/);
  for (const overrides of [{ GOVERNANCE24_READ_RPC_URL: undefined }, { GOVERNANCE24_READ_TRANSACTION_RPC_URL: undefined },
    { GOVERNANCE24_READ_TRANSACTION_RPC_URL: archive }, { GOVERNANCE24_READ_RPC_URL: 'file:///protected' },
    { GOVERNANCE24_READ_RPC_URL: 'https://user:secret@archive.invalid' }, { GOVERNANCE24_READ_RPC_URL: `${archive}#frag` }])
    assert.throws(() => governance24ReadServerConfiguration(env(overrides)), /destinations|HTTP/);
  assert.throws(() => governance24ReadServerConfiguration({ BEMINE_READ_RPC_URL: archive,
    BEMINE_READ_TRANSACTION_RPC_URL: transactions, GOVERNANCE24_REVIEW_ANCHOR_BLOCK: String(anchor) }), /destinations/,
  'existing product/Firsto environment must not populate this service');
});

test('exact CallScheduled signature and indexed topics accept only canonical bounded incremental filters', () => {
  assert.equal(topic, id('CallScheduled(bytes32,uint256,address,uint256,bytes,bytes32,uint256)'));
  const normalized = validateGovernance24Logs(request({ address: timelock.toUpperCase().replace('0X', '0x'),
    topics: [topic.toUpperCase().replace('0X', '0x'), operationId, null], toBlock: '0x864' }), 100);
  assert.equal(normalized.params[0].address, timelock); assert.equal(normalized.params[0].topics[0], topic);
  assert.equal(BigInt(normalized.params[0].toBlock) - BigInt(normalized.params[0].fromBlock), 2047n);
  assert.equal(validateGovernance24Logs(request({ topics: [topic, null, hash('0')] }), 100).params[0].topics[1], null);
  assert.equal(validateGovernance24Logs(request({ toBlock: '0x65' }), 100).params[0].toBlock, '0x65');
});

test('other contracts/events, OR filters, wildcards, noncanonical bounds and ranges over2048 never reach the archive', () => {
  const bad = [ { address: `0x${'1'.repeat(40)}` }, { address: [timelock] }, { address: undefined },
    { topics: [] }, { topics: [null] }, { topics: [hash('4')] }, { topics: [[topic]] },
    { topics: [topic, [operationId]] }, { topics: [topic, '0x1'] }, { topics: [topic, null, null, null] },
    { topics: [topic, undefined] }, { fromBlock: 'latest' }, { toBlock: 'finalized' }, { fromBlock: '0x064' },
    { fromBlock: '0x64' }, { toBlock: '0x64' }, { toBlock: '0x865' }, { toBlock: '0x20000000000000' },
    { blockHash }, { fromBlock: 101 }, { fromBlock: '-1' }, { toBlock: undefined } ];
  for (const candidate of bad) assert.throws(() => validateGovernance24Logs(request(candidate), 100), /pinned|numeric/);
  for (const candidate of [[], { ...request(), id: null }, { ...request(), upstream: archive }, rpc('eth_getLogs', [filter(), {}]),
    rpc('eth_sendRawTransaction', ['0x01'])]) assert.throws(() => validateGovernance24Logs(candidate, 100), /identified/);
});

test('canonical log response fails closed on every unrelated, removed, duplicate or malformed row', () => {
  const expected = normalizeGovernance24Logs([row({ irrelevant: 'dropped' })], filter());
  assert.deepEqual(expected, [row()]);
  const bad = [{ removed: true }, { removed: undefined }, { address: `0x${'1'.repeat(40)}` },
    { topics: [hash('9'), operationId, hash('0')] }, { topics: [topic, operationId] },
    { topics: [topic, operationId, '0x0'] }, { blockNumber: '0x64' }, { blockNumber: '0x67' },
    { blockNumber: '0x065' }, { blockHash: '0x2' }, { transactionHash: '0x3' }, { logIndex: '0x00' },
    { transactionIndex: '0x20000000000000' }, { data: '0x123' }];
  for (const candidate of bad) assert.throws(() => normalizeGovernance24Logs([row(candidate)], filter()), /scope/);
  assert.throws(() => normalizeGovernance24Logs([row(), row()], filter()), /duplicate/);
  assert.throws(() => normalizeGovernance24Logs([row()], filter({ topics: [topic, hash('4')] })), /scope/);
  assert.throws(() => normalizeGovernance24Logs({}, filter()), /bounded/);
});

async function fixture(t, { mutate, logs = [row()], proxyFetcher, handlerOptions = {} } = {}) {
  const calls = [];
  const fetcher = async (url, options) => {
    const payload = JSON.parse(options.body); calls.push({ url, payload });
    if (mutate) { const override = await mutate(payload, url); if (override) return override; }
    const result = payload.method === 'eth_chainId' ? '0x38'
      : payload.method === 'eth_getBlockByNumber' ? { number: '0x1000', hash: blockHash, timestamp: '0x1234' }
      : payload.method === 'eth_getLogs' ? logs : '0x6000';
    return envelope(payload, result);
  };
  const proxy = createLiveDataProxy({ rpcUrl: archive, transactionRpcUrl: transactions, fallbackRpcUrl: null,
    fetcher: proxyFetcher ?? fetcher, chainIdTtlMs: 1 });
  const scheduled = createGovernance24ScheduledLogs({ rpcUrl: archive, reviewAnchorBlock: 100, fetcher, archiveReadStartIntervalMs: 1, ...handlerOptions });
  const server = createGovernance24ReadServer(proxy, scheduled); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { calls, scheduled, server, base, post: (payload, path = '/api/rpc', extra = {}) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), ...extra }) };
}

test('one service route preserves ordinary guarded reads and rejects writes, batches, index, assets and destination injection', async t => {
  const f = await fixture(t);
  for (const path of ['/', '/api/chain-index/health', '/api/journal/health', '/firsto-api/order', '/assets/app.js', '/api/rpc/extra'])
    assert.equal((await f.post(rpc('eth_chainId'), path)).status, 404);
  assert.equal((await fetch(`${f.base}/api/rpc`)).status, 405);
  for (const method of ['eth_sendTransaction', 'eth_sendRawTransaction', 'eth_sign', 'personal_sign', 'wallet_switchEthereumChain', 'debug_traceTransaction'])
    assert.equal((await f.post(rpc(method))).status, 403);
  assert.equal((await f.post([rpc('eth_chainId')])).status, 400);
  assert.equal((await f.post(rpc('eth_chainId'), '/api/rpc?url=https://bad.invalid')).status, 400);
  assert.equal((await f.post(rpc('eth_chainId'), '/api/rpc', { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await f.post(rpc('eth_getBlockByNumber', ['0x65', true]))).status, 400);
  assert.equal(f.calls.length, 0, 'all invalid requests are stopped before archive work');
  const state = await f.post(rpc('eth_getCode', [timelock, '0x65'])); assert.equal(state.status, 200);
  assert.deepEqual(await state.json(), { jsonrpc: '2.0', id: 7, result: '0x6000' });
  assert(f.calls.every(call => call.url === archive));
  const transaction = await f.post(rpc('eth_getTransactionByHash', [transactionHash])); assert.equal(transaction.status, 200);
  assert.equal(f.calls.at(-1).url, transactions, 'transaction bodies retain the independent transaction read destination');
});

test('scoped logs use protected archive only, check finalized/canonical anchors and are never cached', async t => {
  const f = await fixture(t);
  for (let n = 0; n < 2; n++) { const response = await f.post(request()); assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.deepEqual(await response.json(), { jsonrpc: '2.0', id: 7, result: [row()] }); }
  assert.equal(f.calls.length, 10); assert(f.calls.every(call => call.url === archive));
  assert.deepEqual(f.calls.slice(0, 5).map(call => call.payload.method),
    ['eth_chainId', 'eth_getBlockByNumber', 'eth_getLogs', 'eth_getBlockByNumber', 'eth_chainId']);
  assert.deepEqual(f.calls[1].payload.params, ['finalized', false]); assert.deepEqual(f.calls[3].payload.params, ['0x1000', false]);
});

test('log requests beyond finalized or malformed upstream scope, identity or chain are refused without fallback', async t => {
  const faults = [
    payload => payload.method === 'eth_chainId' ? envelope(payload, '0x1') : null,
    payload => payload.method === 'eth_getBlockByNumber' ? envelope(payload, { number: '0x64', hash: blockHash }) : null,
    payload => payload.method === 'eth_getLogs' ? envelope(payload, [row({ removed: true })]) : null,
    payload => payload.method === 'eth_getLogs' ? json({ jsonrpc: '2.0', id: 99, result: [] }) : null,
    payload => payload.method === 'eth_getLogs' ? json({ jsonrpc: '2.0', id: 7, result: [], error: {} }) : null,
    payload => payload.method === 'eth_getLogs' ? json({ jsonrpc: '2.0', id: 7, error: { code: -32000, message: `${archive} secret` } }) : null,
    payload => payload.id === 'gov24-log-canonical' ? envelope(payload, { number: '0x1000', hash: hash('4') }) : null,
    payload => payload.id === 'gov24-log-chain-after' ? envelope(payload, '0x1') : null,
  ];
  for (const mutate of faults) { const f = await fixture(t, { mutate }); const response = await f.post(request());
    assert([400, 502].includes(response.status)); const text = await response.text(); assert(!text.includes('secret') && !text.includes('protected-key'));
    assert(f.calls.every(call => call.url === archive)); }
});

test('log redirect, transport, timeout and oversized streaming responses fail closed', async t => {
  const mutations = [
    payload => payload.method === 'eth_getLogs' ? new Response('', { status: 302, headers: { location: 'https://bad.invalid' } }) : null,
    payload => { if (payload.method === 'eth_getLogs') throw new Error(`${archive} secret`); return null; },
    payload => payload.method === 'eth_getLogs' ? new Response('x'.repeat(1100), { headers: { 'content-type': 'application/json', 'content-length': '1100' } }) : null,
    payload => payload.method === 'eth_getLogs' ? new Response('x'.repeat(1100), { headers: { 'content-type': 'application/json' } }) : null,
  ];
  for (const mutate of mutations) { const f = await fixture(t, { mutate, handlerOptions: { maxResponseBytes: 1024 } });
    const response = await f.post(request()); assert.equal(response.status, 502); assert(!JSON.stringify(await response.json()).includes('protected-key')); }
  const handler = createGovernance24ScheduledLogs({ rpcUrl: archive, reviewAnchorBlock: 100, timeoutMs: 10,
    fetcher: async (_, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) });
  await assert.rejects(handler(request(), { socket: { remoteAddress: '192.0.2.1' } }), error => error.status === 504);
});

test('scoped log concurrency has a fixed bound and does not queue unbounded archive work', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const handler = createGovernance24ScheduledLogs({ rpcUrl: archive, reviewAnchorBlock: 100, maxConcurrent: 1, archiveReadStartIntervalMs: 1,
    fetcher: async (_, options) => { const payload = JSON.parse(options.body); await gate;
      return envelope(payload, payload.method === 'eth_chainId' ? '0x38'
        : payload.method === 'eth_getLogs' ? [] : { number: '0x1000', hash: blockHash }); } });
  const req = { socket: { remoteAddress: '192.0.2.1' } }, first = handler(request(), req);
  await assert.rejects(handler(request(), req), error => error.status === 503); release(); await first;
  assert.deepEqual(await handler(request(), req), { jsonrpc: '2.0', id: 7, result: [] });
});

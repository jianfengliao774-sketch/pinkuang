import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { Interface, ZeroAddress, toQuantity } from 'ethers';
import { serverConfiguration, startChainIndex } from './server.mjs';

const config = rpc => ({ rpc, host: '127.0.0.1', port: 0, dbPath: ':memory:',
  factory: '0x0000000000000000000000000000000000000001',
  market: '0x0000000000000000000000000000000000000002', startBlock: 1, confirmations: 2 });
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function stop(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

test('production configuration keeps HTTPS and loopback requirements', () => {
  const env = { CHAIN_INDEX_RPC_URL: 'https://bsc-rpc.blockreq.com/v1/rpc/public',
    CHAIN_INDEX_DB: '/tmp/index.sqlite', CHAIN_INDEX_FACTORY: config('').factory,
    CHAIN_INDEX_MARKET: config('').market, CHAIN_INDEX_START_BLOCK: '100' };
  assert.equal(serverConfiguration(env).rpc, env.CHAIN_INDEX_RPC_URL);
  assert.equal(serverConfiguration(env).host, '127.0.0.1');
  assert.equal(serverConfiguration(env).scanRange, 100);
  assert.equal(serverConfiguration(env).logsTimeoutMs, 12_000);
  for (const timeout of ['12000', '15000', '30000'])
    assert.equal(serverConfiguration({ ...env, CHAIN_INDEX_LOGS_TIMEOUT_MS: timeout }).logsTimeoutMs, Number(timeout));
  for (const timeout of ['', '11999', '30001', '-1', '12000.5', ' 12000', '012000', '3e4', 'Infinity', '9007199254740992'])
    assert.throws(() => serverConfiguration({ ...env, CHAIN_INDEX_LOGS_TIMEOUT_MS: timeout }), /logs timeout|Logs timeout/);
  for (const scanRange of ['1', '50', '500'])
    assert.equal(serverConfiguration({ ...env, CHAIN_INDEX_SCAN_RANGE: scanRange }).scanRange, Number(scanRange));
  for (const scanRange of ['', '0', '501', '-1', '1.5', '50abc', ' 50', '050', '1e2', '9007199254740992'])
    assert.throws(() => serverConfiguration({ ...env, CHAIN_INDEX_SCAN_RANGE: scanRange }), /scan range|Scan range/);
  assert.equal(serverConfiguration({ ...env, CHAIN_INDEX_LOGS_RPC_URL: 'https://public.1rpc.io/bnb' }).logsRpc, 'https://public.1rpc.io/bnb');
  assert.throws(() => serverConfiguration({ ...env, CHAIN_INDEX_RPC_URL: 'http://untrusted.example' }), /HTTPS/);
  assert.throws(() => serverConfiguration({ ...env, CHAIN_INDEX_HOST: '0.0.0.0' }), /loopback/);
  assert.throws(() => serverConfiguration({ ...env, CHAIN_INDEX_LOGS_RPC_URL: 'http://untrusted.example' }), /HTTPS/);
});

const binding = new Interface(['function shareMarket() view returns(address)', 'function factory() view returns(address)',
  'function poolCount() view returns(uint256)', 'function nextOrderId() view returns(uint256)']);
const hex = number => `0x${number.toString(16).padStart(64, '0')}`;
function rpcFixture({ logs = false, logsFailure = false, chainId = '0x38', firstLogsDelayMs = 0 } = {}) {
  const calls = [];
  let delayed = false;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    const input = JSON.parse(body), list = Array.isArray(input) ? input : [input];
    const replies = list.map(payload => {
      calls.push({ ...payload, at: performance.now() }); let result;
      if (payload.method === 'eth_chainId') result = chainId;
      else if (payload.method === 'eth_getLogs') {
        assert(logs, 'logs must never reach the header RPC'); result = [];
      } else {
        assert.equal(logs, false, 'header/call/code request reached the logs-only RPC');
        if (payload.method === 'eth_getBlockByNumber') {
          const number = payload.params[0] === 'latest' ? 4 : Number(BigInt(payload.params[0]));
          result = { number: toQuantity(number), hash: hex(number), parentHash: hex(number - 1),
            timestamp: toQuantity(1_800_000_000 + number), nonce: '0x0000000000000000', difficulty: '0x0',
            gasLimit: '0x1c9c380', gasUsed: '0x0', extraData: '0x', miner: ZeroAddress, transactions: [] };
        } else if (payload.method === 'eth_getCode') result = '0x6001';
        else if (payload.method === 'eth_call') {
          const parsed = binding.parseTransaction(payload.params[0]);
          const value = parsed.name === 'shareMarket' ? config('').market : parsed.name === 'factory' ? config('').factory
            : parsed.name === 'poolCount' ? 0n : 1n;
          result = binding.encodeFunctionResult(parsed.fragment, [value]);
        } else throw new Error(`Unexpected method ${payload.method}`);
      }
      return { jsonrpc: '2.0', id: payload.id, result };
    });
    if (firstLogsDelayMs && !delayed && list.some(payload => payload.method === 'eth_getLogs')) {
      delayed = true;
      await new Promise(resolve => setTimeout(resolve, firstLogsDelayMs));
    }
    if (logsFailure && list.some(payload => payload.method === 'eth_getLogs')) {
      response.writeHead(429, { 'Retry-After': '90' }); response.end('rate limited');
    } else { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(Array.isArray(input) ? replies : replies[0])); }
  });
  return { server, calls };
}
async function until(check, ms = 2_000) {
  const deadline = performance.now() + ms;
  while (!check()) { assert(performance.now() < deadline, 'condition did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('separate RPC routes headers/calls to primary and only logs to its verified logs endpoint', async () => {
  const primary = rpcFixture(), logs = rpcFixture({ logs: true }); let service;
  try {
    const rpc = await listen(primary.server), logsRpc = await listen(logs.server);
    service = await startChainIndex({ ...config(rpc), logsRpc });
    await until(() => service.index.status().complete);
    assert.equal(service.index.indexedThrough, 2);
    assert(primary.calls.some(row => row.method === 'eth_getBlockByNumber'));
    assert(primary.calls.some(row => row.method === 'eth_call'));
    assert(primary.calls.every(row => row.method !== 'eth_getLogs'));
    assert(logs.calls.some(row => row.method === 'eth_getLogs'));
    assert(logs.calls.every(row => ['eth_chainId', 'eth_getLogs'].includes(row.method)));
    assert(logs.calls.findIndex(row => row.method === 'eth_chainId') < logs.calls.findIndex(row => row.method === 'eth_getLogs'));
  } finally { await service?.close(); await stop(primary.server); await stop(logs.server); }
});

test('an explicitly extended logs deadline accepts a valid response beyond the primary 12-second deadline', { timeout: 20_000 }, async () => {
  const primary = rpcFixture(), logs = rpcFixture({ logs: true, firstLogsDelayMs: 12_500 }); let service;
  try {
    const rpc = await listen(primary.server), logsRpc = await listen(logs.server);
    service = await startChainIndex({ ...config(rpc), logsRpc, logsTimeoutMs: 30_000 });
    await until(() => service.index.status().complete, 17_000);
    assert.equal(service.index.indexedThrough, 2);
    assert.equal(logs.calls.filter(row => row.method === 'eth_getLogs').length, 2, 'one successful scan, no hidden retry');
    assert(primary.calls.every(row => row.method !== 'eth_getLogs'));
  } finally { await service?.close(); await stop(primary.server); await stop(logs.server); }
});

test('logs rate limit remains a failure, backs off instead of retrying each second, and stops cleanly', { timeout: 7_000 }, async () => {
  const primary = rpcFixture(), logs = rpcFixture({ logs: true, logsFailure: true }); let service;
  try {
    const rpc = await listen(primary.server), logsRpc = await listen(logs.server);
    service = await startChainIndex({ ...config(rpc), logsRpc });
    const failures = () => logs.calls.filter(row => row.method === 'eth_getLogs');
    await until(() => service.index.status().unknownReason === 'sync_failed');
    assert.equal(service.index.indexedThrough, 0); assert.equal(service.index.status().complete, false);
    await new Promise(resolve => setTimeout(resolve, 1_200)); assert.equal(failures().length, 2, 'both fixed global reads drain in the failed scan');
    await until(() => failures().length === 4, 4_000);
    assert(failures()[2].at - failures()[0].at >= 4_000);
    await service.close(); const afterClose = primary.calls.length + logs.calls.length;
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(primary.calls.length + logs.calls.length, afterClose);
  } finally { await service?.close(); await stop(primary.server); await stop(logs.server); }
});

test('a logs endpoint on another chain cannot advance the index or return empty success', async () => {
  const primary = rpcFixture(), logs = rpcFixture({ logs: true, chainId: '0x1' }); let service;
  try {
    const rpc = await listen(primary.server), logsRpc = await listen(logs.server);
    service = await startChainIndex({ ...config(rpc), logsRpc });
    await until(() => service.index.status().unknownReason === 'wrong_chain');
    assert.equal(service.index.indexedThrough, 0);
    assert.equal(logs.calls.filter(row => row.method === 'eth_getLogs').length, 0);
  } finally { await service?.close(); await stop(primary.server); await stop(logs.server); }
});

test('primary RPC stays at 12 seconds with an extended same-URL logs deadline and close is idempotent', { timeout: 16_000 }, async () => {
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const upstream = createServer(() => { entered(); });
  let service;
  try {
    const rpc = await listen(upstream); service = await startChainIndex({ ...config(rpc), logsTimeoutMs: 30_000 });
    await started;
    const begin = performance.now(); const closing = service.close();
    assert.equal(service.close(), closing, 'simultaneous shutdown requests share one completion');
    await closing;
    assert(performance.now() - begin < 14_000, 'shutdown must not retain a multi-minute HTTP request');
  } finally { await service?.close(); await stop(upstream); }
});

test('HTTP 429 Retry-After cannot trap the index in a hidden long retry or advance data', { timeout: 5_000 }, async () => {
  let entered, requests = 0; const started = new Promise(resolve => { entered = resolve; });
  const upstream = createServer((_request, response) => {
    requests++; response.writeHead(429, { 'Retry-After': '90', 'content-type': 'application/json' });
    response.end('{"error":"rate limited"}'); entered();
  });
  let service;
  try {
    const rpc = await listen(upstream); service = await startChainIndex(config(rpc));
    await started; const begin = performance.now(); await service.close();
    assert(performance.now() - begin < 2_000, 'Retry-After is handled by the sync loop, not an HTTP backoff');
    assert.equal(requests, 1, 'no invisible retry loop after stopping');
  } finally { await service?.close(); await stop(upstream); }
});

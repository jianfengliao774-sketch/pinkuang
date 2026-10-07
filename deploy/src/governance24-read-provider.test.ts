import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as ethers from 'ethers';
// @ts-ignore The isolated server is tested at runtime through its actual HTTP route.
import { createGovernance24ReadServer } from '../server/governance24-read/governance24-read-server.mjs';
// @ts-ignore Canonical scoped event/range validation is owned by the read service.
import { createGovernance24ScheduledLogs, GOVERNANCE24_OLD_TIMELOCK, GOVERNANCE24_CALL_SCHEDULED_TOPIC } from '../server/governance24-read/scheduled-logs.mjs';
const source = readFileSync(new URL('./Governance24UpgradeStandalone.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
const modules: Record<string, unknown> = { ethers, react: {}, 'react/jsx-runtime': { jsx: () => null },
  'react-dom/client': { createRoot: () => ({ render: () => {} }) },
  '../shared/governance24-upgrade-plan.mjs': {}, '../shared/governance24-upgrade-proof.mjs': {},
  './wallet': {}, './upgrade-transactions': {}, './governance24-upgrade-ui': {}, './target-owner-upgrade.css': {} };
const exports: any = {};
new Function('require', 'exports', '__GOVERNANCE24_RELEASE__', 'document', compiled)(
  (id: string) => { assert(id in modules); return modules[id]; }, exports, {}, { getElementById: () => ({}) });
const create: (url: string, signal?: AbortSignal, deadline?: number) => ethers.JsonRpcProvider = exports.createGovernance24ReadProvider;
type Request = { body: string; payload: ethers.JsonRpcPayload };
async function fixture(answer: (request: Request, index: number, response: http.ServerResponse) => Promise<void> | void) {
  const requests: Request[] = [];
  const server = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const observed = { body, payload: JSON.parse(body) }; requests.push(observed);
    await answer(observed, requests.length, response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const providers: ethers.JsonRpcProvider[] = [];
  return { requests, provider: (signal?: AbortSignal, deadline?: number) => {
    const provider = create(`http://127.0.0.1:${port}`, signal, deadline); providers.push(provider); return provider;
  }, close: async () => { providers.forEach(provider => provider.destroy()); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const result = (response: http.ServerResponse, request: Request, value: unknown) => response.writeHead(200,
  { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: request.payload.id, result: value }));
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
test('actual UI provider.getLogs reaches the actual scoped service with exact numeric CallScheduled filters', async () => {
  const anchor = 126156767, fromBlock = anchor + 1, toBlock = fromBlock + 2047;
  const blockHash = `0x${'22'.repeat(32)}`, transactionHash = `0x${'33'.repeat(32)}`;
  const log = { address: GOVERNANCE24_OLD_TIMELOCK, topics: [GOVERNANCE24_CALL_SCHEDULED_TOPIC, `0x${'11'.repeat(32)}`, ethers.ZeroHash],
    data: '0x', blockNumber: ethers.toQuantity(fromBlock), blockHash, transactionHash, transactionIndex: '0x0', logIndex: '0x0', removed: false };
  const observed: ethers.JsonRpcPayload[] = [], archiveRequests: ethers.JsonRpcPayload[] = [];
  const handler = createGovernance24ScheduledLogs({ rpcUrl: 'https://dummy-archive.invalid/read', reviewAnchorBlock: anchor,
    archiveReadStartIntervalMs: 1, fetcher: async (_url: string, options: any) => {
      const payload = JSON.parse(options.body); archiveRequests.push(payload);
      const value = payload.method === 'eth_chainId' ? '0x38' : payload.method === 'eth_getLogs' ? [log]
        : { number: ethers.toQuantity(toBlock), hash: blockHash };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: value }), { headers: { 'content-type': 'application/json' } });
    } });
  const server = createGovernance24ReadServer({ handle: async (_req: unknown, response: http.ServerResponse) => {
    response.writeHead(403).end('No extra methods in this fixture');
  } }, async (payload: ethers.JsonRpcPayload, req: unknown) => { observed.push(payload); return handler(payload, req); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = create(`http://127.0.0.1:${server.address().port}/api/rpc`);
  try {
    const filter = { address: GOVERNANCE24_OLD_TIMELOCK, topics: [GOVERNANCE24_CALL_SCHEDULED_TOPIC], fromBlock, toBlock };
    const logs = await provider.getLogs(filter); assert.equal(logs.length, 1);
    assert.equal(logs[0].blockNumber, fromBlock); assert.equal(logs[0].transactionHash, transactionHash);
    assert.deepEqual(observed[0].params, [{ address: GOVERNANCE24_OLD_TIMELOCK, topics: filter.topics,
      fromBlock: ethers.toQuantity(fromBlock), toBlock: ethers.toQuantity(toBlock) }]);
    assert.deepEqual(archiveRequests.find(item => item.method === 'eth_getLogs')!.params, observed[0].params);
    await provider.getLogs(filter); assert.equal(observed.length, 2, 'independent log proofs are not cached');
    const before = archiveRequests.length;
    await assert.rejects(provider.getLogs({ ...filter, topics: [ethers.ZeroHash] }));
    assert.equal(archiveRequests.length, before, 'other log events fail at the scoped route before archive work');
  } finally { provider.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(resolve)); }
});
test('actual portal provider recovers one 502 after partial success with an identical body; headers remain independent reads', async () => {
  const f = await fixture((request, index, response) => {
    if (index === 2) response.writeHead(502).end('temporary read epoch reset');
    else result(response, request, request.payload.method === 'eth_chainId' ? '0x38' : index === 3 ? '0x01' : '0x02');
  });
  try {
    const p = f.provider(); assert.equal(await p.send('eth_chainId', []), '0x38');
    const params = [{ to: '0x' + '11'.repeat(20), data: '0x12345678' }, '0x500'];
    assert.equal(await p.send('eth_call', params), '0x01');
    assert.equal(f.requests[1].body, f.requests[2].body); assert.equal(f.requests.length, 3);
    assert.equal(await p.send('eth_getBlockByNumber', ['0x500', false]), '0x02');
    assert.equal(await p.send('eth_getBlockByNumber', ['0x500', false]), '0x02');
    assert.equal(f.requests.filter(row => row.payload.method === 'eth_getBlockByNumber').length, 2);
  } finally { await f.close(); }
});
for (const status of [429, 502, 503]) test(`HTTP ${status} gets at most one exact pure-read retry`, async () => {
  const f = await fixture((_request, _index, response) => { response.writeHead(status).end('temporary'); });
  try { await assert.rejects(f.provider().send('eth_chainId', [])); assert.equal(f.requests.length, 2);
    assert.equal(f.requests[0].body, f.requests[1].body); }
  finally { await f.close(); }
});
for (const kind of ['403', 'rpc-revert', 'malformed']) test(`${kind} is never retried`, async () => {
  const f = await fixture((request, _index, response) => {
    if (kind === '403') response.writeHead(403).end('forbidden');
    else if (kind === 'malformed') response.writeHead(200, { 'content-type': 'application/json' }).end('{bad json');
    else response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0',
      id: request.payload.id, error: { code: 3, message: 'execution reverted', data: '0x' } }));
  });
  try { await assert.rejects(f.provider().send('eth_call', [{ to: '0x' + '11'.repeat(20), data: '0x12345678' }, '0x500']));
    assert.equal(f.requests.length, 1); } finally { await f.close(); }
});
for (const status of [429, 502, 503]) test(`JSON-RPC contract error under HTTP ${status} is never retried`, async () => {
  const f = await fixture((request, _index, response) => { response.writeHead(status, { 'content-type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', id: request.payload.id,
      error: { code: 3, message: 'execution reverted', data: '0x' } })); });
  try { await assert.rejects(f.provider().send('eth_call', [{ to: '0x' + '11'.repeat(20), data: '0x12345678' }, '0x500']));
    assert.equal(f.requests.length, 1); } finally { await f.close(); }
});
test('ordinary proxy error strings still recover once, while invalid RPC-shaped responses never retry', async () => {
  for (const body of [JSON.stringify({ error: 'Read-only RPC chain changed temporarily.' }),
    JSON.stringify({ jsonrpc: '2.0', id: 'incorrect-id', result: '0x38' }), '{"jsonrpc":', '{bad json',
    JSON.stringify({ error: { code: -32603, message: 'invalid RPC response' } })]) {
    const f = await fixture((request, index, response) => { if (index === 1)
      response.writeHead(502, { 'content-type': 'application/json' }).end(body);
      else result(response, request, '0x38'); });
    try {
      const provider = f.provider();
      if (body.includes('chain changed')) { assert.equal(await provider.send('eth_chainId', []), '0x38');
        assert.equal(f.requests.length, 2); assert.equal(f.requests[0].body, f.requests[1].body); }
      else { await assert.rejects(provider.send('eth_chainId', [])); assert.equal(f.requests.length, 1); }
    } finally { await f.close(); }
  }
});
test('second attempt shares the first attempt total deadline rather than receiving a fresh timeout', async () => {
  const f = await fixture(async (request, index, response) => {
    await delay(index === 1 ? 120 : 240);
    if (index === 1) response.writeHead(502).end('temporary'); else result(response, request, '0x38');
  });
  try {
    const start = Date.now(); await assert.rejects(f.provider(undefined, 300).send('eth_chainId', []));
    assert(Date.now() - start < 440, 'two HTTP attempts must not add their separate deadlines');
    assert.equal(f.requests.length, 2);
  } finally { await f.close(); }
});
for (const mode of ['destroy', 'abort']) test(`${mode} cancels a live HTTP read without retrying`, async () => {
  let received!: () => void; const ready = new Promise<void>(resolve => { received = resolve; });
  const f = await fixture(() => { received(); });
  try {
    const controller = new AbortController(), provider = f.provider(controller.signal);
    const rejected = assert.rejects(provider.send('eth_chainId', [])); await ready;
    const start = Date.now(); if (mode === 'destroy') provider.destroy(); else controller.abort();
    await rejected; assert(Date.now() - start < 500); assert.equal(f.requests.length, 1);
    await assert.rejects(provider.send('eth_chainId', [])); assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});
test('abort during retry backoff stops before another HTTP request, including a preaborted signal', async () => {
  let received!: () => void; const ready = new Promise<void>(resolve => { received = resolve; });
  const f = await fixture((_request, _index, response) => { response.writeHead(502).end('temporary'); received(); });
  try {
    const controller = new AbortController(), provider = f.provider(controller.signal);
    const rejected = assert.rejects(provider.send('eth_chainId', [])); await ready; await delay(25); controller.abort();
    await rejected; await delay(120); assert.equal(f.requests.length, 1);
    const preaborted = new AbortController(); preaborted.abort();
    await assert.rejects(f.provider(preaborted.signal).send('eth_chainId', [])); assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});
test('wallet mutations and unknown methods never reach the public transport', async () => {
  const f = await fixture((request, _index, response) => { result(response, request, '0x38'); });
  try { const provider = f.provider();
    for (const method of ['eth_sendTransaction', 'eth_sendRawTransaction', 'personal_sign', 'eth_signTypedData_v4', 'unknown'])
      await assert.rejects(provider.send(method, []));
    assert.equal(f.requests.length, 0); assert.throws(() => f.provider(undefined, 15001), /deadline/);
    assert(source.includes('provider = rpc(controller.signal)'));
    assert(source.includes('timeout = 60000')); // Other session reads retain their existing boundary.
    assert(source.includes('GOVERNANCE24_PREFLIGHT_TIMEOUT_MS = 10 * 60 * 1000'));
    assert.equal((source.match(/preflight\(provider, [^\n]+GOVERNANCE24_PREFLIGHT_TIMEOUT_MS/g) ?? []).length, 3);
  } finally { await f.close(); }
});

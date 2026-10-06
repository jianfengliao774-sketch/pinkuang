import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as ethers from 'ethers';
const source = readFileSync(new URL('./FirstoBatchUpgradeStandalone.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
const modules: Record<string, unknown> = { ethers, react: {}, 'react/jsx-runtime': { jsx: () => null },
  'react-dom/client': { createRoot: () => ({ render: () => {} }) },
  '../shared/firsto-batch-upgrade-plan.mjs': {}, '../shared/firsto-batch-upgrade-proof.mjs': {},
  './wallet': {}, './upgrade-transactions': {}, './firsto-batch-upgrade-ui': {}, './target-owner-upgrade.css': {} };
const exports: any = {};
new Function('require', 'exports', '__FIRSTO_BATCH_RELEASE__', 'document', compiled)(
  (id: string) => { assert(id in modules); return modules[id]; }, exports, {}, { getElementById: () => ({}) });
const create: (url: string, signal?: AbortSignal, deadline?: number) => ethers.JsonRpcProvider = exports.createFirstoBatchReadProvider;
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
    assert(source.includes('timeout = 60000')); // The session/wallet flow retains its existing boundary.
  } finally { await f.close(); }
});

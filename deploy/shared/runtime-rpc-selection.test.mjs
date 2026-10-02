import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { FetchRequest } from 'ethers';
import { createDeferredRuntimeRpcProvider, createRuntimeRpcProvider, selectRuntimeRpcRequest } from './runtime-rpc-selection.mjs';

async function pair(primaryReply, backupReply = () => ({ result: '0x38' })) {
  const calls = { primary: [], backup: [] }, servers = [];
  const start = async (name, reply) => {
    const server = createServer(async (req, res) => {
      const chunks = []; for await (const value of req) chunks.push(value);
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      const rows = Array.isArray(payload) ? payload : [payload]; calls[name].push(...rows);
      const response = reply(rows[0], calls[name]);
      if (response.http) { res.writeHead(response.http, { 'Content-Type': 'text/html' }); res.end(response.body ?? 'unavailable'); return; }
      if (response.html) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>temporarily unavailable</html>'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const values = rows.map(row => ({ jsonrpc: '2.0', id: row.id, ...response }));
      res.end(JSON.stringify(Array.isArray(payload) ? values : values[0]));
    });
    servers.push(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const primary = await start('primary', primaryReply), backup = await start('backup', backupReply);
  const request = new FetchRequest(primary); request.timeout = 1000;
  return { primary, backup, calls, request, env: { CHAIN_INDEX_LOGS_RPC_URL: backup },
    close: async () => { for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } } };
}
const options = f => ({ env: f.env, network: 56, providerOptions: { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 } });

test('a healthy configured primary is selected once and a later send failure never activates backup', async () => {
  const f = await pair(row => row.method === 'eth_sendRawTransaction' ? { http: 503 }
    : { result: row.method === 'eth_chainId' ? '0x38' : '0x1234' }); let provider;
  try {
    provider = await createRuntimeRpcProvider(f.request, options(f));
    assert.equal(await provider.send('eth_call', [{ to: '0x' + '1'.repeat(40), data: '0x' }, 'latest']), '0x1234');
    await assert.rejects(provider.send('eth_sendRawTransaction', ['0x00']));
    assert.deepEqual(f.calls.primary.map(row => row.method), ['eth_chainId', 'eth_call', 'eth_sendRawTransaction']);
    assert.equal(f.calls.backup.length, 0);
  } finally { provider?.destroy(); await f.close(); }
});

test('startup HTML403 selects the configured BSC backup and fixes both read and write transport for the process', async () => {
  const f = await pair(() => ({ http: 403 }), row => row.method === 'eth_sendRawTransaction' ? { http: 503 }
    : { result: row.method === 'eth_chainId' ? '0x38' : '0x1234' }); let provider;
  try {
    provider = await createRuntimeRpcProvider(f.request, options(f));
    assert.equal(await provider.send('eth_call', [{ to: '0x' + '1'.repeat(40), data: '0x' }, 'latest']), '0x1234');
    await assert.rejects(provider.send('eth_sendRawTransaction', ['0x00']));
    assert.deepEqual(f.calls.primary.map(row => row.method), ['eth_chainId']);
    assert.deepEqual(f.calls.backup.map(row => row.method), ['eth_chainId', 'eth_call', 'eth_sendRawTransaction']);
  } finally { provider?.destroy(); await f.close(); }
});

test('wrong-chain, JSON-RPC business error and invalid identity cannot be hidden by the healthy backup', async () => {
  for (const response of [{ result: '0x1' }, { error: { code: -32000, message: 'execution reverted' } },
    { result: '0x38', id: 999 }, { result: 56 }]) {
    const f = await pair(() => response);
    try { await assert.rejects(selectRuntimeRpcRequest(f.request, { env: f.env }));
      assert.equal(f.calls.primary.length, 1); assert.equal(f.calls.backup.length, 0); }
    finally { await f.close(); }
  }
});

test('a non-JSON primary can select a BSC backup, but a wrong-chain or failing backup fails closed without another attempt', async () => {
  for (const backup of [{ result: '0x38' }, { result: '0x1' }, { http: 502 }]) {
    const f = await pair(() => ({ html: true }), () => backup);
    try {
      const selected = selectRuntimeRpcRequest(f.request, { env: f.env });
      if (backup.result === '0x38') { const result = await selected; assert.equal(result.source, 'configured-fallback'); assert.equal(result.request.url, new URL(f.backup).href); }
      else await assert.rejects(selected);
      assert.equal(f.calls.primary.length, 1); assert.equal(f.calls.backup.length, 1);
    } finally { await f.close(); }
  }
});

test('sync relay construction starts one sticky selection before its first read and never reselects after failure', async () => {
  const f = await pair(() => ({ http: 403 }), () => ({ http: 502 }));
  const provider = createDeferredRuntimeRpcProvider(f.request, options(f));
  try {
    await assert.rejects(provider.ready());
    await assert.rejects(provider.send('eth_chainId', []));
    await assert.rejects(provider.send('eth_sendRawTransaction', ['0x00']));
    assert.equal(f.calls.primary.length, 1); assert.equal(f.calls.backup.length, 1);
  } finally { provider.destroy(); await f.close(); }
});

test('the sync relay provider uses its single selected transport for every subsequent operation', async () => {
  const f = await pair(() => ({ http: 403 }), row => ({ result: row.method === 'eth_chainId' ? '0x38' : '0x1234' }));
  const provider = createDeferredRuntimeRpcProvider(f.request, options(f));
  try { await provider.ready(); assert.equal(await provider.send('eth_call', [{}, 'latest']), '0x1234');
    assert.deepEqual(f.calls.primary.map(row => row.method), ['eth_chainId']);
    assert.deepEqual(f.calls.backup.map(row => row.method), ['eth_chainId', 'eth_call']); }
  finally { provider.destroy(); await f.close(); }
});

test('an identical backup URL cannot cause a duplicate startup attempt', async () => {
  const f = await pair(() => ({ http: 403 }));
  try { await assert.rejects(selectRuntimeRpcRequest(f.request, { env: { CHAIN_INDEX_LOGS_RPC_URL: f.primary } }));
    assert.equal(f.calls.primary.length, 1); assert.equal(f.calls.backup.length, 0); }
  finally { await f.close(); }
});

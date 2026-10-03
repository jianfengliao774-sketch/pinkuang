import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { FetchRequest } from 'ethers';
import { createDeferredRuntimeRpcProvider, createRuntimeRpcProvider, selectRuntimeRpcRequest } from './runtime-rpc-selection.mjs';

async function pair(primaryReply, backupReply = () => ({ result: '0x38' })) {
  const calls = { primary: [], backup: [] }, batchSizes = { primary: [], backup: [] }, servers = [];
  const start = async (name, reply) => {
    const server = createServer(async (req, res) => {
      const chunks = []; for await (const value of req) chunks.push(value);
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      const rows = Array.isArray(payload) ? payload : [payload]; calls[name].push(...rows);
      batchSizes[name].push(rows.length);
      const response = reply(rows[0], calls[name]);
      if (response.http) { res.writeHead(response.http, { 'Content-Type': 'text/html' }); res.end(response.body ?? 'unavailable'); return; }
      if (response.html) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>temporarily unavailable</html>'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const values = rows.map((row, index) => ({ jsonrpc: '2.0', id: row.id,
        ...(index === 0 ? response : reply(row, calls[name])) }));
      res.end(JSON.stringify(Array.isArray(payload) ? values : values[0]));
    });
    servers.push(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const primary = await start('primary', primaryReply), backup = await start('backup', backupReply);
  const request = new FetchRequest(primary); request.timeout = 1000;
  return { primary, backup, calls, batchSizes, request, env: { CHAIN_INDEX_LOGS_RPC_URL: backup },
    close: async () => { for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } } };
}
const options = f => ({ env: f.env, network: 56, providerOptions: { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 } });

test('worker defaults retain batching in bounded four-read groups while an explicit single-request option remains single', async () => {
  for (const single of [false, true]) {
    const f = await pair(row => ({ result: row.method === 'eth_chainId' ? '0x38' : '0x1234' }));
    let provider;
    try {
      provider = await createRuntimeRpcProvider(f.request, { env: f.env, network: 56,
        ...(single ? { providerOptions: { batchMaxCount: 1 } } : {}) });
      // Finish Ethers network initialization before measuring business reads.
      await provider.send('eth_chainId', []);
      f.calls.primary.length = 0; f.batchSizes.primary.length = 0;
      const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
        provider.send('eth_call', [{ to: '0x' + '1'.repeat(40), data: `0x${index.toString(16).padStart(2, '0')}` }, 'latest'])));
      assert.deepEqual(results, Array(8).fill('0x1234'));
      assert.equal(f.calls.primary.length, 8);
      assert.deepEqual(f.batchSizes.primary, single ? Array(8).fill(1) : [4, 4]);
      assert.equal(f.calls.backup.length, 0);
    } finally { provider?.destroy(); await f.close(); }
  }
});

const rpc = (id, method = 'eth_call') => ({ jsonrpc: '2.0', id, method,
  params: method === 'eth_call' ? [{ to: '0x' + '1'.repeat(40), data: '0x' }, 'latest'] : ['0x00'] });
const quota = { code: -32005, message: 'Your account has exceeded its Compute Units Per Second capacity.' };

test('HTTP429 read recovery stays on the selected node and has at most three attempts', async () => {
  for (const succeeds of [true, false]) {
    const f = await pair((row, calls) => row.method === 'eth_chainId' ? { result: '0x38' }
      : succeeds && calls.filter(value => value.method === 'eth_call').length === 3 ? { result: '0x1234' } : { http: 429 });
    const delays = [], provider = await createRuntimeRpcProvider(f.request, { ...options(f), retryWait: async ms => { delays.push(ms); } });
    try {
      const result = provider._send(rpc(101));
      if (succeeds) assert.equal((await result)[0].result, '0x1234');
      else await assert.rejects(result);
      assert.deepEqual(delays, [1100, 2200]);
      assert.equal(f.calls.primary.filter(row => row.method === 'eth_call').length, 3);
      assert.equal(f.calls.backup.length, 0);
    } finally { provider.destroy(); await f.close(); }
  }
});

test('partial JSON-RPC quota failures retry only affected IDs and retain successes and contract errors', async () => {
  const f = await pair((row, calls) => {
    if (row.method === 'eth_chainId') return { result: '0x38' };
    if (row.id === 102 && calls.filter(value => value.id === 102).length < 2 || row.id === 104) return { error: quota };
    if (row.id === 103) return { error: { code: -32000, message: 'execution reverted' } };
    return { result: '0x1234' };
  });
  const delays = [], provider = await createRuntimeRpcProvider(f.request, { ...options(f), retryWait: async ms => { delays.push(ms); } });
  try {
    const rows = await provider._send([rpc(101), rpc(102), rpc(103), rpc(104), rpc(105)]);
    assert.deepEqual(rows.map(row => row.id), [101, 102, 103, 104, 105]);
    assert.equal(rows[0].result, '0x1234'); assert.equal(rows[1].result, '0x1234');
    assert.equal(rows[2].error.message, 'execution reverted'); assert.deepEqual(rows[3].error, quota);
    assert.equal(rows[4].result, '0x1234');
    assert.deepEqual([101, 102, 103, 104, 105].map(id => f.calls.primary.filter(row => row.id === id).length), [1, 2, 1, 3, 1]);
    assert.deepEqual(f.batchSizes.primary, [1, 4, 2, 1, 1]);
    assert.deepEqual(delays, [1100, 2200]); assert.equal(f.calls.backup.length, 0);
  } finally { provider.destroy(); await f.close(); }
});

test('actual provider sends retain a successful read when its sibling quota retry ends in HTTP429', async () => {
  const f = await pair((row, calls) => {
    if (row.method === 'eth_chainId') return { result: '0x38' };
    if (row.params[0].data === '0x02') return calls.filter(value => value.method === 'eth_call'
      && value.params[0].data === '0x02').length === 1 ? { error: quota } : { http: 429 };
    return { result: '0x1234' };
  });
  const delays = [], provider = await createRuntimeRpcProvider(f.request, { env: f.env, network: 56,
    providerOptions: { staticNetwork: true }, retryWait: async ms => { delays.push(ms); } });
  try {
    await provider.send('eth_chainId', []); f.calls.primary.length = 0; f.batchSizes.primary.length = 0;
    const settled = await Promise.allSettled(['0x01', '0x02'].map(data =>
      provider.send('eth_call', [{ to: '0x' + '1'.repeat(40), data }, 'latest'])));
    assert.deepEqual(settled.map(row => row.status), ['fulfilled', 'rejected']);
    assert.equal(settled[0].value, '0x1234');
    assert.match(JSON.stringify(settled[1].reason), /Compute Units Per Second/);
    assert.deepEqual(f.calls.primary.filter(row => row.method === 'eth_call').map(row => row.params[0].data),
      ['0x01', '0x02', '0x02', '0x02']);
    assert.deepEqual(delays, [1100, 2200]); assert.equal(f.calls.backup.length, 0);
  } finally { provider.destroy(); await f.close(); }
});

test('actual provider sends retain earlier group results and explicitly fail unreceived IDs after a later transport error', async () => {
  const f = await pair(row => row.method === 'eth_chainId' ? { result: '0x38' }
    : Number.parseInt(row.params[0].data.slice(2), 16) >= 4 ? { http: 503 } : { result: '0x1234' });
  const delays = [], provider = await createRuntimeRpcProvider(f.request, { env: f.env, network: 56,
    providerOptions: { staticNetwork: true }, retryWait: async ms => { delays.push(ms); } });
  try {
    await provider.send('eth_chainId', []); f.calls.primary.length = 0; f.batchSizes.primary.length = 0;
    const settled = await Promise.allSettled(Array.from({ length: 9 }, (_, index) =>
      provider.send('eth_call', [{ to: '0x' + '1'.repeat(40), data: `0x0${index}` }, 'latest'])));
    assert.deepEqual(settled.map(row => row.status), [...Array(4).fill('fulfilled'), ...Array(5).fill('rejected')]);
    assert.deepEqual(settled.slice(0, 4).map(row => row.value), Array(4).fill('0x1234'));
    for (const row of settled.slice(4)) {
      const error = JSON.stringify(row.reason);
      assert.match(error, /Runtime RPC read transport failed/);
      assert.equal(error.includes(f.primary), false); assert.equal(error.includes(f.backup), false);
    }
    assert.deepEqual(f.batchSizes.primary, [4, 4]);
    assert.deepEqual(delays, []); assert.equal(f.calls.backup.length, 0);
  } finally { provider.destroy(); await f.close(); }
});

test('other -32005 messages, mixed batches, sends, signing and unknown methods never retry', async () => {
  const cases = [
    { payload: rpc(101), response: { error: { code: -32005, message: 'Query exceeds the allowed block range.' } }, rejects: false },
    { payload: [rpc(101), rpc(102, 'eth_sendRawTransaction')], response: { http: 429 }, rejects: true },
    { payload: rpc(101, 'eth_sendRawTransaction'), response: { http: 429 }, rejects: true },
    { payload: rpc(101, 'personal_sign'), response: { error: quota }, rejects: false },
    { payload: rpc(101, 'debug_traceCall'), response: { http: 429 }, rejects: true },
  ];
  for (const value of cases) {
    const f = await pair(row => row.method === 'eth_chainId' ? { result: '0x38' } : value.response);
    const delays = [], provider = await createRuntimeRpcProvider(f.request, { ...options(f), retryWait: async ms => { delays.push(ms); } });
    try {
      const result = provider._send(value.payload);
      if (value.rejects) await assert.rejects(result); else assert.ok((await result)[0].error);
      assert.deepEqual(f.batchSizes.primary, [1, Array.isArray(value.payload) ? 2 : 1]);
      assert.deepEqual(delays, []); assert.equal(f.calls.backup.length, 0);
    } finally { provider.destroy(); await f.close(); }
  }
});

test('mismatched quota response IDs cannot cause a retry', async () => {
  const f = await pair(row => row.method === 'eth_chainId' ? { result: '0x38' } : { id: 999, error: quota });
  const delays = [], provider = await createRuntimeRpcProvider(f.request, { ...options(f), retryWait: async ms => { delays.push(ms); } });
  try { await assert.rejects(provider._send(rpc(101)), /does not match/);
    assert.deepEqual(delays, []); assert.deepEqual(f.batchSizes.primary, [1, 1]); assert.equal(f.calls.backup.length, 0); }
  finally { provider.destroy(); await f.close(); }
});

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

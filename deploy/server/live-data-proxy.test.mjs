import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveDataProxy, liveDataProxyConfiguration, validateReadRpc, FEES_CLAIMED_TOPIC } from './live-data-proxy.mjs';
import { createDeploymentServer } from './index.mjs';

const address = `0x${'11'.repeat(20)}`;
const transactionHash = `0x${'ab'.repeat(32)}`;
const rpc = (method = 'eth_chainId', params = []) => ({ jsonrpc: '2.0', id: 1, method, params });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const feeHistoryLogScope = { authority: address, deploymentBlock: 10 };
const feeLogs = () => rpc('eth_getLogs', [{ address, topics: [FEES_CLAIMED_TOPIC], fromBlock: '0xa', toBlock: '0x1389' }]);
const feeAnchor = tag => ({ number: tag, hash: transactionHash, timestamp: '0xa' });
async function fixture(t, options = {}) {
  const calls = [];
  const liveDataProxy = createLiveDataProxy({ rpcUrl: 'https://operator-rpc.test/key', indexUrl: 'http://127.0.0.1:4180',
    fetcher: async (url, init) => { calls.push({ url, init }); return options.upstream ? options.upstream(url, init)
      : json(init.method === 'POST' ? { jsonrpc: '2.0', id: JSON.parse(init.body).id, result: '0x38' } : { source: { complete: true }, data: { items: [] } }); }, ...options });
  const server = createDeploymentServer({ liveDataProxy, journalService: { handle(req, res) { res.end('journal-ok'); } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { calls, base, get: path => fetch(`${base}${path}`), post: (payload, path = '/api/rpc', extra = {}) => fetch(`${base}${path}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), ...extra }) };
}

test('configuration uses only fixed operator destinations and existing journal RPC fallback', () => {
  assert.deepEqual(liveDataProxyConfiguration({}), { rpcUrl: null, logsRpcUrl: null, fallbackRpcUrl: null, indexUrl: 'http://127.0.0.1:4180/' });
  assert.equal(liveDataProxyConfiguration({ DEPLOYMENT_JOURNAL_RPC_URL: 'https://bsc.example/rpc' }).rpcUrl, 'https://bsc.example/rpc');
  assert.equal(liveDataProxyConfiguration({ BEMINE_READ_RPC_URL: 'https://a.test', DEPLOYMENT_JOURNAL_RPC_URL: 'https://b.test' }).rpcUrl, 'https://a.test/');
  assert.equal(liveDataProxyConfiguration({ BEMINE_READ_RPC_URL: 'https://a.test' }).logsRpcUrl, 'https://a.test/');
  assert.equal(liveDataProxyConfiguration({ BEMINE_READ_RPC_URL: 'https://a.test', CHAIN_INDEX_LOGS_RPC_URL: 'https://logs.test/rpc?key=fixed' }).logsRpcUrl,
    'https://logs.test/rpc?key=fixed');
  assert.equal(liveDataProxyConfiguration({ BEMINE_READ_RPC_URL: 'https://a.test', CHAIN_INDEX_LOGS_RPC_URL: 'https://logs.test/rpc?key=fixed' }).fallbackRpcUrl,
    'https://logs.test/rpc?key=fixed');
  assert.equal(liveDataProxyConfiguration({ BEMINE_READ_RPC_URL: 'https://a.test', CHAIN_INDEX_LOGS_RPC_URL: 'https://a.test/' }).fallbackRpcUrl, null);
  assert.equal(liveDataProxyConfiguration({ BEMINE_READ_RPC_URL: 'https://a.test', BEMINE_READ_FALLBACK_RPC_URL: 'https://backup.test/rpc' }).fallbackRpcUrl,
    'https://backup.test/rpc');
  for (const value of ['file:///etc/passwd', 'https://user:password@rpc.test', 'https://rpc.test/#secret']) assert.throws(() => liveDataProxyConfiguration({ BEMINE_READ_RPC_URL: value }));
  for (const value of ['file:///etc/passwd', 'https://user:password@rpc.test', 'https://rpc.test/#secret']) assert.throws(() => liveDataProxyConfiguration({ CHAIN_INDEX_LOGS_RPC_URL: value }));
  for (const value of ['file:///etc/passwd', 'https://user:password@rpc.test', 'https://rpc.test/#secret']) assert.throws(() => liveDataProxyConfiguration({ BEMINE_READ_FALLBACK_RPC_URL: value }));
  assert.throws(() => liveDataProxyConfiguration({ BEMINE_INDEX_URL: 'http://127.0.0.1:4180?url=http://evil.test' }));
});

const backupRpc = 'https://backup-rpc.test/key';
const htmlGateway = () => new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } });
const latestCall = () => rpc('eth_call', [{ to: address, data: '0xab' }, 'latest']);
const requestsAt = (f, destination) => f.calls.filter(call => call.url === destination).map(call => JSON.parse(call.init.body));

test('healthy latest reads do not contact the configured transport fallback or cache latest answers', async t => {
  const f = await fixture(t, { logsRpcUrl: backupRpc, upstream: (url, init) => {
    assert.notEqual(url, backupRpc);
    const request = JSON.parse(init.body);
    return json({ jsonrpc: '2.0', id: request.id, result: request.method === 'eth_chainId' ? '0x38' : '0x6000' });
  } });
  for (let i = 0; i < 2; i++) {
    const response = await f.post(latestCall());
    assert.deepEqual((await response.json()).result, '0x6000');
    assert.equal(response.headers.get('x-bemine-server-cache'), null);
  }
  assert.deepEqual(f.calls.map(call => JSON.parse(call.init.body).method), ['eth_chainId', 'eth_call', 'eth_call']);
});

test('HTML gateway failures use one backup request and share a BSC proof bounded to five seconds', async t => {
  let clock = 100000;
  const f = await fixture(t, { now: () => clock, logsRpcUrl: backupRpc, upstream: async (url, init) => {
    const request = JSON.parse(init.body);
    if (request.method === 'eth_chainId') {
      await new Promise(resolve => setTimeout(resolve, 5));
      return json({ jsonrpc: '2.0', id: request.id, result: '0x38' });
    }
    return url === backupRpc ? json({ jsonrpc: '2.0', id: request.id, result: '0x1234' }) : htmlGateway();
  } });
  const replies = await Promise.all([f.post(latestCall()), f.post(latestCall()), f.post(latestCall())]);
  for (const reply of replies) { assert.equal(reply.status, 200); assert.equal((await reply.json()).result, '0x1234'); }
  assert.equal(requestsAt(f, backupRpc).filter(request => request.method === 'eth_chainId').length, 1);
  assert.equal(requestsAt(f, backupRpc).filter(request => request.method === 'eth_call').length, 3);
  clock += 4999;
  assert.equal((await f.post(latestCall())).status, 200);
  assert.equal(requestsAt(f, backupRpc).filter(request => request.method === 'eth_chainId').length, 1);
  clock++;
  assert.equal((await f.post(latestCall())).status, 200);
  assert.equal(requestsAt(f, backupRpc).filter(request => request.method === 'eth_chainId').length, 2);
  assert.equal(requestsAt(f, backupRpc).filter(request => request.method === 'eth_call').length, 5);
});

test('HTTP quota and gateway failures without an RPC answer use the same bounded fallback', async t => {
  for (const status of [429, 503]) {
    const f = await fixture(t, { fallbackRpcUrl: backupRpc, upstream: (url, init) => {
      const request = JSON.parse(init.body);
      return json(request.method === 'eth_chainId' ? { jsonrpc: '2.0', id: request.id, result: '0x38' }
        : url === backupRpc ? { jsonrpc: '2.0', id: request.id, result: '0x6000' } : { message: 'Gateway unavailable' },
      url !== backupRpc && request.method !== 'eth_chainId' ? status : 200);
    } });
    assert.equal((await f.post(latestCall())).status, 200);
    assert.deepEqual(requestsAt(f, backupRpc).map(request => request.method), ['eth_chainId', 'eth_call']);
  }
});

test('contract errors and invalid RPC envelopes never switch nodes even with HTTP 500', async t => {
  for (const fault of ['revert', 'http_revert', 'wrong_id', 'http_wrong_id', 'invalid_object']) {
    const f = await fixture(t, { fallbackRpcUrl: backupRpc, upstream: (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.method === 'eth_chainId') return json({ jsonrpc: '2.0', id: request.id, result: '0x38' });
      return json(fault.includes('revert') ? { jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'execution reverted' } }
        : fault === 'invalid_object' ? { answer: '0x6000' } : { jsonrpc: '2.0', id: request.id + 1, result: '0x6000' },
      fault.startsWith('http_') ? 500 : 200);
    } });
    const response = await f.post(latestCall());
    assert.equal(response.status, fault === 'revert' ? 200 : 502);
    if (fault === 'revert') assert.equal((await response.json()).error.message, 'Upstream rejected the read request.');
    assert.equal(requestsAt(f, backupRpc).length, 0, fault);
  }
});

test('wrong-chain answers fail closed on either node and never permit a backup business request', async t => {
  for (const wrongNode of ['primary', 'backup']) {
    const f = await fixture(t, { fallbackRpcUrl: backupRpc, upstream: (url, init) => {
      const request = JSON.parse(init.body);
      if (request.method !== 'eth_chainId') return htmlGateway();
      return json({ jsonrpc: '2.0', id: request.id, result: (url === backupRpc) === (wrongNode === 'backup') ? '0x1' : '0x38' });
    } });
    assert.equal((await f.post(latestCall())).status, 502);
    assert.equal(requestsAt(f, backupRpc).filter(request => request.method === 'eth_call').length, 0);
    assert.equal(requestsAt(f, backupRpc).length, wrongNode === 'primary' ? 0 : 1);
  }
});

test('a failed backup ends the request without cycling back or retrying either data request', async t => {
  const f = await fixture(t, { fallbackRpcUrl: backupRpc, upstream: (_url, init) => {
    const request = JSON.parse(init.body);
    return request.method === 'eth_chainId' ? json({ jsonrpc: '2.0', id: request.id, result: '0x38' }) : htmlGateway();
  } });
  assert.equal((await f.post(latestCall())).status, 502);
  assert.deepEqual(f.calls.map(call => [call.url, JSON.parse(call.init.body).method]), [
    ['https://operator-rpc.test/key', 'eth_chainId'], ['https://operator-rpc.test/key', 'eth_call'],
    [backupRpc, 'eth_chainId'], [backupRpc, 'eth_call']]);
});

test('normalized identical RPC destinations disable transport fallback', async t => {
  const f = await fixture(t, { rpcUrl: 'https://same-rpc.test', fallbackRpcUrl: 'https://same-rpc.test/', upstream: (_url, init) => {
    const request = JSON.parse(init.body);
    return request.method === 'eth_chainId' ? json({ jsonrpc: '2.0', id: request.id, result: '0x38' }) : htmlGateway();
  } });
  assert.equal((await f.post(latestCall())).status, 502);
  assert.deepEqual(f.calls.map(call => JSON.parse(call.init.body).method), ['eth_chainId', 'eth_call']);
});

test('pinned reads, safe/finalized reads and canonical headers retain the primary path on transport errors', async t => {
  const f = await fixture(t, { fallbackRpcUrl: backupRpc, upstream: (_url, init) => {
    const request = JSON.parse(init.body);
    return request.method === 'eth_chainId' ? json({ jsonrpc: '2.0', id: request.id, result: '0x38' }) : htmlGateway();
  } });
  for (const request of [rpc('eth_call', [{ to: address, data: '0xab' }, '0xa']),
    rpc('eth_getCode', [address, '0xa']), rpc('eth_getStorageAt', [address, '0x0', '0xa']),
    rpc('eth_call', [{ to: address, data: '0xab' }, 'safe']), rpc('eth_getCode', [address, 'finalized']),
    rpc('eth_getBlockByNumber', ['0xa', false]), rpc('eth_getBlockByNumber', ['latest', false]), rpc('eth_blockNumber')])
    assert.equal((await f.post(request)).status, 502);
  assert.equal(requestsAt(f, backupRpc).length, 0);
});

test('receipt and transaction lookups can recover once without caching pending or confirmed results', async t => {
  const f = await fixture(t, { fallbackRpcUrl: backupRpc, upstream: (url, init) => {
    const request = JSON.parse(init.body);
    return request.method === 'eth_chainId' ? json({ jsonrpc: '2.0', id: request.id, result: '0x38' })
      : url === backupRpc ? json({ jsonrpc: '2.0', id: request.id, result: { hash: transactionHash, status: '0x1' } }) : htmlGateway();
  } });
  for (const method of ['eth_getTransactionReceipt', 'eth_getTransactionByHash']) for (let i = 0; i < 2; i++) {
    const response = await f.post(rpc(method, [transactionHash]));
    assert.equal(response.status, 200); assert.equal((await response.json()).result.hash, transactionHash);
    assert.equal(response.headers.get('x-bemine-server-cache'), null);
  }
  assert.equal(requestsAt(f, backupRpc).filter(request => request.method !== 'eth_chainId').length, 4);
  assert.equal(requestsAt(f, backupRpc).filter(request => request.method === 'eth_chainId').length, 1);
});

test('temporary primary identity transport failures only route eligible reads to a proven backup', async t => {
  let clock = 100000, recovered = false;
  const f = await fixture(t, { now: () => clock, fallbackRpcUrl: backupRpc, upstream: (url, init) => {
    const request = JSON.parse(init.body);
    if (url !== backupRpc && request.method === 'eth_chainId' && !recovered) return htmlGateway();
    return json({ jsonrpc: '2.0', id: request.id, result: request.method === 'eth_chainId' ? '0x38' : '0x6000' });
  } });
  assert.equal((await f.post(latestCall())).status, 200);
  assert.equal((await f.post(latestCall())).status, 200);
  assert.equal((await f.post(rpc())).status, 200);
  assert.equal(requestsAt(f, 'https://operator-rpc.test/key').length, 1, 'only the bounded identity outage is remembered');
  assert.equal((await f.post(rpc('eth_getCode', [address, '0xa']))).status, 502, 'backup identity does not certify the primary or pinned reads');
  assert.equal(requestsAt(f, backupRpc).filter(request => request.method === 'eth_getCode').length, 0);
  clock += 5000; recovered = true;
  assert.equal((await f.post(latestCall())).status, 200);
  assert.equal(requestsAt(f, 'https://operator-rpc.test/key').at(-1).method, 'eth_call');
  assert.equal(requestsAt(f, backupRpc).filter(request => request.method === 'eth_call').length, 2);
});

test('redirects and oversized replies are rejected without weakening bounds through fallback', async t => {
  for (const fault of ['redirect', 'oversized']) {
    const f = await fixture(t, { fallbackRpcUrl: backupRpc, maxResponseBytes: 256, upstream: (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.method === 'eth_chainId') return json({ jsonrpc: '2.0', id: request.id, result: '0x38' });
      return fault === 'redirect' ? new Response(null, { status: 302, headers: { location: 'https://attacker.test' } })
        : json({ jsonrpc: '2.0', id: request.id, result: 'x'.repeat(300) });
    } });
    assert.equal((await f.post(latestCall())).status, 502);
    assert.equal(requestsAt(f, backupRpc).length, 0);
  }
});

test('public sale reference status proxies only one valid pool without caller query options', async t => {
  const envelope = { schemaVersion: 1, enabled: false, stale: false, item: { pool: address, status: 'disabled', proposalId: null } };
  const f = await fixture(t, { upstream: () => json(envelope) });
  const path = `/api/chain-index/v1/display/sale-reference/${address}`;
  const response = await f.get(path);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), envelope);
  assert.deepEqual(f.calls.map(call => [call.url, call.init.method]),
    [[`http://127.0.0.1:4180/v1/display/sale-reference/${address}`, 'GET']]);
  for (const invalid of [`${path}?pool=${address}`, `${path}?refresh=true`, `${path}?url=https://attacker.test`]) {
    assert.equal((await f.get(invalid)).status, 400);
  }
  for (const invalid of ['/api/chain-index/v1/display/sale-reference/0x1234',
    '/api/chain-index/v1/display/sale-reference/not-an-address', `${path}/extra`]) {
    assert.equal((await f.get(invalid)).status, 404);
  }
  assert.equal(f.calls.length, 1, 'invalid requests never reach the read-only status source');
});

test('native ask publication status proxies a fixed read-only pool route without RPC or caller destinations', async t => {
  const envelope = { schemaVersion: 1, chainId: 56, enabled: true, stale: false,
    item: { pool: address, status: 'pending-approval', askHash: `0x${'aa'.repeat(32)}` } };
  const f = await fixture(t, { upstream: () => json(envelope) });
  const path = `/api/chain-index/v1/display/firsto-ask/${address}`, response = await f.get(path);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), envelope);
  assert.deepEqual(f.calls.map(call => [call.url, call.init.method]), [[`http://127.0.0.1:4180/v1/display/firsto-ask/${address}`, 'GET']]);
  for (const suffix of [`?pool=${address}`, '?refresh=true', '?rpc=https://attacker.test', '/extra'])
    assert.equal((await f.get(path + suffix)).status, suffix.startsWith('?') ? 400 : 404);
  assert.equal(f.calls.length, 1);
});

test('only validated fresh Authority fee logs use the fixed index log RPC; other reads retain their destination', async t => {
  const logsRpcUrl = 'https://index-logs.test/key';
  const f = await fixture(t, { logsRpcUrl, feeHistoryLogScope, upstream: (url, init) => {
    const request = JSON.parse(init.body);
    if (request.method === 'eth_chainId') return json({ jsonrpc: '2.0', id: request.id, result: '0x38' });
    if (request.method === 'eth_getBlockByNumber') return json({ jsonrpc: '2.0', id: request.id, result: feeAnchor(request.params[0]) });
    if (request.method === 'eth_getLogs') return url === logsRpcUrl
      ? json({ jsonrpc: '2.0', id: request.id, result: [] })
      : json({ jsonrpc: '2.0', id: request.id, error: { code: -32005, message: 'limit exceeded' } });
    assert.equal(url, 'https://operator-rpc.test/key');
    return json({ jsonrpc: '2.0', id: request.id, result: '0x6000' });
  } });
  assert.equal((await f.post(rpc('eth_getCode', [address, '0xa']))).status, 200);
  assert(!f.calls.some(call => call.url === logsRpcUrl), 'normal page reads never contact the log RPC');
  const response = await f.post(feeLogs());
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).result, []);
  assert.deepEqual(f.calls.filter(call => call.url === logsRpcUrl).map(call => JSON.parse(call.init.body).method), ['eth_getLogs', 'eth_getBlockByNumber']);
  assert(!f.calls.some(call => call.url !== logsRpcUrl && JSON.parse(call.init.body).method === 'eth_getLogs'));
  for (const filter of [{ ...feeLogs().params[0], address: `0x${'22'.repeat(20)}` },
    { ...feeLogs().params[0], topics: [transactionHash] }, { ...feeLogs().params[0], toBlock: '0x1392' },
    { ...feeLogs().params[0], rpcUrl: 'https://attacker.test' }]) {
    const before = f.calls.length;
    assert.equal((await f.post(rpc('eth_getLogs', [filter]))).status, 400);
    assert.equal(f.calls.length, before);
  }
  const disabled = await fixture(t, { logsRpcUrl });
  assert.equal((await disabled.post(feeLogs())).status, 403); assert.equal(disabled.calls.length, 0);
});

test('default fee log destination reuses normal RPC identity without an extra proof', async t => {
  const f = await fixture(t, { feeHistoryLogScope, upstream: (_url, init) => {
    const request = JSON.parse(init.body);
    return json({ jsonrpc: '2.0', id: request.id, result: request.method === 'eth_chainId' ? '0x38' : [] });
  } });
  assert.deepEqual((await (await f.post(feeLogs())).json()).result, []);
  assert.deepEqual(f.calls.map(call => [call.url, JSON.parse(call.init.body).method]),
    [['https://operator-rpc.test/key', 'eth_chainId'], ['https://operator-rpc.test/key', 'eth_getLogs']]);
});

test('a missing configured fee log destination fails without falling back to ordinary reads', async t => {
  const f = await fixture(t, { logsRpcUrl: null, feeHistoryLogScope });
  const response = await f.post(feeLogs());
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'Read-only fee history RPC is not configured.');
  assert.deepEqual(f.calls.map(call => JSON.parse(call.init.body).method), ['eth_chainId']);
});

test('canonical fee ranges remain readable when standalone logs chainId fails and keep their thirty-second cache', async t => {
  const logsRpcUrl = 'https://index-logs.test/key'; let clock = 100000;
  const f = await fixture(t, { now: () => clock, logsRpcUrl, feeHistoryLogScope, upstream: (url, init) => {
    const request = JSON.parse(init.body);
    if (url === logsRpcUrl && request.method === 'eth_chainId')
      return json({ jsonrpc: '2.0', id: request.id, error: { code: -32005, message: 'transient chain identity limit exceeded' } });
    return json({ jsonrpc: '2.0', id: request.id, result: request.method === 'eth_chainId'
      ? '0x38' : request.method === 'eth_getLogs' ? []
        : request.method === 'eth_getBlockByNumber' ? feeAnchor(request.params[0]) : '0x6000' });
  } });
  assert.equal((await f.post(rpc('eth_getCode', [address, '0xa']))).status, 200);
  assert.equal((await f.post(feeLogs())).status, 200);
  clock += 4999;
  const cached = await f.post(feeLogs());
  assert.equal(cached.status, 200); assert.equal(cached.headers.get('x-bemine-server-cache'), 'hit');
  assert.equal(f.calls.filter(call => call.url === logsRpcUrl).length, 2, 'verified cached log ranges do not repeat header proofs');
  clock++;
  const reproved = await f.post(feeLogs()); assert.equal(reproved.status, 200);
  assert.equal(reproved.headers.get('x-bemine-server-cache'), 'hit', 'normal BSC proof expiry does not discard canonical fee data');
  const ordinary = await f.post(rpc('eth_getCode', [address, '0xa']));
  assert.equal(ordinary.status, 200); assert.equal(ordinary.headers.get('x-bemine-server-cache'), 'hit');
  assert.equal(f.calls.filter(call => JSON.parse(call.init.body).method === 'eth_getCode').length, 1);
  clock += 25000;
  const expired = await f.post(feeLogs()); assert.equal(expired.status, 200);
  assert.equal(expired.headers.get('x-bemine-server-cache'), null, 'the bounded fee cache expires after thirty seconds');
  assert.equal(f.calls.filter(call => JSON.parse(call.init.body).method === 'eth_getLogs').length, 2);
  assert.equal(f.calls.filter(call => call.url === logsRpcUrl && JSON.parse(call.init.body).method === 'eth_getBlockByNumber').length, 2,
    'each uncached read still proves the log range against the primary canonical header');
  assert.equal(f.calls.filter(call => call.url === logsRpcUrl && JSON.parse(call.init.body).method === 'eth_chainId').length, 0);
  assert.equal(f.calls.filter(call => call.url !== logsRpcUrl && JSON.parse(call.init.body).method === 'eth_chainId').length, 3,
    'the normal BSC56 proof remains mandatory and periodically renewed');
});

test('concurrent fee reads share the canonical range proof and bounded data cache, without caching errors or falling back', async t => {
  const logsRpcUrl = 'https://index-logs.test/key'; let fail = true;
  const f = await fixture(t, { logsRpcUrl, feeHistoryLogScope, upstream: async (url, init) => {
    const request = JSON.parse(init.body);
    if (request.method === 'eth_chainId') {
      await new Promise(resolve => setTimeout(resolve, 5));
      return json({ jsonrpc: '2.0', id: request.id, result: '0x38' });
    }
    if (request.method === 'eth_getBlockByNumber') return json({ jsonrpc: '2.0', id: request.id, result: feeAnchor(request.params[0]) });
    assert.equal(url, logsRpcUrl); assert.equal(request.method, 'eth_getLogs');
    await new Promise(resolve => setTimeout(resolve, 5));
    return json({ jsonrpc: '2.0', id: request.id, ...(fail
      ? { error: { code: -32005, message: 'private RPC quota detail' } } : { result: [] }) });
  } });
  for (const response of await Promise.all([f.post(feeLogs()), f.post(feeLogs()), f.post(feeLogs())])) {
    assert.equal(response.status, 200); assert.equal((await response.json()).error.message, 'Upstream rejected the read request.');
  }
  assert.equal(f.calls.filter(call => call.url === logsRpcUrl && JSON.parse(call.init.body).method === 'eth_chainId').length, 0);
  assert.equal(f.calls.filter(call => call.url !== logsRpcUrl && JSON.parse(call.init.body).method === 'eth_chainId').length, 1);
  assert.equal(f.calls.filter(call => JSON.parse(call.init.body).method === 'eth_getLogs').length, 1);
  assert.equal(f.calls.filter(call => JSON.parse(call.init.body).method === 'eth_getBlockByNumber').length, 2);
  fail = false;
  const response = await f.post(feeLogs()); assert.deepEqual((await response.json()).result, []);
  assert.equal(response.headers.get('x-bemine-server-cache'), null);
  assert.equal(f.calls.filter(call => JSON.parse(call.init.body).method === 'eth_getLogs').length, 2);
});

test('failed primary BSC reproving rejects earlier canonical fee data before it can repopulate the cache', async t => {
  const logsRpcUrl = 'https://index-logs.test/key'; let clock = 100000, chain = '0x38', releaseLog, startedLog;
  const waiting = new Promise(resolve => { startedLog = resolve; });
  const blocked = new Promise(resolve => { releaseLog = resolve; });
  const f = await fixture(t, { now: () => clock, logsRpcUrl, feeHistoryLogScope, upstream: async (url, init) => {
    const request = JSON.parse(init.body);
    if (request.method === 'eth_chainId') {
      assert.notEqual(url, logsRpcUrl);
      return json({ jsonrpc: '2.0', id: request.id, result: chain });
    }
    if (request.method === 'eth_getBlockByNumber') return json({ jsonrpc: '2.0', id: request.id, result: feeAnchor(request.params[0]) });
    assert.equal(request.method, 'eth_getLogs'); assert.equal(url, logsRpcUrl);
    startedLog(); await blocked; return json({ jsonrpc: '2.0', id: request.id, result: [] });
  } });
  const earlier = f.post(feeLogs()); await waiting;
  clock += 5000; chain = '0x1';
  assert.equal((await f.post(feeLogs())).status, 502);
  releaseLog(); assert.equal((await earlier).status, 502);
  chain = '0x38';
  const current = await f.post(feeLogs()); assert.equal(current.status, 200);
  assert.equal(current.headers.get('x-bemine-server-cache'), null);
  assert.equal(f.calls.filter(call => JSON.parse(call.init.body).method === 'eth_getLogs').length, 2);
});

test('uncached fee ranges reject log-node errors, missing blocks and wrong canonical hashes without poisoning ordinary reads', async t => {
  const logsRpcUrl = 'https://index-logs.test/key'; let fault = 'wrong_hash';
  const f = await fixture(t, { logsRpcUrl, feeHistoryLogScope, upstream: (url, init) => {
    const request = JSON.parse(init.body);
    if (request.method === 'eth_chainId') {
      assert.notEqual(url, logsRpcUrl);
      return json({ jsonrpc: '2.0', id: request.id, result: '0x38' });
    }
    if (request.method === 'eth_getBlockByNumber') {
      if (url === logsRpcUrl && fault === 'error')
        return json({ jsonrpc: '2.0', id: request.id, error: { code: -32005, message: 'private header error detail' } });
      const block = feeAnchor(request.params[0]);
      const result = url !== logsRpcUrl || fault === 'none' ? block : fault === 'missing' ? null
        : { ...block, hash: `0x${'cd'.repeat(32)}` };
      return json({ jsonrpc: '2.0', id: request.id, result });
    }
    if (request.method === 'eth_getLogs') {
      assert.equal(url, logsRpcUrl);
      return json({ jsonrpc: '2.0', id: request.id, result: [] });
    }
    assert.notEqual(url, logsRpcUrl);
    return json({ jsonrpc: '2.0', id: request.id, result: '0x6000' });
  } });
  assert.equal((await f.post(rpc('eth_getCode', [address, '0xa']))).status, 200);
  for (fault of ['wrong_hash', 'missing', 'error']) {
    const failed = await f.post(feeLogs()); assert.equal(failed.status, 502);
    const body = await failed.json(); assert(!Object.hasOwn(body, 'result'), 'failed proofs cannot fabricate an empty scan');
    assert(!JSON.stringify(body).includes('private header error detail'));
    const ordinary = await f.post(rpc('eth_getCode', [address, '0xa']));
    assert.equal(ordinary.status, 200); assert.equal(ordinary.headers.get('x-bemine-server-cache'), 'hit');
  }
  fault = 'none';
  const recovered = await f.post(feeLogs()); assert.equal(recovered.status, 200);
  assert.deepEqual((await recovered.json()).result, []); assert.equal(recovered.headers.get('x-bemine-server-cache'), null);
  assert.equal(f.calls.filter(call => JSON.parse(call.init.body).method === 'eth_getLogs').length, 4, 'failure results are never cached or sent to the ordinary RPC');
  assert.equal(f.calls.filter(call => JSON.parse(call.init.body).method === 'eth_getCode').length, 1);
});

test('all eight read methods accept exact bounded parameters; unknown/write/batch/override routes fail closed', () => {
  const calls = [rpc(), rpc('eth_blockNumber'), rpc('eth_getBlockByNumber', ['0xa', false]), rpc('eth_getCode', [address, 'latest']),
    rpc('eth_getTransactionByHash', [transactionHash]), rpc('eth_getTransactionReceipt', [transactionHash]),
    rpc('eth_getStorageAt', [address, '0x0', '0xa']), rpc('eth_call', [{ to: address, data: '0xab' }, '0xa'])];
  for (const input of calls) assert.equal(validateReadRpc(input).method, input.method);
  assert.equal(validateReadRpc(calls.at(-1)).params[0].gas, '0x1c9c380');
  for (const input of [rpc('eth_sendTransaction', [{}]), rpc('eth_sendRawTransaction', ['0xab']), rpc('personal_sign'), rpc('eth_requestAccounts'),
    rpc('debug_traceCall'), [rpc()], { ...rpc(), id: null }, { ...rpc(), url: 'https://evil.test' },
    rpc('eth_getBlockByNumber', ['latest', true]), rpc('eth_call', [{ to: address, data: '0x' }, 'latest', {}]),
    rpc('eth_call', [{ to: address, data: '0x', gas: '0x1c9c381' }, 'latest']), rpc('eth_call', [{ data: '0x' }, 'latest'])]) assert.throws(() => validateReadRpc(input));
});

test('transaction recovery reads require one exact 32-byte hash before contacting upstream', async t => {
  const f = await fixture(t);
  for (const method of ['eth_getTransactionByHash', 'eth_getTransactionReceipt']) {
    for (const params of [[], [address], ['latest'], ['0x'], [`0x${'ab'.repeat(31)}`],
      [`0x${'ab'.repeat(33)}`], [`0x${'zz'.repeat(32)}`], [null], [7], [{}],
      [transactionHash, 'latest'], [transactionHash, {}]]) {
      assert.throws(() => validateReadRpc(rpc(method, params)), /Invalid read-only RPC parameters/);
      assert.equal((await f.post(rpc(method, params))).status, 400);
    }
  }
  assert.equal(f.calls.length, 0);
});

test('transaction recovery stays BSC-verified, uncached and preserves pending null to mined transitions', async t => {
  const seen = [], counts = new Map();
  const f = await fixture(t, { upstream: (_url, init) => {
    const request = JSON.parse(init.body); seen.push(request);
    if (request.method === 'eth_chainId') return json({ jsonrpc: '2.0', id: request.id, result: '0x38' });
    const count = (counts.get(request.method) ?? 0) + 1; counts.set(request.method, count);
    const result = count === 1 ? null : request.method === 'eth_getTransactionByHash'
      ? { hash: transactionHash, blockNumber: '0xa' }
      : { transactionHash, blockNumber: '0xa', status: '0x1' };
    return json({ jsonrpc: '2.0', id: request.id, result });
  } });
  for (const method of ['eth_getTransactionByHash', 'eth_getTransactionReceipt']) {
    const pending = await f.post(rpc(method, [transactionHash]));
    assert.equal(pending.status, 200); assert.equal((await pending.json()).result, null);
    const mined = await f.post(rpc(method, [transactionHash]));
    assert.equal(mined.status, 200); assert.equal((await mined.json()).result.blockNumber, '0xa');
    assert.equal(mined.headers.get('x-bemine-server-cache'), null);
    assert.equal(mined.headers.get('cache-control'), 'no-store');
    assert.equal(counts.get(method), 2);
  }
  assert.equal(seen[0].method, 'eth_chainId');
  assert.deepEqual(seen.slice(1).map(request => request.params), Array(4).fill([transactionHash]));
  const wrong = await fixture(t, { upstream: (_url, init) => {
    const request = JSON.parse(init.body);
    assert.equal(request.method, 'eth_chainId');
    return json({ jsonrpc: '2.0', id: request.id, result: '0x1' });
  } });
  for (const method of ['eth_getTransactionByHash', 'eth_getTransactionReceipt'])
    assert.equal((await wrong.post(rpc(method, [transactionHash]))).status, 502);
});

test('transaction recovery preserves upstream response size and timeout bounds', async t => {
  for (const method of ['eth_getTransactionByHash', 'eth_getTransactionReceipt']) {
    const oversized = await fixture(t, { maxResponseBytes: 256, upstream: (_url, init) => {
      const request = JSON.parse(init.body);
      return json({ jsonrpc: '2.0', id: request.id, result: request.method === 'eth_chainId'
        ? '0x38' : { input: '0x' + 'ab'.repeat(256) } });
    } });
    assert.equal((await oversized.post(rpc(method, [transactionHash]))).status, 502);
    const stalled = await fixture(t, { timeoutMs: 50, upstream: (_url, init) => {
      const request = JSON.parse(init.body);
      return request.method === 'eth_chainId' ? json({ jsonrpc: '2.0', id: request.id, result: '0x38' })
        : new Promise(() => {});
    } });
    assert.equal((await stalled.post(rpc(method, [transactionHash]))).status, 504);
  }
});

test('same-origin routing retains journal/static behavior and proxies RPC without request headers', async t => {
  const f = await fixture(t); const res = await f.post(rpc(), '/api/rpc', { headers: { 'content-type': 'application/json', authorization: 'must-not-forward', cookie: 'secret' } });
  assert.equal(res.status, 200); assert.equal((await res.json()).result, '0x38'); assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(f.calls[0].url, 'https://operator-rpc.test/key'); assert.equal(f.calls[0].init.redirect, 'error');
  assert.equal(f.calls[0].init.headers.authorization, undefined); assert.equal(f.calls[0].init.headers.cookie, undefined);
  assert.equal(await (await f.get('/api/journal/health')).text(), 'journal-ok');
  assert.equal((await f.get('/missing-static-file')).status, 404);
  assert.equal((await f.post(rpc(), '/missing-static-file')).status, 405);
});

test('RPC rejects writes, URL override, malformed or oversized input before any upstream call', async t => {
  const f = await fixture(t, { maxRequestBytes: 256 });
  assert.equal((await f.post(rpc('eth_sendTransaction', [{}]))).status, 403);
  assert.equal((await f.post(rpc(), '/api/rpc?url=http://evil.test')).status, 400);
  assert.equal((await f.post([rpc()])).status, 400);
  assert.equal((await f.post(rpc(), '/api/rpc', { body: '{' })).status, 400);
  assert.equal((await f.post(rpc(), '/api/rpc', { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await f.post(rpc(), '/api/rpc', { body: 'x'.repeat(300) })).status, 413);
  assert.equal((await f.get('/api/rpc')).status, 405); assert.equal(f.calls.length, 0);
});

test('index allows only known GET endpoints and bounded unique query parameters', async t => {
  const f = await fixture(t);
  for (const path of ['/health', '/v1/stats', '/v1/pools?cursor=0&limit=20', `/v1/accounts/${address}/pools`,
    '/v1/snapshot/pools?cursor=0&limit=20', `/v1/snapshot/pools/${address}`,
    '/v1/snapshot/portfolios?limit=20', '/v1/snapshot/stats',
    `/v1/snapshot/orders?active=true&seller=${address}&limit=20`,
    `/v1/orders?pool=${address}&seller=${address}&active=true&cursor=8`, `/v1/activity?cursor=10:2:1&account=${address}`,
    `/v1/yield?pool=${address}&days=30`]) assert.equal((await f.get(`/api/chain-index${path}`)).status, 200);
  assert(f.calls.every(call => call.url.startsWith('http://127.0.0.1:4180/') && call.init.method === 'GET'));
  const count = f.calls.length;
  for (const path of ['/v1/private', '/v1/notifications', '/v1/public-display',
    `/v1/snapshot/pools/${address}?limit=1`, '/v1/snapshot/pools/0x1234',
    '/v1/pools?url=http://evil.test', '/v1/pools?limit=1&limit=2', '/v1/pools?limit=51',
    '/v1/orders?cursor=0', '/v1/orders?active=maybe', '/v1/activity?cursor=1:2:Infinity', '/v1/yield?days=30']) assert((await f.get(`/api/chain-index${path}`)).status >= 400);
  assert.equal((await f.post(rpc(), '/api/chain-index/v1/pools')).status, 405); assert.equal(f.calls.length, count);
});

test('missing RPC configuration is explicit 503, not dummy chain data', async t => {
  const f = await fixture(t, { rpcUrl: null }); assert.equal((await f.post(rpc())).status, 503); assert.equal(f.calls.length, 0);
});

test('portfolio display directory and detail reach the shared cache without chain reads', async t => {
  const source = { cacheOrigin: 'server', displayOnly: true, transactionReady: false };
  const empty = { source, data: { items: [], nextCursor: null } };
  const detail = { source, data: { item: { kind: 'portfolio', pool: address } } };
  const f = await fixture(t, { upstream: (url, init) => {
    assert.equal(init.method, 'GET');
    return json(new URL(url).pathname === '/v1/display/portfolios' ? empty : detail);
  } });
  for (const query of ['', '?cursor=0&limit=20', `?account=${address}&mine=false`,
    `?account=${address}&mine=true&cursor=20&limit=5`]) {
    const response = await f.get('/api/chain-index/v1/display/portfolios' + query);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), empty, 'An empty budget directory remains a successful read.');
  }
  for (const query of ['', `?account=${address}&children=true`, `?account=${address}&children=false`]) {
    const response = await f.get(`/api/chain-index/v1/display/portfolios/${address}${query}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), detail);
  }
  assert(f.calls.every(call => call.url.startsWith('http://127.0.0.1:4180/v1/display/portfolios')
    && call.init.method === 'GET'), 'Portfolio display never falls back to RPC.');
  const count = f.calls.length;
  for (const path of ['/v1/display/portfolios?mine=true', '/v1/display/portfolios?mine=1',
    '/v1/display/portfolios?limit=21', '/v1/display/portfolios?limit=0',
    '/v1/display/portfolios?cursor=-1', '/v1/display/portfolios?cursor=9007199254740992',
    '/v1/display/portfolios?account=0x1234', `/v1/display/portfolios?account=${address}&account=${address}`,
    '/v1/display/portfolios?children=true', '/v1/display/portfolios?url=https://evil.test',
    `/v1/display/portfolios/${address}?children=maybe`, `/v1/display/portfolios/${address}?children=true&children=false`,
    `/v1/display/portfolios/${address}?mine=true`, `/v1/display/portfolios/${address}?cursor=0`,
    '/v1/display/portfolios/0x1234', `/v1/display/portfolios/${address}/private`]) {
    assert((await f.get('/api/chain-index' + path)).status >= 400, path);
  }
  assert.equal((await f.post(rpc(), '/api/chain-index/v1/display/portfolios')).status, 405);
  assert.equal(f.calls.length, count, 'Invalid display requests are rejected before any upstream request.');
});

test('proxy preserves incomplete index 503 and refuses redirected/HTML/mismatched upstream results', async t => {
  const incomplete = await fixture(t, { upstream: () => json({ source: { complete: false }, data: null }, 503) });
  const result = await incomplete.get('/api/chain-index/v1/pools'); assert.equal(result.status, 503); assert.equal((await result.json()).data, null);
  for (const upstream of [() => new Response('', { status: 302, headers: { location: 'https://evil.test' } }),
    () => new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    () => json({ jsonrpc: '2.0', id: 9, result: '0x38' }), () => json({ jsonrpc: '2.0', id: 1, result: '0x38', error: {} })]) {
    const f = await fixture(t, { upstream }); assert.equal((await f.post(rpc())).status, 502);
  }
});

test('health always relays the live index state after a previously complete read', async t => {
  let indexCalls = 0;
  const source = { chainId: 56, complete: true, unknownReason: null, indexedThrough: 100,
    indexedBlockHash: `0x${'ab'.repeat(32)}`, checkedAt: new Date().toISOString() };
  const f = await fixture(t, {
    upstream: (url, init) => {
      if (init.method === 'POST') return json({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: '0x38' });
      indexCalls++;
      return indexCalls === 1 ? json({ source, data: { items: [] } })
        : json({ source: { ...source, complete: false, unknownReason: 'index_not_caught_up' }, data: null },
          url.endsWith('/health') ? 200 : 503);
    } });
  assert.equal((await f.get('/api/chain-index/v1/pools')).status, 200);
  const health = await f.get('/api/chain-index/health');
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('x-bemine-server-cache'), null);
  assert.equal((await health.json()).source.complete, false, 'prior complete state must not mask sync');
  assert.equal(indexCalls, 2);
  assert.equal((await f.get('/api/chain-index/v1/pools')).status, 503, 'catalog is never served stale');
  assert.equal((await f.post(rpc())).status, 200, 'RPC is never served stale');
  assert.equal((await (await f.get('/api/chain-index/health')).json()).source.complete, false);
  assert.equal(indexCalls, 4, 'each health request reaches the local index');
});

test('verified history responses never substitute for a live health response', async t => {
  const source = { chainId: 56, complete: true, unknownReason: null, indexedThrough: 100,
    indexedBlockHash: `0x${'ab'.repeat(32)}`, checkedAt: new Date().toISOString() };
  const historical = { ...source, readMode: 'verified_snapshot', stale: true,
    refreshing: true, transactionReady: false };
  let calls = 0;
  const f = await fixture(t, { upstream: url => {
    calls++;
    if (url.includes('/v1/pools')) return json({ source, data: { items: [] } });
    if (url.includes('/v1/activity')) return json({ source: historical, data: { items: [] } });
    return json({ source: { ...source, complete: false, unknownReason: 'index_not_caught_up' } });
  } });
  assert.equal((await f.get('/api/chain-index/v1/pools')).status, 200);
  assert.equal((await f.get('/api/chain-index/v1/activity')).status, 200);
  const health = await f.get('/api/chain-index/health');
  assert.equal(health.headers.get('x-bemine-server-cache'), null);
  assert.equal((await health.json()).source.complete, false);
  assert.equal(calls, 3);

  let coldCalls = 0;
  const cold = await fixture(t, { upstream: url => {
    coldCalls++;
    return url.includes('/v1/activity') ? json({ source: historical, data: { items: [] } })
      : json({ source: { ...source, complete: false, unknownReason: 'index_not_caught_up' } });
  } });
  assert.equal((await cold.get('/api/chain-index/v1/activity')).status, 200);
  const coldHealth = await cold.get('/api/chain-index/health');
  assert.equal(coldHealth.headers.get('x-bemine-server-cache'), null);
  assert.equal((await coldHealth.json()).source.complete, false);
  assert.equal(coldCalls, 2);
});

test('health fails closed while the proxy is saturated, then reads current status', async t => {
  let releaseRpc, rpcStarted = false;
  const gate = new Promise(resolve => { releaseRpc = resolve; });
  const source = { chainId: 56, complete: true, unknownReason: null, indexedThrough: 100,
    indexedBlockHash: `0x${'ab'.repeat(32)}`, checkedAt: new Date().toISOString() };
  const f = await fixture(t, { maxConcurrent: 1, maxQueued: 0,
    upstream: async (_url, init) => {
      if (init.method === 'GET') return json({ source, data: { items: [] } });
      rpcStarted = true;
      await gate;
      return json({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: '0x38' });
    } });
  assert.equal((await f.get('/api/chain-index/v1/pools')).status, 200);
  const rpcRead = f.post(rpc());
  while (!rpcStarted) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal((await f.get('/api/chain-index/health')).status, 503,
    'a cached complete source cannot bypass a busy live index');
  releaseRpc();
  assert.equal((await rpcRead).status, 200);
  const health = await f.get('/api/chain-index/health');
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('x-bemine-server-cache'), null);
});

test('server reuses exact pinned reads while live headers and latest simulations stay fresh', async t => {
  let clock = Date.now(), reads = 0;
  const f = await fixture(t, { now: () => clock, pinnedRpcTtlMs: 1000,
    upstream: (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.method === 'eth_chainId') return json({ jsonrpc: '2.0', id: request.id, result: '0x38' });
      reads++;
      return json({ jsonrpc: '2.0', id: request.id, result: '0x6001' });
    } });
  const pinned = rpc('eth_getCode', [address, '0xa']);
  assert.equal((await (await f.post(pinned)).json()).result, '0x6001');
  const hit = await f.post({ ...pinned, id: 2 });
  assert.equal(hit.headers.get('x-bemine-server-cache'), 'hit');
  assert.equal((await hit.json()).id, 2);
  assert.equal(reads, 1);
  await f.post(rpc('eth_getBlockByNumber', ['0xa', false]));
  await f.post(rpc('eth_getBlockByNumber', ['0xa', false]));
  await f.post(rpc('eth_call', [{ to: address, data: '0x' }, 'latest']));
  await f.post(rpc('eth_call', [{ to: address, data: '0x' }, 'latest']));
  assert.equal(reads, 5, 'canonical header checks and latest simulations are never cached');
  clock += 1000;
  await f.post(pinned);
  assert.equal(reads, 6, 'a pinned result expires at its TTL');
});

test('local BSC chain ID requires a recent upstream proof and never caches a wrong chain', async t => {
  let clock=100_000,chain='0x38',proofs=0;
  const f=await fixture(t,{now:()=>clock,chainIdTtlMs:1000,upstream:(_url,init)=>{
    const request=JSON.parse(init.body);
    assert.equal(request.method,'eth_chainId');
    proofs++;
    return json({jsonrpc:'2.0',id:request.id,result:chain});
  }});
  const first=await f.post(rpc());
  assert.equal((await first.json()).result,'0x38');
  assert.equal(proofs,1);
  const local=await f.post({...rpc(),id:2});
  assert.equal((await local.json()).result,'0x38');
  assert.equal(proofs,1,'a verified fixed-chain answer needs no second upstream round trip');
  chain='0x1';clock+=1000;
  assert.equal((await f.post({...rpc(),id:3})).status,502);
  assert.equal(proofs,2,'expired chain proof must be rechecked');
  chain='0x38';
  assert.equal((await (await f.post({...rpc(),id:4})).json()).result,'0x38');
  assert.equal(proofs,3,'wrong-chain evidence cannot seed the local answer');
});

test('all uncached reads require the same recent BSC identity proof',async t=>{
  let clock=100_000,chain='0x1',identityReads=0,dataReads=0;
  const f=await fixture(t,{now:()=>clock,chainIdTtlMs:1000,upstream:(_url,init)=>{
    const request=JSON.parse(init.body);
    if(request.method==='eth_chainId'){
      identityReads++;
      return json({jsonrpc:'2.0',id:request.id,result:chain});
    }
    dataReads++;
    return json({jsonrpc:'2.0',id:request.id,result:'0x2'});
  }});
  const reads=[rpc('eth_blockNumber'),rpc('eth_getStorageAt',[address,'0x0','0xa']),
    rpc('eth_call',[{to:address,data:'0x'},'latest']),rpc('eth_getCode',[address,'latest'])];
  for(const request of reads)assert.equal((await f.post(request)).status,502);
  assert.equal(dataReads,0,'no read may escape to an unverified chain');
  chain='0x38';
  for(const request of reads)assert.equal((await (await f.post(request)).json()).result,'0x2');
  assert.equal(dataReads,reads.length);
  assert.equal(identityReads,reads.length+1,'a successful short-lived proof is shared by uncached reads');
  chain='0x1';clock+=1000;
  assert.equal((await f.post(reads[2])).status,502);
  assert.equal(dataReads,reads.length,'expiry prevents latest eth_call from reading the wrong chain');
});

test('numeric headers coalesce and cache briefly; fresh headers invalidate a reorged hash', async t => {
  let clock=100_000,chain='0x38',headerReads=0,chainReads=0;
  let currentHash=`0x${'a'.repeat(64)}`;
  let releaseHeader,headerStarted;
  const gate=new Promise(resolve=>{releaseHeader=resolve;});
  const started=new Promise(resolve=>{headerStarted=resolve;});
  const f=await fixture(t,{now:()=>clock,chainIdTtlMs:1000,headerTtlMs:100,
    upstream:async(_url,init)=>{
      const request=JSON.parse(init.body);
      if(request.method==='eth_chainId'){
        chainReads++;
        return json({jsonrpc:'2.0',id:request.id,result:chain});
      }
      if(request.method==='eth_getBlockByNumber'){
        headerReads++;
        if(headerReads===1){headerStarted();await gate;}
        return json({jsonrpc:'2.0',id:request.id,result:{number:'0xa',hash:currentHash,
          timestamp:'0x10',transactions:[]}});
      }
      throw new Error(`Unexpected RPC ${request.method}`);
    }});
  const numbered=rpc('eth_getBlockByNumber',['0xa',false]);
  const first=f.post(numbered);
  await started;
  const second=f.post({...numbered,id:2});
  await new Promise(resolve=>setTimeout(resolve,10));
  releaseHeader();
  const [firstResponse,secondResponse]=await Promise.all([first,second]);
  // Under a heavily loaded runner the second HTTP request may reach the
  // server just after the first proof completes; that is a valid cache hit.
  assert.ok([null,'hit'].includes(secondResponse.headers.get('x-bemine-server-cache')));
  assert.deepEqual([firstResponse.status,secondResponse.status],[200,200]);
  assert.deepEqual([(await firstResponse.json()).id,(await secondResponse.json()).id],[1,2]);
  assert.equal(headerReads,1,'in-flight identical heights share one upstream read');
  const cached=await f.post({...numbered,id:3});
  assert.equal(cached.headers.get('x-bemine-server-cache'),'hit');
  assert.equal(headerReads,1);
  currentHash=`0x${'b'.repeat(64)}`;
  const latest=await f.post(rpc('eth_getBlockByNumber',['latest',false]));
  assert.equal((await latest.json()).result.hash,currentHash);
  const afterReorg=await f.post({...numbered,id:4});
  assert.equal(afterReorg.headers.get('x-bemine-server-cache'),null);
  assert.equal((await afterReorg.json()).result.hash,currentHash);
  assert.equal(headerReads,3,'a freshly observed conflicting hash discards the numeric cache');
  clock+=100;
  currentHash=`0x${'c'.repeat(64)}`;
  assert.equal((await (await f.post({...numbered,id:5})).json()).result.hash,currentHash);
  assert.equal(headerReads,4,'the short TTL never turns a new canonical check into a lasting cache hit');
  chain='0x1';clock+=1000;
  assert.equal((await f.post({...numbered,id:6})).status,502);
  assert.equal(headerReads,4,'wrong-chain proof fails before a cached header can be served');
  chain='0x38';
  assert.equal((await (await f.post({...numbered,id:7})).json()).result.hash,currentHash);
  assert.equal(headerReads,5,'recovery requires a fresh header after cache invalidation');
  assert.equal(chainReads,3);
});

test('a pinned read cannot reuse or cache an older same-height pending header', async t => {
  let headerReads=0,releaseOld,oldStarted;
  const oldGate=new Promise(resolve=>{releaseOld=resolve;});
  const started=new Promise(resolve=>{oldStarted=resolve;});
  const oldHash=`0x${'a'.repeat(64)}`,newHash=`0x${'b'.repeat(64)}`;
  const f=await fixture(t,{upstream:async(_url,init)=>{
    const request=JSON.parse(init.body);
    if(request.method==='eth_chainId')return json({jsonrpc:'2.0',id:request.id,result:'0x38'});
    if(request.method==='eth_getBlockByNumber'){
      const ordinal=++headerReads;
      if(ordinal===1){oldStarted();await oldGate;}
      return json({jsonrpc:'2.0',id:request.id,result:{number:'0xa',
        hash:ordinal===1?oldHash:newHash,timestamp:'0x10',transactions:[]}});
    }
    if(request.method==='eth_call')return json({jsonrpc:'2.0',id:request.id,result:'0x01'});
    throw new Error(`Unexpected RPC ${request.method}`);
  }});
  const header=rpc('eth_getBlockByNumber',['0xa',false]);
  const pendingOld=f.post(header);
  await started;
  assert.equal((await (await f.post(rpc('eth_call',[{to:address,data:'0x'},'0xa']))).json()).result,'0x01');
  const afterCall=await f.post({...header,id:2});
  assert.equal((await afterCall.json()).result.hash,newHash,
    'the post-call header must be fetched after the pinned read');
  assert.equal(headerReads,2,'the post-call check must not join the older pending header');
  releaseOld();
  assert.equal((await (await pendingOld).json()).result.hash,oldHash,
    'the original caller receives its own header without poisoning the cache');
  const cached=await f.post({...header,id:3});
  assert.equal((await cached.json()).result.hash,newHash);
  assert.equal(headerReads,2,'the old response cannot replace the newer header cache');
});

test('a header started during a pinned read cannot become its post-read check', async t => {
  let headerReads=0,releaseCall,callStarted,releaseHeader,headerStarted;
  const callGate=new Promise(resolve=>{releaseCall=resolve;});
  const callSeen=new Promise(resolve=>{callStarted=resolve;});
  const headerGate=new Promise(resolve=>{releaseHeader=resolve;});
  const headerSeen=new Promise(resolve=>{headerStarted=resolve;});
  const f=await fixture(t,{upstream:async(_url,init)=>{
    const request=JSON.parse(init.body);
    if(request.method==='eth_chainId')return json({jsonrpc:'2.0',id:request.id,result:'0x38'});
    if(request.method==='eth_call'){
      callStarted();await callGate;
      return json({jsonrpc:'2.0',id:request.id,result:'0x01'});
    }
    if(request.method==='eth_getBlockByNumber'){
      const ordinal=++headerReads;
      if(ordinal===1){headerStarted();await headerGate;}
      return json({jsonrpc:'2.0',id:request.id,result:{number:'0xa',
        hash:`0x${(ordinal===1?'a':'b').repeat(64)}`,timestamp:'0x10',transactions:[]}});
    }
    throw new Error(`Unexpected RPC ${request.method}`);
  }});
  const call=f.post(rpc('eth_call',[{to:address,data:'0x'},'0xa']));
  await callSeen;
  const header=rpc('eth_getBlockByNumber',['0xa',false]);
  const pendingDuring=f.post(header);
  await headerSeen;
  releaseCall();
  assert.equal((await call).status,200);
  const afterCall=await f.post({...header,id:2});
  assert.equal((await afterCall.json()).result.hash,`0x${'b'.repeat(64)}`);
  assert.equal(headerReads,2);
  releaseHeader();
  assert.equal((await (await pendingDuring).json()).result.hash,`0x${'a'.repeat(64)}`,
    'another caller keeps its response while the post-call check stays fresh');
});

test('a reorg evicts pinned calls and rejects old-fork calls still in flight', async t => {
  let fork='a',headerReads=0,callReads=0,releaseOld,oldStarted;
  const oldGate=new Promise(resolve=>{releaseOld=resolve;});
  const started=new Promise(resolve=>{oldStarted=resolve;});
  const f=await fixture(t,{upstream:async(_url,init)=>{
    const request=JSON.parse(init.body);
    if(request.method==='eth_chainId')return json({jsonrpc:'2.0',id:request.id,result:'0x38'});
    if(request.method==='eth_getBlockByNumber'){
      headerReads++;
      return json({jsonrpc:'2.0',id:request.id,result:{number:'0xa',hash:`0x${fork.repeat(64)}`,
        timestamp:'0x10',transactions:[]}});
    }
    if(request.method==='eth_call'){
      callReads++;
      const readFork=fork;
      if(callReads===2){oldStarted();await oldGate;}
      return json({jsonrpc:'2.0',id:request.id,result:readFork==='a'?'0xaa':'0xbb'});
    }
    throw new Error(`Unexpected RPC ${request.method}`);
  }});
  const header=rpc('eth_getBlockByNumber',['0xa',false]);
  const pinned=rpc('eth_call',[{to:address,data:'0x01'},'0xa']);
  assert.equal((await (await f.post(header)).json()).result.hash,`0x${'a'.repeat(64)}`);
  assert.equal((await (await f.post(pinned)).json()).result,'0xaa');
  const cached=await f.post({...pinned,id:2});
  assert.equal(cached.headers.get('x-bemine-server-cache'),'hit');
  assert.equal((await cached.json()).id,2);
  const pending=f.post({...pinned,params:[{to:address,data:'0x02'},'0xa'],id:3});
  await started;
  fork='b';
  assert.equal((await (await f.post(rpc('eth_getBlockByNumber',['latest',false]))).json()).result.hash,`0x${'b'.repeat(64)}`);
  releaseOld();
  assert.equal((await pending).status,502,'an old-fork pending call cannot escape after a new header');
  const fresh=await f.post({...pinned,id:4});
  assert.equal(fresh.headers.get('x-bemine-server-cache'),null);
  assert.deepEqual(await fresh.json(),{jsonrpc:'2.0',id:4,result:'0xbb'});
  const finalHeader=await f.post({...header,id:5});
  assert.equal(finalHeader.headers.get('x-bemine-server-cache'),null,'the post-call canonical check stays fresh');
  assert.equal((await finalHeader.json()).result.hash,`0x${'b'.repeat(64)}`);
  assert.equal(callReads,3);
  assert.equal(headerReads,3);
});

test('failed chain reproof cannot let pending header or code reads repopulate caches', async t => {
  let clock=100_000,chain='0x38',headerReads=0,codeReads=0,startedReads=0;
  let releaseReads;
  const gate=new Promise(resolve=>{releaseReads=resolve;});
  const f=await fixture(t,{now:()=>clock,chainIdTtlMs:1000,upstream:async(_url,init)=>{
    const request=JSON.parse(init.body);
    if(request.method==='eth_chainId')return json({jsonrpc:'2.0',id:request.id,result:chain});
    if(request.method==='eth_getBlockByNumber'){
      headerReads++;startedReads++;
      if(headerReads===1)await gate;
      return json({jsonrpc:'2.0',id:request.id,result:{number:'0xa',hash:`0x${'a'.repeat(64)}`,
        timestamp:'0x10',transactions:[]}});
    }
    if(request.method==='eth_getCode'){
      codeReads++;startedReads++;
      if(codeReads===1)await gate;
      return json({jsonrpc:'2.0',id:request.id,result:'0x6001'});
    }
    throw new Error(`Unexpected RPC ${request.method}`);
  }});
  assert.equal((await f.post(rpc())).status,200);
  const header=rpc('eth_getBlockByNumber',['0xa',false]);
  const code=rpc('eth_getCode',[address,'0xa']);
  const pendingHeader=f.post(header),pendingCode=f.post(code);
  while(startedReads<2)await new Promise(resolve=>setTimeout(resolve,1));
  chain='0x1';clock+=1000;
  assert.equal((await f.post({...rpc(),id:2})).status,502);
  releaseReads();
  assert.deepEqual(await Promise.all([pendingHeader,pendingCode].map(async request=>(await request).status)),[502,502]);
  chain='0x38';
  assert.equal((await f.post({...rpc(),id:3})).status,200);
  const recoveredHeader=await f.post({...header,id:4});
  const recoveredCode=await f.post({...code,id:5});
  assert.equal(recoveredHeader.headers.get('x-bemine-server-cache'),null);
  assert.equal(recoveredCode.headers.get('x-bemine-server-cache'),null);
  assert.equal((await recoveredHeader.json()).id,4);
  assert.equal((await recoveredCode.json()).id,5);
  assert.equal(headerReads,2);
  assert.equal(codeReads,2);
});

test('a slow old-fork header cannot overwrite a newer observed canonical hash', async t => {
  let reads=0,releaseOld,oldStarted;
  const gate=new Promise(resolve=>{releaseOld=resolve;});
  const started=new Promise(resolve=>{oldStarted=resolve;});
  const oldHash=`0x${'a'.repeat(64)}`,newHash=`0x${'b'.repeat(64)}`;
  const f=await fixture(t,{upstream:async(_url,init)=>{
    const request=JSON.parse(init.body);
    if(request.method==='eth_chainId')return json({jsonrpc:'2.0',id:request.id,result:'0x38'});
    assert.equal(request.method,'eth_getBlockByNumber');
    reads++;
    const old=reads===1;
    if(old){oldStarted();await gate;}
    return json({jsonrpc:'2.0',id:request.id,result:{number:'0xa',
      hash:old?oldHash:newHash,timestamp:'0x10',transactions:[]}});
  }});
  const numbered=rpc('eth_getBlockByNumber',['0xa',false]);
  const old=f.post(numbered);
  await started;
  assert.equal((await (await f.post(rpc('eth_getBlockByNumber',['latest',false]))).json()).result.hash,newHash);
  releaseOld();
  assert.equal((await (await old).json()).result.hash,oldHash);
  const current=await f.post({...numbered,id:3});
  assert.equal(current.headers.get('x-bemine-server-cache'),null);
  assert.equal((await current.json()).result.hash,newHash);
  assert.equal(reads,3);
});

test('oversized upstream bodies, timeout and exhausted concurrency are bounded', async t => {
  const huge = await fixture(t, { maxResponseBytes: 64, upstream: () => json({ oversized: 'x'.repeat(100) }) });
  assert.equal((await huge.post(rpc())).status, 502);
  const stalled = await fixture(t, { timeoutMs: 50, maxConcurrent: 1, maxQueued: 0,
    upstream: () => new Promise(() => {}) });
  const first = stalled.post(rpc());
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await stalled.post(rpc())).status, 503); assert.equal((await first).status, 504);
});

test('short bounded queue absorbs read bursts above the active RPC limit without skipping validation', async t => {
  let releaseFirst, active = 0, peak = 0, calls = 0;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const f = await fixture(t, { maxConcurrent: 1, maxQueued: 2, queueTimeoutMs: 500,
    upstream: async (_url, init) => {
      active++; peak = Math.max(peak, active); calls++;
      if (calls === 1) await gate;
      active--;
      return json({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: '0x38' });
    } });
  const read=rpc('eth_blockNumber');
  const first = f.post(read);
  while (calls === 0) await new Promise(resolve => setTimeout(resolve, 1));
  const second = f.post({ ...read, id: 2 });
  const third = f.post({ ...read, id: 3 });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await f.get('/api/chain-index/v1/private')).status, 404,
    'invalid routes must be rejected before they can occupy the queue');
  assert.equal((await f.post({ ...read, id: 4 })).status, 503,
    'the queue remains bounded under overload');
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second, third].map(async request => (await request).status)), [200, 200, 200]);
  assert.equal(peak, 1);
  assert.equal(calls, 4,'one chain proof plus three admitted reads');
});

test('one busy client cannot occupy every upstream slot or block another client behind its queue', async t => {
  let releaseFirst, firstStarted;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const started = new Promise(resolve => { firstStarted = resolve; });
  const f = await fixture(t, { maxConcurrent: 2, maxConcurrentPerClient: 1, maxQueued: 2,
    upstream: async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.method === 'eth_chainId') return json({ jsonrpc: '2.0', id: request.id, result: '0x38' });
      if (request.id === 1) { firstStarted(); await gate; }
      return json({ jsonrpc: '2.0', id: request.id, result: '0x10' });
    } });
  const from = (id, ip) => f.post({ ...rpc('eth_blockNumber'), id }, '/api/rpc',
    { headers: { 'content-type': 'application/json', 'x-real-ip': ip } });
  const first = from(1, '203.0.113.1');
  await started;
  const queued = from(2, '203.0.113.1');
  assert.equal((await from(3, '203.0.113.2')).status, 200,
    'another client must use the unoccupied upstream slot');
  releaseFirst();
  assert.deepEqual(await Promise.all([first, queued].map(async request => (await request).status)), [200, 200]);
});

test('one client hits its queue cap before consuming the global waiting room',async t=>{
  let releaseFirst,started;
  const gate=new Promise(resolve=>{releaseFirst=resolve;});
  const firstStarted=new Promise(resolve=>{started=resolve;});
  const f=await fixture(t,{maxConcurrent:1,maxConcurrentPerClient:1,maxQueued:4,maxQueuedPerClient:2,
    upstream:async(_url,init)=>{
      const request=JSON.parse(init.body);
      if(request.method==='eth_chainId')return json({jsonrpc:'2.0',id:request.id,result:'0x38'});
      if(request.id===1){started();await gate;}
      return json({jsonrpc:'2.0',id:request.id,result:'0x10'});
    }});
  const from=(id,ip)=>f.post({...rpc('eth_blockNumber'),id},'/api/rpc',
    {headers:{'content-type':'application/json','x-real-ip':ip}});
  const first=from(1,'203.0.113.1');await firstStarted;
  const queued=[from(2,'203.0.113.1'),from(3,'203.0.113.1')];
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal((await from(4,'203.0.113.1')).status,429);
  const other=from(5,'203.0.113.2');
  releaseFirst();
  assert.deepEqual(await Promise.all([first,...queued,other].map(async request=>(await request).status)),[200,200,200,200]);
});

test('two saturated clients cannot prevent a third visitor from getting a prompt queue slot',async t=>{
  let releaseActive,startedCount=0,startBoth;
  const gate=new Promise(resolve=>{releaseActive=resolve;});
  const bothStarted=new Promise(resolve=>{startBoth=resolve;});
  const served=[];
  const f=await fixture(t,{maxConcurrent:2,maxConcurrentPerClient:1,maxQueued:4,maxQueuedPerClient:2,
    upstream:async(_url,init)=>{
      const request=JSON.parse(init.body);
      if(request.method==='eth_chainId')return json({jsonrpc:'2.0',id:request.id,result:'0x38'});
      served.push(request.id);
      if(request.id===1||request.id===2){if(++startedCount===2)startBoth();await gate;}
      return json({jsonrpc:'2.0',id:request.id,result:'0x10'});
    }});
  const from=(id,ip)=>f.post({...rpc('eth_blockNumber'),id},'/api/rpc',
    {headers:{'content-type':'application/json','x-real-ip':ip}});
  const active=[from(1,'203.0.113.1'),from(2,'203.0.113.2')];await bothStarted;
  const waiting=[from(3,'203.0.113.1'),from(4,'203.0.113.1'),
    from(5,'203.0.113.2'),from(6,'203.0.113.2')];
  await new Promise(resolve=>setTimeout(resolve,10));
  const newcomer=from(7,'203.0.113.3');
  await new Promise(resolve=>setTimeout(resolve,10));
  releaseActive();
  assert.equal((await newcomer).status,200,'the newcomer must not inherit the two saturated queues');
  const statuses=await Promise.all([...active,...waiting].map(async request=>(await request).status));
  assert.equal(statuses.filter(status=>status===429).length,1,'one duplicate waiter makes room for the newcomer');
  assert(statuses.every(status=>status===200||status===429));
  assert(served.indexOf(7)<4,`round-robin dispatch delayed visitor 7 behind ${served}`);
});

test('default queue admits one portfolio page burst without unbounded upstream concurrency', async t => {
  let releaseReads, active = 0, peak = 0;
  const gate = new Promise(resolve => { releaseReads = resolve; });
  const f = await fixture(t, { upstream: async (_url, init) => {
    const request = JSON.parse(init.body);
    if (request.method === 'eth_chainId') return json({ jsonrpc: '2.0', id: request.id, result: '0x38' });
    active++; peak = Math.max(peak, active);
    await gate;
    active--;
    return json({ jsonrpc: '2.0', id: request.id, result: '0x10' });
  } });
  const requests = Array.from({ length: 104 }, (_, id) => f.post({ ...rpc('eth_blockNumber'), id: id + 1 }));
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
  } finally { releaseReads(); }
  const statuses = await Promise.all(requests.map(async request => (await request).status));
  assert(statuses.every(status => status === 200), `portfolio burst returned ${statuses.filter(status => status !== 200)}`);
  assert(peak <= 24, 'the queue must not bypass the upstream concurrency cap');
});

test('queued reads expire instead of waiting behind a stalled upstream', async t => {
  let releaseFirst, calls = 0;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const f = await fixture(t, { maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 20, timeoutMs: 1000,
    upstream: async (_url, init) => {
      calls++;
      if (calls === 1) await gate;
      return json({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: '0x38' });
    } });
  const read=rpc('eth_blockNumber');
  const first = f.post(read);
  while (calls === 0) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal((await f.post({ ...read, id: 2 })).status, 503);
  releaseFirst();
  assert.equal((await first).status, 200);
  assert.equal((await f.post({ ...read, id: 3 })).status, 200);
  assert.equal(calls, 3, 'one chain proof and two reads; the expired request never reaches the RPC upstream');
});

test('upstream error details are not reflected to visitors', async t => {
  const f = await fixture(t, { upstream: (_url,init) => {
    const request=JSON.parse(init.body);
    return request.method==='eth_chainId' ? json({jsonrpc:'2.0',id:request.id,result:'0x38'})
      : json({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'private-key-or-secret-url' } });
  } });
  const result = await f.post(rpc('eth_blockNumber')); assert.equal(result.status, 200); assert(!(await result.text()).includes('private-key-or-secret-url'));
});

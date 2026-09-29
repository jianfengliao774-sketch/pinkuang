import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveDataProxy, liveDataProxyConfiguration, validateReadRpc } from './live-data-proxy.mjs';
import { createDeploymentServer } from './index.mjs';

const address = `0x${'11'.repeat(20)}`;
const rpc = (method = 'eth_chainId', params = []) => ({ jsonrpc: '2.0', id: 1, method, params });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
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
  assert.deepEqual(liveDataProxyConfiguration({}), { rpcUrl: null, indexUrl: 'http://127.0.0.1:4180/' });
  assert.equal(liveDataProxyConfiguration({ DEPLOYMENT_JOURNAL_RPC_URL: 'https://bsc.example/rpc' }).rpcUrl, 'https://bsc.example/rpc');
  assert.equal(liveDataProxyConfiguration({ BEMINE_READ_RPC_URL: 'https://a.test', DEPLOYMENT_JOURNAL_RPC_URL: 'https://b.test' }).rpcUrl, 'https://a.test/');
  for (const value of ['file:///etc/passwd', 'https://user:password@rpc.test', 'https://rpc.test/#secret']) assert.throws(() => liveDataProxyConfiguration({ BEMINE_READ_RPC_URL: value }));
  assert.throws(() => liveDataProxyConfiguration({ BEMINE_INDEX_URL: 'http://127.0.0.1:4180?url=http://evil.test' }));
});

test('all six read methods accept exact bounded parameters; unknown/write/batch/override routes fail closed', () => {
  const calls = [rpc(), rpc('eth_blockNumber'), rpc('eth_getBlockByNumber', ['0xa', false]), rpc('eth_getCode', [address, 'latest']),
    rpc('eth_getStorageAt', [address, '0x0', '0xa']), rpc('eth_call', [{ to: address, data: '0xab' }, '0xa'])];
  for (const input of calls) assert.equal(validateReadRpc(input).method, input.method);
  assert.equal(validateReadRpc(calls.at(-1)).params[0].gas, '0x1c9c380');
  for (const input of [rpc('eth_sendTransaction', [{}]), rpc('eth_sendRawTransaction', ['0xab']), rpc('personal_sign'), rpc('eth_requestAccounts'),
    rpc('debug_traceCall'), [rpc()], { ...rpc(), id: null }, { ...rpc(), url: 'https://evil.test' },
    rpc('eth_getBlockByNumber', ['latest', true]), rpc('eth_call', [{ to: address, data: '0x' }, 'latest', {}]),
    rpc('eth_call', [{ to: address, data: '0x', gas: '0x1c9c381' }, 'latest']), rpc('eth_call', [{ data: '0x' }, 'latest'])]) assert.throws(() => validateReadRpc(input));
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
    '/v1/snapshot/pools?cursor=0&limit=20', '/v1/snapshot/portfolios?limit=20', '/v1/snapshot/stats',
    `/v1/snapshot/orders?active=true&seller=${address}&limit=20`,
    `/v1/orders?pool=${address}&seller=${address}&active=true&cursor=8`, `/v1/activity?cursor=10:2:1&account=${address}`,
    `/v1/yield?pool=${address}&days=30`]) assert.equal((await f.get(`/api/chain-index${path}`)).status, 200);
  assert(f.calls.every(call => call.url.startsWith('http://127.0.0.1:4180/') && call.init.method === 'GET'));
  const count = f.calls.length;
  for (const path of ['/v1/private', '/v1/notifications', '/v1/pools?url=http://evil.test', '/v1/pools?limit=1&limit=2', '/v1/pools?limit=51',
    '/v1/orders?cursor=0', '/v1/orders?active=maybe', '/v1/activity?cursor=1:2:Infinity', '/v1/yield?days=30']) assert((await f.get(`/api/chain-index${path}`)).status >= 400);
  assert.equal((await f.post(rpc(), '/api/chain-index/v1/pools')).status, 405); assert.equal(f.calls.length, count);
});

test('missing RPC configuration is explicit 503, not dummy chain data', async t => {
  const f = await fixture(t, { rpcUrl: null }); assert.equal((await f.post(rpc())).status, 503); assert.equal(f.calls.length, 0);
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

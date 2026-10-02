import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { Interface, ZeroAddress, keccak256, toQuantity } from 'ethers';
import { chainIndexFailureMessage, chainIndexSyncDelay, refreshDisplayCaches, serverConfiguration, startChainIndex } from './server.mjs';
import { createFreshIndexManifest, freshIndexManifestBytes, freshIndexManifestSha256 } from './fresh-manifest.mjs';
import { ChainIndex } from './indexer.mjs';

const config = rpc => ({ rpc, host: '127.0.0.1', port: 0, dbPath: ':memory:',
  factory: '0x0000000000000000000000000000000000000001',
  market: '0x0000000000000000000000000000000000000002', startBlock: 1, confirmations: 2 });
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function stop(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

test('a failed budget cache does not block updated single-pool event publication', async()=>{
  let rows=0, published=0, errors=0;
  const results=await refreshDisplayCaches({
    displayCache:{refresh:async()=>{rows=100;}},
    portfolioReads:{refresh:async()=>{throw new Error('Budget provider temporarily unavailable');}},
    displayEvents:{publish:()=>{assert.equal(rows,100);published++;}},onError:()=>errors++,
  });
  assert.equal(published,1);assert.equal(errors,1);
  assert.deepEqual(results.map(item=>item.status),['fulfilled','rejected']);
});

test('failed or stopped materializers do not announce a fresh generation', async()=>{
  let published=0,errors=0;
  const fail={refresh:()=>{throw new Error('Unavailable');}};
  const displayEvents={publish:()=>published++};
  await refreshDisplayCaches({displayCache:fail,portfolioReads:fail,displayEvents,onError:()=>errors++});
  await refreshDisplayCaches({portfolioReads:{refresh:async()=>{}},displayEvents,isStopped:()=>true});
  await refreshDisplayCaches({displayEvents});
  assert.equal(published,0);assert.equal(errors,1);
  await refreshDisplayCaches({portfolioReads:{refresh:async()=>{}},displayEvents});
  assert.equal(published,1);
});

test('production configuration keeps HTTPS and loopback requirements', () => {
  const env = { CHAIN_INDEX_RPC_URL: 'https://bsc-rpc.blockreq.com/v1/rpc/public',
    CHAIN_INDEX_DB: '/tmp/index.sqlite', CHAIN_INDEX_FACTORY: config('').factory,
    CHAIN_INDEX_MARKET: config('').market, CHAIN_INDEX_START_BLOCK: '100' };
  assert.equal(serverConfiguration(env).rpc, env.CHAIN_INDEX_RPC_URL);
  assert.equal(serverConfiguration(env).host, '127.0.0.1');
  assert.equal(serverConfiguration(env).reservationMode,'legacy');
  assert.throws(()=>serverConfiguration({...env,CHAIN_INDEX_RESERVATION_MODE:'required'}),/portfolio Factory/);
  assert.equal(serverConfiguration({...env,CHAIN_INDEX_PORTFOLIO_FACTORY:config('').factory,
    CHAIN_INDEX_PORTFOLIO_MARKET:config('').market,CHAIN_INDEX_RESERVATION_MODE:'required'}).reservationMode,'required');
  assert.throws(()=>serverConfiguration({...env,CHAIN_INDEX_RESERVATION_MODE:'auto'}),/reservation mode/);
  assert.equal(serverConfiguration(env).scanRange, 100);
  assert.equal(serverConfiguration(env).maxBlocksPerSync,2000);
  assert.equal(serverConfiguration(env).headerConcurrency,64);
  assert.equal(serverConfiguration({...env,CHAIN_INDEX_MAX_BLOCKS_PER_SYNC:'500',CHAIN_INDEX_HEADER_CONCURRENCY:'32'}).headerConcurrency,32);
  for(const value of ['0','2001','-1','1.5','02'])
    assert.throws(()=>serverConfiguration({...env,CHAIN_INDEX_MAX_BLOCKS_PER_SYNC:value}),/blocks per sync/);
  for(const value of ['0','65','-1','1.5','08'])
    assert.throws(()=>serverConfiguration({...env,CHAIN_INDEX_HEADER_CONCURRENCY:value}),/concurrency/);
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
  assert.equal(serverConfiguration({ ...env, CHAIN_INDEX_LOGS_FALLBACK_RPC_URL: 'https://bsc.publicnode.com' }).fallbackLogsRpc, 'https://bsc.publicnode.com');
  assert.throws(() => serverConfiguration({ ...env, CHAIN_INDEX_RPC_URL: 'http://untrusted.example' }), /HTTPS/);
  assert.throws(() => serverConfiguration({ ...env, CHAIN_INDEX_HOST: '0.0.0.0' }), /loopback/);
  assert.throws(() => serverConfiguration({ ...env, CHAIN_INDEX_LOGS_RPC_URL: 'http://untrusted.example' }), /HTTPS/);
  assert.throws(() => serverConfiguration({ ...env, CHAIN_INDEX_LOGS_FALLBACK_RPC_URL: 'http://untrusted.example' }), /HTTPS/);
  assert.throws(() => serverConfiguration({ ...env, CHAIN_INDEX_LOGS_RPC_URL: 'https://bsc.publicnode.com', CHAIN_INDEX_LOGS_FALLBACK_RPC_URL: 'https://bsc.publicnode.com' }), /differ/);
});

test('fresh v4 index derives all addresses and start block only from a pinned manifest', () => {
  const dir=mkdtempSync(join(tmpdir(),'fresh-v4-index-test-'));
  const names=['factory','shareMarket','lens','beacon','timelock','portfolioFactory',
    'portfolioMarket','portfolioBeacon','portfolioImplementation','portfolioFactoryImplementation'];
  const addr=n=>`0x${n.toString(16).padStart(40,'0')}`;
  const hash=n=>`0x${n.toString(16).padStart(64,'0')}`;
  const source={schemaVersion:1,kind:'integrated-v2',chainId:56,artifactDigest:hash(1),
    deployment:{txHash:hash(2),blockNumber:115,blockHash:hash(3)},
    verifiedBlockNumber:206,verifiedBlockHash:hash(4),
    ...Object.fromEntries(names.map((name,i)=>[name,addr(i+1)])),
    codehash:Object.fromEntries(names.map(name=>[name,hash(5)])),
    authority:addr(20),gasWallet:addr(21),
    freshAuthority:{address:addr(20),gasWallet:addr(21),codehash:hash(6),
      deploymentTxHash:hash(7),administratorOne:addr(22),administratorTwo:addr(23)}};
  const manifest=createFreshIndexManifest(source);
  const path=join(dir,'fresh-product-manifest.json');
  writeFileSync(path,freshIndexManifestBytes(manifest));
  const env={CHAIN_INDEX_MODE:'fresh-v4',CHAIN_INDEX_RPC_URL:'https://bsc.publicnode.com',
    CHAIN_INDEX_DB:join(dir,'index.sqlite'),CHAIN_INDEX_FRESH_MANIFEST_PATH:path,
    CHAIN_INDEX_FRESH_MANIFEST_SHA256:freshIndexManifestSha256(manifest)};
  try {
    const config=serverConfiguration(env);
    assert.equal(config.factory,manifest.factory);
    assert.equal(config.market,manifest.shareMarket);
    assert.equal(config.portfolioFactory,manifest.portfolioFactory);
    assert.equal(config.portfolioMarket,manifest.portfolioMarket);
    assert.equal(config.startBlock,115);
    assert.equal(config.maxBlocksPerSync,2000);assert.equal(config.headerConcurrency,64);
    assert.equal(config.reservationMode,'required');
    assert.equal(config.freshCodehashes.length,11);
    assert.deepEqual(config.freshCodehashes.at(-1),{address:manifest.authority,expected:manifest.freshAuthority.codehash});
    assert.throws(()=>serverConfiguration({...env,NODE_ENV:'production'}),/independent database path/);
    assert.throws(()=>serverConfiguration({...env,NODE_ENV:'production',
      CHAIN_INDEX_DB:'/var/lib/pinkuang-index-v4/index.sqlite'}),/release-pinned manifest path/);
    assert.throws(()=>serverConfiguration({...env,CHAIN_INDEX_FACTORY:addr(99)}),/cannot override/);
    assert.throws(()=>serverConfiguration({...env,CHAIN_INDEX_START_BLOCK:'1'}),/cannot override/);
    assert.throws(()=>serverConfiguration({...env,CHAIN_INDEX_FRESH_MANIFEST_SHA256:'0'.repeat(64)}),/SHA256 differs/);
    writeFileSync(path,Buffer.from(freshIndexManifestBytes(manifest).toString().replace(manifest.factory,addr(99))));
    assert.throws(()=>serverConfiguration(env),/SHA256 differs/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('fresh index verifies pinned codehashes at first sync and each 20-block interval', async () => {
  const address=n=>`0x${n.toString(16).padStart(40,'0')}`;
  const factory=address(1), shareMarket=address(2), portfolioFactory=address(3), portfolioMarket=address(4);
  const graph=Array.from({length:11},(_,i)=>address(i+1));
  const expected=keccak256('0x6001');
  const freshCodehashes=graph.map(address=>({address,expected}));
  const iface=new Interface(['function shareMarket() view returns(address)',
    'function factory() view returns(address)','function legacyFactory() view returns(address)']);
  let changed=null, unavailable=null;
  const codeReads=[];
  const provider={
    send:async()=> '0x38',getLogs:async()=>[],
    getCode:async (to,block)=>{
      codeReads.push({to,block});
      if(to.toLowerCase()===unavailable) throw new Error('upstream unavailable');
      return to.toLowerCase()===changed?'0x6002':'0x6001';
    },
    call:async ({to,data})=>{
      const parsed=iface.parseTransaction({data});
      const result=parsed.name==='legacyFactory'?factory
        : parsed.name==='shareMarket'?(to.toLowerCase()===factory.toLowerCase()?shareMarket:portfolioMarket)
        : to.toLowerCase()===shareMarket.toLowerCase()?factory:portfolioFactory;
      return iface.encodeFunctionResult(parsed.fragment,[result]);
    },
  };
  const index=new ChainIndex(provider,{dbPath:':memory:',factory,market:shareMarket,portfolioFactory,portfolioMarket,
    reservationMode:'required',startBlock:1,freshCodehashes});
  try {
    await index._verifyDeployment(100);
    assert.equal(index.freshCodehashVerifiedAt,100);
    assert.equal(codeReads.filter(read=>read.block===100).length,15);
    await index._verifyDeployment(119);
    assert.equal(codeReads.filter(read=>read.block===119).length,4,'ordinary sync only checks core bindings');
    changed=graph[8].toLowerCase();
    await assert.rejects(index._verifyDeployment(120),/Fresh manifest codehash mismatch/);
    assert.equal(index.freshCodehashVerifiedAt,100,'mismatch must not advance proof cadence');
    changed=null; unavailable=graph[9].toLowerCase();
    await assert.rejects(index._verifyDeployment(120),/upstream unavailable/);
    assert.equal(index.freshCodehashVerifiedAt,100,'RPC failure must not advance proof cadence');
    unavailable=null;
    await index._verifyDeployment(120);
    assert.equal(index.freshCodehashVerifiedAt,120);
  } finally { index.close(); }
});

test('sync failure diagnostics identify a bounded RPC method without leaking provider URLs', () => {
  const error = Object.assign(new Error('upstream https://rpc.example/?token=secret'), {
    rpcMethod: 'eth_getLogs', code: 'SERVER_ERROR', error: { code: -32005, body: 'private response' },
    info: { response: { statusCode: 429, body: 'another private response' } },
  });
  const message = chainIndexFailureMessage({ status: () => ({ unknownReason: 'sync_failed' }), lastFailureStage: 'scan_factory_logs' }, error);
  assert.match(message, /stage=scan_factory_logs; method=eth_getLogs; type=Error; code=SERVER_ERROR; rpcCode=-32005; httpStatus=429/);
  assert.equal(message.includes('secret'), false);
  assert.equal(message.includes('private response'), false);
});

const binding = new Interface(['function shareMarket() view returns(address)', 'function factory() view returns(address)',
  'function poolCount() view returns(uint256)', 'function nextOrderId() view returns(uint256)']);
const hex = number => `0x${number.toString(16).padStart(64, '0')}`;
function rpcFixture({ logs = false, logsFailure = false, logsBehind = false, logsFork = false, chainId = '0x38', chainIdFailure = false, firstLogsDelayMs = 0, latestNumber = 4 } = {}) {
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
      } else if (payload.method === 'eth_getBlockByNumber' && logs) {
        const number = Number(BigInt(payload.params[0]));
        result = logsBehind ? null : { number: toQuantity(number), hash: hex(number + (logsFork ? 100 : 0)),
          parentHash: hex(number - 1), timestamp: toQuantity(1_800_000_000 + number),
          nonce: '0x0000000000000000', difficulty: '0x0', gasLimit: '0x1c9c380', gasUsed: '0x0',
          extraData: '0x', miner: ZeroAddress, transactions: [] };
      } else {
        assert.equal(logs, false, 'header/call/code request reached the logs-only RPC');
        if (payload.method === 'eth_getBlockByNumber') {
          const number = payload.params[0] === 'latest' ? latestNumber : Number(BigInt(payload.params[0]));
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
    if (chainIdFailure && list.some(payload => payload.method === 'eth_chainId')) {
      response.writeHead(403, { 'content-type': 'application/json' }); response.end('{"error":"forbidden"}');
    } else if (logsFailure && list.some(payload => payload.method === 'eth_getLogs')) {
      response.writeHead(429, { 'Retry-After': '90' }); response.end('rate limited');
    } else { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(Array.isArray(input) ? replies : replies[0])); }
  });
  return { server, calls };
}
async function until(check, ms = 2_000) {
  const deadline = performance.now() + ms;
  while (!check()) { assert(performance.now() < deadline, 'condition did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('successful bounded catch-up continues without a one-second pause and stops scheduling when closed', async()=>{
  const primary=rpcFixture({latestNumber:38}),logs=rpcFixture({logs:true});let service;
  try {
    const rpc=await listen(primary.server),logsRpc=await listen(logs.server);
    service=await startChainIndex({...config(rpc),logsRpc,scanRange:12,maxBlocksPerSync:12,headerConcurrency:64});
    await until(()=>service.index.status().complete);
    const latestReads=primary.calls.filter(row=>row.method==='eth_getBlockByNumber'&&row.params[0]==='latest');
    assert.equal(latestReads.length,3);
    for(let i=1;i<latestReads.length;i++)assert(latestReads[i].at-latestReads[i-1].at<900,
      'a successful progress cycle must yield and continue without polling delay');
    assert.equal(service.index.indexedThrough,36);
    assert.equal(service.index.db.prepare('SELECT COUNT(*) AS n FROM headers').get().n,36);
    await service.close();const count=primary.calls.length+logs.calls.length;
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(primary.calls.length+logs.calls.length,count);
  } finally {await service?.close();await stop(primary.server);await stop(logs.server);}
  assert.equal(chainIndexSyncDelay({complete:false,progressed:false}),1000,'idle incomplete state is bounded');
  assert.equal(chainIndexSyncDelay({complete:true,progressed:true}),10000);
  assert.equal(chainIndexSyncDelay({failures:1,progressed:true}),4000,'partial progress must not bypass failure backoff');
  assert.equal(chainIndexSyncDelay({failures:5}),60000);
});

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
    assert(logs.calls.every(row => ['eth_chainId', 'eth_getLogs', 'eth_getBlockByNumber'].includes(row.method)));
    assert(logs.calls.findIndex(row => row.method === 'eth_chainId') < logs.calls.findIndex(row => row.method === 'eth_getLogs'));
  } finally { await service?.close(); await stop(primary.server); await stop(logs.server); }
});

test('a lagging or forked logs RPC cannot silently commit empty event ranges', async () => {
  for (const options of [{ logsBehind: true }, { logsFork: true }]) {
    const primary = rpcFixture(), logs = rpcFixture({ logs: true, ...options }); let service;
    try {
      const rpc = await listen(primary.server), logsRpc = await listen(logs.server);
      service = await startChainIndex({ ...config(rpc), logsRpc });
      await until(() => service.index.status().unknownReason === 'sync_failed');
      assert.equal(service.index.indexedThrough, 0);
      assert.equal(logs.calls.filter(row => row.method === 'eth_getLogs').length, 0);
    } finally { await service?.close(); await stop(primary.server); await stop(logs.server); }
  }
});

test('an independently verified fallback logs RPC recovers a failed primary logs request', async () => {
  const primary = rpcFixture(), logs = rpcFixture({ logs: true, logsFailure: true }), fallback = rpcFixture({ logs: true }); let service;
  try {
    const rpc = await listen(primary.server), logsRpc = await listen(logs.server), fallbackLogsRpc = await listen(fallback.server);
    service = await startChainIndex({ ...config(rpc), logsRpc, fallbackLogsRpc });
    await until(() => service.index.status().complete);
    assert.equal(service.index.indexedThrough, 2);
    assert(logs.calls.some(row => row.method === 'eth_getLogs'));
    assert(fallback.calls.some(row => row.method === 'eth_getLogs'));
    assert(fallback.calls.some(row => row.method === 'eth_getBlockByNumber'));
  } finally { await service?.close(); await stop(primary.server); await stop(logs.server); await stop(fallback.server); }
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


test('an unused forbidden fallback cannot block healthy indexing or empty its display directory', async () => {
  const primary = rpcFixture(), logs = rpcFixture({ logs: true });
  const fallback = rpcFixture({ logs: true, chainIdFailure: true }); let service;
  try {
    const rpc = await listen(primary.server), logsRpc = await listen(logs.server), fallbackLogsRpc = await listen(fallback.server);
    service = await startChainIndex({ ...config(rpc), logsRpc, fallbackLogsRpc });
    await until(() => service.index.status().complete);
    assert.equal(service.index.indexedThrough, 2);
    assert.equal(fallback.calls.length, 0, 'unused fallback never participates in the primary sync');
    assert(logs.calls.some(row => row.method === 'eth_chainId'));
    assert(logs.calls.some(row => row.method === 'eth_getLogs'));
  } finally { await service?.close(); await stop(primary.server); await stop(logs.server); await stop(fallback.server); }
});

test('a logs identity outage can use the independently checked fallback', async () => {
  const primary = rpcFixture(), logs = rpcFixture({ logs: true, chainIdFailure: true });
  const fallback = rpcFixture({ logs: true }); let service;
  try {
    const rpc = await listen(primary.server), logsRpc = await listen(logs.server), fallbackLogsRpc = await listen(fallback.server);
    service = await startChainIndex({ ...config(rpc), logsRpc, fallbackLogsRpc });
    await until(() => service.index.status().complete);
    assert.equal(service.index.indexedThrough, 2);
    assert.equal(logs.calls.filter(row => row.method === 'eth_getLogs').length, 0);
    assert(fallback.calls.some(row => row.method === 'eth_chainId'));
    assert(fallback.calls.some(row => row.method === 'eth_getBlockByNumber'));
    assert(fallback.calls.some(row => row.method === 'eth_getLogs'));
  } finally { await service?.close(); await stop(primary.server); await stop(logs.server); await stop(fallback.server); }
});

test('a fallback on a different chain cannot rescue failed logs or advance the cursor', async () => {
  const primary = rpcFixture(), logs = rpcFixture({ logs: true, chainIdFailure: true });
  const fallback = rpcFixture({ logs: true, chainId: '0x1' }); let service;
  try {
    const rpc = await listen(primary.server), logsRpc = await listen(logs.server), fallbackLogsRpc = await listen(fallback.server);
    service = await startChainIndex({ ...config(rpc), logsRpc, fallbackLogsRpc });
    await until(() => service.index.status().unknownReason === 'wrong_chain');
    assert.equal(service.index.indexedThrough, 0);
    assert.equal(fallback.calls.filter(row => row.method === 'eth_getLogs').length, 0);
  } finally { await service?.close(); await stop(primary.server); await stop(logs.server); await stop(fallback.server); }
});

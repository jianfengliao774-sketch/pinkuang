import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface, ZeroAddress } from 'ethers';
import { abi } from '../../../web/lib/chain-client.mjs';
import { PoolDisplayCache, cacheDecode } from './pool-display-cache.mjs';
import { createChainIndexServer } from './api.mjs';
const address=n=>'0x'+String(n).padStart(40,'0');
const factory=address(1),lens=address(2),pool=address(3),account=address(4),market=address(5);
const blockHash='0x'+'ab'.repeat(32);
const creationBlockHash='0x'+'05'.repeat(32);
const collection='0xb1024b89886b9a34aa4ff5f31c411d708b20a14c';
const binding=new Interface(['function lens() view returns(address)','function factory() view returns(address)','function VERSION() view returns(uint256)']);
const targetOwnerAbi=new Interface(['function ownerOf(uint256) view returns(address)']);
const targetModeAbi=new Interface(['function flexiblePurchase() view returns(bool enabled,uint256 referenceCircuitId,(uint128 minVerifiedWeight,uint256 referencePriceWei,uint256 targetDailyYieldAtomic,uint16 extraBps,uint64 referenceObservedAt,uint64 referenceBlock,bytes32 referenceDigest) config)']);
function fixture() {
  let fork=false,failed=false,calls=0,time=1000000,tokenId=12962n,state=2n,currentOwner=account,targetFailed=false;
  const position={shares:50n,claimableBEM:7n,bnbOwed:11n,contributedWei:55550000000000000n};
  const targetCalls=[];
  const source={complete:true,unknownReason:null,chainId:56,factory,market,startBlock:1,confirmations:12,
    indexedThrough:10,indexedTimestamp:1000,observedSafeHead:10,indexedBlockHash:blockHash,
    checkedAt:new Date(time).toISOString(),registeredPoolCount:'1'};
  const directory={source,pools:[{address:pool,createdBlock:5,collection,circuitId:'12962'}],orders:[],stats:{scope:'confirmed_indexed_history',registeredPoolCount:'1'}};
  const index={factory,market,snapshotTrusted:true,_header:block=>({hash:fork?'0x'+'cd'.repeat(32):block===5?creationBlockHash:source.indexedBlockHash}),
    verifiedDisplaySnapshot:()=>index.snapshotTrusted?directory:null,status:()=>source,syncing:false,
    db:{prepare:query=>query.startsWith('SELECT address')?{all:()=>[{address:pool}]}:query.includes("kind='factory'")
      ?{iterate:()=>[{block_number:5,tx_index:1,log_index:3,args:JSON.stringify({pool,circuits:collection,circuitId:'12962'})}]}
      :{iterate:()=>[{args:JSON.stringify({user:account})}],get:()=>null}}};
  const provider={getBlock:async block=>{calls++;return {hash:fork?'0x'+'cd'.repeat(32):block===5?creationBlockHash:source.indexedBlockHash,timestamp:1000};},
    getLogs:async()=>{calls++;targetCalls.push('transfers');return [];},
    send:async(method,params)=>{
      calls++;if(failed) throw new Error('offline');if(method==='eth_chainId') return '0x38';
      assert.equal(method,'eth_call');
      if(params[0].to===collection) {
        targetCalls.push('owner:'+params[1]);if(targetFailed)throw new Error('owner unavailable');
        return targetOwnerAbi.encodeFunctionResult('ownerOf',[params[1]==='0x5'?account:currentOwner]);
      }
      if(params[0].to===pool) {
        targetCalls.push('mode');return targetModeAbi.encodeFunctionResult('flexiblePurchase',
          [false,tokenId,[0n,0n,0n,0n,0n,0n,'0x'+'00'.repeat(32)]]);
      }
      assert.equal(params[1],'0x'+source.indexedThrough.toString(16));
      const request=params[0],iface=request.to===market?abi.ShareMarket:request.to===lens && request.data.startsWith(abi.PoolLens.getFunction('positions').selector)?abi.PoolLens:binding;
      const call=iface.parseTransaction(request);let value;
      if(call.name==='lens')value=lens;else if(call.name==='factory')value=factory;else if(call.name==='VERSION')value=1n;
      else if(call.name==='bnbOwed')value=13n;else {
        const own=call.args[1].toLowerCase()===account;
        value={blockNumber:BigInt(source.indexedThrough),timestamp:1000n,totalPools:1n,nextCursor:1n,registryCountValid:true,pools:[{
          pool,status:{validMask:(1n<<17n)-1n,errorMask:0n,trustError:0n},
          params:{circuits:collection,circuitId:tokenId,targetRaise:111100000000000000n,priceCap:101000000000000000n,
            directSeller:ZeroAddress,directPrice:0n,fundingDeadline:2000n,purchaseDeadline:3000n},
          state,unitPriceWei:1111000000000000n,totalRaised:111100000000000000n,totalSupply:100n,memberCount:2n,
          depositPaused:false,purchaseCost:101000000000000000n,activatedAt:500n,shareTradingAllowed:true,
          shares:own?position.shares:0n,lockedShares:0n,availableShares:own?position.shares:0n,
          claimableBEM:own?position.claimableBEM:0n,bnbOwed:own?position.bnbOwed:0n,
          initialContributedWei:own?position.contributedWei:0n}]};
      }
      return iface.encodeFunctionResult(call.name,[value]);
    }};
  return {index,provider,now:()=>time,get calls(){return calls;},fork:()=>{fork=true;},fail:()=>{failed=true;},advance:n=>{time+=n;},
    targetCalls,setOwner:value=>{currentOwner=value;},failTarget:()=>{targetFailed=true;},
    setPosition:value=>{Object.assign(position,value);},
    nextBlock:()=>{source.indexedThrough++;source.observedSafeHead=source.indexedThrough;
      source.indexedBlockHash='0x'+source.indexedThrough.toString(16).padStart(64,'0');},
    setToken:value=>{tokenId=BigInt(value);},setState:value=>{state=BigInt(value);}};
}

test('background materialization persists exact public and per-wallet state; HTTP cache reads make zero RPC calls',async()=>{
  const f=fixture(),dir=mkdtempSync(join(tmpdir(),'pool-display-')),path=join(dir,'cache.json');
  const cache=new PoolDisplayCache(f.index,f.provider,{lens,path,now:f.now,quoteLoader:async()=>({asset:{collection,tokenId:'12962',
    mining:{status:'verified',estimated24hAtomic:'432000',tokenSymbol:'BEM',tokenDecimals:8}}})});let server;
  try {
    await cache.refresh();await cache.quoteRunning;const saved=cache.snapshot();assert(saved);
    assert.equal(saved.rows[pool].shares,null);assert.equal(saved.accountRows[account][pool].shares,50n);
    assert.equal(saved.rows[pool].params.targetRaise,111100000000000000n);
    assert.equal(saved.stats.currentlyActivePoolCount,'1');assert.equal(saved.stats.estimatedDailyBemAtomic,'432000');
    assert.equal(saved.stats.miningOverview.dailyOutputComplete,true);assert.match(cache.revision(),/^[a-f\d]{64}$/);
    const reopened=new PoolDisplayCache(f.index,f.provider,{lens,path,now:f.now});assert.equal(reopened.snapshot().accountRows[account][pool].bnbOwed,11n);
    assert.equal(reopened.miningOverview.snapshot(Object.values(reopened.snapshot().rows)).estimatedDailyBemAtomic,'432000');await reopened.close();
    server=createChainIndexServer(f.index,{displayCache:cache});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`,before=f.calls;
    for(const route of [`/v1/display/pools/${pool}`,`/v1/display/pools/${pool}?account=${account}`,
      `/v1/display/positions/${account}`,'/v1/display/pools','/v1/display/stats','/v1/display/orders']) {
      const response=await fetch(base+route);assert.equal(response.status,200);
      const body=JSON.parse(await response.text(),cacheDecode);assert.equal(body.source.cacheOrigin,'server');
      assert.equal(body.source.transactionReady,false);
      if(route.endsWith('?account='+account))assert.equal(body.data.item.shares,50n);
      if(route===`/v1/display/pools/${pool}`)assert.equal(body.data.item.shares,null);
      if(route==='/v1/display/stats') {assert.equal(body.data.currentlyActivePoolCount,'1');assert.equal(body.data.estimatedDailyBemAtomic,'432000');}
    }
    assert.equal(f.calls,before);
    f.fail();await assert.rejects(cache.refresh(),/offline/);assert.equal(cache.snapshot().rows[pool].unitPriceWei,1111000000000000n);
    f.fork();assert.equal(cache.snapshot(),null);
  } finally {await cache.close();if(server)await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});
test('expired or invalidated caches cannot be served after restart',async()=>{
  const f=fixture(),cache=new PoolDisplayCache(f.index,f.provider,{lens,now:f.now});await cache.refresh();
  f.advance(30*60_000+1);assert.equal(cache.snapshot(),null);await cache.close();
});

test('public overview expires a quote after ten minutes even when RPC refresh fails or the cache reopens',async()=>{
  const f=fixture(),dir=mkdtempSync(join(tmpdir(),'pool-display-ttl-')),path=join(dir,'cache.json');
  const cache=new PoolDisplayCache(f.index,f.provider,{lens,path,now:f.now,quoteLoader:async()=>({asset:{collection,tokenId:'12962',
    mining:{status:'verified',estimated24hAtomic:'432000',tokenSymbol:'BEM',tokenDecimals:8}}})});
  let reopened,server;
  try {
    await cache.refresh();await cache.quoteRunning;
    const initial=cache.snapshot(),initialRevision=cache.revision(),disk=readFileSync(path,'utf8');
    assert.equal(initial.stats.estimatedDailyBemAtomic,'432000');
    f.advance(10*60_000+1);f.fail();await assert.rejects(cache.refresh(),/offline/);
    const expired=cache.snapshot();assert(expired,'business data remains within its separate thirty-minute lifetime');
    assert.equal(expired.accountRows[account][pool].shares,50n);
    assert.equal(expired.stats.currentlyActivePoolCount,'1');assert.equal(expired.stats.estimatedDailyBemAtomic,null);
    assert.equal(expired.stats.miningOverview.dailyOutputComplete,false);assert.equal(expired.stats.miningOverview.quotedMinerCount,'0');
    assert.equal(expired.stats.miningOverview.missingMinerCount,'1');assert.equal(expired.stats.miningOverview.observedAt,null);
    assert.notEqual(cache.revision(),initialRevision,'quote expiry creates a different public display generation');
    assert.equal(expired.savedAt,initial.savedAt,'serving an expired quote cannot extend the business lifetime');
    assert.equal(readFileSync(path,'utf8'),disk,'public reads do not rewrite the stored cache or its timestamps');
    reopened=new PoolDisplayCache(f.index,f.provider,{lens,path,now:f.now});
    assert.equal(reopened.miningOverview.quotes.size,0,'restart discards expired persisted estimates');
    assert.equal(reopened.snapshot().stats.estimatedDailyBemAtomic,null,'persisted aggregate cannot outlive its discarded quotes');
    assert.equal(reopened.snapshot().stats.currentlyActivePoolCount,'1');
    server=createChainIndexServer(f.index,{displayCache:reopened});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const before=f.calls,response=await fetch(`http://127.0.0.1:${server.address().port}/v1/display/stats`);
    assert.equal(response.status,200);const body=JSON.parse(await response.text(),cacheDecode);
    assert.equal(body.data.estimatedDailyBemAtomic,null);assert.equal(body.data.miningOverview.dailyOutputComplete,false);
    assert.equal(body.data.currentlyActivePoolCount,'1');assert.equal(f.calls,before,'expiry is derived without HTTP-triggered RPC');
    f.advance(20*60_000);assert.equal(reopened.snapshot(),null,'the underlying business cache still expires at thirty minutes');
  } finally {await cache.close();await reopened?.close();if(server)await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});

test('a slow Firsto quote never blocks pool, wallet, order or initial count materialization',async()=>{
  const f=fixture();let resolveQuote,updated=0;
  const waiting=new Promise(resolve=>{resolveQuote=resolve;});
  const cache=new PoolDisplayCache(f.index,f.provider,{lens,now:f.now,quoteLoader:()=>waiting,onUpdate:()=>{updated++;}});
  try {
    await cache.refresh();
    const initial=cache.snapshot();assert(initial);assert.equal(initial.accountRows[account][pool].shares,50n);
    assert.equal(initial.stats.currentlyActivePoolCount,'1');assert.equal(initial.stats.estimatedDailyBemAtomic,null);
    assert.equal(initial.stats.miningOverview.missingMinerCount,'1');const revision=cache.revision();
    resolveQuote({asset:{collection,tokenId:'12962',mining:{status:'verified',estimated24hAtomic:'432000',tokenSymbol:'BEM',tokenDecimals:8}}});
    await cache.quoteRunning;
    assert.equal(cache.snapshot().stats.estimatedDailyBemAtomic,'432000');assert.notEqual(cache.revision(),revision);assert.equal(updated,1);
  } finally {resolveQuote?.({});await cache.close();}
});

test('a late quote for an earlier miner set cannot overwrite the current aggregate',async()=>{
  const f=fixture();let resolveQuote;
  const waiting=new Promise(resolve=>{resolveQuote=resolve;});
  const cache=new PoolDisplayCache(f.index,f.provider,{lens,now:f.now,quoteLoader:()=>waiting});
  try {
    await cache.refresh();f.setState(4);await cache.refresh();
    assert.equal(cache.snapshot().stats.currentlyActivePoolCount,'0');assert.equal(cache.snapshot().stats.estimatedDailyBemAtomic,'0');
    resolveQuote({asset:{collection,tokenId:'12962',mining:{status:'verified',estimated24hAtomic:'432000',tokenSymbol:'BEM',tokenDecimals:8}}});
    await cache.quoteRunning;
    assert.equal(cache.snapshot().stats.currentlyActivePoolCount,'0');assert.equal(cache.snapshot().stats.estimatedDailyBemAtomic,'0');
  } finally {resolveQuote?.({});await cache.close();}
});

test('owner transfer availability is persisted on public and wallet rows, updates revision and adds zero HTTP RPC',async()=>{
  const f=fixture(),dir=mkdtempSync(join(tmpdir(),'pool-target-display-')),path=join(dir,'cache.json');f.setState(0);
  const cache=new PoolDisplayCache(f.index,f.provider,{lens,path,now:f.now});let reopened,server;
  try {
    await cache.refresh();const before=cache.revision();
    assert.equal(cache.snapshot().rows[pool].targetAvailability.status,'available');
    await cache.refresh();assert.equal(f.targetCalls.filter(name=>name==='owner:0xa').length,1,'same-tip display refresh reuses ownership');
    f.nextBlock();f.setOwner(address(9));await cache.refresh();const saved=cache.snapshot();
    assert.notEqual(cache.revision(),before,'the ownership result is part of the public display revision');
    assert.equal(saved.rows[pool].targetAvailability.status,'unavailable');assert.equal(saved.rows[pool].state,0n);
    assert.equal(saved.accountRows[account][pool].targetAvailability.status,'unavailable');
    assert.equal(saved.accountRows[account][pool].shares,50n,'positions and contributor funds remain visible');
    assert.deepEqual(saved.directory,[pool],'historical directory membership is preserved');
    reopened=new PoolDisplayCache(f.index,f.provider,{lens,path,now:f.now});f.targetCalls.length=0;await reopened.refresh();
    assert.deepEqual(f.targetCalls,['owner:0xb'],'restart reuses proved original owner and mode');
    server=createChainIndexServer(f.index,{displayCache:reopened});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`,rpcBefore=f.calls;
    for(const route of ['/v1/display/pools',`/v1/display/pools/${pool}`,`/v1/display/pools/${pool}?account=${account}`,
      `/v1/display/positions/${account}`]) {
      const response=await fetch(base+route);assert.equal(response.status,200);
      const body=JSON.parse(await response.text(),cacheDecode),item=body.data.item??body.data.items[0];
      assert.equal(item.targetAvailability.status,'unavailable');assert.equal(item.state,0n);
    }
    assert.equal(f.calls,rpcBefore);
    f.nextBlock();f.failTarget();await reopened.refresh();assert.equal(reopened.snapshot().rows[pool].targetAvailability.status,'unknown');
    assert.equal(reopened.snapshot().rows[pool].state,0n,'unknown evidence never pretends cancellation or a refund');
  } finally {await cache.close();await reopened?.close();if(server)await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});

test('target history uses its independently supplied verified transport while ordinary display calls retain their provider',async()=>{
  const f=fixture();f.setState(0);
  const displayProvider={...f.provider,getLogs:()=>assert.fail('ordinary display RPC must not fetch target Transfer history'),
    send:(method,params)=>{
      assert(![collection,pool].includes(params[0]?.to),'target owner/mode reads must use the target transport');
      return f.provider.send(method,params);
    }};
  const cache=new PoolDisplayCache(f.index,displayProvider,{lens,now:f.now,targetProvider:f.provider});
  try {
    await cache.refresh();assert.equal(cache.snapshot().rows[pool].targetAvailability.status,'available');
    assert.deepEqual(f.targetCalls,['mode','transfers','owner:0x5','owner:0xa']);
    await cache.refresh();assert.deepEqual(f.targetCalls,['mode','transfers','owner:0x5','owner:0xa'],
      'same-tip materialization adds no target history or current owner requests');
  } finally {await cache.close();}
});

test('an externally sold Funded target remains in its participant positions with the actual refund deadline and no HTTP RPC',async()=>{
  const f=fixture();f.setState(1);f.setPosition({claimableBEM:0n,bnbOwed:0n});f.setOwner(address(9));
  const cache=new PoolDisplayCache(f.index,f.provider,{lens,now:f.now});let server;
  try {
    await cache.refresh();server=createChainIndexServer(f.index,{displayCache:cache});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`,before=f.calls;
    const response=await fetch(`${base}/v1/display/positions/${account}`);assert.equal(response.status,200);
    const body=JSON.parse(await response.text(),cacheDecode);assert.equal(body.data.items.length,1);
    const item=body.data.items[0];
    assert.equal(item.pool,pool);assert.equal(item.state,1n,'ownership evidence cannot change the on-chain state to Refunding');
    assert.equal(item.targetAvailability.status,'unavailable');assert.equal(item.targetAvailability.reason,'target_owner_changed');
    assert.equal(item.targetAvailability.originalOwner,account);assert.equal(item.targetAvailability.currentOwner,address(9));
    assert.equal(item.shares,50n);assert.equal(item.initialContributedWei,55550000000000000n);
    assert.equal(item.bnbOwed,0n,'external sale cannot pretend a refund was already credited');
    assert.equal(item.params.purchaseDeadline,3000n);assert.equal(body.source.indexedTimestamp,1000);
    assert.equal(body.source.transactionReady,false,'materialized ownership evidence remains display-only');
    const strangerResponse=await fetch(`${base}/v1/display/positions/${address(99)}`);
    assert.equal(strangerResponse.status,200);
    const stranger=JSON.parse(await strangerResponse.text(),cacheDecode);assert.deepEqual(stranger.data.items,[]);
    assert.equal(stranger.data.marketBnbOwed,0n,'participant credits are not copied to another account');
    const exact=JSON.parse(await (await fetch(`${base}/v1/display/pools/${pool}?account=${account}`)).text(),cacheDecode);
    assert.equal(exact.data.item.params.purchaseDeadline,3000n);assert.equal(exact.data.item.shares,50n);
    assert.equal(f.calls,before,'participant notices and refund timing reuse the existing materialized cache');
  } finally {await cache.close();if(server)await new Promise(resolve=>server.close(resolve));}
});

test('a participant who withdraws Funding shares keeps the BNB credit after the sold target is hidden from public participation',async()=>{
  const f=fixture();f.setState(0);f.setOwner(address(9));
  f.setPosition({shares:0n,claimableBEM:0n,bnbOwed:55550000000000000n,contributedWei:0n});
  const cache=new PoolDisplayCache(f.index,f.provider,{lens,now:f.now});let server;
  try {
    await cache.refresh();server=createChainIndexServer(f.index,{displayCache:cache});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`,before=f.calls;
    const response=await fetch(`${base}/v1/display/positions/${account}`);assert.equal(response.status,200);
    const body=JSON.parse(await response.text(),cacheDecode);assert.equal(body.data.items.length,1);
    const item=body.data.items[0];
    assert.equal(item.state,0n);assert.equal(item.targetAvailability.status,'unavailable');assert.equal(item.shares,0n);
    assert.equal(item.initialContributedWei,0n,'withdrawDeposit clears the remaining contribution rather than recording all-time principal');
    assert.equal(item.bnbOwed,55550000000000000n,'the second withdrawal step must remain reachable with zero shares');
    const publicResponse=await fetch(`${base}/v1/display/pools/${pool}`);assert.equal(publicResponse.status,200);
    const publicBody=JSON.parse(await publicResponse.text(),cacheDecode);assert.equal(publicBody.data.item.bnbOwed,null);
    assert.equal(publicBody.data.item.shares,null,'public rows do not disclose or replace per-wallet balances');
    assert.equal(f.calls,before,'reading the retained withdrawal credit does not issue an HTTP-triggered RPC');
    f.nextBlock();f.setState(1);await cache.refresh();const fundedCalls=f.calls;
    const funded=JSON.parse(await (await fetch(`${base}/v1/display/positions/${account}`)).text(),cacheDecode);
    assert.equal(funded.data.items[0].state,1n);assert.equal(funded.data.items[0].shares,0n);
    assert.equal(funded.data.items[0].bnbOwed,55550000000000000n,
      'another member completing funding cannot hide an earlier participant withdrawal credit');
    assert.equal(f.calls,fundedCalls);
    f.nextBlock();f.setPosition({bnbOwed:0n});await cache.refresh();const paidCalls=f.calls;
    const paid=JSON.parse(await (await fetch(`${base}/v1/display/positions/${account}`)).text(),cacheDecode);
    assert.deepEqual(paid.data.items,[],'only a settled zero-balance position may leave the personal assets list');
    const exact=JSON.parse(await (await fetch(`${base}/v1/display/pools/${pool}?account=${account}`)).text(),cacheDecode);
    assert.equal(exact.data.item.bnbOwed,0n,'the historical exact project remains available after its credit is withdrawn');
    assert.equal(f.calls,paidCalls);
  } finally {await cache.close();if(server)await new Promise(resolve=>server.close(resolve));}
});

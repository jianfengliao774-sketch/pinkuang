import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface, ZeroAddress } from 'ethers';
import { abi } from '../../../web/lib/chain-client.mjs';
import { PoolDisplayCache, cacheDecode } from './pool-display-cache.mjs';
import { createChainIndexServer } from './api.mjs';
const address=n=>'0x'+String(n).padStart(40,'0');
const factory=address(1),lens=address(2),pool=address(3),account=address(4),market=address(5);
const blockHash='0x'+'ab'.repeat(32);
const binding=new Interface(['function lens() view returns(address)','function factory() view returns(address)','function VERSION() view returns(uint256)']);
function fixture() {
  let fork=false,failed=false,calls=0,time=1000000;
  const source={complete:true,unknownReason:null,chainId:56,factory,market,startBlock:1,confirmations:12,
    indexedThrough:10,indexedTimestamp:1000,observedSafeHead:10,indexedBlockHash:blockHash,
    checkedAt:new Date(time).toISOString(),registeredPoolCount:'1'};
  const directory={source,pools:[{address:pool}],orders:[],stats:{scope:'confirmed_indexed_history',registeredPoolCount:'1'}};
  const index={factory,market,snapshotTrusted:true,_header:()=>({hash:fork?'0x'+'cd'.repeat(32):blockHash}),
    verifiedDisplaySnapshot:()=>index.snapshotTrusted?directory:null,status:()=>source,syncing:false,
    db:{prepare:query=>query.startsWith('SELECT address')?{all:()=>[{address:pool}]}:{iterate:()=>[{args:JSON.stringify({user:account})}]}}};
  const provider={getBlock:async()=>{calls++;return {hash:fork?'0x'+'cd'.repeat(32):blockHash,timestamp:1000};},
    send:async(method,params)=>{
      calls++;if(failed) throw new Error('offline');if(method==='eth_chainId') return '0x38';
      assert.equal(method,'eth_call');assert.equal(params[1],'0xa');
      const request=params[0],iface=request.to===market?abi.ShareMarket:request.to===lens && request.data.startsWith(abi.PoolLens.getFunction('positions').selector)?abi.PoolLens:binding;
      const call=iface.parseTransaction(request);let value;
      if(call.name==='lens')value=lens;else if(call.name==='factory')value=factory;else if(call.name==='VERSION')value=1n;
      else if(call.name==='bnbOwed')value=13n;else {
        const own=call.args[1].toLowerCase()===account;
        value={blockNumber:10n,timestamp:1000n,totalPools:1n,nextCursor:1n,registryCountValid:true,pools:[{
          pool,status:{validMask:(1n<<17n)-1n,errorMask:0n,trustError:0n},
          params:{circuits:address(6),circuitId:12962n,targetRaise:111100000000000000n,priceCap:101000000000000000n,
            directSeller:ZeroAddress,directPrice:0n,fundingDeadline:2000n,purchaseDeadline:3000n},
          state:2n,unitPriceWei:1111000000000000n,totalRaised:111100000000000000n,totalSupply:100n,memberCount:2n,
          depositPaused:false,purchaseCost:101000000000000000n,activatedAt:500n,shareTradingAllowed:true,
          shares:own?50n:0n,lockedShares:0n,availableShares:own?50n:0n,claimableBEM:own?7n:0n,bnbOwed:own?11n:0n,initialContributedWei:own?55550000000000000n:0n}]};
      }
      return iface.encodeFunctionResult(call.name,[value]);
    }};
  return {index,provider,now:()=>time,get calls(){return calls;},fork:()=>{fork=true;},fail:()=>{failed=true;},advance:n=>{time+=n;}};
}

test('background materialization persists exact public and per-wallet state; HTTP cache reads make zero RPC calls',async()=>{
  const f=fixture(),dir=mkdtempSync(join(tmpdir(),'pool-display-')),path=join(dir,'cache.json');
  const cache=new PoolDisplayCache(f.index,f.provider,{lens,path,now:f.now});let server;
  try {
    await cache.refresh();const saved=cache.snapshot();assert(saved);
    assert.equal(saved.rows[pool].shares,null);assert.equal(saved.accountRows[account][pool].shares,50n);
    assert.equal(saved.rows[pool].params.targetRaise,111100000000000000n);
    const reopened=new PoolDisplayCache(f.index,f.provider,{lens,path,now:f.now});assert.equal(reopened.snapshot().accountRows[account][pool].bnbOwed,11n);
    server=createChainIndexServer(f.index,{displayCache:cache});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`,before=f.calls;
    for(const route of [`/v1/display/pools/${pool}`,`/v1/display/pools/${pool}?account=${account}`,
      `/v1/display/positions/${account}`,'/v1/display/pools','/v1/display/stats','/v1/display/orders']) {
      const response=await fetch(base+route);assert.equal(response.status,200);
      const body=JSON.parse(await response.text(),cacheDecode);assert.equal(body.source.cacheOrigin,'server');
      assert.equal(body.source.transactionReady,false);
      if(route.endsWith('?account='+account))assert.equal(body.data.item.shares,50n);
      if(route===`/v1/display/pools/${pool}`)assert.equal(body.data.item.shares,null);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { pollMarketDiscovery } from '../lib/discovery-poll.mjs';
const parent=`0x${'1'.repeat(40)}`,H=`0x${'2'.repeat(64)}`,url=`/api/journal/budget-candidates?parent=${parent}&block=12&hash=${H}`;
const pending={complete:false,status:'scanning',chainId:56,parent,blockNumber:'12',blockHash:H,retryAfterMs:2000};
test('public discovery polls exact pinned identity with GETs and only returns a complete snapshot',async()=>{
  let calls=0,time=0;const fetcher=async(input,options)=>{calls++;assert.equal(options.method,'GET');assert.equal(options.credentials,'same-origin');
    assert.equal(new URL(input,'https://site.example').searchParams.get('async'),'1');
    return Response.json(calls===3?{complete:true,candidates:[]}:pending,{status:calls===3?200:202});};
  const result=await pollMarketDiscovery(url,{fetcher,now:()=>time,wait:async ms=>{time+=ms;}});
  assert.equal(result.complete,true);assert.equal(calls,3);assert.equal(time,4000);
});
test('wrong parent, chain or pinned block never advances a pending discovery',async()=>{
  for(const update of [{parent:`0x${'3'.repeat(40)}`},{chainId:97},{blockNumber:'13'},{blockHash:`0x${'4'.repeat(64)}`},{retryAfterMs:0}])
    await assert.rejects(pollMarketDiscovery(url,{fetcher:async()=>Response.json({...pending,...update}),wait:async()=>{throw Error('must not poll');}}),/identity/);
});
test('scan deadline, reorg and service failure stop rather than authorize Firsto',async()=>{
  let time=0;await assert.rejects(pollMarketDiscovery(url,{maxWaitMs:5000,now:()=>time,wait:async ms=>{time+=ms;},
    fetcher:async()=>Response.json(pending,{status:202})}),/timed out/);
  await assert.rejects(pollMarketDiscovery(url,{fetcher:async()=>Response.json({error:'reorg'},{status:409})}),/block changed/);
  await assert.rejects(pollMarketDiscovery(url,{fetcher:async()=>Response.json({error:'upstream'},{status:503})}),/503/);
  await assert.rejects(pollMarketDiscovery('https://evil.example/api'),/this site/);
});

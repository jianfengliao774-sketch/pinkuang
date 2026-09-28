import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAddress } from 'ethers';
import { createJournalService } from './journal-api.mjs';
const address=n=>getAddress(`0x${n.toString(16).padStart(40,'0')}`),hash=n=>`0x${n.toString(16).padStart(64,'0')}`;
const factory=address(1),parent=address(2),legacy=address(3),digest=hash(99);
const path=(number=10)=>`/api/journal/budget-candidates?parent=${parent}&block=${number}&hash=${hash(number)}`;
async function fixture({discovery,officialScanTimeoutMs}={}){
  const directory=await mkdtemp(join(tmpdir(),'journal-budget-'));
  const state={chain:56n,head:20,time:100000,hashes:new Map(),graphs:0,scans:0,graphValid:true};
  const provider={send:async method=>{assert.equal(method,'eth_chainId');return `0x${state.chain.toString(16)}`;},
    getBlock:async number=>{const n=number==='latest'?state.head:number;return {number:n,hash:state.hashes.get(n)??hash(n),timestamp:1000};}};
  const complete=({block})=>({complete:true,chainId:56,parent,factory,legacyFactory:legacy,artifactDigest:digest,
    budgetWei:'1000',spentWei:'0',remainingWei:'1000',absoluteCapWei:'500',unitCapWei:'100',purchaseDeadline:'2000',
    snapshot:{complete:true,blockNumber:block.number,blockHash:block.hash},candidates:[]});
  const service=createJournalService({dbPath:join(directory,'private','journal.sqlite'),origin:'http://127.0.0.1:4173',provider,
    currentArtifactDigest:()=>digest,allowedProductFactories:[factory],now:()=>state.time,officialScanTimeoutMs,
    productGraphVerifier:async(_rpc,target,block)=>{state.graphs++;assert.equal(target.toLowerCase(),factory.toLowerCase());
      if(!state.graphValid)throw Error('Invalid reviewed graph');return {factory,productKind:'budget',legacyFactory:legacy,artifactDigest:digest,blockNumber:block.number};},
    budgetCandidateDiscovery:async options=>{state.scans++;return discovery?discovery(options,complete,state):complete(options);}});
  const server=createServer((req,res)=>service.handle(req,res));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {state,async get(route=path()){const response=await fetch(`http://127.0.0.1:${server.address().port}${route}`);return {status:response.status,body:await response.json(),cache:response.headers.get('cache-control')};},
    async close(){await new Promise(resolve=>server.close(resolve));await service.close();await rm(directory,{recursive:true,force:true});}};
}
test('budget HTTP discovery is read-only, caches one canonical parent and never requires a wallet session',async()=>{
  const f=await fixture();try{const result=await f.get();assert.equal(result.status,200);assert.equal(result.cache,'no-store');
    assert.equal(result.body.parent,parent);assert.equal(result.body.complete,true);assert.equal((await f.get()).status,200);
    assert.equal(f.state.scans,1);assert.equal(f.state.graphs,1);
  }finally{await f.close();}
});
test('budget query and historical or changed blocks stop before candidate scans',async()=>{
  const f=await fixture();try{
    for(const route of ['/api/journal/budget-candidates',path()+'&parent='+parent,path()+'&extra=1',path().replace('block=10','block=010')])assert.equal((await f.get(route)).status,400);
    assert.equal(f.state.scans,0);assert.equal((await f.get(path(21))).status,409);
    f.state.hashes.set(10,hash(100));assert.equal((await f.get()).status,409);assert.equal(f.state.scans,0);
  }finally{await f.close();}
});
test('bad graph and incomplete or mismatched discoveries never return empty complete candidates',async()=>{
  for(const discovery of [()=>{throw Error('upstream unavailable');},(options,complete)=>({...complete(options),complete:false}),
    (options,complete)=>({...complete(options),parent:address(999)}),
    (options,complete)=>({...complete(options),snapshot:{complete:false,blockNumber:10,blockHash:hash(10)}})]){
    const f=await fixture({discovery});try{assert.equal((await f.get()).status,503);}finally{await f.close();}
  }
  const f=await fixture();try{f.state.graphValid=false;assert.equal((await f.get()).status,503);assert.equal(f.state.scans,0);}finally{await f.close();}
});
test('budget discovery rejects post-scan reorg and wrong network',async()=>{
  const f=await fixture({discovery:(options,complete,state)=>{state.hashes.set(10,hash(100));return complete(options);}});
  try{assert.equal((await f.get()).status,409);f.state.chain=97n;assert.equal((await f.get(path(11))).status,503);}finally{await f.close();}
});
test('timed-out budget scans remain failed until actual work settles, without starting a duplicate signing lane',async()=>{
  const f=await fixture({officialScanTimeoutMs:15,discovery:async(options,complete)=>{await new Promise(resolve=>setTimeout(resolve,35));return complete(options);}});
  try{const result=await f.get();assert.equal(result.status,503);assert.match(result.body.error,/Firsto/);await new Promise(resolve=>setTimeout(resolve,40));}
  finally{await f.close();}
});

test('asynchronous budget discovery returns 202 quickly, coalesces polling, then returns the complete pinned result',async()=>{
  let release;const f=await fixture({discovery:async(options,complete)=>{await new Promise(resolve=>{release=resolve;});return complete(options);}});
  try{
    const first=await f.get(path()+'&async=1');assert.equal(first.status,202);assert.equal(first.body.complete,false);assert.equal(first.body.parent,parent);
    const second=await f.get(path()+'&async=1');assert.equal(second.status,202);assert.equal(f.state.scans,1);
    release();await new Promise(resolve=>setTimeout(resolve,10));const done=await f.get(path()+'&async=1');assert.equal(done.status,200);assert.equal(done.body.complete,true);
    assert.equal(f.state.scans,1);
  }finally{release?.();await f.close();}
});
test('asynchronous poll rejects reorg or aged block and never returns another parent job',async()=>{
  let release;const f=await fixture({discovery:async(options,complete)=>{await new Promise(resolve=>{release=resolve;});return complete(options);}});
  try{
    assert.equal((await f.get(path()+'&async=1')).status,202);f.state.head=131;
    assert.equal((await f.get(path()+'&async=1')).status,409);f.state.head=20;f.state.hashes.set(10,hash(999));
    assert.equal((await f.get(path()+'&async=1')).status,409);
    assert.equal((await f.get(path()+'&async=2')).status,400);
  }finally{release?.();await f.close();}
});

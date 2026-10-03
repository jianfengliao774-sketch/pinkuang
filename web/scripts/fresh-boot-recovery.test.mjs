import test from 'node:test';
import assert from 'node:assert/strict';
import { startFreshBootRecovery, freshIdentityReadable, freshOperationsReady, freshRecheckDisplay } from '../lib/fresh-boot-recovery.mjs';
const waiting={status:'ready',productFamily:'fresh-v4',readMode:'current',stale:false,operationalReady:false,transactionReady:false,userExitReady:true};
const ready={...waiting,operationalReady:true,transactionReady:true};
const history={...waiting,readMode:'verified_snapshot',stale:true,snapshotAgeMs:1000,userExitReady:false};
const drain=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function fixture(values=[waiting]){
 let now=0,id=0,visible=true,busy=false,context={wallet:{},revision:1,route:{}},calls=0;
 const tasks=new Map(),accepted=[],errors=[],exhausted=[],expired=[];
 const run=startFreshBootRecovery({load:async()=>{const value=values[Math.min(calls++,values.length-1)];return typeof value==='function'?value():value;},
  onConfig:value=>accepted.push(value),onError:(error,shown)=>errors.push({error,shown}),onExhausted:value=>exhausted.push(value),onExpired:()=>expired.push(true),
  getContext:()=>context,isBusy:()=>busy,isVisible:()=>visible,now:()=>now,
  schedule:(fn,delay)=>{tasks.set(++id,{at:now+delay,fn});return id;},unschedule:key=>tasks.delete(key)});
 const advance=async ms=>{await drain();const target=now+ms;while(true){const entry=[...tasks].sort((a,b)=>a[1].at-b[1].at)[0];
  if(!entry||entry[1].at>target)break;now=entry[1].at;tasks.delete(entry[0]);entry[1].fn();await drain();}now=target;await drain();};
 return {accepted,errors,exhausted,expired,advance,stop:run,get calls(){return calls;},get timers(){return tasks.size;},
  busy:value=>busy=value,visible:value=>visible=value,changeContext:()=>context={...context,revision:context.revision+1,route:{}}};
}
test('current identity is distinct from worker readiness; history never grants an operator identity',()=>{
 assert.equal(freshIdentityReadable(waiting),true);assert.equal(freshOperationsReady(waiting),false);
 assert.equal(freshIdentityReadable(history),false);assert.equal(freshOperationsReady(history),false);
 assert.equal(freshOperationsReady(ready),true);
 assert.equal(freshIdentityReadable({...ready,stale:undefined}),false);
});
test('false to true publishes once, preserves repeated waiting client, and stops healthy polling',async()=>{
 const f=fixture([waiting,{...waiting},ready]);await f.advance(15000);assert.equal(f.calls,2);assert.equal(f.accepted.length,1);
 await f.advance(30000);assert.equal(f.calls,3);assert.equal(f.accepted.at(-1),ready);
 await f.advance(600000);assert.equal(f.calls,3);assert.equal(f.timers,0);f.stop();
});
test('historical to current waiting to current healthy changes the proof without granting historical access',async()=>{
 const f=fixture([history,waiting,ready]);await f.advance(45000);
 assert.deepEqual(f.accepted,[history,waiting,ready]);assert.equal(f.expired.length,0);assert.equal(f.timers,0);f.stop();
});
test('a changed validated deployment/stage identity is not hidden behind unchanged readiness flags',async()=>{
 for(const change of [{stage:'fresh-active'},{stageActivationHash:'0x123'},{stageActivationBlock:20},
  {artifactDigest:'0xabc'},{operationId:'next'},{freshAuthority:{address:'other'}},{manifest:{factory:'other'}}]){
  const next={...waiting,...change},f=fixture([waiting,next]);await f.advance(15000);
  assert.deepEqual(f.accepted,[waiting,next]);f.stop();
 }
});
test('five delayed retries exhaust, do not run concurrently or poll forever',async()=>{
 const f=fixture();await f.advance(225000);assert.equal(f.calls,6);assert.equal(f.accepted.length,1);
 assert.equal(f.exhausted.at(-1),true);await f.advance(900000);assert.equal(f.calls,6);f.stop();
});
test('hidden pages and open confirmations defer the check without burning retries or catch-up bursts',async()=>{
 const f=fixture([waiting,ready]);await drain();f.busy(true);await f.advance(60000);assert.equal(f.calls,1);
 f.busy(false);f.visible(false);await f.advance(60000);assert.equal(f.calls,1);
 f.visible(true);await f.advance(5000);assert.equal(f.calls,2);assert.equal(f.accepted.at(-1),ready);f.stop();
});
test('late response after account/route change cannot apply; a later bound check can recover',async()=>{
 let resolve;const f=fixture([waiting,()=>new Promise(r=>resolve=r),ready]);await f.advance(15000);
 f.changeContext();resolve(ready);await drain();assert.deepEqual(f.accepted,[waiting]);
 await f.advance(30000);assert.equal(f.accepted.at(-1),ready);f.stop();
});
test('confirmation opened during a pending recovery keeps the existing exit proof and client',async()=>{
 let resolve;const f=fixture([waiting,()=>new Promise(r=>resolve=r),ready]);await f.advance(15000);
 f.busy(true);resolve(ready);await drain();assert.deepEqual(f.accepted,[waiting]);assert.equal(f.accepted[0].userExitReady,true);
 await f.advance(30000);assert.equal(f.calls,2);f.busy(false);await f.advance(5000);assert.equal(f.accepted.at(-1),ready);f.stop();
});
test('unmount ignores late results and clears future work',async()=>{
 let resolve;const f=fixture([()=>new Promise(r=>resolve=r)]);f.stop();resolve(ready);await drain();
 assert.deepEqual(f.accepted,[]);assert.equal(f.timers,0);
});
test('errors are bounded and do not silently upgrade previously verified waiting state',async()=>{
 const f=fixture([waiting,()=>{throw Error('invalid graph');}]);await f.advance(225000);
 assert.deepEqual(f.accepted,[waiting]);assert.equal(f.errors.length,5);assert.equal(f.exhausted.at(-1),true);f.stop();
});
test('expired historical display is removed even after retries are exhausted',async()=>{
 const f=fixture([history]);await f.advance(30*60_000);assert.equal(f.expired.length,1);assert.equal(f.timers,0);f.stop();
});

test('a recheck retains validated deployment identity for display and revokes all action permissions',()=>{
 const value={...ready,manifest:{factory:'verified'}};
 const retained=freshRecheckDisplay(value,1000);
 assert.equal(retained.manifest,value.manifest);assert.equal(retained.status,'ready');
 assert.equal(retained.operationalReady,false);assert.equal(retained.transactionReady,false);assert.equal(retained.userExitReady,false);
 assert.equal(freshIdentityReadable(retained),false);assert.equal(freshOperationsReady(retained),false);
 assert.equal(freshRecheckDisplay({status:'loading'},1000),null);
 assert.equal(freshRecheckDisplay({...value,productFamily:'legacy'},1000),null);
 assert.equal(freshIdentityReadable({...ready,walletSessionReady:false}),false);
});

test('repeated rechecks cannot extend retained display lifetime',()=>{
 const value=freshRecheckDisplay({...ready,manifest:{}},1000);
 assert.equal(freshRecheckDisplay(value,2000).recheckExpiresAt,value.recheckExpiresAt);
 assert.equal(freshRecheckDisplay(value,value.recheckExpiresAt),null);
 const historical=freshRecheckDisplay({...history,manifest:{}},1000);
 assert.equal(historical.recheckExpiresAt,30*60_000);
});

test('a failed first recheck keeps prior display blocked until a validated graph replaces it',async()=>{
 const retained=freshRecheckDisplay({...ready,manifest:{}},Date.now());
 const accepted=[],errors=[];let calls=0;
 const tasks=new Map();let id=0;
 const stop=startFreshBootRecovery({initialConfig:retained,load:async()=>{if(calls++===0)throw Error('temporary RPC');return {...ready,manifest:{}};},
  getContext:()=>({wallet:null,revision:1,route:'same'}),isBusy:()=>false,
  onConfig:value=>accepted.push(value),onError:(error,shown)=>errors.push(shown),onExhausted:()=>{},onExpired:()=>{},
  schedule:(fn,delay)=>{tasks.set(++id,{fn,delay});return id;},unschedule:key=>tasks.delete(key)});
 await drain();assert.deepEqual(errors,[true]);assert.deepEqual(accepted,[]);
 const retry=[...tasks.values()].find(item=>item.delay===15000);retry.fn();await drain();
 assert.equal(accepted.length,1);assert.equal(freshOperationsReady(accepted[0]),true);stop();
});

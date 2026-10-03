import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedReadPreview } from '../lib/bounded-read-preview.mjs';
const tick = async () => { for (let n=0;n<8;n++) await Promise.resolve(); };
function fixture() {
  let timeout, cleared=0, release, requests=0;
  return { provider: { request: async () => { requests++; return new Promise(resolve => { release=resolve; }); } },
    schedule: fn => { timeout=fn; return 1; }, unschedule: () => { cleared++; },
    timeout: () => timeout(), release: value => release(value), get requests(){return requests;}, get cleared(){return cleared;} };
}
test('successful pure reads retain exact results and clear their deadline', async()=>{
  const f=fixture();let scope;
  const result=boundedReadPreview(async value=>{scope=value;return value.provider.request({method:'eth_call',params:[{data:'0x01'},'0x64']});},f);
  await tick();f.release('43695679475146443511');assert.equal(await result,'43695679475146443511');
  assert.equal(f.cleared,1);assert.equal(scope.signal.aborted,true);
});
test('timeout does not accept late transport data or allow a second request', async()=>{
  const f=fixture();let advanced=false;
  const result=boundedReadPreview(async({provider})=>{await provider.request({method:'eth_call'});advanced=true;return provider.request({method:'eth_chainId'});},f);
  const rejected=assert.rejects(result,{code:'read_timeout'});await tick();f.timeout();await rejected;
  f.release('0x01');await tick();assert.equal(advanced,false);assert.equal(f.requests,1);
});
test('cancel is explicit and a late read cannot finish a preview',async()=>{
  const f=fixture(),controller=new AbortController();let advanced=false;
  const result=boundedReadPreview(async({provider})=>{await provider.request({method:'eth_call'});advanced=true;}, {...f,signal:controller.signal});
  const rejected=assert.rejects(result,{code:'read_cancelled'});await tick();controller.abort();await rejected;f.release('0x01');await tick();assert.equal(advanced,false);
});
test('account or route epoch invalidation rejects a finishing read',async()=>{
  const f=fixture();let current=true;
  const result=boundedReadPreview(({provider})=>provider.request({method:'eth_call'}),{...f,isCurrent:()=>current});
  const rejected=assert.rejects(result,{code:'read_cancelled'});await tick();current=false;f.release('0x01');await rejected;
});
test('authorization, signing and broadcast methods never reach the underlying provider',async()=>{
  for (const method of ['eth_accounts','eth_requestAccounts','personal_sign','eth_signTypedData_v4','eth_sendTransaction','eth_sendRawTransaction','wallet_switchEthereumChain']) {
    const f=fixture();await assert.rejects(boundedReadPreview(({provider})=>provider.request({method}),f),{code:'read_method_forbidden'});assert.equal(f.requests,0);
  }
});
test('explicit retry after timeout gets a new isolated deadline, never an automatic retry',async()=>{
  const f=fixture(),first=boundedReadPreview(({provider})=>provider.request({method:'eth_call'}),f);
  const rejected=assert.rejects(first,{code:'read_timeout'});await tick();f.timeout();await rejected;assert.equal(f.requests,1);
  assert.equal(await boundedReadPreview(({provider})=>provider.request({method:'eth_chainId'}),{provider:{request:async()=> '0x38'}}),'0x38');
  f.release('old-result');await tick();assert.equal(f.requests,1);
});
test('a late rejection is consumed and cannot leak into a later preview',async()=>{
  const f=fixture();let rejectRead;
  f.provider.request=()=>new Promise((_,reject)=>{rejectRead=reject;});
  const result=boundedReadPreview(({provider})=>provider.request({method:'eth_call'}),f);
  const rejected=assert.rejects(result,{code:'read_timeout'});await tick();f.timeout();await rejected;
  rejectRead(new Error('late transport failure'));await tick();assert.equal(f.cleared,1);
});

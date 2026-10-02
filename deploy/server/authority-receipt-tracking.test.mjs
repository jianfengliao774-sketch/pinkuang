import test from 'node:test';
import assert from 'node:assert/strict';
import {trackAuthorityReceipts} from './authority-signer.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('Authority receipt tracking keeps reconciling after the submitting browser is gone',async()=>{
  let calls=0;
  const stop=trackAuthorityReceipts({reconcile:async()=>{calls++;return {status:calls<2?'pending':'confirmed'};}},
    {intervalMs:5,onError:assert.fail});
  try {await delay(25);assert.ok(calls>=2);}
  finally {await stop();}
  const ended=calls;await delay(15);assert.equal(calls,ended);
});

test('slow receipt lookup never overlaps and shutdown waits for the durable update',async()=>{
  let resolveRead,calls=0,stopped=false;
  const stop=trackAuthorityReceipts({reconcile:()=>{calls++;return new Promise(resolve=>{resolveRead=resolve;});}},
    {intervalMs:5,onError:assert.fail});
  await delay(20);assert.equal(calls,1);
  const closing=stop().then(()=>{stopped=true;});
  await delay(10);assert.equal(stopped,false);
  resolveRead();await closing;await delay(10);
  assert.equal(stopped,true);assert.equal(calls,1);
});

test('temporary receipt failures retry without terminating the signer or sending a transaction',async()=>{
  let errors=0,calls=0;
  const stop=trackAuthorityReceipts({reconcile:async()=>{
    calls++;if(calls===1)throw new Error('RPC temporarily unavailable');
    return {status:'idle'};
  }},{intervalMs:5,onError:()=>errors++});
  try {await delay(25);assert.equal(errors,1);assert.ok(calls>=2);}
  finally {await stop();}
});

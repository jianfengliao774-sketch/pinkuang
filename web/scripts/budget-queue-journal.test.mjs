import test from 'node:test';
import assert from 'node:assert/strict';
import { readBudgetQueue, writeBudgetQueue } from '../lib/budget-queue-journal.mjs';
const A=`0x${'1'.repeat(40)}`,P=`0x${'2'.repeat(40)}`,config={journalBase:'/bemine-v2/api/journal'};

test('purchase queue client uses only authenticated same-origin server storage',async()=>{
  const calls=[];
  const fetcher=async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({revision:0,record:null}),{status:200});};
  const result=await readBudgetQueue({config,account:A,parent:P,fetcher});
  assert.deepEqual(result,{revision:0,record:null});
  assert.equal(calls[0].url,`/bemine-v2/api/journal/budget-queue?parent=${P}`);
  assert.equal(calls[0].options.credentials,'same-origin');
  assert.equal(calls[0].options.cache,'no-store');
  assert.equal(calls[0].options.headers['X-Pinkuang-Account'],A);
});

test('purchase queue client refuses unauthenticated or mismatched server responses',async()=>{
  await assert.rejects(readBudgetQueue({config,account:A,parent:P,fetcher:async()=>new Response(JSON.stringify({error:'Wallet session is required.'}),{status:401})}),/Wallet session/);
  await assert.rejects(readBudgetQueue({config,account:A,parent:P,fetcher:async()=>new Response(JSON.stringify({revision:1,record:{account:A}}),{status:200})}));
  await assert.rejects(writeBudgetQueue({config,account:A,parent:P,record:{},expectedRevision:0}),/Project|项目|purchase|Queue|queue|Invalid/);
});

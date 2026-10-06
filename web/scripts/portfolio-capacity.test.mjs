import test from 'node:test';
import assert from 'node:assert/strict';
import {readPortfolioDailyCapacity} from '../lib/portfolio-capacity.mjs';
import {capacityFixture as fixture} from './portfolio-capacity-fixture.mjs';

test('complete fixed-block pagination includes more than 100 children and sums exact atomic units',async()=>{
  const f=fixture({count:101}),progress=[];
  const q=await readPortfolioDailyCapacity(f.config,f.provider,{...f.input,onProgress:p=>progress.push(p.inspected)});
  assert.equal(q.available,true);assert.equal(q.inspectedChildren,101n);assert.equal(q.retainedChildren,101n);
  assert.equal(q.estimated24hAtomic,101n*100000001n);assert.deepEqual(progress,[100n,101n]);assert.equal(f.quotes.length,101);
  assert.equal(q.priceWeiPerDailyBem,q.pricePerUnitWei*100n*100000000n/q.estimated24hAtomic);
  assert(f.requests.every(c=>!/(send|sign)/i.test(c.method)));
});
test('sold and completed-but-not-settled children contribute no capacity and are not fetched',async()=>{
  const f=fixture({sold:[0],pending:[1]});const q=await readPortfolioDailyCapacity(f.config,f.provider,f.input);
  assert.equal(q.available,true);assert.equal(q.soldChildren,1n);assert.equal(q.pendingSaleChildren,1n);assert.equal(q.estimated24hAtomic,100000001n);assert.deepEqual(f.quotes,['3']);
});
test('unknown or missing final child, duplicate NFT identity, ownership change and reorg never become a partial total or zero',async()=>{
  for(const options of [{count:101,unknown:100},{count:101,missing:100},{duplicate:true},{wrongOwner:true},{reorg:true}]){
    const f=fixture(options),q=await readPortfolioDailyCapacity(f.config,f.provider,f.input);
    assert.equal(q.available,false,JSON.stringify(options));assert.equal(q.estimated24hAtomic,undefined);
  }
});
test('a verified empty portfolio has zero output but no fabricated price per daily BEM',async()=>{
  const f=fixture({count:0}),q=await readPortfolioDailyCapacity(f.config,f.provider,f.input);
  assert.equal(q.available,true);assert.equal(q.estimated24hAtomic,0n);assert.equal(q.priceWeiPerDailyBem,null);
});
test('abandoned and stale reads return unavailable, and unsafe numeric price input is rejected',async()=>{
  const f=fixture(),abort=new AbortController();abort.abort();
  for(const options of [{signal:abort.signal},{now:f.input.now+600000},{pricePerUnitWei:9007199254740993}]){
    const q=await readPortfolioDailyCapacity(f.config,f.provider,{...f.input,...options});assert.equal(q.available,false);
  }
});
test('navigation abort while quote reads are pending drains the started batch without publishing stale capacity',async()=>{
  const f=fixture({count:5}),abort=new AbortController();let release,entered,finished=0;
  const gate=new Promise(resolve=>release=resolve),seen=new Promise(resolve=>entered=resolve);
  const pending=readPortfolioDailyCapacity(f.config,f.provider,{...f.input,signal:abort.signal,quoteLoader:async(...args)=>{
    entered();await gate;finished++;return f.input.quoteLoader(...args);
  }});
  await seen;abort.abort();release();const result=await pending;
  assert.equal(result.available,false);assert.equal(result.reason,'cancelled');assert.equal(result.estimated24hAtomic,undefined);
  assert.equal(finished,4);assert.equal(f.quotes.length,4);
});

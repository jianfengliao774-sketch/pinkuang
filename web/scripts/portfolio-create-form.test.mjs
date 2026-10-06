import test from 'node:test';
import assert from 'node:assert/strict';
import { portfolioCreateForm } from '../lib/portfolio-create-form.mjs';
import { portfolioDailyCapSample, dailyCapToWeightCap } from '../lib/portfolio-daily-cap.mjs';

const sample={output:18_700_000n,weight:40n,observedAt:Date.now()};
const valid={budget:'1.000',absoluteCap:'0.2',dailyCap:'9',capacitySample:sample,fundHours:'24',buyHours:'48'};
test('portfolio form identifies the missing cap instead of reporting a generic BNB error',()=>{
  assert.throws(()=>portfolioCreateForm({...valid,dailyCap:''}),/日产能价上限/);
  assert.throws(()=>portfolioCreateForm({...valid,absoluteCap:''}),/单机价格上限/);
  assert.throws(()=>portfolioCreateForm({...valid,budget:''}),/募集预算/);
  assert.equal(portfolioCreateForm(valid).unitCap,'0.042075');
});
test('portfolio form rejects oversized budgets and amounts beyond wei precision',()=>{
  assert.throws(()=>portfolioCreateForm({...valid,absoluteCap:'1.1'}),/不能超过募集预算/);
  assert.throws(()=>portfolioCreateForm({...valid,dailyCap:'9.0000000000000000001'}),/日产能价上限/);
  assert.equal(portfolioCreateForm({...valid,budget:'0.0004',absoluteCap:'0.0001'}).budget,'0.0004');
  assert.equal(portfolioCreateForm({...valid,budget:'0.200004999999999900',absoluteCap:'0.200004999999999899'}).budget,'0.200004999999999900');
  assert.throws(()=>portfolioCreateForm({...valid,budget:'0.200004999999999999',absoluteCap:'0.2'}),/平均分为 100 份/);
});
test('daily cap conversion uses the lowest verified fresh output per H and fails closed on stale data',()=>{
  const rows=[{status:'verified',unverifiedWeight:'0',verifiedWeight:'40',estimated24hAtomic:'18700000',source:{observedAt:Date.now()}},
    {status:'verified',unverifiedWeight:'0',verifiedWeight:'100',estimated24hAtomic:'45000000',source:{observedAt:Date.now()}},
    {status:'verified',unverifiedWeight:'1',verifiedWeight:'100',estimated24hAtomic:'10000000',source:{observedAt:Date.now()}}];
  assert.equal(dailyCapToWeightCap('9',portfolioDailyCapSample(rows,Date.now())), '0.0405');
  assert.throws(()=>portfolioCreateForm({...valid,capacitySample:null}),/产能样本/);
  assert.throws(()=>dailyCapToWeightCap('9',{...sample,observedAt:Date.now()-121_000}),/已过期/);
  assert.throws(()=>dailyCapToWeightCap('0.000000000000000001',sample),/限价为 0/);
});

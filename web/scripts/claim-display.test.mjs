import assert from 'node:assert/strict';
import test from 'node:test';
import { claimDisplayState } from '../lib/claim-display.mjs';
const address=n=>`0x${n.toString(16).padStart(40,'0')}`,hash=n=>`0x${n.toString(16).padStart(64,'0')}`;
const pool=address(1),account=address(2),other=address(3),now=1_000_000;
const base={pool,account,currency:'BEM',balance:0n,now};
const wallet=(change={})=>({status:'confirmed',account,target:pool,action:'claim',value:'0',
  data:'0x4e71d92d',hash:hash(4),blockNumber:'0x64',confirmedAt:now-1000,...change});
const row=(change={})=>({event:'BemClaimed',contract:pool,pool,transactionHash:hash(5),blockHash:hash(6),blockNumber:100,
  fields:{user:account,amount:'116000'},...change});

test('successful claims belong to the exact account/pool/currency and a later positive balance restores claiming',()=>{
  const claimed=claimDisplayState({...base,activity:[row()]});
  assert.equal(claimed.state,'claimed');assert.equal(claimed.labelZh,'已领取 BEM');assert.equal(claimed.canClaim,false);
  assert.equal(claimDisplayState({...base,balance:2n,activity:[row()]}).state,'available');
  assert.equal(claimDisplayState({...base,transactions:[wallet()]}).state,'claimed');
  for(const changed of [{account:other},{target:other},{status:'failed'},{status:'pending'},
    {action:'withdrawBnb',data:'0x1da0603a'},{data:'0x1da0603a'},{value:'1'},{chainId:1}])
    assert.equal(claimDisplayState({...base,transactions:[wallet(changed)]}).state,'empty');
  for(const changed of [{contract:other},{pool:other},{event:'BnbWithdrawn'},
    {fields:{user:other,amount:'116000'}},{fields:{user:account,member:other,amount:'1'}},
    {fields:{user:account,amount:'0'}},{status:'failed'}])
    assert.equal(claimDisplayState({...base,activity:[row(changed)]}).state,'empty');
  const bnb=claimDisplayState({...base,currency:'BNB',activity:[row({event:'BnbWithdrawn',fields:{member:account,amount:'100'}})]});
  assert.equal(bnb.state,'claimed');assert.equal(bnb.labelZh,'已领取 BNB');
});

test('unknown balance never becomes a zero/claimed-all balance; recent confirmation gets explicit updating feedback',()=>{
  assert.equal(claimDisplayState({...base,balance:null}).state,'unavailable');
  assert.equal(claimDisplayState({...base,balance:undefined,activity:[row()]}).state,'unavailable');
  const recent=claimDisplayState({...base,balance:null,transactions:[wallet()]});
  assert.equal(recent.state,'confirmed');assert.equal(recent.balanceKnown,false);assert.equal(recent.amount,null);
  assert.match(recent.labelZh,/本次.*领取已确认/);assert.equal(recent.updating,true);assert.equal(recent.canClaim,false);
  assert.equal(claimDisplayState({...base,balance:null,transactions:[wallet({confirmedAt:now-120_000})]}).state,'unavailable');
  assert.equal(claimDisplayState({...base,balance:null,transactions:[wallet({confirmedAt:now+1})]}).state,'unavailable');
  const stale=claimDisplayState({...base,balance:116000n,balanceBlock:99,transactions:[wallet()]});
  assert.equal(stale.state,'confirmed','do not reuse the known pre-claim amount as fresh availability');
  const renewed=claimDisplayState({...base,balance:116000n,balanceBlock:101,transactions:[wallet()]});
  assert.equal(renewed.state,'available');assert.equal(renewed.canClaim,true);
  assert.equal(claimDisplayState({...base,balance:0}).state,'unavailable','number/absent data is not an atomic zero');
  assert.equal(claimDisplayState({...base,account:null,transactions:[wallet()]}).state,'connect');
});

test('finalized journal receipts require successful bound receipt identity rather than a generic success message',()=>{
  const record=wallet({data:undefined,value:undefined,finalized:true,receipt:{status:1,from:account,to:pool,
    transactionHash:hash(4),blockHash:hash(7),blockNumber:100}});
  assert.equal(claimDisplayState({...base,transactions:[record]}).state,'claimed');
  for(const receipt of [{...record.receipt,status:0},{...record.receipt,to:other},
    {...record.receipt,from:other},{...record.receipt,transactionHash:hash(9)}])
    assert.equal(claimDisplayState({...base,transactions:[{...record,receipt}]}).state,'empty');
  assert.equal(claimDisplayState({...base,transactions:[{...record,finalized:false}]}).state,'empty');
  assert.equal(claimDisplayState({...base,transactions:[{kind:'success',action:'claim',hash:hash(4)}]}).state,'empty');
});

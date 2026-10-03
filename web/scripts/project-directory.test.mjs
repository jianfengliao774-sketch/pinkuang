import test from 'node:test';
import assert from 'node:assert/strict';
import { projectDirectory, portfolioDirectoryRow } from '../lib/project-directory.mjs';
const parent={kind:'portfolio',pool:'0x0000000000000000000000000000000000000901',state:0n,totalSupply:25n,
  unitPriceWei:10000000000000001n,budgetWei:1000000000000000100n,childCount:12n,activeChildCount:8n,memberCount:3n,spentWei:0n};
const single={pool:'0x0000000000000000000000000000000000000101',name:'TapeOut',tokenId:'123',status:'Funding',funded:10,unitPriceWei:10000000000000000n};
test('one parent shares the directory with one miner without multiplying its shares by children',()=>{
  const result=projectDirectory([single],[parent],{filter:'Funding'});
  assert.equal(result.rows.length,2);assert.equal(result.counts.Funding,2);
  const row=result.rows.find(r=>r.kind==='portfolio');assert.equal(row.funded,25);assert.equal(row.remaining,75);
  assert.equal(row.unitPriceWei,parent.unitPriceWei);assert.equal(row.tokenId,null);assert.equal(row.params,undefined);
  assert.equal(parent.status,undefined);assert.equal(single.kind,undefined);
});
test('summary and Funding tab both include funded/acquiring projects',()=>{
  const result=projectDirectory([{...single,status:'Funded'}],[{...parent,state:1n}],{filter:'Funding'});
  assert.equal(result.rows.length,result.counts.Funding);assert.equal(result.rows.length,2);
  assert.equal(projectDirectory([single],[{...parent,state:2n}],{filter:'Active'}).rows[0].kind,'portfolio');
});
test('search finds a parent by address or type without inventing a miner ID',()=>{
  assert.equal(projectDirectory([single],[parent],{query:'0901'}).rows[0].kind,'portfolio');
  assert.equal(projectDirectory([single],[parent],{query:'多矿机'}).rows.length,1);
  assert.equal(projectDirectory([single],[parent],{query:'multi-miner'}).rows.length,1);
  assert.equal(projectDirectory([single],[parent],{query:'123'}).rows.length,1);
});
test('per-share sorting distinguishes exact wei beyond Number precision',()=>{
  const result=projectDirectory([single],[parent],{sort:'price'});
  assert.equal(result.rows[0].pool,single.pool);assert.equal(result.rows[1].unitPriceWei,10000000000000001n);
});
test('unavailable capacity and parent miner ID sort last; budget is never a capacity proxy',()=>{
  const result=projectDirectory([single],[parent],{sort:'capacity',capacityFor:row=>row.kind==='portfolio'?null:5n});
  assert.equal(result.rows[1].kind,'portfolio');assert.equal(projectDirectory([single],[parent],{sort:'id'}).rows[1].kind,'portfolio');
});
test('a finished or refunding parent remains available from Overview, never a funding card',()=>{
  for(const state of [4n,5n]){
    assert.equal(projectDirectory([],[{...parent,state}],{filter:'Funding'}).rows.length,0);
    assert.equal(projectDirectory([],[{...parent,state}],{filter:'all'}).rows.length,1);
  }
  assert.equal(portfolioDirectoryRow({...parent,state:6n}).status,'Unknown');
});

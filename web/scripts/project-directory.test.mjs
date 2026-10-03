import test from 'node:test';
import assert from 'node:assert/strict';
import { projectDirectory, projectDirectoryCategory, portfolioDirectoryRow } from '../lib/project-directory.mjs';
const parent={kind:'portfolio',pool:'0x0000000000000000000000000000000000000901',state:0n,totalSupply:25n,
  unitPriceWei:10000000000000001n,budgetWei:1000000000000000100n,childCount:12n,activeChildCount:8n,memberCount:3n,spentWei:0n};
const single={pool:'0x0000000000000000000000000000000000000101',name:'TapeOut',tokenId:'123',status:'Funding',funded:10,unitPriceWei:10000000000000000n};
const transferred = { ...single, state: 0n, targetAvailability: {
  status: 'unavailable', purchaseMode: 'fixed',
  originalOwner: '0x0000000000000000000000000000000000000201',
  currentOwner: '0x0000000000000000000000000000000000000202',
  observedBlock: 101, observedBlockHash: `0x${'a'.repeat(64)}`,
  creationBlock: 100, creationBlockHash: `0x${'b'.repeat(64)}`, chainState: 0n,
} };

test('confirmed transferred fixed target leaves Funding but remains in Overview under its true chain state',()=>{
  assert.equal(projectDirectoryCategory(transferred),'unavailable');
  const funding=projectDirectory([transferred],[parent],{filter:'Funding'});
  assert.equal(funding.rows.length,1);assert.equal(funding.rows[0].kind,'portfolio');
  assert.equal(funding.counts.Funding,1);
  const overview=projectDirectory([transferred],[parent],{filter:'all'});
  assert.equal(overview.rows.length,2);assert.equal(overview.all.find(row=>row.pool===single.pool).status,'Funding');
  assert.equal(overview.rows.filter(row=>projectDirectoryCategory(row)==='unavailable').length,1);
  const funded={...transferred,status:'Funded',state:1n,
    targetAvailability:{...transferred.targetAvailability,chainState:1n}};
  assert.equal(projectDirectory([funded],[],{filter:'Funding'}).rows.length,0);
  assert.equal(projectDirectory([funded],[],{filter:'all'}).rows[0].status,'Funded');
});

test('unknown, flexible, and inconsistent transfer evidence are not hidden from Funding',()=>{
  const variants=[
    {...transferred,targetAvailability:{...transferred.targetAvailability,status:'unknown'}},
    {...transferred,targetAvailability:{...transferred.targetAvailability,purchaseMode:'flexible',status:'not_applicable'}},
    {...transferred,targetAvailability:{...transferred.targetAvailability,currentOwner:transferred.targetAvailability.originalOwner}},
    {...transferred,targetAvailability:{...transferred.targetAvailability,currentOwner:single.pool}},
    {...transferred,targetAvailability:{...transferred.targetAvailability,chainState:1n}},
    {...transferred,targetAvailability:{...transferred.targetAvailability,creationBlockHash:null}},
    {...transferred,targetAvailability:{...transferred.targetAvailability,observedBlock:99}},
  ];
  for(const row of variants){
    assert.equal(projectDirectoryCategory(row),'Funding');
    assert.equal(projectDirectory([row],[],{filter:'Funding'}).rows.length,1);
  }
});
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

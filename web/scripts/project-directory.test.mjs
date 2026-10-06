import test from 'node:test';
import assert from 'node:assert/strict';
import { projectDirectory, projectDirectoryCategory, portfolioDirectoryRow, projectSortState, projectSortValue,
  projectTargetRaiseWei, toggleProjectSort } from '../lib/project-directory.mjs';
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

test('confirmed transferred fixed target is absent from every public catalog without changing personal records',()=>{
  assert.equal(projectDirectoryCategory(transferred),'unavailable');
  const funding=projectDirectory([transferred],[parent],{filter:'Funding'});
  assert.equal(funding.rows.length,1);assert.equal(funding.rows[0].kind,'portfolio');
  assert.equal(funding.counts.Funding,1);
  const overview=projectDirectory([transferred],[parent],{filter:'all'});
  assert.equal(overview.rows.length,1);assert.equal(overview.all.some(row=>row.pool===single.pool),false);
  assert.equal(transferred.status,'Funding');assert.equal(transferred.state,0n);
  assert.equal(projectDirectory([transferred],[],{query:single.pool}).rows.length,0);
  const funded={...transferred,status:'Funded',state:1n,
    targetAvailability:{...transferred.targetAvailability,chainState:1n}};
  assert.equal(projectDirectory([funded],[],{filter:'Funding'}).rows.length,0);
  assert.equal(projectDirectory([funded],[],{filter:'all'}).rows.length,0);
  assert.equal(funded.status,'Funded');assert.equal(funded.state,1n);
});

test('a fixed target with no official or Firsto listing is hidden while ownership and personal data remain unchanged',()=>{
  const row={...transferred,shares:40n,bnbOwed:15n,targetAvailability:{...transferred.targetAvailability,
    currentOwner:transferred.targetAvailability.originalOwner,reason:'target_listing_unavailable',
    listingEvidence:{official:'absent',firsto:'absent',observedAt:new Date().toISOString(),validUntil:new Date(Date.now()+60000).toISOString()}}};
  for(const filter of ['Funding','all']){
    const catalog=projectDirectory([row],[],{filter});
    assert.equal(catalog.rows.length,0);assert.equal(catalog.counts.Funding,0);
  }
  assert.equal(row.state,0n);assert.equal(row.shares,40n);assert.equal(row.bnbOwed,15n);
  for(const listingEvidence of [{...row.targetAvailability.listingEvidence,firsto:'unknown'},
    {...row.targetAvailability.listingEvidence,observedAt:new Date(Date.now()-120001).toISOString()},
    {...row.targetAvailability.listingEvidence,validUntil:new Date(Date.now()-1).toISOString()}]){
    assert.equal(projectDirectory([{...row,targetAvailability:{...row.targetAvailability,listingEvidence}}],[],{filter:'Funding'}).rows.length,1);
  }
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

test('total funding amount uses the original miner target or portfolio budget, not unit price or purchase cost',()=>{
  const precise=900719925474099300001n;
  assert.equal(projectTargetRaiseWei({...single,params:{targetRaise:precise},targetRaiseWei:2n}),precise);
  assert.equal(projectTargetRaiseWei({...single,targetRaiseWei:precise.toString()}),precise);
  assert.equal(projectTargetRaiseWei({...parent,spentWei:1n,params:{targetRaise:2n}}),parent.budgetWei);
  assert.equal(projectTargetRaiseWei(single),null);
  assert.equal(projectTargetRaiseWei({...single,params:{targetRaise:'1.2345 BNB'},targetRaiseWei:2n}),null);
  assert.equal(projectTargetRaiseWei({...parent,budgetWei:null,spentWei:2n}),null);
  const cheapShares={...single,pool:'low-target',unitPriceWei:precise,params:{targetRaise:10n}};
  const expensiveTarget={...single,pool:'high-target',unitPriceWei:1n,params:{targetRaise:precise}};
  const result=projectDirectory([expensiveTarget,cheapShares],[parent],{sort:'total'});
  assert.deepEqual(result.rows.map(row=>row.pool),['low-target',parent.pool,'high-target']);
  assert.equal(cheapShares.params.targetRaise,10n);
  assert.equal(parent.budgetWei,1000000000000000100n);
});

test('every numeric column sorts raw integers in both directions with unknown values last',()=>{
  const low=900719925474099300000n, high=low+1n;
  const row=(pool,value)=>({...single,pool,tokenId:value?.toString()??null,totalSupply:value,
    funded:value,members:value,memberCount:value,unitPriceWei:value,params:{targetRaise:value},
    hashPower:value?.toString()??null,estimated24hAtomic:value,capacityWei:value});
  const rows=[row('unknown',null),row('high',high),row('low',low)];
  const options={capacityFor:r=>r.capacityWei,hashPowerFor:r=>r.hashPower,dailyFor:r=>r.estimated24hAtomic};
  for(const field of ['funded','price','total','hash','daily','capacity','members','id']){
    for(const direction of ['asc','desc']){
      const result=projectDirectory(rows,[],{...options,sort:projectSortValue(field,direction)});
      assert.deepEqual(result.rows.map(r=>r.pool),direction==='asc'?['low','high','unknown']:['high','low','unknown'],`${field} ${direction}`);
    }
  }
  assert.deepEqual(rows.map(r=>r.pool),['unknown','high','low']);
});

test('formatted amounts, unsafe numbers and malformed metadata never become sort keys',()=>{
  const rows=[{...single,pool:'formatted',unitPriceWei:'1,000.0000'},
    {...single,pool:'unsafe',unitPriceWei:Number.MAX_SAFE_INTEGER+1},
    {...single,pool:'negative',unitPriceWei:-1n},
    {...single,pool:'known',unitPriceWei:0n}];
  for(const sort of ['price','price-desc']){
    assert.deepEqual(projectDirectory(rows,[],{sort}).rows.map(r=>r.pool),['known','formatted','unsafe','negative']);
  }
  for(const invalid of ['verified','1.25',NaN,-6n]){
    const result=projectDirectory([{...single,pool:'unknown'},{...single,pool:'known'}],[],{
      sort:'hash-desc',hashPowerFor:r=>r.pool==='known'?'6':invalid});
    assert.equal(result.rows[0].pool,'known');
  }
});

test('funded and participant sorting use the same original counters projected by the public rows',()=>{
  const moreShares={...single,pool:'more-shares',totalSupply:75n,funded:1,memberCount:2n,members:99};
  const moreMembers={...single,pool:'more-members',totalSupply:25n,funded:99,memberCount:3n,members:1};
  assert.equal(projectDirectory([moreMembers,moreShares],[parent],{sort:'funded'}).rows[0].pool,'more-shares');
  assert.equal(projectDirectory([moreMembers,moreShares],[],{sort:'members-desc'}).rows[0].pool,'more-members');
  const projected=portfolioDirectoryRow(parent);
  assert.equal(projected.funded,Number(parent.totalSupply));
  assert.equal(projected.members,Number(parent.memberCount));
  assert.equal(projected.funded,25);
  assert.equal(projected.members,3);
});

test('miner type filtering is shared by Funding, Active, Listed and the grouped overview',()=>{
  const rows=['Funding','Active','Listed'].flatMap((status,index)=>[
    {...single,pool:`tape-${index}`,status},
    {...single,pool:`behemoth-${index}`,name:'Behemoth',status}]);
  for(const filter of ['Funding','Active','Listed','all']){
    for(const minerType of ['TapeOut','Behemoth']){
      const result=projectDirectory(rows,[parent],{filter,minerType});
      assert.equal(result.rows.length,filter==='all'?3:1);
      assert.ok(result.rows.every(r=>r.name===minerType&&r.kind!=='portfolio'));
      assert.equal(result.counts.Funding,3);
    }
  }
  assert.equal(projectDirectory(rows,[parent],{minerType:'all'}).rows.length,7);
  assert.equal(projectDirectory(rows,[parent],{minerType:'TapeOut',query:'behemoth'}).rows.length,0);
});

test('header toggles and menu aliases share the exact field and direction',()=>{
  assert.deepEqual(projectSortState('funded'),{field:'funded',direction:'desc'});
  assert.deepEqual(projectSortState('funded-desc'),projectSortState('funded'));
  assert.equal(toggleProjectSort('funded','funded'),'funded-asc');
  assert.equal(toggleProjectSort('funded-asc','funded'),'funded');
  for(const field of ['price','total','hash','daily','capacity','members','id']){
    const ascending=toggleProjectSort('funded',field);
    assert.deepEqual(projectSortState(ascending),{field,direction:'asc'});
    const descending=toggleProjectSort(ascending,field);
    assert.deepEqual(projectSortState(descending),{field,direction:'desc'});
    assert.equal(toggleProjectSort(descending,field),ascending);
  }
  for(const invalid of [null,'unknown-desc','price-sideways','total-desc-extra']){
    assert.deepEqual(projectSortState(invalid),{field:'funded',direction:'desc'});
  }
  assert.equal(projectSortValue('unknown','asc'),'funded');
  assert.equal(projectSortValue('price','sideways'),'funded');
});

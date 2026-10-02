import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface, Wallet, Transaction, keccak256, parseEther } from 'ethers';
import { createSaleReferencePublisher, readSaleReferenceDemand, readSaleReferencePublisherStatus,
  saleReferencePublisherConfiguration,budgetCandidatePassed,readBudgetSaleReferenceDemands } from './sale-reference-publisher.mjs';
import { trackSaleReferences } from './authority-signer.mjs';

const address=n=>`0x${n.toString(16).padStart(40,'0')}`,factory=address(1),market=address(2),pool=address(3);
const iface=new Interface(['function automaticSaleReferenceVersion() returns(uint256)',
  'function saleReferencePublisher() returns(address)','function publishSaleReference(address,uint128,uint64,bytes32)']);
function fixture({capability=true,busy=false,sourceError=false,ambiguous=false,eligible=true}={}) {
  let clock=1790904988000,quoteReads=0,holderReads=0,signatures=0,broadcasts=0,graphReads=0,reconciles=0;
  let journal={version:1,chainId:56,factory,pool:market,transactionTarget:market,transaction:null,gasSpentWei:'0',gasReceipts:{}};
  const wallet=Wallet.createRandom(),writes=[],publications=[],ref={marketPriceWei:0n,observedAt:0n},options={
    journal:'/private/reference.json',statusPath:'/public/status.json',gasLimit:200_000n,maxGasWei:parseEther('0.001'),
    hourlyGasWei:parseEther('0.01'),maxGasPrice:1_000_000_000n,minIntervalMs:120_000,refreshMarginSeconds:120,batch:10,maxPools:1000,
    baseUrl:'https://official.example'};
  const provider={async call(tx){const method=iface.parseTransaction(tx).name;return iface.encodeFunctionResult(method,
    method==='automaticSaleReferenceVersion'?[capability?1n:0n]:[wallet.address]);},
    async getFeeData(){return {gasPrice:100_000_000n};},async getBalance(){return parseEther('1');},
    async getTransactionCount(){return 4;},async getNetwork(){return {chainId:56n};},
    async getBlock(){return {gasLimit:30_000_000n};},async broadcastTransaction(raw){broadcasts++;
      assert.equal(journal.transaction.phase,'signed');assert.equal(journal.transaction.attempts[0].broadcastCount,1);
      const tx=Transaction.from(raw);assert.equal(tx.to.toLowerCase(),market);assert.equal(tx.nonce,4);assert.equal(tx.value,0n);
      const parsed=iface.parseTransaction(tx);assert.equal(parsed.name,'publishSaleReference');assert.equal(parsed.args[0].toLowerCase(),pool);
      assert.equal(parsed.args[1],34436343241727426n);assert.equal(tx.from,wallet.address);
      if(ambiguous)throw new Error('network failed after submission');return {hash:keccak256(raw)};}};
  const signer={getAddress:()=>wallet.getAddress(),async signTransaction(tx){signatures++;return wallet.signTransaction(tx);}};
  const dependencies={now:()=>clock,lockJournal:()=>()=>{},lockWallet:()=>{if(busy)throw new Error('Wallet has an unresolved transaction in another pool journal. Reconcile that journal first.');return ()=>{};},
    readJournal:()=>journal,writeJournal:(_path,value)=>{journal=value;writes.push(structuredClone(value));},
    reconcilePending:async()=>{reconciles++;return journal.transaction&&!['confirmed','reverted'].includes(journal.transaction.phase)?{status:'pending-receipt'}:null;},
    publishStatus:(_path,value)=>publications.push(structuredClone(value)),discoverPools:async()=>[pool],
    readDemand:async()=>({pool,eligible,proposalId:1n,reference:ref,params:async()=>({circuits:address(9),circuitId:16736n})}),
    readReference:async()=>{holderReads++;return {};},readQuote:async options=>{quoteReads++;await options.referenceLoader();
      if(sourceError)throw new Error('old official source');return {validUntil:clock+120000,args:{market,pool,
        priceWei:'34436343241727426',observedAt:String(Math.floor(clock/1000)),digest:`0x${'11'.repeat(32)}`}};}};
  const publisher=createSaleReferencePublisher({config:options,provider,signer,factory,market,
    verifyDeployment:async()=>{graphReads++;},dependencies});
  return {publisher,options,dependencies,provider,ref,writes,publications,
    get journal(){return journal;},set journal(value){journal=value;},advance(ms){clock+=ms;},
    get quoteReads(){return quoteReads;},get holderReads(){return holderReads;},get signatures(){return signatures;},
    get broadcasts(){return broadcasts;},get graphReads(){return graphReads;},get reconciles(){return reconciles;},
    get status(){return publisher.snapshot().pools[pool];},get now(){return clock;}};
}

test('automatic reference signs only the exact restricted market function and journals before broadcast',async()=>{
  const f=fixture();await f.publisher.tick();assert.equal(f.signatures,1);assert.equal(f.broadcasts,1);assert.equal(f.graphReads,1);
  assert.equal(f.status.status,'pending');assert.equal(f.journal.transaction.reference.proposalId,'1');
  assert(f.writes.some(value=>value.transaction?.phase==='signed'&&value.transaction.attempts[0].broadcastCount===0));
  await f.publisher.close();
});
test('unsupported market never reads official prices or signs and cannot report auto-reference enabled',async()=>{
  const f=fixture({capability:false});await f.publisher.tick();assert.equal(f.publisher.snapshot().enabled,false);
  assert.equal(f.quoteReads,0);assert.equal(f.signatures,0);await f.publisher.close();
});
test('unpassed or executed demand causes no quote, signature or broadcast',async()=>{
  const f=fixture({eligible:false});await f.publisher.tick();assert.equal(f.status.status,'idle');
  assert.equal(f.quoteReads,0);assert.equal(f.signatures,0);await f.publisher.close();
});
test('a sufficiently fresh existing reference is reused without Gas',async()=>{
  const f=fixture();f.ref.marketPriceWei=50n;f.ref.observedAt=BigInt(Math.floor(f.now/1000)-100);await f.publisher.tick();
  assert.equal(f.status.status,'confirmed');assert.equal(f.signatures,0);assert.equal(f.quoteReads,0);await f.publisher.close();
});
test('source outage preserves a previous displayed price without fabricating freshness',async()=>{
  const f=fixture({sourceError:true});f.ref.marketPriceWei=50n;f.ref.observedAt=BigInt(Math.floor(f.now/1000)-100);
  await f.publisher.tick();f.advance(250000);await f.publisher.tick();assert.equal(f.status.status,'source-unavailable');
  assert.equal(f.status.priceWei,'50');assert.equal(f.signatures,0);await f.publisher.close();
});
test('foreign wallet reservation queues publication and never releases or erases the foreign journal',async()=>{
  const f=fixture({busy:true});await f.publisher.tick();assert.equal(f.status.status,'queued');assert.equal(f.signatures,0);
  assert.equal(f.journal.transaction,null);await f.publisher.close();
});
test('ambiguous broadcast and process restart reconcile only the exact durable hash without new signing',async()=>{
  const f=fixture({ambiguous:true});await f.publisher.tick();const hash=f.journal.transaction.hash;
  assert.equal(f.journal.transaction.phase,'signed');await f.publisher.tick();assert.equal(f.signatures,1);assert.equal(f.broadcasts,1);
  await f.publisher.close();const restarted=createSaleReferencePublisher({config:f.options,provider:f.provider,
    signer:{async getAddress(){throw new Error('no signing permitted during recovery');}},factory,market,verifyDeployment:()=>{},dependencies:f.dependencies});
  await restarted.tick();assert.equal(restarted.snapshot().pools[pool].hash,hash);assert.equal(f.signatures,1);await restarted.close();
});
test('finalized failed publication stays on operator hold and is never acknowledged automatically',async()=>{
  const f=fixture();await f.publisher.tick();Object.assign(f.journal.transaction,{phase:'reverted',confirmedAt:new Date(f.now).toISOString(),gasCostWei:'20000000000000'});
  await f.publisher.tick();assert.equal(f.status.status,'review-required');assert.equal(f.signatures,1);assert.equal(f.journal.transaction.phase,'reverted');await f.publisher.close();
});
test('rolling hourly Gas budget pauses and resumes after the hour, rather than imposing a permanent attempt limit',async()=>{
  const f=fixture();await f.publisher.tick();Object.assign(f.journal.transaction,{phase:'confirmed',confirmedAt:new Date(f.now).toISOString(),gasCostWei:'20000000000000'});
  f.options.hourlyGasWei=30000000000000n;f.advance(121000);await f.publisher.tick();assert.equal(f.status.status,'gas-paused');assert.equal(f.signatures,1);
  f.advance(3600000);await f.publisher.tick();assert.equal(f.signatures,2);assert.equal(f.broadcasts,2);await f.publisher.close();
});
test('overlapping timer calls share the same job and never spend another nonce',async()=>{
  const f=fixture();const a=f.publisher.tick(),b=f.publisher.tick();assert.equal(a,b);await a;
  assert.equal(f.signatures,1);await f.publisher.close();
});
test('configuration isolates private journal from public status and bounds Gas exposure',()=>{
  const env={SALE_REFERENCE_PUBLISHER_ENABLED:'1',SALE_REFERENCE_PUBLISHER_JOURNAL:'/private/reference.json',SALE_REFERENCE_STATUS_PATH:'/public/status.json'};
  const config=saleReferencePublisherConfiguration(env,{journal:'/private/authority.json'});assert.equal(config.gasLimit,200000n);
  assert.equal(saleReferencePublisherConfiguration({},{}),null);
  assert.throws(()=>saleReferencePublisherConfiguration({...env,SALE_REFERENCE_PUBLISHER_JOURNAL:'/other/ref.json'},{journal:'/private/authority.json'}));
  assert.throws(()=>saleReferencePublisherConfiguration({...env,SALE_REFERENCE_HOURLY_GAS_BNB:'1'},{journal:'/private/authority.json'}));
});
test('public status reads are bounded, deployment-specific and clearly stale without any wallet work',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ref-status-')),path=join(dir,'status.json'),now=1790904988000;
  try{const row={pool,status:'confirmed',proposalId:'1',priceWei:'50',observedAt:1790904900};
    writeFileSync(path,JSON.stringify({schemaVersion:1,chainId:56,factory,market,enabled:true,updatedAt:new Date(now-100000).toISOString(),pools:{[pool]:row}}));
    const value=readSaleReferencePublisherStatus(path,{factory,market,pool,now:()=>now});assert.equal(value.stale,true);assert.equal(value.item.priceWei,'50');
    assert.throws(()=>readSaleReferencePublisherStatus(path,{factory:address(44),market,pool,now:()=>now}));
    assert.equal(readSaleReferencePublisherStatus(null,{factory,market,pool}).item.status,'disabled');
  }finally{rmSync(dir,{recursive:true});}
});

test('budget demand uses strict holder and share majorities of the active round, never equality or expired votes',()=>{
  const round={executed:false,endsAt:2000n},candidate={...round,price:1n,memberCount:4n,yesMembers:3n,yesShares:51n};
  assert.equal(budgetCandidatePassed(candidate,round,1000),true);
  for(const change of [{yesMembers:2n},{yesShares:50n},{executed:true},{endsAt:1999n},{price:0n}])
    assert.equal(budgetCandidatePassed({...candidate,...change},round,1000),false);
  assert.equal(budgetCandidatePassed(candidate,round,2000),false);
  assert.equal(budgetCandidatePassed(candidate,{...round,executed:true},1000),false);
});

test('a passed budget candidate is discovered before any child proposal exists; bounds and identity remain checked',async()=>{
  const parent=address(10),views=new Interface(['function state() returns(uint8)','function legacyFactory() returns(address)',
    'function activeProposalId() returns(uint256)','function nextProposalId() returns(uint256)',
    'function proposals(uint256) returns(address child,uint256 price,uint256 referencePrice,uint64 referenceAt,uint64 endsAt,uint16 memberCount,uint16 yesMembers,uint16 yesShares,bool executed)',
    'function childInfo(address) returns(address collection,uint256 tokenId,uint256 purchaseCost,bool official,bool sold)']);
  let next=3n,bound=factory;const calls=[];
  const provider={async call(tx){assert.equal(tx.to.toLowerCase(),parent);const parsed=views.parseTransaction(tx);calls.push(parsed.name);
    const name=parsed.name,value={state:[2n],legacyFactory:[bound],activeProposalId:[1n],nextProposalId:[next],
      childInfo:[address(11),16736n,40n,true,false]}[name];
    if(value)return views.encodeFunctionResult(name,value);
    const passed=parsed.args[0]===2n;return views.encodeFunctionResult('proposals',[pool,40n,40n,900n,2000n,4n,passed?3n:2n,51n,false]);}};
  const demands=await readBudgetSaleReferenceDemands(provider,{factory,parent,now:()=>1000000});
  assert.deepEqual(demands,[{parent,pool,proposalId:2n,endsAt:2000n}]);assert.equal(calls.filter(name=>name==='proposals').length,2);
  assert(!calls.includes('proposalPassed'),'Parent majority reads do not wait for a child proposal that has not been created.');
  next=18n;await assert.rejects(readBudgetSaleReferenceDemands(provider,{factory,parent,now:()=>1000000}),/bound/);
  next=3n;bound=address(88);await assert.rejects(readBudgetSaleReferenceDemands(provider,{factory,parent,now:()=>1000000}),/Factory/);
});

test('expired single-miner rounds stop publication even though proposalPassed still reports its vote result',async()=>{
  const views=new Interface(['function state() returns(uint8)','function activeProposalId() returns(uint256)',
    'function nextProposalId() returns(uint256)','function salePrice() returns(uint256)',
    'function getProposal(uint256) returns(tuple(address proposer,uint48 snapshotTs,uint64 endsAt,uint64 refAt,uint256 price,uint256 refPrice,uint256 snapshotMemberCount,uint256 snapshotTotalShares,uint256 yesCount,uint256 yesShares,bool executed))']);
  const provider={async call(tx){const parsed=views.parseTransaction(tx),values={state:[2n],activeProposalId:[1n],nextProposalId:[2n],salePrice:[0n]};
    if(values[parsed.name])return views.encodeFunctionResult(parsed.name,values[parsed.name]);
    return views.encodeFunctionResult('getProposal',[[address(7),800n,1000n,800n,40n,40n,1n,100n,1n,100n,false]]);}};
  const demand=await readSaleReferenceDemand(provider,{market,pool,now:()=>1000000});assert.equal(demand.eligible,false);
});

test('automatic publication timer never overlaps and shutdown waits for its running job',async()=>{
  let calls=0,finish;const work=new Promise(resolve=>{finish=resolve;});
  const stop=trackSaleReferences({publishSaleReferences:()=>{calls++;return work;}},{intervalMs:1,onError:()=>assert.fail('unexpected timer error')});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
  let ended=false;const closing=stop().then(()=>{ended=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(ended,false);
  finish();await closing;await new Promise(resolve=>setTimeout(resolve,5));assert.equal(calls,1);
});

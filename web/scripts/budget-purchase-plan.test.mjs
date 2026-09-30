import test from 'node:test';
import assert from 'node:assert/strict';
import { ZeroAddress, getAddress } from 'ethers';
import { selectBudgetCandidates,discoverBudgetPurchasePlan,validateBudgetQueue,prepareBudgetQueueStep,beginBudgetQueueStep,
  applyBudgetQueueResult,nextBudgetQueueItem,budgetQueuePreviewMatches,reconcileBudgetQueue,
  restoreBudgetQueueBeforeSubmission,budgetPurchaseQueueSupported } from '../lib/budget-purchase-plan.mjs';
import { parseFirstoSignedAsk } from '../../deploy/src/firsto-purchase.mjs';
import { signedSource,now as sourceNow } from '../../deploy/scripts/fixtures/firsto-order.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JournalStore, JournalConflict } from '../../deploy/server/journal-store.mjs';
import { abi } from '../lib/chain-client.mjs';
const address=n=>getAddress(`0x${n.toString(16).padStart(40,'0')}`),H=`0x${'a'.repeat(64)}`,D=`0x${'d'.repeat(64)}`;
const C=getAddress('0xb1024b89886b9a34aa4ff5f31c411d708b20a14c'),account=address(1),parent=address(2),factory=address(3),portfolioFactory=address(4),child=address(5);
const config={kind:'integrated-v2',factory,portfolioFactory,artifactDigest:D,stage:'role-wired',operationalReady:true};
const candidate=(token,cost=200)=>({collection:C,tokenId:String(token),costWei:String(cost),verifiedWeight:'10',venue:'official',listingId:String(token)});
function fixture(candidates=[candidate(1),candidate(2)]){
  const row={budgetWei:1000n,spentWei:0n,absoluteCapWei:500n,unitCapWei:100n,purchaseDeadline:2000n,timestamp:1000n};
  const snapshot={complete:true,blockNumber:10,blockHash:H,observedAt:Date.now()};
  const context={block:{number:'0xa',hash:H},tag:'0xa',manifest:config,canonical:async()=>{},read:async(_to,_abi,name)=>{
    if(name==='params')return [{circuits:C,circuitId:1n,targetRaise:200n,priceCap:200n,directSeller:ZeroAddress,directPrice:0n,fundingDeadline:1999n,purchaseDeadline:2000n}];
    if(name==='designatedSubscriber')return [parent];
    return [{factory, state:0n,totalSupply:0n}[name]];
  }};
  const readParent=async()=>({row,context}),readOfficial=async()=>({...config,parent,budgetWei:'1000',spentWei:'0',absoluteCapWei:'500',unitCapWei:'100',snapshot,candidates});
  const discover=()=>discoverBudgetPurchasePlan({config,provider:{},account,parent,limitWei:600n,readParent,readOfficial,quotePage:()=>{throw Error('Firsto must not run');}});
  const readMiner=async()=>({blockHash:H,verifiedWeight:'10',registry:{ready:true,pool:ZeroAddress},official:{priceWei:'200',id:'1'}});
  const prepareCreate=async input=>{assert.equal(input.kind,'createBudgetChildPool');assert.equal(input.subscriber,parent);return {transaction:{from:account,to:factory,data:'0x1234',chainId:'0x38',value:'0x0'},kind:input.kind};};
  return {row,context,readParent,readOfficial,discover,readMiner,prepareCreate};
}
function final(phase,overrides={}){return{status:'confirmed',finalized:true,account,target:phase==='create'?factory:parent,
  factory:phase==='create'?factory:portfolioFactory,action:phase==='create'?'createBudgetChildPool':'buyOfficial',hash:H,nonce:4,poolAddress:child,
  receipt:{transactionHash:H,status:1},...overrides};}

test('genesis and incomplete fresh Authority configuration cannot discover or submit a budget child purchase',async()=>{
  const f=fixture();let reads=0;
  for(const stage of ['genesis','fresh-active']){
    const blocked={...config,stage};
    assert.equal(budgetPurchaseQueueSupported(blocked),false);
    await assert.rejects(discoverBudgetPurchasePlan({config:blocked,provider:{},account,parent,readParent:async()=>{reads++;return f.readParent();}}),/contract stage/);
    await assert.rejects(prepareBudgetQueueStep({config:blocked,provider:{},account,parent,plan:{},index:0,readParent:async()=>{reads++;return f.readParent();}}),/contract stage/);
  }
  assert.equal(budgetPurchaseQueueSupported({...config,operationalReady:false}),false);
  assert.equal(budgetPurchaseQueueSupported(config),true);
  assert.equal(budgetPurchaseQueueSupported({...config,stage:'fresh-active',authority:address(10),gasWallet:address(11)}),true);
  assert.equal(budgetPurchaseQueueSupported({...config,stage:'fresh-active',authority:address(10),gasWallet:address(11),transactionReady:false}),false);
  assert.equal(reads,0);
});

test('candidate selection respects exact temporary funding and deduplicates permanent NFT identity',()=>{
  assert.deepEqual(selectBudgetCandidates([candidate(1,101),candidate(1,101),candidate(2,100)],{remainingWei:250n,limitWei:250n}).map(x=>x.tokenId),['2']);
  assert.equal(selectBudgetCandidates([candidate(1,101)],{remainingWei:200n,limitWei:101n})[0].targetRaiseWei,'200');
});

test('full official candidates always precede Firsto, approval binds budget and NFT identity',async()=>{
  const f=fixture(),plan=await f.discover();assert.equal(plan.items.length,2);assert.equal(plan.approved,false);
  for(const update of [{account:address(99)},{parent:address(99)},{limitWei:'601'},{factory:address(99)}])
    assert.throws(()=>validateBudgetQueue({...plan,...update},{config,account,parent}));
  const duplicate=structuredClone(plan);duplicate.items[1]=duplicate.items[0];assert.throws(()=>validateBudgetQueue(duplicate),/Duplicate/);
});

test('incomplete official discovery never authorizes Firsto fallback',async()=>{
  const f=fixture([]);let requested=false;
  await assert.rejects(discoverBudgetPurchasePlan({config,provider:{},account,parent,readParent:f.readParent,
    readOfficial:async()=>{throw Error('Official unavailable');},quotePage:async()=>{requested=true;}}),/Official/);
  assert.equal(requested,false);
});

test('invalid Firsto pagination fails closed before any candidate is authorized',async()=>{
  const f=fixture([]);
  for(const response of [{page:1,totalPages:6,excluded:0,rows:[]},{page:1,totalPages:1,excluded:1,rows:[]}])
    await assert.rejects(discoverBudgetPurchasePlan({config,provider:{},account,parent,readParent:f.readParent,readOfficial:f.readOfficial,
      quotePage:async()=>response}),/分页/);
});

test('Firsto accepts a bounded pinned view over 250 rows, verifies selected asks and rechecks before child creation',async()=>{
  const f=fixture([]),source=await signedSource({price:'100'}),order=parseFirstoSignedAsk(source,{collection:C,tokenId:'7',owner:source.account,now:sourceNow});
  const quote={collection:C,tokenId:'7',status:'verified',verifiedWeight:'10',unverifiedWeight:'0',ask:source};let pages=0,verifications=0;
  const discover=()=>discoverBudgetPurchasePlan({config,provider:{},account,parent,limitWei:600n,readParent:f.readParent,readOfficial:f.readOfficial,
    quotePage:async({page,viewId})=>{pages++;if(page>1)assert.equal(viewId,'pinned');return {page,totalPages:100,total:5000,viewId:'pinned',sourceBlock:'10',excluded:0,rows:[quote]};},
    checkQuote:async()=>({blockHash:H,registry:{ready:true,pool:ZeroAddress},official:null,firsto:order})});
  const plan={...await discover(),approved:true};assert.equal(plan.items[0].venue,'firsto');assert.equal(plan.items[0].maxCostWei,'101');assert.equal(pages,5);
  assert.equal(plan.firstoView.truncated,true);assert.equal(plan.firstoView.pagesRead,5);
  const input={config,provider:{},account,parent,plan,index:0,readParent:f.readParent,readOfficial:f.readOfficial,
    readMiner:async()=>({...await f.readMiner(),official:null}),prepareCreate:f.prepareCreate,
    verifyOrder:async(_provider,decoded)=>{verifications++;assert.equal(decoded.askHash,order.askHash);return order;}};
  assert.equal((await prepareBudgetQueueStep(input)).phase,'create');assert.equal(verifications,1);
  await assert.rejects(prepareBudgetQueueStep({...input,readOfficial:async()=>({...await f.readOfficial(),candidates:[candidate(9)]})}),/官网候选/);
  await assert.rejects(prepareBudgetQueueStep({...input,verifyOrder:async()=>({...order,grossWei:'102'})}),/cap/);
});

test('changing Firsto view identity never mixes pages',async()=>{
  const f=fixture([]);await assert.rejects(discoverBudgetPurchasePlan({config,provider:{},account,parent,readParent:f.readParent,readOfficial:f.readOfficial,
    quotePage:async({page})=>({page,totalPages:2,total:100,viewId:`view-${page}`,sourceBlock:'10',excluded:0,rows:[]})}),/view changed/);
});

test('each creation is zero value and parent-bound; pending steps cannot produce another transaction',async()=>{
  const f=fixture(),plan={...await f.discover(),approved:true};
  const input={config,provider:{},account,parent,plan,index:0,readParent:f.readParent,readMiner:f.readMiner,prepareCreate:f.prepareCreate};
  const preview=await prepareBudgetQueueStep(input);assert.equal(preview.phase,'create');assert.equal(preview.transaction.value,'0x0');
  const started=beginBudgetQueueStep(plan,preview);assert.equal(started.items[0].status,'creating');
  await assert.rejects(prepareBudgetQueueStep({...input,plan:started}),/未知/);
  const pending=applyBudgetQueueResult(started,0,{status:'pending',hash:H});assert.equal(pending.items[0].status,'pending');
  await assert.rejects(prepareBudgetQueueStep({...input,plan:pending}),/未知/);
  assert.throws(()=>applyBudgetQueueResult(pending,0,final('create',{account:address(99)})),/receipt/);
  const created=applyBudgetQueueResult(pending,0,final('create'));assert.equal(created.items[0].child,child);assert.equal(created.items[0].status,'created');
});

test('reserved NFTs, changed parent balance or weight stop before building a creation transaction',async()=>{
  const f=fixture(),plan={...await f.discover(),approved:true};let creations=0;
  const input={config,provider:{},account,parent,plan,index:0,readParent:f.readParent,readMiner:f.readMiner,prepareCreate:async()=>{creations++;return f.prepareCreate();}};
  await assert.rejects(prepareBudgetQueueStep({...input,readMiner:async()=>({...await f.readMiner(),registry:{ready:true,pool:child}})}),/永久/);
  await assert.rejects(prepareBudgetQueueStep({...input,readMiner:async()=>({...await f.readMiner(),verifiedWeight:'9'})}),/weight/);
  f.row.spentWei=500n;await assert.rejects(prepareBudgetQueueStep(input),/budget/);assert.equal(creations,0);
});

test('created child is checked empty and exact before parent purchase; purchase failures advance only after final receipt',async()=>{
  const f=fixture(),plan={...await f.discover(),approved:true};
  const original=await prepareBudgetQueueStep({config,provider:{},account,parent,plan,index:0,readParent:f.readParent,readMiner:f.readMiner,prepareCreate:f.prepareCreate});
  const created=applyBudgetQueueResult(beginBudgetQueueStep(plan,original),0,final('create'));
  let purchases=0;const input={config,provider:{},account,parent,plan:created,index:0,readParent:f.readParent,
    readMiner:async()=>({...await f.readMiner(),registry:{ready:true,pool:child}}),preparePurchase:async()=>{purchases++;return {
      transaction:{from:account,to:parent,data:'0xabcd',chainId:'0x38',value:'0x0'},action:{kind:'buyOfficial',targetType:'portfolio'},
      procurement:{route:'official',priceWei:200n}};}};
  const preview=await prepareBudgetQueueStep(input);assert.equal(preview.phase,'purchase');
  const read=f.context.read;f.context.read=async(...args)=>args[2]==='totalSupply'?[1n]:read(...args);
  await assert.rejects(prepareBudgetQueueStep(input),/状态改变/);assert.equal(purchases,1);
  const started=beginBudgetQueueStep(created,preview);
  assert.throws(()=>applyBudgetQueueResult(started,0,final('purchase',{factory:factory})),/identity/);
  const failed=applyBudgetQueueResult(started,0,final('purchase',{status:'reverted',receipt:{transactionHash:H,status:0}}));
  assert.equal(failed.items[0].status,'failed');assert.equal(nextBudgetQueueItem(failed),1);
  const done=applyBudgetQueueResult(started,0,final('purchase'));assert.equal(done.items[0].status,'completed');
  assert(!budgetQueuePreviewMatches(preview,{...preview,procurement:{route:'official',priceWei:201n}}));
});

test('server queue survives restart, rejects stale revisions and preserves unresolved wallet steps',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'bemine-budget-queue-')),path=join(directory,'private','journal.sqlite');
  try{
    const f=fixture(),plan={...await f.discover(),approved:true};
    let store=new JournalStore(path);
    assert.deepEqual(store.budgetQueue(account.toLowerCase(),parent.toLowerCase()),{revision:0,record:null});
    assert.equal(store.putBudgetQueue(account.toLowerCase(),parent.toLowerCase(),plan,0),1);
    store.close();store=new JournalStore(path);
    assert.equal(store.budgetQueue(account.toLowerCase(),parent.toLowerCase()).record.id,plan.id);
    assert.throws(()=>store.putBudgetQueue(account.toLowerCase(),parent.toLowerCase(),plan,0),JournalConflict);
    const prepared=await prepareBudgetQueueStep({config,provider:{},account,parent,plan,index:0,readParent:f.readParent,
      readMiner:f.readMiner,prepareCreate:f.prepareCreate});
    const begun=beginBudgetQueueStep(plan,prepared);
    assert.equal(store.putBudgetQueue(account.toLowerCase(),parent.toLowerCase(),begun,1),2);
    const other={...await f.discover(),approved:true};
    assert.throws(()=>store.putBudgetQueue(account.toLowerCase(),parent.toLowerCase(),other,2),JournalConflict);
    const pending=applyBudgetQueueResult(begun,0,{status:'pending',hash:H});
    assert.equal(store.putBudgetQueue(account.toLowerCase(),parent.toLowerCase(),pending,2),3);
    const erased=structuredClone(pending);delete erased.items[0].hash;erased.revision++;
    assert.throws(()=>store.putBudgetQueue(account.toLowerCase(),parent.toLowerCase(),erased,3),JournalConflict);
    store.close();
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('a proven failure before entering the send routine restores the previous step with a new CAS revision',async()=>{
  const f=fixture(),plan={...await f.discover(),approved:true};
  const preview=await prepareBudgetQueueStep({config,provider:{},account,parent,plan,index:0,readParent:f.readParent,readMiner:f.readMiner,prepareCreate:f.prepareCreate});
  const begun=beginBudgetQueueStep(plan,preview),restored=restoreBudgetQueueBeforeSubmission(begun,0);
  assert.equal(restored.items[0].status,'ready');assert.equal(restored.revision,2);assert.equal(restored.items[0].intent,undefined);
  const pending=applyBudgetQueueResult(begun,0,{status:'pending',hash:H});assert.throws(()=>restoreBudgetQueueBeforeSubmission(pending,0),/Cannot undo/);
});

test('recovery only reads: an empty journal is not permission to resend; archived receipts must match calldata',async()=>{
  const f=fixture(),plan={...await f.discover(),approved:true};
  const preview=await prepareBudgetQueueStep({config,provider:{},account,parent,plan,index:0,readParent:f.readParent,readMiner:f.readMiner,prepareCreate:f.prepareCreate});
  const begun=beginBudgetQueueStep(plan,preview),calls=[];let input='0x9999';
  const provider={request:async({method})=>{calls.push(method);if(method==='eth_accounts')return [account];if(method==='eth_chainId')return '0x38';
    if(method==='eth_getTransactionByHash')return {hash:H,from:account,to:factory,chainId:'0x38',nonce:'0x4',value:'0x0',input};throw Error(`No signing: ${method}`);}};
  const result={...final('create'),transactionHash:H,receipt:{transactionHash:H,status:1,to:factory,blockNumber:10,blockHash:H}};
  const fetcher=async url=>new Response(JSON.stringify(url.includes('/result?')?{result}:{revision:0,record:null}),{status:200,headers:{'Content-Type':'application/json'}});
  await assert.rejects(reconcileBudgetQueue({config,provider,account,parent,plan:begun,index:0,fetcher}),/原意图/);
  await assert.rejects(reconcileBudgetQueue({config,provider,account,parent,plan:begun,index:0,hash:H,fetcher}),/differs/);
  input='0x1234';const recovered=await reconcileBudgetQueue({config,provider,account,parent,plan:begun,index:0,hash:H,fetcher});
  assert.equal(recovered.items[0].status,'created');assert(calls.every(method=>['eth_accounts','eth_chainId','eth_getTransactionByHash'].includes(method)));
});

test('fresh queue binds two independent Authority commands and persists the confirmed child before exact-cost purchase',async()=>{
  const f=fixture([candidate(1)]),fresh={...config,stage:'fresh-active',authority:address(10),gasWallet:address(11)},
    plan={...await f.discover(),approved:true};
  const create=await prepareBudgetQueueStep({config:fresh,provider:{},account,parent,plan,index:0,
    readParent:f.readParent,readMiner:f.readMiner,prepareCreate:async({params,subscriber})=>({
      transaction:{from:account,to:factory,chainId:'0x38',value:'0x0',data:abi.PoolFactory.encodeFunctionData('createBudgetChildPool',[
        [params.circuits,params.circuitId,params.targetRaiseWei,params.priceCapWei,ZeroAddress,0n,params.fundingDeadline,params.purchaseDeadline],subscriber])},
    })});
  assert.equal(create.authority.kind,'executeApprovedOperation');
  assert.equal(create.authority.args.target,factory);
  const begun=beginBudgetQueueStep(plan,create);
  assert.deepEqual(begun.items[0].intent.authority,create.authority);
  await assert.rejects(prepareBudgetQueueStep({config:fresh,provider:{},account,parent,plan:begun,index:0}),/未知/);
  const created=applyBudgetQueueResult(begun,0,final('create'));
  const buy=await prepareBudgetQueueStep({config:fresh,provider:{},account,parent,plan:created,index:0,
    readParent:f.readParent,readMiner:async()=>({...await f.readMiner(),registry:{ready:true,pool:child}}),
    preparePurchase:async()=>({row:{pool:parent},transaction:{from:account,to:parent,chainId:'0x38',value:'0x0',
      data:abi.BudgetPortfolioVault.encodeFunctionData('buyOfficial',[child,1n])},
      action:{kind:'buyOfficial',targetType:'portfolio'},procurement:{route:'official',child,priceWei:199n,capWei:200n}})});
  assert.deepEqual(buy.authority,{kind:'buyBudgetOfficial',args:{portfolio:parent,child,maxCost:'199',listingId:'1'}});
  const buying=beginBudgetQueueStep(created,buy);
  assert.equal(buying.items[0].creationHash,H);assert.equal(buying.items[0].hash,undefined);
  assert.deepEqual(buying.items[0].intent.authority,buy.authority);
  assert.equal(budgetQueuePreviewMatches(buy,{...buy,authority:{...buy.authority,args:{...buy.authority.args,maxCost:'200'}}}),false);
  assert.equal(applyBudgetQueueResult(buying,0,final('purchase')).items[0].status,'completed');
});

test('queue preview rejects official listing replacement rather than silently substituting an approved source',async()=>{
  const f=fixture(),plan={...await f.discover(),approved:true};
  await assert.rejects(prepareBudgetQueueStep({config,provider:{},account,parent,plan,index:0,
    readParent:f.readParent,readMiner:async()=>({...await f.readMiner(),official:{id:'999',priceWei:'200'}}),
    prepareCreate:()=>{throw Error('must not build a changed listing');}}),/Official listing or purchase source changed/);
});

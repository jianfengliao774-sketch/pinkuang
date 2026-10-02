import assert from 'node:assert/strict';
import test from 'node:test';
import { ZeroAddress, ZeroHash } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { validateManifest } from '../lib/live-config.mjs';
import { portfolioBnbEntitlement,genesisPortfolioProposalGate,portfolioPageActionReady,portfolioSelectedActionReady,portfolioOrderActionReady,portfolioCreateActionReady,readPortfolioContext,readPortfolio,readPortfolioPage,readPortfolioOrders,preparePortfolioAction } from '../lib/live-portfolios.mjs';
import { portfolioFixture,PORTFOLIOS,address } from './portfolio-fixture.mjs';

const saleProposal=(changes={})=>({child:address(0x951),price:100n,referencePrice:100n,referenceAt:1n,
  endsAt:2_000_000_000n,memberCount:2n,yesMembers:2n,yesShares:51n,executed:false,...changes});

test('historical budget directories cannot enable row actions while independent operator creation remains available',()=>{
  const config={productFamily:'fresh-v4',operationalReady:true,stale:false};
  const current={config,freshRead:true,listingSource:{readMode:'current',stale:false},initialPool:null};
  assert.equal(portfolioPageActionReady(current),true);
  assert.equal(portfolioPageActionReady({...current,freshRead:false}),false);
  assert.equal(portfolioPageActionReady({...current,listingSource:{readMode:'verified_snapshot',stale:true}}),false);
  assert.equal(portfolioPageActionReady({...current,config:{...config,operationalReady:false}}),false);
  assert.equal(portfolioPageActionReady({...current,initialPool:address(0x900),listingSource:null}),true);
  assert.equal(portfolioSelectedActionReady({config,selectedProofCurrent:false}),false);
  assert.equal(portfolioSelectedActionReady({config,selectedProofCurrent:true}),true,
    'a separately verified current detail can enable actions even if the directory remains historical');
  const order={config,selectedProofCurrent:true,source:{readMode:'current',stale:false},
    orderPool:address(0x900),selectedPool:address(0x900)};
  assert.equal(portfolioOrderActionReady(order),true);
  assert.equal(portfolioOrderActionReady({...order,source:{readMode:'verified_snapshot',stale:true}}),false);
  assert.equal(portfolioOrderActionReady({...order,orderPool:address(0x902)}),false);
  const create={config,operatorVerified:true,wallet:{},account:address(0x901)};
  assert.equal(portfolioCreateActionReady(create),true);
  assert.equal(portfolioCreateActionReady({...create,operatorVerified:false}),false);
  assert.equal(portfolioCreateActionReady({...create,operatorVerified:false,operator:create.account,
    currentOperatorRead:true}),true);
  assert.equal(portfolioCreateActionReady({...create,operatorVerified:false,operator:create.account,
    currentOperatorRead:false}),false);
  assert.equal(portfolioCreateActionReady({...create,config:{...config,stale:true}}),false);
});

test('budget manifest requires the complete reviewed graph and rejects partial legacy additions',()=>{
  const f=portfolioFixture();assert.equal(validateManifest(f.manifest).kind,'integrated-v2');
  const partial={...f.manifest};delete partial.portfolioImplementation;assert.throws(()=>validateManifest(partial));
  assert.throws(()=>validateManifest({...f.manifest,kind:undefined}));
});
test('BNB historical credit is not doubled or lost after all shares move',()=>{
  const row={shares:10n,salePerShareWei:3n,saleDebt:5n,bnbOwed:7n,refundPerShareWei:2n,refundSettled:false,state:2n};
  assert.equal(portfolioBnbEntitlement(row),52n);
  assert.equal(portfolioBnbEntitlement({...row,state:0n}),32n);
  assert.equal(portfolioBnbEntitlement({...row,refundSettled:true}),32n);
  assert.equal(portfolioBnbEntitlement({...row,shares:0n,saleDebt:0n,bnbOwed:52n}),52n);
  assert.throws(()=>portfolioBnbEntitlement({...row,saleDebt:31n}),/账本/);
});
test('portfolio discovery uses parent registration and does not multiply 100 shares per child',async()=>{
  const f=portfolioFixture({childCount:1001n});
  const page=await readPortfolioPage(f.config,f.provider,{account:f.account,fetcher:f.fetcher});
  assert.equal(page.items.length,2);assert(page.items.every(row=>row.childCount===1001n&&row.shares===10n&&row.children.length===0));
  assert.equal(page.items[0].unitPriceWei,50000000000000n);
  assert(f.calls.every(c=>!/(send|sign)/i.test(c.method)));
  for(const option of [{badCode:true},{wrongImplementation:true},{wrongMarketImplementation:true},{foreign:true}]){
    const broken=portfolioFixture(option);await assert.rejects(readPortfolioPage(broken.config,broken.provider,{fetcher:broken.fetcher}));
  }
});
test('fresh v4 display pages omit deployment proof while the independently configured action path still checks it',async()=>{
  const f=portfolioFixture(),config={...f.config,productFamily:'fresh-v4'};
  await readPortfolioPage(config,f.provider,{account:f.account,fetcher:f.fetcher});
  const codeReads=()=>f.calls.filter(call=>call.method==='eth_getCode').length;
  const first=codeReads();
  assert.equal(first,0);
  await readPortfolioOrders(config,f.provider,PORTFOLIOS[0],{fetcher:f.fetcher});
  assert.equal(codeReads(),0,'display order reads must not inspect runtime code');
  await readPortfolioContext(config,f.provider);
  assert(codeReads()>first,'the action path must verify the graph independently');
});
test('budget directory and orders use the index response clock with slow and fast client clocks',async()=>{
  for(const offset of [-5*60_000,5*60_000]){
    const f=portfolioFixture(),serverNow=Date.now(),clientNow=serverNow+offset;
    const fetcher=async url=>new Response(JSON.stringify(f.index(url)),
      {headers:{'content-type':'application/json',Date:new Date(serverNow).toUTCString()}});
    const page=await readPortfolioPage(f.config,f.provider,
      {account:f.account,fetcher,now:()=>clientNow});
    assert.equal(page.items.length,2);
    const orders=await readPortfolioOrders(f.config,f.provider,PORTFOLIOS[0],
      {fetcher,now:()=>clientNow});
    assert.equal(orders.items.length,1);
  }
});
test('budget fallback snapshot uses its own response Date rather than the failed live response',async()=>{
  const f=portfolioFixture(),serverNow=Date.now(),clientNow=serverNow-5*60_000;
  const snapshotSource={...f.source(),checkedAt:new Date(serverNow-60_000).toISOString(),
    readMode:'verified_snapshot',stale:true,refreshing:true,transactionReady:false,portfolioCount:'2'};
  const fetcher=async url=>new URL(url).pathname.endsWith('/v1/portfolios')
    ? new Response(JSON.stringify({error:'syncing'}),{status:503,headers:{'content-type':'application/json'}})
    : new Response(JSON.stringify({...f.index(url),source:snapshotSource}),
      {headers:{'content-type':'application/json',Date:new Date(serverNow).toUTCString()}});
  const page=await readPortfolioPage(f.config,f.provider,
    {fetcher,now:()=>clientNow});
  assert.equal(page.source.readMode,'verified_snapshot');
  assert.equal(page.source.transactionReady,false);
  assert.equal(page.items.length,2);
});
test('budget server Date does not accept future proofs, stale blocks, or absent Date with wrong local time',async()=>{
  const f=portfolioFixture(),serverNow=Date.now(),clientNow=serverNow-5*60_000;
  const read=async(changes,includeDate=true)=>readPortfolioOrders(f.config,f.provider,PORTFOLIOS[0],{
    now:()=>clientNow,fetcher:async url=>new Response(JSON.stringify({...f.index(url),
      source:{...f.source(),...changes}}),{headers:{'content-type':'application/json',
        ...(includeDate?{Date:new Date(serverNow).toUTCString()}:{})}})});
  await assert.rejects(read({checkedAt:new Date(serverNow+31_000).toISOString()}),{code:'index_stale'});
  await assert.rejects(read({indexedTimestamp:f.source().indexedTimestamp-300}),{code:'index_stale'});
  await assert.rejects(read({},false),{code:'index_stale'});
  assert.equal(f.calls.length,0,'failed clock proofs must stop before historical RPC reads');
});
test('budget index block mismatch is tagged as a reorg so stale display caches are retired',async()=>{
  const f=portfolioFixture();
  const fetcher=async url=>new Response(JSON.stringify({...f.index(url),
    source:{...f.source(),indexedBlockHash:`0x${'ab'.repeat(32)}`}}),
  {headers:{'content-type':'application/json'}});
  await assert.rejects(readPortfolioPage(f.config,f.provider,{fetcher}),{code:'source_reorg'});
});
test('genesis budget sale shows the cost-based 60-share threshold only below purchase cost',async()=>{
  const f=portfolioFixture({stage:'genesis',activeProposalId:1n,nextProposalId:2n,
    proposal:{child:address(0x951),price:100n,referencePrice:100n,referenceAt:1n,
      endsAt:2_000_000_000n,memberCount:2n,yesMembers:2n,
      yesShares:59n,executed:false},childCost:150n});
  const context=await readPortfolioContext(f.config,f.provider);
  const row=await readPortfolio(context,PORTFOLIOS[0],f.account,{includeChildren:false});
  assert.equal(row.proposal.threshold,60n);
  assert.equal(row.proposal.yesShares,59n);
  assert.equal(row.proposal.price,100n);
  f.state.childCost=100n;
  const equalCost=await readPortfolio(context,PORTFOLIOS[0],f.account,{includeChildren:false});
  assert.equal(equalCost.proposal.threshold,51n);
  assert(f.calls.some(({method,params})=>method==='eth_call'
    && params[0].data===abi.BudgetPortfolioVault.encodeFunctionData('childInfo',[address(0x951)])));
});
test('genesis budget sale execution requires its cost-based threshold before wallet submission',async()=>{
  const f=portfolioFixture({stage:'genesis',poolState:2n,activeProposalId:1n,nextProposalId:2n,
    proposal:{child:address(0x951),price:100n,referencePrice:100n,referenceAt:1n,
      endsAt:2_000_000_000n,memberCount:2n,yesMembers:2n,
      yesShares:59n,executed:false},childCost:150n});
  const input={config:f.config,provider:f.provider,account:f.account,pool:PORTFOLIOS[0],
    action:{kind:'executeChildSale',proposalId:'1'}};
  await assert.rejects(preparePortfolioAction(input),/表决门槛/);
  f.state.proposal.yesShares=60n;
  const prepared=await preparePortfolioAction(input);
  assert.equal(abi.BudgetPortfolioVault.parseTransaction(prepared.transaction).name,'executeChildSale');
  assert(!f.calls.some(({method,params})=>method==='eth_call'&&
    [abi.BudgetPortfolioVault.getFunction('childSaleReview').selector,abi.ShareMarket.getFunction('saleReference').selector]
      .includes(params[0].data.slice(0,10))),'genesis must retain its purchase-cost rule');
});
test('genesis budget sale proposal accepts one share only after the current round and child maturity',async()=>{
  const f=portfolioFixture({stage:'genesis',poolState:2n,shares:1n,saleDebt:0n});
  const input={config:f.config,provider:f.provider,account:f.account,pool:PORTFOLIOS[0],
    action:{kind:'proposeChildSale',child:address(0x951),price:'0.04',reference:'0.04',referenceAt:String(f.source().indexedTimestamp)}};
  const ready=await readPortfolio(await readPortfolioContext(f.config,f.provider),PORTFOLIOS[0],f.account,{includeChildren:false});
  assert.equal(genesisPortfolioProposalGate(ready).allowed,true);
  const prepared=await preparePortfolioAction(input);
  assert.equal(abi.BudgetPortfolioVault.parseTransaction(prepared.transaction).name,'proposeChildSale');
  assert(!f.calls.some(({method,params})=>method==='eth_call'&&params?.[0]?.from===f.account));
  f.state.shares=0n;
  await assert.rejects(preparePortfolioAction(input),/至少 1 份/);
  f.state.shares=1n;f.state.nextRoundAt=BigInt(f.source().indexedTimestamp)+1n;
  await assert.rejects(preparePortfolioAction(input),/下一轮/);
  f.state.nextRoundAt=0n;f.state.activeProposalId=1n;f.state.nextProposalId=2n;
  await assert.rejects(preparePortfolioAction(input),/本轮已有/);
  f.state.activeProposalId=0n;f.state.nextProposalId=1n;
  f.state.childActivatedAt=BigInt(f.source().indexedTimestamp)-7n*86400n+1n;
  await assert.rejects(preparePortfolioAction(input),/出售条件/);
  f.state.childActivatedAt=BigInt(f.source().indexedTimestamp)-8n*86400n;
  f.state.childSold=true;
  await assert.rejects(preparePortfolioAction(input),/出售条件/);
});
test('v4 budget child sale needs a fresh child reference and an approved review below that price',async()=>{
  const f=portfolioFixture({poolState:2n,activeProposalId:1n,nextProposalId:2n,
    proposal:saleProposal(),referencePrice:150n});
  const input={config:f.config,provider:f.provider,account:f.account,pool:PORTFOLIOS[0],
    action:{kind:'executeChildSale',proposalId:'1'}};
  const row=await readPortfolio(await readPortfolioContext(f.config,f.provider),PORTFOLIOS[0],f.account,{includeChildren:false});
  assert.equal(row.proposal.passed,true);
  assert.equal(row.proposal.saleReference.priceWei,150n);
  assert.equal(row.proposal.saleReview.status,0n);
  assert.equal(row.proposal.discounted,true);
  assert.equal(row.proposal.reviewApproved,false);
  assert.equal(row.proposal.canExecute,false);
  assert(f.calls.some(({method,params})=>method==='eth_call'&&
    params[0].data&&params[0].to===f.manifest.shareMarket&&params[1]==='0x64'&&
    abi.ShareMarket.parseTransaction({data:params[0].data})?.name==='saleReference'&&
    abi.ShareMarket.parseTransaction({data:params[0].data}).args[0]===saleProposal().child));
  assert(f.calls.some(({method,params})=>method==='eth_call'&&
    params[0].data&&params[0].to===PORTFOLIOS[0]&&params[1]==='0x64'&&
    abi.BudgetPortfolioVault.parseTransaction({data:params[0].data})?.name==='childSaleReview'));
  await assert.rejects(preparePortfolioAction(input),/尚待平台审核/);
  f.state.reviewStatus=1n;
  const approved=await preparePortfolioAction(input);
  assert.equal(approved.row.proposal.reviewApproved,true);
  assert.equal(approved.row.proposal.canExecute,true);
  assert.equal(abi.BudgetPortfolioVault.parseTransaction(approved.transaction).name,'executeChildSale');
  f.state.reviewStatus=2n;
  await assert.rejects(preparePortfolioAction(input),/已驳回/);
  assert(!f.calls.some(({method,params})=>method==='eth_call'&&params?.[0]?.from===f.account),
    'the review gate uses pinned reads without reintroducing transaction simulation');
});
test('v4 budget child sale fails closed when reference or review cannot be trusted',async()=>{
  const f=portfolioFixture({poolState:2n,activeProposalId:1n,nextProposalId:2n,
    proposal:saleProposal(),referencePrice:150n,reviewStatus:1n});
  const input={config:f.config,provider:f.provider,account:f.account,pool:PORTFOLIOS[0],
    action:{kind:'executeChildSale',proposalId:'1'}};
  const validAt=BigInt(f.source().indexedTimestamp)-100n;
  for(const change of [
    {referenceAt:validAt-901n,referencePrice:150n,referenceDigest:`0x${'11'.repeat(32)}`,referenceReadError:false},
    {referenceAt:validAt+101n,referencePrice:150n,referenceDigest:`0x${'11'.repeat(32)}`,referenceReadError:false},
    {referenceAt:validAt,referencePrice:0n,referenceDigest:`0x${'11'.repeat(32)}`,referenceReadError:false},
    {referenceAt:validAt,referencePrice:150n,referenceDigest:ZeroHash,referenceReadError:false},
    {referenceAt:validAt,referencePrice:150n,referenceDigest:`0x${'11'.repeat(32)}`,referenceReadError:true},
  ]){
    Object.assign(f.state,change);
    const row=await readPortfolio(await readPortfolioContext(f.config,f.provider),PORTFOLIOS[0],f.account,{includeChildren:false});
    assert.equal(row.proposal.canExecute,false);
    assert.equal(row.proposal.discounted,null);
    await assert.rejects(preparePortfolioAction(input),/参考价/);
  }
  Object.assign(f.state,{referenceReadError:false,referenceAt:validAt,reviewReadError:true});
  const unknown=await readPortfolio(await readPortfolioContext(f.config,f.provider),PORTFOLIOS[0],f.account,{includeChildren:false});
  assert.equal(unknown.proposal.saleReview.available,false);
  await assert.rejects(preparePortfolioAction(input),/审核状态/);
  Object.assign(f.state,{reviewReadError:false,reviewStatus:3n});
  await assert.rejects(preparePortfolioAction(input),/审核状态/);
});
test('v4 non-discount child sale ignores an earlier discount rejection or unavailable review',async()=>{
  const f=portfolioFixture({poolState:2n,activeProposalId:1n,nextProposalId:2n,
    proposal:saleProposal(),referencePrice:90n,reviewStatus:0n});
  const input={config:f.config,provider:f.provider,account:f.account,pool:PORTFOLIOS[0],
    action:{kind:'executeChildSale',proposalId:'1'}};
  const prepared=await preparePortfolioAction(input);
  assert.equal(prepared.row.proposal.discounted,false);
  assert.equal(prepared.row.proposal.reviewRequired,false);
  assert.equal(prepared.row.proposal.reviewApproved,false);
  assert.equal(prepared.row.proposal.canExecute,true);
  f.state.reviewStatus=2n;
  const afterRejection=await preparePortfolioAction(input);
  assert.equal(afterRejection.row.proposal.canExecute,true);
  f.state.reviewReadError=true;
  const reviewUnavailable=await preparePortfolioAction(input);
  assert.equal(reviewUnavailable.row.proposal.canExecute,true);
  f.state.referencePrice=150n;
  await assert.rejects(preparePortfolioAction(input),/审核状态/);
  f.state.reviewReadError=false;
  await assert.rejects(preparePortfolioAction(input),/已驳回/);
});
test('v4 reviews and references remain bound to each child sale candidate',async()=>{
  const first=saleProposal({child:address(0x951)}),second=saleProposal({child:address(0x952)});
  const f=portfolioFixture({poolState:2n,activeProposalId:1n,nextProposalId:3n,
    proposals:[first,second],references:{
      [first.child.toLowerCase()]:{price:150n},[second.child.toLowerCase()]:{price:120n}},
    reviewStatuses:{1:1n,2:2n}});
  const context=await readPortfolioContext(f.config,f.provider);
  const row=await readPortfolio(context,PORTFOLIOS[0],f.account,{includeChildren:false});
  assert.deepEqual(row.proposals.map(item=>item.id),[1n,2n]);
  assert.deepEqual(row.proposals.map(item=>item.saleReference.priceWei),[150n,120n]);
  assert.deepEqual(row.proposals.map(item=>item.saleReview.status),[1n,2n]);
  assert.deepEqual(row.proposals.map(item=>item.canExecute),[true,false]);
  await assert.rejects(preparePortfolioAction({config:f.config,provider:f.provider,account:f.account,pool:PORTFOLIOS[0],
    action:{kind:'executeChildSale',proposalId:'2'}}),/已驳回/);
  await assert.rejects(preparePortfolioAction({config:f.config,provider:f.provider,account:f.account,pool:PORTFOLIOS[0],
    action:{kind:'executeChildSale',proposalId:'3'}}),/提案已改变/);
  f.state.activeProposalId=0n;f.state.nextProposalId=1n;
  await assert.rejects(preparePortfolioAction({config:f.config,provider:f.provider,account:f.account,pool:PORTFOLIOS[0],
    action:{kind:'executeChildSale',proposalId:'1'}}),/提案已改变/);
});

test('budget sale display applies both deployed versions and caches one child rule within its snapshot',async()=>{
  for(const [parent,childRule,price,referencePrice,required] of [
    [8000n,8000n,79n,100n,true],[8000n,8000n,80n,100n,false],
    [8000n,8000n,81n,100n,false],[8000n,8000n,99n,100n,false],
    [8000n,undefined,90n,100n,true],[undefined,8000n,90n,100n,true],
    [8000n,8000n,80n,101n,true],
  ]){
    const candidate=saleProposal({price});
    const f=portfolioFixture({poolState:2n,activeProposalId:1n,nextProposalId:3n,
      proposals:[candidate,{...candidate}],referencePrice,reviewStatus:0n,
      saleReviewThresholdBps:parent,childReviewThresholdBps:childRule});
    const row=await readPortfolio(await readPortfolioContext(f.config,f.provider),PORTFOLIOS[0],f.account,{includeChildren:false});
    assert.equal(row.proposal.saleReviewThresholdBps,parent===8000n&&childRule===8000n?8000n:10000n);
    assert.equal(row.proposal.discounted,true);assert.equal(row.proposal.reviewRequired,required);
    assert.equal(row.proposal.canExecute,!required);
    assert.equal(f.calls.filter(c=>c.method==='eth_call'
      && c.params[0].data===abi.PoolVault.encodeFunctionData('saleReviewThresholdBps')
      && c.params[0].to.toLowerCase()===candidate.child.toLowerCase()).length,1);
  }
});
test('automatic portfolio fallback remains an explicitly stale display snapshot',async()=>{
  const f=portfolioFixture();
  const source={...f.source(),checkedAt:new Date(Date.now()-60_000).toISOString(),
    readMode:'verified_snapshot',stale:true,refreshing:true,transactionReady:false,portfolioCount:'2'};
  const fetcher=async url=>new Response(JSON.stringify({...f.index(url),source}),
    {headers:{'content-type':'application/json'}});
  const page=await readPortfolioPage(f.config,f.provider,{account:f.account,fetcher});
  assert.equal(page.source.stale,true);
  assert.equal(page.source.transactionReady,false);
  assert.equal(page.source.checkedAt,source.checkedAt);
  assert.equal(page.items.length,2);
});
test('old portfolio snapshot is display-only and never starts historical contract reads',async()=>{
  const f=portfolioFixture();
  const source={...f.source(),indexedTimestamp:f.source().indexedTimestamp-1000,
    checkedAt:new Date(Date.now()-1000).toISOString(),readMode:'verified_snapshot',
    stale:true,refreshing:false,transactionReady:false,portfolioCount:'2'};
  const fetcher=async url=>new URL(url).pathname.endsWith('/v1/portfolios')
    ? new Response(JSON.stringify({error:'syncing'}),{status:503,headers:{'content-type':'application/json'}})
    : new Response(JSON.stringify({...f.index(url),source}),{headers:{'content-type':'application/json'}});
  await assert.rejects(readPortfolioPage(f.config,f.provider,{account:f.account,fetcher}),{code:'index_stale'});
  assert.equal(f.calls.filter(call=>call.method==='eth_call').length,0);
});
test('former holders can read and withdraw settled BNB without current shares',async()=>{
  const f=portfolioFixture({shares:0n,saleDebt:0n,bnbOwed:99n});
  const row=await readPortfolio(await readPortfolioContext(f.config,f.provider),PORTFOLIOS[0],f.account);
  assert.equal(row.shares,0n);assert.equal(row.withdrawableBnb,99n);
  const prepared=await preparePortfolioAction({config:f.config,provider:f.provider,account:f.account,pool:PORTFOLIOS[0],action:{kind:'withdrawBnb'}});
  assert.equal(prepared.action.targetType,'portfolio');assert.equal(prepared.transaction.value,'0x0');assert.equal(prepared.payoutWei,99n);
  assert(!f.calls.some(({method,params})=>method==='eth_call' && params?.[0]?.from===f.account));
});
test('portfolio BEM stays visible while listed shares block a fresh claim preview',async()=>{
  const f=portfolioFixture({lockedShares:2n});
  const row=await readPortfolio(await readPortfolioContext(f.config,f.provider),PORTFOLIOS[0],f.account,{includeChildren:false});
  assert.equal(row.claimableBem,100n);
  assert.equal(row.lockedShares,2n);
  await assert.rejects(preparePortfolioAction({config:f.config,provider:f.provider,account:f.account,
    pool:PORTFOLIOS[0],action:{kind:'claimBem'}}),/挂单仍在锁定/);
  f.state.lockedShares=0n;
  const prepared=await preparePortfolioAction({config:f.config,provider:f.provider,account:f.account,
    pool:PORTFOLIOS[0],action:{kind:'claimBem'}});
  assert.equal(prepared.payoutWei,100n);
});
test('portfolio page reads overlap but an unfinished row cannot publish partial page results',async()=>{
  const f=portfolioFixture();let release,second;const held=new Promise(r=>release=r),seen=new Promise(r=>second=r);let gated=false,finished=false;
  f.state.beforeRead=async({method,params=[]})=>{if(method!=='eth_call'||params[0].data!==abi.BudgetPortfolioVault.encodeFunctionData('budgetWei'))return;
    if(params[0].to===PORTFOLIOS[1])second();if(params[0].to===PORTFOLIOS[0]&&!gated){gated=true;await held;}};
  const task=readPortfolioPage(f.config,f.provider,{fetcher:f.fetcher}).then(value=>{finished=true;return value;});
  await seen;assert.equal(finished,false);release();const page=await task;assert.deepEqual(page.items.map(row=>row.pool),PORTFOLIOS);
});
test('portfolio page bounds pinned reads across four portfolios below the proxy active limit',async()=>{
  const f=portfolioFixture(),pools=[...PORTFOLIOS,address(0x903),address(0x904)];
  const targets=new Set(pools);let active=0,peak=0;const tags=[];
  const provider={request:async input=>{
    const to=input.method==='eth_call'?input.params[0].to:null;
    if(!targets.has(to))return f.provider.request(input);
    active++;peak=Math.max(peak,active);tags.push(input.params[1]);
    try{
      await new Promise(resolve=>setTimeout(resolve,2));
      if(active>24)throw new Error('Read-only data service is busy.');
      const mapped=pools.slice(2).includes(to)?{...input,params:[{...input.params[0],to:PORTFOLIOS[0]},input.params[1]]}:input;
      return await f.provider.request(mapped);
    }finally{active--;}
  }};
  const fetcher=async url=>{
    const reply=f.index(url),sample=reply.data.items[0];
    return new Response(JSON.stringify({...reply,data:{...reply.data,
      items:pools.map(pool=>({...sample,address:pool}))}}),{headers:{'content-type':'application/json'}});
  };
  const page=await readPortfolioPage(f.config,provider,{account:f.account,fetcher});
  assert.deepEqual(page.items.map(row=>row.pool),pools);
  assert(page.items.every(row=>row.blockNumber===100n));
  assert.equal(peak,12);assert.equal(active,0);
  assert(tags.length>100 && tags.every(tag=>tag==='0x64'));
});
test('a stalled portfolio page does not hold reads from another section',async()=>{
  const f=portfolioFixture();let release,markFull;let blocked=0;
  const held=new Promise(resolve=>release=resolve),full=new Promise(resolve=>markFull=resolve);
  f.state.beforeRead=async({method,params=[]})=>{
    if(method!=='eth_call'||!PORTFOLIOS.includes(params[0].to))return;
    if(++blocked===12)markFull();
    await held;
  };
  const pageTask=readPortfolioPage(f.config,f.provider,{fetcher:f.fetcher});
  let timer;
  try{
    await Promise.race([full,
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('portfolio reads did not fill the limiter')),2000);})]);
    clearTimeout(timer);
    const other=await Promise.race([
      readPortfolioContext(f.config,f.provider),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('independent context was blocked')),2000);}),
    ]);
    assert.equal(other.tag,'0x64');
  }finally{clearTimeout(timer);release();}
  assert.equal((await pageTask).items.length,2);
});
test('a failed portfolio page drains its reads before rejection and a fresh section can read',async()=>{
  const f=portfolioFixture();let active=0,fail=true;
  const budget=abi.BudgetPortfolioVault.encodeFunctionData('budgetWei');
  const provider={request:async input=>{
    if(input.method!=='eth_call'||!PORTFOLIOS.includes(input.params[0].to))return f.provider.request(input);
    active++;
    try{
      await new Promise(resolve=>setTimeout(resolve,2));
      if(fail&&input.params[0].to===PORTFOLIOS[1]&&input.params[0].data===budget)throw new Error('portfolio read failed');
      return await f.provider.request(input);
    }finally{active--;}
  }};
  await assert.rejects(readPortfolioPage(f.config,provider,{fetcher:f.fetcher}),/portfolio read failed/);
  assert.equal(active,0);
  fail=false;
  const context=await readPortfolioContext(f.config,provider);
  assert.equal(context.tag,'0x64');
  const page=await readPortfolioPage(f.config,provider,{fetcher:f.fetcher});
  assert.deepEqual(page.items.map(row=>row.pool),PORTFOLIOS);
});
test('budget subscriptions, transfers and creation encode exact reviewed amounts without transaction simulation',async()=>{
  const f=portfolioFixture(),input={config:f.config,provider:f.provider,account:f.account,pool:PORTFOLIOS[0]};
  const deposit=await preparePortfolioAction({...input,action:{kind:'deposit',quantity:'3'}});
  assert.equal(BigInt(deposit.transaction.value),150000000000000n);assert.equal(abi.BudgetPortfolioVault.parseTransaction(deposit.transaction).args[0],3n);
  const transfer=await preparePortfolioAction({...input,action:{kind:'transfer',recipient:address(7),quantity:'2'}});
  assert.deepEqual([...abi.BudgetPortfolioVault.parseTransaction(transfer.transaction).args],[address(7),2n]);
  await assert.rejects(preparePortfolioAction({...input,action:{kind:'transfer',recipient:ZeroAddress,quantity:'2'}}));
  const now=BigInt(f.source().indexedTimestamp);
  const create=await preparePortfolioAction({...input,action:{kind:'createPortfolio',budget:'0.005',absoluteCap:'0.003',unitCap:'0.0000001',fundingDeadline:String(now+60n),purchaseDeadline:String(now+120n)}});
  assert.equal(create.action.targetType,'portfolioFactory');assert.equal(create.transaction.to,f.manifest.portfolioFactory);
  f.state.simulationFails=true;
  await preparePortfolioAction({...input,action:{kind:'deposit',quantity:'1'}});
  assert(!f.calls.some(({method,params})=>method==='eth_call' && params?.[0]?.from===f.account));
});
test('budget market quotes both fees, refuses reprice, wrong parent, frozen or old markets',async()=>{
  const f=portfolioFixture(),input={config:f.config,provider:f.provider,account:f.account,pool:PORTFOLIOS[0],action:{kind:'marketFill',orderId:'1',quantity:'2'}};
  await assert.rejects(preparePortfolioAction({...input,action:{kind:'marketList',quantity:'1',price:'0'}}),/greater than zero/);
  const orders=await readPortfolioOrders(f.config,f.provider,PORTFOLIOS[0],{fetcher:f.fetcher});assert.equal(orders.items[0].remaining,5n);
  assert.equal(orders.source.factory.toLowerCase(),f.manifest.factory.toLowerCase());
  const fill=await preparePortfolioAction(input);assert.equal(fill.transaction.value,'0xca');assert.equal(fill.action.targetType,'portfolioMarket');
  assert.equal(fill.marketTrade.baseWei,200n);assert.equal(fill.marketTrade.buyerFeeWei,2n);assert.equal(fill.marketTrade.sellerFeeWei,2n);
  await assert.rejects(preparePortfolioAction({...input,action:{...input.action,expectedPricePerUnitWei:'101'}}),/价格/);
  await assert.rejects(preparePortfolioAction({...input,pool:PORTFOLIOS[1]}),/其他预算/);
  f.state.trading=false;await assert.rejects(preparePortfolioAction(input),/暂不能/);
  f.state.trading=true;f.state.buyerFeeBps=0n;await assert.rejects(preparePortfolioAction(input),/费率/);
});

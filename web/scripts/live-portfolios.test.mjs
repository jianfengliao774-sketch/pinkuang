import assert from 'node:assert/strict';
import test from 'node:test';
import { ZeroAddress } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { validateManifest } from '../lib/live-config.mjs';
import { portfolioBnbEntitlement,readPortfolioContext,readPortfolio,readPortfolioPage,readPortfolioOrders,preparePortfolioAction } from '../lib/live-portfolios.mjs';
import { portfolioFixture,PORTFOLIOS,address } from './portfolio-fixture.mjs';

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
test('former holders can read and withdraw settled BNB without current shares',async()=>{
  const f=portfolioFixture({shares:0n,saleDebt:0n,bnbOwed:99n});
  const row=await readPortfolio(await readPortfolioContext(f.config,f.provider),PORTFOLIOS[0],f.account);
  assert.equal(row.shares,0n);assert.equal(row.withdrawableBnb,99n);
  const prepared=await preparePortfolioAction({config:f.config,provider:f.provider,account:f.account,pool:PORTFOLIOS[0],action:{kind:'withdrawBnb'}});
  assert.equal(prepared.action.targetType,'portfolio');assert.equal(prepared.transaction.value,'0x0');assert.equal(prepared.payoutWei,13n);
});
test('portfolio page reads overlap but an unfinished row cannot publish partial page results',async()=>{
  const f=portfolioFixture();let release,second;const held=new Promise(r=>release=r),seen=new Promise(r=>second=r);let gated=false,finished=false;
  f.state.beforeRead=async({method,params=[]})=>{if(method!=='eth_call'||params[0].data!==abi.BudgetPortfolioVault.encodeFunctionData('budgetWei'))return;
    if(params[0].to===PORTFOLIOS[1])second();if(params[0].to===PORTFOLIOS[0]&&!gated){gated=true;await held;}};
  const task=readPortfolioPage(f.config,f.provider,{fetcher:f.fetcher}).then(value=>{finished=true;return value;});
  await seen;assert.equal(finished,false);release();const page=await task;assert.deepEqual(page.items.map(row=>row.pool),PORTFOLIOS);
});
test('budget subscriptions, transfers and creation encode exact reviewed amounts and simulate before return',async()=>{
  const f=portfolioFixture(),input={config:f.config,provider:f.provider,account:f.account,pool:PORTFOLIOS[0]};
  const deposit=await preparePortfolioAction({...input,action:{kind:'deposit',quantity:'3'}});
  assert.equal(BigInt(deposit.transaction.value),150000000000000n);assert.equal(abi.BudgetPortfolioVault.parseTransaction(deposit.transaction).args[0],3n);
  const transfer=await preparePortfolioAction({...input,action:{kind:'transfer',recipient:address(7),quantity:'2'}});
  assert.deepEqual([...abi.BudgetPortfolioVault.parseTransaction(transfer.transaction).args],[address(7),2n]);
  await assert.rejects(preparePortfolioAction({...input,action:{kind:'transfer',recipient:ZeroAddress,quantity:'2'}}));
  const now=BigInt(f.source().indexedTimestamp);
  const create=await preparePortfolioAction({...input,action:{kind:'createPortfolio',budget:'0.005',absoluteCap:'0.003',unitCap:'0.0000001',fundingDeadline:String(now+60n),purchaseDeadline:String(now+120n)}});
  assert.equal(create.action.targetType,'portfolioFactory');assert.equal(create.transaction.to,f.manifest.portfolioFactory);
  f.state.simulationFails=true;await assert.rejects(preparePortfolioAction({...input,action:{kind:'deposit',quantity:'1'}}),/simulation/);
});
test('budget market quotes both fees, refuses reprice, wrong parent, frozen or old markets',async()=>{
  const f=portfolioFixture(),input={config:f.config,provider:f.provider,account:f.account,pool:PORTFOLIOS[0],action:{kind:'marketFill',orderId:'1',quantity:'2'}};
  const orders=await readPortfolioOrders(f.config,f.provider,PORTFOLIOS[0],{fetcher:f.fetcher});assert.equal(orders.items[0].remaining,5n);
  const fill=await preparePortfolioAction(input);assert.equal(fill.transaction.value,'0xca');assert.equal(fill.action.targetType,'portfolioMarket');
  assert.equal(fill.marketTrade.baseWei,200n);assert.equal(fill.marketTrade.buyerFeeWei,2n);assert.equal(fill.marketTrade.sellerFeeWei,2n);
  await assert.rejects(preparePortfolioAction({...input,action:{...input.action,expectedPricePerUnitWei:'101'}}),/价格/);
  await assert.rejects(preparePortfolioAction({...input,pool:PORTFOLIOS[1]}),/其他预算/);
  f.state.trading=false;await assert.rejects(preparePortfolioAction(input),/暂不能/);
  f.state.trading=true;f.state.buyerFeeBps=0n;await assert.rejects(preparePortfolioAction(input),/费率/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { abi } from '../lib/chain-client.mjs';
import { freshUserExitReady, isFreshUserExitTransaction } from '../lib/fresh-user-exits.mjs';
import { loadFreshLiveConfig, validateFreshProductGraph } from '../lib/fresh-product-config.mjs';
import { requireCurrentProductStage, validateProductTransactionStage } from '../lib/live-transactions.mjs';
import { currentActionSourceReady } from '../lib/live-view.mjs';
import { portfolioConfigActionReady,portfolioSelectedActionReady,portfolioOrderActionReady } from '../lib/live-portfolios.mjs';
import { freshAuthorityBrowserFixture } from './fresh-authority-browser-fixture.mjs';
const f=freshAuthorityBrowserFixture(),source={stale:false,readMode:'current'};
const graph={...f.graph(),operationalReady:false,transactionReady:false,userExitReady:true};
const fetcher=async url=>new Response(JSON.stringify(url.includes('/data/')?f.manifest:graph),{headers:{'Content-Type':'application/json'}});
const boot=await loadFreshLiveConfig({origin:'https://example.test',basePath:'/bemine-v4',manifestSha256:f.manifestSha,fetcher});
const config={...boot,...boot.manifest};
const make=(targetType,kind,args=[])=>{
  const contract=targetType==='pool'?abi.PoolVault:targetType==='portfolio'?abi.BudgetPortfolioVault:abi.ShareMarket;
  return {transaction:{chainId:'0x38',from:f.signer.address,to:targetType==='pool'?f.f.base.pools.active:
    targetType==='portfolio'?f.child:targetType==='market'?config.shareMarket:config.portfolioMarket,
    data:contract.encodeFunctionData(kind,args),value:'0x0'},action:{kind,targetType}};
};

test('actual fresh loader preserves current exit proof while platform services are unavailable',async()=>{
  assert.equal(config.userExitReady,true);assert.equal(config.operationalReady,false);assert.equal(config.transactionReady,false);
  const tx=make('pool','claim');
  assert.equal((await requireCurrentProductStage(config,fetcher,tx)).userExitReady,true);
  assert.equal(validateProductTransactionStage(config,tx.transaction,tx.action).action.kind,'claim');
  await assert.rejects(requireCurrentProductStage(config,fetcher),/最新链上核验/);
});

for(const [target,kind,args] of [['pool','withdrawBnb',[]],['pool','finalizeFailure',[]],['portfolio','claimBem',[]],
  ['portfolio','claimFailedFunding',[]],['market','cancel',[1]],['portfolioMarket','expire',[1]]]){
  test(`user-paid ${target}/${kind} remains eligible only as exact zero-value calldata`,()=>{
    const {transaction,action}=make(target,kind,args);
    assert.equal(isFreshUserExitTransaction(config,transaction,action),true);
    assert.equal(validateProductTransactionStage(config,transaction,action).targetType,target);
    for(const altered of [{...transaction,value:'0x1'},{...transaction,chainId:'0x1'},{...transaction,data:transaction.data+'00'}]){
      assert.equal(isFreshUserExitTransaction(config,altered,action),false);
      assert.throws(()=>validateProductTransactionStage(config,altered,action));
    }
  });
}

test('direct user actions do not inherit exit permission; independent wallet policy handles them',()=>{
  for(const [target,kind,args] of [['pool','deposit',[1]],['portfolio','deposit',[1]],['portfolio','transfer',[f.other.address,1]],
    ['market','list',[f.child,1,10000000000000n]],['market','fill',[1,1]]]){
    const {transaction,action}=make(target,kind,args);
    assert.equal(isFreshUserExitTransaction(config,transaction,action),false);
    if (['deposit','fill'].includes(kind)) assert.throws(()=>validateProductTransactionStage(config,transaction,action));
    else assert.equal(validateProductTransactionStage(config,transaction,action).action.kind,kind);
  }
  const {transaction,action}=make('market','cancel',[1]);
  assert.equal(isFreshUserExitTransaction(config,transaction,{...action,targetType:'portfolioMarket'}),false);
});

test('historical graphs never enable sending; current direct-wallet actions need no worker exit attestation',()=>{
  assert.equal(validateProductTransactionStage({...config,userExitReady:false},make('pool','claim').transaction,'claim').action.kind,'claim');
  for(const blocked of [{...config,stale:true,readMode:'verified_snapshot'}]){
    const tx=make('pool','claim');assert.equal(freshUserExitReady(blocked,'pool','claim'),false);
    assert.throws(()=>validateProductTransactionStage(blocked,tx.transaction,tx.action));
  }
  const historical=validateFreshProductGraph({...graph,readMode:'verified_snapshot',stale:true,refreshing:true,snapshotAgeMs:1000},boot.pinnedManifest);
  assert.equal(historical.userExitReady,false);
});

test('UI distinguishes current deployment from independent worker readiness',()=>{
  assert.equal(currentActionSourceReady({client:{},config,source,action:'claim'}),true);
  assert.equal(currentActionSourceReady({client:{},config,source,action:'list'}),false);
  assert.equal(currentActionSourceReady({client:{},config,source:{...source,stale:true},action:'claim'}),true);
  assert.equal(portfolioConfigActionReady(config,'claimBem'),true);
  assert.equal(portfolioConfigActionReady(config,'createPortfolio'),false);
  assert.equal(portfolioSelectedActionReady({config,selectedProofCurrent:false,action:'claimBem'}),false);
  const input={config,selectedProofCurrent:true,source,orderPool:f.child,selectedPool:f.child};
  assert.equal(portfolioOrderActionReady({...input,action:'cancel'}),true);
  assert.equal(portfolioOrderActionReady({...input,action:'fill'}),true);
  assert.equal(portfolioOrderActionReady({...input,action:'cancel',selectedPool:f.other.address}),false);
});

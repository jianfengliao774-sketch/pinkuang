import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { loadOperatorQuote,operatorQuoteDraft } from '../lib/operator-quotes.mjs';
import { prepareAdminAction } from '../lib/live-admin.mjs';
import { validateProductTransactionStage } from '../lib/live-transactions.mjs';
import { operatorFirstoFixture } from './operator-firsto-fixture.mjs';
import { batchSource,batchProvider } from '../../deploy/scripts/fixtures/firsto-batch-order.mjs';
import { FIRSTO_BATCH_EXCHANGE } from '../../deploy/shared/firsto-batch-order.mjs';
const extra=new Interface(['function firstoBatchPurchaseVersion() view returns(uint16)','function isCPU(address) view returns(bool)',
  'function ownerOf(uint256) view returns(address)','function getApproved(uint256) view returns(address)','function isApprovedForAll(address,address) view returns(bool)',
  'function supportsInterface(bytes4) view returns(bool)','function factory() view returns(address)']);
async function fixture(options={}) {
  const f=await operatorFirstoFixture(options),source=await batchSource({price:'5000000000000001'});
  f.data.row.bestAsk=source;f.data.detail.asset.bestAsk=source;
  f.data.detail.orders.signedAsks=[{askHash:source.id,leafHash:source.id,batchHash:source.execution.batchHash,
    maker:source.account,status:'open',priceWei:source.priceWei,buyerCostWei:source.buyerCostWei}];
  f.data.page.sourceFreshness[`circuit_batch_ask_exchange:${FIRSTO_BATCH_EXCHANGE.toLowerCase()}`]=Date.now();
  const b=batchProvider(source,{block:{hash:'0x'+'12'.repeat(32)},versionTarget:f.pool,values:options.batchValues});
  const base=f.provider;
  f.provider={async request(input){
    const {method,params=[]}=input;
    if(method==='eth_getCode'&&params[0].toLowerCase()===FIRSTO_BATCH_EXCHANGE.toLowerCase())return b.provider.request(input);
    if(method==='eth_call'){
      const to=params[0].to.toLowerCase(),parsed=extra.parseTransaction(params[0]);
      const poolCall=to===f.pool.toLowerCase()?abi.PoolVault.parseTransaction(params[0]):null;
      if(poolCall?.name==='params')return abi.PoolVault.encodeFunctionResult(poolCall.fragment,[f.rows[0].params]);
      if(to===FIRSTO_BATCH_EXCHANGE.toLowerCase()||parsed?.name==='firstoBatchPurchaseVersion'
        ||parsed?.name==='isCPU'||parsed?.name==='supportsInterface'
        ||to===source.execution.collection.toLowerCase()&&['factory','getApproved','isApprovedForAll','ownerOf'].includes(parsed?.name))
        return b.provider.request(input);
    }
    return base.request(method==='eth_call'&&params[1]==='latest'?{...input,params:[params[0],'0x64']}:input);
  }};
  if(options.enabled)f.config.firstoBatchPurchase={active:true,protocolReviewed:true,implementation:f.pool};
  f.batchCalls=b.calls;f.batchSource=source;return f;
}
const quote=f=>loadOperatorQuote({collection:f.data.quote.collection,tokenId:'7',config:f.config,
  provider:f.provider,fetcher:f.api.fetcher});

test('batch listing stays reference-only until independent protocol and upgraded capability are enabled',async()=>{
  const f=await fixture(),q=await quote(f);
  assert.equal(q.chain.firsto,null);assert.match(q.chain.firstoError,/批量协议尚未完成审核/);
  assert.throws(()=>operatorQuoteDraft(q),/批量/);
  assert.equal(operatorQuoteDraft(q,{mode:'createFlexiblePoolChecked'}).kind,'createFlexiblePoolChecked');
  assert.equal(f.batchCalls.some(row=>row.params?.[0]?.to?.toLowerCase()===FIRSTO_BATCH_EXCHANGE.toLowerCase()),false);
});
test('reviewed batch leaf can prepare a fixed fee-inclusive draft and exact pool kind1 calldata',async t=>{
  const f=await fixture({enabled:true}),q=await quote(f);
  assert.equal(q.chain.firsto.kind,1);assert.equal(q.chain.firsto.askHash,f.batchSource.id);
  const draft=operatorQuoteDraft(q);assert.equal(draft.params.priceCapWei,'5050000000000001');
  f.state.registryPool=f.pool;t.mock.method(globalThis,'fetch',f.api.fetcher);
  const preview=await prepareAdminAction({provider:f.provider,config:f.config,account:f.account,kind:'autoPurchase',pool:f.pool});
  const parsed=abi.PoolVault.parseTransaction(preview.transaction);
  assert.equal(parsed.name,'buyFromFirsto');assert.equal(parsed.args[0],1n);
  assert.equal(preview.request.firstoKind,1);assert.equal(preview.transaction.value,'0x0');
  const requests=f.api.requests.length;f.data.page.rows=[];
  const again=await prepareAdminAction({provider:f.provider,config:f.config,account:f.account,...preview.request});
  assert.deepEqual(again.transaction,preview.transaction);assert.equal(f.api.requests.length,requests);
});
test('valid original official listing wins without loading or checking a batch order',async()=>{
  const f=await fixture({enabled:true,officialListing:true});
  const q=await loadOperatorQuote({collection:f.data.quote.collection,tokenId:'7',config:f.config,provider:f.provider,
    fetcher:async()=>{throw Error('Firsto must not be queried');}});
  assert(q.chain.official);assert.equal(f.batchCalls.some(row=>row.params?.[0]?.to?.toLowerCase()===FIRSTO_BATCH_EXCHANGE.toLowerCase()),false);assert.equal(q.chain.firsto,null);
});
test('closed gate, old implementation, moved owner and invalidated leaf never produce a batch purchase draft',async()=>{
  for(const options of [{},{enabled:true,batchValues:{firstoBatchPurchaseVersion:0n}},
    {enabled:true,batchValues:{ownerOf:'0x2222222222222222222222222222222222222222'}},
    {enabled:true,batchValues:{isAskLeafInvalidated:true}}]){
    const f=await fixture(options);
    if(options.batchValues?.ownerOf)await assert.rejects(quote(f),/持有人|持有者|卖家|变化/);
    else {const q=await quote(f);assert.equal(q.chain.firsto===null,true);assert.throws(()=>operatorQuoteDraft(q));}
  }
});
test('wallet stage rejects kind1 without current capability and never widens unknown kind',async()=>{
  const f=await fixture({enabled:true}),q=await quote(f),tx={from:f.account,to:f.pool,chainId:'0x38',value:'0',
    data:abi.PoolVault.encodeFunctionData('buyFromFirsto',[1,q.chain.firsto.encodedOrder])};
  assert.throws(()=>validateProductTransactionStage({...f.config,firstoBatchPurchase:undefined},tx,'buyFromFirsto'));
  assert.equal(validateProductTransactionStage(f.config,tx,'buyFromFirsto').action.kind,'buyFromFirsto');
  assert.throws(()=>validateProductTransactionStage(f.config,{...tx,
    data:abi.PoolVault.encodeFunctionData('buyFromFirsto',[2,q.chain.firsto.encodedOrder])},'buyFromFirsto'));
});


test('display-only batch fallback still prefers a complete official same-task alternative',async t=>{
  const f=await fixture({enabled:true,flexible:true,alternativeListing:{valid:true,price:4000000000000000n}});
  f.config.displayOnly=true;f.config.journalBase='/bemine/api/journal';f.state.registryPool=f.pool;
  f.config.freshAuthority={administratorOne:f.account,administratorTwo:'0x2222222222222222222222222222222222222222'};
  const candidates={complete:true,chainId:56,factory:f.config.factory,artifactDigest:(await import('../lib/chain-client.mjs')).ARTIFACT_DIGEST,
    pool:f.pool,blockNumber:'100',blockHash:'0x'+'12'.repeat(32),flexible:true,
    model:{circuits:f.data.quote.collection,taskId:'220',minVerifiedWeight:'50',referenceVerifiedWeight:'61',
      referencePriceWei:'10000000000000000',priceCap:f.rows[0].params.priceCap.toString()},
    candidates:[{listingId:'46',collection:f.data.quote.collection,tokenId:'8',seller:f.source.account,
      priceWei:'4000000000000000',verifiedWeight:'61'}]};
  t.mock.method(globalThis,'fetch',async(input,init)=>new URL(input,'https://local.example').pathname.endsWith('/api/journal/official-candidates')
    ?new Response(JSON.stringify(candidates),{headers:{'Content-Type':'application/json'}}):f.api.fetcher(input,init));
  const preview=await prepareAdminAction({provider:f.provider,config:f.config,account:f.account,kind:'autoPurchase',pool:f.pool});
  assert.equal(preview.kind,'buyAlternativeFromMarket');assert.equal(preview.official.tokenId,'8');
});

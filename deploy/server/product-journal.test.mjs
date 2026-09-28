import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Interface, Wallet, getAddress } from 'ethers';
import { createJournalService, verifyProductIntent as verifyWithGraph, cancellationIntent, PRODUCT_POOL_ABI as poolAbi, PRODUCT_MARKET_ABI as marketAbi, PRODUCT_FACTORY_ABI as factoryAbi,
  PRODUCT_PORTFOLIO_ABI as portfolioAbi,PRODUCT_PORTFOLIO_FACTORY_ABI as portfolioFactoryAbi } from './journal-api.mjs';
import { JournalStore } from './journal-store.mjs';
import { parseFirstoSignedAsk } from '../src/firsto-purchase.mjs';
import { signedSource,firstoProvider,collection,now } from '../scripts/fixtures/firsto-order.mjs';
const addr = n => getAddress(`0x${n.toString(16).padStart(40,'0')}`);
const hash = n => `0x${n.toString(16).padStart(64,'0')}`;
const factory = addr(1), pool = addr(2), market = addr(3), wallet = Wallet.createRandom(), account = wallet.address.toLowerCase();
const origin = 'http://127.0.0.1:4173';
const graphVerifier = async()=>{};
const verifyProductIntent=(provider,record,allow)=>verifyWithGraph(provider,record,allow,graphVerifier);

async function firstoIntentProof(options = {}) {
  const source=await signedSource(),order=parseFirstoSignedAsk(source,{collection,tokenId:'7',owner:source.account,now});
  const record=intent('buyFromFirsto',[0,order.encodedOrder],'0'),p=proof(record),f=firstoProvider(source,options);
  const originalSend=p.provider.send.bind(p.provider),originalBlock=p.provider.getBlock.bind(p.provider);
  p.provider.getBlock=async tag=>tag==='latest'?{number:100,hash:`0x${'12'.repeat(32)}`}:
    tag===100?{number:100,hash:`0x${'12'.repeat(32)}`} : originalBlock(tag);
  p.provider.send=async(method,params)=>{
    if (['eth_getBlockByNumber','eth_getStorageAt','eth_getCode'].includes(method)
      || method==='eth_call' && !params[0].from && ![pool,factory,market].some(a=>a.toLowerCase()===params[0].to.toLowerCase()))
      return f.provider.request({method,params});
    return originalSend(method,params);
  };
  return {record,p,order};
}
const views = new Interface(['function operator() view returns(address)','function isPool(address) view returns(bool)','function shareMarket() view returns(address)',
  'function legacyFactory() view returns(address)','function budgetWei() view returns(uint256)',
  'function machineRegistryStatus() view returns(bool initialized,bool ready,uint256 cursor,uint256 cutoff)',
  'function machinePool(address,uint256) view returns(address)',
  'function poolCount() view returns(uint256)', 'function creationPaused() view returns(bool)',
  'function factory() view returns(address)','function OFFICIAL_FACTORY() view returns(address)',
  'function unitPriceWei() view returns(uint256)','function salePrice() view returns(uint256)',
  'function feeBps() view returns(uint16)','function buyerFeeBps() view returns(uint16)',
  'function orders(uint256) view returns(tuple(address seller,address pool,uint256 remaining,uint256 pricePerUnit,bool active))']);
function intent(name = 'deposit', args = [2], value = '20', targetType = 'pool') {
  return { version:2, chainId:56, account, factory, target:targetType === 'factory' ? factory : targetType === 'pool' ? pool : market, targetType, nonce:7,
    action:{kind:name}, data:(targetType === 'factory' ? factoryAbi : targetType === 'pool' ? poolAbi : marketAbi).encodeFunctionData(name,args), value,
    gas:'100000',gasPrice:'1000000000',submittedAt:'2026-09-27T00:00:00.000Z' };
}
function proof(record = intent()) {
  const state = { mined:false, registered:true, chain:'0x38', final:101, fail:false, nonce:7, txHash:hash(77),
    target:record.target, data:record.data, value:BigInt(record.value), status:1, logs:[],accountCode:'0x',
    balance:10n**18n,gasPrice:1_000_000_000n,estimate:50000n,operator:account,graphFailed:false,graphChecks:0,
    registry:[true,true,0n,0n],reservedPool:addr(0),legacyCount:0n,legacyPaused:true };
  const event = (user = account, shares = 2n, amount = 20n, address = pool) => ({ address,transactionHash:hash(77),blockHash:hash(100),
    ...(record.targetType==='portfolio'?portfolioAbi.encodeEventLog(portfolioAbi.getEvent('Deposited'),[user,shares,amount])
      :poolAbi.encodeEventLog(poolAbi.getEvent('Deposited'),[user,shares,amount,20n])) });
  state.logs = record.action.kind === 'deposit' ? [event()] : [];
  const provider = {
    async send(method, params) {
      if (state.fail) throw new Error('offline');
      if (method === 'eth_chainId') return state.chain;
      assert.equal(method,'eth_call');
      const [tx] = params;
      if (tx.from) return '0x';
      const parsed = views.parseTransaction(tx);
      if (parsed.name==='buyerFeeBps' && state.buyerFeeMissing) return '0x';
      if (parsed.name==='machineRegistryStatus') return state.registry===null?'0x':views.encodeFunctionResult(parsed.name,state.registry);
      const result = ({ operator:state.operator,isPool:state.registered,shareMarket:market,factory,OFFICIAL_FACTORY:factory,legacyFactory:addr(10),budgetWei:1000n,unitPriceWei:10n,salePrice:200n,
        machinePool:state.reservedPool,feeBps:state.sellerFeeBps??100n,buyerFeeBps:state.buyerFeeBps??100n,
        poolCount:state.legacyCount,creationPaused:state.legacyPaused,
        orders:[account,pool,100n,state.orderPrice??5n,true] })[parsed.name];
      return views.encodeFunctionResult(parsed.name,[result]);
    },
    getCode:async target=> target.toLowerCase()===account ? state.accountCode : '0x6000',
    getBalance:async()=>state.balance,
    getFeeData:async()=>({gasPrice:state.gasPrice}),
    estimateGas:async()=>state.estimate,
    getTransactionCount:async(_target,tag)=> state.mined ? state.nonce+1 : tag==='pending' ? state.pendingNonce??state.nonce : state.nonce,
    getBlock:async tag => tag === 'latest' ? {number:102,hash:hash(102)} : tag === 'finalized' ? {number:state.final,hash:hash(state.final)}
      : {number:Number(tag),hash:hash(Number(tag)),transactions:state.membership===false?[]:[state.txHash]},
    getTransaction:async()=> state.mined ? {hash:state.txHash,chainId:56n,from:account,nonce:state.nonce,to:state.target,
      data:state.data,value:state.value,index:0,blockNumber:100,blockHash:hash(100)} : null,
    getTransactionReceipt:async()=> state.mined ? {hash:state.txHash,from:account,to:state.target,index:0,blockNumber:100,blockHash:hash(100),status:state.status,logs:state.logs} : null,
  };
  return {state,provider,event};
}
async function fixture({record = intent(),allow = [factory],legacyFactory} = {}) {
  const directory = await mkdtemp(join(tmpdir(),'pinkuang-products-')), dbPath = join(directory,'private','journal.sqlite');
  const p = proof(record);
  const service = createJournalService({dbPath,origin,provider:p.provider,currentArtifactDigest:()=>hash(1),allowedProductFactories:allow,legacyFactory,
    productGraphVerifier:async()=>{p.state.graphChecks++;if(p.state.graphFailed)throw Error('graph changed');
      return {productKind:record.targetType?.startsWith('portfolio')?'budget':'pool',factory,legacyFactory:addr(10)};}});
  const server = createServer((req,res)=>service.handle(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  let cookie;
  const request=async(path,method='GET',body)=>{
    const response=await fetch(`${base}/api/journal/${path}`,{method,headers:{Origin:origin,'Content-Type':'application/json',
      ...(cookie?{Cookie:cookie,'X-Pinkuang-Account':account}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const nextCookie=response.headers.get('set-cookie'); if(nextCookie)cookie=nextCookie.split(';')[0];
    return {status:response.status,body:await response.json()};
  };
  const challenge=(await request('challenge','POST',{account})).body;
  assert.equal((await request('session','POST',{account,nonce:challenge.nonce,signature:await wallet.signMessage(challenge.message)})).status,200);
  return {...p,directory,dbPath,request,async close(){await new Promise(resolve=>server.close(resolve));await service.close();await rm(directory,{recursive:true,force:true});}};
}

test('all permitted pool and market actions require exact values, registration and a free nonce', async()=>{
  const p=proof(), allow=new Set([factory.toLowerCase()]);
  const calls=[['deposit',[2],'20'],['withdrawDeposit',[],'0'],['finalizeFailure',[],'0'],['harvest',[],'0'],['claim',[],'0'],
    ['withdrawBnb',[],'0'],['propose',[200,200,1],'0'],['vote',[1,true],'0'],['executeSale',[1],'0'],['cancelExpired',[],'0']];
  for(const [name,args,value] of calls)await verifyProductIntent(p.provider,intent(name,args,value),allow);
  for(const [name,args,value] of [['list',[pool,2,5],'0'],['fill',[1,2],'10'],['cancel',[1],'0'],['expire',[1],'0'],['withdrawBnb',[],'0']])
    await verifyProductIntent(p.provider,intent(name,args,value,'market'),allow);
  await assert.rejects(verifyProductIntent(p.provider,intent('deposit',[2],'21'),allow),/Deposit value/);
  await assert.rejects(verifyProductIntent(p.provider,intent('completeSale',[],'200'),allow),/Legacy whole miner sale is disabled/);
  await assert.rejects(verifyProductIntent(p.provider,intent('fill',[1,2],'11','market'),allow),/Order price/);
  p.state.registered=false; await assert.rejects(verifyProductIntent(p.provider,intent(),allow),/registered/);
  p.state.registered=true;p.state.nonce=8; await assert.rejects(verifyProductIntent(p.provider,intent(),allow),/nonce/);
});

test('share fill charges the buyer separately and rejects the old one-sided value', async()=>{
  const p=proof(),allow=new Set([factory.toLowerCase()]);
  p.state.orderPrice=101n;
  await verifyProductIntent(p.provider,intent('fill',[1,2],'204','market'),allow);
  await assert.rejects(verifyProductIntent(p.provider,intent('fill',[1,2],'202','market'),allow),/buyer fee/);
  p.state.buyerFeeBps=0n;
  await assert.rejects(verifyProductIntent(p.provider,intent('fill',[1,2],'204','market'),allow),/Bilateral/);
  p.state.buyerFeeBps=100n;
  p.state.sellerFeeBps=0n;
  await assert.rejects(verifyProductIntent(p.provider,intent('list',[pool,1,101],'0','market'),allow),/Bilateral/);
  p.state.sellerFeeBps=100n;
  p.state.buyerFeeMissing=true;
  await assert.rejects(verifyProductIntent(p.provider,intent('fill',[1,2],'204','market'),allow),/Bilateral/);
  await verifyProductIntent(p.provider,intent('withdrawBnb',[],'0','market'),allow);
});

test('Firsto journal requires operator, exact canonical signed order and independently pinned protocol runtime',async()=>{
  const allow=new Set([factory.toLowerCase()]);
  const {record,p,order}=await firstoIntentProof();
  await verifyProductIntent(p.provider,record,allow);
  p.state.operator=addr(99);
  await assert.rejects(verifyProductIntent(p.provider,record,allow),/operator/);
  p.state.operator=account;
  for(const bad of [intent('buyFromFirsto',[1,order.encodedOrder],'0'),intent('buyFromFirsto',[0,order.encodedOrder+'00'],'0'),
    intent('buyFromFirsto',[0,order.encodedOrder],'1')]) await assert.rejects(verifyProductIntent(p.provider,bad,allow));
  for(const options of [{implementationCode:'0x6000'},{values:{isSignedAskNonceInvalidated:true}},{values:{defaultTakerFeeBps:101n}}]){
    const changed=await firstoIntentProof(options);
    await assert.rejects(verifyProductIntent(changed.p.provider,changed.record,allow));
  }
});

test('new project signing refuses a legacy/incomplete registry and a machine already registered to any project',async()=>{
  const p=proof(),allow=new Set([factory.toLowerCase()]),params=[addr(4),1,1000,1000,addr(0),0,2000,3000];
  const config=[10,1000,1,0,100,90,hash(10)];
  for(const record of [intent('createPool',[params],'0','factory'),intent('createFlexiblePoolChecked',[params,config,1,10],'0','factory')]) {
    for(const registry of [null,[false,false,0n,0n],[true,false,0n,1n],[true,true,0n,1n]]){
      p.state.registry=registry;await assert.rejects(verifyProductIntent(p.provider,record,allow));
    }
    p.state.registry=[true,true,0n,0n];p.state.reservedPool=pool;
    await assert.rejects(verifyProductIntent(p.provider,record,allow),/already has a project/);
    p.state.reservedPool=addr(0);await verifyProductIntent(p.provider,record,allow);
  }
});

test('cutover is checked before journal persistence and again before a creation signing permission',async()=>{
  const params=[addr(4),1,1000,1000,addr(0),0,2000,3000],record=intent('createPool',[params],'0','factory');
  const f=await fixture({record,legacyFactory:addr(10)});
  try {
    f.state.legacyPaused=false;
    assert.equal((await f.request('market','PUT',{record,expectedRevision:0})).status,409);
    assert.equal((await f.request('market')).body.record,null,'failed cutover cannot reserve the wallet nonce');
    f.state.legacyPaused=true;
    const saved=await f.request('market','PUT',{record,expectedRevision:0});assert.equal(saved.status,200);
    f.state.legacyPaused=false;
    const denied=await f.request('market/arm','POST',{expectedRevision:saved.body.revision});
    assert.equal(denied.status,409);assert.match(denied.body.error,/尚未停建/);
    f.state.legacyPaused=true;
    const armed=await f.request('market/arm','POST',{expectedRevision:saved.body.revision});assert.equal(armed.status,200);
  }finally{await f.close();}
});

test('product route rejects unconfigured factory, arbitrary selector, extra calldata and nonpayable value',async()=>{
  const f=await fixture();
  try{
    for(const record of [{...intent(),factory:addr(99)},{...intent(),data:'0x12345678'},
      {...intent(),data:intent().data+'00'},intent('claim',[],'1'),intent('deposit',[0],'0'),intent('propose',[0,0,1],'0')]){
      const result=await f.request('market','PUT',{record,expectedRevision:0});
      assert([400,403,409].includes(result.status),JSON.stringify(result));
      assert.equal((await f.request('market')).body.record,null);
    }
    const request=()=>f.request('market','PUT',{record:intent(),expectedRevision:0});
    const race=await Promise.all([request(),request()]);
    assert.deepEqual(race.map(x=>x.status).sort(),[200,409]);
    assert.equal((await f.request('market','PUT',{record:{...intent(),target:addr(8)},expectedRevision:1})).status,409);
  }finally{await f.close();}
  const disabled=await fixture({allow:[]});
  try{assert.equal((await disabled.request('market','PUT',{record:intent(),expectedRevision:0})).status,403);}
  finally{await disabled.close();}
});

test('finalized deposit verifies exact event and atomically retains proof across pending deletion and restart',async()=>{
  const f=await fixture();
  try{
    assert.equal((await f.request('market','PUT',{record:intent(),expectedRevision:0})).status,200);
    assert.equal((await f.request('market','DELETE',{expectedRevision:1,hash:hash(77)})).status,409);
    f.state.mined=true;f.state.final=99;
    assert.equal((await f.request('market','DELETE',{expectedRevision:1,hash:hash(77)})).status,409);
    f.state.final=101;
    for(const logs of [[],[f.event(addr(9))],[f.event(account,1n)],[f.event(account,2n,19n)],
      [f.event(account,2n,20n,addr(9))],[f.event(),f.event()]]){
      f.state.logs=logs;
      assert.equal((await f.request('market','DELETE',{expectedRevision:1,hash:hash(77)})).status,409);
      assert((await f.request('market')).body.record);
    }
    f.state.logs=[f.event()];
    const done=await f.request('market','DELETE',{expectedRevision:1,hash:hash(77)});
    assert.equal(done.status,200);assert.equal(done.body.result.status,'confirmed');
    assert.equal(done.body.result.poolAddress,pool);assert.equal(done.body.result.shares,'2');assert.equal(done.body.result.amountWei,'20');
    assert.equal(done.body.result.finalized,true);assert.equal((await f.request('market')).body.record,null);
    assert.deepEqual((await f.request(`market/result?hash=${hash(77)}`)).body.result,done.body.result);
    const store=new JournalStore(f.dbPath);
    try{assert.deepEqual(store.marketResult(account,hash(77)),done.body.result);assert.equal(store.marketResult(addr(99),hash(77)),null);}
    finally{store.close();}
  }finally{await f.close();}
});

test('reverted, cancelled and unrelated replacement never become a successful deposit',async()=>{
  for(const mode of ['reverted','cancelled','replaced']){
    const f=await fixture();
    try{
      assert.equal((await f.request('market','PUT',{record:{...intent(),hash:hash(76)},expectedRevision:0})).status,200);
      f.state.mined=true;f.state.logs=[];
      if(mode==='reverted')f.state.status=0;
      else{f.state.target=mode==='cancelled'?account:addr(98);f.state.data='0x';f.state.value=0n;}
      const result=await f.request('market','DELETE',{expectedRevision:1,hash:hash(77)});
      assert.equal(result.status,200);assert.equal(result.body.result.status,mode);assert.equal(result.body.result.poolAddress,undefined);
    }finally{await f.close();}
  }
});

test('hash progress survives RPC outage and product/deployment use one wallet signing lane',async()=>{
  const f=await fixture();
  try{
    assert.equal((await f.request('market','PUT',{record:intent(),expectedRevision:0})).status,200);
    f.state.fail=true;
    assert.equal((await f.request('market','PUT',{record:{...intent(),hash:hash(77)},expectedRevision:1})).status,200);
    assert.equal((await f.request('market','DELETE',{expectedRevision:2,hash:hash(77)})).status,503);
    const store=new JournalStore(f.dbPath), d={id:'deployment',steps:[{id:'PoolVault',status:'waiting'}]};
    try{assert.throws(()=>store.putDeployment(account,d,0),/unresolved/);}
    finally{store.close();}
  }finally{await f.close();}
  const directory=await mkdtemp(join(tmpdir(),'pinkuang-lane-'));
  const store=new JournalStore(join(directory,'private','journal.sqlite'));
  try{
    store.putDeployment(account,{id:'first',steps:[{id:'PoolVault',status:'waiting'}]},0);
    assert.throws(()=>store.putMarket(account,intent(),0),/active deployment/);
  }finally{store.close();await rm(directory,{recursive:true,force:true});}
});

test('explicit cancellation ACK preserves both current and legacy journal intent and binds the exact EOA nonce',async()=>{
  const legacy={...intent('withdrawBnb',[],'0','market'),version:1,market,action:{kind:'withdraw'},hash:hash(76)};
  delete legacy.target;delete legacy.targetType;
  for(const record of [intent(),legacy]){
    const f=await fixture({record});
    try{
      assert.equal((await f.request('market/cancel-intent','POST',{expectedRevision:0})).status,409);
      assert.equal((await f.request('market','PUT',{record,expectedRevision:0})).status,200);
      const request=()=>f.request('market/cancel-intent','POST',{expectedRevision:1});
      const race=await Promise.all([request(),request()]);
      assert.deepEqual(race.map(x=>x.status).sort(),[200,409]);
      const ack=race.find(x=>x.status===200).body;
      assert.equal(ack.revision,2);assert.equal(ack.record.nonce,7);assert.equal(ack.record.data,record.data);
      assert.deepEqual(ack.transaction,{from:account,to:account,chainId:'0x38',nonce:'0x7',data:'0x',value:'0x0',
        gas:'0x5208',gasPrice:`0x${1_200_000_000n.toString(16)}`,type:'0x0'});
      assert.equal(ack.record.cancellationRequests.length,1);
      const tampered={...ack.record,cancellationRequests:[]};
      assert.equal((await f.request('market','PUT',{record:tampered,expectedRevision:2})).status,409);
      const arbitrary={...ack.record,cancellationRequests:[{...ack.record.cancellationRequests[0],to:addr(98)}]};
      assert.equal((await f.request('market','PUT',{record:arbitrary,expectedRevision:2})).status,400);
      assert((await f.request('market')).body.record);
      f.state.mined=true;f.state.target=account;f.state.data='0x';f.state.value=0n;f.state.logs=[];
      const result=await f.request('market','DELETE',{expectedRevision:2,hash:hash(77)});
      assert.equal(result.status,200);assert.equal(result.body.result.status,'cancelled');assert.equal(result.body.result.poolAddress,undefined);
    }finally{await f.close();}
  }
});

test('cancellation fails closed on consumed/queued nonce, wrong chain, delegated wallet, RPC, gas or balance',async()=>{
  for(const change of [{nonce:8},{pendingNonce:9},{chain:'0x1'},{accountCode:'0xef0100'},{fail:true},
    {gasPrice:3_000_000_000n},{gasPrice:0n},{balance:1n}]){
    const p=proof();Object.assign(p.state,change);
    await assert.rejects(cancellationIntent(p.provider,intent()));
  }
  await assert.rejects(cancellationIntent(null,intent()),/unavailable/);
  const p=proof();p.state.pendingNonce=8;
  p.provider.getTransaction=async()=>({chainId:56n,from:account,nonce:7,gasPrice:2_000_000_000n});
  const tx=await cancellationIntent(p.provider,{...intent(),hash:hash(77)});
  assert.equal(BigInt(tx.gasPrice),2_400_000_000n);
});

function legacyIntent(){
  const record={...intent('withdrawBnb',[],'0','market'),version:1,market,action:{kind:'withdraw'},hash:hash(77)};
  delete record.target;delete record.targetType;
  return record;
}
test('re-importing a finalized legacy pending record reuses the identical proof and frees the active slot',async()=>{
  const record=legacyIntent(),f=await fixture({record});
  try{
    f.state.target=market;f.state.mined=true;
    assert.equal((await f.request('market','PUT',{record,expectedRevision:0})).status,200);
    const first=await f.request('market','DELETE',{hash:hash(77),expectedRevision:1});
    assert.equal(first.status,200);assert.equal(first.body.revision,2);
    // Simulates a stale localStorage record imported again by the old deployment client.
    assert.equal((await f.request('market','PUT',{record,expectedRevision:2})).status,200);
    const second=await f.request('market','DELETE',{hash:hash(77),expectedRevision:3});
    assert.equal(second.status,200);assert.equal(second.body.revision,4);
    assert.deepEqual(second.body.result,first.body.result);
    assert.deepEqual((await f.request('market')).body,{record:null,revision:4});
    assert.deepEqual((await f.request(`market/result?hash=${hash(77)}`)).body.result,first.body.result);
  }finally{await f.close();}
});

test('conflicting finalized result never overwrites the saved proof or clears a re-imported intent',async()=>{
  const record=legacyIntent(),f=await fixture({record});
  try{
    f.state.target=market;f.state.mined=true;
    assert.equal((await f.request('market','PUT',{record,expectedRevision:0})).status,200);
    const first=await f.request('market','DELETE',{hash:hash(77),expectedRevision:1});
    assert.equal(first.status,200);
    assert.equal((await f.request('market','PUT',{record,expectedRevision:2})).status,200);
    // An inconsistent RPC proof must not replace the original durable confirmed result.
    f.state.status=0;
    const conflicting=await f.request('market','DELETE',{hash:hash(77),expectedRevision:3});
    assert.equal(conflicting.status,409);assert.match(conflicting.body.error,/differs from the saved proof/);
    assert.deepEqual((await f.request('market')).body,{record,revision:3});
    assert.deepEqual((await f.request(`market/result?hash=${hash(77)}`)).body.result,first.body.result);
    f.state.status=1;
    assert.equal((await f.request('market','DELETE',{hash:hash(77),expectedRevision:3})).status,200);
    assert.equal((await f.request('market')).body.record,null);
  }finally{await f.close();}
});


test('one durable signing permission survives concurrent tabs, stale revisions and server restart',async()=>{
  const f=await fixture();
  try {
    assert.equal((await f.request('market','PUT',{record:intent(),expectedRevision:0})).status,200);
    const race=await Promise.all([f.request('market/arm','POST',{expectedRevision:1}),f.request('market/arm','POST',{expectedRevision:1})]);
    assert.deepEqual(race.map(item=>item.status).sort(),[200,409]);
    const ack=race.find(item=>item.status===200).body;
    assert.equal(ack.revision,2); assert.deepEqual(ack.record,intent());
    assert.deepEqual(ack.transaction,{chainId:'0x38',from:account,to:pool,nonce:'0x7',data:intent().data,value:'0x14',
      gas:'0x186a0',gasPrice:'0x3b9aca00',type:'0x0'});
    assert.equal((await f.request('market/arm','POST',{expectedRevision:2})).status,409);
    const reopened=new JournalStore(f.dbPath);
    try { assert.throws(()=>reopened.armMarket(account,2),/already consumed/); } finally {reopened.close();}
    assert.equal((await f.request('market','PUT',{record:{...intent(),gas:'100001'},expectedRevision:2})).status,409);
    assert.equal((await f.request('market','PUT',{record:{...intent(),hash:hash(77)},expectedRevision:2})).status,200);
  } finally {await f.close();}
});

test('signing permission rechecks graph, nonce, Gas estimate/price and balance after persistence',async()=>{
  for (const change of [{nonce:8},{pendingNonce:8},{estimate:100001n},{gasPrice:1000000001n},{balance:1n},{graphFailed:true}]) {
    const f=await fixture();
    try {
      assert.equal((await f.request('market','PUT',{record:intent(),expectedRevision:0})).status,200);
      Object.assign(f.state,change);
      assert.equal((await f.request('market/arm','POST',{expectedRevision:1})).status,409);
      assert.deepEqual((await f.request('market')).body,{record:intent(),revision:1,canAbandon:true});
    } finally {await f.close();}
  }
  await assert.rejects(verifyWithGraph(proof().provider,intent(),new Set([factory.toLowerCase()])),/graph verifier/);
});

test('completed deployment leaves product lane available; an unfinished deployment never does',async()=>{
  const f=await fixture();
  try {
    const store=new JournalStore(f.dbPath);
    try { store.putDeployment(account,{id:'complete',status:'complete',steps:[{id:'initialize',status:'confirmed'}]},0); }
    finally {store.close();}
    assert.equal((await f.request('market','PUT',{record:intent(),expectedRevision:0})).status,200);
    assert.equal((await f.request('market/arm','POST',{expectedRevision:1})).status,200);
  } finally {await f.close();}
});

test('factory creation and operator pool actions use canonical allowlisted calls, zero BNB and operator identity',async()=>{
  const params=[addr(4),1,1000,1000,addr(0),0,2000,3000];
  const config=[10,1000,1,0,100,90,hash(10)];
  const f=await fixture();
  try {
    for(const record of [intent('createPool',[params],'0','factory'),intent('createFlexiblePoolChecked',[params,config,1,10],'0','factory'),
      intent('buyFromMarket',[1],'0'),intent('buyAlternativeFromMarket',[1],'0')]) {
      await verifyProductIntent(f.provider,record,new Set([factory.toLowerCase()]));
      f.state.operator=addr(99);
      await assert.rejects(verifyProductIntent(f.provider,record,new Set([factory.toLowerCase()])),/operator/);
      f.state.operator=account;
    }
    const record=intent('createPool',[params],'0','factory');
    for(const invalid of [{...record,data:record.data+'00'},{...record,value:'1'},{...record,target:pool}])
      assert.equal((await f.request('market','PUT',{record:invalid,expectedRevision:0})).status,400);
    const mining=new Interface(['function arm(address,uint256)','function reclaim(bytes32)','function claim(bytes32)']);
    for(const data of [mining.encodeFunctionData('arm',[addr(4),1]),mining.encodeFunctionData('reclaim',[hash(2)])])
      await verifyProductIntent(f.provider,intent('mine',[data],'0'),new Set([factory.toLowerCase()]));
    assert.equal((await f.request('market','PUT',{record:intent('mine',[mining.encodeFunctionData('claim',[hash(2)])],'0'),expectedRevision:0})).status,400);
  } finally {await f.close();}
});

test('product finality requires canonical transaction inclusion and authentic receipt-log identity without historical account state',async()=>{
  const f=await fixture();
  try {
    assert.equal((await f.request('market','PUT',{record:intent(),expectedRevision:0})).status,200);
    f.state.mined=true; f.state.membership=false;
    assert.equal((await f.request('market','DELETE',{expectedRevision:1,hash:hash(77)})).status,409);
    f.state.membership=true; f.state.logs=[{...f.event(),transactionHash:hash(99)}];
    assert.equal((await f.request('market','DELETE',{expectedRevision:1,hash:hash(77)})).status,409);
    f.state.logs=[f.event()];f.provider.getTransactionCount=async()=>{throw Error('historical trie pruned');};
    assert.equal((await f.request('market','DELETE',{expectedRevision:1,hash:hash(77)})).status,200);
  } finally {await f.close();}
});


test('only a never-armed preparation may be abandoned, with durable CAS evidence and no timeout inference',async()=>{
  const f=await fixture();
  try {
    assert.equal((await f.request('market','PUT',{record:intent(),expectedRevision:0})).status,200);
    assert.equal((await f.request('market')).body.canAbandon,true);
    assert.equal((await f.request('market/abandon','POST',{expectedRevision:0})).status,409);
    assert.deepEqual((await f.request('market/abandon','POST',{expectedRevision:1})).body,{revision:2,record:null});
    assert.equal((await f.request('market','PUT',{record:intent(),expectedRevision:2})).status,200);
    const race=await Promise.all([f.request('market/arm','POST',{expectedRevision:3}),f.request('market/abandon','POST',{expectedRevision:3})]);
    assert.deepEqual(race.map(item=>item.status).sort(),[200,409]);
    const current=(await f.request('market')).body;
    if(current.record) {
      assert.equal(current.canAbandon,false);
      assert.equal((await f.request('market/abandon','POST',{expectedRevision:current.revision})).status,409);
    }
  } finally {await f.close();}
});


test('configured product mode retires new legacy signing but retains existing and known-hash recovery',async()=>{
  const record=legacyIntent();delete record.hash;
  const f=await fixture({record});
  try {
    const denied=await f.request('market','PUT',{record,expectedRevision:0});
    assert.equal(denied.status,409);assert.match(denied.body.error,/BEMine/);
    assert.equal((await f.request('market')).body.record,null);
    const store=new JournalStore(f.dbPath);
    try {store.putMarket(account,record,0);} finally {store.close();}
    // A record saved by the previous release is recoverable even with no original ACK/hash.
    assert.equal((await f.request('market','PUT',{record:{...record,hash:hash(77)},expectedRevision:1})).status,200);
    f.state.mined=true;f.state.target=market;
    assert.equal((await f.request('market','DELETE',{hash:hash(77),expectedRevision:2})).status,200);
    assert.equal((await f.request('market','PUT',{record:{...record,hash:hash(77)},expectedRevision:3})).status,200);
    assert.equal((await f.request('market','DELETE',{hash:hash(77),expectedRevision:4})).status,200);
  } finally {await f.close();}
});

test('finalized Factory creation returns exactly the new pool with an authenticated matching event',async()=>{
  const params=[addr(4),9,1000,900,addr(0),0,2000,3000];
  const record=intent('createPool',[params],'0','factory'),f=await fixture({record});
  const event=(overrides={})=>({address:factory,transactionHash:hash(77),blockHash:hash(100),
    ...factoryAbi.encodeEventLog(factoryAbi.getEvent('PoolCreated'),[pool,addr(4),9,1000,900,account]),...overrides});
  try {
    assert.equal((await f.request('market','PUT',{record,expectedRevision:0})).status,200);
    f.state.mined=true;
    for(const logs of [[],[event({address:pool})],[event({transactionHash:hash(99)})],[event({blockHash:hash(99)})],
      [event(),event()],[{address:factory,transactionHash:hash(77),blockHash:hash(100),
        ...factoryAbi.encodeEventLog(factoryAbi.getEvent('PoolCreated'),[pool,addr(4),9,1001,900,account])}]]) {
      f.state.logs=logs;
      assert.equal((await f.request('market','DELETE',{hash:hash(77),expectedRevision:1})).status,409);
      assert((await f.request('market')).body.record);
    }
    f.state.logs=[event()];
    const done=await f.request('market','DELETE',{hash:hash(77),expectedRevision:1});
    assert.equal(done.status,200);assert.equal(done.body.result.status,'confirmed');
    assert.equal(done.body.result.action,'createPool');assert.equal(done.body.result.poolAddress,pool);
    assert.equal((await f.request('market')).body.record,null);
  } finally {await f.close();}
});

test('budget deposit uses the same durable one-shot signing lane and requires the parent receipt event',async()=>{
  const record={...intent(),targetType:'portfolio',data:portfolioAbi.encodeFunctionData('deposit',[2])};
  const f=await fixture({record});
  try {
    assert.equal((await f.request('market','PUT',{record,expectedRevision:0})).status,200);
    const race=await Promise.all([f.request('market/arm','POST',{expectedRevision:1}),f.request('market/arm','POST',{expectedRevision:1})]);
    assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);
    f.state.mined=true;f.state.logs=[];
    assert.equal((await f.request('market','DELETE',{hash:hash(77),expectedRevision:2})).status,409);
    f.state.logs=[f.event()];const done=await f.request('market','DELETE',{hash:hash(77),expectedRevision:2});
    assert.equal(done.status,200);assert.equal(done.body.result.amountWei,'20');assert.equal(done.body.result.shares,'2');
  } finally {await f.close();}
});

test('budget creation archives only its own authenticated caps and parent address',async()=>{
  const record={...intent('createPool',[[addr(4),9,1000,900,addr(0),0,2000,3000]],'0','factory'),targetType:'portfolioFactory',
    action:{kind:'createPortfolio'},data:portfolioFactoryAbi.encodeFunctionData('createPortfolio',[1000,900,10,2000,3000])};
  const f=await fixture({record});
  const event=budget=>({address:factory,transactionHash:hash(77),blockHash:hash(100),
    ...portfolioFactoryAbi.encodeEventLog(portfolioFactoryAbi.getEvent('PortfolioCreated'),[pool,budget,900,10])});
  try {
    assert.equal((await f.request('market','PUT',{record,expectedRevision:0})).status,200);f.state.mined=true;
    f.state.logs=[event(1001)];assert.equal((await f.request('market','DELETE',{hash:hash(77),expectedRevision:1})).status,409);
    f.state.logs=[event(1000)];const done=await f.request('market','DELETE',{hash:hash(77),expectedRevision:1});
    assert.equal(done.status,200);assert.equal(done.body.result.portfolioAddress,pool);
  } finally {await f.close();}
});

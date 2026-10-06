import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { Interface, Wallet, getAddress } from 'ethers';
import { createJournalService, createProductVerifierProvider, verifyProductIntent as verifyWithGraph, cancellationIntent, PRODUCT_POOL_ABI as poolAbi, PRODUCT_MARKET_ABI as marketAbi, PRODUCT_FACTORY_ABI as factoryAbi,
  PRODUCT_PORTFOLIO_ABI as portfolioAbi,PRODUCT_PORTFOLIO_FACTORY_ABI as portfolioFactoryAbi,verifyMarketFinalized } from './journal-api.mjs';
import { JournalStore } from './journal-store.mjs';
import { parseFirstoSignedAsk } from '../src/firsto-purchase.mjs';
import { signedSource,firstoProvider,collection,now } from '../scripts/fixtures/firsto-order.mjs';
const addr = n => getAddress(`0x${n.toString(16).padStart(40,'0')}`);
const hash = n => `0x${n.toString(16).padStart(64,'0')}`;
const factory = addr(1), pool = addr(2), market = addr(3), wallet = Wallet.createRandom(), account = wallet.address.toLowerCase();
const origin = 'http://127.0.0.1:4173';
const graphVerifier = async()=>{};
const verifyProductIntent=(provider,record,allow)=>verifyWithGraph(provider,record,allow,graphVerifier);

test('signing verifier sends independent graph reads to an RPC that cannot answer batches',async()=>{
  const seen=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString());seen.push(body);
    res.setHeader('Content-Type','application/json');
    if(Array.isArray(body)){res.end(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32600,message:'batch unavailable'}}));return;}
    res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result:body.method==='eth_chainId'?'0x38':'0x'}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const provider=createProductVerifierProvider(`http://127.0.0.1:${server.address().port}`);
  try{
    const result=await Promise.all(Array.from({length:24},(_,i)=>provider.send('eth_call',
      [{to:factory,data:`0x${i.toString(16).padStart(8,'0')}`},'latest'])));
    assert.equal(result.length,24);assert(result.every(value=>value==='0x'));
    assert(seen.length>=24);assert(seen.every(body=>!Array.isArray(body)));
  }finally{provider.destroy();await new Promise(resolve=>server.close(resolve));}
});

test('product signing RPC has a bounded timeout and does not retry HTTP 429', async () => {
  let mode = 'rate', requests = 0;
  const server = createServer((req, res) => {
    requests++;
    req.resume();
    if (mode === 'rate') {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '120' });
      res.end('{}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const rpcUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const defaultProvider = createProductVerifierProvider(rpcUrl);
    assert.equal(defaultProvider._getConnection().timeout, 9_000, 'production signing RPC must not use the ethers 300-second default');
    defaultProvider.destroy();
    const limited = createProductVerifierProvider(rpcUrl, 100);
    assert.equal(limited._getConnection().timeout, 100);
    await assert.rejects(limited.send('eth_chainId', []));
    assert.equal(requests, 1, '429 must not trigger a hidden retry or Retry-After delay');
    limited.destroy();
    mode = 'hang'; requests = 0;
    const timed = createProductVerifierProvider(rpcUrl, 80);
    await assert.rejects(timed.send('eth_chainId', []));
    assert.equal(requests, 1, 'an unresponsive RPC must terminate after its configured timeout');
    timed.destroy();
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

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
    balance:10n**18n,gasPrice:1_000_000_000n,txGasLimit:100_000n,txMaxFeePerGas:1_000_000_000n,
    txPriorityFeePerGas:1_000_000_000n,txType:2,estimate:50000n,operator:account,graphFailed:false,graphChecks:0,
    simulations:0,estimates:0,
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
      if (tx.from) {state.simulations++;return '0x';}
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
    estimateGas:async()=>{state.estimates++;return state.estimate;},
    getTransactionCount:async(_target,tag)=> state.mined ? state.nonce+1 : tag==='pending' ? state.pendingNonce??state.nonce : state.nonce,
    getBlock:async (tag,prefetch=false) => tag === 'latest' ? {number:102,hash:hash(102)} : tag === 'finalized' ? {number:state.final,hash:hash(state.final)}
      : {number:Number(tag),hash:hash(Number(tag)),parentHash:Number(tag)>0?hash(Number(tag)-1):null,
        transactions:state.membership===false?[]:[...(state.priorTransactionTypes??[]).map((_,i)=>hash(200+i)),state.txHash],
        ...(prefetch?{prefetchedTransactions:[...(state.priorTransactionTypes??[]).map((type,i)=>({hash:hash(200+i),type})),
          {hash:state.txHash,type:state.txType}]}:{})},
    getTransaction:async()=> state.mined ? {hash:state.txHash,chainId:56n,from:account,nonce:state.nonce,to:state.target,
      data:state.data,value:state.value,type:state.txType,gasLimit:state.txGasLimit,gasPrice:state.gasPrice,
      maxFeePerGas:state.txMaxFeePerGas,maxPriorityFeePerGas:state.txPriorityFeePerGas,
      index:(state.priorTransactionTypes??[]).length,blockNumber:100,blockHash:hash(100)} : null,
    getTransactionReceipt:async()=> state.mined ? {hash:state.txHash,from:account,to:state.target,index:(state.priorTransactionTypes??[]).length,blockNumber:100,blockHash:hash(100),
      status:state.status,gasPrice:state.gasPrice,logs:state.logs} : null,
  };
  return {state,provider,event};
}
async function fixture({record = intent(),allow = [factory],legacyFactory,now} = {}) {
  const directory = await mkdtemp(join(tmpdir(),'pinkuang-products-')), dbPath = join(directory,'private','journal.sqlite');
  const p = proof(record);
  const service = createJournalService({dbPath,origin,provider:p.provider,currentArtifactDigest:()=>hash(1),allowedProductFactories:allow,legacyFactory,
    ...(now ? {now} : {}),
    productGraphVerifier:async()=>{p.state.graphChecks++;if(p.state.graphFailed)throw Error('graph changed');
      return {productKind:record.targetType?.startsWith('portfolio')?'budget':'pool',factory,legacyFactory:addr(10)};}});
  const server = createServer((req,res)=>service.handle(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  let cookie;
  const request=async(path,method='GET',body,extraHeaders={})=>{
    const response=await fetch(`${base}/api/journal/${path}`,{method,headers:{Origin:origin,'Content-Type':'application/json',
      ...(cookie?{Cookie:cookie,'X-Pinkuang-Account':account}:{}),...extraHeaders},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const nextCookie=response.headers.get('set-cookie'); if(nextCookie)cookie=nextCookie.split(';')[0];
    return {status:response.status,body:await response.json()};
  };
  const challenge=(await request('challenge','POST',{account})).body;
  assert.equal((await request('session','POST',{account,nonce:challenge.nonce,signature:await wallet.signMessage(challenge.message)})).status,200);
  const login=async signer=>{
    const issued=(await request('challenge','POST',{account:signer.address})).body;
    const response=await request('session','POST',{account:signer.address,nonce:issued.nonce,
      signature:await signer.signMessage(issued.message)});
    assert.equal(response.status,200);
    return cookie;
  };
  return {...p,directory,dbPath,request,login,async close(){await new Promise(resolve=>server.close(resolve));await service.close();await rm(directory,{recursive:true,force:true});}};
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

test('early delisting uses only the upgraded pool action with exact zero value and listing-bound IDs', async () => {
  const allow = new Set([factory.toLowerCase()]), upgraded = async () => ({ nativeSaleUpgrade: { version: 1 } });
  for (const args of [[0, 0, 7, true], [1, 3, 7, true], [1, 3, 7, false], [2, 3, 7, true]]) {
    const record = intent('delist', args, '0'), p = proof(record);
    await verifyWithGraph(p.provider, record, allow, upgraded);
    assert.equal(p.state.simulations, 0, 'The existing member journal does not add a new preflight simulation round.');
    assert.equal(p.state.estimates, 0);
    await assert.rejects(verifyWithGraph(p.provider, record, allow, async () => ({})), /verified native-sale upgrade/);
    await assert.rejects(verifyWithGraph(p.provider, { ...record, value: '1' }, allow, upgraded), /cannot send BNB/);
  }
  for (const args of [[3, 3, 7, true], [0, 3, 7, true], [1, 0, 7, true], [2, 0, 7, true], [0, 0, 0, true]]) {
    const record = intent('delist', args, '0'), p = proof(record);
    await assert.rejects(verifyWithGraph(p.provider, record, allow, upgraded), /current listing and exact/);
    assert.equal(p.state.simulations, 0, 'Malformed intent never reaches a simulation or wallet reservation.');
  }
  const record = intent('delist', [0, 0, 7, true], '0'), p = proof(record);
  p.state.registered = false;
  await assert.rejects(verifyWithGraph(p.provider, record, allow, upgraded), /registered/);
  p.state.registered = true;
  await assert.rejects(verifyWithGraph(p.provider, { ...record, action: { kind: 'vote' } }, allow, upgraded), /calldata must match/);
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

test('genesis product graph rejects the candidate-only budget child selector before reserving a nonce',async()=>{
  const p=proof(),allow=new Set([factory.toLowerCase()]);
  const params=[addr(4),1,1000,1000,addr(0),0,2000,3000];
  const record=intent('createBudgetChildPool',[params,addr(99)],'0','factory');
  await assert.rejects(verifyWithGraph(p.provider,record,allow,async()=>({
    factory,artifactDigest:hash(1),productKind:'pool',
  })),/verified upgraded Factory/);
  await assert.rejects(verifyWithGraph(p.provider,record,allow,async()=>({
    factory,artifactDigest:hash(2),productKind:'pool',securityUpgrade:{operationId:hash(3)},
  })),/Budget child subscriber is not a registered project/);
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

test('atomic product authorization verifies once and durably saves one signing permission',async()=>{
  const f=await fixture();
  try{
    const record=intent();
    f.state.registered=false;
    assert.equal((await f.request('market/prepare-and-arm','POST',{record,expectedRevision:0})).status,409);
    assert.equal((await f.request('market')).body.record,null);
    f.state.registered=true;
    const granted=await f.request('market/prepare-and-arm','POST',{record,expectedRevision:0});
    assert.equal(granted.status,200);
    assert.equal(granted.body.revision,2);
    assert.equal(granted.body.transaction.nonce,'0x7');
    assert.equal(granted.body.transaction.data,record.data);
    assert.equal(f.state.simulations,0);
    assert.equal(f.state.estimates,0);
    assert.equal(f.state.graphChecks,2,'one rejected and one accepted request each verify only once');
    const saved=(await f.request('market')).body;
    assert.equal(saved.revision,2);assert.deepEqual(saved.record,record);
    assert.equal(saved.canAbandon,false,'a granted signing permission cannot be discarded as an unused preparation');
    assert.equal((await f.request('market/prepare-and-arm','POST',{record,expectedRevision:0})).status,409);
    assert.equal((await f.request('market/arm','POST',{expectedRevision:2})).status,409);
  }finally{await f.close();}
});

test('product Gas envelope admits its 5M by 3 gwei boundary but rejects a larger fee',async()=>{
  const record={...intent(),gas:'5000000',gasPrice:'3000000000'};
  const f=await fixture({record});
  try{
    f.state.gasPrice=3_000_000_000n;
    const admitted=await f.request('market/prepare-and-arm','POST',{record,expectedRevision:0});
    assert.equal(admitted.status,200);
    assert.equal(admitted.body.record.gas,record.gas);
    assert.equal(admitted.body.record.gasPrice,record.gasPrice);
    assert.equal(f.state.simulations,0);
    assert.equal(f.state.estimates,0);
  }finally{await f.close();}

  const over={...record,gas:'5000001'};
  const rejected=await fixture({record:over});
  try{
    rejected.state.gasPrice=3_000_000_000n;
    const response=await rejected.request('market/prepare-and-arm','POST',{record:over,expectedRevision:0});
    assert.equal(response.status,400);
    assert.match(response.body.error,/Gas limits/);
    assert.equal(rejected.state.graphChecks,0);
  }finally{await rejected.close();}
});

test('product intent checks are capped per wallet before graph RPC, then recover without blocking hash writes',async()=>{
  const clock={value:120_000},f=await fixture({now:()=>clock.value});
  try{
    const record=intent();
    f.state.graphFailed=true;
    for(let i=0;i<8;i++){
      const path=i%2?'market':'market/prepare-and-arm',method=i%2?'PUT':'POST';
      const result=await f.request(path,method,{record,expectedRevision:0},
        {'X-Real-IP':`198.51.100.${i+1}`});
      assert.equal(result.status,409);
    }
    assert.equal(f.state.graphChecks,8);
    const capped=await f.request('market/prepare-and-arm','POST',{record,expectedRevision:0},
      {'X-Real-IP':'198.51.100.20'});
    assert.equal(capped.status,429);
    assert.equal(f.state.graphChecks,8,'a rejected request performs no graph proof');
    assert.equal((await f.request('market')).body.record,null);

    clock.value+=60_000;
    f.state.graphFailed=false;
    const saved=await f.request('market','PUT',{record,expectedRevision:0});
    assert.equal(saved.status,200,'a later window can start a legitimate intent');
    f.state.graphFailed=true;
    for(let i=0;i<7;i++)
      assert.equal((await f.request('market/arm','POST',{expectedRevision:saved.body.revision})).status,409);
    const checked=f.state.graphChecks;
    assert.equal((await f.request('market/arm','POST',{expectedRevision:saved.body.revision})).status,429);
    assert.equal(f.state.graphChecks,checked);
    assert.equal((await f.request('market','PUT',{record:{...record,hash:hash(77)},
      expectedRevision:saved.body.revision})).status,200,
    'an existing transaction hash remains durable when signing checks are capped');
  }finally{await f.close();}
});

test('product intent checks are capped per client IP across authenticated wallets',async()=>{
  const f=await fixture();
  try{
    f.state.graphFailed=true;
    const signers=[wallet,Wallet.createRandom(),Wallet.createRandom(),Wallet.createRandom()];
    const sessions=[];
    for(const signer of signers)sessions.push({signer,cookie:await f.login(signer)});
    for(const {signer,cookie} of sessions){
      const record={...intent(),account:signer.address.toLowerCase()};
      for(let i=0;i<6;i++)
        assert.equal((await f.request('market/prepare-and-arm','POST',{record,expectedRevision:0},
          {Cookie:cookie,'X-Pinkuang-Account':record.account,'X-Real-IP':'198.51.100.42'})).status,409);
    }
    assert.equal(f.state.graphChecks,24);
    const {signer,cookie}=sessions[0],record={...intent(),account:signer.address.toLowerCase()};
    assert.equal((await f.request('market/prepare-and-arm','POST',{record,expectedRevision:0},
      {Cookie:cookie,'X-Pinkuang-Account':record.account,'X-Real-IP':'198.51.100.42'})).status,429);
    assert.equal(f.state.graphChecks,24);
    assert.equal((await f.request('market/prepare-and-arm','POST',{record,expectedRevision:0},
      {Cookie:cookie,'X-Pinkuang-Account':record.account,'X-Real-IP':'198.51.100.43'})).status,409,
    'the wallet still has budget through a different client address');
    assert.equal(f.state.graphChecks,25);
  }finally{await f.close();}
});

test('concurrent atomic signing requests cannot authorize two wallet sends',async()=>{
  const f=await fixture();
  try{
    const record=intent();
    const responses=await Promise.all([f.request('market/prepare-and-arm','POST',{record,expectedRevision:0}),
      f.request('market/prepare-and-arm','POST',{record,expectedRevision:0})]);
    assert.deepEqual(responses.map(x=>x.status).sort(),[200,409]);
    assert.equal((await f.request('market')).body.revision,2);
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

test('reverted, proven cancellation and plain-EOA replacement never become a successful deposit',async()=>{
  for(const mode of ['reverted','cancelled','replaced']){
    const f=await fixture();
    try{
      assert.equal((await f.request('market','PUT',{record:{...intent(),hash:hash(76)},expectedRevision:0})).status,200);
      f.state.mined=true;f.state.logs=[];
      if(mode==='reverted')f.state.status=0;
      else{f.state.target=mode==='cancelled'?account:addr(98);f.state.data='0x';f.state.value=0n;
        if(mode==='cancelled'){f.state.txType=2;f.state.txGasLimit=21_000n;}}
      const result=await f.request('market','DELETE',{expectedRevision:1,hash:hash(77)});
      assert.equal(result.status,200);assert.equal(result.body.result.status,mode);assert.equal(result.body.result.poolAddress,undefined);
      if(mode==='replaced')assert.equal(result.body.result.plainEoaReplacementVerified,true);
    }finally{await f.close();}
  }
});

test('a type-4 envelope stays pending even when it contains the exact calldata and a matching deposit event',async()=>{
  const f=await fixture();
  try{
    assert.equal((await f.request('market','PUT',{record:intent(),expectedRevision:0})).status,200);
    f.state.mined=true;f.state.target=account;f.state.txType=4;f.state.value=0n;
    f.state.data=`0x12345678${intent().data.slice(2)}`;
    const result=await f.request('market','DELETE',{expectedRevision:1,hash:hash(77)});
    assert.equal(result.status,409);assert.match(result.body.error,/inner product call/);
    assert.deepEqual((await f.request('market')).body.record,intent());
    assert.equal((await f.request(`market/result?hash=${hash(77)}`)).body.result,null);
  }finally{await f.close();}
});

test('all product action selectors reject unproved successful wrapped execution',async()=>{
  const sample=input=>input.baseType==='tuple' ? input.components.map(sample)
    : input.baseType==='array' ? [] : input.type==='address' ? addr(9)
      : input.type==='bool' ? true : input.type.startsWith('bytes') ? input.type==='bytes' ? '0x12' : hash(9)
        : input.type==='string' ? 'sample' : 1n;
  const groups=[['pool',poolAbi,pool],['market',marketAbi,market],['factory',factoryAbi,factory],
    ['portfolio',portfolioAbi,addr(4)],['portfolioFactory',portfolioFactoryAbi,addr(5)],
    ['portfolioMarket',marketAbi,addr(6)]];
  for(const [targetType,contract,target] of groups){
    for(const fragment of contract.fragments.filter(item=>item.type==='function')){
      const record={...intent(),targetType,target,factory:targetType==='factory'||targetType==='portfolioFactory'?target:factory,
        action:{kind:fragment.name},data:contract.encodeFunctionData(fragment,fragment.inputs.map(sample)),value:'0'};
      const p=proof(record);p.state.mined=true;p.state.target=account;p.state.txType=4;
      p.state.data=`0x12345678${record.data.slice(2)}`;p.state.value=0n;
      await assert.rejects(verifyMarketFinalized(p.provider,record,hash(77)),/inner product call/,
        `${targetType}.${fragment.name}`);
    }
  }
});

test('exact finalized product calls settle after wallet speed-up or Gas edits and keep the over-cap evidence',async()=>{
  for(const [change,label,expected] of [
    [state=>{state.txGasLimit=100_001n;},'Gas limit',{gasLimitExceeded:true}],
    [state=>{state.txMaxFeePerGas=1_200_000_000n;},'maximum fee',{feeExceeded:true}],
    [state=>{state.txPriorityFeePerGas=1_200_000_000n;},'priority fee',{feeExceeded:true}],
    [state=>{state.gasPrice=1_200_000_000n;},'wallet-selected effective fee',{feeExceeded:true}],
  ]){
    const f=await fixture();
    try{
      assert.equal((await f.request('market','PUT',{record:intent(),expectedRevision:0})).status,200);
      f.state.mined=true;change(f.state);
      const settled=await f.request('market','DELETE',{expectedRevision:1,hash:hash(77)});
      assert.equal(settled.status,200,label);assert.equal(settled.body.result.status,'confirmed',label);
      for(const [key,value] of Object.entries(expected))assert.equal(settled.body.result[key],value,label);
      assert.deepEqual((await f.request(`market/result?hash=${hash(77)}`)).body.result,settled.body.result);
      assert.equal((await f.request('market')).body.record,null,label);
      f.state.mined=false;f.state.nonce=8;f.state.gasPrice=1_000_000_000n;
      assert.equal((await f.request('market','PUT',{record:{...intent(),nonce:8},expectedRevision:2})).status,200,
        `${label} must not strand the next signing lane`);
    }finally{await f.close();}
  }
});

test('exact direct type-4 action may confirm, but a wrapped self-call cannot clear an intent',async()=>{
  const direct=await fixture();
  try{
    assert.equal((await direct.request('market','PUT',{record:intent(),expectedRevision:0})).status,200);
    direct.state.mined=true;direct.state.txType=4;
    const result=await direct.request('market','DELETE',{expectedRevision:1,hash:hash(77)});
    assert.equal(result.status,200);assert.equal(result.body.result.status,'confirmed');
  }finally{await direct.close();}
  const self=await fixture();
  try{
    assert.equal((await self.request('market','PUT',{record:intent(),expectedRevision:0})).status,200);
    self.state.mined=true;self.state.target=account;self.state.txType=4;
    self.state.data='0x';self.state.value=0n;
    const result=await self.request('market','DELETE',{expectedRevision:1,hash:hash(77)});
    assert.equal(result.status,409);assert((await self.request('market')).body.record);
  }finally{await self.close();}
});

test('only inert 21,000-gas self-transfers count as cancellation; other provable EOA spends are replacement',async()=>{
  for(const [type,gasLimit,authorizationList,status] of [
    [0,21_000n,undefined,'cancelled'],[1,21_000n,undefined,'cancelled'],[2,21_000n,undefined,'cancelled'],
    [2,21_001n,undefined,'replaced'],[2,21_000n,[{}],null],[4,21_000n,undefined,null],
  ]){
    const f=await fixture();
    try{
      assert.equal((await f.request('market','PUT',{record:intent(),expectedRevision:0})).status,200);
      f.state.mined=true;f.state.target=account;f.state.data='0x';f.state.value=0n;f.state.logs=[];
      f.state.txType=type;f.state.txGasLimit=gasLimit;
      const original=f.provider.getTransaction.bind(f.provider);
      f.provider.getTransaction=async hash=>({...await original(hash),authorizationList});
      const recovered=await f.request('market','DELETE',{expectedRevision:1,hash:hash(77)});
      assert.equal(recovered.status,status?200:409,`type ${type}, gas ${gasLimit}, auth ${Boolean(authorizationList)}`);
      if(status){assert.equal(recovered.body.result.status,status);assert.equal((await f.request('market')).body.record,null);}
      else assert.deepEqual((await f.request('market')).body.record,intent());
    }finally{await f.close();}
  }
});

test('a reverted unrelated replacement can release the nonce without claiming product execution',async()=>{
  const f=await fixture();
  try{
    assert.equal((await f.request('market','PUT',{record:intent(),expectedRevision:0})).status,200);
    f.state.mined=true;f.state.status=0;f.state.target=addr(98);f.state.data='0x';f.state.value=0n;
    const result=await f.request('market','DELETE',{expectedRevision:1,hash:hash(77)});
    assert.equal(result.status,200);assert.equal(result.body.result.status,'replaced');
    assert.equal((await f.request('market')).body.record,null);
  }finally{await f.close();}
});

test('a successful unrelated plain-EOA nonce spend settles as replaced and frees the next product lane',async()=>{
  const f=await fixture();
  try{
    assert.equal((await f.request('market','PUT',{record:intent(),expectedRevision:0})).status,200);
    assert.equal((await f.request('market/arm','POST',{expectedRevision:1})).status,200);
    f.state.mined=true;f.state.target=addr(98);f.state.data='0x1234';f.state.value=0n;f.state.logs=[];
    const settled=await f.request('market','DELETE',{expectedRevision:2,hash:hash(77)});
    assert.equal(settled.status,200);assert.equal(settled.body.result.status,'replaced');
    assert.equal(settled.body.result.plainEoaReplacementVerified,true);
    assert.equal((await f.request('market')).body.record,null);
    f.state.mined=false;f.state.nonce=8;
    const next=await f.request('market/prepare-and-arm','POST',{record:{...intent(),nonce:8},expectedRevision:3});
    assert.equal(next.status,200,'the proven unrelated spend must not strand a wallet account');
  }finally{await f.close();}
});

test('successful replacement stays pending when same-block delegation or full EOA proof is uncertain',async()=>{
  for(const [label,change] of [
    ['account delegated before block',state=>{state.accountCode='0xef0100';}],
    ['earlier type-4 in same block',state=>{state.priorTransactionTypes=[4];}],
    ['unknown earlier envelope',state=>{state.priorTransactionTypes=[99];}],
    ['same product target with different calldata',state=>{state.target=pool;}],
  ]){
    const f=await fixture();
    try{
      assert.equal((await f.request('market','PUT',{record:intent(),expectedRevision:0})).status,200);
      f.state.mined=true;f.state.target=addr(98);f.state.data='0x1234';f.state.value=0n;f.state.logs=[];
      change(f.state);
      assert.equal((await f.request('market','DELETE',{expectedRevision:1,hash:hash(77)})).status,409,label);
      assert.deepEqual((await f.request('market')).body.record,intent(),label);
    }finally{await f.close();}
  }
  const incomplete=await fixture();
  try{
    assert.equal((await incomplete.request('market','PUT',{record:intent(),expectedRevision:0})).status,200);
    incomplete.state.mined=true;incomplete.state.target=addr(98);incomplete.state.data='0x1234';incomplete.state.value=0n;
    const getBlock=incomplete.provider.getBlock.bind(incomplete.provider);
    incomplete.provider.getBlock=async tag=>getBlock(tag,false);
    assert.equal((await incomplete.request('market','DELETE',{expectedRevision:1,hash:hash(77)})).status,409);
    assert.deepEqual((await incomplete.request('market')).body.record,intent());
  }finally{await incomplete.close();}
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
      assert.deepEqual(ack.transaction,{from:account,to:account,chainId:'0x38',nonce:'0x7',data:'0x',value:'0x0',gas:'0x5208',
        ...(record.version===2
          ? {maxFeePerGas:`0x${1_200_000_000n.toString(16)}`,maxPriorityFeePerGas:`0x${1_200_000_000n.toString(16)}`,type:'0x2'}
          : {gasPrice:`0x${1_200_000_000n.toString(16)}`,type:'0x0'})});
      assert.equal(ack.record.cancellationRequests.length,1);
      const tampered={...ack.record,cancellationRequests:[]};
      assert.equal((await f.request('market','PUT',{record:tampered,expectedRevision:2})).status,409);
      const arbitrary={...ack.record,cancellationRequests:[{...ack.record.cancellationRequests[0],to:addr(98)}]};
      assert.equal((await f.request('market','PUT',{record:arbitrary,expectedRevision:2})).status,400);
      assert((await f.request('market')).body.record);
      f.state.mined=true;f.state.target=account;f.state.data='0x';f.state.value=0n;f.state.logs=[];
      f.state.txType=record.version===2?2:0;f.state.txGasLimit=21_000n;
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
  assert.equal(BigInt(tx.maxFeePerGas),2_400_000_000n);
  assert.equal(tx.maxPriorityFeePerGas,tx.maxFeePerGas);
  const next=await cancellationIntent(p.provider,{...intent(),cancellationRequests:[{...tx,createdAt:'2026-09-29T00:00:00Z'}]});
  assert.equal(BigInt(next.maxFeePerGas),2_880_000_000n,'retry must bump the previous signed cancellation ACK');
  const prior=proof();prior.provider.getTransaction=async()=>({chainId:56n,from:account,nonce:7,
    gasPrice:1_100_000_000n,maxFeePerGas:2_000_000_000n,maxPriorityFeePerGas:1_800_000_000n});
  const bumped=await cancellationIntent(prior.provider,{...intent(),hash:hash(77)});
  assert.equal(BigInt(bumped.maxFeePerGas),2_400_000_000n,'type-2 maximum fee must be bumped, not just its effective price');
});

function legacyIntent(){
  const record={...intent('withdrawBnb',[],'0','market'),version:1,market,action:{kind:'withdraw'},hash:hash(77)};
  delete record.target;delete record.targetType;
  return record;
}
test('a legacy market journal also releases a finalized unrelated plain-EOA nonce spend',async()=>{
  const record={...legacyIntent(),hash:hash(76)},f=await fixture({record});
  try{
    assert.equal((await f.request('market','PUT',{record,expectedRevision:0})).status,200);
    f.state.mined=true;f.state.target=addr(98);f.state.data='0x1234';f.state.value=0n;f.state.logs=[];
    const settled=await f.request('market','DELETE',{expectedRevision:1,hash:hash(77)});
    assert.equal(settled.status,200);assert.equal(settled.body.result.status,'replaced');
    assert.equal(settled.body.result.plainEoaReplacementVerified,true);
    assert.equal((await f.request('market')).body.record,null);
  }finally{await f.close();}
});
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
      gas:'0x186a0',maxFeePerGas:'0x3b9aca00',maxPriorityFeePerGas:'0x3b9aca00',type:'0x2'});
    assert.equal((await f.request('market/arm','POST',{expectedRevision:2})).status,409);
    const reopened=new JournalStore(f.dbPath);
    try { assert.throws(()=>reopened.armMarket(account,2),/already consumed/); } finally {reopened.close();}
    assert.equal((await f.request('market','PUT',{record:{...intent(),gas:'100001'},expectedRevision:2})).status,409);
    assert.equal((await f.request('market','PUT',{record:{...intent(),hash:hash(77)},expectedRevision:2})).status,200);
  } finally {await f.close();}
});

test('one legacy envelope is durably issued only for the same armed product call and free nonce',async()=>{
  const f=await fixture();
  try{
    const record=intent();
    assert.equal((await f.request('market','PUT',{record,expectedRevision:0})).status,200);
    assert.equal((await f.request('market')).body.canRequestLegacyEnvelope,false,'preparation has no signing permission');
    assert.equal((await f.request('market')).body.legacyEnvelopeIssued,false);
    assert.equal((await f.request('market/legacy-envelope','POST',{expectedRevision:1,walletRejectedType2:true})).status,409);
    assert.equal((await f.request('market/arm','POST',{expectedRevision:1})).status,200);
    assert.equal((await f.request('market')).body.canRequestLegacyEnvelope,true);
    assert.equal((await f.request('market/legacy-envelope','POST',{expectedRevision:2})).status,400);
    const request=()=>f.request('market/legacy-envelope','POST',{expectedRevision:2,walletRejectedType2:true});
    const race=await Promise.all([request(),request()]);
    assert.deepEqual(race.map(item=>item.status).sort(),[200,409]);
    const grant=race.find(item=>item.status===200).body;
    assert.equal(grant.legacyEnvelopeAuthorized,true);assert.equal(grant.revision,3);
    assert.deepEqual(grant.record,record);
    assert.deepEqual(grant.transaction,{chainId:'0x38',from:account,to:pool,nonce:'0x7',data:record.data,
      value:'0x14',gas:'0x186a0',gasPrice:'0x3b9aca00',type:'0x0'});
    assert.equal((await f.request('market')).body.canRequestLegacyEnvelope,false);
    assert.equal((await f.request('market')).body.legacyEnvelopeIssued,true);
    const reopened=new JournalStore(f.dbPath);
    try{
      assert.equal(reopened.canRequestLegacyMarketEnvelope(account),false);
      assert.throws(()=>reopened.authorizeLegacyMarketEnvelope(account,3),/unavailable/);
    }finally{reopened.close();}
    assert.equal((await f.request('market/legacy-envelope','POST',{expectedRevision:3,walletRejectedType2:true})).status,409);
    f.state.mined=true;f.state.txType=0;
    const settled=await f.request('market','DELETE',{expectedRevision:3,hash:hash(77)});
    assert.equal(settled.status,200);assert.equal(settled.body.result.status,'confirmed');
  }finally{await f.close();}
});

test('legacy envelope fallback cannot bypass hash, nonce or current product graph checks',async()=>{
  for(const change of [{pendingNonce:8},{nonce:8},{graphFailed:true},{gasPrice:1_000_000_001n}]){
    const f=await fixture();
    try{
      assert.equal((await f.request('market','PUT',{record:intent(),expectedRevision:0})).status,200);
      assert.equal((await f.request('market/arm','POST',{expectedRevision:1})).status,200);
      Object.assign(f.state,change);
      assert.equal((await f.request('market/legacy-envelope','POST',{expectedRevision:2,walletRejectedType2:true})).status,409);
      assert.equal((await f.request('market')).body.canRequestLegacyEnvelope,true,'failed preflight must not consume the grant');
    }finally{await f.close();}
  }
  const f=await fixture();
  try{
    assert.equal((await f.request('market','PUT',{record:intent(),expectedRevision:0})).status,200);
    assert.equal((await f.request('market/arm','POST',{expectedRevision:1})).status,200);
    assert.equal((await f.request('market','PUT',{record:{...intent(),hash:hash(77)},expectedRevision:2})).status,200);
    assert.equal((await f.request('market','GET')).body.canRequestLegacyEnvelope,false);
    assert.equal((await f.request('market/legacy-envelope','POST',{expectedRevision:3,walletRejectedType2:true})).status,409);
  }finally{await f.close();}
});

test('cancellation after legacy fallback uses a legacy self-transfer and still needs a finalized nonce proof',async()=>{
  const f=await fixture();
  try{
    assert.equal((await f.request('market','PUT',{record:intent(),expectedRevision:0})).status,200);
    assert.equal((await f.request('market/arm','POST',{expectedRevision:1})).status,200);
    assert.equal((await f.request('market/legacy-envelope','POST',{expectedRevision:2,walletRejectedType2:true})).status,200);
    const cancel=await f.request('market/cancel-intent','POST',{expectedRevision:3});
    assert.equal(cancel.status,200);assert.equal(cancel.body.transaction.type,'0x0');
    assert.equal(cancel.body.legacyEnvelopeIssued,true);
    assert.equal(BigInt(cancel.body.transaction.gasPrice),1_200_000_000n);
    assert.equal((await f.request('market','DELETE',{expectedRevision:4,hash:hash(77)})).status,409);
    f.state.mined=true;f.state.target=account;f.state.data='0x';f.state.value=0n;f.state.logs=[];
    f.state.txType=0;f.state.txGasLimit=21_000n;
    const settled=await f.request('market','DELETE',{expectedRevision:4,hash:hash(77)});
    assert.equal(settled.status,200);assert.equal(settled.body.result.status,'cancelled');
  }finally{await f.close();}
});

test('existing market signing journals migrate without forgetting their consumed intent',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'pinkuang-signing-migrate-'));
  const dbPath=join(directory,'journal.sqlite');
  const previous=new DatabaseSync(dbPath);
  try{
    previous.exec('CREATE TABLE market_signing (account TEXT PRIMARY KEY, intent_key TEXT NOT NULL, armed_at INTEGER NOT NULL)');
    previous.prepare('INSERT INTO market_signing(account,intent_key,armed_at) VALUES(?,?,?)').run(account,'old-intent',123);
  }finally{previous.close();}
  const upgraded=new JournalStore(dbPath);
  try{
    assert.equal(upgraded.db.prepare('SELECT intent_key,armed_at,legacy_issued_at FROM market_signing WHERE account=?')
      .get(account).intent_key,'old-intent');
    assert.equal(upgraded.db.prepare('SELECT legacy_issued_at FROM market_signing WHERE account=?').get(account).legacy_issued_at,null);
  }finally{upgraded.close();await rm(directory,{recursive:true,force:true});}
});

test('signing permission rechecks graph, nonce, Gas price and balance after persistence',async()=>{
  for (const change of [{nonce:8},{pendingNonce:8},{gasPrice:1000000001n},{balance:1n},{graphFailed:true}]) {
    const f=await fixture();
    try {
      assert.equal((await f.request('market','PUT',{record:intent(),expectedRevision:0})).status,200);
      Object.assign(f.state,change);
      assert.equal((await f.request('market/arm','POST',{expectedRevision:1})).status,409);
      assert.deepEqual((await f.request('market')).body,{record:intent(),revision:1,canAbandon:true,
        canRequestLegacyEnvelope:false,legacyEnvelopeIssued:false});
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

test('fresh direct user deposits, share trades and governance do not read operational worker readiness',async()=>{
 const p=proof(),allow=new Set([factory.toLowerCase()]);let checks=0,prepares=0;
 const graph=async()=>({freshAuthority:{address:addr(90)},freshFactoryVerified:true});
 const options={freshProductVerifier:async()=>{checks++;throw Error('mining worker offline');}};
 options.freshProductVerifier.prepareIndex=async()=>{prepares++;throw Error('index offline');};
 for(const [name,args,value,type]of [['deposit',[2],'20','pool'],['claim',[],'0','pool'],['withdrawBnb',[],'0','pool'],
   ['propose',[200,200,1],'0','pool'],['vote',[1,true],'0','pool'],['executeSale',[1],'0','pool'],
   ['list',[pool,2,5],'0','market'],['fill',[1,2],'10','market']]){
   await verifyWithGraph(p.provider,intent(name,args,value,type),allow,graph,options);
 }
 assert.equal(checks,0,'the user wallet path never calls index/purchase/mining readiness');
 assert.equal(prepares,0,'member wallet actions never prefetch the index');
 assert.equal(p.state.simulations,0);assert.equal(p.state.estimates,0);
 await assert.rejects(verifyWithGraph(p.provider,intent(),allow,graph),/not enabled/);
});
test('fresh automated product intents prepare the index before the pinned graph and consume the prepared validator',async()=>{
 const record=intent('buyFromMarket',[1],'0'),p=proof(record),events=[];let releaseIndex;
 const send=p.provider.send;p.provider.send=async(method,args)=>{if(method==='eth_chainId')events.push('chain');return send(method,args);};
 const getBlock=p.provider.getBlock;p.provider.getBlock=async(...args)=>{if(args[0]==='latest')events.push('latest');return getBlock(...args);};
 const verifier=async()=>{throw Error('unprepared verifier must not run');};
 verifier.prepareIndex=async()=>{events.push('index');await new Promise(resolve=>{releaseIndex=resolve;});
  return async(_provider,_graph,block)=>{assert.equal(block.number,102);events.push('prepared-proof');throw Error('machine proof failed');};};
 const graph=async()=>{events.push('graph');return {freshAuthority:{address:addr(90)},freshFactoryVerified:true};};
 const attempt=verifyWithGraph(p.provider,record,new Set([factory.toLowerCase()]),graph,{freshProductVerifier:verifier});
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(events,['chain','index']);releaseIndex();
 await assert.rejects(attempt,error=>{
   assert.equal(error.status,409);assert.equal(error.message,'Product identity, value or transaction checks could not be verified.');return true;
  });
 assert.deepEqual(events,['chain','index','latest','graph','prepared-proof']);
});
test('fresh operator actions remain on Authority and automated purchases retain service readiness',async()=>{
 const p=proof(),graph=async()=>({freshAuthority:{address:addr(90)},freshFactoryVerified:true});
 const allow=new Set([factory.toLowerCase()]);let readinessCalls=0;
 const options={freshProductVerifier:async()=>{readinessCalls++;throw Error('mining worker offline');}};
 let prepares=0;options.freshProductVerifier.prepareIndex=async()=>{prepares++;return options.freshProductVerifier;};
 const params=[addr(4),9,1000,900,addr(0),0,2000,3000];
 const mine=intent('mine',[new Interface(['function reclaim(bytes32)']).encodeFunctionData('reclaim',[hash(2)])],'0');
 const budgetCreate={...intent(),target:factory,targetType:'portfolioFactory',action:{kind:'createPortfolio'},value:'0',
   data:portfolioFactoryAbi.encodeFunctionData('createPortfolio',[1000,900,10,2000,3000])};
 const budgetBuy={...intent(),targetType:'portfolio',action:{kind:'buyOfficial'},value:'0',
   data:portfolioAbi.encodeFunctionData('buyOfficial',[addr(40),1])};
 for(const record of [mine,intent('createPool',[params],'0','factory'),budgetCreate,budgetBuy])
   await assert.rejects(verifyWithGraph(p.provider,record,allow,graph,options),/administrator signature/);
 assert.equal(readinessCalls,0,'Authority-only operations are denied before worker access');
 assert.equal(prepares,0,'Authority-only actions cannot acquire an index dependency before their original rejection');
 for(const name of ['buyFromMarket','buyAlternativeFromMarket'])
   await assert.rejects(verifyWithGraph(p.provider,intent(name,[1],'0'),allow,graph,options));
 assert.equal(readinessCalls,2,'operator pool purchase paths still require service readiness');
});

test('fresh member wallet outage exception preserves target, exact calldata/value, graph, fee and nonce checks',async()=>{
 const p=proof(),allow=new Set([factory.toLowerCase()]),graph=async()=>({freshAuthority:{address:addr(90)},freshFactoryVerified:true});
 let readinessCalls=0;const options={freshProductVerifier:async()=>{readinessCalls++;throw Error('worker offline');}};
 const verify=record=>verifyWithGraph(p.provider,record,allow,graph,options);
 await verify(intent());
 await assert.rejects(verify(intent('deposit',[2],'21')),/Deposit value/);
 await assert.rejects(verify({...intent(),action:{kind:'claim'}}),/exact calldata/);
 await assert.rejects(verify({...intent(),data:intent().data+'00'}),/exact calldata/);
 await assert.rejects(verify({...intent(),targetType:'market'}),/Unsupported product call|exact calldata/);
 await assert.rejects(verify(intent('claim',[],'1')),/nonpayable|value|send BNB/i);
 p.state.registered=false;await assert.rejects(verify(intent()),/registered/);p.state.registered=true;
 const getCode=p.provider.getCode;p.provider.getCode=async target=>target===pool?'0x':getCode(target);
 await assert.rejects(verify(intent()),/no code/);p.provider.getCode=getCode;
 await assert.rejects(verifyWithGraph(p.provider,intent(),allow,async()=>{throw Error('untrusted graph');},options));
 p.state.orderPrice=101n;
 await assert.rejects(verify(intent('fill',[1,2],'202','market')),/buyer fee/);
 await verify(intent('fill',[1,2],'204','market'));
 p.state.buyerFeeBps=0n;await assert.rejects(verify(intent('fill',[1,2],'204','market')),/Bilateral/);p.state.buyerFeeBps=100n;
 p.state.pendingNonce=8;await assert.rejects(verify(intent()),/nonce/);p.state.pendingNonce=7;
 p.state.balance=0n;await assert.rejects(verify(intent()),/balance|funds/i);
 assert.equal(readinessCalls,0,'failures are precise user-intent failures, not worker checks');
});

test('fresh budget wallet deposits, transfers, governance, claims and market orders are independent of workers',async()=>{
 const p=proof(),allow=new Set([factory.toLowerCase()]),child=addr(40),legacy=addr(10);
 const graph=async()=>({freshAuthority:{address:addr(90)},freshFactoryVerified:true,productKind:'budget',factory,legacyFactory:legacy});
 let readinessCalls=0;const options={freshProductVerifier:async()=>{readinessCalls++;throw Error('worker offline');}};
 const extra=new Interface(['function childInfo(address) view returns(address collection,uint256 tokenId,uint256 purchaseCost,bool official,bool sold)',
   'function factory() view returns(address)','function OFFICIAL_FACTORY() view returns(address)']);
 const send=p.provider.send.bind(p.provider);
 p.provider.send=async(method,params)=>{
   if(method==='eth_call'){
     const parsed=extra.parseTransaction(params[0]);
     if(parsed?.name==='childInfo')return extra.encodeFunctionResult('childInfo',[addr(41),7,100,true,false]);
     if(params[0].to.toLowerCase()===child.toLowerCase()&&parsed)
       return extra.encodeFunctionResult(parsed.name,[legacy]);
   }
   return send(method,params);
 };
 const make=(name,args=[],value='0')=>({...intent(),targetType:'portfolio',action:{kind:name},
   data:portfolioAbi.encodeFunctionData(name,args),value});
 for(const [name,args,value] of [['deposit',[2],'20'],['transfer',[addr(42),1],'0'],
   ['withdrawDeposit',[],'0'],['finalizeFundingFailure',[],'0'],['claimFailedFunding',[],'0'],['finalizeAcquisition',[],'0'],
   ['collectChildBem',[child],'0'],['claimBem',[],'0'],['withdrawBnb',[],'0'],['proposeChildSale',[child,100,100,1],'0'],
   ['voteChildSale',[1,true],'0'],['executeChildSale',[1],'0'],['settleChildSale',[],'0'],['expireChildSale',[],'0']])
   await verifyWithGraph(p.provider,make(name,args,value),allow,graph,options);
 for(const [name,args,value] of [['list',[pool,2,5],'0'],['fill',[1,2],'10'],['cancel',[1],'0'],['expire',[1],'0'],['withdrawBnb',[],'0']])
   await verifyWithGraph(p.provider,intent(name,args,value,'portfolioMarket'),allow,graph,options);
 await assert.rejects(verifyWithGraph(p.provider,make('deposit',[2],'21'),allow,graph,options),/share price/);
 await assert.rejects(verifyWithGraph(p.provider,make('transfer',[addr(0),1]),allow,graph,options),/recipient/);
 p.state.registered=false;await assert.rejects(verifyWithGraph(p.provider,make('claimBem'),allow,graph,options),/registered/);
 assert.equal(readinessCalls,0);
});


test('fresh user exits survive machine outage but preserve registration, amount and nonce checks',async()=>{
 const p=proof(),allow=new Set([factory.toLowerCase()]),graph=async()=>({freshFactoryVerified:true,freshAuthority:{address:addr(90)}});
 let readinessCalls=0;const options={freshProductVerifier:async()=>{readinessCalls++;throw Error('worker offline');}};
 const nonce=p.provider.getTransactionCount,balance=p.provider.getBalance;
 p.provider.getTransactionCount=async(address,tag)=>{assert.equal(address,account,'only the user funds this exit');return nonce(address,tag);};
 p.provider.getBalance=async address=>{assert.equal(address,account,'platform Gas balance is never queried for a member exit');return balance(address);};
 for(const [name,args,type]of [['claim',[],'pool'],['withdrawBnb',[],'pool'],['withdrawDeposit',[],'pool'],['finalizeFailure',[],'pool'],['harvest',[],'pool'],['cancelExpired',[],'pool'],['cancel',[1],'market'],['expire',[1],'market'],['withdrawBnb',[],'market']])
  await verifyWithGraph(p.provider,intent(name,args,'0',type),allow,graph,options);
 await assert.rejects(verifyWithGraph(p.provider,intent('claim',[],'1'),allow,graph,options),/nonpayable|value|send BNB/i);
 p.state.registered=false;await assert.rejects(verifyWithGraph(p.provider,intent('claim',[],'0'),allow,graph,options),/registered/);
 p.state.registered=true;p.state.pendingNonce=8;await assert.rejects(verifyWithGraph(p.provider,intent('claim',[],'0'),allow,graph,options),/nonce/);
 await assert.rejects(verifyWithGraph(p.provider,intent('claim',[],'0'),new Set(),graph,options),/not enabled/);
 assert.equal(readinessCalls,0,'member exits never enter the machine/relay proof reader');
});

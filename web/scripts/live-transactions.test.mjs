import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { authenticate, connectWallet, readPending, sendProductTransaction, recoverPending, cancelPendingNonce,
  retryLegacyEnvelope, productGasLimit, requireCurrentProductStage, validateProductTransactionStage } from '../lib/live-transactions.mjs';
import { ARTIFACT_DIGEST } from '../lib/chain-client.mjs';
import pinnedGenesis from '../public/data/frontend-manifest.json' with { type: 'json' };
import { loadFreshLiveConfig } from '../lib/fresh-product-config.mjs';
import { freshAuthorityBrowserFixture } from './fresh-authority-browser-fixture.mjs';
const addr=n=>getAddress(`0x${n.toString(16).padStart(40,'0')}`), hash=n=>`0x${n.toString(16).padStart(64,'0')}`;
const account=addr(1),factory=addr(2),pool=addr(3),market=addr(4);
const config={status:'ready',chainId:56,factory,shareMarket:market,journalBase:'/api/journal',origin:'https://bemine.example'};
test('genesis stage accepts old selectors but rejects candidate-only Factory methods', () => {
  const base = { ...config, factory: pinnedGenesis.factory, shareMarket: pinnedGenesis.shareMarket,
    manifest: pinnedGenesis, stage: 'genesis', artifactDigest: pinnedGenesis.artifactDigest };
  const oldCall = { from: account, to: pool, chainId: '0x38', value: '0',
    data: abi.PoolVault.encodeFunctionData('claim') };
  assert.equal(validateProductTransactionStage(base, oldCall, 'claim').action.kind, 'claim');
  const params = { circuits: addr(88), circuitId: 1n, targetRaise: 100n, priceCap: 100n,
    directSeller: addr(89), directPrice: 0n, fundingDeadline: 1000n, purchaseDeadline: 2000n };
  const newCall = { from: account, to: pinnedGenesis.factory, chainId: '0x38', value: '0',
    data: abi.PoolFactory.encodeFunctionData('createBudgetChildPool', [params, account]) };
  assert.throws(() => validateProductTransactionStage(base, newCall, 'createBudgetChildPool'));
  const upgraded = { ...base, stage: 'code-upgraded', artifactDigest: ARTIFACT_DIGEST,
    manifest: { ...pinnedGenesis, artifactDigest: ARTIFACT_DIGEST } };
  assert.throws(() => validateProductTransactionStage(upgraded, newCall, 'createBudgetChildPool'));
  upgraded.operationalReady = true;
  assert.equal(validateProductTransactionStage(upgraded, newCall, 'createBudgetChildPool').action.kind, 'createBudgetChildPool');
  assert.throws(() => validateProductTransactionStage({ ...upgraded, artifactDigest: pinnedGenesis.artifactDigest }, oldCall, 'claim'));
});

test('a verified fresh graph without a user-exit attestation remains read-only until services are active', () => {
  const transaction = { from: account, to: pool, chainId: '0x38', value: '0',
    data: abi.PoolVault.encodeFunctionData('claim') };
  const fresh = { ...config, stage: 'fresh-active', artifactDigest: ARTIFACT_DIGEST,
    manifest: { ...pinnedGenesis, artifactDigest: ARTIFACT_DIGEST }, operationalReady: false };
  assert.throws(() => validateProductTransactionStage(fresh, transaction, 'claim'),
    /新增交易服务尚未启用/);
  assert.equal(validateProductTransactionStage({ ...fresh, operationalReady: true }, transaction, 'claim').action.kind, 'claim');
});

test('display-only graph metadata blocks a wallet action before signing or journaling', () => {
  const base = { ...config, factory: pinnedGenesis.factory, shareMarket: pinnedGenesis.shareMarket,
    manifest: pinnedGenesis, stage: 'genesis', artifactDigest: pinnedGenesis.artifactDigest };
  const transaction = { from: account, to: pool, chainId: '0x38', value: '0',
    data: abi.PoolVault.encodeFunctionData('claim') };
  for (const historical of [{ readMode: 'verified_snapshot', stale: true, transactionReady: false },
    { readMode: 'unknown' }, { readMode: 'current', stale: true }, { readMode: 'current', transactionReady: false }])
    assert.throws(() => validateProductTransactionStage({ ...base, ...historical }, transaction, 'claim'),
      /仅供展示/);
  assert.equal(validateProductTransactionStage({ ...base, readMode: 'current', stale: false }, transaction, 'claim').action.kind, 'claim');
});

test('a stale or unverified graph blocks before wallet access or intent persistence', async () => {
  const secureConfig = { ...config, factory: pinnedGenesis.factory, shareMarket: pinnedGenesis.shareMarket,
    portfolioFactory: pinnedGenesis.portfolioFactory, manifest: pinnedGenesis, stage: 'genesis',
    artifactDigest: pinnedGenesis.artifactDigest, productGraphUrl: 'https://bemine.example/api/journal/product-graph' };
  let walletCalls = 0, networkCalls = 0;
  const provider = { request: async () => { walletCalls++; throw new Error('wallet must remain untouched'); } };
  const fetcher = async () => { networkCalls++; return new Response(JSON.stringify({ status: 'unverified' }),
    { status: 200, headers: { 'content-type': 'application/json' } }); };
  const transaction = { from: account, to: pool, chainId: '0x38', value: '0', data: abi.PoolVault.encodeFunctionData('claim') };
  await assert.rejects(sendProductTransaction({ provider, config: { ...secureConfig,
    readMode: 'verified_snapshot', stale: true, transactionReady: false },
    transaction, action: 'claim', fetcher }), error => error.code === 'product_graph' && error.beforeIntent === true);
  assert.equal(networkCalls, 1); assert.equal(walletCalls, 0);
  await assert.rejects(sendProductTransaction({ provider, config: secureConfig,
    transaction,
    action: 'claim', fetcher }), error => error.code === 'product_graph' && error.beforeIntent === true);
  assert.equal(networkCalls, 2); assert.equal(walletCalls, 0);
});

test('display-only graph waits for a fresh identical proof before transaction preparation', async () => {
  const manifest = { ...pinnedGenesis, verifiedBlockNumber: pinnedGenesis.deployment.blockNumber };
  const secureConfig = { ...config, factory: pinnedGenesis.factory, shareMarket: pinnedGenesis.shareMarket,
    portfolioFactory: pinnedGenesis.portfolioFactory, manifest, stage: 'genesis',
    artifactDigest: pinnedGenesis.artifactDigest, stageActivationBlock: pinnedGenesis.deployment.blockNumber,
    stageActivationHash: pinnedGenesis.deployment.blockHash, operationalReady: true,
    productGraphUrl: 'https://bemine.example/api/journal/product-graph' };
  const baseGraph = { status: 'verified', chainId: 56, stage: 'genesis',
    artifactDigest: pinnedGenesis.artifactDigest, genesisArtifactDigest: pinnedGenesis.artifactDigest,
    upgradeArtifactDigest: null, operationId: null, verifiedBlockNumber: pinnedGenesis.verifiedBlockNumber,
    verifiedBlockHash: hash(99), stageActivationBlock: pinnedGenesis.deployment.blockNumber,
    stageActivationHash: pinnedGenesis.deployment.blockHash, factory: pinnedGenesis.factory,
    portfolioFactory: pinnedGenesis.portfolioFactory, operationalReady: false, manifest };
  let reads = 0, waits = 0;
  const fetcher = async () => new Response(JSON.stringify(reads++ === 0
    ? { ...baseGraph, readMode: 'verified_snapshot', stale: true, transactionReady: false,
      refreshing: true, snapshotAgeMs: 25_000 }
    : { ...baseGraph, operationalReady: true, readMode: 'current', stale: false, transactionReady: true }),
  { status: 200, headers: { 'content-type': 'application/json' } });
  const graph = await requireCurrentProductStage(secureConfig, fetcher, { wait: async () => { waits++; } });
  assert.equal(graph.readMode, 'current');
  assert.equal(reads, 2);
  assert.equal(waits, 1);
});
test('fixed Gas caps give simple market actions less reservation without running estimates',()=>{
  for(const kind of ['list','cancel','expire','withdrawBnb']) assert.equal(productGasLimit(kind,'market'),1_000_000n);
  assert.equal(productGasLimit('fill','market'),3_000_000n);
  assert.equal(productGasLimit('list','portfolioMarket'),1_000_000n);
  assert.equal(productGasLimit('fill','portfolioMarket'),3_000_000n);
  assert.equal(productGasLimit('deposit','pool'),5_000_000n);
  assert.equal(productGasLimit('withdrawBnb','pool'),5_000_000n);
});
const transaction=(name='deposit',args=[2],value='20',target=pool)=>({from:account,to:target,chainId:'0x38',
  data:(target===market?abi.ShareMarket:abi.PoolVault).encodeFunctionData(name,args),value});
function fixture(options={}){
  const state={record:null,revision:0,saved:null,authenticated:true,chain:'0x38',account,nonce:7n,pendingNonce:7n,
    balance:10n**25n,price:1000000000n,gas:100000n,hash:hash(7),final:true,resolution:'confirmed',...options};
  const calls=[];
  const provider={async request({method,params}){
    calls.push({method,params});
    if(method==='eth_chainId')return state.chain;
    if(method==='eth_accounts'||method==='eth_requestAccounts')return [state.account];
    if(method==='personal_sign')return `0x${'12'.repeat(65)}`;
    if(method==='eth_call')return '0x';
    if(method==='eth_getTransactionCount')return state.quantityNumbers?Number(params[1]==='pending'?state.pendingNonce:state.nonce):`0x${(params[1]==='pending'?state.pendingNonce:state.nonce).toString(16)}`;
    if(method==='eth_getBalance')return state.quantityNumbers?Number(state.balance):`0x${state.balance.toString(16)}`;
    if(method==='eth_getCode')return state.accountCode??'0x';
    if(method==='eth_gasPrice'){if(state.priceFail)throw new Error('gas price unavailable');return state.quantityNumbers?Number(state.price):`0x${state.price.toString(16)}`;}
    if(method==='eth_estimateGas')assert.fail('dynamic gas estimation is disabled for product submission');
    if(method==='eth_sendTransaction'){
      assert(state.record,'Server intent ACK must precede wallet send');
      if(state.rejectType2&&params[0].type==='0x2')throw new Error('Unsupported transaction type 0x2 (EIP-1559 envelope)');
      if(state.rejectWallet)throw Object.assign(new Error('rejected'),{code:4001});
      if(state.sendTimeout)throw new Error('wallet response lost');
      if(state.afterSend)state.afterSend(state);
      return state.hash;
    }
    assert.fail(`Unexpected wallet method ${method}`);
  }};
  const response=(status,body)=>({ok:status>=200&&status<300,status,json:async()=>body});
  const fetcher=async(url,init={})=>{
    const method=init.method||'GET',body=init.body?JSON.parse(init.body):undefined;
    calls.push({url,method,body});
    assert.equal(init.credentials,'same-origin');
    const path=url.replace('/api/journal/','');
    if(path==='session'&&method==='GET')return state.authenticated?response(200,{account:state.sessionAccount??account}):response(401,{error:'login required'});
    if(path==='challenge'){
      const nonce='A'.repeat(32);
      const message=`Pinkuang deployment journal login\nOrigin: ${state.challengeOrigin??config.origin}\nChain ID: 56\nAccount: ${account.toLowerCase()}\nNonce: ${nonce}\nExpires At: ${new Date(Date.now()+300000).toISOString()}`;
      return response(200,{nonce,message});
    }
    if(path==='session'&&method==='POST'){state.authenticated=true;return response(200,{account});}
    if(path==='market'&&method==='GET')return response(200,{record:state.record,revision:state.revision,
      legacyEnvelopeIssued:state.record?.version===2&&state.legacyUsed===true,
      canRequestLegacyEnvelope:state.rejectType2&&state.record?.version===2&&!state.record.hash&&!state.legacyUsed});
    if(path==='market/prepare-and-arm'&&method==='POST'){
      if(!state.fastAuthorization)return response(404,{error:'Unknown journal route.'});
      if(state.armFail)return response(409,{error:'Signature permission already consumed'});
      if(state.record||body.expectedRevision!==state.revision)return response(409,{error:'Revision changed'});
      state.record=structuredClone(body.record);state.revision+=2;
      if(state.afterAck)state.afterAck(state);
      const r=state.record;
      const transaction={from:r.account,to:r.target,chainId:'0x38',nonce:`0x${BigInt(r.nonce).toString(16)}`,
        data:r.data,value:`0x${BigInt(r.value).toString(16)}`,gas:`0x${BigInt(r.gas).toString(16)}`,
        maxFeePerGas:`0x${BigInt(r.gasPrice).toString(16)}`,
        maxPriorityFeePerGas:`0x${BigInt(r.gasPrice).toString(16)}`,type:'0x2',...state.permitTransaction};
      if(state.armAckLost)throw new Error('Signature permission ACK lost');
      return response(200,{revision:state.revision,record:structuredClone(r),transaction});
    }
    if(path==='market/arm'&&method==='POST'){
      if(state.armFail)return response(409,{error:'Signature permission already consumed'});
      if(!state.record||body.expectedRevision!==state.revision)return response(409,{error:'Revision changed'});
      const r=state.record;state.revision++;
      const transaction={from:r.account,to:r.target,chainId:'0x38',nonce:`0x${BigInt(r.nonce).toString(16)}`,
        data:r.data,value:`0x${BigInt(r.value).toString(16)}`,gas:`0x${BigInt(r.gas).toString(16)}`,
        maxFeePerGas:`0x${BigInt(r.gasPrice).toString(16)}`,
        maxPriorityFeePerGas:`0x${BigInt(r.gasPrice).toString(16)}`,type:'0x2',...state.permitTransaction};
      if(state.armAckLost)throw new Error('Signature permission ACK lost');
      return response(200,{revision:state.revision,record:structuredClone(r),transaction});
    }
    if(path==='market/cancel-intent'&&method==='POST'){
      if(state.cancelAckFail)return response(503,{error:'Cancellation ACK unavailable'});
      if(!state.record||body.expectedRevision!==state.revision)return response(409,{error:'Revision changed'});
      const fee=`0x${(state.price*120n/100n).toString(16)}`;
      const transaction={from:account,to:account,chainId:'0x38',nonce:`0x${state.record.nonce.toString(16)}`,data:'0x',value:'0x0',
        gas:'0x5208',...(state.record.version===2&&!state.legacyUsed?{maxFeePerGas:fee,maxPriorityFeePerGas:fee,type:'0x2'}
          :{gasPrice:fee,type:'0x0'}),...state.cancelTransaction};
      state.record={...state.record,cancellationRequests:[...(state.record.cancellationRequests??[]),{...transaction,createdAt:new Date().toISOString()}]};
      state.revision++;
      const result={record:structuredClone(state.record),revision:state.revision,transaction,
        ...(state.record.version===2?{legacyEnvelopeIssued:state.legacyUsed===true}:{})};
      if(state.afterCancelAck)state.afterCancelAck(state);
      if(state.cancelAckLost)throw new Error('Cancellation ACK lost');
      return response(200,result);
    }
    if(path==='market/legacy-envelope'&&method==='POST'){
      if(!state.record||body.expectedRevision!==state.revision||body.walletRejectedType2!==true||state.legacyUsed)
        return response(409,{error:'Legacy envelope unavailable'});
      const r=state.record;state.legacyUsed=true;state.revision++;
      const transaction={from:r.account,to:r.target,chainId:'0x38',nonce:`0x${BigInt(r.nonce).toString(16)}`,
        data:r.data,value:`0x${BigInt(r.value).toString(16)}`,gas:`0x${BigInt(r.gas).toString(16)}`,
        gasPrice:`0x${BigInt(r.gasPrice).toString(16)}`,type:'0x0',...state.legacyTransaction};
      return response(200,{revision:state.revision,record:structuredClone(r),transaction,legacyEnvelopeAuthorized:true});
    }
    if(path==='market'&&method==='PUT'){
      if(body.expectedRevision!==state.revision)return response(409,{error:'Revision changed'});
      if(!state.record&&state.ackFail)return response(503,{error:'Store unavailable'});
      if(state.record&&state.hashAckFail)throw new Error('Hash ACK lost');
      state.record=structuredClone(body.record);state.revision++;
      if(state.afterAck)state.afterAck(state);
      if(state.initialAckLost&&state.revision===1)throw new Error('Initial ACK lost');
      return response(200,{revision:state.revision});
    }
    if(path==='market'&&method==='DELETE'){
      if(!state.final)return response(409,{error:state.finalityMessage??'Not finalized'});
      const r=state.record;
      const result={action:r.action.kind,status:state.resolution,account,nonce:r.nonce,factory:r.factory,target:r.target??r.market,
        finalized:true,transactionHash:body.hash,receipt:{status:state.resolution==='reverted'?0:1,transactionHash:body.hash,
          to:state.resolution==='cancelled'?account:state.plainReplacementProof?addr(9):r.target??r.market,
          blockNumber:100,blockHash:hash(100)},
        ...(state.plainReplacementProof?{plainEoaReplacementVerified:true}:{})};
      if(result.status==='confirmed'&&r.action.kind==='deposit'&&!state.missingDeposit){
        const args=abi.PoolVault.decodeFunctionData('deposit',r.data);
        Object.assign(result,{poolAddress:pool,shares:args[0].toString(),amountWei:r.value});
      }
      state.saved=result;state.record=null;state.revision++;
      if(state.deleteAckLost)throw new Error('Delete ACK lost');
      return response(200,{revision:state.revision,result});
    }
    if(path.startsWith('market/result?'))return response(200,{result:state.saved});
    assert.fail(`Unexpected request ${method} ${url}`);
  };
  const send=(name='deposit',args=[2],value='20',target=pool,extra={})=>sendProductTransaction({provider,config,transaction:transaction(name,args,value,target),action:name,fetcher,...extra});
  return {state,provider,fetcher,calls,send};
}

test('connect and journal authentication are explicit; existing sessions do not prompt signatures',async()=>{
  const f=fixture();assert.equal(f.calls.length,0);
  assert.equal(await connectWallet(f.provider),account);
  assert.equal((await authenticate({provider:f.provider,account,config,fetcher:f.fetcher})).account,account);
  assert(!f.calls.some(x=>x.method==='personal_sign'));
  f.state.authenticated=false;
  await authenticate({provider:f.provider,account,config,fetcher:f.fetcher});
  assert.equal(f.calls.filter(x=>x.method==='personal_sign').length,1);
  assert(!f.calls.some(x=>x.method==='eth_sendTransaction'));
});

test('the full permitted 3 gwei quote reaches the wallet without a simulation or another RPC round',async()=>{
  const f=fixture({price:3_000_000_000n});
  const result=await f.send();
  assert.equal(result.status,'confirmed');
  const sends=f.calls.filter(call=>call.method==='eth_sendTransaction');
  assert.equal(sends.length,1);
  assert.equal(BigInt(sends[0].params[0].gas),5_000_000n);
  assert.equal(BigInt(sends[0].params[0].maxFeePerGas),3_000_000_000n);
  assert.equal(BigInt(sends[0].params[0].maxPriorityFeePerGas),3_000_000_000n);
  assert.equal(sends[0].params[0].type,'0x2');
  assert.equal(sends[0].params[0].gasPrice,undefined);
  assert(!f.calls.some(call=>['eth_call','eth_estimateGas'].includes(call.method)));

  const over=fixture({price:3_000_000_001n});
  await assert.rejects(over.send(),/Gas 费用超出/);
  assert(!over.calls.some(call=>call.method==='eth_sendTransaction'));
});

test('authentication refuses a foreign challenge before personal_sign',async()=>{
  const f=fixture({authenticated:false,challengeOrigin:'https://attacker.example'});
  await assert.rejects(authenticate({provider:f.provider,account,config,fetcher:f.fetcher}),/挑战/);
  assert(!f.calls.some(x=>x.method==='personal_sign'));
});

test('deposit uses exact integer payment, ACK before one wallet send, and verified event result only',async()=>{
  const f=fixture();const value='900719925474099312345';
  const result=await f.send('deposit',[2],value,pool,{onState(){throw new Error('Broken UI callback');}});
  assert.equal(result.status,'confirmed');assert.equal(result.finalized,true);
  assert.equal(result.poolAddress,pool);assert.equal(result.shares,'2');assert.equal(result.amountWei,value);
  assert.equal(result.transactionHash,hash(7));assert.equal(f.state.record,null);
  const sends=f.calls.filter(x=>x.method==='eth_sendTransaction');assert.equal(sends.length,1);
  assert.equal(BigInt(sends[0].params[0].value),BigInt(value));assert.equal(sends[0].params[0].nonce,'0x7');
  const ack=f.calls.findIndex(x=>x.url?.endsWith('/market')&&x.method==='PUT');
  assert(ack<f.calls.findIndex(x=>x.method==='eth_sendTransaction'));
  assert(!f.calls.some(x=>['personal_sign','eth_requestAccounts'].includes(x.method)));
});

test('fresh deposit survives a readiness recovery and opens the wallet once with the exact 50-share payment', async () => {
  const fresh = freshAuthorityBrowserFixture();
  const before = { ...fresh.graph(), operationalReady: false, transactionReady: false };
  const current = { ...fresh.graph(), operationalReady: true, transactionReady: true };
  const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  const boot = await loadFreshLiveConfig({ origin: config.origin, basePath: '/bemine-v4',
    manifestSha256: fresh.manifestSha,
    fetcher: url => response(url.includes('/data/') ? fresh.manifest : before) });
  const actionConfig = { ...boot, ...boot.manifest, journalBase: '/api/journal', walletSessionReady: false };
  const f = fixture({ fastAuthorization: true });
  const fetcher = (url, init) => url === boot.productGraphUrl ? response(current) : f.fetcher(url, init);
  const result = await f.send('deposit', [50], '55550000000000000', pool, { config: actionConfig, fetcher });
  assert.equal(result.status, 'confirmed');
  assert.equal(result.shares, '50');
  assert.equal(result.amountWei, '55550000000000000');
  assert.equal(f.calls.filter(call => call.method === 'eth_sendTransaction').length, 1);
  assert(!f.calls.some(call => ['eth_call', 'eth_estimateGas'].includes(call.method)));
});

test('wallet safe-number RPC quantities are accepted without changing the zero-value create-pool transaction',async()=>{
  const f=fixture({chain:56,quantityNumbers:true,balance:8000000000000000n});
  const data=abi.PoolFactory.encodeFunctionData('createPool',[{
    circuits:addr(5),circuitId:13043n,targetRaise:44000000000000000n,priceCap:40000000000000000n,
    directSeller:addr(0),directPrice:0n,fundingDeadline:2000000000n,purchaseDeadline:2000172800n,
  }]);
  const result=await sendProductTransaction({provider:f.provider,config,transaction:{from:account,to:factory,chainId:'0x38',data,value:'0x0'},
    action:'createPool',fetcher:f.fetcher});
  assert.equal(result.status,'confirmed');
  const sends=f.calls.filter(x=>x.method==='eth_sendTransaction');
  assert.equal(sends.length,1);assert.equal(sends[0].params[0].value,'0x0');
});

test('new runtime saves and arms once before a single wallet request',async()=>{
  const f=fixture({fastAuthorization:true});
  const result=await f.send();
  assert.equal(result.status,'confirmed');
  assert(!f.calls.some(x=>['eth_call','eth_estimateGas'].includes(x.method)),'submission does not simulate the transaction');
  const authorized=f.calls.filter(x=>x.url?.endsWith('/market/prepare-and-arm'));
  assert.equal(authorized.length,1);
  assert.equal(f.calls.filter(x=>x.url?.endsWith('/market/arm')).length,0);
  assert.equal(f.calls.filter(x=>x.url?.endsWith('/market')&&x.method==='PUT'&&!x.body.record.hash).length,0);
  assert( f.calls.indexOf(authorized[0]) < f.calls.findIndex(x=>x.method==='eth_sendTransaction'));
  assert.equal(f.calls.filter(x=>x.method==='eth_sendTransaction').length,1);
});

test('final wallet identity and both nonce checks overlap after the server permission',async()=>{
  const f=fixture({fastAuthorization:true}), original=f.provider.request.bind(f.provider), seen=new Set();
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const timer=setTimeout(release,1500);
  f.provider.request=async payload=>{
    if(f.state.record && ['eth_chainId','eth_accounts','eth_getTransactionCount'].includes(payload.method)){
      seen.add(payload.method==='eth_getTransactionCount'?`nonce-${payload.params[1]}`:payload.method);
      if(seen.size===4)release();
      await gate;
    }
    return original(payload);
  };
  try{
    assert.equal((await f.send()).status,'confirmed');
    assert.equal(seen.size,4);
  }finally{clearTimeout(timer);release();}
});

test('lost atomic signing ACK cannot prompt a second wallet send',async()=>{
  const f=fixture({fastAuthorization:true,armAckLost:true});
  await assert.rejects(f.send(),/Signature permission ACK lost/);
  assert(f.state.record);
  assert(!f.calls.some(x=>x.method==='eth_sendTransaction'));
  await assert.rejects(f.send(),/待核对/);
});

test('unsafe numeric wallet balance is rejected before an intent is written or a wallet is prompted',async()=>{
  const f=fixture({quantityNumbers:true,balance:10n**25n});
  await assert.rejects(f.send(),/钱包 BNB 余额不是精确的非负整数/);
  assert.equal(f.state.record,null);
  assert(!f.calls.some(x=>x.method==='eth_sendTransaction'));
});

test('without durable ACK, session, nonce, funds or gas-price checks no wallet send occurs',async()=>{
  for(const options of [{ackFail:true},{initialAckLost:true},{authenticated:false},{priceFail:true},{chain:'0x1'},
    {pendingNonce:8n},{balance:1n},{price:4000000000n}]){
    const f=fixture(options);await assert.rejects(f.send());
    assert(!f.calls.some(x=>x.method==='eth_sendTransaction'),JSON.stringify(options,(_k,v)=>typeof v==='bigint'?v.toString():v));
    if(options.initialAckLost)assert(f.state.record,'Lost ACK still leaves a durable intent');
  }
});

test('switching wallet or nonce after ACK retains intent and prevents signing',async()=>{
  for(const afterAck of [state=>{state.account=addr(9);},state=>{state.nonce=8n;state.pendingNonce=8n;}]){
    const f=fixture({afterAck});const result=await f.send();
    assert.equal(result.status,'pending');assert(f.state.record);assert(!f.calls.some(x=>x.method==='eth_sendTransaction'));
  }
});

test('wallet rejection, send timeout and hash ACK loss keep pending and never resend',async()=>{
  for(const options of [{rejectWallet:true},{sendTimeout:true},{hashAckFail:true}]){
    const f=fixture(options);const result=await f.send();assert.equal(result.status,'pending');assert(f.state.record);
    assert.equal(f.calls.filter(x=>x.method==='eth_sendTransaction').length,1);
    if(options.hashAckFail)assert.equal(result.hash,hash(7));
    await assert.rejects(f.send(),/待核对/);
    assert.equal(f.calls.filter(x=>x.method==='eth_sendTransaction').length,1);
  }
});

test('pending finality, replacement and revert do not produce share confirmations',async()=>{
  for(const options of [{final:false},{resolution:'reverted'},{resolution:'cancelled'},{resolution:'replaced'},{missingDeposit:true}]){
    const f=fixture(options);const result=await f.send();
    assert.notEqual(result.status,'confirmed');assert.equal(result.poolAddress,undefined);
    assert.equal(f.calls.filter(x=>x.method==='eth_sendTransaction').length,1);
  }
});

test('an old server success-labelled replacement cannot appear as a cleared product intent',async()=>{
  const f=fixture({resolution:'replaced'});
  const result=await f.send();
  assert.equal(result.status,'pending');
  assert.match(result.message,/可能已执行产品操作/);
  assert(result.record);
  assert.equal(f.calls.filter(call=>call.method==='eth_sendTransaction').length,1);
});
test('a successful unrelated replacement needs the server plain-EOA proof',async()=>{
  const f=fixture({resolution:'replaced',plainReplacementProof:true});
  const result=await f.send();
  assert.equal(result.status,'replaced');
  assert.equal(result.plainEoaReplacementVerified,true);
  assert.equal(f.state.record,null);
});

test('a rejected type-2 envelope offers one explicit, same-intent legacy attempt',async()=>{
  const f=fixture({fastAuthorization:true,rejectType2:true});
  const first=await f.send();
  assert.equal(first.status,'pending');
  assert.equal(first.legacyEnvelopeRejected,true);
  assert.equal(f.calls.filter(call=>call.method==='eth_sendTransaction').length,1);
  const second=await retryLegacyEnvelope({provider:f.provider,config,account,fetcher:f.fetcher});
  assert.equal(second.status,'confirmed');
  const sends=f.calls.filter(call=>call.method==='eth_sendTransaction');
  assert.equal(sends.length,2);
  assert.equal(sends[0].params[0].type,'0x2');
  assert.equal(sends[1].params[0].type,'0x0');
  assert.equal(sends[1].params[0].gasPrice,sends[0].params[0].maxFeePerGas);
  assert.equal(sends[1].params[0].nonce,sends[0].params[0].nonce);
  assert.equal(sends[1].params[0].data,sends[0].params[0].data);
  assert(f.calls.findIndex(call=>call.url?.endsWith('/legacy-envelope'))<f.calls.findLastIndex(call=>call.method==='eth_sendTransaction'));
  await assert.rejects(retryLegacyEnvelope({provider:f.provider,config,account,fetcher:f.fetcher}),/不能切换/);
});
test('legacy fallback never forwards altered server fields to the wallet',async()=>{
  const f=fixture({fastAuthorization:true,rejectType2:true});
  assert.equal((await f.send()).legacyEnvelopeRejected,true);
  f.state.legacyTransaction={to:addr(9)};
  const result=await retryLegacyEnvelope({provider:f.provider,config,account,fetcher:f.fetcher});
  assert.equal(result.status,'pending');
  assert.match(result.message,/兼容交易信封/);
  assert.equal(f.calls.filter(call=>call.method==='eth_sendTransaction').length,1);
});

test('recovery reads saved finalized result after lost DELETE ACK, never signing again',async()=>{
  const f=fixture({deleteAckLost:true});
  const result=await f.send();assert.equal(result.status,'confirmed');
  const before=f.calls.length;
  const recovered=await recoverPending({provider:f.provider,account,config,hash:hash(7),fetcher:f.fetcher});
  assert.equal(recovered.status,'confirmed');assert.equal(recovered.shares,'2');
  assert(!f.calls.slice(before).some(x=>['eth_sendTransaction','personal_sign','eth_requestAccounts'].includes(x.method)));
});

test('background finality recovery retains pending intent then confirms without wallet calls',async()=>{
  const message='Transaction is not finalized on the canonical chain.';
  const f=fixture({final:false,finalityMessage:message});
  const submitted=await f.send();
  assert.equal(submitted.status,'pending');
  assert.equal(submitted.message,message);
  const before=f.calls.length;
  const waiting=await recoverPending({account,config,hash:submitted.hash,fetcher:f.fetcher});
  assert.equal(waiting.status,'pending');
  assert.equal(waiting.hash,submitted.hash);
  assert(f.state.record);
  f.state.final=true;
  const confirmed=await recoverPending({account,config,hash:submitted.hash,fetcher:f.fetcher});
  assert.equal(confirmed.status,'confirmed');
  assert.equal(confirmed.finalized,true);
  assert.equal(f.state.record,null);
  assert(!f.calls.slice(before).some(x=>x.method.startsWith('eth_')||x.method==='personal_sign'));
  assert.equal(f.calls.filter(x=>x.method==='eth_sendTransaction').length,1);
});

test('all product actions and market actions use the same intent slot; arbitrary approvals are rejected',async()=>{
  for(const [name,args,value,target] of [['harvest',[],'0',pool],['claim',[],'0',pool],['withdrawBnb',[],'0',pool],
    ['withdrawDeposit',[],'0',pool],['finalizeFailure',[],'0',pool],['propose',[200,200,1],'0',pool],['vote',[1,true],'0',pool],
    ['executeSale',[1],'0',pool],['cancelExpired',[],'0',pool],['completeFirstoSale',[1,200,100,1],'202',pool],
    ['list',[pool,2,5],'0',market],['fill',[1,2],'10',market],['cancel',[1],'0',market],['expire',[1],'0',market],['withdrawBnb',[],'0',market]]){
    const f=fixture();const result=await f.send(name,args,value,target);assert.equal(result.status,'confirmed',name);
    const initial=f.calls.find(x=>x.method==='PUT').body.record;
    assert.equal(initial.targetType,target===pool?'pool':'market');assert.equal(initial.action.kind,name);
    assert.equal(initial.gas,productGasLimit(name,initial.targetType).toString());
  }
  const f=fixture();await assert.rejects(f.send('approve',[addr(9),1],'0'),/允许/);
  assert.equal(f.calls.length,0);
  await assert.rejects(f.send('deposit',[2],20),/精确整数/);
});

test('readPending is side-effect-free and an existing legacy journal blocks new product signatures',async()=>{
  const f=fixture({record:{version:1,chainId:56,account,factory,market,nonce:7,action:{kind:'withdraw'},data:'0x12345678',value:'0'}});
  assert.equal((await readPending({account,config,fetcher:f.fetcher})).record.version,1);
  await assert.rejects(f.send(),/待核对/);
  assert(!f.calls.some(x=>['eth_sendTransaction','personal_sign','eth_requestAccounts'].includes(x.method)));
});

const pendingRecord=(version=2)=>version===2?{version:2,chainId:56,account,factory,target:pool,targetType:'pool',nonce:7,
  action:{kind:'deposit'},data:transaction().data,value:'20',submittedAt:'2026-09-27T00:00:00Z',hash:hash(6)}
  :{version:1,chainId:56,account,factory,market,nonce:7,action:{kind:'withdraw'},
    data:abi.ShareMarket.encodeFunctionData('withdrawBnb'),value:'0',submittedAt:'2026-09-27T00:00:00Z',hash:hash(6)};
test('explicit nonce cancellation persists server ACK then sends one zero-value self-transfer for v1 and v2',async()=>{
  for(const {version,legacyUsed} of [{version:1,legacyUsed:false},{version:2,legacyUsed:false},{version:2,legacyUsed:true}]){
    const f=fixture({record:pendingRecord(version),resolution:'cancelled',pendingNonce:8n,legacyUsed});
    const states=[];
    const result=await cancelPendingNonce({provider:f.provider,account,config,fetcher:f.fetcher,onState:state=>states.push(state)});
    assert.equal(result.status,'cancelled');assert.equal(result.finalized,true);assert.equal(result.poolAddress,undefined);
    assert(!states.some(state=>state.status==='confirmed'));
    assert.equal(f.state.record,null);
    const sends=f.calls.filter(x=>x.method==='eth_sendTransaction');assert.equal(sends.length,1);
    const fee=`0x${1_200_000_000n.toString(16)}`;
    assert.deepEqual(sends[0].params[0],{from:account,to:account,chainId:'0x38',nonce:'0x7',data:'0x',value:'0x0',
      gas:'0x5208',...(version===2&&!legacyUsed?{maxFeePerGas:fee,maxPriorityFeePerGas:fee,type:'0x2'}
        :{gasPrice:fee,type:'0x0'})});
    assert(f.calls.findIndex(x=>x.url?.endsWith('/cancel-intent'))<f.calls.findIndex(x=>x.method==='eth_sendTransaction'));
    const saved=f.calls.find(x=>x.method==='PUT').body.record;
    assert.equal(saved.hash,hash(6));assert.deepEqual(saved.recoveryHashes,[hash(7)]);
    assert(!f.calls.some(x=>['personal_sign','eth_requestAccounts'].includes(x.method)));
  }
});

test('cancellation never signs without an ACK, exact own nonce, unchanged identity and journal, EOA or safe fee',async()=>{
  for(const options of [{cancelAckFail:true},{cancelAckLost:true},{cancelTransaction:{to:addr(9)}},{cancelTransaction:{value:'0x1'}},
    {cancelTransaction:{maxPriorityFeePerGas:'0x1'}},{cancelTransaction:{gasPrice:'0x1'}},
    {cancelTransaction:{nonce:'0x8'}},{afterCancelAck:state=>{state.nonce=8n;}},{afterCancelAck:state=>{state.pendingNonce=9n;}},
    {afterCancelAck:state=>{state.account=addr(9);}},{afterCancelAck:state=>{state.chain='0x1';}},
    {afterCancelAck:state=>{state.revision++;}},{accountCode:'0xef0100'},{balance:1n},{price:3_000_000_000n}]){
    const f=fixture({record:pendingRecord(),...options});
    const result=await cancelPendingNonce({provider:f.provider,account,config,fetcher:f.fetcher});
    assert.equal(result.status,'pending');assert(f.state.record);assert(!f.calls.some(x=>x.method==='eth_sendTransaction'));
  }
  const absent=fixture();
  await assert.rejects(cancelPendingNonce({provider:absent.provider,account,config,fetcher:absent.fetcher}),/没有/);
  assert(!absent.calls.some(x=>x.method==='eth_sendTransaction'));
});

test('cancel rejection and ambiguous outcome preserve the intent; recovery never resends or confirms a deposit',async()=>{
  for(const options of [{rejectWallet:true},{sendTimeout:true},{hashAckFail:true},{final:false},{resolution:'confirmed'},
    {afterSend:state=>{state.account=addr(9);}}]){
    const f=fixture({record:pendingRecord(),resolution:'cancelled',...options}),states=[];
    const result=await cancelPendingNonce({provider:f.provider,account,config,fetcher:f.fetcher,onState:state=>states.push(state)});
    assert.equal(result.status,'pending');assert.equal(result.poolAddress,undefined);assert(!states.some(state=>state.status==='confirmed'));
    assert.equal(f.calls.filter(x=>x.method==='eth_sendTransaction').length,1);
    if(!options.resolution)assert(f.state.record);
    if(options.afterSend)assert.deepEqual(f.state.record.recoveryHashes,[hash(7)]);
    const before=f.calls.length;
    await readPending({account,config,fetcher:f.fetcher});
    assert(!f.calls.slice(before).some(x=>x.method==='eth_sendTransaction'));
  }
});

test('missing, lost or modified single-use signing permission never opens the wallet', async()=>{
  for(const options of [{armFail:true},{armAckLost:true},{permitTransaction:{value:'0x100'}},
    {permitTransaction:{to:addr(90)}},{permitTransaction:{gas:'0x1'}},
    {permitTransaction:{gasPrice:'0x1'}}]){
    const f=fixture(options);const result=await f.send();assert.equal(result.status,'pending');
    assert(f.state.record);assert(!f.calls.some(x=>x.method==='eth_sendTransaction'));
  }
});

test('wallet metadata and journal reads share one round without transaction simulation', async () => {
  const f=fixture({fastAuthorization:true}), original=f.provider.request.bind(f.provider), seen=new Set();
  let release, armed=false, timedOut=false;
  const gate=new Promise(resolve=>{release=resolve;});
  const timer=setTimeout(()=>{timedOut=true;release();},1500);
  const enter=async name=>{seen.add(name);if(seen.size===8)release();await gate;};
  f.provider.request=async payload=>{
    const {method,params}=payload;
    if(!armed && ['eth_chainId','eth_accounts','eth_gasPrice','eth_getBalance','eth_getTransactionCount'].includes(method))
      await enter(method==='eth_getTransactionCount'?method+params[1]:method);
    return original(payload);
  };
  const fetcher=async(url,init)=>{
    if(!armed && init.method==='GET')await enter(url.endsWith('/session')?'session':'journal');
    if(url.endsWith('/market/prepare-and-arm')){
      assert.equal(seen.size,8,'all independent reads must start in one round');armed=true;
    }
    return f.fetcher(url,init);
  };
  try{
    assert.equal((await sendProductTransaction({provider:f.provider,config,transaction:transaction(),action:'deposit',fetcher})).status,'confirmed');
    assert(!f.calls.some(call=>['eth_call','eth_estimateGas'].includes(call.method)));
    assert.equal(f.calls.filter(call=>call.method==='eth_sendTransaction').length,1);
    assert.equal(seen.size,8);
    assert.equal(timedOut,false,'all eight reads must start before any read completes');
  }finally{clearTimeout(timer);release();}
});

test('failed parallel gas-price read drains reads and retains the wallet lane without signing',async()=>{
  const f=fixture({priceFail:true}), original=f.provider.request.bind(f.provider);
  let release, balanceStarted;
  const waiting=new Promise(resolve=>{release=resolve;}), started=new Promise(resolve=>{balanceStarted=resolve;});
  f.provider.request=async payload=>{
    if(payload.method==='eth_getBalance'){balanceStarted();await waiting;}
    return original(payload);
  };
  let settled=false;
  const send=f.send().then(()=>assert.fail('gas price must fail'),error=>{assert.match(error.message,/gas price/);settled=true;});
  const timer=setTimeout(release,1500);
  try{
    await started;
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(settled,false,'failure must wait for already-started reads');
    await assert.rejects(f.send(),/另一笔交易/);
    assert(!f.calls.some(x=>x.method==='PUT'||x.method==='eth_sendTransaction'));
  }finally{release();clearTimeout(timer);await send;}
});

test('a rejected chain read drains its concurrent account read before releasing the send lane',async()=>{
  const f=fixture(), original=f.provider.request.bind(f.provider);let release, accountsStarted;
  const waiting=new Promise(resolve=>{release=resolve;}), started=new Promise(resolve=>{accountsStarted=resolve;});
  f.provider.request=async payload=>{
    const {method}=payload;
    if(method==='eth_chainId')throw new Error('chain unavailable');
    if(method==='eth_accounts'){accountsStarted();await waiting;return [account];}
    return original(payload);
  };
  let settled=false;
  const send=f.send().then(()=>assert.fail('identity failure must reject'),error=>{assert.match(error.message,/chain unavailable/);settled=true;});
  const timer=setTimeout(release,1500);
  try{
    await started;await new Promise(resolve=>setImmediate(resolve));
    assert.equal(settled,false);
    await assert.rejects(f.send(),/另一笔交易/);
    assert(!f.calls.some(x=>x.method==='PUT'));
  }finally{release();clearTimeout(timer);await send;}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { Interface, Transaction, Wallet, ZeroAddress, getAddress, keccak256 } from 'ethers';
import { authorityRelayConfiguration, createAuthorityRelayService } from './authority-relay-api.mjs';
import { createDeploymentServer } from './index.mjs';
import { authorityTypedAction } from '../shared/authority-typed.mjs';
import { ORIGINAL_GAS_WALLET, requireOriginalSenderDrained } from '../shared/original-gas-wallet.mjs';
import { authorityOperationId, prepareAuthorityCall, runAuthorityRelay } from '../scripts/authority-relay.mjs';
import { readJournal, writeJournal } from '../scripts/purchase-keeper.mjs';

const address = n => getAddress(`0x${n.toString(16).padStart(40,'0')}`);
const hash = n => `0x${n.toString(16).padStart(64,'0')}`;
const sign = async (wallet,authority,kind,args,nonce,deadline) => {
  const typed=authorityTypedAction(authority,kind,args,nonce,deadline);
  return wallet.signTypedData(typed.domain,typed.types,typed.message);
};

function fixture({registered=true,relayHandler=null,lockJournal=null,lockWallet=null,authenticateAccount=null,singleAdmin=false,runtimeRpc=null,
  machineReadiness=null,stateRead=null,graphRead=null,useActualState=false}={}) {
  const directory = mkdtempSync(join(tmpdir(),'authority-relay-test-'));
  const admin = Wallet.createRandom(), gas = Wallet.createRandom();
  const authority = address(31), factory = address(32), budget = address(33), market = address(34), pool = address(35);
  const code = '0x6000', codehash = keccak256(code);
  const second = singleAdmin ? admin.address : address(36);
  const config = {origin:'https://example.test',rpcUrl:'https://example.test/rpc',journal:join(directory,'authority.json'),
    expectedGasWallet:gas.address,maxGasWei:10n**18n,maxGasPrice:3n*10n**9n,
    ...(machineReadiness ? { requireMachineReadiness: true } : {}),
    ...(runtimeRpc ? {rpcUrl:runtimeRpc.primary,readFallbackRpcUrl:runtimeRpc.backup} : {})};
  const params = '(address circuits,uint256 circuitId,uint256 targetRaise,uint256 priceCap,address directSeller,uint256 directPrice,uint64 fundingDeadline,uint64 purchaseDeadline)';
  const flexible = '(uint128 minVerifiedWeight,uint256 referencePriceWei,uint256 targetDailyYieldAtomic,uint16 extraBps,uint64 referenceObservedAt,uint64 referenceBlock,bytes32 referenceDigest)';
  const creationAbi = [`function createPool(${params} params)`,
    `function createPoolWithExpiry(${params} params,bool expiryEnabled)`,
    `function createBudgetChildPool(${params} params,address subscriber)`,
    `function createFlexiblePool(${params} params,${flexible} config)`,
    `function createFlexiblePoolChecked(${params} params,${flexible} config,uint32 expectedTaskId,uint128 expectedReferenceWeight)`,
    'function setDepositPaused(bool enabled)'];
  const trusted = {record:{addresses:{factory,portfolioFactory:budget,shareMarket:market}},
    bundle:{artifacts:{FreshPoolFactory:{abi:creationAbi},
      PlatformAuthority:{deployedBytecode:code,deployedLinkReferences:{},immutableReferences:{},abi:[
        'function coreFactory() view returns(address)', 'function budgetFactory() view returns(address)',
        'function administratorOne() view returns(address)', 'function administratorTwo() view returns(address)',
        'function gasWallet() view returns(address)']},
      BudgetPortfolioFactory:{abi:['function createPortfolio(uint256 budget,uint256 absoluteCap,uint256 unitCap,uint64 fundingEnd,uint64 purchaseEnd)']}}},
    freshAuthority:{authority:{address:authority,codehash,administratorOne:admin.address,
      administratorTwo:second,gasWallet:gas.address}}};
  const graph = {freshAuthority:{address:authority,codehash},freshFactoryVerified:true,
    addresses:trusted.record.addresses};
  const calls = [], errors = [];
  const roleState={first:admin.address,second,core:factory,budget,gasWallet:gas.address,code};
  const reservationAbi = new Interface(['function machinePool(address,uint256) view returns(address)']);
  const reservation = { pools: new Map(), calls: [], response: null };
  const reservationKey = (collection,id) => `${getAddress(collection).toLowerCase()}:${BigInt(id)}`;
  const provider = {send:async(method,params=[])=>{
    if(method==='eth_chainId')return '0x38';
    if(method==='eth_gasPrice')return '0x3b9aca00';
    if(method==='eth_call'){
      const [tx,blockTag]=params,decoded=reservationAbi.parseTransaction({data:tx.data});
      assert.equal(getAddress(tx.to),factory);
      assert.equal(decoded?.name,'machinePool');
      reservation.calls.push({collection:decoded.args[0],tokenId:decoded.args[1],blockTag});
      return reservation.response ?? reservationAbi.encodeFunctionResult('machinePool',[
        reservation.pools.get(reservationKey(decoded.args[0],decoded.args[1]))??ZeroAddress]);
    }
    throw new Error(`Unexpected RPC method ${method}`);
  },getNetwork:async()=>({chainId:56n}),getBlock:async()=>({number:1,hash:hash(1),
    timestamp:Math.floor(Date.now()/1000)}),destroy(){}};
  const store = {session:()=>admin.address.toLowerCase(),close(){}};
  const service = createAuthorityRelayService(config,{trusted,...(runtimeRpc ? {} : {provider}),store,onError:error=>errors.push(error),
    ...(authenticateAccount ? {authenticateAccount} : {}),
    verifyGraph:graphRead??(async()=>graph),loadCredential:()=>gas.privateKey,
    ...(machineReadiness ? { machineReadiness } : {}),
    readReclaimState:async target=>({registered:registered && target===pool,factory,
      mining:'0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46',minerKey:hash(333)}),
    ...(useActualState ? {} : { readAuthorityState:stateRead ? (...args)=>stateRead({...roleState,nonce:0n},...args)
      : async()=>({...roleState,nonce:0n}) }),
    lockJournal:lockJournal??(()=>()=>{}),lockWallet:lockWallet??(()=>()=>{}),
    relay:async (_provider,options,signer)=>{
      calls.push({options,signer:signer.address});
      if (relayHandler) return relayHandler(options,signer,_provider);
      return {status:'broadcast',hash:hash(9),kind:options.commandObject.kind};
    }});
  const request = (path,method,body,headers={}) => new Promise(resolve=>{
    const req = Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
    Object.assign(req,{url:path,method,headers:{cookie:`pinkuang_journal=${'a'.repeat(43)}`,
      'x-pinkuang-account':admin.address,origin:config.origin,
      'content-type':'application/json',...headers}});
    const res = {statusCode:200,setHeader(){},end(data){resolve({status:this.statusCode,body:JSON.parse(data)});}};
    service.handle(req,res);
  });
  return {admin,gas,authority,factory,budget,market,pool,codehash,service,request,calls,errors,config,provider,trusted,
    creationAbi,roleState,reservation,reservationKey,
    close:async()=>{await service.close();rmSync(directory,{recursive:true,force:true});}};
}

async function signedReview(f) {
  const args = {market:f.market,pool:f.pool,proposalId:'7',priceWei:'1000',approved:true};
  const nonce = '0', deadline = String(Math.floor(Date.now()/1000)+300);
  const signature = await sign(f.admin,f.authority,'reviewSale',args,nonce,deadline);
  return {authority:f.authority,expectedCodehash:f.codehash,kind:'reviewSale',args,nonce,deadline,signature};
}

async function installFinalizedFailure(f) {
  const command = await signedReview(f), prepared = prepareAuthorityCall(command);
  const raw = await f.gas.signTransaction({ type:0,chainId:56,to:f.authority,data:prepared.data,
    value:0n,nonce:17,gasLimit:650000n,gasPrice:1000000000n });
  const signed = Transaction.from(raw);
  const tx = { phase:'reverted',kind:command.kind,from:f.gas.address,to:f.authority,data:prepared.data,
    value:'0',nonce:17,hash:signed.hash,blockNumber:100,blockHash:hash(100),finality:'bsc-finalized',
    finalizedBlockNumber:110,finalizedBlockHash:hash(110),gasCostWei:'21000',speedUps:0,
    attempts:[{kind:'purchase',raw,hash:signed.hash,gasLimit:'650000',gasPrice:'1000000000',broadcastCount:1}] };
  const options = { factory:f.authority,pool:f.authority,transactionTarget:f.authority };
  const journal = {...readJournal(f.config.journal,options),transaction:tx,gasSpentWei:'21000',gasReceipts:{[tx.hash]:'21000'}};
  writeJournal(f.config.journal,journal);
  const state = {code:'0x6000',fee:21000n,nonce:18,blockHash:hash(100)}, reads=[], broadcasts=[];
  const getters = new Interface(['function coreFactory() view returns(address)','function budgetFactory() view returns(address)',
    'function gasWallet() view returns(address)','function administratorOne() view returns(address)',
    'function administratorTwo() view returns(address)','function nonces(address) view returns(uint256)']);
  const values = {coreFactory:f.factory,budgetFactory:f.budget,gasWallet:f.gas.address,
    administratorOne:f.admin.address,administratorTwo:address(36),nonces:0n};
  Object.assign(f.provider,{
    getNetwork:async()=>{reads.push('network');return {chainId:56n};},
    getBlock:async tag=>{reads.push(['block',tag]);return {number:tag==='latest'?115:tag==='finalized'?110:tag,
      hash:tag===100?state.blockHash:hash(tag==='latest'?115:tag==='finalized'?110:tag),
      gasLimit:30000000n,timestamp:Math.floor(Date.now()/1000)};},
    getCode:async()=>{reads.push('code');return state.code;},
    call:async transaction=>{const decoded=getters.parseTransaction(transaction);reads.push(['call',decoded.name]);
      return getters.encodeFunctionResult(decoded.name,[values[decoded.name]]);},
    getTransactionCount:async()=>{reads.push('nonce');return state.nonce;},
    getTransaction:async()=>{reads.push('transaction');return {hash:tx.hash,from:tx.from,to:tx.to,data:tx.data,nonce:tx.nonce,
      value:0n,chainId:56n,gasLimit:650000n,gasPrice:1000000000n,type:0,blockNumber:100,blockHash:hash(100)};},
    getTransactionReceipt:async()=>{reads.push('receipt');return {hash:tx.hash,from:tx.from,to:tx.to,
      blockNumber:100,blockHash:hash(100),status:0,fee:state.fee};},
    getFeeData:async()=>({gasPrice:1000000000n}),getBalance:async()=>10n**18n,
    estimateGas:async()=>assert.fail('No submission or recovery simulation'),
    broadcastTransaction:async bytes=>{broadcasts.push(bytes);return {hash:keccak256(bytes)};},
  });
  return {command,prepared,raw,tx,options,journal,state,reads,broadcasts,values};
}

test('background recovery archives one exact failure without credentials/signing and later polls make zero RPC reads',async()=>{
  const locks=[];
  const f=fixture({lockWallet:(...args)=>{locks.push(args);return ()=>{};}});
  try{
    const old=await installFinalizedFailure(f);
    delete f.trusted.freshAuthority.authority.codehash;
    const status=await f.service.reconcile();
    assert.equal(status.status,'failed');assert.equal(status.archived,true);assert.equal(status.recoveryRequired,false);
    assert.equal(status.operationId,authorityOperationId(f.authority,old.prepared.data));
    assert.deepEqual(locks[0][3],{existingJournalOnly:true});
    const saved=readJournal(f.config.journal,old.options);
    assert.equal(saved.transaction,null);assert.equal(saved.gasSpentWei,'21000');
    assert.equal(saved.reviewedAuthorityFailures[0].transaction.attempts[0].raw,old.raw);
    old.reads.length=0;
    assert.deepEqual(await f.service.reconcile(),status);assert.deepEqual(old.reads,[]);
    assert.equal(f.calls.length,0);assert.deepEqual(old.broadcasts,[]);
  }finally{await f.close();}
});

test('next explicitly signed POST archives finalized failure and accepts only its own newly durable transaction',async()=>{
  let active=false;
  const locks=[];
  const f=fixture({lockJournal:()=>{assert.equal(active,false);active=true;return()=>{active=false;};},
    lockWallet:(...args)=>{locks.push(args);return()=>{};},
    relayHandler:(options,signer,provider)=>runAuthorityRelay(provider,options,signer)});
  try{
    const old=await installFinalizedFailure(f);
    const command=await signedReview(f);command.args.priceWei='1001';
    command.signature=await sign(f.admin,f.authority,command.kind,command.args,command.nonce,command.deadline);
    const result=await f.request('/api/journal/authority-relay','POST',{command});
    assert.equal(result.status,200);assert.equal(result.body.status,'pending');assert.equal(result.body.accepted,true);
    const requestId=authorityOperationId(f.authority,prepareAuthorityCall(command).data);
    assert.equal(result.body.requestId,requestId);assert.equal(result.body.operationId,requestId);
    assert.notEqual(result.body.hash,old.tx.hash);assert.equal(result.body.previousFailure.hash,old.tx.hash);
    assert.equal(result.body.previousFailure.archived,true);assert.equal(result.body.previousFailure.status,'reverted');
    assert.equal(old.broadcasts.length,1);assert.deepEqual(locks[0][3],{existingJournalOnly:true});
    const saved=readJournal(f.config.journal,old.options);
    assert.equal(saved.transaction.nonce,18);assert.equal(saved.gasSpentWei,'21000');
    assert.equal(saved.reviewedAuthorityFailures[0].transaction.hash,old.tx.hash);
  }finally{await f.close();}
});

test('an unverified failure remains locked, repeated background polls back off, and explicit submit cannot resend it',async()=>{
  const f=fixture({relayHandler:(options,signer,provider)=>runAuthorityRelay(provider,options,signer)});
  try{
    const old=await installFinalizedFailure(f);old.state.fee=21001n;
    const first=await f.service.reconcile();
    assert.equal(first.status,'uncertain');assert.equal(first.recoveryRequired,true);assert.equal(first.archived,false);
    const count=old.reads.length;
    assert.deepEqual(await f.service.reconcile(),first);assert.equal(old.reads.length,count);
    const command=await signedReview(f);command.args.priceWei='1001';
    command.signature=await sign(f.admin,f.authority,command.kind,command.args,command.nonce,command.deadline);
    const result=await f.request('/api/journal/authority-relay','POST',{command});
    assert.equal(result.body.accepted,false);assert.equal(result.body.status,'failed');assert.equal(result.body.recoveryRequired,true);
    assert.equal(result.body.hash,old.tx.hash);assert.notEqual(result.body.operationId,result.body.requestId);
    assert.equal(f.calls.length,0);assert.deepEqual(old.broadcasts,[]);
    const saved=readJournal(f.config.journal,old.options);
    assert.equal(saved.transaction.hash,old.tx.hash);assert.equal(saved.reviewedAuthorityFailures,undefined);
  }finally{await f.close();}
});

test('an unrelated pending operation is not accepted as a newly signed request and no second nonce is sent',async()=>{
  const f=fixture({relayHandler:(options,signer,provider)=>runAuthorityRelay(provider,options,signer)});
  try{
    const old=await installFinalizedFailure(f);
    old.journal.transaction.phase='broadcast';delete old.journal.transaction.finality;
    writeJournal(f.config.journal,old.journal);
    f.provider.getTransactionReceipt=async()=>null;
    const command=await signedReview(f);command.args.priceWei='1001';
    command.signature=await sign(f.admin,f.authority,command.kind,command.args,command.nonce,command.deadline);
    const result=await f.request('/api/journal/authority-relay','POST',{command});
    assert.equal(result.status,200);assert.equal(result.body.accepted,false);
    assert.equal(result.body.hash,old.tx.hash);assert.notEqual(result.body.operationId,result.body.requestId);
    assert.deepEqual(old.broadcasts,[]);assert.equal(readJournal(f.config.journal,old.options).transaction.hash,old.tx.hash);
  }finally{await f.close();}
});

async function localRpcPair({backupChain='0x38',primaryResultError=false}={}) {
  const calls={primary:[],backup:[]}, servers=[];
  const block={number:'0x1',hash:hash(1),parentHash:hash(0),timestamp:'0x'+Math.floor(Date.now()/1000).toString(16),
    nonce:'0x0000000000000000',difficulty:'0x0',gasLimit:'0x1c9c380',gasUsed:'0x0',extraData:'0x',
    miner:address(0),transactions:[]};
  const url=async name=>{
    const server=createServer(async(req,res)=>{
      const buffers=[];for await(const value of req)buffers.push(value);
      const payload=JSON.parse(Buffer.concat(buffers).toString());
      const rows=Array.isArray(payload)?payload:[payload];calls[name].push(...rows.map(row=>row.method));
      if(name==='primary'&&!primaryResultError){res.writeHead(403,{'Content-Type':'text/html'});res.end('Forbidden');return;}
      if(rows.some(row=>row.method==='eth_sendRawTransaction')){res.writeHead(503,{'Content-Type':'text/html'});res.end('write unavailable');return;}
      const replies=rows.map(row=>name==='primary'?{jsonrpc:'2.0',id:row.id,error:{code:-32000,message:'execution reverted'}}
        :{jsonrpc:'2.0',id:row.id,result:row.method==='eth_chainId'?backupChain:row.method==='eth_getBlockByNumber'?block:null});
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(Array.isArray(payload)?replies:replies[0]));
    });
    servers.push(server);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  return {primary:await url('primary'),backup:await url('backup'),calls,
    close:async()=>{for(const server of servers){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}};
}

test('actual relay provider fixes its startup BSC backup after HTML403 and never reselects on submission failure',async()=>{
  const rpc=await localRpcPair();let f;
  try {
  f=fixture({runtimeRpc:rpc,relayHandler:async(_options,_signer,provider)=>{
    // A local mock rejects this inert byte string. No real RPC or signed transaction is used.
    await provider.send('eth_sendRawTransaction',['0x00']);assert.fail('A write failure must never be retried on another node.');
  }});
    const result=await f.request('/api/journal/authority-relay','POST',{command:await signedReview(f)});
    assert.equal(f.calls.length,1,'The verified read path reaches the existing serialized relay exactly once.');
    assert.equal(result.status,503,'An unknown submission outcome must still be reported honestly.');
    assert.equal(rpc.calls.backup.includes('eth_getBlockByNumber'), false,
      'mocked current state needs no repeated canonical block or graph read');
    assert(rpc.calls.backup.includes('eth_chainId'));
    assert.deepEqual(rpc.calls.primary,['eth_chainId'],'The original transport is never revisited after startup selection.');
    assert.equal(rpc.calls.backup.filter(method=>method==='eth_sendRawTransaction').length,1);
    assert.equal(result.body.error.includes(rpc.backup),false,'Public errors do not disclose the RPC destination.');
  } finally {await f?.close();await rpc.close();}
});

test('actual relay provider rejects a non-BSC backup before authority submission and does not fallback JSON-RPC errors',async()=>{
  for(const options of [{backupChain:'0x1'},{primaryResultError:true}]){
    const rpc=await localRpcPair(options);let f;
    try {
      f=fixture({runtimeRpc:rpc});
      const result=await f.request('/api/journal/authority-relay','POST',{command:await signedReview(f)});
      assert.equal(result.status,503);assert.equal(f.calls.length,0);
      if(options.backupChain==='0x1')assert.deepEqual(rpc.calls.backup,['eth_chainId']);
      else assert.equal(rpc.calls.backup.length,0,'Business errors are not transport failures.');
    } finally {await f?.close();await rpc.close();}
  }
});

test('private receipt reconciliation needs no browser session and stops when the relay closes',async()=>{
  const f=fixture({authenticateAccount:()=>{throw new Error('No browser is open');}});
  assert.equal((await f.service.reconcile()).status,'idle');
  await f.service.close();
  assert.equal(await f.service.reconcile(),null);
  await f.close();
});

test('Gas relay is disabled by default and requires a systemd credential when enabled',()=>{
  assert.equal(authorityRelayConfiguration({}),null);
  assert.throws(()=>authorityRelayConfiguration({AUTHORITY_RELAY_ENABLED:'1',AUTHORITY_REQUIRE_FRESH_READINESS:'1',
    DEPLOYMENT_JOURNAL_ORIGIN:'https://example.test',DEPLOYMENT_JOURNAL_RPC_URL:'https://example.test/rpc',
    KEEPER_PRIVATE_KEY:'0x'+'1'.repeat(64)}),/systemd Gas-wallet credential/);
});

test('the original Gas wallet requires an explicit drained-v2 sender gate',()=>{
  assert.throws(()=>requireOriginalSenderDrained(ORIGINAL_GAS_WALLET,{}),/drained and disabled v2 sender/);
  assert.doesNotThrow(()=>requireOriginalSenderDrained(ORIGINAL_GAS_WALLET,
    {BEMINE_V2_GAS_SENDER_DRAINED:'1'}));
  assert.doesNotThrow(()=>requireOriginalSenderDrained(address(98),{}));
});

test('status polling waits for an in-flight submit instead of colliding with its O_EXCL lock',async()=>{
  let locked=false, enter, finish;
  const entered=new Promise(resolve=>{enter=resolve;});
  const releaseRelay=new Promise(resolve=>{finish=resolve;});
  const f=fixture({
    lockJournal:()=>{
      if (locked) throw new Error('simultaneous filesystem lock');
      locked=true;
      return ()=>{locked=false;};
    },
    relayHandler:async options=>{
      enter();
      await releaseRelay;
      return {status:'broadcast',hash:hash(9),kind:options.commandObject.kind};
    },
  });
  try {
    const command=await signedReview(f);
    const submitting=f.request('/api/journal/authority-relay','POST',{command});
    await entered;
    const polling=f.request('/api/journal/authority-relay/status','GET');
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(locked,true);
    finish();
    assert.equal((await submitting).status,200);
    assert.equal((await polling).status,200);
    assert.equal(f.errors.length,0);
  } finally {await f.close();}
});

test('deployment server routes relay before the general journal handler',async()=>{
  let journalCalled=false;
  const server=createDeploymentServer({journalService:{handle(){journalCalled=true;}},
    authorityRelayService:{handle(_req,res){res.statusCode=200;res.end('{"status":"idle"}');}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/journal/authority-relay/status`);
    assert.deepEqual(await response.json(),{status:'idle'});
    assert.equal(journalCalled,false);
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('status exposes only the authenticated administrator journal summary',async()=>{
  const f=fixture();
  try {
    const result=await f.request('/api/journal/authority-relay/status','GET');
    assert.deepEqual(result,{status:200,body:{status:'idle',hash:null,kind:null,
      operationId:null,blockNumber:null,gasCostWei:null}});
    const switched=await f.request('/api/journal/authority-relay/status','GET',undefined,
      {'x-pinkuang-account':address(99)});
    assert.equal(switched.status,409);
  } finally {await f.close();}
});

test('signer rate limit is applied only after admin validation and is separate for both administrators',async()=>{
  let caller=Wallet.createRandom().address;
  const f=fixture({authenticateAccount:()=>caller});
  try{
    for(let count=0;count<35;count++)
      assert.equal((await f.request('/api/journal/authority-relay/status','GET')).status,403,
        'unrelated wallet assertions do not spend an administrator quota');
    caller=f.admin.address;
    for(let count=0;count<30;count++)
      assert.equal((await f.request('/api/journal/authority-relay/status','GET')).status,200);
    assert.equal((await f.request('/api/journal/authority-relay/status','GET')).status,429);
    caller=address(36);
    assert.equal((await f.request('/api/journal/authority-relay/status','GET')).status,200,
      'the second approved administrator remains able to reconcile status');
  }finally{await f.close();}
});

test('signer accepts a rotated on-chain administrator and rejects the retired one',async()=>{
  let caller;
  const f=fixture({authenticateAccount:()=>caller});
  const rotated=Wallet.createRandom();
  try {
    caller=f.admin.address;
    assert.equal((await f.request('/api/journal/authority-relay/status','GET')).status,200);
    f.roleState.first=rotated.address;
    assert.equal((await f.request('/api/journal/authority-relay','POST',{command:await signedReview(f)})).status,403,
      'current roles are authoritative on submission');
    caller=rotated.address;
    f.trusted.freshAuthority.authority.administratorOne=rotated.address;
    assert.equal((await f.request('/api/journal/authority-relay/status','GET')).status,200);
    const args={market:f.market,pool:f.pool,proposalId:'7',priceWei:'1000',approved:true};
    const deadline=String(Math.floor(Date.now()/1000)+300);
    const signature=await sign(rotated,f.authority,'reviewSale',args,'0',deadline);
    const command={authority:f.authority,expectedCodehash:f.codehash,kind:'reviewSale',
      args,nonce:'0',deadline,signature};
    assert.equal((await f.request('/api/journal/authority-relay','POST',{command})).status,200);
    assert.equal(f.calls.length,1);
    f.roleState.core=address(99);
    assert.equal((await f.request('/api/journal/authority-relay','POST',{command})).status,409,
      'submission cannot authorize a changed Authority binding');
  } finally {await f.close();}
});

test('idle status uses installed administrators and zero current-role or readiness RPC reads',async()=>{
  const f=fixture({stateRead:()=>assert.fail('status must not reread roles/nonce/code'),
    machineReadiness:()=>assert.fail('status must not scan readiness'),
    graphRead:()=>assert.fail('status must not scan the deployment graph')});
  try{
    f.provider.getNetwork=()=>assert.fail('idle status needs no RPC network lookup');
    f.provider.send=()=>assert.fail('idle status needs no RPC requests');
    f.provider.getBlock=()=>assert.fail('idle status needs no block reads');
    const reply=await f.request('/api/journal/authority-relay/status','GET');
    assert.equal(reply.status,200);assert.equal(reply.body.status,'idle');
    assert.equal(f.calls.length,0);
  }finally{await f.close();}
});

test('pending status reads only its existing transaction/receipt lane and never rereads Authority roles',async()=>{
  const f=fixture({stateRead:()=>assert.fail('pending status must not query Authority roles')});
  try{
    const old=await installFinalizedFailure(f);
    old.journal.transaction.phase='broadcast';delete old.journal.transaction.finality;
    old.state.nonce=17;writeJournal(f.config.journal,old.journal);
    f.provider.getTransactionReceipt=async()=>{old.reads.push('receipt');return null;};
    old.reads.length=0;
    const reply=await f.request('/api/journal/authority-relay/status','GET');
    assert.equal(reply.status,200);assert.equal(reply.body.status,'pending');
    assert.equal(reply.body.hash,old.tx.hash);
    assert.deepEqual(old.reads,['network','transaction','receipt','nonce','nonce']);
    assert.deepEqual(old.broadcasts,[]);assert.equal(f.calls.length,0);
  }finally{await f.close();}
});

test('only the signed admin session can relay exact EIP-712 calldata with bounded Gas and no estimate',async()=>{
  const f=fixture();
  try {
    const command=await signedReview(f);
    const sent=await f.request('/api/journal/authority-relay','POST',{command});
    assert.equal(sent.status,200,f.errors[0]?.message);
    assert.deepEqual({status:sent.body.status,hash:sent.body.hash,kind:sent.body.kind},
      {status:'pending',hash:hash(9),kind:'reviewSale'});
    assert.equal(f.calls.length,1);
    assert.equal(f.calls[0].options.gasLimit,650_000n);
    assert.equal(f.calls[0].signer,f.gas.address);
    assert.equal(f.calls[0].options.commandObject.signature,command.signature);
    const wrongSession=await f.request('/api/journal/authority-relay','POST',{command},
      {'x-pinkuang-account':address(99)});
    assert.equal(wrongSession.status,409);
    const crossOrigin=await f.request('/api/journal/authority-relay','POST',{command},{origin:'https://evil.test'});
    assert.equal(crossOrigin.status,403);
    const badHash=await f.request('/api/journal/authority-relay','POST',
      {command:{...command,expectedCodehash:hash(7)}});
    assert.equal(badHash.status,409);
    assert.equal(f.calls.length,1);
  } finally { await f.close(); }
});

test('unsigned mine and arbitrary admin operation cannot reach the Gas wallet',async()=>{
  const f=fixture();
  try {
    const unsigned=await f.request('/api/journal/authority-relay','POST',{command:{
      authority:f.authority,kind:'executeOperation',args:{target:f.pool,data:'0x1249c58b'},
    }});
    assert.equal(unsigned.status,400,f.errors[0]?.message);
    const command=await signedReview(f);
    const changed={...command,args:{...command.args,priceWei:'1'}};
    const result=await f.request('/api/journal/authority-relay','POST',{command:changed});
    assert.equal(result.status,403);
    assert.equal(f.calls.length,0);
  } finally { await f.close(); }
});

test('signed creation accepts only exact reviewed Factory selectors',async()=>{
  const f=fixture();
  try {
    const iface=new Interface(f.creationAbi);
    const params=[address(77),13043n,10n,10n,address(0),0n,
      BigInt(Math.floor(Date.now()/1000)+3600),BigInt(Math.floor(Date.now()/1000)+7200)];
    const data=iface.encodeFunctionData('createPool',[params]);
    const deadline=String(Math.floor(Date.now()/1000)+300);
    const signOperation=async (target,inner)=>sign(f.admin,f.authority,'executeApprovedOperation',
      {target,data:inner},'0',deadline);
    const command={authority:f.authority,expectedCodehash:f.codehash,kind:'executeApprovedOperation',
      args:{target:f.factory,data},nonce:'0',deadline,signature:await signOperation(f.factory,data)};
    assert.equal((await f.request('/api/journal/authority-relay','POST',{command})).body.status,'pending');
    assert.deepEqual(f.reservation.calls,[{collection:address(77),tokenId:13043n,blockTag:'latest'}]);
    const pause=iface.encodeFunctionData('setDepositPaused',[true]);
    const forbidden={...command,args:{target:f.factory,data:pause},signature:await signOperation(f.factory,pause)};
    const blocked=await f.request('/api/journal/authority-relay','POST',{command:forbidden});
    assert.equal(blocked.status,400);
    assert.equal(f.calls.length,1);
  } finally {await f.close();}
});

test('all five signed core creation selectors reject an occupied exact miner before relay or journal work',async()=>{
  const params=[address(77),7223n,10n,10n,ZeroAddress,0n,
    BigInt(Math.floor(Date.now()/1000)+3600),BigInt(Math.floor(Date.now()/1000)+7200)];
  const flexible=[1n,10n,100000000n,1000,BigInt(Math.floor(Date.now()/1000)-1),1n,hash(7)];
  const cases=[['createPool',[params]],['createPoolWithExpiry',[params,true]],
    ['createBudgetChildPool',[params,address(99)]],['createFlexiblePool',[params,flexible]],
    ['createFlexiblePoolChecked',[params,flexible,1,1]]];
  for(const [name,args] of cases){
    const f=fixture();
    try{
      f.reservation.pools.set(f.reservationKey(params[0],params[1]),f.pool);
      const data=new Interface(f.creationAbi).encodeFunctionData(name,args);
      const deadline=String(Math.floor(Date.now()/1000)+300),nonce='0';
      const signature=await sign(f.admin,f.authority,'executeApprovedOperation',
        {target:f.factory,data},nonce,deadline);
      const command={authority:f.authority,expectedCodehash:f.codehash,kind:'executeApprovedOperation',
        args:{target:f.factory,data},nonce,deadline,signature};
      const reply=await f.request('/api/journal/authority-relay','POST',{command});
      assert.equal(reply.status,409,`${name}: ${reply.body.error}`);
      assert.match(reply.body.error,/已有拼矿项目.*不能重复创建/);
      assert.equal(f.calls.length,0,`${name} must not enter the Gas relay`);
      assert.deepEqual(f.reservation.calls,[{collection:params[0],tokenId:params[1],blockTag:'latest'}]);
    }finally{await f.close();}
  }
});

test('core creation checks exact collection and ID while zero or other identity remains available',async()=>{
  const f=fixture();
  try{
    f.reservation.pools.set(f.reservationKey(address(77),7223n),f.pool);
    const iface=new Interface(f.creationAbi),deadline=String(Math.floor(Date.now()/1000)+300),nonce='0';
    const send=async(collection,tokenId)=>{
      const params=[collection,tokenId,10n,10n,ZeroAddress,0n,
        BigInt(Math.floor(Date.now()/1000)+3600),BigInt(Math.floor(Date.now()/1000)+7200)];
      const data=iface.encodeFunctionData('createPool',[params]);
      const signature=await sign(f.admin,f.authority,'executeApprovedOperation',
        {target:f.factory,data},nonce,deadline);
      return f.request('/api/journal/authority-relay','POST',{command:{authority:f.authority,
        expectedCodehash:f.codehash,kind:'executeApprovedOperation',args:{target:f.factory,data},
        nonce,deadline,signature}});
    };
    assert.equal((await send(address(77),7224n)).status,200);
    assert.equal((await send(address(78),7223n)).status,200);
    assert.equal(f.calls.length,2);
    assert.deepEqual(f.reservation.calls.map(({collection,tokenId})=>[collection,tokenId]),[
      [address(77),7224n],[address(78),7223n]]);
  }finally{await f.close();}
});

test('malformed or unavailable reservation proof fails closed before the Gas relay',async()=>{
  const f=fixture();
  try{
    f.reservation.response='0x';
    const params=[address(77),7223n,10n,10n,ZeroAddress,0n,
      BigInt(Math.floor(Date.now()/1000)+3600),BigInt(Math.floor(Date.now()/1000)+7200)];
    const data=new Interface(f.creationAbi).encodeFunctionData('createPool',[params]);
    const deadline=String(Math.floor(Date.now()/1000)+300),nonce='0';
    const signature=await sign(f.admin,f.authority,'executeApprovedOperation',
      {target:f.factory,data},nonce,deadline);
    const reply=await f.request('/api/journal/authority-relay','POST',{command:{authority:f.authority,
      expectedCodehash:f.codehash,kind:'executeApprovedOperation',args:{target:f.factory,data},
      nonce,deadline,signature}});
    assert.equal(reply.status,503);
    assert.equal(f.calls.length,0);
  }finally{await f.close();}
});

test('signed pool operation accepts only canonical reclaim for a current fresh miner',async()=>{
  const f=fixture();
  try {
    const outer=new Interface(['function mine(bytes data)']);
    const mining=new Interface(['function reclaim(bytes32 key)','function arm(address circuits,uint256 circuitId)']);
    const deadline=String(Math.floor(Date.now()/1000)+300);
    const signOperation=async data=>sign(f.admin,f.authority,'executeApprovedOperation',
      {target:f.pool,data},'0',deadline);
    const send=async (data,signedData=data)=>f.request('/api/journal/authority-relay','POST',{command:{
      authority:f.authority,expectedCodehash:f.codehash,kind:'executeApprovedOperation',
      args:{target:f.pool,data},nonce:'0',deadline,signature:await signOperation(signedData)}});
    const reclaim=outer.encodeFunctionData('mine',[mining.encodeFunctionData('reclaim',[hash(333)])]);
    assert.equal((await send(reclaim)).status,200,f.errors[0]?.message);
    assert.equal((await send(`${reclaim}00`,reclaim)).status,400);
    assert.equal((await send(outer.encodeFunctionData('mine',[
      mining.encodeFunctionData('reclaim',[hash(334)])]))).status,409);
    assert.equal((await send(outer.encodeFunctionData('mine',[
      mining.encodeFunctionData('arm',[address(77),1])]),reclaim)).status,400);
    assert.equal(f.calls.length,1);
  } finally {await f.close();}
  const unregistered=fixture({registered:false});
  try {
    const outer=new Interface(['function mine(bytes data)']);
    const reclaim=outer.encodeFunctionData('mine',[
      new Interface(['function reclaim(bytes32 key)']).encodeFunctionData('reclaim',[hash(333)])]);
    const deadline=String(Math.floor(Date.now()/1000)+300);
    const signature=await sign(unregistered.admin,unregistered.authority,'executeApprovedOperation',
      {target:unregistered.pool,data:reclaim},'0',deadline);
    const result=await unregistered.request('/api/journal/authority-relay','POST',{command:{
      authority:unregistered.authority,expectedCodehash:unregistered.codehash,kind:'executeApprovedOperation',
      args:{target:unregistered.pool,data:reclaim},nonce:'0',deadline,signature}});
    assert.equal(result.status,409);
    assert.equal(unregistered.calls.length,0);
  } finally {await unregistered.close();}
});

test('reviewed single administrator can read status and submit a signed action',async()=>{
  const f=fixture({singleAdmin:true});
  try {
    assert.equal((await f.request('/api/journal/authority-relay/status','GET')).status,200);
    const result=await f.request('/api/journal/authority-relay','POST',{command:await signedReview(f)});
    assert.equal(result.status,200,f.errors[0]?.message);
    assert.equal(f.calls.length,1);
    assert.equal(f.calls[0].signer,f.gas.address);
  } finally {await f.close();}
});

test('production-shaped activation without codehash rejects a browser hash that differs from vetted runtime',async()=>{
  let roleReads=0;
  const f=fixture({graphRead:()=>assert.fail('full graph must stay off submit'),
    stateRead:async state=>{roleReads++;return state;}});
  try{
    f.trusted.freshAuthority.authority={address:f.authority,deploymentTxHash:hash(700),
      administratorOne:f.admin.address,administratorTwo:address(36),gasWallet:f.gas.address};
    const command=await signedReview(f);command.expectedCodehash=hash(701);
    const result=await f.request('/api/journal/authority-relay','POST',{command});
    assert.equal(result.status,409);
    assert.match(result.body.error,/Authority identity differs/);
    assert.equal(roleReads,1);assert.equal(f.calls.length,0);
  }finally{await f.close();}
});

test('interactive submit has one role read, one parallel Gas group, no full proof or post-sign nonce reread',async t=>{
  const reads=[], broadcasts=[];
  let activeGas=0,peakGas=0,roleReads=0;
  const delay=async(label,value)=>{
    reads.push(label);activeGas++;peakGas=Math.max(peakGas,activeGas);
    await new Promise(resolve=>setTimeout(resolve,25));activeGas--;return value;
  };
  const f=fixture({
    machineReadiness:()=>assert.fail('worker/historical readiness must stay off submit'),
    graphRead:()=>assert.fail('full graph must stay off submit'),
    stateRead:async state=>{roleReads++;await new Promise(resolve=>setTimeout(resolve,25));return state;},
    relayHandler:(options,signer,provider)=>runAuthorityRelay(provider,options,signer),
  });
  try{
    // Production activation records save the deployment transaction and roles,
    // but have no codehash. Actual vetted runtime still authorizes this send.
    f.trusted.freshAuthority.authority={address:f.authority,deploymentTxHash:hash(700),
      administratorOne:f.admin.address,administratorTwo:address(36),gasWallet:f.gas.address};
    const originalSend=f.provider.send;
    Object.assign(f.provider,{
      send:async(method,params)=>method==='eth_gasPrice'
        ? delay('gasPrice','0x3b9aca00') : originalSend(method,params),
      getBlock:async()=>delay('gasBlock',{number:1,hash:hash(1),gasLimit:30000000n,
        timestamp:Math.floor(Date.now()/1000)}),
      getBalance:async()=>delay('balance',10n**18n),
      getTransactionCount:async(_wallet,tag)=>delay(`nonce:${tag}`,0),
      getCode:()=>assert.fail('code was already read in current Authority state'),
      getFeeData:()=>assert.fail('fee history is unnecessary for the legacy Gas transaction'),
      estimateGas:()=>assert.fail('submission never simulates'),
      broadcastTransaction:async raw=>{
        broadcasts.push(raw);
        const journal=readJournal(f.config.journal,{factory:f.authority,pool:f.authority,transactionTarget:f.authority});
        assert.equal(journal.transaction.phase,'signed');
        assert.equal(journal.transaction.attempts[0].raw,raw);
        assert.equal(journal.transaction.attempts[0].broadcastCount,1);
        return {hash:keccak256(raw)};
      },
    });
    const stamp=performance.now();
    const result=await f.request('/api/journal/authority-relay','POST',{command:await signedReview(f)});
    const elapsed=performance.now()-stamp;
    assert.equal(result.status,200,f.errors[0]?.message);
    assert.equal(result.body.accepted,true);assert.equal(broadcasts.length,1);
    assert.equal(roleReads,1);assert.equal(peakGas,5);
    assert.deepEqual(reads,['gasPrice','balance','nonce:latest','nonce:pending','gasBlock']);
    assert.equal(f.calls[0].options.fastSubmission,true);
    t.diagnostic(`fixture: one 25ms current-Authority group + five concurrent 25ms Gas reads; elapsed ${elapsed.toFixed(1)}ms including local signature`);
  }finally{await f.close();}
});

test('real JSON-RPC transport submits in two concurrent read groups instead of serialized repeated proofs',async t=>{
  let f,active=0,peak=0;
  const calls=[],groups=[];
  const getters=new Interface([
    'function coreFactory() view returns(address)','function budgetFactory() view returns(address)',
    'function administratorOne() view returns(address)','function administratorTwo() view returns(address)',
    'function gasWallet() view returns(address)','function nonces(address) view returns(uint256)',
  ]);
  const block={number:'0x1',hash:hash(1),parentHash:hash(0),timestamp:'0x'+Math.floor(Date.now()/1000).toString(16),
    nonce:'0x0000000000000000',difficulty:'0x0',gasLimit:'0x1c9c380',gasUsed:'0x0',extraData:'0x',
    miner:address(0),transactions:[]};
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const part of req)chunks.push(part);
    const row=JSON.parse(Buffer.concat(chunks).toString());
    let label=row.method,value;
    if(row.method==='eth_chainId')value='0x38';
    else if(row.method==='eth_call'){
      const decoded=getters.parseTransaction(row.params[0]);label=`role:${decoded.name}`;
      const values={coreFactory:f.factory,budgetFactory:f.budget,administratorOne:f.admin.address,
        administratorTwo:address(36),gasWallet:f.gas.address,nonces:0n};
      value=getters.encodeFunctionResult(decoded.name,[values[decoded.name]]);
    }else if(row.method==='eth_getCode')value='0x6000';
    else if(row.method==='eth_gasPrice')value='0x3b9aca00';
    else if(row.method==='eth_getBalance')value='0xde0b6b3a7640000';
    else if(row.method==='eth_getTransactionCount'){label=`gasNonce:${row.params[1]}`;value='0x0';}
    else if(row.method==='eth_getBlockByNumber')value=block;
    else if(row.method==='eth_blockNumber')value='0x1';
    else if(row.method==='eth_sendRawTransaction'){
      const saved=readJournal(f.config.journal,{factory:f.authority,pool:f.authority,transactionTarget:f.authority});
      assert.equal(saved.transaction.attempts[0].raw,row.params[0]);
      assert.equal(saved.transaction.attempts[0].broadcastCount,1);
      value=keccak256(row.params[0]);
    }else assert.fail(`Unexpected read on interactive path: ${row.method}`);
    calls.push(label);
    if(row.method!=='eth_chainId'){
      active++;peak=Math.max(peak,active);groups.push({label,active});
      await new Promise(resolve=>setTimeout(resolve,25));active--;
    }
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({jsonrpc:'2.0',id:row.id,result:value}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const primary=`http://127.0.0.1:${server.address().port}`;
  f=fixture({runtimeRpc:{primary,backup:primary},useActualState:true,
    machineReadiness:()=>assert.fail('readiness must not run before broadcast'),
    graphRead:()=>assert.fail('full graph must not run before broadcast'),
    relayHandler:(options,signer,provider)=>runAuthorityRelay(provider,options,signer)});
  try{
    delete f.trusted.freshAuthority.authority.codehash;
    const stamp=performance.now();
    const result=await f.request('/api/journal/authority-relay','POST',{command:await signedReview(f)});
    assert.equal(result.status,200,f.errors[0]?.message);assert.equal(result.body.accepted,true);
    const expected=['role:coreFactory','role:budgetFactory','role:administratorOne','role:administratorTwo',
      'role:gasWallet','role:nonces','eth_getCode','eth_gasPrice','eth_getBalance','gasNonce:latest',
      'gasNonce:pending','eth_getBlockByNumber','eth_blockNumber','eth_sendRawTransaction'];
    assert.deepEqual(calls.filter(label=>label!=='eth_chainId').sort(),expected.sort());
    assert.equal(peak,7,'all seven current-Authority reads really overlap on HTTP');
    assert.equal(calls.filter(label=>label==='eth_chainId').length,1,'one startup identity, no pre/post send repeats');
    assert.equal(calls.filter(label=>label==='eth_sendRawTransaction').length,1);
    t.diagnostic(`actual mock RPC: 7 concurrent current-role/code reads + 5 concurrent Gas reads + Ethers blockNumber/send group; ${
      (performance.now()-stamp).toFixed(1)}ms at 25ms/request, ${calls.length} total RPC requests including startup`);
  }finally{await f.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

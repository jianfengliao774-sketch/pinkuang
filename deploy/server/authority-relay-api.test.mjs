import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { Interface, Wallet, getAddress, keccak256 } from 'ethers';
import { authorityRelayConfiguration, createAuthorityRelayService } from './authority-relay-api.mjs';
import { createDeploymentServer } from './index.mjs';
import { authorityTypedAction } from '../shared/authority-typed.mjs';
import { ORIGINAL_GAS_WALLET, requireOriginalSenderDrained } from '../shared/original-gas-wallet.mjs';

const address = n => getAddress(`0x${n.toString(16).padStart(40,'0')}`);
const hash = n => `0x${n.toString(16).padStart(64,'0')}`;
const sign = async (wallet,authority,kind,args,nonce,deadline) => {
  const typed=authorityTypedAction(authority,kind,args,nonce,deadline);
  return wallet.signTypedData(typed.domain,typed.types,typed.message);
};

function fixture({registered=true,relayHandler=null,lockJournal=null,authenticateAccount=null,singleAdmin=false,runtimeRpc=null}={}) {
  const directory = mkdtempSync(join(tmpdir(),'authority-relay-test-'));
  const admin = Wallet.createRandom(), gas = Wallet.createRandom();
  const authority = address(31), factory = address(32), budget = address(33), market = address(34), pool = address(35);
  const code = '0x6000', codehash = keccak256(code);
  const second = singleAdmin ? admin.address : address(36);
  const config = {origin:'https://example.test',rpcUrl:'https://example.test/rpc',journal:join(directory,'authority.json'),
    expectedGasWallet:gas.address,maxGasWei:10n**18n,maxGasPrice:3n*10n**9n,
    ...(runtimeRpc ? {rpcUrl:runtimeRpc.primary,readFallbackRpcUrl:runtimeRpc.backup} : {})};
  const creationAbi = ['function createPool((address circuits,uint256 circuitId,uint256 targetRaise,uint256 priceCap,address directSeller,uint256 directPrice,uint64 fundingDeadline,uint64 purchaseDeadline) params)',
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
  const provider = {send:async()=> '0x38',getBlock:async()=>({number:1,hash:hash(1),
    timestamp:Math.floor(Date.now()/1000)}),destroy(){}};
  const store = {session:()=>admin.address.toLowerCase(),close(){}};
  const service = createAuthorityRelayService(config,{trusted,...(runtimeRpc ? {} : {provider}),store,onError:error=>errors.push(error),
    ...(authenticateAccount ? {authenticateAccount} : {}),
    verifyGraph:async()=>graph,loadCredential:()=>gas.privateKey,
    readReclaimState:async target=>({registered:registered && target===pool,factory,
      mining:'0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46',minerKey:hash(333)}),
    readAuthorityState:async()=>({...roleState,nonce:0n}),
    lockJournal:lockJournal??(()=>()=>{}),lockWallet:()=>()=>{},
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
  return {admin,gas,authority,factory,budget,market,pool,codehash,service,request,calls,errors,
    creationAbi,roleState,
    close:async()=>{await service.close();rmSync(directory,{recursive:true,force:true});}};
}

async function signedReview(f) {
  const args = {market:f.market,pool:f.pool,proposalId:'7',priceWei:'1000',approved:true};
  const nonce = '0', deadline = String(Math.floor(Date.now()/1000)+300);
  const signature = await sign(f.admin,f.authority,'reviewSale',args,nonce,deadline);
  return {authority:f.authority,expectedCodehash:f.codehash,kind:'reviewSale',args,nonce,deadline,signature};
}

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
    assert(rpc.calls.backup.includes('eth_getBlockByNumber'));
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
      blockNumber:null,gasCostWei:null}});
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
    assert.equal((await f.request('/api/journal/authority-relay/status','GET')).status,403);
    caller=rotated.address;
    assert.equal((await f.request('/api/journal/authority-relay/status','GET')).status,200);
    const args={market:f.market,pool:f.pool,proposalId:'7',priceWei:'1000',approved:true};
    const deadline=String(Math.floor(Date.now()/1000)+300);
    const signature=await sign(rotated,f.authority,'reviewSale',args,'0',deadline);
    const command={authority:f.authority,expectedCodehash:f.codehash,kind:'reviewSale',
      args,nonce:'0',deadline,signature};
    assert.equal((await f.request('/api/journal/authority-relay','POST',{command})).status,200);
    assert.equal(f.calls.length,1);
    f.roleState.core=address(99);
    assert.equal((await f.request('/api/journal/authority-relay/status','GET')).status,409,
      'a role read alone cannot authorize a changed Authority binding');
  } finally {await f.close();}
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
    const pause=iface.encodeFunctionData('setDepositPaused',[true]);
    const forbidden={...command,args:{target:f.factory,data:pause},signature:await signOperation(f.factory,pause)};
    const blocked=await f.request('/api/journal/authority-relay','POST',{command:forbidden});
    assert.equal(blocked.status,400);
    assert.equal(f.calls.length,1);
  } finally {await f.close();}
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

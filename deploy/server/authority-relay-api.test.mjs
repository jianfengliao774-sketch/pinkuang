import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Interface, Wallet, getAddress, keccak256 } from 'ethers';
import { authorityRelayConfiguration, createAuthorityRelayService } from './authority-relay-api.mjs';
import { createDeploymentServer } from './index.mjs';
import { authorityTypedAction } from '../shared/authority-typed.mjs';

const address = n => getAddress(`0x${n.toString(16).padStart(40,'0')}`);
const hash = n => `0x${n.toString(16).padStart(64,'0')}`;
const sign = async (wallet,authority,kind,args,nonce,deadline) => {
  const typed=authorityTypedAction(authority,kind,args,nonce,deadline);
  return wallet.signTypedData(typed.domain,typed.types,typed.message);
};

function fixture({registered=true,relayHandler=null,lockJournal=null}={}) {
  const directory = mkdtempSync(join(tmpdir(),'authority-relay-test-'));
  const admin = Wallet.createRandom(), gas = Wallet.createRandom();
  const authority = address(31), factory = address(32), budget = address(33), market = address(34), pool = address(35);
  const code = '0x6000', codehash = keccak256(code);
  const config = {origin:'https://example.test',rpcUrl:'https://example.test/rpc',journal:join(directory,'authority.json'),
    expectedGasWallet:gas.address,maxGasWei:10n**18n,maxGasPrice:3n*10n**9n};
  const creationAbi = ['function createPool((address circuits,uint256 circuitId,uint256 targetRaise,uint256 priceCap,address directSeller,uint256 directPrice,uint64 fundingDeadline,uint64 purchaseDeadline) params)',
    'function setDepositPaused(bool enabled)'];
  const trusted = {record:{addresses:{factory,portfolioFactory:budget,shareMarket:market}},
    bundle:{artifacts:{FreshPoolFactory:{abi:creationAbi},
      BudgetPortfolioFactory:{abi:['function createPortfolio(uint256 budget,uint256 absoluteCap,uint256 unitCap,uint64 fundingEnd,uint64 purchaseEnd)']}}},
    freshAuthority:{authority:{address:authority,codehash,administratorOne:admin.address,
      administratorTwo:address(36),gasWallet:gas.address}}};
  const graph = {freshAuthority:{address:authority,codehash},freshFactoryVerified:true,
    addresses:trusted.record.addresses};
  const calls = [], errors = [];
  const provider = {send:async()=> '0x38',getBlock:async()=>({number:1,hash:hash(1),
    timestamp:Math.floor(Date.now()/1000)}),destroy(){}};
  const store = {session:()=>admin.address.toLowerCase(),close(){}};
  const service = createAuthorityRelayService(config,{trusted,provider,store,onError:error=>errors.push(error),
    verifyGraph:async()=>graph,loadCredential:()=>gas.privateKey,
    readReclaimState:async target=>({registered:registered && target===pool,factory,
      mining:'0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46',minerKey:hash(333)}),
    readAuthorityState:async()=>({core:factory,budget,first:admin.address,second:address(36),
      gasWallet:gas.address,nonce:0n,code}),
    lockJournal:lockJournal??(()=>()=>{}),lockWallet:()=>()=>{},
    relay:async (_provider,options,signer)=>{
      calls.push({options,signer:signer.address});
      if (relayHandler) return relayHandler(options,signer);
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
  return {admin,gas,authority,factory,budget,market,pool,codehash,service,request,calls,errors,creationAbi,
    close:async()=>{await service.close();rmSync(directory,{recursive:true,force:true});}};
}

async function signedReview(f) {
  const args = {market:f.market,pool:f.pool,proposalId:'7',priceWei:'1000',approved:true};
  const nonce = '0', deadline = String(Math.floor(Date.now()/1000)+300);
  const signature = await sign(f.admin,f.authority,'reviewSale',args,nonce,deadline);
  return {authority:f.authority,expectedCodehash:f.codehash,kind:'reviewSale',args,nonce,deadline,signature};
}

test('Gas relay is disabled by default and requires a systemd credential when enabled',()=>{
  assert.equal(authorityRelayConfiguration({}),null);
  assert.throws(()=>authorityRelayConfiguration({AUTHORITY_RELAY_ENABLED:'1',
    DEPLOYMENT_JOURNAL_ORIGIN:'https://example.test',DEPLOYMENT_JOURNAL_RPC_URL:'https://example.test/rpc',
    KEEPER_PRIVATE_KEY:'0x'+'1'.repeat(64)}),/systemd Gas-wallet credential/);
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

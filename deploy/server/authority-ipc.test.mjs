import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface, Wallet } from 'ethers';
import { authorityIpcConfiguration, createAuthorityAssertionVerifier, createAuthorityRelayProxy,
  createAuthorityRolePrefilter, createAuthoritySignerServer, createGasSignerProofReader, listenAuthoritySigner,
  signAuthorityAssertion } from './authority-ipc.mjs';
import { startAuthoritySigner } from './authority-signer.mjs';
import { verifyGasSignerAttestation } from '../shared/gas-signer-attestation.mjs';
import { FRESH_ADMIN_ONE, FRESH_ADMIN_TWO } from './fresh-activation-journal.mjs';
import { verifyCurrentAuthorityAdministrator } from './authority-role.mjs';

const origin='https://example.test';
const token='a'.repeat(43);

test('independent signer cannot start without explicit activation',async()=>{
  await assert.rejects(startAuthoritySigner({}),/disabled/);
  await assert.rejects(startAuthoritySigner({AUTHORITY_RELAY_ENABLED:'1',
    AUTHORITY_RELAY_SOCKET:'/tmp/unreviewed.sock'}),/unreviewed socket/);
});

test('public relay configuration rejects a Gas credential and any unreviewed IPC target',()=>{
  const root=mkdtempSync(join(tmpdir(),'authority-ipc-credentials-'));
  const env={AUTHORITY_RELAY_SOCKET:'/run/pinkuang-v4-relay/authority.sock',
    AUTHORITY_RELAY_ENABLED:'0',DEPLOYMENT_JOURNAL_ORIGIN:origin,
    DEPLOYMENT_JOURNAL_DB:join(root,'sessions.sqlite'),CREDENTIALS_DIRECTORY:root,
    DEPLOYMENT_JOURNAL_RPC_URL:'https://example.test/rpc',
    BEMINE_EXPECTED_GAS_WALLET:Wallet.createRandom().address,
    BEMINE_DEPLOYMENT_RECORD_PATH:join(root,'record.json'),
    BEMINE_PRODUCT_GENESIS_ARTIFACT_PATH:join(root,'bundle.json'),
    BEMINE_PRODUCT_ACTIVATION_PATH:join(root,'activation.json'),
    BEMINE_SALE_POLICY_CATALOG_PATH:join(root,'sale-policy-catalog.json'),
    BEMINE_SALE_POLICY_ARTIFACT_PATH:join(root,'sale-policy-artifacts.json'),
    BEMINE_NATIVE_SALE_CATALOG_PATH:join(root,'native-sale-catalog.json'),
    BEMINE_NATIVE_SALE_ARTIFACT_PATH:join(root,'native-sale-artifacts.json')};
  try {
    writeFileSync(join(root,'authority-ipc-hmac'),randomBytes(32));
    assert.equal(authorityIpcConfiguration(env).key.length,32);
    const configured=authorityIpcConfiguration(env);
    assert.equal(configured.salePolicyCatalogPath,env.BEMINE_SALE_POLICY_CATALOG_PATH);
    assert.equal(configured.salePolicyArtifactPath,env.BEMINE_SALE_POLICY_ARTIFACT_PATH);
    assert.equal(configured.nativeSaleCatalogPath,env.BEMINE_NATIVE_SALE_CATALOG_PATH);
    assert.equal(configured.nativeSaleArtifactPath,env.BEMINE_NATIVE_SALE_ARTIFACT_PATH);
    const attestOnly={...env,AUTHORITY_RELAY_PUBLIC_ENABLED:'0'};
    for(const name of ['BEMINE_DEPLOYMENT_RECORD_PATH','BEMINE_PRODUCT_GENESIS_ARTIFACT_PATH',
      'BEMINE_PRODUCT_ACTIVATION_PATH']) delete attestOnly[name];
    assert.equal(authorityIpcConfiguration(attestOnly).key.length,32,
      'the Gas proof does not depend on unactivated product graph files');
    assert.throws(()=>authorityIpcConfiguration({...attestOnly,AUTHORITY_RELAY_PUBLIC_ENABLED:'1'}),
      /graph evidence before relay/);
    assert.throws(()=>authorityIpcConfiguration({...env,AUTHORITY_RELAY_SOCKET:'/tmp/evil.sock'}),
      /reviewed local relay socket/);
    writeFileSync(join(root,'keeper-private-key'),'secret');
    assert.throws(()=>authorityIpcConfiguration(env),/must not receive a Gas private key/);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('public Authority proxy forwards complete policy and native evidence and rejects invalid configuration before RPC',()=>{
  const paths={salePolicyCatalogPath:'/srv/reviewed/sale-policy-catalog.json',
    salePolicyArtifactPath:'/srv/reviewed/sale-policy-artifacts.json',
    nativeSaleCatalogPath:'/srv/reviewed/native-sale-catalog.json',
    nativeSaleArtifactPath:'/srv/reviewed/native-sale-artifacts.json'};
  let captured;
  assert.throws(()=>createAuthorityRelayProxy({socketPath:'/run/pinkuang-v4-relay/authority.sock',
    origin,key:randomBytes(32),...paths},{store:{close(){}},configuration(input){
      captured=input;throw new Error('Reviewed native-sale configuration rejected.');
    }}),/Reviewed native-sale configuration rejected/);
  assert.deepEqual(Object.fromEntries(Object.keys(paths).map(key=>[key,captured[key]])),paths);
});

test('authority assertion binds exact method, path, body, account, time and single use',()=>{
  const key=randomBytes(32), account=Wallet.createRandom().address;
  const body=Buffer.from('{"command":{}}');
  const verifier=createAuthorityAssertionVerifier(key,()=>10_500);
  const assertion=signAuthorityAssertion(key,{account,method:'POST',
    path:'/api/journal/authority-relay',body,now:10_000});
  assert.throws(()=>verifier(assertion,{method:'GET',url:'/api/journal/authority-relay'},body),
    /stale or mismatched/);
  assert.throws(()=>verifier(assertion,{method:'POST',url:'/api/journal/authority-relay'},Buffer.from('{}')),
    /stale or mismatched/);
  assert.equal(verifier(assertion,{method:'POST',url:'/api/journal/authority-relay'},body),account);
  assert.throws(()=>verifier(assertion,{method:'POST',url:'/api/journal/authority-relay'},body),/reused/);
  assert.throws(()=>createAuthorityAssertionVerifier(key,()=>26_000)(assertion,
    {method:'POST',url:'/api/journal/authority-relay'},body),/stale or mismatched/);
  assert.throws(()=>createAuthorityAssertionVerifier(randomBytes(32),()=>10_500)(assertion,
    {method:'POST',url:'/api/journal/authority-relay'},body),/invalid/);
});

test('replay capacity reports busy separately from a reused assertion and recovers after expiry',()=>{
  const key=randomBytes(32),body=Buffer.alloc(0);
  let clock=10_500;
  const verify=createAuthorityAssertionVerifier(key,()=>clock);
  const req={method:'GET',url:'/api/journal/authority-relay/status'};
  const make=number=>signAuthorityAssertion(key,{account:FRESH_ADMIN_ONE,
    method:req.method,path:req.url,body,now:10_000,nonce:number.toString(16).padStart(32,'0')});
  for(let number=0;number<4096;number++)assert.equal(verify(make(number),req,body),FRESH_ADMIN_ONE);
  assert.throws(()=>verify(make(0),req,body),error=>error.status===409 && /reused/.test(error.message));
  assert.throws(()=>verify(make(4096),req,body),error=>error.status===503 && /busy/.test(error.message));
  clock=26_000;
  const fresh=signAuthorityAssertion(key,{account:FRESH_ADMIN_TWO,method:req.method,
    path:req.url,body,now:26_000,nonce:'f'.repeat(32)});
  assert.equal(verify(fresh,req,body),FRESH_ADMIN_TWO);
});

test('independent signer proves its public Gas address through the private socket without enabling relay',async()=>{
  const root=mkdtempSync(join(tmpdir(),'gas-signer-attestation-'));
  chmodSync(root,0o750);
  const socketPath=join(root,'authority.sock');
  const key=randomBytes(32), gas=Wallet.createRandom(), deployment=Wallet.createRandom();
  const signer=createAuthoritySignerServer(null,key,{attestation:{wallet:gas,origin}});
  await listenAuthoritySigner(signer,socketPath,{allowTestPath:true});
  const readProof=createGasSignerProofReader({socketPath,origin,key,expectedGasWallet:gas.address},
    {allowTestPath:true});
  const challenge={chainId:56,origin,deploymentAccount:deployment.address,
    deploymentId:`1780000000000-${deployment.address}`,
    artifactDigest:`0x${'a'.repeat(64)}`,expectedGasWallet:gas.address,
    nonce:`0x${'b'.repeat(64)}`};
  try {
    const proof=await readProof(challenge);
    assert.equal(verifyGasSignerAttestation(challenge,proof),true);
    assert.equal(verifyGasSignerAttestation({...challenge,nonce:`0x${'c'.repeat(64)}`},proof),false);
    await assert.rejects(readProof({...challenge,expectedGasWallet:Wallet.createRandom().address}),
      /reviewed public configuration/);
    const body=Buffer.from('{}');
    const relay=await new Promise((resolve,reject)=>{
      const request=httpRequest({socketPath,path:'/api/journal/authority-relay',
        method:'POST',headers:{'content-length':String(body.length),
          'x-bemine-relay-assertion':signAuthorityAssertion(key,{account:deployment.address,
            method:'POST',path:'/api/journal/authority-relay',body})}},response=>{
        response.resume();response.on('end',()=>resolve(response.statusCode));
      });
      request.on('error',reject);request.end(body);
    });
    assert.equal(relay,503,'the attestation-only signer cannot broadcast a transaction');
  } finally {
    await new Promise(resolve=>signer.close(resolve));
    rmSync(root,{recursive:true,force:true});
  }
});

test('Gas signer attestation has a global signature ceiling across deployment accounts',async()=>{
  const key=randomBytes(32),gas=Wallet.createRandom();
  const accounts=Array.from({length:3},()=>Wallet.createRandom().address);
  let signatures=0;
  const wallet={address:gas.address,async signMessage(){signatures++;return `0x${'a'.repeat(130)}`;}};
  const signer=createAuthoritySignerServer(null,key,{attestation:{wallet,origin}});
  await new Promise(resolve=>signer.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${signer.address().port}/internal/fresh-gas-attestation`;
  try {
    for(let number=0;number<31;number++){
      const account=accounts[Math.floor(number/11)];
      const challenge={chainId:56,origin,deploymentAccount:account,
        deploymentId:`1780000000000-${account}`,artifactDigest:`0x${'a'.repeat(64)}`,
        expectedGasWallet:gas.address,nonce:`0x${(number+1).toString(16).padStart(64,'0')}`};
      const body=JSON.stringify(challenge);
      const assertion=signAuthorityAssertion(key,{account,method:'POST',
        path:'/internal/fresh-gas-attestation',body:Buffer.from(body)});
      const response=await fetch(url,{method:'POST',headers:{origin,
        'content-type':'application/json','x-bemine-relay-assertion':assertion},body});
      assert.equal(response.status,number<30?200:429,`request ${number+1}`);
    }
    assert.equal(signatures,30,'rotating accounts cannot make the Gas wallet sign past the global ceiling');
  }finally{await new Promise(resolve=>signer.close(resolve));}
});

test('local signer proxy accepts only authenticated exact paths, 0750 directory and 0660 socket',async()=>{
  const root=mkdtempSync(join(tmpdir(),'authority-ipc-test-'));
  chmodSync(root,0o750);
  const socketPath=join(root,'authority.sock'), account=FRESH_ADMIN_ONE;
  const key=randomBytes(32), seen=[];
  const service={handle:async(req,res)=>{
    const body=[]; for await (const part of req) body.push(part);
    seen.push({path:req.url,method:req.method,account:req.authorityIpcAccount,
      body:Buffer.concat(body).toString()});
    res.statusCode=200;res.end(JSON.stringify({status:'idle'}));
  }};
  const signer=createAuthoritySignerServer(service,key);
  await listenAuthoritySigner(signer,socketPath,{allowTestPath:true});
  let session=account, proofReads=0, prefilterReads=0;
  const current=new Set([account.toLowerCase(),FRESH_ADMIN_TWO.toLowerCase()]);
  const proxy=createAuthorityRelayProxy({socketPath,origin,key},{store:{session:()=>session,close(){}},
    prefilterAdministrator:async candidate=>{
      prefilterReads++;
      if (!current.has(candidate.toLowerCase())) throw Object.assign(
        new Error('Administrator wallet is required.'),{status:403});
    },
    verifyAdministrator:async candidate=>{
      proofReads++;
      if (!current.has(candidate.toLowerCase())) throw Object.assign(new Error('Administrator wallet is required.'),{status:403});
    }});
  const frontend=createServer((req,res)=>{void proxy.handle(req,res);});
  await new Promise(resolve=>frontend.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${frontend.address().port}`;
  const headers={cookie:`pinkuang_journal=${token}`,'x-pinkuang-account':account,origin};
  try {
    assert.equal(statSync(socketPath).mode & 0o777,0o660);
    const ok=await fetch(`${url}/api/journal/authority-relay`,{method:'POST',headers:{...headers,
      'content-type':'application/json'},body:'{"command":{}}'});
    assert.equal(ok.status,200);
    assert.deepEqual(await ok.json(),{status:'idle'});
    assert.deepEqual(seen,[{path:'/api/journal/authority-relay',method:'POST',account,
      body:'{"command":{}}'}]);
    assert.equal((await fetch(`${url}/api/journal/authority-relay/other`,{headers})).status,404);
    assert.equal((await fetch(`${url}/api/journal/authority-relay`,{method:'POST',
      headers:{...headers,origin:'https://evil.test','content-type':'application/json'},body:'{}'})).status,403);
    assert.equal((await fetch(`${url}/api/journal/authority-relay/status`,{
      headers:{...headers,'x-pinkuang-account':Wallet.createRandom().address}})).status,409);
    assert.equal((await fetch(`${url}/api/journal/authority-relay`,{method:'POST',
      headers:{...headers,'content-type':'application/json'},body:'x'.repeat(65_537)})).status,413);
    assert.equal(proofReads,1,'an oversized body is rejected before any chain role read');
    session=Wallet.createRandom().address;
    assert.equal((await fetch(`${url}/api/journal/authority-relay/status`,{
      headers:{...headers,'x-pinkuang-account':session}})).status,403,
    'an ordinary session cannot consume signer quota or reach the private socket');
    assert.equal(proofReads,1,'an ordinary session is rejected before the full chain role proof');
    const ordinaryPrefilterReads=prefilterReads;
    for(let count=1;count<30;count++)assert.equal((await fetch(
      `${url}/api/journal/authority-relay/status`,{
        headers:{...headers,'x-pinkuang-account':session}})).status,403);
    assert.equal(prefilterReads,ordinaryPrefilterReads+29);
    assert.equal((await fetch(`${url}/api/journal/authority-relay/status`,{
      headers:{...headers,'x-pinkuang-account':session}})).status,429);
    assert.equal(prefilterReads,ordinaryPrefilterReads+29,
      'the wallet quota rejects repeated non-admin calls before the role prefilter');
    assert.equal(proofReads,1);
    assert.equal(seen.length,1);
    session=FRESH_ADMIN_TWO;
    assert.equal((await fetch(`${url}/api/journal/authority-relay/status`,{
      headers:{...headers,'x-pinkuang-account':session}})).status,200);
    session=account;
    for(let count=2;count<31;count++)
      assert.equal((await fetch(`${url}/api/journal/authority-relay/status`,{headers})).status,200);
    assert.equal((await fetch(`${url}/api/journal/authority-relay/status`,{headers})).status,429,
      'one administrator is bounded independently');
    session=FRESH_ADMIN_TWO;
    assert.equal((await fetch(`${url}/api/journal/authority-relay/status`,{
      headers:{...headers,'x-pinkuang-account':session}})).status,200,
    'the other administrator keeps access');
    const rotated=Wallet.createRandom().address;
    current.delete(account.toLowerCase());current.add(rotated.toLowerCase());
    session=rotated;
    assert.equal((await fetch(`${url}/api/journal/authority-relay/status`,{
      headers:{...headers,'x-pinkuang-account':session}})).status,200,
    'a third limiter key does not block a newly rotated administrator');
    current.delete(FRESH_ADMIN_TWO.toLowerCase());
    session=FRESH_ADMIN_TWO;
    assert.equal((await fetch(`${url}/api/journal/authority-relay/status`,{
      headers:{...headers,'x-pinkuang-account':session}})).status,403);
    assert.equal(seen.length,33);
  } finally {
    await new Promise(resolve=>frontend.close(resolve));
    await new Promise(resolve=>signer.close(resolve));
    proxy.close();rmSync(root,{recursive:true,force:true});
  }
});

test('role prefilter shares pinned role reads, refreshes rotation, and caches RPC failure',async()=>{
  let clock=Date.now(), calls=0, reorg=false;
  const authority=Wallet.createRandom().address, rotated=Wallet.createRandom().address;
  const iface=new Interface(['function administratorOne() view returns (address)',
    'function administratorTwo() view returns (address)']);
  const roles={administratorOne:FRESH_ADMIN_ONE,administratorTwo:FRESH_ADMIN_TWO};
  const hash=`0x${'1'.repeat(64)}`;
  const provider={
    async send(method,args){
      calls++;
      if(method==='eth_chainId')return '0x38';
      assert.equal(method,'eth_call');
      assert.equal(args[0].to,authority);assert.equal(args[1],'0x64');
      const name=iface.parseTransaction(args[0]).name;
      return iface.encodeFunctionResult(name,[roles[name]]);
    },
    async getBlock(tag){calls++;return {number:100,hash:tag===100&&reorg
      ?`0x${'2'.repeat(64)}`:hash,timestamp:Math.floor(clock/1000)};},
  };
  const prefilter=createAuthorityRolePrefilter(provider,
    {freshAuthority:{authority:{address:authority}}},{now:()=>clock});
  const outsiders=Array.from({length:20},()=>Wallet.createRandom().address);
  await Promise.all(outsiders.map(account=>assert.rejects(prefilter(account),error=>error.status===403)));
  assert.equal(calls,6,'concurrent non-admins share one pinned two-role refresh');
  await prefilter(FRESH_ADMIN_ONE);
  assert.equal(calls,6,'cached roles need no further RPC');
  roles.administratorOne=rotated;clock+=15_001;
  await prefilter(rotated);
  await assert.rejects(prefilter(FRESH_ADMIN_ONE),error=>error.status===403);
  assert.equal(calls,12,'rotation is visible after the bounded TTL');
  roles.administratorOne=FRESH_ADMIN_ONE;roles.administratorTwo=FRESH_ADMIN_ONE;clock+=15_001;
  await assert.rejects(prefilter(FRESH_ADMIN_ONE),error=>error.status===409,
    'a dual-admin deployment cannot silently become single-admin');
  const singlePrefilter=createAuthorityRolePrefilter(provider,{freshAuthority:{authority:{address:authority,
    administratorOne:FRESH_ADMIN_ONE,administratorTwo:FRESH_ADMIN_ONE}}},{now:()=>clock});
  await singlePrefilter(FRESH_ADMIN_ONE);
  await assert.rejects(singlePrefilter(FRESH_ADMIN_TWO),error=>error.status===403,
    'the removed second administrator does not gain access');
  roles.administratorTwo='0x0000000000000000000000000000000000000000';clock+=15_001;
  await assert.rejects(singlePrefilter(FRESH_ADMIN_ONE),error=>error.status===409);
  roles.administratorOne=rotated;roles.administratorTwo=FRESH_ADMIN_TWO;
  reorg=true;clock+=15_001;
  await assert.rejects(prefilter(rotated),error=>error.status===503);
  const afterFailure=calls;
  await assert.rejects(prefilter(rotated),error=>error.status===503);
  assert.equal(calls,afterFailure,'failed refresh is cached briefly instead of amplifying an RPC outage');
});

test('on-chain role proof is pinned, rejects retired admins and refuses identity drift',async()=>{
  const admin=FRESH_ADMIN_ONE, second=FRESH_ADMIN_TWO, rotated=Wallet.createRandom().address;
  const authority=Wallet.createRandom().address, factory=Wallet.createRandom().address;
  const budget=Wallet.createRandom().address, gasWallet=Wallet.createRandom().address;
  const code='0x6000';
  const abi=['function coreFactory() view returns(address)',
    'function budgetFactory() view returns(address)',
    'function administratorOne() view returns(address)',
    'function administratorTwo() view returns(address)',
    'function gasWallet() view returns(address)'];
  const { Interface, keccak256 }=await import('ethers');
  const iface=new Interface(abi),blockHash=`0x${'1'.repeat(64)}`;
  const trusted={record:{addresses:{factory,portfolioFactory:budget}},
    bundle:{artifacts:{PlatformAuthority:{deployedBytecode:code,deployedLinkReferences:{},
      immutableReferences:{},abi}}},
    freshAuthority:{authority:{address:authority,codehash:keccak256(code),gasWallet}}};
  const state={first:admin,second,core:factory,budget,gasWallet,code,reorg:false};
  const provider={
    async send(method,args){
      if(method==='eth_chainId')return '0x38';
      assert.equal(method,'eth_call');assert.equal(args[1],'0x64');
      const methodName=iface.parseTransaction(args[0]).name;
      return iface.encodeFunctionResult(methodName,[state[{
        coreFactory:'core',budgetFactory:'budget',administratorOne:'first',
        administratorTwo:'second',gasWallet:'gasWallet'}[methodName]]]);
    },
    async getBlock(tag){return {number:100,hash:tag===100&&state.reorg
      ?`0x${'2'.repeat(64)}`:blockHash,timestamp:Math.floor(Date.now()/1000)};},
    async getCode(address,tag){assert.equal(address,authority);assert.equal(tag,100);return state.code;},
  };
  await verifyCurrentAuthorityAdministrator(provider,trusted,admin);
  state.first=rotated;
  await assert.rejects(verifyCurrentAuthorityAdministrator(provider,trusted,admin),
    error=>error.status===403);
  await verifyCurrentAuthorityAdministrator(provider,trusted,rotated);
  state.first=admin;state.second=admin;
  await assert.rejects(verifyCurrentAuthorityAdministrator(provider,trusted,admin),error=>error.status===409);
  trusted.freshAuthority.authority.administratorOne=admin;
  trusted.freshAuthority.authority.administratorTwo=admin;
  await verifyCurrentAuthorityAdministrator(provider,trusted,admin);
  await assert.rejects(verifyCurrentAuthorityAdministrator(provider,trusted,second),error=>error.status===403);
  state.first=gasWallet;state.second=gasWallet;
  await assert.rejects(verifyCurrentAuthorityAdministrator(provider,trusted,gasWallet),error=>error.status===409,
    'the Gas wallet cannot occupy an administrator role');
  state.first=rotated;state.second=second;
  state.core=Wallet.createRandom().address;
  await assert.rejects(verifyCurrentAuthorityAdministrator(provider,trusted,rotated),
    error=>error.status===409);
  state.core=factory;state.reorg=true;
  await assert.rejects(verifyCurrentAuthorityAdministrator(provider,trusted,rotated),
    error=>error.status===503);
});

test('public relay IP limit rejects excess requests before a session database read',async()=>{
  let lookups=0;
  const proxy=createAuthorityRelayProxy({socketPath:'/run/pinkuang-v4-relay/authority.sock',
    origin,key:randomBytes(32)},{store:{session(){lookups++;return null;},close(){}},
      verifyAdministrator:async()=>{}});
  const frontend=createServer((req,res)=>{void proxy.handle(req,res);});
  await new Promise(resolve=>frontend.listen(0,'127.0.0.1',resolve));
  try{
    const url=`http://127.0.0.1:${frontend.address().port}/api/journal/authority-relay/status`;
    const headers={cookie:`pinkuang_journal=${token}`,'x-pinkuang-account':FRESH_ADMIN_ONE};
    for(let count=0;count<90;count++)assert.equal((await fetch(url,{headers})).status,401);
    assert.equal(lookups,90);
    assert.equal((await fetch(url,{headers})).status,429);
    assert.equal(lookups,90,'the over-limit request must not reach SQLite');
  }finally{
    await new Promise(resolve=>frontend.close(resolve));
    proxy.close();
  }
});

test('unresponsive local signer times out without exposing an arbitrary HTTP target',async()=>{
  const root=mkdtempSync(join(tmpdir(),'authority-ipc-timeout-'));
  chmodSync(root,0o750);
  const socketPath=join(root,'authority.sock'), account=FRESH_ADMIN_TWO;
  const signer=createServer((_req,_res)=>{});
  await listenAuthoritySigner(signer,socketPath,{allowTestPath:true});
  const proxy=createAuthorityRelayProxy({socketPath,origin,key:randomBytes(32)},
    {store:{session:()=>account,close(){}},timeoutMs:25,verifyAdministrator:async()=>{}});
  const frontend=createServer((req,res)=>{void proxy.handle(req,res);});
  await new Promise(resolve=>frontend.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${frontend.address().port}/api/journal/authority-relay/status`,
      {headers:{cookie:`pinkuang_journal=${token}`,'x-pinkuang-account':account,origin}});
    assert.equal(response.status,503);
    assert.match((await response.json()).error,/unavailable/);
  } finally {
    await new Promise(resolve=>frontend.close(resolve));
    signer.closeAllConnections();
    await new Promise(resolve=>signer.close(resolve));
    proxy.close();rmSync(root,{recursive:true,force:true});
  }
});

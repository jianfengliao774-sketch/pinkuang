import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createFullTestService } from './server.mjs';
import { FULL_TEST_COOKIE, FULL_TEST_COOKIE_PATH, FULL_TEST_TIMINGS, validateFullTestProfile } from './server-profile.mjs';
import { createJournalService } from '../deploy/server/journal-api.mjs';
const {Wallet}=createRequire(new URL('../deploy/package.json',import.meta.url))('ethers');
const hash=n=>'0x'+n.toString(16).padStart(64,'0'), address=n=>'0x'+n.toString(16).padStart(40,'0');
const origin='http://127.0.0.1:4207',deployer='0x6f4d78fb59ec938cbaf65b9fc822ad04d00c155e';
const admins=[deployer,'0x7674fa446d42b1f7f150dc5e678cc525d275ea53'],gas='0xad95dff16fe0e09c47bade687ab549929ac66c80';
const artifactDigest=hash(1),sourceHead='a'.repeat(40);
function inputs() {
  const profile={schemaVersion:1,profile:'full-test',chainId:56,artifactDigest,sourceHead,
    timings:{...FULL_TEST_TIMINGS},roles:{deployer,administratorOne:admins[0],administratorTwo:admins[1],gasWallet:gas},
    forbiddenContracts:[address(999),address(998)]};
  const bundle={sourceCommit:sourceHead,metadata:{profile:'full-test',kind:'bemine-full-mainnet-test',chainId:56,
    timings:{...FULL_TEST_TIMINGS},formalArtifactDigest:hash(2)}};
  const names=['factory','shareMarket','lens','beacon','timelock','portfolioFactory','portfolioShareMarket',
    'portfolioBeacon','BudgetPortfolioVault','BudgetPortfolioFactory'];
  const addresses=Object.fromEntries(names.map((n,i)=>[n,address(i+10)]));
  const codehash=Object.fromEntries(names.map((n,i)=>[n,hash(i+20)]));
  const initial={id:'initialize',status:'confirmed',txHash:hash(70),receipt:{status:1,blockNumber:100,blockHash:hash(100)}};
  const record={schemaVersion:1,id:'test-deployment',kind:'integrated-v2',chainId:56,account:deployer,
    artifactDigest,sourceCommit:sourceHead,status:'complete',addresses,steps:[initial]};
  const activation={schemaVersion:1,kind:'fresh-authority',chainId:56,account:deployer,status:'complete',
    genesisArtifactDigest:artifactDigest,deploymentId:record.id,authorityAddress:address(80),
    administratorOne:admins[0],administratorTwo:admins[1],gasWallet:gas,
    steps:['deployAuthority','coreOperator','coreTreasury','budgetOperator','budgetTreasury','coreOwner','budgetOwner']
      .map((id,i)=>({id,status:'confirmed',txHash:hash(80+i),receipt:{status:1,blockNumber:101+i,blockHash:hash(101+i)}}))};
  const graph={freshFactoryVerified:true,artifactDigest,addresses,codehash,
    freshAuthority:{address:activation.authorityAddress,codehash:hash(50),deploymentTxHash:activation.steps[0].txHash,
      administratorOne:admins[0],administratorTwo:admins[1],gasWallet:gas}};
  return {profile,bundle,record,activation,graph};
}
async function fixture({input=inputs(),directory,manageIndex=true}={}) {
  const state=directory??await mkdtemp(join(tmpdir(),'bemine-full-test-'));
  let deploymentRevision=1,activationRevision=1,graphFailure=false,closedIndex=0,starts=0,proofs=0;
  const calls=[],journals=[];
  const runtime={
    createJournalService(options){journals.push(options);return {
      readAuthenticatedDeployment(req){if(req.headers.cookie!=='test_session=valid'){const e=new Error('Wallet session is required.');e.status=401;throw e;}
        return {account:deployer,deployment:{record:input.record,revision:deploymentRevision},activation:{record:input.activation,revision:activationRevision}};},
      handle(req,res){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({journal:true}));},
      verifyFreshOperationalReadiness:async()=>{throw new Error('Workers are not ready.');},close:async()=>{},
    };},
    validateFreshActivation(){calls.push('activation');},
    verifyCompletedDeployment:async(_provider,_record,{trustedArtifactBundle})=>{assert.equal(trustedArtifactBundle,input.bundle);calls.push('receipts');},
    productGraphConfiguration(options){assert.equal(options.bundle,input.bundle);calls.push('trusted graph');return options;},
    verifyProductGraph:async()=>{proofs++;calls.push('runtime graph');if(graphFailure)throw new Error('Runtime mismatch.');return input.graph;},
    createFreshIndexManifest(manifest){return {...manifest,kind:'fresh-v4-index'};},
    overviewQuoteLoader(options){assert.equal(options.baseUrl,'http://127.0.0.1:4207/firsto-api');return ()=>{};},
    startChainIndex:async config=>{starts++;assert.equal(config.port,4204);assert.equal(config.host,'127.0.0.1');
      assert.ok(config.dbPath.startsWith(state));assert.equal(config.freshCodehashes.length,11);
      return {close:async()=>{closedIndex++;}};},
    createLiveDataProxy(config){assert.equal(config.indexUrl,'http://127.0.0.1:4204');return {handle:async(_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({localProxy:true}));}};},
    proxyFirsto:async(_req,res)=>res.end(),
  };
  const provider={getBlock:async id=>({number:id==='latest'?150:id,hash:hash(id==='latest'?150:id)})};
  const service=await createFullTestService({runtime,profile:input.profile,bundle:input.bundle,artifactDigest,provider,
    rpcUrl:'https://test-read.example/',stateRoot:state,origin,allowTemporaryState:true,manageIndex,
    freshProductReadinessReader:async()=>({ready:false})});
  const server=createServer((req,res)=>void service.handle(req,res));
  await new Promise(accept=>server.listen(0,'127.0.0.1',accept));
  const request=async(path='/api/full-test/activate',{method='POST',body={account:deployer},cookie='test_session=valid',requestOrigin=origin}={})=>{
    const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,
      headers:{Origin:requestOrigin,'Content-Type':'application/json',Cookie:cookie},...(method==='GET'?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json()};};
  return {service,state,input,request,calls,journals,stats:()=>({starts,proofs,closedIndex}),
    graphFailure(){graphFailure=true;},changeRevision(){activationRevision++;},
    async close(keep=false){const stopped=new Promise(accept=>server.close(accept));await service.close();server.closeAllConnections();await stopped;
      if(!keep)await rm(state,{recursive:true,force:true});}};
}

test('unconfigured test site exposes no formal manifest, index, or product journal',async()=>{
  const f=await fixture();try{
    const config=await f.request('/api/full-test/config',{method:'GET'});
    assert.equal(config.body.status,'unconfigured');assert.equal(config.body.manifest,undefined);
    assert.equal(config.body.automationReady,false);assert.equal(f.stats().starts,0);
    assert.equal((await f.request('/api/chain-index/v1/display/stats',{method:'GET'})).status,503);
    assert.equal((await f.request('/api/journal/product-graph',{method:'GET'})).status,503);
    assert.equal((await f.request('/api/journal/authority-relay')).status,503);
    assert.equal(f.journals[0].sessionCookieName,FULL_TEST_COOKIE);assert.equal(f.journals[0].sessionCookiePath,FULL_TEST_COOKIE_PATH);
    assert.equal(f.journals[0].freshConsolePreGenesis,false);assert.equal(f.journals[0].gasWalletAddressReader,undefined);
  }finally{await f.close();}
});
test('activation requires authenticated journal, exact origin and account; rejects caller manifest',async()=>{
  const f=await fixture();try{
    assert.equal((await f.request(undefined,{cookie:'pinkuang_journal=production'})).status,401);
    assert.equal((await f.request(undefined,{requestOrigin:'https://bemine.cc.cd'})).status,403);
    assert.equal((await f.request(undefined,{body:{account:address(4)}})).status,409);
    assert.equal((await f.request(undefined,{body:{account:deployer,manifest:{factory:address(4)}}})).status,400);
    assert.equal(f.stats().proofs,0);assert.equal(f.stats().starts,0);
  }finally{await f.close();}
});
test('Stage 1 alone, wrong bundle, or formal addresses never activate data services',async()=>{
  for(const change of [f=>f.input.activation.status='paused',f=>f.input.record.artifactDigest=hash(2),
    f=>f.input.record.addresses.factory=f.input.profile.forbiddenContracts[0]]){
    const f=await fixture();try{change(f);assert.equal((await f.request()).status,409);assert.equal(f.stats().starts,0);
      await assert.rejects(readFile(join(f.state,'activation-state.json')),/ENOENT/);
    }finally{await f.close();}
  }
});
test('actual receipt, Authority, runtime and canonical block proofs precede manifest export',async()=>{
  const f=await fixture();try{
    const activated=await f.request();assert.equal(activated.status,200);assert.equal(activated.body.status,'ready');
    assert.equal(activated.body.stage,'fresh-active');assert.equal(activated.body.operationalReady,false);
    assert.equal(activated.body.manifest.factory,f.input.graph.addresses.factory);
    assert.equal(activated.body.manifest.freshAuthority.gasWallet,gas);
    assert.deepEqual(f.calls,['activation','receipts','trusted graph','runtime graph']);
    const ready=JSON.parse(await readFile(join(f.state,'activation-ready.json'),'utf8'));
    const persisted=JSON.parse(await readFile(join(f.state,'activation-state.json'),'utf8'));
    assert.equal(ready.profile,'full-test');assert.equal(persisted.record.id,f.input.record.id);
    assert.equal(f.stats().starts,1);assert.equal((await f.request()).status,200);assert.equal(f.stats().starts,1);
    f.input.record.id='a-different-deployment';assert.equal((await f.request()).status,409);
  }finally{await f.close();}
});
test('runtime proof failure cannot export a ready file or start an index',async()=>{
  const f=await fixture();try{f.graphFailure();assert.equal((await f.request()).status,409);assert.equal(f.stats().starts,0);
    await assert.rejects(readFile(join(f.state,'activation-ready.json')),/ENOENT/);
  }finally{await f.close();}
});
test('restart independently proves persisted graph and preserves the unique deployment',async()=>{
  const f=await fixture();const input=f.input;await f.request();const directory=f.state;await f.close(true);
  const restored=await fixture({input,directory});try{assert.equal((await restored.service.config()).status,'ready');
    assert.equal(restored.stats().proofs,1);assert.equal(restored.stats().starts,1);
  }finally{await restored.close();}
});
test('declared zero-delay profile cannot reuse formal bundle or production gas signer',()=>{
  const {profile,bundle}=inputs();
  assert.doesNotThrow(()=>validateFullTestProfile(profile,bundle,artifactDigest));
  const wrong=structuredClone(bundle);wrong.metadata.profile='fresh-v4';
  assert.throws(()=>validateFullTestProfile(profile,wrong,artifactDigest),/artifact identity/);
  const delay=structuredClone(bundle);delay.metadata.timings.upgradeDelaySeconds=172800;
  assert.throws(()=>validateFullTestProfile(profile,delay,artifactDigest),/timing profile/);
  const signer=structuredClone(profile);signer.roles.gasWallet='0xA285d1933e32b5990625aC1F5BEa205Cf2606619';
  assert.throws(()=>validateFullTestProfile(signer,bundle,artifactDigest),/declared wallets/);
});
test('public API can hand off verified manifest without starting privileged index services',async()=>{
  const f=await fixture({manageIndex:false});try{
    const result=await f.request();assert.equal(result.status,200);assert.equal(result.body.status,'ready');
    assert.equal(result.body.automationReady,false);assert.equal(f.stats().starts,0);
    assert.equal(JSON.parse(await readFile(join(f.state,'activation-ready.json'),'utf8')).factory,f.input.record.addresses.factory);
    assert.equal((await f.request('/api/chain-index/v1/display/stats',{method:'GET'})).status,200);
  }finally{await f.close();}
});

test('isolated cookie uses real signature login; formal cookie and wrong wallet cannot read records',
  {skip:process.platform==='win32'?'The existing production JournalStore requires POSIX 0700 permissions. Run this auth integration case on Linux.':false},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'full-test-journal-auth-')),wallet=Wallet.createRandom();
  const service=createJournalService({dbPath:join(directory,'journal.sqlite'),origin,
    currentArtifactDigest:()=>artifactDigest,sessionCookieName:FULL_TEST_COOKIE,sessionCookiePath:FULL_TEST_COOKIE_PATH,
    deploymentAccountAllowlist:[wallet.address]});
  const server=createServer((req,res)=>service.handle(req,res));await new Promise(accept=>server.listen(0,'127.0.0.1',accept));
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=async(path,body)=>fetch(base+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
  try{
    const challenge=await (await post('/api/journal/challenge',{account:wallet.address})).json();
    const session=await post('/api/journal/session',{account:wallet.address,nonce:challenge.nonce,signature:await wallet.signMessage(challenge.message)});
    assert.equal(session.status,200);const cookie=session.headers.get('set-cookie');
    assert.ok(cookie.startsWith(FULL_TEST_COOKIE+'='));assert.ok(cookie.includes('Path='+FULL_TEST_COOKIE_PATH));
    const request={headers:{cookie:cookie.split(';')[0],origin,'x-pinkuang-account':wallet.address}};
    assert.equal(service.readAuthenticatedDeployment(request).account,wallet.address.toLowerCase());
    assert.throws(()=>service.readAuthenticatedDeployment({headers:{...request.headers,cookie:cookie.replace(FULL_TEST_COOKIE,'pinkuang_journal')}}),/Wallet session/);
    assert.throws(()=>service.readAuthenticatedDeployment({headers:{...request.headers,'x-pinkuang-account':address(1)}}),/switched accounts/);
    assert.equal((await post('/api/journal/session',{account:wallet.address,nonce:challenge.nonce,signature:await wallet.signMessage(challenge.message)})).status,401);
  }finally{const stopped=new Promise(accept=>server.close(accept));await service.close();server.closeAllConnections();await stopped;await rm(directory,{recursive:true,force:true});}
});

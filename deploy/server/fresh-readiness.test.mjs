import {isFreshUserExit,FRESH_USER_EXIT_ACTIONS} from '../shared/fresh-user-exits.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import {mkdtempSync, mkdirSync, copyFileSync, writeFileSync, symlinkSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import { createFreshProductGate, validateFreshProductBindings, freshProductConfiguration } from './fresh-product-gate.mjs';
import { createFreshMachineReadiness, verifyFreshLegacyDrain } from './fresh-machine-readiness.mjs';
import { createFreshProductReadinessReader, createAuthoritySignerServer, createAuthorityRelayProxy } from './authority-ipc.mjs';
import { freshGraphIdentity, validateFreshWorker } from '../shared/fresh-runtime-identity.mjs';
import {freshIndexManifestBytes,freshIndexManifestSha256} from './chain-index/fresh-manifest.mjs';
const a=n=>'0x'+n.toString(16).padStart(40,'0'), h=n=>'0x'+n.toString(16).padStart(64,'0');
const stamp=2_000_000_000_000, sourceHead='a'.repeat(40);
function fixture(){
 const names={factory:'factory',shareMarket:'shareMarket',portfolioFactory:'portfolioFactory',portfolioMarket:'portfolioShareMarket',lens:'lens',beacon:'beacon',timelock:'timelock',portfolioBeacon:'portfolioBeacon',portfolioImplementation:'BudgetPortfolioVault',portfolioFactoryImplementation:'BudgetPortfolioFactory'};
 const addresses={FreshPoolFactory:a(30)},code={},codehash={},manifest={kind:'fresh-v4-index',chainId:56,artifactDigest:h(40),deployment:{txHash:h(1),blockNumber:100,blockHash:h(100)},verifiedBlockNumber:110,verifiedBlockHash:h(110),authority:a(20),gasWallet:a(21),freshAuthority:{codehash:h(20),deploymentTxHash:h(20),administratorOne:a(22),administratorTwo:a(23)}};
 let i=1;for(const [key,name]of Object.entries(names)){manifest[key]=a(i);addresses[name]=a(i);code[name]={codehash:h(i)};codehash[key]=h(i++);}manifest.codehash=codehash;
 const trusted={record:{chainId:56,artifactDigest:h(40),addresses,verification:{code},steps:[{id:'initialize',txHash:h(1),receipt:{blockNumber:100,blockHash:h(100)}}]},freshAuthority:{authority:{address:a(20),gasWallet:a(21),deploymentTxHash:h(20),administratorOne:a(22),administratorTwo:a(23)},steps:[{blockNumber:110,blockHash:h(110)}]}};
 const graph={freshFactoryVerified:true,artifactDigest:h(40),addresses,blockNumber:120,blockHash:h(120),freshAuthority:{address:a(20),gasWallet:a(21),codehash:h(20)}};
 const identity=freshGraphIdentity(graph),block={number:120,hash:h(120),timestamp:stamp/1000};
 const pulse=role=>({schemaVersion:1,role,ready:true,sendEnabled:true,sourceHead,pid:99,invocationId:'b'.repeat(32),checkedAt:stamp-100,blockNumber:120,blockHash:h(120),identity});
 const unit={ActiveState:'active',SubState:'running',MainPID:'99',InvocationID:'b'.repeat(32)};
 const oldUnit={ActiveState:'inactive',MainPID:'0',LoadState:'loaded',UnitFileState:'disabled'};
 const drain={schemaVersion:1,chainId:56,gasWallet:a(21),cutoverNonce:1,latestNonce:1,pendingNonce:1,units:['pinkuang-purchase-v2.service'],journals:[{journalSha256:'c'.repeat(64),phase:'confirmed',nonce:0,txHash:h(70),blockNumber:90,blockHash:h(90)}]};
 const provider={getTransactionCount:async()=>1,getBlock:async n=>n==='finalized'?{number:121,hash:h(121)}:{number:n,hash:h(n),timestamp:stamp/1000},getTransaction:async()=>({hash:h(70),chainId:56n,from:a(21),nonce:0}),getTransactionReceipt:async()=>({hash:h(70),status:1,blockNumber:90,blockHash:h(90)})};
 const machine={schemaVersion:1,ready:true,relayEnabled:true,attestOnly:false,sourceHead,identity,checkedAt:stamp,workers:{purchase:pulse('purchase'),mining:pulse('mining')},drain:{oldSendersDisabled:true}};
 const source={chainId:56,complete:true,factory:manifest.factory,market:manifest.shareMarket,portfolioFactory:manifest.portfolioFactory,portfolioMarket:manifest.portfolioMarket,startBlock:100,indexedThrough:120,observedSafeHead:120,indexedBlockHash:h(120),indexedTimestamp:stamp/1000};
 const config={manifest,sourceHead,indexUrl:'http://127.0.0.1:4184/health'},factories=new Set([manifest.factory,manifest.portfolioFactory]);
 const gate=()=>createFreshProductGate(config,{trusted,factories,machineReader:async()=>machine,fetcher:async()=>({ok:true,text:async()=>JSON.stringify({source})}),now:()=>stamp});
 return {manifest,trusted,graph,identity,block,pulse,unit,oldUnit,drain,provider,machine,source,config,factories,gate};
}
test('fresh product stays closed without explicit isolated-process configuration',()=>{
 assert.equal(freshProductConfiguration({}),null);
 for(const patch of [{},{HOST:'0.0.0.0'},{PORT:'4177'},{BEMINE_FRESH_STAGE2_HOLD:'0'},{AUTHORITY_RELAY_ENABLED:'1'}]) assert.throws(()=>freshProductConfiguration({BEMINE_FRESH_PRODUCT_ENABLED:'1',...patch}),/separate/);
});
test('fresh graph+two worker processes+canonical fresh index admit only the exact release',async()=>{
 const f=fixture();assert.deepEqual(await f.gate()(f.provider,f.graph,f.block),{ready:true,indexedThrough:120,checkedAt:stamp});
});

test('index ahead of the pinned graph still rejects and exposes only fixed predicate facts',async()=>{
 const f=fixture();f.source.indexedThrough=121;f.source.observedSafeHead=121;f.source.indexedBlockHash=h(121);
 await assert.rejects(f.gate()(f.provider,f.graph,f.block),error=>{
  assert.equal(error.message,'Fresh index is incomplete, stale or belongs to another graph.');
  assert.deepEqual(error.indexFacts,{indexNotAheadOfGraph:false,indexFresh:true,indexComplete:true,
   indexSameGraph:true,indexAtSafeHead:true,indexInBlockWindow:true,indexHasCanonicalHash:true,indexAfterActivation:true});
  assert.equal(Object.values(error.indexFacts).every(value=>typeof value==='boolean'),true);return true;
 });
});

test('prepared index remains before the pinned graph while the index advances and machine proof starts afterward',async()=>{
 const f=fixture(),events=[];let clock=stamp,finishGraph;
 const gate=createFreshProductGate(f.config,{trusted:f.trusted,factories:f.factories,now:()=>clock,
  fetcher:async()=>({ok:true,text:async()=>{events.push('index-body');return JSON.stringify({source:f.source});}}),
  machineReader:async()=>{events.push('machine');return {...f.machine,checkedAt:clock};}});
 const validate=await gate.prepareIndex();
 events.push('latest');const block={...f.block,number:123,hash:h(123)};
 const graphProof=new Promise(resolve=>{finishGraph=()=>{events.push('graph-complete');resolve({...f.graph,blockNumber:123,blockHash:h(123)});};});
 const result=graphProof.then(graph=>validate(f.provider,graph,block));
 f.source.indexedThrough=125;f.source.observedSafeHead=125;f.source.indexedBlockHash=h(125);clock+=20_000;
 assert.deepEqual(events,['index-body','latest']);finishGraph();
 assert.deepEqual(await result,{ready:true,indexedThrough:120,checkedAt:clock});
 assert.deepEqual(events,['index-body','latest','graph-complete','machine']);
 await assert.rejects(validate(f.provider,f.graph,f.block),/already been used/);
 assert.equal(events.filter(event=>event==='machine').length,1,'a used validator cannot start another machine proof');
});

for(const [name,mutate]of Object.entries({
 wrongIdentity:f=>{f.graph={...f.graph,addresses:{...f.graph.addresses,factory:a(90)}};},
 futureIndex:f=>{f.source.indexedThrough=121;f.source.observedSafeHead=121;},
 failedMachine:f=>{f.machine.ready=false;},
 reorg:f=>{f.provider.getBlock=async number=>({number,hash:h(999)});},
}))test('prepared product readiness still rejects '+name,async()=>{
 const f=fixture();mutate(f);let validate;
 await assert.rejects(async()=>{validate=await f.gate().prepareIndex();await validate(f.provider,f.graph,f.block);});
 if(validate)await assert.rejects(validate(f.provider,f.graph,f.block),/already been used/);
});

test('prepared index waits only for a valid refreshing snapshot and defers all graph and machine work',async()=>{
 const f=fixture(),signals=[];let reads=0,machines=0;
 const server=createServer((_req,res)=>{
  reads++;res.setHeader('content-type','application/json');
  const source=reads===1?{...f.source,complete:false,unknownReason:'index_refreshing',observedSafeHead:121}
   :{...f.source,indexedThrough:121,observedSafeHead:121,indexedBlockHash:h(121)};
  res.end(JSON.stringify({source,displaySource:{...f.source,complete:true}}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const gate=createFreshProductGate({...f.config,indexUrl:`http://127.0.0.1:${server.address().port}/health`},
  {trusted:f.trusted,factories:f.factories,now:()=>stamp,
   fetcher:(url,options)=>{signals.push(options.signal);return fetch(url,options);},
   machineReader:async()=>{machines++;return f.machine;}});
 try {
  const validate=await gate.prepareIndex();assert.equal(reads,2);assert.equal(machines,0);
  assert.equal(new Set(signals).size,1,'fetches share one timeout signal');
  const block={...f.block,number:123,hash:h(123)};
  assert.deepEqual(await validate(f.provider,f.graph,block),{ready:true,indexedThrough:121,checkedAt:stamp});
  assert.equal(machines,1);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('persistent index refresh expires one total five-second budget without starting machine proof',async()=>{
 const f=fixture(),signals=[];let machines=0;
 const source={...f.source,complete:false,unknownReason:'index_refreshing',observedSafeHead:121};
 const server=await localIndex(source),started=Date.now();
 const gate=createFreshProductGate({...f.config,indexUrl:server.url},{trusted:f.trusted,factories:f.factories,now:()=>stamp,
  fetcher:(url,options)=>{signals.push(options.signal);return fetch(url,options);},
  machineReader:async()=>{machines++;return f.machine;}});
 try {
  await assert.rejects(gate.prepareIndex(),error=>error.name==='TimeoutError');
  assert.equal(signals.length>1,true);assert.equal(new Set(signals).size,1);assert.equal(machines,0);
  assert.equal(Date.now()-started<6500,true,'repeated health GETs do not renew the budget');
 }finally{await server.close();}
});

for(const [name,patch]of Object.entries({wrongChain:{chainId:1},wrongGraph:{factory:a(99)},
 stale:{indexedTimestamp:stamp/1000-91},hardFailure:{complete:false,unknownReason:'sync_failed'},
 malformedHeight:{indexedThrough:'120'},badHash:{indexedBlockHash:'0x'}}))
test('index preparation rejects '+name+' immediately without retrying or reading machine status',async()=>{
 const f=fixture();let reads=0,machines=0;
 const gate=createFreshProductGate(f.config,{trusted:f.trusted,factories:f.factories,now:()=>stamp,
  fetcher:async()=>{reads++;return {ok:true,text:async()=>JSON.stringify({source:{...f.source,complete:false,
   unknownReason:'index_refreshing',observedSafeHead:121,...patch},displaySource:f.source})};},
  machineReader:async()=>{machines++;return f.machine;}});
 await assert.rejects(gate.prepareIndex());assert.equal(reads,1);assert.equal(machines,0);
});

test('a prepared index cannot outlive its strict ninety-second freshness window',async()=>{
 const f=fixture();let clock=stamp;
 const gate=createFreshProductGate(f.config,{trusted:f.trusted,factories:f.factories,now:()=>clock,
  fetcher:async()=>({ok:true,text:async()=>JSON.stringify({source:f.source})}),
  machineReader:async()=>({...f.machine,checkedAt:clock})});
 const validate=await gate.prepareIndex();clock+=91_000;
 await assert.rejects(validate(f.provider,f.graph,f.block),/index is incomplete/);
});

test('index preparation never retries HTTP errors, malformed JSON or a missing source',async()=>{
 for(const response of [{ok:false,text:async()=>''},{ok:true,text:async()=>'{invalid'},
  {ok:true,text:async()=>JSON.stringify({displaySource:fixture().source})}]) {
  const f=fixture();let reads=0,machines=0;
  const gate=createFreshProductGate(f.config,{trusted:f.trusted,factories:f.factories,now:()=>stamp,
   fetcher:async()=>{reads++;return response;},machineReader:async()=>{machines++;return f.machine;}});
  await assert.rejects(gate.prepareIndex());assert.equal(reads,1);assert.equal(machines,0);
 }
});

async function localIndex(source,{bodyDelayMs=0}={}){
 const timers=new Set(),server=createServer((_req,res)=>{
  res.writeHead(200,{'content-type':'application/json'});res.flushHeaders();
  if(!bodyDelayMs)res.end(JSON.stringify({source}));
  else{const timer=setTimeout(()=>{timers.delete(timer);res.end(JSON.stringify({source}));},bodyDelayMs);timers.add(timer);}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return{url:`http://127.0.0.1:${server.address().port}/health`,async close(){
  for(const timer of timers)clearTimeout(timer);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 }};
}

test('native index Fetch body is consumed before a machine proof longer than the five-second timeout',async()=>{
 const f=fixture(),server=await localIndex(f.source);
 const gate=createFreshProductGate({...f.config,indexUrl:server.url},{trusted:f.trusted,factories:f.factories,
  machineReader:async()=>{await new Promise(resolve=>setTimeout(resolve,5400));return f.machine;},now:()=>stamp});
 try{assert.deepEqual(await gate(f.provider,f.graph,f.block),{ready:true,indexedThrough:120,checkedAt:stamp});}
 finally{await server.close();}
});

test('native index Fetch still rejects a body that arrives after its own five-second timeout',async()=>{
 const f=fixture(),server=await localIndex(f.source,{bodyDelayMs:5400});
 const gate=createFreshProductGate({...f.config,indexUrl:server.url},{trusted:f.trusted,factories:f.factories,
  machineReader:async()=>f.machine,now:()=>stamp});
 try{await assert.rejects(gate(f.provider,f.graph,f.block),error=>['TimeoutError','AbortError'].includes(error.name));}
 finally{await server.close();}
});

test('a promptly consumed native index response cannot conceal a machine proof failure',async()=>{
 const f=fixture(),server=await localIndex(f.source);
 const gate=createFreshProductGate({...f.config,indexUrl:server.url},{trusted:f.trusted,factories:f.factories,
  machineReader:async()=>{throw new Error('Controlled machine proof failed.');},now:()=>stamp});
 try{await assert.rejects(gate(f.provider,f.graph,f.block),/Controlled machine proof failed/);}
 finally{await server.close();}
});
test('installed product configuration defaults to its own source and accepts only an explicit lowercase machine pin',async t=>{
 const root=mkdtempSync(join(tmpdir(),'fresh-machine-source-pin-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 for(const folder of ['server/chain-index','shared','public'])mkdirSync(join(root,folder),{recursive:true});
 writeFileSync(join(root,'package.json'),JSON.stringify({type:'module'}),{mode:0o600});
 for(const path of ['server/fresh-product-gate.mjs','server/chain-index/fresh-manifest.mjs','shared/fresh-runtime-identity.mjs'])
  copyFileSync(new URL('../'+path,import.meta.url),join(root,path));
 symlinkSync(fileURLToPath(new URL('../node_modules',import.meta.url)),join(root,'node_modules'),'dir');
 const ownHead='b'.repeat(40),f=fixture();
 const manifest={...f.manifest,schemaVersion:1,freshAuthority:{...f.manifest.freshAuthority,address:f.manifest.authority,gasWallet:f.manifest.gasWallet}};
 const manifestPath=join(root,'index-manifest.json');writeFileSync(manifestPath,freshIndexManifestBytes(manifest),{mode:0o600});
 writeFileSync(join(root,'public/fresh-release-manifest.json'),JSON.stringify({chainId:56,kind:'fresh-v4-product-backend-draft',sourceHead:ownHead}),{mode:0o600});
 const {freshProductConfiguration:configure}=await import(pathToFileURL(join(root,'server/fresh-product-gate.mjs')));
 const env={BEMINE_FRESH_PRODUCT_ENABLED:'1',BEMINE_FRESH_CONSOLE_PRE_GENESIS:'0',BEMINE_FRESH_STAGE2_HOLD:'1',
  HOST:'127.0.0.1',PORT:'4187',AUTHORITY_RELAY_PUBLIC_ENABLED:'1',AUTHORITY_RELAY_ENABLED:'0',
  BEMINE_INDEX_URL:'http://127.0.0.1:4184',BEMINE_FRESH_PRODUCT_MANIFEST_PATH:manifestPath,
  BEMINE_FRESH_PRODUCT_MANIFEST_SHA256:freshIndexManifestSha256(manifest)};
 const normal=configure(env);assert.equal(normal.sourceHead,ownHead);assert.equal(normal.machineSourceHead,ownHead);
 const pinned=configure({...env,BEMINE_FRESH_MACHINE_SOURCE_HEAD:sourceHead});
 assert.equal(pinned.sourceHead,ownHead);assert.equal(pinned.machineSourceHead,sourceHead);
 for(const value of ['',null,42,'A'.repeat(40),'a'.repeat(39),'a'.repeat(41),'g'.repeat(40),' '+sourceHead,sourceHead+'\n'])
  assert.throws(()=>configure({...env,BEMINE_FRESH_MACHINE_SOURCE_HEAD:value}),/lowercase forty/);
});
test('an explicit machine release pin allows a product-only update without weakening readiness or graph checks',async()=>{
 const f=fixture();f.config.sourceHead='b'.repeat(40);f.config.machineSourceHead=sourceHead;
 assert.deepEqual(await f.gate()(f.provider,f.graph,f.block),{ready:true,indexedThrough:120,checkedAt:stamp});
 assert.equal(f.config.sourceHead,'b'.repeat(40),'product retains its own installed release identity');
 for(const [name,mutate]of Object.entries({machineHead:f=>{f.machine.sourceHead='b'.repeat(40);},
  purchaseHead:f=>{f.machine.workers.purchase.sourceHead='b'.repeat(40);},miningHead:f=>{f.machine.workers.mining.sourceHead='b'.repeat(40);},
  wrongIdentity:f=>{f.machine.identity={...f.machine.identity,authority:a(999)};},
  stale:f=>{f.machine.checkedAt-=16000;},notReady:f=>{f.machine.ready=false;},workerNotReady:f=>{f.machine.workers.mining.ready=false;},
  notDrained:f=>{f.machine.drain.oldSendersDisabled=false;},incompleteIndex:f=>{f.source.complete=false;},
  oldGraph:f=>{f.graph.freshFactoryVerified=false;}})){
  const bad=fixture();bad.config.sourceHead='b'.repeat(40);bad.config.machineSourceHead=sourceHead;mutate(bad);
  await assert.rejects(async()=>bad.gate()(bad.provider,bad.graph,bad.block),undefined,name);
 }
});
test('no explicit machine pin preserves strict own-release matching and invalid pins cannot create a gate',async()=>{
 const f=fixture();f.config.sourceHead='b'.repeat(40);
 await assert.rejects(async()=>f.gate()(f.provider,f.graph,f.block),/proved readiness/);
 f.config.machineSourceHead='c'.repeat(40);
 await assert.rejects(async()=>f.gate()(f.provider,f.graph,f.block),/proved readiness/);
 for(const value of ['',null,42,'A'.repeat(40),'a'.repeat(39),'g'.repeat(40)]){
  const invalid=fixture();invalid.config.machineSourceHead=value;assert.throws(invalid.gate,/lowercase forty/);
 }
});
for(const [name,mutate]of Object.entries({oldGraph:f=>{f.graph.freshFactoryVerified=false;},wrongManifest:f=>{f.manifest.factory=a(90);},wrongHash:f=>{f.source.indexedBlockHash=h(999);},partialIndex:f=>{f.source.complete=false;},staleIndex:f=>{f.source.indexedTimestamp-=91;},wrongBudget:f=>{f.source.portfolioFactory=a(90);},behindIndex:f=>{f.source.observedSafeHead=121;},wrongSource:f=>{f.machine.sourceHead='d'.repeat(40);},attestationOnly:f=>{f.machine.attestOnly=true;},oldHeartbeat:f=>{f.machine.checkedAt-=16000;},missingWorker:f=>{delete f.machine.workers.mining;},notDrained:f=>{f.machine.drain.oldSendersDisabled=false;}}))test('product readiness rejects '+name,async()=>{const f=fixture();mutate(f);await assert.rejects(async()=>f.gate()(f.provider,f.graph,f.block));});
test('old graph or extra Factory cannot become fresh via a feature flag',()=>{const f=fixture();f.factories.add(a(999));assert.throws(()=>validateFreshProductBindings(f.config,f.trusted,f.factories),/exactly/);});
for(const [name,change]of Object.entries({wrongPID:p=>{p.pid++;},wrongInvocation:p=>{p.invocationId='c'.repeat(32);},stale:p=>{p.checkedAt-=91000;},future:p=>{p.checkedAt+=1000;},wrongRelease:p=>{p.sourceHead='d'.repeat(40);},dryRun:p=>{p.sendEnabled=false;}}))test('worker heartbeat rejects '+name,()=>{const f=fixture(),p=f.pulse('purchase');change(p);assert.throws(()=>validateFreshWorker(p,{role:'purchase',sourceHead,identity:f.identity,unit:f.unit,now:stamp}));});
test('machine readiness validates live systemd identity, full graph and each heartbeat block',async()=>{
 const f=fixture(),read=createFreshMachineReadiness({provider:f.provider,verifyGraph:async()=>f.graph,sourceHead,now:()=>stamp,readWorker:f.pulse,unitState:async name=>name.includes('-v4-')?f.unit:f.oldUnit,drainOptions:{readDrain:()=>f.drain}});
 assert.equal((await read()).ready,true);f.unit.InvocationID='e'.repeat(32);await assert.rejects(read,/systemd/);
});
test('root drain rejects enabled old service and noncanonical/incorrect-status terminal receipt',async()=>{
 const f=fixture(),opts={readDrain:()=>f.drain,unitState:async()=>f.oldUnit};assert.equal((await verifyFreshLegacyDrain(f.provider,f.identity,opts)).oldSendersDisabled,true);
 f.oldUnit.UnitFileState='enabled';await assert.rejects(verifyFreshLegacyDrain(f.provider,f.identity,opts),/active or enabled/);f.oldUnit.UnitFileState='disabled';
 f.drain.journals[0].phase='reverted';await assert.rejects(verifyFreshLegacyDrain(f.provider,f.identity,opts),/canonical finalized/);
});
test('v4 own pending nonce blocks NEW signing readiness but not existing journal reconciliation',async()=>{
 const f=fixture(),opts={readDrain:()=>f.drain,unitState:async()=>f.oldUnit};f.provider.getTransactionCount=async(_a,tag)=>tag==='pending'?3:2;
 await assert.rejects(verifyFreshLegacyDrain(f.provider,f.identity,opts),/nonce drain/);
 assert.equal((await verifyFreshLegacyDrain(f.provider,f.identity,{...opts,allowCurrentPending:true})).currentNonce,2);
 f.provider.getTransactionCount=async()=>3;assert.equal((await verifyFreshLegacyDrain(f.provider,f.identity,opts)).currentNonce,3);
});
test('machine IPC uses replay-protected HMAC and never produces a wallet signature; origins remain separate',async()=>{
 const f=fixture(),key=Buffer.alloc(32,4),product='https://bemine.example',consoleOrigin='https://console.example';let signatures=0;
 const service={readiness:async()=>f.machine,handle:(_req,res)=>{res.end('{}');}};
 const server=createAuthoritySignerServer(service,key,{machine:{gasWallet:f.identity.gasWallet,origin:product},attestation:{origin:consoleOrigin,wallet:{address:f.identity.gasWallet,signMessage(){signatures++;throw Error('unexpected signature');}}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const transport=(options,callback)=>httpRequest({...options,socketPath:undefined,hostname:'127.0.0.1',port:server.address().port},callback);
 try{const config={socketPath:'/test/readiness.sock',origin:product,key,expectedGasWallet:f.identity.gasWallet};
  const read=createFreshProductReadinessReader(config,{allowTestPath:true,transport});assert.equal((await read()).ready,true);assert.equal(signatures,0);
  await assert.rejects(createFreshProductReadinessReader({...config,origin:consoleOrigin},{allowTestPath:true,transport})(),/not ready/);
  service.readiness=null;await assert.rejects(read,/not ready/);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('fresh public relay POST requires current graph/index readiness; GET recovery remains available',async()=>{
 const key=Buffer.alloc(32,7),account=a(22),origin='https://bemine.example';let forwarded=0,ready=false;
 const signer=createAuthoritySignerServer({handle(req,res){forwarded++;res.end(JSON.stringify({status:'pending'}));}},key);
 await new Promise(resolve=>signer.listen(0,'127.0.0.1',resolve));
 const config={socketPath:'/test/relay.sock',origin,key,freshProductRequired:true};
 assert.throws(()=>createAuthorityRelayProxy(config),/independent graph and index/);
 const proxy=createAuthorityRelayProxy(config,{store:{session:()=>account,close(){}},verifyAdministrator:async()=>{},verifyOperationalReadiness:async()=>{if(!ready)throw Error('index stale');},
 transport:(options,callback)=>httpRequest({...options,socketPath:undefined,hostname:'127.0.0.1',port:signer.address().port},callback)});
 const {createServer}=await import('node:http'),server=createServer((req,res)=>proxy.handle(req,res));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}/api/journal/authority-relay`,headers={origin,cookie:'pinkuang_journal='+'a'.repeat(43),'x-pinkuang-account':account,'content-type':'application/json'};
 try{assert.equal((await fetch(base,{method:'POST',headers,body:'{}'})).status,503);assert.equal(forwarded,0);
 assert.equal((await fetch(base+'/status',{headers})).status,200);assert.equal(forwarded,1);
 ready=true;assert.equal((await fetch(base,{method:'POST',headers,body:'{}'})).status,200);assert.equal(forwarded,2);
 }finally{await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>signer.close(resolve));proxy.close();}
});


test('the shared zero-value exit list cannot admit deposits, new orders, purchases or operator calls',()=>{
 for(const [type,names]of Object.entries(FRESH_USER_EXIT_ACTIONS))for(const name of names){assert.equal(isFreshUserExit(type,name,'0'),true);assert.equal(isFreshUserExit(type,name,'1'),false);}
 for(const [type,name]of [['pool','deposit'],['market','list'],['market','fill'],['portfolio','buyOfficial'],['portfolio','buyFirsto'],['portfolio','transfer'],['factory','createPool'],['pool','mine'],['pool','cancel'],['portfolioFactory','withdrawBnb']])assert.equal(isFreshUserExit(type,name,'0'),false);
 assert.equal(isFreshUserExit('__proto__','claim','0'),false);
});

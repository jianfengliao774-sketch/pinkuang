import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {JournalStore} from './journal-store.mjs';
import {createJournalService} from './journal-api.mjs';
import {fixture as deployment} from '../ops/v4/fresh-cutover-fixture.mjs';
import {createFreshIndexManifest} from './chain-index/fresh-manifest.mjs';
const h=n=>'0x'+n.toString(16).padStart(64,'0'),a=n=>'0x'+n.toString(16).padStart(40,'0');
test('durable budget queue supports creating, created, buying, completed without erasing creation proof',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fresh-queue-'));chmodSync(dir,0o700);const store=new JournalStore(join(dir,'journal.sqlite'));
 let plan={id:'queue',revision:0,approved:true,approvalDigest:h(1),items:[{status:'ready'}]},revision=0;
 const put=patch=>{const next=structuredClone(plan);next.revision++;Object.assign(next.items[0],patch);revision=store.putBudgetQueue(a(1),a(2),next,revision);plan=next;};
 try{
 revision=store.putBudgetQueue(a(1),a(2),plan,revision);put({status:'creating',intent:{kind:'create'}});
 put({status:'pending',hash:h(2),nonce:5,pendingPhase:'create'});
 put({status:'created',child:a(3),creationHash:h(2),lastResult:{status:'confirmed',hash:h(2),nonce:5},intent:undefined,pendingPhase:undefined});
 const created=structuredClone(plan);put({status:'buying',hash:undefined,nonce:undefined,intent:{kind:'buy'},pendingPhase:'purchase'});
 assert.equal(store.budgetQueue(a(1),a(2)).record.items[0].creationHash,h(2));
 const bad=structuredClone(plan);bad.revision++;delete bad.items[0].creationHash;assert.throws(()=>store.putBudgetQueue(a(1),a(2),bad,revision),/creation hash/);
 put({status:'pending',hash:h(3),nonce:6});put({status:'completed',purchaseHash:h(3),lastResult:{status:'confirmed',hash:h(3),nonce:6}});
 assert.equal(store.budgetQueue(a(1),a(2)).record.items[0].purchaseHash,h(3));
 const rewind={...created,revision:plan.revision+1};assert.throws(()=>store.putBudgetQueue(a(1),a(2),rewind,revision),/regress/);
 }finally{store.close();rmSync(dir,{recursive:true});}
});
test('new product HTTP instance blocks deployment and activation before any wallet session',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fresh-product-http-'));chmodSync(dir,0o700);const f=deployment();
 const activationPath=join(dir,'activation.json');writeFileSync(activationPath,JSON.stringify(f.activation));
 const manifest=createFreshIndexManifest(f.manifest);
 const service=createJournalService({dbPath:join(dir,'journal.sqlite'),origin:'https://bemine.example',
 currentArtifactDigest:()=>f.record.artifactDigest,allowedProductFactories:[f.record.addresses.factory,f.record.addresses.portfolioFactory],
 productDeploymentRecord:f.record,productArtifactBundle:f.bundle,freshActivationEvidencePath:activationPath,
 expectedGasWallet:f.expectedGasWallet,freshProduct:{manifest,sourceHead:'a'.repeat(40),indexUrl:'http://127.0.0.1:4184/health'},freshProductReadinessReader:async()=>{throw Error('not active');}});
 const server=createServer((req,res)=>service.handle(req,res));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{for(const path of ['deployment','deployment/import-archive','fresh-activation','fresh-activation/config']){
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/journal/${path}`);assert.equal(response.status,403);assert.match((await response.json()).error,/public product/);
 }}finally{await new Promise(resolve=>server.close(resolve));await service.close();rmSync(dir,{recursive:true});}
});

test('fresh display traffic reuses one readiness check; explicit operational permission still checks again',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fresh-display-cache-'));chmodSync(dir,0o700);const f=deployment();
 const activationPath=join(dir,'activation.json');writeFileSync(activationPath,JSON.stringify(f.activation));
 const manifest=createFreshIndexManifest(f.manifest), stamp=2_000_000_000_000;
 const block={number:210,hash:h(210),timestamp:stamp/1000};let checks=0,reads=0;
 const source={chainId:56,complete:true,factory:manifest.factory,market:manifest.shareMarket,
  portfolioFactory:manifest.portfolioFactory,portfolioMarket:manifest.portfolioMarket,
  startBlock:115,indexedThrough:210,observedSafeHead:210,indexedBlockHash:block.hash,indexedTimestamp:stamp/1000};
 const index=createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({source}));});
 await new Promise(r=>index.listen(0,'127.0.0.1',r));
 const graph={factory:manifest.factory,blockNumber:block.number,artifactDigest:f.record.artifactDigest,
  addresses:f.record.addresses,codehash:Object.fromEntries(Object.entries(f.record.verification.code).map(([k,v])=>[k,v.codehash])),
  freshFactoryVerified:true,freshAuthority:{...manifest.freshAuthority,activationBlock:206,activationHash:h(306)}};
 const service=createJournalService({dbPath:join(dir,'journal.sqlite'),origin:'https://bemine.example',now:()=>stamp,
  currentArtifactDigest:()=>f.record.artifactDigest,allowedProductFactories:[manifest.factory,manifest.portfolioFactory],
  productDeploymentRecord:f.record,productArtifactBundle:f.bundle,freshActivationEvidencePath:activationPath,
  expectedGasWallet:f.expectedGasWallet,
  provider:{send:async()=>{reads++;return '0x38';},getBlock:async tag=>{reads++;return tag===206?{number:206,hash:h(306),timestamp:stamp/1000-1}:block;}},
  productGraphVerifier:async()=>graph,
  freshProduct:{manifest,sourceHead:'a'.repeat(40),indexUrl:`http://127.0.0.1:${index.address().port}/health`},
  freshProductReadinessReader:async()=>{checks++;throw Error('worker unavailable');}});
 const server=createServer((req,res)=>service.handle(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {
  const url=`http://127.0.0.1:${server.address().port}/api/journal/product-graph`;
  const first=await (await fetch(url)).json();assert.equal(first.stage,'fresh-active');assert.equal(first.operationalReady,false);
  assert.equal(checks,1);const before=reads;
  const visitors=await Promise.all(Array.from({length:12},async()=>{const r=await fetch(url);assert.equal(r.status,200);return r.json();}));
  assert(visitors.every(v=>v.readMode==='current' && !v.operationalReady));
  assert.equal(checks,1);assert.equal(reads,before,'cached visitors perform no upstream RPC');
  await assert.rejects(service.verifyFreshOperationalReadiness(),/worker unavailable/);
  assert.equal(checks,2,'cached display cannot grant fresh operational permission');
 }finally{await new Promise(r=>server.close(r));await service.close();await new Promise(r=>index.close(r));rmSync(dir,{recursive:true});}
});

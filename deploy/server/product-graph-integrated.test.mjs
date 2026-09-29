import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Interface, getAddress } from 'ethers';
import { productGraphConfiguration, verifyProductGraph } from './product-graph.mjs';
import { createJournalService, isTransientProductRpcFailure } from './journal-api.mjs';
import { buildDigest } from '../shared/firsto-upgrade-proof.mjs';
import { buildIntegratedUpgradePlan, buildIntegratedProposerBootstrapPlan,
  buildIntegratedRoleMigrationPlan, integratedUpgradeDeploymentOrder } from '../shared/integrated-upgrade-plan.mjs';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const genesisRecord = read('../public/upgrade-genesis/genesis-record.json');
const genesisBundle = read('../public/upgrade-genesis/genesis-artifacts.json');
const genesisManifest = read('../../web/public/data/frontend-manifest.json');
// Tests must use the source-pinned artifact, not a possibly stale local build.
const candidateBundle = read('../public/deployment-artifacts.json');
const addr = number => getAddress(`0x${number.toString(16).padStart(40, '0')}`);
const salt = digit => `0x${digit.repeat(64)}`;
const replacements = Object.fromEntries(integratedUpgradeDeploymentOrder.map((name, index) =>
  [name, addr(10_000 + index)]));

test('product graph treats transport and JSON-RPC server failures as transient, not identity drift',()=>{
  for(const error of [
    {code:'NETWORK_ERROR'},
    {code:'SERVER_ERROR',info:{error:{code:-32000,message:'header not found'}}},
    {code:'SERVER_ERROR',error:{code:-32603,message:'internal error'}},
    {code:'SERVER_ERROR',info:{responseStatus:'429 Too Many Requests'}},
    {code:'SERVER_ERROR',status:500},
    {code:'SERVER_ERROR',response:{status:503}},
  ]) assert.equal(isTransientProductRpcFailure(error),true);
  assert.equal(isTransientProductRpcFailure({code:'CALL_EXCEPTION',error:{code:3}}),false);
  assert.equal(isTransientProductRpcFailure({code:'SERVER_ERROR',status:400}),false);
});

function fixture() {
  const plan = buildIntegratedUpgradePlan({ genesisRecord, genesisBundle,
    trustedGenesisManifest: genesisManifest, upgradeBundle: candidateBundle,
    trustedUpgradeArtifactDigest: buildDigest(candidateBundle), replacements,
    salt: salt('1'), delaySeconds: 172800 });
  const bootstrapPlan = buildIntegratedProposerBootstrapPlan({ genesisRecord, genesisBundle,
    trustedGenesisManifest: genesisManifest, hardwareWallet: addr(20_000),
    salt: salt('2'), delaySeconds: 172800 });
  const evidence = { plan, bootstrapPlan };
  const configuration = () => productGraphConfiguration({ record: genesisRecord, bundle: genesisBundle,
    integratedUpgradeEvidence: evidence, integratedUpgradeArtifact: candidateBundle,
    genesisManifest });
  return { evidence, configuration };
}

test('integrated product graph retains the genesis runtime and pins a separate upgrade build', () => {
  const { evidence, configuration } = fixture();
  const trusted = configuration();
  assert.equal(trusted.record.artifactDigest, genesisRecord.artifactDigest);
  assert.equal(trusted.bundle.artifacts.PoolFactory.bytecode, genesisBundle.artifacts.PoolFactory.bytecode);
  assert.equal(trusted.integratedUpgrade.digest, buildDigest(candidateBundle));
  assert.equal(trusted.integratedUpgrade.plan.operationId, evidence.plan.operationId);
  evidence.plan.salt = salt('3');
  assert.equal(trusted.integratedUpgrade.plan.salt, salt('1'), 'caller cannot mutate the trusted plan');
  assert.throws(configuration, /differs from the reviewed server evidence/);
});

test('integrated product graph rejects a changed genesis, candidate, manifest or hardware bootstrap', () => {
  const { evidence } = fixture();
  const options = { record: genesisRecord, bundle: genesisBundle,
    integratedUpgradeEvidence: evidence, integratedUpgradeArtifact: candidateBundle, genesisManifest };
  const changedRecord = structuredClone(genesisRecord); changedRecord.artifactDigest = salt('4');
  assert.throws(() => productGraphConfiguration({ ...options, record: changedRecord }), /completed, verified/);
  const changedCandidate = structuredClone(candidateBundle); changedCandidate.artifacts.PoolFactory.bytecode += '00';
  assert.throws(() => productGraphConfiguration({ ...options, integratedUpgradeArtifact: changedCandidate }), /digest|reviewed/);
  const changedManifest = structuredClone(genesisManifest); changedManifest.factory = addr(44_000);
  assert.throws(() => productGraphConfiguration({ ...options, genesisManifest: changedManifest }), /Genesis factory/);
  const changedEvidence = structuredClone(evidence); changedEvidence.bootstrapPlan.hardwareWallet = addr(55_000);
  assert.throws(() => productGraphConfiguration({ ...options, integratedUpgradeEvidence: changedEvidence }),
    /bootstrap differs/);
});

test('an independently pinned Authority plan requires the approved administrators and exact deployment hash', () => {
  const { evidence } = fixture();
  evidence.rolePlan = buildIntegratedRoleMigrationPlan({ genesisRecord, codePlan: evidence.plan,
    bootstrapPlan: evidence.bootstrapPlan, authorityAddress: addr(30_000),
    hardwareWallet: evidence.bootstrapPlan.hardwareWallet, salt: salt('3'), delaySeconds: 172800 });
  const opts = { record: genesisRecord, bundle: genesisBundle,
    integratedUpgradeEvidence: evidence, integratedUpgradeArtifact: candidateBundle, genesisManifest };
  assert.throws(() => productGraphConfiguration(opts), /Authority requires a reviewed deployment/);
  evidence.authority = { address: addr(30_000), deploymentTxHash: salt('4'),
    administratorOne: '0x7674fa446D42b1f7f150DC5e678cc525d275Ea53',
    administratorTwo: '0xeD2FCBe59EBe1754a3676aeb9CcfBA20f193FcbB', gasWallet: addr(40_000) };
  assert.equal(productGraphConfiguration(opts).integratedUpgrade.rolePlan.authorityAddress, addr(30_000));
  evidence.authority.administratorOne = addr(99_000);
  assert.throws(() => productGraphConfiguration(opts), /administrators differ/);
});

test('unknown Factory implementation fails before any other product read', async () => {
  const trusted = fixture().configuration();
  let reads = 0;
  const provider = { async getStorage() { reads++; return `0x${addr(888_888).slice(2).padStart(64, '0')}`; },
    async send() { throw new Error('unexpected eth_call'); },
    async getCode() { throw new Error('unexpected eth_getCode'); } };
  await assert.rejects(verifyProductGraph(provider, genesisRecord.addresses.factory, trusted,
    { number: 1, hash: salt('5') }), /neither the reviewed genesis nor the reviewed upgrade/);
  assert.equal(reads, 1);
});

test('public product-graph response is pinned to a verified block and never falls back to an unreviewed digest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'product-graph-api-'));
  const { evidence } = fixture();
  const initial=genesisRecord.steps.find(step=>step.id==='initialize');
  const block = { number: initial.receipt.blockNumber+100, hash: salt('6'), timestamp: 1_700_000_100 };
  let finalized=block;
  let clock=1_000_000;
  const provider = { async send(method) { assert.equal(method, 'eth_chainId'); return '0x38'; },
    async getBlock(tag) {
      if (tag === 'finalized' || tag === finalized.number) return finalized;
      if (tag === block.number) return block;
      if (tag === initial.receipt.blockNumber) return {
        number:tag,hash:initial.receipt.blockHash,timestamp:1_700_000_000};
      throw new Error(`Unexpected block ${tag}`);
    } };
  const addresses = genesisRecord.addresses;
  let verifiedDigest = genesisRecord.artifactDigest;
  let invalidVerification;
  const invalidReached=new Promise(resolve=>{invalidVerification=resolve;});
  const service = createJournalService({ dbPath: join(directory, 'private', 'journal.sqlite'),
    origin: 'http://127.0.0.1:4173', provider, now:()=>clock,
    currentArtifactDigest: () => genesisRecord.artifactDigest,
    productDeploymentRecord: genesisRecord, productArtifactBundle: genesisBundle,
    integratedUpgradeEvidence: evidence, integratedUpgradeArtifact: candidateBundle, genesisManifest,
    allowedProductFactories: [addresses.factory, addresses.portfolioFactory],
    productGraphVerifier: async (_provider, factory, confirmedBlock) => {
      assert.equal(factory, addresses.factory);
      assert.deepEqual(confirmedBlock, finalized);
      if (verifiedDigest !== genesisRecord.artifactDigest) invalidVerification();
      return { factory, blockNumber: finalized.number, artifactDigest: verifiedDigest,
        addresses, codehash: Object.fromEntries(Object.entries(genesisRecord.verification.code)
          .map(([name, value]) => [name, value.codehash])) };
    } });
  const server = createServer((req, res) => service.handle(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/journal/product-graph`;
    const valid = await fetch(base);
    assert.equal(valid.status, 200);
    const payload = await valid.json();
    assert.equal(payload.stage, 'genesis');
    assert.equal(payload.upgradeArtifactDigest, buildDigest(candidateBundle));
    assert.equal(payload.reviewedUpgradeOperationId, evidence.plan.operationId);
    assert.equal(payload.reviewedBootstrapOperationId, evidence.bootstrapPlan.operationId);
    assert.equal(payload.operationId, null);
    assert.equal(payload.manifest.artifactDigest, genesisRecord.artifactDigest);
    assert.equal(payload.manifest.deployment.txHash,
      genesisRecord.steps.find(step => step.id === 'initialize').txHash);
    assert.equal(payload.manifest.codehash.factory,
      genesisRecord.verification.code.factory.codehash);
    assert.equal(payload.stageActivationBlock,initial.receipt.blockNumber);
    assert.equal(payload.stageActivationHash,initial.receipt.blockHash);
    clock+=100;
    assert.equal((await (await fetch(base)).json()).snapshotAgeMs,100,
      'read-only bootstrap may reuse a bounded verified snapshot');
    assert.equal((await fetch(`${base}?pool=${addresses.factory}`)).status, 400);
    verifiedDigest = salt('7');
    clock+=45_000;finalized={...block,number:block.number+1,hash:salt('8')};
    const stale=await (await fetch(base)).json();
    assert.equal(stale.readMode,'verified_snapshot');
    assert.equal(stale.stale,true);
    assert.equal(stale.transactionReady,false);
    assert.equal(stale.operationalReady,false);
    assert.equal(stale.verifiedBlockHash,block.hash,'old verified block remains explicitly historical');
    await invalidReached;
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal((await fetch(base)).status,503,'failed refresh invalidates the old graph');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('expired verified graph returns immediately as display-only while one new proof runs', async () => {
  const directory=await mkdtemp(join(tmpdir(),'product-graph-refresh-api-'));
  const initial=genesisRecord.steps.find(step=>step.id==='initialize');
  const first={number:initial.receipt.blockNumber+100,hash:salt('6'),timestamp:1_700_000_100};
  const next={number:first.number+1,hash:salt('7'),timestamp:first.timestamp+3};
  let finalized=first,clock=1_000_000,verifications=0,rejectGraph=false;
  let releaseSecond,secondStarted,secondActivationRead;
  const secondGate=new Promise(resolve=>{releaseSecond=resolve;});
  const secondProofStarted=new Promise(resolve=>{secondStarted=resolve;});
  const secondActivation=new Promise(resolve=>{secondActivationRead=resolve;});
  const addresses=genesisRecord.addresses;
  const codehash=Object.fromEntries(Object.entries(genesisRecord.verification.code)
    .map(([name,value])=>[name,value.codehash]));
  const provider={async send(method){assert.equal(method,'eth_chainId');return '0x38';},
    async getBlock(tag){
      if(tag==='finalized')return finalized;
      if(tag===first.number)return first;
      if(tag===next.number)return next;
      if(tag===initial.receipt.blockNumber){
        if(verifications===2)secondActivationRead();
        return {number:tag,hash:initial.receipt.blockHash,timestamp:first.timestamp-100};
      }
      throw new Error(`Unexpected block ${tag}`);
    }};
  const service=createJournalService({dbPath:join(directory,'private','journal.sqlite'),
    origin:'http://127.0.0.1:4173',provider,now:()=>clock,
    currentArtifactDigest:()=>genesisRecord.artifactDigest,
    productDeploymentRecord:genesisRecord,productArtifactBundle:genesisBundle,
    allowedProductFactories:[addresses.factory,addresses.portfolioFactory],
    productGraphVerifier:async (_provider,factory,block)=>{
      verifications++;
      if(verifications===2){secondStarted();await secondGate;}
      if(rejectGraph)throw Object.assign(new Error('Temporary RPC timeout'),{code:'ETIMEDOUT'});
      return {factory,blockNumber:block.number,artifactDigest:genesisRecord.artifactDigest,
        addresses,codehash};
    }});
  const server=createServer((req,res)=>service.handle(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const url=`http://127.0.0.1:${server.address().port}/api/journal/product-graph`;
    const firstRead=await (await fetch(url)).json();
    assert.equal(firstRead.readMode,'current');
    assert.equal(firstRead.stale,false);
    const cachedReads=await Promise.all(Array.from({length:8},()=>fetch(url)));
    assert.ok(cachedReads.every(response=>response.status===200),
      'cached verified reads from one NAT address must not consume the proof quota');
    assert.equal(verifications,1);
    clock+=45_000;finalized=next;
    const response=await fetch(url,{signal:AbortSignal.timeout(1_000)});
    assert.equal(response.status,200,'refresh must not block the display');
    const stale=await response.json();
    assert.equal(stale.readMode,'verified_snapshot');
    assert.equal(stale.verifiedBlockHash,first.hash);
    assert.equal(stale.snapshotAgeMs,45_000);
    assert.equal(stale.refreshing,true);
    assert.equal(stale.transactionReady,false);
    assert.equal(stale.operationalReady,false);
    await secondProofStarted;
    const staleReads=await Promise.all(Array.from({length:8},()=>fetch(url)));
    assert.ok(staleReads.every(response=>response.status===200),
      'stale verified display reads from one NAT address must remain available');
    for(const response of staleReads){
      const graph=await response.json();
      assert.equal(graph.stale,true);
      assert.equal(graph.transactionReady,false);
    }
    assert.equal(verifications,2,'concurrent stale reads share one proof');
    releaseSecond();
    await secondActivation;
    await new Promise(resolve=>setImmediate(resolve));
    const fresh=await (await fetch(url)).json();
    assert.equal(fresh.readMode,'current');
    assert.equal(fresh.stale,false);
    assert.equal(fresh.verifiedBlockHash,next.hash);
    clock+=120_000;
    const aged=await (await fetch(url,{headers:{'x-real-ip':'127.0.0.2'}})).json();
    assert.equal(aged.readMode,'current','a snapshot beyond the stale bound must wait for a new proof');
    assert.equal(verifications,3);
    rejectGraph=true;clock+=120_000;
    const missHeaders={'x-real-ip':'198.51.100.42'};
    for(let index=0;index<4;index++)
      assert.equal((await fetch(url,{headers:missHeaders})).status,503,
        'each uncached proof attempt must fail closed on RPC timeout');
    assert.equal((await fetch(url,{headers:missHeaders})).status,429,
      'uncached proof attempts remain bounded per client');
  }finally{
    releaseSecond();
    await new Promise(resolve=>server.close(resolve));
    await service.close();
    await rm(directory,{recursive:true,force:true});
  }
});

test('recent product visitor gets a warm graph, while a first visitor after idle waits for a new proof', async () => {
  const directory=await mkdtemp(join(tmpdir(),'product-graph-timer-api-'));
  const initial=genesisRecord.steps.find(step=>step.id==='initialize');
  const first={number:initial.receipt.blockNumber+100,hash:salt('6'),timestamp:1_700_000_100};
  const next={number:first.number+1,hash:salt('7'),timestamp:first.timestamp+3};
  const afterIdle={number:next.number+1,hash:salt('8'),timestamp:next.timestamp+3};
  let finalized=first,clock=1_000_000,verifications=0,resolveNext;
  const nextProof=new Promise(resolve=>{resolveNext=resolve;});
  const addresses=genesisRecord.addresses;
  const codehash=Object.fromEntries(Object.entries(genesisRecord.verification.code)
    .map(([name,value])=>[name,value.codehash]));
  const provider={async send(method){assert.equal(method,'eth_chainId');return '0x38';},
    async getBlock(tag){
      if(tag==='finalized')return finalized;
      if(tag===first.number)return first;
      if(tag===next.number)return next;
      if(tag===afterIdle.number)return afterIdle;
      if(tag===initial.receipt.blockNumber)
        return {number:tag,hash:initial.receipt.blockHash,timestamp:first.timestamp-100};
      throw new Error(`Unexpected block ${tag}`);
    }};
  const service=createJournalService({dbPath:join(directory,'private','journal.sqlite'),
    origin:'http://127.0.0.1:4173',provider,now:()=>clock,productGraphRefreshMs:100,
    currentArtifactDigest:()=>genesisRecord.artifactDigest,
    productDeploymentRecord:genesisRecord,productArtifactBundle:genesisBundle,
    allowedProductFactories:[addresses.factory,addresses.portfolioFactory],
    productGraphVerifier:async(_provider,factory,block)=>{
      verifications++;
      if(block.number===next.number)resolveNext();
      return {factory,blockNumber:block.number,artifactDigest:genesisRecord.artifactDigest,
        addresses,codehash};
    }});
  const server=createServer((req,res)=>service.handle(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const url=`http://127.0.0.1:${server.address().port}/api/journal/product-graph`;
    assert.equal((await(await fetch(url)).json()).verifiedBlockHash,first.hash);
    clock+=45_000;finalized=next;
    const timeout=setTimeout(()=>resolveNext(new Error('background refresh did not start')),1_000);
    const result=await nextProof;
    clearTimeout(timeout);
    if(result instanceof Error)throw result;
    await new Promise(resolve=>setImmediate(resolve));
    const current=await(await fetch(url)).json();
    assert.equal(current.readMode,'current');
    assert.equal(current.verifiedBlockHash,next.hash);
    assert.equal(verifications,2,'no visitor request was needed to trigger the next proof');
    clock+=120_001;finalized=afterIdle;
    await new Promise(resolve=>setTimeout(resolve,220));
    assert.equal(verifications,2,'idle traffic must not trigger another full graph proof');
    const firstAfterIdle=await(await fetch(url)).json();
    assert.equal(firstAfterIdle.readMode,'current');
    assert.equal(firstAfterIdle.stale,false);
    assert.equal(firstAfterIdle.verifiedBlockHash,afterIdle.hash);
    assert.equal(verifications,3,'the first visitor after idle waits for a new verified graph');
  }finally{
    await new Promise(resolve=>server.close(resolve));
    await service.close();
    await rm(directory,{recursive:true,force:true});
  }
});

test('a bounded public budget proof cannot consume the site graph refresh slot', async () => {
  const directory=await mkdtemp(join(tmpdir(),'product-graph-budget-cap-api-'));
  const initial=genesisRecord.steps.find(step=>step.id==='initialize');
  const first={number:initial.receipt.blockNumber+100,hash:salt('6'),timestamp:1_700_000_100};
  const budgetBlocks=[1,2].map(offset=>({number:first.number+offset,
    hash:salt(String(offset)),timestamp:first.timestamp+offset}));
  const next={number:first.number+3,hash:salt('7'),timestamp:first.timestamp+3};
  const addresses=genesisRecord.addresses,parent=addr(61_000);
  const identityAbi=new Interface(['function isPool(address) view returns(bool)',
    'function OFFICIAL_FACTORY() view returns(address)']);
  const codehash=Object.fromEntries(Object.entries(genesisRecord.verification.code)
    .map(([name,value])=>[name,value.codehash]));
  let finalized=first,clock=1_000_000,budgetProofs=0,siteProofs=0;
  let releaseBudget,resolveBudgetStarted;
  const budgetGate=new Promise(resolve=>{releaseBudget=resolve;});
  const budgetStarted=new Promise(resolve=>{resolveBudgetStarted=resolve;});
  const blocks=new Map([first,...budgetBlocks,next].map(block=>[block.number,block]));
  const provider={async send(method,args){
      if(method==='eth_chainId')return '0x38';
      assert.equal(method,'eth_call');
      const [{to,data}]=args,call=identityAbi.parseTransaction({data});
      if(call.name==='isPool'){
        assert.equal(to.toLowerCase(),addresses.portfolioFactory.toLowerCase());
        return identityAbi.encodeFunctionResult('isPool',[true]);
      }
      assert.equal(to.toLowerCase(),parent.toLowerCase());
      return identityAbi.encodeFunctionResult('OFFICIAL_FACTORY',[addresses.portfolioFactory]);
    },
    async getCode(address){return address.toLowerCase()===parent.toLowerCase()?'0x1234':'0x';},
    async getBlock(tag){
      if(tag==='finalized')return finalized;
      if(tag==='latest')return {number:next.number+1,hash:salt('8'),timestamp:next.timestamp+3};
      if(tag===initial.receipt.blockNumber)
        return {number:tag,hash:initial.receipt.blockHash,timestamp:first.timestamp-100};
      return blocks.get(tag)??null;
    }};
  const service=createJournalService({dbPath:join(directory,'private','journal.sqlite'),
    origin:'http://127.0.0.1:4173',provider,now:()=>clock,
    currentArtifactDigest:()=>genesisRecord.artifactDigest,
    productDeploymentRecord:genesisRecord,productArtifactBundle:genesisBundle,
    allowedProductFactories:[addresses.factory,addresses.portfolioFactory],
    productGraphVerifier:async(_provider,factory,block)=>{
      if(factory.toLowerCase()===addresses.portfolioFactory.toLowerCase()){
        budgetProofs++;
        if(budgetProofs===1)resolveBudgetStarted();
        await budgetGate;
        throw new Error('Held candidate proof released');
      }
      siteProofs++;
      return {factory,blockNumber:block.number,artifactDigest:genesisRecord.artifactDigest,
        addresses,codehash};
    }});
  const server=createServer((req,res)=>service.handle(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const pending=[];
  try{
    const graphUrl=`${base}/api/journal/product-graph`;
    assert.equal((await(await fetch(graphUrl)).json()).verifiedBlockHash,first.hash);
    const firstBudget=budgetBlocks[0];
    pending.push(fetch(`${base}/api/journal/budget-candidates?parent=${parent}&block=${firstBudget.number}&hash=${firstBudget.hash}`,
      {headers:{'X-Real-IP':'198.51.100.1'}}));
    await budgetStarted;
    const secondBudget=budgetBlocks[1];
    const denied=await fetch(`${base}/api/journal/budget-candidates?parent=${parent}&block=${secondBudget.number}&hash=${secondBudget.hash}`,
      {headers:{'X-Real-IP':'198.51.100.2'}});
    assert.equal(denied.status,503,'budget proofs have one active slot even across public clients');
    assert.equal(budgetProofs,1);
    clock+=45_000;finalized=next;
    assert.equal((await(await fetch(graphUrl)).json()).readMode,'verified_snapshot');
    await new Promise(resolve=>setImmediate(resolve));
    const refreshed=await(await fetch(graphUrl)).json();
    assert.equal(refreshed.readMode,'current');
    assert.equal(refreshed.verifiedBlockHash,next.hash);
    assert.equal(siteProofs,2,'site graph proof runs despite the occupied candidate slots');
  }finally{
    releaseBudget();
    await Promise.allSettled(pending);
    await new Promise(resolve=>server.close(resolve));
    await service.close();
    await rm(directory,{recursive:true,force:true});
  }
});

test('a transient RPC outage retains only the original two-minute display snapshot', async () => {
  const directory=await mkdtemp(join(tmpdir(),'product-graph-transient-api-'));
  const initial=genesisRecord.steps.find(step=>step.id==='initialize');
  const block={number:initial.receipt.blockNumber+100,hash:salt('6'),timestamp:1_700_000_100};
  let clock=1_000_000,offline=false,verifications=0,offlineReads=0,failedRead;
  const failureReached=new Promise(resolve=>{failedRead=resolve;});
  const addresses=genesisRecord.addresses;
  const codehash=Object.fromEntries(Object.entries(genesisRecord.verification.code)
    .map(([name,value])=>[name,value.codehash]));
  const provider={async send(method){assert.equal(method,'eth_chainId');return '0x38';},
    async getBlock(tag){
      if(tag==='finalized' && offline){
        offlineReads++;
        failedRead();
        throw Object.assign(new Error('RPC header not found'),
          {code:'SERVER_ERROR',info:{error:{code:-32000,message:'header not found'}}});
      }
      if(tag==='finalized'||tag===block.number)return block;
      if(tag===initial.receipt.blockNumber)
        return {number:tag,hash:initial.receipt.blockHash,timestamp:block.timestamp-100};
      throw new Error(`Unexpected block ${tag}`);
    }};
  const service=createJournalService({dbPath:join(directory,'private','journal.sqlite'),
    origin:'http://127.0.0.1:4173',provider,now:()=>clock,
    currentArtifactDigest:()=>genesisRecord.artifactDigest,
    productDeploymentRecord:genesisRecord,productArtifactBundle:genesisBundle,
    allowedProductFactories:[addresses.factory,addresses.portfolioFactory],
    productGraphVerifier:async (_provider,factory,confirmedBlock)=>{
      verifications++;
      return {factory,blockNumber:confirmedBlock.number,
        artifactDigest:genesisRecord.artifactDigest,addresses,codehash};
    }});
  const server=createServer((req,res)=>service.handle(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const url=`http://127.0.0.1:${server.address().port}/api/journal/product-graph`;
    assert.equal((await (await fetch(url)).json()).readMode,'current');
    clock+=45_000;offline=true;
    assert.equal((await (await fetch(url)).json()).readMode,'verified_snapshot');
    await failureReached;
    await new Promise(resolve=>setImmediate(resolve));
    const retained=await (await fetch(url)).json();
    assert.equal(retained.readMode,'verified_snapshot');
    assert.equal(retained.stale,true);
    assert.equal(retained.verifiedBlockHash,block.hash);
    assert.equal(retained.transactionReady,false);
    assert.equal(retained.operationalReady,false);
    assert.equal(retained.refreshing,false);
    assert.equal(retained.snapshotAgeMs,45_000,'failed refresh must not renew the snapshot age');
    assert.equal(verifications,1);
    const staleReads=await Promise.all(Array.from({length:8},()=>fetch(url)));
    assert.ok(staleReads.every(response=>response.status===200));
    assert.equal(offlineReads,1,'stale display traffic cannot repeatedly start a fast-failing proof');
    clock=1_000_000+2*60_000;
    assert.equal((await fetch(url)).status,503,'a network outage cannot extend the two-minute bound');
  }finally{
    await new Promise(resolve=>server.close(resolve));
    await service.close();
    await rm(directory,{recursive:true,force:true});
  }
});

test('a temporarily missing reviewed anchor keeps only the bounded display snapshot', async () => {
  const directory=await mkdtemp(join(tmpdir(),'product-graph-anchor-api-'));
  const initial=genesisRecord.steps.find(step=>step.id==='initialize');
  const block={number:initial.receipt.blockNumber+100,hash:salt('6'),timestamp:1_700_000_100};
  let clock=1_000_000,missing=false,resolveMissing;
  const missingRead=new Promise(resolve=>{resolveMissing=resolve;});
  const addresses=genesisRecord.addresses;
  const codehash=Object.fromEntries(Object.entries(genesisRecord.verification.code)
    .map(([name,value])=>[name,value.codehash]));
  const provider={async send(method){assert.equal(method,'eth_chainId');return '0x38';},
    async getBlock(tag){
      if(tag==='finalized')return block;
      if(tag===block.number){if(missing){resolveMissing();return null;}return block;}
      if(tag===initial.receipt.blockNumber)
        return {number:tag,hash:initial.receipt.blockHash,timestamp:block.timestamp-100};
      throw new Error(`Unexpected block ${tag}`);
    }};
  const service=createJournalService({dbPath:join(directory,'private','journal.sqlite'),
    origin:'http://127.0.0.1:4173',provider,now:()=>clock,
    currentArtifactDigest:()=>genesisRecord.artifactDigest,
    productDeploymentRecord:genesisRecord,productArtifactBundle:genesisBundle,
    allowedProductFactories:[addresses.factory,addresses.portfolioFactory],
    productGraphVerifier:async(_provider,factory,confirmedBlock)=>({factory,
      blockNumber:confirmedBlock.number,artifactDigest:genesisRecord.artifactDigest,addresses,codehash})});
  const server=createServer((req,res)=>service.handle(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const url=`http://127.0.0.1:${server.address().port}/api/journal/product-graph`;
    assert.equal((await(await fetch(url)).json()).readMode,'current');
    missing=true;clock+=45_000;
    assert.equal((await(await fetch(url)).json()).readMode,'verified_snapshot');
    await missingRead;
    await new Promise(resolve=>setImmediate(resolve));
    const retained=await(await fetch(url)).json();
    assert.equal(retained.readMode,'verified_snapshot');
    assert.equal(retained.transactionReady,false);
    assert.equal(retained.snapshotAgeMs,45_000);
    clock=1_000_000+2*60_000;
    assert.equal((await fetch(url)).status,503,'missing RPC data cannot extend the two-minute bound');
  }finally{
    await new Promise(resolve=>server.close(resolve));
    await service.close();
    await rm(directory,{recursive:true,force:true});
  }
});

test('wrong RPC chain ID invalidates a prior display snapshot rather than treating it as an outage', async () => {
  const directory=await mkdtemp(join(tmpdir(),'product-graph-chain-id-api-'));
  const initial=genesisRecord.steps.find(step=>step.id==='initialize');
  const block={number:initial.receipt.blockNumber+100,hash:salt('8'),timestamp:1_700_000_100};
  let clock=1_000_000,chainId='0x38',verifications=0,wrongChainRead;
  const wrongChainReached=new Promise(resolve=>{wrongChainRead=resolve;});
  const addresses=genesisRecord.addresses;
  const codehash=Object.fromEntries(Object.entries(genesisRecord.verification.code)
    .map(([name,value])=>[name,value.codehash]));
  const provider={async send(method){
      assert.equal(method,'eth_chainId');
      if(chainId!=='0x38')wrongChainRead();
      return chainId;
    },async getBlock(tag){
      if(tag==='finalized'||tag===block.number)return block;
      if(tag===initial.receipt.blockNumber)
        return {number:tag,hash:initial.receipt.blockHash,timestamp:block.timestamp-100};
      throw new Error(`Unexpected block ${tag}`);
    }};
  const service=createJournalService({dbPath:join(directory,'private','journal.sqlite'),
    origin:'http://127.0.0.1:4173',provider,now:()=>clock,
    currentArtifactDigest:()=>genesisRecord.artifactDigest,
    productDeploymentRecord:genesisRecord,productArtifactBundle:genesisBundle,
    allowedProductFactories:[addresses.factory,addresses.portfolioFactory],
    productGraphVerifier:async (_provider,factory,confirmedBlock)=>{
      verifications++;
      return {factory,blockNumber:confirmedBlock.number,
        artifactDigest:genesisRecord.artifactDigest,addresses,codehash};
    }});
  const server=createServer((req,res)=>service.handle(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const url=`http://127.0.0.1:${server.address().port}/api/journal/product-graph`;
    assert.equal((await (await fetch(url)).json()).readMode,'current');
    clock+=45_000;chainId='0x1';
    assert.equal((await (await fetch(url)).json()).stale,true);
    await wrongChainReached;
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal((await fetch(url)).status,503);
    assert.equal(verifications,1,'wrong-chain refresh cannot reach graph verification');
  }finally{
    await new Promise(resolve=>server.close(resolve));
    await service.close();
    await rm(directory,{recursive:true,force:true});
  }
});

test('a changed canonical hash invalidates the previous display snapshot before reproving', async () => {
  const directory=await mkdtemp(join(tmpdir(),'product-graph-reorg-api-'));
  const initial=genesisRecord.steps.find(step=>step.id==='initialize');
  const first={number:initial.receipt.blockNumber+100,hash:salt('8'),timestamp:1_700_000_100};
  const replacement={...first,hash:salt('9')};
  let canonical=first,clock=1_000_000,verifications=0;
  let anchorChecked;
  const checked=new Promise(resolve=>{anchorChecked=resolve;});
  const addresses=genesisRecord.addresses;
  const codehash=Object.fromEntries(Object.entries(genesisRecord.verification.code)
    .map(([name,value])=>[name,value.codehash]));
  const provider={async send(method){assert.equal(method,'eth_chainId');return '0x38';},
    async getBlock(tag){
      if(tag==='finalized')return canonical;
      if(tag===first.number){if(canonical===replacement)anchorChecked();return canonical;}
      if(tag===initial.receipt.blockNumber)return {number:tag,hash:initial.receipt.blockHash,timestamp:first.timestamp-100};
      throw new Error(`Unexpected block ${tag}`);
    }};
  const service=createJournalService({dbPath:join(directory,'private','journal.sqlite'),
    origin:'http://127.0.0.1:4173',provider,now:()=>clock,
    currentArtifactDigest:()=>genesisRecord.artifactDigest,
    productDeploymentRecord:genesisRecord,productArtifactBundle:genesisBundle,
    allowedProductFactories:[addresses.factory,addresses.portfolioFactory],
    productGraphVerifier:async (_provider,factory,block)=>{
      verifications++;
      return {factory,blockNumber:block.number,artifactDigest:genesisRecord.artifactDigest,
        addresses,codehash};
    }});
  const server=createServer((req,res)=>service.handle(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const url=`http://127.0.0.1:${server.address().port}/api/journal/product-graph`;
    assert.equal((await (await fetch(url)).json()).verifiedBlockHash,first.hash);
    clock+=45_000;canonical=replacement;
    assert.equal((await (await fetch(url)).json()).stale,true);
    await checked;
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(verifications,1,'reorg check stops the old proof before graph verification');
    const recovered=await (await fetch(url)).json();
    assert.equal(recovered.readMode,'current');
    assert.equal(recovered.verifiedBlockHash,replacement.hash);
    assert.equal(verifications,2,'replacement branch requires a new proof');
  }finally{
    await new Promise(resolve=>server.close(resolve));
    await service.close();
    await rm(directory,{recursive:true,force:true});
  }
});

test('verified fresh graph is published as read-only without checking old Factory pause state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'product-graph-fresh-api-'));
  const initial=genesisRecord.steps.find(step=>step.id==='initialize');
  const activationBlock=initial.receipt.blockNumber+10;
  const activationHash=salt('a');
  const block={number:activationBlock+10,hash:salt('b'),timestamp:1_700_000_100};
  const addresses=genesisRecord.addresses;
  const authority={address:addr(80_000),gasWallet:addr(80_001),administratorOne:addr(80_002),
    administratorTwo:addr(80_003),codehash:salt('c'),deploymentTxHash:salt('d'),
    activationBlock,activationHash};
  const provider={async send(method){assert.equal(method,'eth_chainId');return '0x38';},
    async getBlock(tag){
      if(tag==='finalized'||tag===block.number)return block;
      if(tag===activationBlock)return {number:activationBlock,hash:activationHash,timestamp:block.timestamp-1};
      throw new Error(`Unexpected block ${tag}`);
    }};
  const service=createJournalService({dbPath:join(directory,'private','journal.sqlite'),
    origin:'http://127.0.0.1:4173',provider,currentArtifactDigest:()=>genesisRecord.artifactDigest,
    productDeploymentRecord:genesisRecord,productArtifactBundle:genesisBundle,
    allowedProductFactories:[addresses.factory,addresses.portfolioFactory],
    productGraphVerifier:async()=>({factory:addresses.factory,blockNumber:block.number,
      artifactDigest:genesisRecord.artifactDigest,addresses,
      codehash:Object.fromEntries(Object.entries(genesisRecord.verification.code)
        .map(([name,value])=>[name,value.codehash])),freshFactoryVerified:true,freshAuthority:authority})});
  const server=createServer((req,res)=>service.handle(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/journal/product-graph`);
    assert.equal(response.status,200);
    const payload=await response.json();
    assert.equal(payload.stage,'fresh-active');
    assert.equal(payload.freshFactoryVerified,true);
    assert.equal(payload.operationalReady,false);
    assert.equal(payload.previousFactoriesPaused,undefined);
  }finally{
    await new Promise(resolve=>server.close(resolve));
    await service.close();
    await rm(directory,{recursive:true,force:true});
  }
});

test('public product-graph response exposes the reviewed candidate manifest only after its verifier passes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'product-graph-candidate-api-'));
  const { evidence } = fixture();
  const deploymentBlock=genesisRecord.steps.find(step=>step.id==='initialize').receipt.blockNumber;
  const activationBlock=deploymentBlock+10;
  const activationHash=salt('d');
  evidence.codeExecuteTxHash=salt('e');
  const block = { number: deploymentBlock+100, hash: salt('9'), timestamp: 1_700_000_100 };
  let finalized=block;
  let clock=2_000_000;
  const executionAbi=new Interface([
    'event CallExecuted(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data)',
  ]);
  const logs=evidence.plan.targets.map((target,index)=>({
    address:genesisRecord.addresses.timelock,transactionHash:evidence.codeExecuteTxHash,
    blockHash:activationHash,removed:false,
    ...executionAbi.encodeEventLog('CallExecuted',[
      evidence.plan.operationId,BigInt(index),target,0n,evidence.plan.payloads[index],
    ]),
  }));
  const tx={hash:evidence.codeExecuteTxHash,chainId:56n,blockNumber:activationBlock,
    blockHash:activationHash,index:0};
  const receipt={hash:evidence.codeExecuteTxHash,status:1,blockNumber:activationBlock,
    blockHash:activationHash,index:0,logs};
  const provider = {
    async send(method) { assert.equal(method,'eth_chainId');return '0x38'; },
    async getTransaction(hash) { assert.equal(hash,evidence.codeExecuteTxHash);return tx; },
    async getTransactionReceipt(hash) { assert.equal(hash,evidence.codeExecuteTxHash);return receipt; },
    async getBlock(tag) {
      if (tag==='finalized' || tag===finalized.number) return finalized;
      if (tag===block.number) return block;
      if (tag===activationBlock) return {number:tag,hash:activationHash,
        timestamp:block.timestamp-1,transactions:[evidence.codeExecuteTxHash]};
      throw new Error(`Unexpected block ${tag}`);
    },
  };
  const candidateAddresses = { ...genesisRecord.addresses, ...replacements };
  const codehash = Object.fromEntries(Object.entries(genesisRecord.verification.code)
    .map(([name, value]) => [name, value.codehash]));
  codehash.BudgetPortfolioVault = salt('a');
  codehash.BudgetPortfolioFactory = salt('b');
  let verified = true;
  let failedRefresh;
  const failedRefreshReached=new Promise(resolve=>{failedRefresh=resolve;});
  receipt.logs=[];
  const service = createJournalService({ dbPath: join(directory, 'private', 'journal.sqlite'),
    origin: 'http://127.0.0.1:4173', provider, now:()=>clock,
    currentArtifactDigest: () => genesisRecord.artifactDigest,
    productDeploymentRecord: genesisRecord, productArtifactBundle: genesisBundle,
    integratedUpgradeEvidence: evidence, integratedUpgradeArtifact: candidateBundle, genesisManifest,
    allowedProductFactories: [genesisRecord.addresses.factory, genesisRecord.addresses.portfolioFactory],
    productGraphVerifier: async () => {
      if (!verified) { failedRefresh(); throw new Error('candidate no longer verified'); }
      return { factory: genesisRecord.addresses.factory, blockNumber: finalized.number,
        artifactDigest: buildDigest(candidateBundle), addresses: candidateAddresses, codehash,
        securityUpgrade: { operationId: evidence.plan.operationId, roleWiringComplete: false } };
    } });
  const server = createServer((req, res) => service.handle(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/journal/product-graph`;
    assert.equal((await fetch(url)).status,503,'a claimed execute hash without exact Timelock events is not an activation');
    receipt.logs=logs;
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.stage, 'code-upgraded');
    assert.equal(payload.artifactDigest, buildDigest(candidateBundle));
    assert.equal(payload.manifest.portfolioImplementation, replacements.BudgetPortfolioVault);
    assert.equal(payload.manifest.codehash.portfolioFactoryImplementation, salt('b'));
    assert.equal(payload.stageActivationBlock,activationBlock);
    assert.equal(payload.stageActivationHash,activationHash);
    assert.equal(payload.manifest.verifiedBlockNumber,activationBlock);
    assert.equal(payload.manifest.verifiedBlockHash,activationHash);
    assert.equal(payload.verifiedBlockNumber,block.number);
    assert.equal(payload.operationalReady, false);
    verified = false;clock+=45_000;finalized={...block,number:block.number+1,hash:salt('c')};
    const stale=await (await fetch(url)).json();
    assert.equal(stale.stale,true);
    assert.equal(stale.operationId,evidence.plan.operationId,'old stage is explicitly historical');
    assert.equal(stale.transactionReady,false);
    await failedRefreshReached;
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal((await fetch(url)).status,503);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

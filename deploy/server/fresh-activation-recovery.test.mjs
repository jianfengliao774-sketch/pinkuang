import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AbstractProvider, Interface, Network, getCreateAddress, keccak256, toUtf8Bytes } from 'ethers';
import { JournalStore } from './journal-store.mjs';
import { createJournalService } from './journal-api.mjs';
import { FRESH_ACTIVATION_STEPS, FRESH_ADMIN_ONE, FRESH_ADMIN_TWO,
  validateFreshActivation, validateFreshActivationProgress,
  verifyFinalizedFreshAttempt, verifyRecoveredFreshSigning } from './fresh-activation-journal.mjs';

const address = digit => `0x${digit.repeat(40)}`;
const hash = digit => `0x${digit.repeat(64)}`;
const hardware=address('1'),gasWallet=address('2'),authority=getCreateAddress({from:hardware,nonce:0});
const factory=address('3'),budget=address('4'),timelock=address('5');
const shareMarket=address('6'),portfolioMarket=address('7');
const code='0x6000', codehash=keccak256(code);
const coreImpl=address('9'),budgetImpl=address('a');
const bundle={artifacts:{PlatformAuthority:{abi:[
  'constructor(address,address,address,address,address)'],bytecode:'0x6000',
  deployedBytecode:code,deployedLinkReferences:{},immutableReferences:{},linkReferences:{}}}};
const canonical=value=>Array.isArray(value)?value.map(canonical)
  :value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const bundleDigest=keccak256(toUtf8Bytes(JSON.stringify(canonical(bundle))));
const blockHash=number=>number===120?hash('d'):number===125?hash('f')
  :`0x${number.toString(16).padStart(64,'0')}`;
const receipt={blockNumber:120,blockHash:hash('d'),status:0,gasUsed:'100000',
  gasPrice:'1000000000',feeWei:'100000000000000'};
const factoryAbi=new Interface(['function owner() view returns(address)',
  'function operator() view returns(address)','function treasury() view returns(address)',
  'function timelock() view returns(address)','function shareMarket() view returns(address)',
  'function poolCount() view returns(uint256)','function portfolioCount() view returns(uint256)',
  'function creationPaused() view returns(bool)']);
const factoryWrite=new Interface(['function setOperator(address)',
  'function setTreasury(address)','function transferOwnership(address)']);
const timelockAbi=new Interface(['function getMinDelay() view returns(uint256)',
  'function PROPOSER_ROLE() view returns(bytes32)','function CANCELLER_ROLE() view returns(bytes32)',
  'function hasRole(bytes32,address) view returns(bool)']);
const authorityAbi=new Interface(['function owner() view returns(address)',
  'function coreFactory() view returns(address)','function budgetFactory() view returns(address)',
  'function administratorOne() view returns(address)','function administratorTwo() view returns(address)',
  'function gasWallet() view returns(address)']);

function fixture(index,status='failed') {
  const actions=[null,[factory,'setOperator',authority],[factory,'setTreasury',authority],
    [budget,'setOperator',authority],[budget,'setTreasury',authority],
    [factory,'transferOwnership',timelock],[budget,'transferOwnership',timelock]];
  const [target,method,destination]=actions[index]??[null,null,null];
  const data=index===0
    ? bundle.artifacts.PlatformAuthority.bytecode
      +new Interface(bundle.artifacts.PlatformAuthority.abi)
        .encodeDeploy([factory,budget,FRESH_ADMIN_ONE,FRESH_ADMIN_TWO,gasWallet]).slice(2)
    : factoryWrite.encodeFunctionData(method,[destination]);
  const steps=FRESH_ACTIVATION_STEPS.map((id,i)=>({id,status:i<index?'confirmed':'waiting'}));
  for(let i=0;i<index;i++){
    steps[i].nonce=i;
    steps[i].dataHash=hash('a');
    steps[i].gasLimit='150000';
    steps[i].gasPriceWei='0';
    steps[i].maxFeeWei='0';
    steps[i].txHash=hash(String(i+1));
    steps[i].receipt={blockNumber:100+i,blockHash:hash('a'),status:1,
      gasUsed:'0',gasPrice:'0',feeWei:'0'};
  }
  steps[index]={id:FRESH_ACTIVATION_STEPS[index],status,nonce:8,dataHash:keccak256(data),
    txHash:hash('b'),...(status==='replaced'?{replacementHash:hash('c')}:{}),
    gasLimit:'150000',gasPriceWei:'1000000000',maxFeeWei:'150000000000000',
    receipt:{...receipt,status:status==='replaced'?1:0}};
  const record={schemaVersion:1,kind:'fresh-authority',chainId:56,account:hardware,
    deploymentId:'new-graph',genesisArtifactDigest:bundleDigest,
    genesis:{factory,portfolioFactory:budget,timelock,shareMarket,portfolioMarket,
      codehash:{factory:codehash,portfolioFactory:codehash,shareMarket:codehash,
        portfolioMarket:codehash,timelock:codehash}},
    administratorOne:FRESH_ADMIN_ONE,administratorTwo:FRESH_ADMIN_TWO,gasWallet,
    ...(index>0?{authorityAddress:authority}:{}),
    createdAt:'2026-09-29T00:00:00Z',updatedAt:'2026-09-29T00:00:00Z',
    maxGasBudgetBnb:'0.05',gasPriceCapGwei:'3',spentWei:receipt.feeWei,
    status:'aborted',steps};
  const genesis={id:record.deploymentId,status:'complete',kind:'integrated-v2',account:hardware,
    artifactDigest:record.genesisArtifactDigest,
    input:{ownerMultisig:hardware,operator:hardware,treasury:hardware},
    addresses:{factory,portfolioFactory:budget,timelock,shareMarket,
      portfolioShareMarket:portfolioMarket,FreshPoolFactory:coreImpl,BudgetPortfolioFactory:budgetImpl},
    verification:{code:Object.fromEntries([
      ['factory','factory'],['portfolioFactory','portfolioFactory'],['shareMarket','shareMarket'],
      ['portfolioMarket','portfolioShareMarket'],['timelock','timelock']]
      .map(([key,name])=>[name,{codehash:record.genesis.codehash[key]}]))}};
  genesis.verification.code.FreshPoolFactory={address:coreImpl,codehash};
  genesis.verification.code.BudgetPortfolioFactory={address:budgetImpl,codehash};
  return {record,genesis,winnerHash:status==='replaced'?hash('c'):hash('b'),target,data,bundle};
}

function chain(f,{record,winnerHash},index) {
  const state={finalized:125,receiptHash:receipt.blockHash,txKnown:true,wrongRole:false,
    wrongRoleLatest:false,wrongImplLatest:false,wrongImplCodeLatest:false,wrongAuthorityLatest:false,
    forkParent:false,predictedOccupied:false,pending:9};
  const chainReceipt={hash:winnerHash,from:hardware,blockNumber:120,blockHash:receipt.blockHash,
    status:record.steps[index].receipt.status,gasUsed:100000n,gasPrice:1000000000n,
    fee:100000000000000n};
  const provider={
    getNetwork:async()=>({chainId:56n}),
    getTransaction:async()=>state.txKnown?{hash:winnerHash,chainId:56n,from:hardware,
      nonce:8,blockNumber:120,blockHash:receipt.blockHash,
      to:record.steps[index].status==='replaced'?hardware:f.target,
      data:record.steps[index].status==='replaced'?'0x':f.data,value:0n}:null,
    getTransactionReceipt:async()=>state.txKnown?chainReceipt:null,
    getBlock:async tag=>{
      const number=tag==='finalized'?state.finalized:tag==='latest'?127:tag;
      if(!Number.isInteger(number)||number<119||number>127)return null;
      return {number,hash:number===120?state.receiptHash:blockHash(number),
        parentHash:number===125&&state.forkParent?hash('e'):blockHash(number-1)};
    },
    getCode:async(address,block)=>index===0&&address.toLowerCase()===getCreateAddress({from:hardware,nonce:8}).toLowerCase()
      ? state.predictedOccupied?code:'0x'
      :state.wrongImplCodeLatest&&block===127&&address===coreImpl
        ||state.wrongAuthorityLatest&&block===127&&address===authority?'0x6001':code,
    getStorage:async(proxy,_slot,block)=>'0x'+(state.wrongImplLatest&&block===127&&proxy===factory
      ?address('c'):proxy===factory?coreImpl:budgetImpl).slice(2).padStart(64,'0'),
    getTransactionCount:async(_account,tag)=>tag==='pending'?state.pending:9,
    call:async({to,data,blockTag},extra)=>{
      assert.equal(extra,undefined,'ethers call accepts the block tag only inside its transaction');
      assert(Number.isSafeInteger(blockTag),'role reads must use a numbered chain anchor');
      const block=blockTag;
      assert([125,127].includes(block));
      const abi=to===timelock?timelockAbi:to===authority?authorityAbi:factoryAbi;
      const parsed=abi.parseTransaction({data});
      assert(parsed);
      const method=parsed.name;
      let value;
      if(to===timelock) value=method==='getMinDelay'?172800n
        :method==='hasRole'?true:hash(method==='PROPOSER_ROLE'?'1':'2');
      else if(to===authority) value={owner:timelock,coreFactory:factory,budgetFactory:budget,
        administratorOne:FRESH_ADMIN_ONE,administratorTwo:FRESH_ADMIN_TWO,gasWallet}[method];
      else {
        const isBudget=to===budget;
        const owner=isBudget?index>=7?timelock:hardware:index>=6?timelock:hardware;
        const operator=isBudget?index>=4?authority:hardware:index>=2?authority:hardware;
        const treasury=isBudget?index>=5?authority:hardware:index>=3?authority:hardware;
        value={owner,operator:state.wrongRole||state.wrongRoleLatest&&block===127?gasWallet:operator,treasury,timelock,
          shareMarket:isBudget?portfolioMarket:shareMarket,poolCount:0n,
          portfolioCount:0n,creationPaused:false}[method];
      }
      return abi.encodeFunctionResult(method,[value]);
    },
  };
  return {provider,state};
}

// Exercise AbstractProvider.call itself: ethers 6.17 ignores a second positional
// argument and takes the block tag from the transaction request.
class EthersCallAdapter extends AbstractProvider {
  constructor(delegate) { super(Network.from(56)); this.delegate=delegate; this.callTags=[]; }
  async _detectNetwork() { return Network.from(56); }
  async _perform(request) {
    assert.equal(request.method,'call');
    assert.match(request.blockTag,/^0x[\da-f]+$/i);
    this.callTags.push(request.blockTag);
    return this.delegate.call({...request.transaction,blockTag:Number(BigInt(request.blockTag))});
  }
  getBlock(tag) { return this.delegate.getBlock(tag); }
  getTransaction(hash) { return this.delegate.getTransaction(hash); }
  getTransactionReceipt(hash) { return this.delegate.getTransactionReceipt(hash); }
  getCode(address,tag) { return this.delegate.getCode(address,tag); }
  getStorage(address,slot,tag) { return this.delegate.getStorage(address,slot,tag); }
  getTransactionCount(address,tag) { return this.delegate.getTransactionCount(address,tag); }
}

test('ethers 6.17 adapter receives distinct finalized and latest block tags for role calls',async()=>{
  const f=fixture(2),{provider}=chain(f,f,2);
  const adapter=new EthersCallAdapter(provider);
  await verifyFinalizedFreshAttempt(adapter,f.record,f.genesis,hardware,
    'coreTreasury',8,f.winnerHash,f.bundle);
  assert(adapter.callTags.includes('0x7d'),'finalized block 125 must reach eth_call');
  assert(adapter.callTags.includes('0x7f'),'latest block 127 must reach eth_call');
  assert(!adapter.callTags.includes('latest'));
});

for(const [index,status] of [[0,'failed'],[0,'replaced'],[2,'failed'],[6,'replaced']]) {
  test(`finalized Stage 2 ${status} at step ${index+1} archives the attempt and preserves fees`,async()=>{
    const f=fixture(index,status),{provider}=chain(f,f,index);
    assert.equal(validateFreshActivation(f.record,hardware,f.genesis,gasWallet),f.record);
    const proof=await verifyFinalizedFreshAttempt(provider,f.record,f.genesis,hardware,
      f.record.steps[index].id,8,f.winnerHash,f.bundle);
    const dir=mkdtempSync(join(tmpdir(),'fresh-stage2-recovery-'));
    const store=new JournalStore(join(dir,'journal.sqlite'));
    try {
      assert.equal(store.putFreshActivation(hardware,f.record,0),1);
      const recovered=store.recoverFinalizedFreshAttempt(hardware,1,proof).record;
      assert.equal(recovered.status,'paused');
      assert.equal(recovered.steps[index].status,'waiting');
      assert.equal(recovered.steps[index].attempts.length,1);
      assert.equal(recovered.steps[index].attempts[0].recovery.winnerHash,f.winnerHash);
      assert.equal(recovered.spentWei,receipt.feeWei);
      assert.equal(validateFreshActivation(recovered,hardware,f.genesis,gasWallet),recovered);
      assert.throws(()=>validateFreshActivationProgress(f.record,recovered),/progress changed/);
      const tampered=structuredClone(recovered);
      tampered.steps[index].attempts[0].receipt.feeWei='0';
      assert.throws(()=>validateFreshActivationProgress(recovered,tampered),/progress changed/);
      assert.throws(()=>store.recoverFinalizedFreshAttempt(hardware,1,proof),/revision changed/);
    } finally {store.close();rmSync(dir,{recursive:true,force:true});}
  });
}

test('unknown winner, unfinalized receipt, reorg, pending nonce and changed roles all fail closed',async()=>{
  const f=fixture(2),{provider,state}=chain(f,f,2);
  const run=()=>verifyFinalizedFreshAttempt(provider,f.record,f.genesis,hardware,'coreTreasury',8,f.winnerHash,f.bundle);
  state.txKnown=false;await assert.rejects(run(),/proof failed/);state.txKnown=true;
  state.finalized=119;await assert.rejects(run(),/proof failed/);state.finalized=125;
  state.receiptHash=hash('e');await assert.rejects(run(),/proof failed/);state.receiptHash=receipt.blockHash;
  state.pending=10;await assert.rejects(run(),/proof failed/);state.pending=9;
  state.wrongRole=true;await assert.rejects(run(),/proof failed/);
  state.wrongRole=false;
  state.wrongRoleLatest=true;await assert.rejects(run(),/proof failed/);state.wrongRoleLatest=false;
  state.wrongImplLatest=true;await assert.rejects(run(),/proof failed/);state.wrongImplLatest=false;
  state.wrongImplCodeLatest=true;await assert.rejects(run(),/proof failed/);state.wrongImplCodeLatest=false;
  state.wrongAuthorityLatest=true;await assert.rejects(run(),/proof failed/);state.wrongAuthorityLatest=false;
  // A changed finalized receipt block is a real canonical-chain conflict;
  // changing only a mock parentHash without changing its block hash is not.
  state.receiptHash=hash('e');await assert.rejects(run(),/proof failed/);
});

test('first Authority creation cannot retry if its predicted address has code',async()=>{
  const f=fixture(0),{provider,state}=chain(f,f,0);
  state.predictedOccupied=true;
  await assert.rejects(()=>verifyFinalizedFreshAttempt(provider,f.record,f.genesis,hardware,
    'deployAuthority',8,f.winnerHash,f.bundle),/proof failed/);
});

test('authenticated recovery API checks the chain and journal revision before archiving',async()=>{
  const f=fixture(2),{provider,state}=chain(f,f,2);
  const dir=mkdtempSync(join(tmpdir(),'fresh-stage2-api-'));
  const dbPath=join(dir,'journal.sqlite');
  const origin='http://127.0.0.1:4173';
  const service=createJournalService({dbPath,origin,provider,
    currentArtifactDigest:()=>f.record.genesisArtifactDigest,
    genesisBundle:f.bundle,
    expectedGasWallet:gasWallet,gasWalletAddressReader:()=>gasWallet,freshStage2Hold:false});
  const store=new JournalStore(dbPath);
  const token=randomBytes(32).toString('base64url');
  store.putDeployment(hardware,f.genesis,0);
  store.putFreshActivation(hardware,f.record,0);
  store.db.prepare('INSERT INTO sessions(token_hash,account,expires) VALUES(?,?,?)')
    .run(createHash('sha256').update(token).digest('hex'),hardware.toLowerCase(),Date.now()+60_000);
  store.close();
  const server=createServer((req,res)=>service.handle(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/api/journal/fresh-activation/recover-finalized-attempt`;
  const request=async(expectedRevision,winnerHash=f.winnerHash)=>{
    const response=await fetch(url,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Pinkuang-Activation-Protocol':'2',
      Cookie:`pinkuang_journal=${token}`},body:JSON.stringify({expectedRevision,
      stepId:'coreTreasury',nonce:8,winnerHash})});
    return {status:response.status,body:await response.json()};
  };
  try {
    assert.equal((await request(1,hash('e'))).status,409);
    const recovered=await request(1);
    assert.equal(recovered.status,200);
    assert.equal(recovered.body.record.steps[2].attempts[0].recovery.winnerHash,f.winnerHash);
    assert.equal((await request(1)).status,409,'a stale tab cannot release the attempt again');
    const next=structuredClone(recovered.body.record);
    Object.assign(next.steps[2],{status:'signing',nonce:9,
      dataHash:keccak256(f.data),gasLimit:'150000',gasPriceWei:'1000000000',
      maxFeeWei:'150000000000000'});
    const signing=async()=>{
      const response=await fetch(`http://127.0.0.1:${server.address().port}/api/journal/fresh-activation`,
        {method:'PUT',headers:{Origin:origin,'Content-Type':'application/json','X-Pinkuang-Activation-Protocol':'2',
          Cookie:`pinkuang_journal=${token}`},body:JSON.stringify({expectedRevision:2,record:next})});
      return response.status;
    };
    state.wrongRoleLatest=true;
    assert.equal(await signing(),409,'changed latest role blocks a later signing intent');
    state.wrongRoleLatest=false;
    assert.equal(await signing(),200);
  } finally {
    await new Promise(resolve=>server.close(resolve));
    await service.close();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('authenticated first-step recovery requires the exact reviewed creation artifact',async()=>{
  const f=fixture(0),{provider}=chain(f,f,0);
  f.record.genesisArtifactDigest=bundleDigest;
  f.genesis.artifactDigest=bundleDigest;
  const dir=mkdtempSync(join(tmpdir(),'fresh-stage2-first-api-'));
  const dbPath=join(dir,'journal.sqlite'),origin='http://127.0.0.1:4173';
  const service=createJournalService({dbPath,origin,provider,
    currentArtifactDigest:()=>bundleDigest,genesisBundle:f.bundle,
    expectedGasWallet:gasWallet,freshStage2Hold:false});
  const store=new JournalStore(dbPath),token=randomBytes(32).toString('base64url');
  store.putDeployment(hardware,f.genesis,0);
  store.putFreshActivation(hardware,f.record,0);
  store.db.prepare('INSERT INTO sessions(token_hash,account,expires) VALUES(?,?,?)')
    .run(createHash('sha256').update(token).digest('hex'),hardware.toLowerCase(),Date.now()+60_000);
  store.close();
  const server=createServer((req,res)=>service.handle(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const request=()=>fetch(`http://127.0.0.1:${server.address().port}/api/journal/fresh-activation/recover-finalized-attempt`,
      {method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Pinkuang-Activation-Protocol':'2',
        Cookie:`pinkuang_journal=${token}`},body:JSON.stringify({expectedRevision:1,
        stepId:'deployAuthority',nonce:8,winnerHash:f.winnerHash})});
    f.bundle.artifacts.PlatformAuthority.bytecode='0x6001';
    assert.equal((await request()).status,409,'changed server artifact cannot release Authority creation');
    f.bundle.artifacts.PlatformAuthority.bytecode='0x6000';
    const response=await request();
    assert.equal(response.status,200);
    assert.equal((await response.json()).record.steps[0].attempts.length,1);
  } finally {
    await new Promise(resolve=>server.close(resolve));
    await service.close();rmSync(dir,{recursive:true,force:true});
  }
});

test('an archived same-nonce winner is checked again before another signature',async()=>{
  const f=fixture(2),{provider,state}=chain(f,f,2);
  const proof=await verifyFinalizedFreshAttempt(provider,f.record,f.genesis,hardware,
    'coreTreasury',8,f.winnerHash,f.bundle);
  const dir=mkdtempSync(join(tmpdir(),'fresh-stage2-history-'));
  const store=new JournalStore(join(dir,'journal.sqlite'));
  try {
    store.putFreshActivation(hardware,f.record,0);
    const recovered=store.recoverFinalizedFreshAttempt(hardware,1,proof).record;
    await verifyRecoveredFreshSigning(provider,recovered,f.genesis,hardware,f.bundle);
    state.receiptHash=hash('e');
    await assert.rejects(()=>verifyRecoveredFreshSigning(provider,recovered,f.genesis,hardware,f.bundle),/proof failed/);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('phase-switching RPC cannot pair finalized A128 with latest B128',async()=>{
  const f=fixture(2),base=chain(f,f,2).provider;
  const a128=hash('a'),b128=hash('b');
  let finalizedReads=0,latestReads=0,numbered128=0;
  const provider={...base,getBlock:async tag=>{
    if(tag==='finalized') return ++finalizedReads===1?base.getBlock(tag)
      :{number:128,hash:a128,parentHash:blockHash(127)};
    if(tag==='latest') return ++latestReads===1?base.getBlock(tag)
      :{number:128,hash:b128,parentHash:blockHash(127)};
    if(tag===128) return {number:128,hash:++numbered128===1?a128:b128,
      parentHash:blockHash(127)};
    return base.getBlock(tag);
  }};
  await assert.rejects(()=>verifyFinalizedFreshAttempt(provider,f.record,f.genesis,hardware,
    'coreTreasury',8,f.winnerHash,f.bundle),/proof failed/);
});

test('a newer finalized anchor gets fresh role and code checks',async()=>{
  for (const drift of ['role','code']) {
    const f=fixture(2),base=chain(f,f,2).provider;
    let finalizedReads=0,latestReads=0;
    const provider={...base,
      getBlock:async tag=>{
        if(tag==='finalized'&&++finalizedReads>1 || tag==='latest'&&++latestReads>1)
          return tag==='finalized'?{number:128,hash:hash('a'),parentHash:blockHash(127)}
            :{number:129,hash:hash('b'),parentHash:hash('a')};
        if(tag===128) return {number:128,hash:hash('a'),parentHash:blockHash(127)};
        if(tag===129) return {number:129,hash:hash('b'),parentHash:hash('a')};
        return base.getBlock(tag);
      },
      getCode:async(address,block)=>drift==='code'&&block===128&&address===coreImpl
        ?'0x6001':base.getCode(address,block),
      call:async(tx)=>drift==='role'&&tx.blockTag===128&&tx.to===factory
        && factoryAbi.parseTransaction({data:tx.data})?.name==='operator'
        ?factoryAbi.encodeFunctionResult('operator',[gasWallet])
        :base.call({...tx,blockTag:tx.blockTag>=128?125:tx.blockTag}),
    };
    await assert.rejects(()=>verifyFinalizedFreshAttempt(provider,f.record,f.genesis,hardware,
      'coreTreasury',8,f.winnerHash,f.bundle),/proof failed/);
  }
});

test('two archived winners from separate forks cannot share a signing proof',async()=>{
  const f=fixture(2),base=chain(f,f,2).provider;
  const dir=mkdtempSync(join(tmpdir(),'fresh-stage2-two-forks-'));
  const store=new JournalStore(join(dir,'journal.sqlite'));
  try {
    const proof=await verifyFinalizedFreshAttempt(base,f.record,f.genesis,hardware,
      'coreTreasury',8,f.winnerHash,f.bundle);
    store.putFreshActivation(hardware,f.record,0);
    const recovered=store.recoverFinalizedFreshAttempt(hardware,1,proof).record;
    const second=structuredClone(recovered.steps[2].attempts[0]);
    const secondHash=hash('e');
    const forkHash=number=>number===120?hash('e')
      :`0x${(number+1000).toString(16).padStart(64,'0')}`;
    second.nonce=9;second.txHash=secondHash;second.receipt.blockHash=forkHash(120);
    second.recovery.winnerHash=secondHash;
    second.recovery.finalizedBlockHash=forkHash(125);
    recovered.steps[2].attempts.push(second);
    recovered.spentWei=(BigInt(receipt.feeWei)*2n).toString();
    validateFreshActivation(recovered,hardware,f.genesis,gasWallet);
    let fork='A';
    const provider={...base,
      getTransaction:async winner=>{
        if(winner!==secondHash)return base.getTransaction(winner);
        fork='B';
        return {hash:secondHash,chainId:56n,from:hardware,nonce:9,
          blockNumber:120,blockHash:forkHash(120),to:factory,data:f.data,value:0n};
      },
      getTransactionReceipt:async winner=>winner===secondHash
        ?{hash:secondHash,from:hardware,blockNumber:120,blockHash:forkHash(120),
          status:0,gasUsed:100000n,gasPrice:1000000000n,fee:100000000000000n}
        :base.getTransactionReceipt(winner),
      getBlock:async tag=>{
        if(fork==='A')return base.getBlock(tag);
        const number=tag==='finalized'?125:tag==='latest'?127:tag;
        if(number<120||number>127)return base.getBlock(tag);
        return {number,hash:forkHash(number),parentHash:number===120?blockHash(119):forkHash(number-1)};
      },
    };
    await assert.rejects(()=>verifyRecoveredFreshSigning(provider,recovered,f.genesis,hardware,f.bundle),
      /proof failed/);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('a finalized attempt can be recovered after more than one million blocks with bounded RPC reads',async()=>{
  const f=fixture(2),base=chain(f,f,2).provider;
  const far=1_100_120;
  let blockReads=0;
  const provider={...base,
    getBlock:async tag=>{
      blockReads++;
      const number=tag==='finalized'?far:tag==='latest'?far+1:tag;
      if(number<=127)return base.getBlock(number);
      return {number,hash:blockHash(number),parentHash:blockHash(number-1)};
    },
    call:async(tx)=>base.call({...tx,blockTag:tx.blockTag>=128?125:tx.blockTag}),
  };
  const proof=await verifyFinalizedFreshAttempt(provider,f.record,f.genesis,hardware,
    'coreTreasury',8,f.winnerHash,f.bundle);
  assert.equal(proof.finalizedBlockNumber,far);
  assert(blockReads<100,`expected bounded anchor checks, observed ${blockReads} block reads`);
  const broken={...provider,getBlock:async tag=>{
    const block=await provider.getBlock(tag);
    return tag===120?{...block,hash:hash('e')}:block;
  }};
  await assert.rejects(()=>verifyFinalizedFreshAttempt(broken,f.record,f.genesis,hardware,
    'coreTreasury',8,f.winnerHash,f.bundle),/proof failed/);
});

test('a reorg during refreshed state reads rejects both recovery and later signing',async()=>{
  for (const changed of ['winner','old-anchor']) {
    const f=fixture(2),base=chain(f,f,2).provider;
    const proof=await verifyFinalizedFreshAttempt(base,f.record,f.genesis,hardware,
      'coreTreasury',8,f.winnerHash,f.bundle);
    const dir=mkdtempSync(join(tmpdir(),'fresh-stage2-late-reorg-'));
    const store=new JournalStore(join(dir,'journal.sqlite'));
    let recovered;
    try {
      store.putFreshActivation(hardware,f.record,0);
      recovered=store.recoverFinalizedFreshAttempt(hardware,1,proof).record;
    } finally {store.close();rmSync(dir,{recursive:true,force:true});}
    const providerWithLateReorg=()=>{
      let finalizedReads=0,latestReads=0,reorg=false;
      return {...base,
        getBlock:async tag=>{
          if(tag==='finalized') return ++finalizedReads===1?base.getBlock(tag)
            :{number:128,hash:hash('a'),parentHash:blockHash(127)};
          if(tag==='latest') return ++latestReads===1?base.getBlock(tag)
            :{number:129,hash:hash('b'),parentHash:hash('a')};
          if(tag===128) return {number:128,hash:hash('a'),parentHash:blockHash(127)};
          if(tag===129) return {number:129,hash:hash('b'),parentHash:hash('a')};
          if(reorg&&tag===(changed==='winner'?120:125))
            return {...await base.getBlock(tag),hash:hash('e')};
          return base.getBlock(tag);
        },
        call:async tx=>{
          if(tx.blockTag===128)reorg=true;
          return base.call({...tx,blockTag:tx.blockTag>=128?125:tx.blockTag});
        },
      };
    };
    await assert.rejects(()=>verifyFinalizedFreshAttempt(providerWithLateReorg(),f.record,
      f.genesis,hardware,'coreTreasury',8,f.winnerHash,f.bundle),/proof failed/);
    await assert.rejects(()=>verifyRecoveredFreshSigning(providerWithLateReorg(),recovered,
      f.genesis,hardware,f.bundle),/proof failed/);
  }
});


test('fresh activation PUT independently reads a newly confirmed role receipt and cannot persist an unproved wrapper',async()=>{
  const f=fixture(2),{provider}=chain(f,f,2);
  const previous=structuredClone(f.record);
  previous.status='paused';previous.spentWei='0';previous.steps[2].status='submitted';delete previous.steps[2].receipt;
  const confirmed=structuredClone(previous);confirmed.steps[2].status='confirmed';
  confirmed.steps[2].receipt={...receipt,status:1};confirmed.spentWei=receipt.feeWei;
  const dir=mkdtempSync(join(tmpdir(),'fresh-stage2-confirm-api-'));
  const dbPath=join(dir,'journal.sqlite'),origin='http://127.0.0.1:4173';
  let rpcReads=0;
  provider.getTransaction=async()=>{rpcReads++;throw new Error('independent RPC unavailable');};
  const service=createJournalService({dbPath,origin,provider,currentArtifactDigest:()=>bundleDigest,
    genesisBundle:f.bundle,expectedGasWallet:gasWallet,freshStage2Hold:false});
  const store=new JournalStore(dbPath),token=randomBytes(32).toString('base64url');
  store.putDeployment(hardware,f.genesis,0);store.putFreshActivation(hardware,previous,0);
  store.db.prepare('INSERT INTO sessions(token_hash,account,expires) VALUES(?,?,?)')
    .run(createHash('sha256').update(token).digest('hex'),hardware.toLowerCase(),Date.now()+60_000);
  const server=createServer((req,res)=>service.handle(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/journal/fresh-activation`,{
      method:'PUT',headers:{Origin:origin,'Content-Type':'application/json','X-Pinkuang-Activation-Protocol':'2',Cookie:`pinkuang_journal=${token}`},
      body:JSON.stringify({expectedRevision:1,record:confirmed}),
    });
    assert.equal(response.status,409);
    assert.match((await response.json()).error,/execution or permission prefix/);
    assert.equal(rpcReads,1,'the real HTTP handler must invoke independent receipt proof');
    const after=store.freshActivation(hardware);
    assert.equal(after.revision,1);assert.equal(after.record.steps[2].status,'submitted');
  }finally{await new Promise(resolve=>server.close(resolve));await service.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

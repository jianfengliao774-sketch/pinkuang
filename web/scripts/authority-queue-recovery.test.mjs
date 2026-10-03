import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, ZeroAddress, getAddress, id, keccak256 } from 'ethers';
import { abi } from '../lib/chain-client.mjs';
import { authorityAction } from '../lib/authority-client.mjs';
import { expectedAuthorityQueueCall, recoverAuthorityQueueStep } from '../lib/authority-queue-recovery.mjs';
import { budgetApprovalDigest } from '../../deploy/shared/budget-queue.mjs';
import { applyBudgetQueueResult } from '../lib/budget-purchase-plan.mjs';

const A = n => getAddress(`0x${n.toString(16).padStart(40, '0')}`), H = n => `0x${n.toString(16).padStart(64, '0')}`;
const signer = new Wallet(`0x${'11'.repeat(32)}`), other = new Wallet(`0x${'12'.repeat(32)}`);
const factory=A(1), portfolioFactory=A(2), parent=A(3), authority=A(4), gasWallet=A(5), child=A(6), collection=A(7);
const code='0x6000', hash=H(10), blockHash=H(11), finalHash=H(12);
const config={kind:'integrated-v2',stage:'fresh-active',factory,portfolioFactory,authority,gasWallet,
  artifactDigest:H(13),freshAuthority:{codehash:keccak256(code)}};

async function fixture(phase='create', venue='official', successful=true) {
  const item={collection,tokenId:'7',maxCostWei:'101',targetRaiseWei:'200',verifiedWeight:'1',venue,
    ...(venue==='official'?{listingId:'77'}:{encodedOrder:'0x1234'}),status:phase==='create'?'creating':'buying',pendingPhase:phase,
    ...(phase==='purchase'?{child}:{})};
  const plan={version:1,chainId:56,id:'queue-1',revision:1,approved:true,account:signer.address,parent,factory,portfolioFactory,
    artifactDigest:config.artifactDigest,budgetWei:'1000',startSpentWei:'0',limitWei:'500',absoluteCapWei:'500',unitCapWei:'500',purchaseDeadline:'2000',
    snapshot:{complete:true,blockNumber:90,blockHash:H(90)},items:[item]};
  const params={circuits:collection,circuitId:7n,targetRaise:200n,priceCap:101n,directSeller:ZeroAddress,directPrice:0n,
    fundingDeadline:1999n,purchaseDeadline:2000n};
  const kind=phase==='create'?'executeApprovedOperation':venue==='official'?'buyBudgetOfficial':'buyBudgetFirsto';
  const action=phase==='create'?'createBudgetChildPool':venue==='official'?'buyOfficial':'buyFirsto';
  const target=phase==='create'?factory:parent;
  const data=phase==='create'?abi.PoolFactory.encodeFunctionData(action,[params,parent])
    :abi.BudgetPortfolioVault.encodeFunctionData(action,[child,venue==='official'?77:'0x1234']);
  const args=phase==='create'?{target:factory,data}:{portfolio:parent,child,maxCost:'100',
    ...(venue==='official'?{listingId:'77'}:{encodedOrder:'0x1234'})};
  item.intent={transaction:{from:signer.address,to:target,value:'0x0',chainId:'0x38',data},action:{kind:action},authority:{kind,args}};
  plan.approvalDigest=budgetApprovalDigest(plan);
  const nonce=0n,deadline=1800n,typed=authorityAction(authority,kind,args,nonce,deadline);
  const signature=await signer.signTypedData(typed.domain,typed.types,typed.message);
  const expected=expectedAuthorityQueueCall(config,plan,0);
  const tx={hash,from:gasWallet,to:authority,chainId:'0x38',value:'0x0',nonce:'0x3',blockHash,blockNumber:'0x64',
    input:abi.PlatformAuthority.encodeFunctionData(kind,[...expected.arguments,nonce,deadline,signature])};
  const receipt={transactionHash:hash,from:gasWallet,to:authority,blockHash,blockNumber:'0x64',status:successful?'0x1':'0x0',logs:[]};
  const log=(contract,address,name,values)=>({address,...contract.encodeEventLog(contract.getEvent(name),values),
    transactionHash:hash,blockHash,removed:false});
  if(successful){
    receipt.logs.push(log(abi.PlatformAuthority,authority,'AdminAction',[signer.address,expected.eventKind,target,nonce]));
    receipt.logs.push(phase==='create'?log(abi.PoolFactory,factory,'PoolCreated',[child,collection,7,200,101,authority])
      :log(abi.BudgetPortfolioVault,parent,'ChildPurchased',[child,collection,7,100,venue==='official']));
  }
  const block={number:'0x64',hash:blockHash,timestamp:'0x3e8'}, finalized={number:'0x65',hash:finalHash,timestamp:'0x3e9'};
  const state={tx,receipt,block,finalized,code,subscriber:parent}, calls=[];
  const provider={request:async({method,params})=>{calls.push(method);switch(method){
    case 'eth_getTransactionByHash':return state.tx;
    case 'eth_getTransactionReceipt':return state.receipt;
    case 'eth_getCode':return state.code;
    case 'eth_getBlockByNumber':return params[0]==='finalized'||params[0]==='0x65'?state.finalized:state.block;
    default:throw Error('Unexpected RPC '+method);
  }}};
  const readContext=async()=>({manifest:config,read:async()=>[state.subscriber],canonical:async()=>{}});
  const run=(overrides={})=>recoverAuthorityQueueStep({config,provider,plan,index:0,hash,readContext,...overrides});
  return {plan,item,tx,receipt,state,calls,run,log,expected,typed,signature};
}

for(const [phase,venue] of [['create','official'],['purchase','official'],['purchase','firsto']]) {
  test(`fresh queue advances ${phase}/${venue} only from an exact finalized Authority transaction`,async()=>{
    const f=await fixture(phase,venue), result=await f.run();
    assert.equal(result.status,'confirmed');assert.equal(result.finalized,true);assert.equal(result.account,signer.address);
    const next=applyBudgetQueueResult(f.plan,0,result);
    assert.equal(next.items[0].status,phase==='create'?'created':'completed');
    if(phase==='create')assert.equal(next.items[0].child,child);
    assert(!f.calls.some(method=>/send|sign/i.test(method)));
  });
}

test('a reverted relayed purchase is terminal only with its matching finalized signed transaction',async()=>{
  const f=await fixture('purchase','official',false);
  f.state.block.timestamp='0x800'; // An expired signature can legitimately revert.
  const result=await f.run();assert.equal(result.status,'reverted');assert.equal(result.receipt.status,0);
  assert.equal(applyBudgetQueueResult(f.plan,0,result).items[0].status,'failed');
});

for(const [name,change] of [
  ['unknown transaction',f=>{f.state.tx=null;f.state.receipt=null;}],
  ['unmined transaction',f=>{f.state.receipt=null;}],
  ['not finalized',f=>{f.state.finalized={...f.state.finalized,number:'0x63'};}],
])test(`fresh queue keeps ${name} unresolved without sending`,async()=>{
  const f=await fixture();change(f);const result=await f.run();assert.equal(result.status,'pending');
  assert.equal(applyBudgetQueueResult(f.plan,0,result).items[0].status,'pending');
});

for(const [name,change] of [
  ['wrong gas sender',f=>{f.tx.from=A(99);}],
  ['wrong Authority',f=>{f.tx.to=A(99);}],
  ['wrong chain',f=>{f.tx.chainId='0x1';}],
  ['nonzero payment',f=>{f.tx.value='0x1';}],
  ['trailing calldata',f=>{f.tx.input+='00';}],
  ['mismatched receipt hash',f=>{f.receipt.transactionHash=H(99);}],
  ['changed receipt block',f=>{f.state.block.hash=H(99);}],
  ['wrong runtime',f=>{f.state.code='0x6001';}],
  ['missing action event',f=>{f.receipt.logs.shift();}],
  ['duplicate action event',f=>{f.receipt.logs.push(f.receipt.logs[0]);}],
  ['removed business event',f=>{f.receipt.logs[1].removed=true;}],
  ['other project subscriber',f=>{f.state.subscriber=A(99);}],
  ['wrong event NFT',f=>{f.receipt.logs[1]=f.log(abi.PoolFactory,factory,'PoolCreated',[child,collection,8,200,101,authority]);}],
  ['wrong event authority nonce',f=>{f.receipt.logs[0]=f.log(abi.PlatformAuthority,authority,'AdminAction',[signer.address,id('APPROVED_OPERATION'),factory,1]);}],
])test(`fresh queue rejects ${name}`,async()=>{
  const f=await fixture();change(f);await assert.rejects(f.run());assert.equal(f.item.status,'creating');
});

test('another administrator signature cannot claim this queue even when target and calldata match',async()=>{
  const f=await fixture(),signature=await other.signTypedData(f.typed.domain,f.typed.types,f.typed.message);
  f.tx.input=abi.PlatformAuthority.encodeFunctionData(f.expected.command.kind,[...f.expected.arguments,0,1800,signature]);
  await assert.rejects(f.run(),/本队列/);
});

test('purchase receipt cannot change approved cost, source, child or miner',async()=>{
  for(const values of [[child,collection,7,101,true],[child,collection,7,100,false],[A(99),collection,7,100,true],[child,collection,8,100,true]]){
    const f=await fixture('purchase');f.receipt.logs[1]=f.log(abi.BudgetPortfolioVault,parent,'ChildPurchased',values);
    await assert.rejects(f.run(),/采购事件/);
  }
});

test('missing, changed or unreviewed queue authority intent cannot be recovered from relay status',async()=>{
  const f=await fixture();await assert.rejects(f.run({hash:null}),/哈希/);
  delete f.item.intent.authority;await assert.rejects(f.run(),/意图/);
  const p=await fixture('purchase');p.item.intent.authority.args.maxCost='102';
  await assert.rejects(p.run(),/限额/);
});

test('official recovery cannot change the original queue venue or listing ID',async()=>{
  for(const patch of [{venue:'firsto',encodedOrder:'0x1234'},{listingId:'78'}]) {
    const f=await fixture('purchase');Object.assign(f.item,patch);f.plan.approvalDigest=budgetApprovalDigest(f.plan);
    await assert.rejects(f.run(),/官网采购挂单/);
  }
  const f=await fixture();f.plan.snapshot.blockNumber=101;
  await assert.rejects(f.run(),/回执身份/);
});

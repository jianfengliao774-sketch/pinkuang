import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Interface,ZeroAddress,getAddress,keccak256,toQuantity} from 'ethers';
import {parseFirstoPurchaseOrder,verifyFirstoPurchaseOrder,FIRSTO_BATCH_EXCHANGE,
  FIRSTO_BATCH_RUNTIME_HASH,FIRSTO_BATCH_ASK_TUPLE,FIRSTO_ASK_LEAF_TUPLE} from '../src/firsto-purchase.mjs';
import {batchSource} from './fixtures/firsto-batch-order.mjs';
import {collection,now} from './fixtures/firsto-order.mjs';
const observedRuntime=readFileSync(new URL('./fixtures/firsto-batch-observed-runtime.hex',import.meta.url),'utf8').trim();
const evidence=JSON.parse(readFileSync(new URL('./fixtures/firsto-batch-runtime-evidence.json',import.meta.url),'utf8'));
const sourcePath=new URL('../src/firsto-purchase.mjs',import.meta.url),productionSource=readFileSync(sourcePath,'utf8');
assert(productionSource.includes('const FIRSTO_BATCH_PROVENANCE_VERIFIED = false;'));
assert.equal(keccak256(observedRuntime),evidence.observedRuntimeHash);
assert.equal(FIRSTO_BATCH_RUNTIME_HASH,evidence.officialAdvertisedHash);
assert.notEqual(FIRSTO_BATCH_RUNTIME_HASH,keccak256(observedRuntime));
// Test only: clone the candidate module into an isolated temporary directory.
// The published module, private gate and production pin are never modified.
const directory=mkdtempSync(join(tmpdir(),'bemine-batch-verifier-test-'));
after(()=>rmSync(directory,{recursive:true,force:true}));
const clone=productionSource.replace("from 'ethers'",`from ${JSON.stringify(import.meta.resolve('ethers'))}`)
  .replace('const FIRSTO_BATCH_PROVENANCE_VERIFIED = false;','const FIRSTO_BATCH_PROVENANCE_VERIFIED = true;')
  .replace(evidence.officialAdvertisedHash,evidence.observedRuntimeHash);
const candidatePath=join(directory,'candidate.mjs');writeFileSync(candidatePath,clone);
const candidate=await import(pathToFileURL(candidatePath).href);
const parse=source=>parseFirstoPurchaseOrder(source,{collection,tokenId:'7',owner:source.account,now});
const functions=new Interface([
  'function factory() view returns(address)','function paused() view returns(bool)','function defaultTakerFeeBps() view returns(uint16)',
  'function feeEpoch() view returns(uint256)','function feeBpsAtEpoch(uint256) view returns(uint16)','function BATCH_ASK_SCHEMA_VERSION() view returns(uint16)',
  'function batchCancelled(address,uint256) view returns(bool)','function isAskLeafInvalidated(address,uint256,uint256) view returns(bool)',
  `function hashBatchAsk(${FIRSTO_BATCH_ASK_TUPLE}) view returns(bytes32)`,`function hashAskLeaf(${FIRSTO_ASK_LEAF_TUPLE}) pure returns(bytes32)`,
  'function ownerOf(uint256) view returns(address)','function getApproved(uint256) view returns(address)',
  'function isApprovedForAll(address,address) view returns(bool)','function isValidSignature(bytes32,bytes) view returns(bytes4)',
]);
function fixture(source,overrides={}){
  const calls=[],block={number:'0x64',hash:`0x${'12'.repeat(32)}`,timestamp:toQuantity(BigInt(now/1000))};
  const values={factory:'0x68224F668083c29e9800Be2a646d42d18cedF7e2',paused:false,defaultTakerFeeBps:100n,
    feeEpoch:1n,feeBpsAtEpoch:100n,BATCH_ASK_SCHEMA_VERSION:1n,batchCancelled:false,isAskLeafInvalidated:false,
    ownerOf:source.account,getApproved:ZeroAddress,isApprovedForAll:true,hashBatchAsk:source.execution.batchHash,
    hashAskLeaf:source.execution.leafHash,isValidSignature:'0x1626ba7e',...overrides.values};
  let chainReads=0;
  const provider={request:async({method,params=[]})=>{
    calls.push({method,params});
    if(method==='eth_chainId')return ++chainReads===1?overrides.chain??'0x38':overrides.finalChain??overrides.chain??'0x38';
    if(method==='eth_getBlockByNumber')return {...block,...(params[0]==='latest'?overrides.initialBlock:overrides.finalBlock)};
    if(method==='eth_getCode'){
      assert.equal(getAddress(params[0]),FIRSTO_BATCH_EXCHANGE);return overrides.runtime??observedRuntime;
    }
    if(method==='eth_call'){
      const decoded=functions.parseTransaction(params[0]);
      if(!(decoded.name in values))throw new Error('Unknown fixture read');
      return functions.encodeFunctionResult(decoded.fragment,[values[decoded.name]]);
    }
    throw new Error(`Read-only fixture refused ${method}`);
  }};
  return {provider,calls};
}

test('production batch gate stays private, unconfigurable and closed before any RPC',async()=>{
  const order=parse(await batchSource());let calls=0;const provider={request:async()=>{calls++;throw new Error('No RPC');}};
  for(const options of [{},{provenanceVerified:true},{runtimeHash:evidence.observedRuntimeHash},{FIRSTO_BATCH_PROVENANCE_VERIFIED:true}])
    await assert.rejects(verifyFirstoPurchaseOrder(provider,order,options),/尚未通过核验/);
  assert.equal(calls,0);assert.equal(readFileSync(sourcePath,'utf8'),productionSource);
});

test('isolated reviewed candidate pins exact runtime, every policy/NFT read and canonical reread',async()=>{
  const source=await batchSource(),order=parse(source),f=fixture(source);
  const checked=await candidate.verifyFirstoPurchaseOrder(f.provider,order);
  assert.equal(checked.checkedBlock.number,'0x64');assert.equal(checked.askHash,source.execution.batchHash);
  assert.equal(checked.leafHash,source.id);assert.equal(checked.runtimeHash,evidence.observedRuntimeHash);
  for(const call of f.calls.filter(item=>['eth_call','eth_getCode'].includes(item.method)))assert.equal(call.params.at(-1),'0x64');
  assert(f.calls.every(item=>!['eth_sendTransaction','eth_sendRawTransaction','personal_sign','eth_getStorageAt'].includes(item.method)));
  const viewCalls=f.calls.filter(item=>item.method==='eth_call').map(item=>functions.parseTransaction(item.params[0]));
  const cancelled=viewCalls.find(item=>item.name==='batchCancelled');assert.equal(cancelled.args[0],order.batch.maker);assert.equal(cancelled.args[1],9n);
  const leaf=viewCalls.find(item=>item.name==='isAskLeafInvalidated');assert.equal(leaf.args[0],order.batch.maker);assert.equal(leaf.args[1],9n);assert.equal(leaf.args[2],0n);
  assert.deepEqual(viewCalls.find(item=>item.name==='ownerOf').args.toArray(),[7n]);
});

test('isolated candidate rejects runtime/fee/pause/schema/nonce/consumed leaf/ownership/approval/hash/chain/reorg contamination',async()=>{
  const source=await batchSource(),order=parse(source);
  const changes=[{chain:'0x1'},{runtime:'0x6000'},{runtime:'0x'},{values:{factory:collection}},{values:{paused:true}},
    {values:{feeEpoch:2n}},{values:{defaultTakerFeeBps:101n}},{values:{feeBpsAtEpoch:101n}},{values:{BATCH_ASK_SCHEMA_VERSION:2n}},
    {values:{batchCancelled:true}},{values:{isAskLeafInvalidated:true}},{values:{ownerOf:collection}},
    {values:{isApprovedForAll:false,getApproved:ZeroAddress}},{values:{hashBatchAsk:`0x${'ab'.repeat(32)}`}},
    {values:{hashAskLeaf:`0x${'ab'.repeat(32)}`}},{finalChain:'0x1'},{finalBlock:{hash:`0x${'ab'.repeat(32)}`}},
    {finalBlock:{timestamp:'0x1'}},{finalBlock:{number:'0x65'}},{initialBlock:{timestamp:toQuantity(BigInt(order.ask.expiry))}}];
  for(const change of changes)await assert.rejects(candidate.verifyFirstoPurchaseOrder(fixture(source,change).provider,order));
});

test('isolated candidate supports exact NFT approval and rejects fixed-block substitution before contract reads',async()=>{
  const source=await batchSource(),order=parse(source);
  await candidate.verifyFirstoPurchaseOrder(fixture(source,{values:{getApproved:FIRSTO_BATCH_EXCHANGE,isApprovedForAll:false}}).provider,order,{blockTag:'0x64'});
  const f=fixture(source);await assert.rejects(candidate.verifyFirstoPurchaseOrder(f.provider,order,{blockTag:'0x63'}),/区块与请求不一致/);
  assert.equal(f.calls.filter(item=>item.method==='eth_call').length,0);
  const g=fixture(source);await assert.rejects(candidate.verifyFirstoPurchaseOrder(g.provider,order,{blockTag:'pending'}));assert.equal(g.calls.length,0);
});

test('isolated candidate preserves EIP712 maker validation and bounded ERC1271 fallback without asserting unreviewed live support',async()=>{
  for(const signature of ['0x','0x123456',`0x${'ab'.repeat(1024)}`]){
    const source=await batchSource({signature,maker:collection}),order=parse(source),f=fixture(source);
    const checked=await candidate.verifyFirstoPurchaseOrder(f.provider,order);assert.equal(checked.signature,signature);
    const call=f.calls.find(item=>item.method==='eth_call'&&functions.parseTransaction(item.params[0]).name==='isValidSignature');
    const decoded=functions.parseTransaction(call.params[0]);assert.equal(decoded.args[0],order.batchHash);assert.equal(decoded.args[1],signature);
    assert.equal(call.params[1],'0x64');
    await assert.rejects(candidate.verifyFirstoPurchaseOrder(fixture(source,{values:{isValidSignature:'0xffffffff'}}).provider,order),/签名无效/);
  }
  const source=await batchSource(),order=parse(source),f=fixture(source);
  await candidate.verifyFirstoPurchaseOrder(f.provider,order);
  assert(!f.calls.some(item=>item.method==='eth_call'&&functions.parseTransaction(item.params[0]).name==='isValidSignature'));
});

test('isolated candidate drains concurrent RPC siblings before returning a verification failure',async()=>{
  const source=await batchSource(),order=parse(source),f=fixture(source),original=f.provider.request;
  let release,began,settled=false;const hold=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{began=resolve;});
  f.provider.request=async input=>{
    if(input.method==='eth_getCode')throw new Error('runtime unavailable');
    if(input.method==='eth_call'&&functions.parseTransaction(input.params[0]).name==='batchCancelled'){began();await hold;}
    return original(input);
  };
  const result=candidate.verifyFirstoPurchaseOrder(f.provider,order).then(()=>assert.fail('must reject'),error=>{settled=true;assert.match(error.message,/runtime unavailable/);});
  await started;await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);release();await result;
});

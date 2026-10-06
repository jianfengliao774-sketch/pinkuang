import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, keccak256 } from 'ethers';
import { decodeFirstoOrder,parseFirstoPurchaseAsk,verifyFirstoPurchaseOrder } from '../src/firsto-purchase.mjs';
import { FIRSTO_BATCH_RUNTIME_HASH,FIRSTO_BATCH_TUPLE,FIRSTO_LEAF_TUPLE,buildFirstoBatchOrder,firstoAskLeafHash,
  verifyFirstoMerkleProof } from '../shared/firsto-batch-order.mjs';
import { selectFirstoCandidates,verifyFirstoCandidate } from './purchase-keeper.mjs';
import { batchSource,batchProvider,collection,versionTarget,now,runtime } from './fixtures/firsto-batch-order.mjs';
const parse=source=>parseFirstoPurchaseAsk(source,{collection,tokenId:'7',owner:source.account,now});
const options={reviewedBatchProtocol:true,versionTarget};

test('batch canonical single-leaf encoding has exact separate batch/leaf identities and floor buyer fee',async()=>{
  const source=await batchSource({price:'5000000000000001'}),order=parse(source);
  assert.equal(order.kind,1);assert.equal(order.feeWei,'50000000000000');assert.equal(order.grossWei,'5050000000000001');
  assert.equal(order.askHash,source.id);assert.notEqual(order.askHash,order.batchHash);
  assert.deepEqual(decodeFirstoOrder(order.encodedOrder,1),order);
  assert.throws(()=>decodeFirstoOrder(order.encodedOrder));
  assert.throws(()=>decodeFirstoOrder(order.encodedOrder,2));
  assert.throws(()=>decodeFirstoOrder(order.encodedOrder+'00',1));
  assert(Object.isFrozen(order.leaf)&&Object.isFrozen(order.batch)&&Object.isFrozen(order.merkleProof));
});
test('sorted-pair proof covers the selected leaf and never accepts another NFT or false root',async()=>{
  const order=parse(await batchSource()),other={...order.leaf,tokenId:'8',leafIndex:'1'},sibling=firstoAskLeafHash(other);
  const coder=AbiCoder.defaultAbiCoder(),root=keccak256(coder.encode(['bytes32','bytes32'],
    BigInt(order.leafHash)<BigInt(sibling)?[order.leafHash,sibling]:[sibling,order.leafHash]));
  assert.equal(verifyFirstoMerkleProof(order.leafHash,[sibling],root),true);
  assert.equal(verifyFirstoMerkleProof(sibling,[order.leafHash],root),true);
  assert.equal(verifyFirstoMerkleProof(order.leafHash,[],root),false);
  assert.throws(()=>buildFirstoBatchOrder({...order.batch,merkleRoot:root},order.leaf,[],order.signature),/Merkle/);
  assert.throws(()=>buildFirstoBatchOrder(order.batch,{...order.leaf,batchNonce:'10'},[],order.signature),/条件不一致/);
  assert.throws(()=>buildFirstoBatchOrder(order.batch,{...order.leaf,tokenId:9007199254740992},[],order.signature),/精确整数/);
  const encoded=coder.encode([FIRSTO_BATCH_TUPLE,FIRSTO_LEAF_TUPLE,'bytes32[]','bytes'],
    [order.batch,order.leaf,Array(33).fill(sibling),order.signature]);
  assert.throws(()=>decodeFirstoOrder(encoded,1),/Merkle/);
});
test('protocol review is closed by default; order-provided ready flags grant no permission',async()=>{
  const source=await batchSource(),order=parse(source),f=batchProvider(source);
  await assert.rejects(verifyFirstoPurchaseOrder(f.provider,{...order,protocolReviewed:true,active:true},{versionTarget}),/尚未完成审核/);
  assert.equal(f.calls.length,0);
  await assert.rejects(verifyFirstoPurchaseOrder(f.provider,order,{...options,reviewedBatchProtocol:'true'}),/尚未完成审核/);
});
test('reviewed batch path checks direct raw runtime, upgraded pool and every read at one canonical BSC block',async()=>{
  assert.equal(keccak256(runtime),FIRSTO_BATCH_RUNTIME_HASH);
  const source=await batchSource(),f=batchProvider(source),order=parse(source);
  const checked=await verifyFirstoPurchaseOrder(f.provider,order,options);
  assert.equal(checked.checkedBlock.number,'0x64');assert.equal(checked.askHash,source.id);
  assert(f.calls.every(row=>!['eth_sendRawTransaction','eth_sendTransaction','eth_getStorageAt'].includes(row.method)));
  for(const row of f.calls.filter(row=>['eth_call','eth_getCode'].includes(row.method)))assert.equal(row.params.at(-1),'0x64');
});
test('runtime, old pool, network, ownership, expiry, cancelled/filled leaf, fees, approval, false hashes and reorg reject',async()=>{
  const source=await batchSource(),order=parse(source);
  for(const overrides of [{runtime:'0x6000'},{chain:'0x1'},{values:{firstoBatchPurchaseVersion:0n}},
    {values:{paused:true}},{values:{feeEpoch:2n}},{values:{feeBpsAtEpoch:101n}},{values:{BATCH_ASK_SCHEMA_VERSION:2n}},
    {values:{batchCancelled:true}},{values:{isAskLeafInvalidated:true}},{values:{ownerOf:versionTarget}},
    {values:{getApproved:versionTarget}},{values:{hashBatchAsk:'0x'+'00'.repeat(32)}},{values:{hashAskLeaf:'0x'+'00'.repeat(32)}},
    {values:{isCPU:false}},{values:{supportsInterface:false}},{values:{factory:versionTarget}},
    {finalBlock:{hash:'0x'+'cd'.repeat(32)}}])
    await assert.rejects(verifyFirstoPurchaseOrder(batchProvider(source,overrides).provider,order,options));
  const expired=await batchSource();expired.execution.expiry=String(now/1000);expired.expiresAt=now;
  assert.throws(()=>parse(expired),/摘要|过期/);
});
test('invalid signatures, false proof, forged fee totals and another target are never admitted',async()=>{
  for(const mutate of [s=>s.execution.signature='0x1234',s=>s.execution.merkleProof=['0x'+'12'.repeat(32)],
    s=>s.buyerCostWei='1000',s=>s.execution.tokenId='8',s=>s.execution.exchange=versionTarget,
    s=>s.execution.batchHash='0x'+'00'.repeat(32),s=>s.execution.leafHash='0x'+'00'.repeat(32),s=>s.execution.priceWei=1000]){
    const source=await batchSource();mutate(source);
    if(source.execution.signature==='0x1234')await assert.rejects(verifyFirstoPurchaseOrder(
      batchProvider(source,{values:{isValidSignature:'0xffffffff'}}).provider,parse(source),options),/签名无效/);
    else assert.throws(()=>parse(source));
  }
});
test('keeper admits only the original fee-inclusive batch candidate and requires independently enabled upgraded capability',async()=>{
  const source=await batchSource(),constraints={circuits:collection,circuitId:7n,priceCap:1010n,minVerifiedWeight:1n,blockNumber:100};
  const row={collection,tokenId:'7',owner:source.account,category:'official_mining',
    mining:{status:'verified',verifiedWeight:'10',unverifiedWeight:'0'},bestAsk:source};
  const candidates=selectFirstoCandidates([row],constraints,now);assert.equal(candidates.length,1);
  assert.equal(selectFirstoCandidates([row],{...constraints,priceCap:1009n},now).length,0);
  assert.equal(selectFirstoCandidates([row],{...constraints,circuitId:8n},now).length,0);
  await assert.rejects(verifyFirstoCandidate(batchProvider(source).provider,candidates[0],constraints),/尚未完成审核/);
  const verified=await verifyFirstoCandidate(batchProvider(source).provider,candidates[0],constraints,
    {pool:versionTarget,firstoBatchPurchase:{active:true,protocolReviewed:true}});
  assert.equal(verified.priceWei,1010n);assert.equal(verified.order.kind,1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AbiCoder,ZeroAddress,keccak256,toUtf8Bytes,verifyTypedData } from 'ethers';
import { parseFirstoPurchaseOrder,decodeFirstoPurchaseOrder,verifyFirstoPurchaseOrder,
  encodeFirstoBudgetOrder,decodeFirstoBudgetOrder,FIRSTO_BUDGET_ORDER_MAGIC,FIRSTO_POOL_INTERFACE,
  FIRSTO_BATCH_ASK_TUPLE,FIRSTO_ASK_LEAF_TUPLE,FIRSTO_BATCH_DOMAIN,FIRSTO_BATCH_ASK_FIELDS } from '../src/firsto-purchase.mjs';
import { signedSource,firstoProvider,collection,now } from './fixtures/firsto-order.mjs';
import { batchSource } from './fixtures/firsto-batch-order.mjs';
const parse = source => parseFirstoPurchaseOrder(source,{collection,tokenId:'7',owner:source.account,now});
const coder = AbiCoder.defaultAbiCoder();

test('generic signed route preserves raw bytes and full existing canonical-block verification',async()=>{
  const source=await signedSource(),order=parse(source),f=firstoProvider(source);
  assert.equal(order.kind,0);assert.deepEqual(decodeFirstoPurchaseOrder(order.encodedOrder,0n),order);
  assert.equal(encodeFirstoBudgetOrder(order),order.encodedOrder);
  assert.deepEqual(decodeFirstoBudgetOrder(order.encodedOrder),order);
  assert.equal((await verifyFirstoPurchaseOrder(f.provider,order)).checkedBlock.number,'0x64');
});

test('batch route binds a single proven NFT, exact floor fee, expiry and distinct leaf/batch hashes',async()=>{
  const source=await batchSource(),order=parse(source);
  assert.equal(order.kind,1);assert.equal(order.leafHash,source.id);assert.equal(order.askHash,source.execution.batchHash);
  assert.notEqual(order.askHash,order.leafHash);assert.equal(order.batch.merkleRoot,order.leafHash);
  assert.equal(order.priceWei,'5000000000000001');assert.equal(order.feeWei,'50000000000000');
  assert.equal(order.grossWei,'5050000000000001');assert.equal(order.ask.tokenId,'7');assert.equal(order.ask.expiry,source.execution.expiry);
  assert.deepEqual(decodeFirstoPurchaseOrder(order.encodedOrder,1n),order);
  assert(Object.isFrozen(order.ask));assert(Object.isFrozen(order.batch));assert(Object.isFrozen(order.leaf));assert(Object.isFrozen(order.proof));
  const call=FIRSTO_POOL_INTERFACE.parseTransaction({data:FIRSTO_POOL_INTERFACE.encodeFunctionData('buyFromFirsto',[order.kind,order.encodedOrder])});
  assert.equal(call.args[0],1n);assert.equal(call.args[1],order.encodedOrder);
});

test('batch Merkle proof uses sorted pairs and a double-hashed typed leaf',async()=>{
  const proofs=[[`0x${'00'.repeat(32)}`],[`0x${'ff'.repeat(32)}`],[`0x${'12'.repeat(32)}`,`0x${'ab'.repeat(32)}`]];
  for(const proof of proofs){
    const source=await batchSource({proof}),order=parse(source);
    assert.deepEqual(order.proof,proof);assert.notEqual(order.batch.merkleRoot,order.leafHash);
    const changed=structuredClone(source);changed.execution.merkleProof[0]=`0x${'23'.repeat(32)}`;
    assert.throws(()=>parse(changed),/Merkle/);
  }
});

test('batch metadata mismatches, unsafe numbers, zero amounts, unknown kinds and wrong route bytes fail locally',async()=>{
  const source=await batchSource();
  for(const mutate of [s=>s.status='cancelled',s=>s.venue='official',s=>s.execution.kind='batch_ask',
    s=>s.execution.chainId=1,s=>s.execution.exchange=collection,s=>s.execution.collection=ZeroAddress,
    s=>s.execution.tokenId='8',s=>s.execution.payoutRecipient=ZeroAddress,s=>s.execution.schemaVersion='2',
    s=>s.execution.batchNonce=9,s=>s.execution.leafIndex='01',s=>s.execution.priceWei=5000000000000001,
    s=>s.execution.priceWei='0',s=>s.execution.feeBps=100.1,s=>s.execution.feeEpoch='0',
    s=>s.buyerCostWei='5000000000000001',s=>s.priceWei='1',s=>s.id=s.execution.batchHash,
    s=>s.execution.leafHash=`0x${'00'.repeat(32)}`,s=>s.execution.batchHash=`0x${'00'.repeat(32)}`,
    s=>s.execution.merkleProof=[`0x${'00'.repeat(32)}`],s=>s.execution.merkleProof=['0x'],
    s=>s.execution.expiry=(2n**64n).toString(),s=>s.execution.signature=`0x${'aa'.repeat(1025)}`,
    s=>s.expiresAt=now-1]){const copy=structuredClone(source);mutate(copy);assert.throws(()=>parse(copy));}
  const order=parse(source);
  for(const kind of [2,255,-1,'1',undefined]){
    if(kind===undefined)assert.throws(()=>decodeFirstoPurchaseOrder(order.encodedOrder));
    else assert.throws(()=>decodeFirstoPurchaseOrder(order.encodedOrder,kind));
  }
  const signed=parse(await signedSource());assert.throws(()=>decodeFirstoPurchaseOrder(signed.encodedOrder,1));
});

test('batch tuple rejects mismatched batch/leaf fields, proof/sig bounds, aliases and trailing bytes',async()=>{
  const source=await batchSource(),order=parse(source),types=[FIRSTO_BATCH_ASK_TUPLE,FIRSTO_ASK_LEAF_TUPLE,FIRSTO_BATCH_DOMAIN,FIRSTO_BATCH_ASK_FIELDS,'bytes32[]','bytes'];
  for(const change of [{maker:collection},{payoutRecipient:collection},{feeBps:'101'},{feeEpoch:'2'},{batchNonce:'10'},{schemaVersion:'2'}]){
    assert.throws(()=>decodeFirstoPurchaseOrder(coder.encode(types,[{...order.batch,...change},order.leaf,order.proof,order.signature]),1));
  }
  assert.throws(()=>decodeFirstoPurchaseOrder(order.encodedOrder+'00',1));
  assert.throws(()=>decodeFirstoPurchaseOrder(order.encodedOrder.slice(0,-2)+'01',1));
  const large=await batchSource({proof:Array.from({length:32},(_,i)=>keccak256(toUtf8Bytes(String(i)))),signature:`0x${'aa'.repeat(1024)}`});
  const maximum=parse(large);assert.equal((maximum.encodedOrder.length-2)/2,2752);
  assert.deepEqual(decodeFirstoPurchaseOrder(maximum.encodedOrder,1),maximum);
  assert.throws(()=>parse({...large,execution:{...large.execution,merkleProof:[...large.execution.merkleProof,`0x${'aa'.repeat(32)}`]}}));
});

test('budget envelope is the exact three-field ABI encoding and strictly binds route and inner bytes',async()=>{
  const order=parse(await batchSource()),wrapped=encodeFirstoBudgetOrder(order);
  assert.equal(FIRSTO_BUDGET_ORDER_MAGIC,keccak256(toUtf8Bytes('BEMine Firsto order envelope v1')));
  assert.equal(wrapped.slice(0,66),FIRSTO_BUDGET_ORDER_MAGIC);
  assert.equal(wrapped,coder.encode(['bytes32','uint8','bytes'],[FIRSTO_BUDGET_ORDER_MAGIC,1,order.encodedOrder]));
  assert.deepEqual(decodeFirstoBudgetOrder(wrapped),order);
  assert.throws(()=>decodeFirstoBudgetOrder(wrapped+'00'));
  for(const kind of [0,2,255])assert.throws(()=>decodeFirstoBudgetOrder(coder.encode(['bytes32','uint8','bytes'],[FIRSTO_BUDGET_ORDER_MAGIC,kind,order.encodedOrder])));
  assert.throws(()=>decodeFirstoBudgetOrder(coder.encode(['tuple(bytes32 magic,uint8 kind,bytes inner)'],[[FIRSTO_BUDGET_ORDER_MAGIC,1,order.encodedOrder]])));
  const signed=parse(await signedSource());
  assert.throws(()=>decodeFirstoBudgetOrder(coder.encode(['bytes32','uint8','bytes'],[FIRSTO_BUDGET_ORDER_MAGIC,1,signed.encodedOrder])));
  const maximum=parse(await batchSource({proof:Array.from({length:32},(_,i)=>keccak256(toUtf8Bytes(String(i)))),signature:`0x${'aa'.repeat(1024)}`}));
  assert.equal((encodeFirstoBudgetOrder(maximum).length-2)/2,2880);
  assert.deepEqual(decodeFirstoBudgetOrder(encodeFirstoBudgetOrder(maximum)),maximum);
});

test('unreviewed batch runtime never passes a verification or RPC boundary',async()=>{
  const order=parse(await batchSource());let reads=0;
  const provider={request:async()=>{reads++;throw new Error('must not query an unreviewed deployment');}};
  await assert.rejects(verifyFirstoPurchaseOrder(provider,order),/尚未通过核验/);
  for(const change of [{kind:2},{grossWei:'1'},{encodedOrder:order.encodedOrder+'00'},{leafHash:`0x${'00'.repeat(32)}`}])
    await assert.rejects(verifyFirstoPurchaseOrder(provider,{...order,...change}));
  assert.equal(reads,0);
});


test('confirmed historical 5181 transaction reproduces the official batch digest, leaf and maker without asserting a live order',()=>{
  const evidence=JSON.parse(readFileSync(new URL('./fixtures/firsto-batch-5181-historical.json',import.meta.url),'utf8'));
  const encoded=coder.encode([FIRSTO_BATCH_ASK_TUPLE,FIRSTO_ASK_LEAF_TUPLE,'bytes32[]','bytes'],
    [evidence.batch,evidence.leaf,evidence.merkleProof,evidence.signature]);
  const order=decodeFirstoPurchaseOrder(encoded,1);
  assert.equal(order.batchHash,evidence.batchHash);assert.equal(order.leafHash,evidence.leafHash);
  assert.equal(order.grossWei,evidence.itemPaymentWei);assert.equal(order.priceWei,'1373777280000000000');
  assert.equal(verifyTypedData(FIRSTO_BATCH_DOMAIN,{BatchAsk:FIRSTO_BATCH_ASK_FIELDS},order.batch,order.signature),evidence.recoveredMaker);
  // An offline parser fixture only: the real listing was filled in the cited transaction.
  const source={id:evidence.leafHash,account:evidence.batch.maker,venue:'firsto',status:'open',
    priceWei:evidence.leaf.price,buyerCostWei:evidence.itemPaymentWei,expiresAt:Number(evidence.batch.expiry)*1000,
    execution:{...evidence.batch,...evidence.leaf,feeBps:Number(evidence.batch.feeBps),priceWei:evidence.leaf.price,
      chainId:56,kind:'circuit_batch_ask',exchange:FIRSTO_BATCH_DOMAIN.verifyingContract,merkleProof:evidence.merkleProof,
      signature:evidence.signature,batchHash:evidence.batchHash,leafHash:evidence.leafHash}};
  assert.deepEqual(parseFirstoPurchaseOrder(source,{collection:evidence.leaf.collection,tokenId:'5181',owner:evidence.batch.maker,now:1791040000000}),order);
});

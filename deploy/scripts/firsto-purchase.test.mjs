import test from 'node:test';
import assert from 'node:assert/strict';
import { ZeroAddress, keccak256 } from 'ethers';
import { parseFirstoSignedAsk, verifyFirstoSignedAsk, decodeFirstoOrder, FIRSTO_POOL_INTERFACE,
  FIRSTO_PROXY_HASH,FIRSTO_IMPLEMENTATION_HASH } from '../src/firsto-purchase.mjs';
import { signedSource,firstoProvider,collection,now,runtime } from './fixtures/firsto-order.mjs';
const parse = source => parseFirstoSignedAsk(source,{collection,tokenId:'7',owner:source.account,now});

test('exact gross includes floor source fee and canonical pool calldata carries no recipient', async () => {
  const source = await signedSource(), order = parse(source);
  assert.equal(order.priceWei,'5000000000000001');assert.equal(order.feeWei,'50000000000000');assert.equal(order.grossWei,'5050000000000001');
  assert.deepEqual(decodeFirstoOrder(order.encodedOrder),order);
  const parsed = FIRSTO_POOL_INTERFACE.parseTransaction({data:FIRSTO_POOL_INTERFACE.encodeFunctionData('buyFromFirsto',[0,order.encodedOrder])});
  assert.equal(parsed.args.length,2);assert.equal(parsed.args[0],0n);
  assert(Object.isFrozen(order.ask));assert(Object.isFrozen(order));
});

test('wrong venue, batch, chain, exchange, recipient, hashes, prices and unsafe numeric data are rejected', async () => {
  const source = await signedSource();
  for (const change of [s=>s.status='cancelled',s=>s.venue='other',s=>s.execution.kind='circuit_batch_ask',
    s=>s.execution.chainId=1,s=>s.execution.exchange=collection,s=>s.execution.collection=ZeroAddress,
    s=>s.execution.tokenId='8',s=>s.execution.payoutRecipient=ZeroAddress,s=>s.execution.schemaVersion='1',
    s=>s.id=`0x${'00'.repeat(32)}`,s=>s.execution.askHash=s.execution.signature.slice(0,66),
    s=>s.buyerCostWei='5050000000000000',s=>s.priceWei='5000000000000000',s=>s.execution.priceWei=5000000000000001,
    s=>s.execution.expiry=(2n**64n).toString(),s=>s.execution.nonce=(2n**256n).toString(),
    s=>s.expiresAt=new Date(now - 1000).toISOString(),s=>s.execution.signature=`0x${'aa'.repeat(1025)}`]) {
    const copy=structuredClone(source);change(copy);assert.throws(()=>parse(copy));
  }
});

test('inner order decoder rejects padding, trailing bytes and aliases before journal acceptance',async()=>{
  const order=parse(await signedSource());
  assert.throws(()=>decodeFirstoOrder(`${order.encodedOrder}00`));
  assert.throws(()=>decodeFirstoOrder('0x'));
  const badPadding=order.encodedOrder.slice(0,-2)+'01';
  assert.throws(()=>decodeFirstoOrder(badPadding));
});

test('reviewed runtime fixture is pinned and all Firsto reads use one canonical BSC block',async()=>{
  assert.equal(keccak256(runtime.proxy),FIRSTO_PROXY_HASH);assert.equal(keccak256(runtime.implementationCode),FIRSTO_IMPLEMENTATION_HASH);
  const source=await signedSource(),f=firstoProvider(source),order=parse(source);
  const checked=await verifyFirstoSignedAsk(f.provider,order);
  assert.equal(checked.checkedBlock.number,'0x64');assert.equal(checked.askHash,source.id);
  for (const call of f.calls.filter(c=>['eth_call','eth_getCode','eth_getStorageAt'].includes(c.method))) assert.equal(call.params.at(-1),'0x64');
  assert(f.calls.every(c=>!['eth_sendTransaction','eth_sendRawTransaction','personal_sign'].includes(c.method)));
});

test('chain runtime upgrades, fee changes, cancellation, seller transfer, approval loss and reorg all stop purchase',async()=>{
  const source=await signedSource(),order=parse(source);
  for (const overrides of [{chain:'0x1'},{proxy:'0x6000'},{implementationCode:'0x6000'},{slot:'0x'},
    {values:{factory:collection}},{values:{paused:true}},{values:{feeEpoch:2n}},{values:{defaultTakerFeeBps:101n}},
    {values:{feeBpsAtEpoch:101n}},{values:{SIGNED_ASK_SCHEMA_VERSION:1n}},{values:{isSignedAskNonceInvalidated:true}},
    {values:{ownerOf:collection}},{values:{isApprovedForAll:false}},{finalBlock:{hash:`0x${'ab'.repeat(32)}`}},
    {finalBlock:{timestamp:'0x1'}},{finalBlock:{number:'0x65'}}]) {
    await assert.rejects(verifyFirstoSignedAsk(firstoProvider(source,overrides).provider,order));
  }
});

test('ERC1271 permits bounded zero, short and long contract signatures; wrong magic fails',async()=>{
  for (const signature of ['0x','0x123456',`0x${'ab'.repeat(1024)}`]) {
    const source=await signedSource({signature,maker:collection}),order=parse(source);
    assert.equal((await verifyFirstoSignedAsk(firstoProvider(source).provider,order)).encodedOrder,order.encodedOrder);
    await assert.rejects(verifyFirstoSignedAsk(firstoProvider(source,{values:{isValidSignature:'0xffffffff'}}).provider,order),/签名无效/);
  }
});

test('changing a prepared encoding or gross total is rejected before RPC',async()=>{
  const source=await signedSource(),order=parse(source),f=firstoProvider(source);
  for (const changes of [{kind:1},{encodedOrder:`${order.encodedOrder}00`},{grossWei:'1'}])
    await assert.rejects(verifyFirstoSignedAsk(f.provider,{...order,...changes}));
  assert.equal(f.calls.length,0);
});

test('a fixed requested block cannot be silently substituted by latest',async()=>{
  const source=await signedSource(),f=firstoProvider(source);
  await assert.rejects(verifyFirstoSignedAsk(f.provider,parse(source),{blockTag:'0x63'}),/区块与请求不一致/);
  assert.equal(f.calls.filter(c=>c.method==='eth_call').length,0);
});

test('a failed parallel RPC drains siblings before allowing another verification round',async()=>{
  const source=await signedSource(),f=firstoProvider(source),base=f.provider.request;
  let release,started,settled=false;
  const hold=new Promise(resolve=>{release=resolve;});const began=new Promise(resolve=>{started=resolve;});
  f.provider.request=async input=>{
    if(input.method==='eth_getCode')throw new Error('runtime unavailable');
    if(input.method==='eth_getStorageAt'){started();await hold;}
    return base(input);
  };
  const result=verifyFirstoSignedAsk(f.provider,parse(source)).then(()=>assert.fail('must reject'),error=>{
    settled=true;assert.match(error.message,/runtime unavailable/);
  });
  await began;await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);
  release();await result;
});

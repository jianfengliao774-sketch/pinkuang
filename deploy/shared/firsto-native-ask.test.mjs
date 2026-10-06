import test from 'node:test';
import assert from 'node:assert/strict';
import { TypedDataEncoder } from 'ethers';
import { FIRSTO_ASK_FIELDS } from '../src/firsto-purchase.mjs';
import { createFirstoNativeAsk, FIRSTO_NATIVE_ASK_FIELDS, FIRSTO_NATIVE_ASK_DOMAIN, FIRSTO_NATIVE_EXCHANGE,
  FIRSTO_NATIVE_ZERO_SIGNATURE, parseFirstoNativeAskPublication, findFirstoNativeAskRecord } from './firsto-native-ask.mjs';

const pool = '0x0d776f099fe694e07a7509334067b1f92f68cd0e';
const collection = '0xb1024b89886b9a34aa4ff5f31c411d708b20a14c';
const ask = { maker: pool, collection, tokenId: 16736n, nonce: 1n, price: 15001234567890123n,
  expiry: 1791040000n, payoutRecipient: pool, feeBps: 100n, feeEpoch: 1n, schemaVersion: 2n };
const options = {pool, collection, tokenId: '16736', nativeAuthorized: true, nativeVersion: 1};
const build = (change = {}, extra = {}) => createFirstoNativeAsk({...ask, ...change}, {...options, ...extra});
const row = expected => ({askHash: expected.askHash, chainId: 56, verifyingContract: FIRSTO_NATIVE_EXCHANGE,
  ...expected.ask, priceWei: expected.ask.price, feeBps: 100, status: 'open'});

test('native ask uses the official ten-field schema and exact decimal JSON without a wallet signature', () => {
  const result = build();
  assert.deepEqual(FIRSTO_NATIVE_ASK_FIELDS, FIRSTO_ASK_FIELDS);
  assert.equal(result.askHash, TypedDataEncoder.hash(FIRSTO_NATIVE_ASK_DOMAIN, {SignedAsk:FIRSTO_ASK_FIELDS}, result.ask));
  const payload = JSON.parse(result.body);
  assert.deepEqual(Object.keys(payload), ['domain', 'primaryType', 'message', 'signature']);
  assert.equal(payload.signature, FIRSTO_NATIVE_ZERO_SIGNATURE);
  assert.equal(payload.message.price, '15001234567890123');
  for (const field of FIRSTO_NATIVE_ASK_FIELDS.filter(field => field.type !== 'address'))
    assert.equal(typeof payload.message[field.name], 'string');
  assert.equal(result.feeWei, '150012345678901');
  assert.equal(result.buyerCostWei, '15151246913569024');
  assert(Object.isFrozen(result) && Object.isFrozen(result.payload) && Object.isFrozen(result.ask));
});

test('empty and 65-zero ERC-1271 signatures require exact enabled native pool capability', () => {
  assert.equal(build({}, {signature:'0x'}).signature, '0x');
  for (const extra of [{nativeAuthorized:'true'}, {nativeAuthorized:1}, {nativeAuthorized:false},
    {nativeVersion:0}, {nativeVersion:2}, {signature:`0x${'11'.repeat(65)}`}]) assert.throws(() => build({}, extra));
  assert.throws(() => build({maker:'0x'+'22'.repeat(20)}), /卖方/);
  assert.throws(() => build({payoutRecipient:'0x'+'22'.repeat(20)}), /收款/);
  assert.throws(() => build({}, {expectedAskHash:'0x'+'00'.repeat(32)}), /授权摘要/);
  const result = build();assert.equal(build({}, {expectedAskHash:result.askHash}).askHash, result.askHash);
});

test('integer bounds reject unsafe Number coercion and retain maximal uint values exactly', () => {
  assert.throws(() => build({nonce: Number.MAX_SAFE_INTEGER + 1}), /精确整数/);
  for (const value of [true, -1, -1n, 1.2, '1e18', '0x12', '01', '', ' 1'])
    assert.throws(() => build({price:value}), /精确整数/);
  for (const [field, bits] of [['tokenId',256],['nonce',256],['price',128],['expiry',64],['feeEpoch',256]])
    assert.throws(() => build({[field]:1n << BigInt(bits)}), /超出/);
  const maximal = build({nonce:(1n<<256n)-1n,price:(1n<<128n)-1n,expiry:(1n<<64n)-1n,feeEpoch:(1n<<256n)-1n});
  assert.equal(JSON.parse(maximal.body).message.nonce, ((1n<<256n)-1n).toString());
  assert.throws(() => build({feeBps:201}), /手续费/);assert.throws(() => build({schemaVersion:1}), /不受支持/);
  assert.throws(() => build({collection:'0x'+'22'.repeat(20)}, {collection:'0x'+'22'.repeat(20)}), /不受支持/);
});

test('publication accepts only this exact hash and distinguishes pending approval from an open order', () => {
  const expected = build();
  assert.deepEqual(parseFirstoNativeAskPublication({askHash:expected.askHash,status:'open'}, expected),
    {askHash:expected.askHash,status:'open',published:true});
  assert.equal(parseFirstoNativeAskPublication({askHash:expected.askHash,status:'pending_approval'}, expected).published,false);
  for (const value of [{askHash:'0x'+'11'.repeat(32),status:'open'}, {askHash:expected.askHash,status:true},
    {askHash:expected.askHash,status:'pending_submission'}, {}, null]) assert.throws(() => parseFirstoNativeAskPublication(value, expected));
});

test('account and detail reconciliation never mistake another maker, asset, nonce or amount for this ask', () => {
  const expected = build(), exact = row(expected);
  const account = orders => ({kind:'listings',sourceBlock:'125216804',orders});
  const detail = signedAsks => ({asset:{collection,tokenId:'16736'}, orders:{signedAsks}});
  assert.equal(findFirstoNativeAskRecord(account([exact]), expected).published,true);
  assert.equal(findFirstoNativeAskRecord(detail([exact]), expected,{kind:'detail'}).askHash,expected.askHash);
  assert.equal(findFirstoNativeAskRecord(account([{...exact,askHash:'0x'+'11'.repeat(32)}]),expected),null);
  for (const change of [{maker:'0x'+'22'.repeat(20)},{collection:'0x'+'22'.repeat(20)}, {tokenId:'16737'},
    {nonce:'2'},{priceWei:'15001234567890124'},{feeEpoch:'2'},{chainId:1},{exchange:'0x'+'22'.repeat(20)}, {status:true}])
    assert.throws(() => findFirstoNativeAskRecord(account([{...exact,...change}]),expected));
  assert.throws(() => findFirstoNativeAskRecord(detail([exact]),expected,{kind:'account'}));
  assert.throws(() => findFirstoNativeAskRecord({...detail([exact]),asset:{collection,tokenId:'16737'}},expected,{kind:'detail'}));
  assert.throws(() => findFirstoNativeAskRecord(account([exact,exact]),expected), /重复/);
  assert.throws(() => findFirstoNativeAskRecord(account([{askHash:expected.askHash,status:'open'}]),expected), /缺少/);
});

test('closed indexed statuses and mismatched execution remain closed or invalid without resubmitting', () => {
  const expected=build(),exact=row(expected);
  for(const status of ['filled','cancelled','expired','asset_transferred','approval_revoked','invalid']) {
    const result=findFirstoNativeAskRecord({kind:'listings',orders:[{...exact,status}]},expected);
    assert.equal(result.status,status);assert.equal(result.published,false);
  }
  const execution={kind:'signed_ask',chainId:56,exchange:FIRSTO_NATIVE_EXCHANGE,...expected.ask,
    askHash:expected.askHash,priceWei:expected.ask.price,nonce:'2'};
  assert.throws(()=>findFirstoNativeAskRecord({kind:'listings',orders:[{...exact,execution}]},expected),/条款/);
});

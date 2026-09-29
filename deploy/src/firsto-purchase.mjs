import { AbiCoder, Interface, TypedDataEncoder, ZeroAddress, getAddress, keccak256, toQuantity, verifyTypedData } from 'ethers';

// Reviewed against the Firsto production ABI and BSC runtime on 2026-09-27.
// This pin detects an upgrade before submission; a third-party proxy can still upgrade before inclusion.
export const FIRSTO_SIGNED_EXCHANGE = '0x33423244F9a5bF81b12B1a018aF6F4e079B97f29';
export const FIRSTO_PROXY_HASH = '0xba136f70efd54699acdcbfbbbbcc6671debaa0bc7f88d67e135b6c585db938d3';
export const FIRSTO_IMPLEMENTATION_HASH = '0x743584d511d72470b2911265f7f86e43aa3e5db3d94ba5fd7652905be434d673';
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const FACTORY = '0x68224F668083c29e9800Be2a646d42d18cedF7e2';
const COLLECTIONS = ['0xb1024b89886b9a34aa4ff5f31c411d708b20a14c', '0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c'];
export const FIRSTO_ASK_FIELDS = Object.freeze([
  ['maker','address'], ['collection','address'], ['tokenId','uint256'], ['nonce','uint256'], ['price','uint128'],
  ['expiry','uint64'], ['payoutRecipient','address'], ['feeBps','uint16'], ['feeEpoch','uint256'], ['schemaVersion','uint16'],
].map(([name,type]) => Object.freeze({ name, type })));
export const FIRSTO_ASK_TUPLE = `tuple(${FIRSTO_ASK_FIELDS.map(({name,type}) => `${type} ${name}`).join(',')})`;
const DOMAIN = Object.freeze({ name:'Firsto Circuit Signed Ask', version:'2', chainId:56, verifyingContract:FIRSTO_SIGNED_EXCHANGE });
const TYPES = { SignedAsk:FIRSTO_ASK_FIELDS };
const coder = AbiCoder.defaultAbiCoder();
export const FIRSTO_POOL_INTERFACE = new Interface(['function buyFromFirsto(uint8 kind,bytes encodedOrder)']);
const exchange = new Interface([
  'function factory() view returns(address)', 'function paused() view returns(bool)',
  'function defaultTakerFeeBps() view returns(uint16)', 'function feeEpoch() view returns(uint256)',
  'function feeBpsAtEpoch(uint256) view returns(uint16)', 'function SIGNED_ASK_SCHEMA_VERSION() view returns(uint16)',
  'function isSignedAskNonceInvalidated(address,uint256) view returns(bool)',
]);
const nft = new Interface(['function ownerOf(uint256) view returns(address)', 'function getApproved(uint256) view returns(address)',
  'function isApprovedForAll(address,address) view returns(bool)']);
const signatureContract = new Interface(['function isValidSignature(bytes32,bytes) view returns(bytes4)']);
const need = (condition, message) => { if (!condition) throw new Error(message); };
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const address = value => { const result = getAddress(value); need(result !== ZeroAddress, 'Firsto 地址不能为零。'); return result; };
const integer = (value, bits = 256) => {
  need(typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && value.length <= 78, 'Firsto 金额或编号必须为精确整数。');
  const result = BigInt(value); need(result < 2n ** BigInt(bits), 'Firsto 字段超出合约范围。'); return result;
};
const hash = value => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value);
const code = value => typeof value === 'string' && /^0x(?:[\da-f]{2})+$/i.test(value);
const settle = async operations => {
  const results = await Promise.allSettled(operations);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map(result => result.value);
};

function buildOrder(ask, signature) {
  need(typeof signature === 'string' && /^0x(?:[\da-f]{2}){0,1024}$/i.test(signature), 'Firsto 签名格式无效或超过读取上限。');
  const normalized = Object.fromEntries(FIRSTO_ASK_FIELDS.map(({name,type}) => [name,
    type === 'address' ? address(ask[name]) : integer(String(ask[name]), Number(type.slice(4))).toString()]));
  need(COLLECTIONS.includes(normalized.collection.toLowerCase()) && normalized.schemaVersion === '2'
    && BigInt(normalized.price) > 0n && BigInt(normalized.feeEpoch) > 0n && BigInt(normalized.feeBps) <= 10000n, '不支持此 Firsto 订单类型或费率。');
  const frozenAsk = Object.freeze(normalized), feeWei = BigInt(normalized.price) * BigInt(normalized.feeBps) / 10000n;
  return Object.freeze({ kind:0, exchange:FIRSTO_SIGNED_EXCHANGE, ask:frozenAsk, signature,
    encodedOrder:coder.encode([FIRSTO_ASK_TUPLE,'bytes'], [frozenAsk,signature]),
    askHash:TypedDataEncoder.hash(DOMAIN,TYPES,frozenAsk), priceWei:normalized.price,
    feeWei:feeWei.toString(), grossWei:(BigInt(normalized.price) + feeWei).toString() });
}

export function decodeFirstoOrder(encodedOrder) {
  need(typeof encodedOrder === 'string' && /^0x(?:[\da-f]{2}){384,1408}$/i.test(encodedOrder), 'Firsto 订单编码超出范围。');
  const [ask,signature] = coder.decode([FIRSTO_ASK_TUPLE,'bytes'],encodedOrder);
  const result = buildOrder(ask,signature);
  need(same(encodedOrder,result.encodedOrder), 'Firsto 订单编码不是规范格式。');
  return result;
}

/** An indexer can supply an order, never an arbitrary destination, recipient or transaction payload. */
export function parseFirstoSignedAsk(source, { collection, tokenId, owner, now = Date.now() } = {}) {
  const e = source?.execution;
  need(source?.status === 'open' && source.venue === 'firsto' && e?.kind === 'signed_ask', '仅支持 Firsto 单笔签名挂单；批量挂单尚未开放。');
  need(e.chainId === 56 && same(e.exchange,FIRSTO_SIGNED_EXCHANGE), 'Firsto 交易网络或市场地址不受支持。');
  need(typeof e.schemaVersion === 'string' && typeof e.feeBps === 'number' && Number.isSafeInteger(e.feeBps), 'Firsto 协议字段格式无效。');
  for (const key of ['tokenId','nonce','priceWei','expiry','feeEpoch']) integer(e[key], key === 'priceWei' ? 128 : key === 'expiry' ? 64 : 256);
  const result = buildOrder({ ...e, price:e.priceWei },e.signature);
  need(same(result.ask.collection,address(collection)) && result.ask.tokenId === integer(tokenId).toString()
    && same(result.ask.maker,address(owner)) && same(result.ask.maker,address(source.account ?? source.seller)), 'Firsto 订单与目标矿机或卖家不一致。');
  need(result.priceWei === integer(source.priceWei).toString() && result.grossWei === integer(source.buyerCostWei).toString(), 'Firsto 含费总价不一致，请重新获取报价。');
  need(hash(e.askHash) && same(e.askHash,result.askHash) && same(source.id,result.askHash), 'Firsto 订单摘要不一致。');
  const expiresAt = typeof source.expiresAt === 'number' ? source.expiresAt : Date.parse(source.expiresAt);
  need(Number.isSafeInteger(expiresAt) && expiresAt === Number(result.ask.expiry) * 1000 && expiresAt > now, 'Firsto 订单已过期或到期时间不一致。');
  return result;
}

/** Read-only at one canonical block. Pool simulation must still verify funding, quality and settlement. */
export async function verifyFirstoSignedAsk(provider, order, { blockTag = 'latest' } = {}) {
  const canonical = buildOrder(order?.ask,order?.signature);
  need(order.kind === 0 && same(order.exchange,canonical.exchange) && same(order.askHash,canonical.askHash)
    && same(order.encodedOrder,canonical.encodedOrder) && order.grossWei === canonical.grossWei, 'Firsto 订单编码已变化。');
  const request = (method,params = []) => provider.request({ method, params });
  need(blockTag === 'latest' || typeof blockTag === 'string' && /^0x[\da-f]+$/i.test(blockTag), 'Firsto 核对区块无效。');
  const [chain,block] = await settle([request('eth_chainId'),request('eth_getBlockByNumber',[blockTag,false])]);
  need(BigInt(chain) === 56n && hash(block?.hash) && /^0x[\da-f]+$/i.test(block?.number ?? '')
    && /^0x[\da-f]+$/i.test(block?.timestamp ?? ''), '无法核对 Firsto 的 BSC 区块。');
  const tag = toQuantity(BigInt(block.number));
  need(blockTag === 'latest' || BigInt(blockTag) === BigInt(tag), 'Firsto 返回区块与请求不一致。');
  need(BigInt(canonical.ask.expiry) > BigInt(block.timestamp), 'Firsto 订单已过期。');
  const call = async (to,abi,name,args = []) => abi.decodeFunctionResult(name,
    await request('eth_call',[{ to,data:abi.encodeFunctionData(name,args) },tag]))[0];
  const a = canonical.ask;
  const [proxy,slot,factory,paused,epoch,fee,oldFee,schema,invalid,owner,approved,approvedAll] = await settle([
    request('eth_getCode',[FIRSTO_SIGNED_EXCHANGE,tag]), request('eth_getStorageAt',[FIRSTO_SIGNED_EXCHANGE,IMPLEMENTATION_SLOT,tag]),
    call(FIRSTO_SIGNED_EXCHANGE,exchange,'factory'),call(FIRSTO_SIGNED_EXCHANGE,exchange,'paused'),
    call(FIRSTO_SIGNED_EXCHANGE,exchange,'feeEpoch'),call(FIRSTO_SIGNED_EXCHANGE,exchange,'defaultTakerFeeBps'),
    call(FIRSTO_SIGNED_EXCHANGE,exchange,'feeBpsAtEpoch',[a.feeEpoch]),call(FIRSTO_SIGNED_EXCHANGE,exchange,'SIGNED_ASK_SCHEMA_VERSION'),
    call(FIRSTO_SIGNED_EXCHANGE,exchange,'isSignedAskNonceInvalidated',[a.maker,a.nonce]),
    call(a.collection,nft,'ownerOf',[a.tokenId]),call(a.collection,nft,'getApproved',[a.tokenId]),
    call(a.collection,nft,'isApprovedForAll',[a.maker,FIRSTO_SIGNED_EXCHANGE]),
  ]);
  need(code(proxy) && keccak256(proxy) === FIRSTO_PROXY_HASH && /^0x0{24}[\da-f]{40}$/i.test(slot ?? ''), 'Firsto 合约版本发生变化，暂停采购等待核验。');
  const implementation = address(`0x${slot.slice(-40)}`);
  const runtime = await request('eth_getCode',[implementation,tag]);
  need(code(runtime) && keccak256(runtime) === FIRSTO_IMPLEMENTATION_HASH, 'Firsto 实现版本发生变化，暂停采购等待核验。');
  need(same(factory,FACTORY) && !paused && schema === 2n && epoch === BigInt(a.feeEpoch)
    && fee === BigInt(a.feeBps) && oldFee === fee, 'Firsto 已暂停或手续费条件发生变化。');
  need(!invalid && same(owner,a.maker) && (same(approved,FIRSTO_SIGNED_EXCHANGE) || approvedAll === true), 'Firsto 订单已撤销、矿机已转移或出售授权失效。');
  let valid = false;
  try { valid = same(verifyTypedData(DOMAIN,TYPES,a,canonical.signature),a.maker); } catch { /* ERC-1271 need not be an ECDSA signature. */ }
  if (!valid) {
    try { valid = (await call(a.maker,signatureContract,'isValidSignature',[canonical.askHash,canonical.signature])) === '0x1626ba7e'; } catch { /* The signed exchange rejects invalid signatures as well. */ }
  }
  need(valid, 'Firsto 卖家签名无效。');
  const [after,finalChain] = await settle([request('eth_getBlockByNumber',[tag,false]),request('eth_chainId')]);
  need(after?.hash === block.hash && after?.timestamp === block.timestamp && after?.number === block.number
    && BigInt(finalChain) === 56n, 'Firsto 核对期间区块或网络变化，请重新获取。');
  return Object.freeze({ ...canonical, checkedBlock:Object.freeze({ number:tag,hash:block.hash,timestamp:block.timestamp }),implementation });
}

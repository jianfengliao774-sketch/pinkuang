import { AbiCoder, Interface, TypedDataEncoder, ZeroAddress, getAddress, keccak256, toQuantity, toUtf8Bytes, verifyTypedData } from 'ethers';

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
  need(source?.status === 'open', 'Firsto 挂单已关闭或不可用，请重新获取报价。');
  need(source.venue === 'firsto', '该挂单不属于 Firsto 签名市场。');
  need(e?.kind !== 'circuit_batch_ask', '该矿机有 Firsto 批量挂单，但当前合约不支持批量采购。');
  need(e?.kind === 'signed_ask', '当前合约不支持此 Firsto 挂单类型。');
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


// Batch ABI, domain and double-hashed Merkle leaf match Firsto's published
// production frontend (index-CCV82TiP.js, 2026-10-03). Execution still requires
// an independently reviewed deployment; indexer metadata cannot establish it.
export const FIRSTO_BATCH_EXCHANGE = '0x3F58C9cbce933c76158B2A29B0d612c46546Dc43';
// Published Firsto pin. The observed mainnet runtime does not match it. This
// private compile-time gate cannot be enabled by RPC/indexer/env/UI settings.
export const FIRSTO_BATCH_RUNTIME_HASH = '0x0a44a1aa18057cf5345eea9e1c58e4d40b0ff9c3da52c0f6eb8032320e7f23fb';
const FIRSTO_BATCH_PROVENANCE_VERIFIED = false;
export const FIRSTO_BATCH_ASK_FIELDS = Object.freeze([
  ['maker','address'], ['merkleRoot','bytes32'], ['batchNonce','uint256'], ['expiry','uint64'],
  ['payoutRecipient','address'], ['feeBps','uint16'], ['feeEpoch','uint256'], ['schemaVersion','uint16'],
].map(([name,type]) => Object.freeze({ name,type })));
export const FIRSTO_ASK_LEAF_FIELDS = Object.freeze([
  ['maker','address'], ['collection','address'], ['tokenId','uint256'], ['price','uint128'],
  ['payoutRecipient','address'], ['feeBps','uint16'], ['feeEpoch','uint256'], ['batchNonce','uint256'],
  ['leafIndex','uint256'], ['schemaVersion','uint16'],
].map(([name,type]) => Object.freeze({ name,type })));
const tupleFor = fields => `tuple(${fields.map(({name,type}) => `${type} ${name}`).join(',')})`;
export const FIRSTO_BATCH_ASK_TUPLE = tupleFor(FIRSTO_BATCH_ASK_FIELDS);
export const FIRSTO_ASK_LEAF_TUPLE = tupleFor(FIRSTO_ASK_LEAF_FIELDS);
export const FIRSTO_BATCH_DOMAIN = Object.freeze({ name:'Firsto Circuit Batch Ask',version:'1',chainId:56,verifyingContract:FIRSTO_BATCH_EXCHANGE });
export const FIRSTO_BUDGET_ORDER_MAGIC = keccak256(toUtf8Bytes('BEMine Firsto order envelope v1'));
const BATCH_TYPES = { BatchAsk:FIRSTO_BATCH_ASK_FIELDS };
const LEAF_TYPE_HASH = keccak256(toUtf8Bytes(`AskLeaf(${FIRSTO_ASK_LEAF_FIELDS.map(({name,type}) => `${type} ${name}`).join(',')})`));
const BATCH_ENCODING = [FIRSTO_BATCH_ASK_TUPLE,FIRSTO_ASK_LEAF_TUPLE,'bytes32[]','bytes'];
const BUDGET_ENCODING = ['bytes32','uint8','bytes'];
const batchExchange = new Interface([
  'function factory() view returns(address)', 'function paused() view returns(bool)',
  'function defaultTakerFeeBps() view returns(uint16)', 'function feeEpoch() view returns(uint256)',
  'function feeBpsAtEpoch(uint256) view returns(uint16)', 'function BATCH_ASK_SCHEMA_VERSION() view returns(uint16)',
  'function batchCancelled(address,uint256) view returns(bool)',
  'function isAskLeafInvalidated(address,uint256,uint256) view returns(bool)',
  `function hashBatchAsk(${FIRSTO_BATCH_ASK_TUPLE}) view returns(bytes32)`,
  `function hashAskLeaf(${FIRSTO_ASK_LEAF_TUPLE}) pure returns(bytes32)`,
]);
const purchaseKind = kind => {
  need(kind === 0 || kind === 0n || kind === 1 || kind === 1n, '不支持此 Firsto 采购路由。');
  return Number(kind);
};
const normalizeFields = (source,fields) => Object.freeze(Object.fromEntries(fields.map(({name,type}) => [name,
  type === 'address' ? address(source?.[name]) : type === 'bytes32'
    ? (need(hash(source?.[name]),'Firsto 摘要格式无效。'),source[name].toLowerCase())
    : integer(String(source?.[name]),Number(type.slice(4))).toString()])));
export function hashFirstoAskLeaf(leaf) {
  const normalized = normalizeFields(leaf,FIRSTO_ASK_LEAF_FIELDS);
  return keccak256(keccak256(coder.encode(['bytes32',...FIRSTO_ASK_LEAF_FIELDS.map(({type}) => type)],
    [LEAF_TYPE_HASH,...FIRSTO_ASK_LEAF_FIELDS.map(({name}) => normalized[name])])));
}
function buildBatchOrder(batch,leaf,proof,signature) {
  need(typeof signature === 'string' && /^0x(?:[\da-f]{2}){0,1024}$/i.test(signature), 'Firsto 签名格式无效或超过读取上限。');
  need(Array.isArray(proof) && proof.length <= 32 && proof.every(hash), 'Firsto 批量订单证明格式无效或超过读取上限。');
  const b = normalizeFields(batch,FIRSTO_BATCH_ASK_FIELDS), l = normalizeFields(leaf,FIRSTO_ASK_LEAF_FIELDS);
  need(COLLECTIONS.includes(l.collection.toLowerCase()) && b.schemaVersion === '1' && l.schemaVersion === '1'
    && BigInt(l.price) > 0n && BigInt(b.feeEpoch) > 0n && BigInt(b.feeBps) <= 10000n && BigInt(b.expiry) > 0n,
    '不支持此 Firsto 批量订单类型或费率。');
  for (const field of ['maker','payoutRecipient','feeBps','feeEpoch','batchNonce','schemaVersion'])
    need(same(String(b[field]),String(l[field])), 'Firsto 批次和矿机订单条件不一致。');
  const frozenProof = Object.freeze(proof.map(item => item.toLowerCase())), leafHash = hashFirstoAskLeaf(l);
  let root = leafHash;
  for (const sibling of frozenProof) root = keccak256(root.toLowerCase() < sibling ? root + sibling.slice(2) : sibling + root.slice(2));
  need(same(root,b.merkleRoot), 'Firsto 批量订单 Merkle 证明无效。');
  const ask = Object.freeze({...l,expiry:b.expiry}), feeWei = BigInt(l.price) * BigInt(l.feeBps) / 10000n;
  const batchHash = TypedDataEncoder.hash(FIRSTO_BATCH_DOMAIN,BATCH_TYPES,b);
  return Object.freeze({kind:1,exchange:FIRSTO_BATCH_EXCHANGE,ask,batch:b,leaf:l,proof:frozenProof,signature,
    encodedOrder:coder.encode(BATCH_ENCODING,[b,l,frozenProof,signature]),askHash:batchHash,batchHash,leafHash,
    priceWei:l.price,feeWei:feeWei.toString(),grossWei:(BigInt(l.price) + feeWei).toString()});
}

/** Decode the exact route frozen into Pool calldata; never infer a route from bytes. */
export function decodeFirstoPurchaseOrder(encodedOrder,kind = 0) {
  if (purchaseKind(kind) === 0) return decodeFirstoOrder(encodedOrder);
  need(typeof encodedOrder === 'string' && /^0x(?:[\da-f]{2}){704,2752}$/i.test(encodedOrder), 'Firsto 批量订单编码超出范围。');
  const [batch,leaf,proof,signature] = coder.decode(BATCH_ENCODING,encodedOrder);
  const result = buildBatchOrder(batch,leaf,Array.from(proof),signature);
  need(same(encodedOrder,result.encodedOrder), 'Firsto 批量订单编码不是规范格式。');
  return result;
}

/** A batch authorizes one proven leaf; it never authorizes purchasing every leaf. */
export function parseFirstoPurchaseOrder(source, {collection,tokenId,owner,now = Date.now()} = {}) {
  if (source?.execution?.kind !== 'circuit_batch_ask') return parseFirstoSignedAsk(source,{collection,tokenId,owner,now});
  const e = source.execution;
  need(source.status === 'open', 'Firsto 挂单已关闭或不可用，请重新获取报价。');
  need(source.venue === 'firsto', '该挂单不属于 Firsto 签名市场。');
  need(e.chainId === 56 && same(e.exchange,FIRSTO_BATCH_EXCHANGE), 'Firsto 交易网络或市场地址不受支持。');
  need(typeof e.schemaVersion === 'string' && typeof e.feeBps === 'number' && Number.isSafeInteger(e.feeBps), 'Firsto 协议字段格式无效。');
  for (const key of ['tokenId','batchNonce','priceWei','expiry','feeEpoch','leafIndex'])
    integer(e[key],key === 'priceWei' ? 128 : key === 'expiry' ? 64 : 256);
  const result = buildBatchOrder(e,{...e,price:e.priceWei},e.merkleProof,e.signature);
  need(same(result.ask.collection,address(collection)) && result.ask.tokenId === integer(tokenId).toString()
    && same(result.ask.maker,address(owner)) && same(result.ask.maker,address(source.account ?? source.seller)),
    'Firsto 订单与目标矿机或卖家不一致。');
  need(result.priceWei === integer(source.priceWei).toString() && result.grossWei === integer(source.buyerCostWei).toString(),
    'Firsto 含费总价不一致，请重新获取报价。');
  need(hash(e.batchHash) && same(e.batchHash,result.batchHash) && hash(e.leafHash) && same(e.leafHash,result.leafHash)
    && same(source.id,result.leafHash), 'Firsto 批量订单摘要不一致。');
  const expiresAt = typeof source.expiresAt === 'number' ? source.expiresAt : Date.parse(source.expiresAt);
  need(Number.isSafeInteger(expiresAt) && expiresAt === Number(result.ask.expiry) * 1000 && expiresAt > now,
    'Firsto 订单已过期或到期时间不一致。');
  return result;
}

/** Legacy budget calldata remains byte-for-byte unchanged. Only batch orders use the envelope. */
export function encodeFirstoBudgetOrder(order) {
  need(order?.kind === 0 || order?.kind === 1, '不支持此 Firsto 采购路由。');
  const canonical = decodeFirstoPurchaseOrder(order?.encodedOrder,order?.kind);
  need(same(canonical.askHash,order.askHash) && canonical.grossWei === order.grossWei, 'Firsto 订单编码已变化。');
  return canonical.kind === 0 ? canonical.encodedOrder : coder.encode(BUDGET_ENCODING,
    [FIRSTO_BUDGET_ORDER_MAGIC,canonical.kind,canonical.encodedOrder]);
}
export function decodeFirstoBudgetOrder(encodedOrder) {
  need(typeof encodedOrder === 'string' && /^0x(?:[\da-f]{2}){384,2880}$/i.test(encodedOrder), 'Firsto 预算订单编码超出范围。');
  if (!same(encodedOrder.slice(0,66),FIRSTO_BUDGET_ORDER_MAGIC)) return decodeFirstoOrder(encodedOrder);
  const [magic,kind,inner] = coder.decode(BUDGET_ENCODING,encodedOrder);
  need(same(magic,FIRSTO_BUDGET_ORDER_MAGIC) && kind === 1n, 'Firsto 预算订单路由无效。');
  const result = decodeFirstoPurchaseOrder(inner,kind);
  need(same(encodedOrder,coder.encode(BUDGET_ENCODING,[FIRSTO_BUDGET_ORDER_MAGIC,kind,result.encodedOrder])),
    'Firsto 预算订单编码不是规范格式。');
  return result;
}

export async function verifyFirstoPurchaseOrder(provider,order,options = {}) {
  if (purchaseKind(order?.kind) === 0) return verifyFirstoSignedAsk(provider,order,options);
  const canonical = buildBatchOrder(order?.batch,order?.leaf,order?.proof,order?.signature);
  need(order.kind === 1 && same(order.exchange,canonical.exchange) && same(order.askHash,canonical.askHash)
    && same(order.batchHash,canonical.batchHash) && same(order.leafHash,canonical.leafHash)
    && same(order.encodedOrder,canonical.encodedOrder) && order.grossWei === canonical.grossWei
    && Object.keys(canonical.ask).every(name => same(String(order.ask?.[name]),String(canonical.ask[name]))),
    'Firsto 订单编码已变化。');
  // The advertised production hash differs from the observed runtime. Until the
  // exact runtime and leaf-consumption semantics are independently reviewed,
  // no batch order may pass verification or reach a signature/send boundary.
  need(FIRSTO_BATCH_PROVENANCE_VERIFIED, 'Firsto 批量市场合约版本尚未通过核验，暂停采购等待核验。');
  const {blockTag = 'latest'} = options;
  need(blockTag === 'latest' || typeof blockTag === 'string' && /^0x[\da-f]+$/i.test(blockTag), 'Firsto 核对区块无效。');
  const request = (method,params = []) => provider.request({method,params});
  const [chain,block] = await settle([request('eth_chainId'),request('eth_getBlockByNumber',[blockTag,false])]);
  need(BigInt(chain) === 56n && hash(block?.hash) && /^0x[\da-f]+$/i.test(block?.number ?? '')
    && /^0x[\da-f]+$/i.test(block?.timestamp ?? ''), '无法核对 Firsto 的 BSC 区块。');
  const tag = toQuantity(BigInt(block.number));
  need(blockTag === 'latest' || BigInt(blockTag) === BigInt(tag), 'Firsto 返回区块与请求不一致。');
  need(BigInt(canonical.ask.expiry) > BigInt(block.timestamp), 'Firsto 订单已过期。');
  const call = async (to,abi,name,args = []) => abi.decodeFunctionResult(name,
    await request('eth_call',[{to,data:abi.encodeFunctionData(name,args)},tag]))[0];
  const b = canonical.batch, l = canonical.leaf;
  // The batch exchange is a direct deployment. Every policy/NFT/hash read is
  // pinned to the same canonical block, including the cancellation bitmap.
  const [runtime,factory,paused,epoch,fee,oldFee,schema,cancelled,invalid,owner,approved,approvedAll,batchHash,leafHash] = await settle([
    request('eth_getCode',[FIRSTO_BATCH_EXCHANGE,tag]),call(FIRSTO_BATCH_EXCHANGE,batchExchange,'factory'),
    call(FIRSTO_BATCH_EXCHANGE,batchExchange,'paused'),call(FIRSTO_BATCH_EXCHANGE,batchExchange,'feeEpoch'),
    call(FIRSTO_BATCH_EXCHANGE,batchExchange,'defaultTakerFeeBps'),call(FIRSTO_BATCH_EXCHANGE,batchExchange,'feeBpsAtEpoch',[b.feeEpoch]),
    call(FIRSTO_BATCH_EXCHANGE,batchExchange,'BATCH_ASK_SCHEMA_VERSION'),
    call(FIRSTO_BATCH_EXCHANGE,batchExchange,'batchCancelled',[b.maker,b.batchNonce]),
    call(FIRSTO_BATCH_EXCHANGE,batchExchange,'isAskLeafInvalidated',[b.maker,b.batchNonce,l.leafIndex]),
    call(l.collection,nft,'ownerOf',[l.tokenId]),call(l.collection,nft,'getApproved',[l.tokenId]),
    call(l.collection,nft,'isApprovedForAll',[l.maker,FIRSTO_BATCH_EXCHANGE]),
    call(FIRSTO_BATCH_EXCHANGE,batchExchange,'hashBatchAsk',[b]),call(FIRSTO_BATCH_EXCHANGE,batchExchange,'hashAskLeaf',[l]),
  ]);
  need(code(runtime) && keccak256(runtime) === FIRSTO_BATCH_RUNTIME_HASH, 'Firsto 合约版本发生变化，暂停采购等待核验。');
  need(same(factory,FACTORY) && paused === false && schema === 1n && epoch === BigInt(b.feeEpoch)
    && fee === BigInt(b.feeBps) && oldFee === fee, 'Firsto 已暂停或手续费条件发生变化。');
  need(cancelled === false && invalid === false && same(owner,l.maker)
    && (same(approved,FIRSTO_BATCH_EXCHANGE) || approvedAll === true), 'Firsto 订单已撤销、矿机已转移或出售授权失效。');
  need(same(batchHash,canonical.batchHash) && same(leafHash,canonical.leafHash), 'Firsto 批量订单摘要与合约不一致。');
  let valid = false;
  try { valid = same(verifyTypedData(FIRSTO_BATCH_DOMAIN,BATCH_TYPES,b,canonical.signature),b.maker); }
  catch { /* ERC-1271 signatures need not be ECDSA. Final Pool simulation remains mandatory. */ }
  if (!valid) {
    try { valid = (await call(b.maker,signatureContract,'isValidSignature',[canonical.batchHash,canonical.signature])) === '0x1626ba7e'; }
    catch { /* Candidate ERC-1271 check; actual exchange support still requires provenance review. */ }
  }
  need(valid, 'Firsto 卖家签名无效。');
  const [after,finalChain] = await settle([request('eth_getBlockByNumber',[tag,false]),request('eth_chainId')]);
  need(after?.hash === block.hash && after?.timestamp === block.timestamp && after?.number === block.number
    && BigInt(finalChain) === 56n, 'Firsto 核对期间区块或网络变化，请重新获取。');
  return Object.freeze({...canonical,checkedBlock:Object.freeze({number:tag,hash:block.hash,timestamp:block.timestamp}),
    implementation:FIRSTO_BATCH_EXCHANGE,runtimeHash:FIRSTO_BATCH_RUNTIME_HASH});
}

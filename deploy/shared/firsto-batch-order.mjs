import { AbiCoder, Interface, TypedDataEncoder, ZeroAddress, getAddress, id, keccak256, toQuantity, verifyTypedData } from 'ethers';

// Wire identity is independently observed; execution still needs an explicit
// reviewed protocol gate. An API's advertised hash is not that review.
export const FIRSTO_BATCH_EXCHANGE = '0x3F58C9cbce933c76158B2A29B0d612c46546Dc43';
export const FIRSTO_BATCH_RUNTIME_HASH = '0x84072ba0b149f0cb72a8d1be49797ba293206d931407eeb2a25eeaf9f28db0b0';
export const FIRSTO_BATCH_PROTOCOL_REVIEWED = false;
export const FIRSTO_BATCH_FIELDS = Object.freeze([
  ['maker','address'],['merkleRoot','bytes32'],['batchNonce','uint256'],['expiry','uint64'],
  ['payoutRecipient','address'],['feeBps','uint16'],['feeEpoch','uint256'],['schemaVersion','uint16'],
].map(([name,type]) => Object.freeze({ name,type })));
export const FIRSTO_LEAF_FIELDS = Object.freeze([
  ['maker','address'],['collection','address'],['tokenId','uint256'],['price','uint128'],['payoutRecipient','address'],
  ['feeBps','uint16'],['feeEpoch','uint256'],['batchNonce','uint256'],['leafIndex','uint256'],['schemaVersion','uint16'],
].map(([name,type]) => Object.freeze({ name,type })));
const tuple = fields => `tuple(${fields.map(({name,type}) => `${type} ${name}`).join(',')})`;
export const FIRSTO_BATCH_TUPLE = tuple(FIRSTO_BATCH_FIELDS), FIRSTO_LEAF_TUPLE = tuple(FIRSTO_LEAF_FIELDS);
export const FIRSTO_BATCH_DOMAIN = Object.freeze({ name:'Firsto Circuit Batch Ask',version:'1',chainId:56,verifyingContract:FIRSTO_BATCH_EXCHANGE });
const types = { BatchAsk:FIRSTO_BATCH_FIELDS }, coder = AbiCoder.defaultAbiCoder();
const leafTypehash = id(`AskLeaf(${FIRSTO_LEAF_FIELDS.map(({name,type}) => `${type} ${name}`).join(',')})`);
const collections = new Set(['0xb1024b89886b9a34aa4ff5f31c411d708b20a14c','0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c']);
const factory = '0x68224F668083c29e9800Be2a646d42d18cedF7e2';
const need = (ok,text) => { if (!ok) throw Error(text); };
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const hash = value => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value);
const addr = value => { const result=getAddress(value);need(result!==ZeroAddress,'Firsto 地址不能为零。');return result; };
const integer = (value,bits=256) => {
  need(typeof value==='string' && /^(0|[1-9]\d*)$/.test(value) && value.length<=78,'Firsto 金额或编号必须为精确整数。');
  const result=BigInt(value);need(result<2n**BigInt(bits),'Firsto 字段超出合约范围。');return result.toString();
};
const normalize = (value,fields) => {
  need(value && typeof value==='object','Firsto 批量订单字段不完整。');
  return Object.freeze(Object.fromEntries(fields.map(({name,type}) => [name,type==='address'?addr(value[name])
    :type==='bytes32'?(need(hash(value[name]),'Firsto 批量摘要无效。'),value[name].toLowerCase())
      :integer(typeof value[name]==='bigint'||typeof value[name]==='number'&&Number(type.slice(4))<=16
        &&Number.isSafeInteger(value[name])?String(value[name]):value[name],Number(type.slice(4)))])));
};
export function firstoAskLeafHash(leaf) {
  const normalized=normalize(leaf,FIRSTO_LEAF_FIELDS);
  return keccak256(keccak256(coder.encode(['bytes32',...FIRSTO_LEAF_FIELDS.map(field=>field.type)],
    [leafTypehash,...FIRSTO_LEAF_FIELDS.map(field=>normalized[field.name])])));
}
export function verifyFirstoMerkleProof(leafHash,proof,root) {
  need(hash(leafHash)&&hash(root)&&Array.isArray(proof)&&proof.length<=32&&proof.every(hash),'Firsto Merkle 证明格式无效。');
  let value=leafHash;
  for(const sibling of proof) value=keccak256(coder.encode(['bytes32','bytes32'],
    BigInt(value)<BigInt(sibling)?[value,sibling]:[sibling,value]));
  return same(value,root);
}
export function buildFirstoBatchOrder(batchValue,leafValue,proofValue,signature) {
  const batch=normalize(batchValue,FIRSTO_BATCH_FIELDS),leaf=normalize(leafValue,FIRSTO_LEAF_FIELDS);
  need(typeof signature==='string' && /^0x(?:[\da-f]{2}){0,1024}$/i.test(signature),'Firsto 签名格式无效或超过读取上限。');
  need(batch.schemaVersion==='1'&&leaf.schemaVersion==='1'&&collections.has(leaf.collection.toLowerCase())
    &&BigInt(leaf.price)>0n&&BigInt(batch.expiry)>0n&&BigInt(batch.feeEpoch)>0n&&BigInt(batch.feeBps)<=10000n,'不支持此 Firsto 批量订单类型或费率。');
  for(const key of ['maker','payoutRecipient','feeBps','feeEpoch','batchNonce','schemaVersion'])
    need(same(String(batch[key]),String(leaf[key])),'Firsto 批量订单与矿机叶子条件不一致。');
  const leafHash=firstoAskLeafHash(leaf);
  need(verifyFirstoMerkleProof(leafHash,proofValue,batch.merkleRoot),'Firsto Merkle 证明与批量订单不匹配。');
  const merkleProof=Object.freeze(proofValue.map(value=>value.toLowerCase()));
  const fee=BigInt(leaf.price)*BigInt(leaf.feeBps)/10000n;
  return Object.freeze({kind:1,exchange:FIRSTO_BATCH_EXCHANGE,batch,leaf,ask:leaf,merkleProof,signature,
    batchHash:TypedDataEncoder.hash(FIRSTO_BATCH_DOMAIN,types,batch),leafHash,askHash:leafHash,
    encodedOrder:coder.encode([FIRSTO_BATCH_TUPLE,FIRSTO_LEAF_TUPLE,'bytes32[]','bytes'],[batch,leaf,merkleProof,signature]),
    priceWei:leaf.price,feeWei:fee.toString(),grossWei:(BigInt(leaf.price)+fee).toString()});
}
export function decodeFirstoBatchOrder(encodedOrder) {
  need(typeof encodedOrder==='string'&&/^0x(?:[\da-f]{2}){704,2752}$/i.test(encodedOrder),'Firsto 批量订单编码超出范围。');
  const decoded=coder.decode([FIRSTO_BATCH_TUPLE,FIRSTO_LEAF_TUPLE,'bytes32[]','bytes'],encodedOrder);
  const result=buildFirstoBatchOrder(...decoded);
  need(same(result.encodedOrder,encodedOrder),'Firsto 批量订单编码不是规范格式。');return result;
}
export function parseFirstoBatchAsk(source,{collection,tokenId,owner,now=Date.now()}={}) {
  const e=source?.execution;
  need(source?.status==='open'&&source.venue==='firsto'&&e?.kind==='circuit_batch_ask','Firsto 批量挂单已关闭或不可用。');
  need(e.chainId===56&&same(e.exchange,FIRSTO_BATCH_EXCHANGE),'Firsto 批量交易网络或市场地址不受支持。');
  need(typeof e.schemaVersion==='string'&&typeof e.feeBps==='number'&&Number.isSafeInteger(e.feeBps),'Firsto 协议字段格式无效。');
  for(const key of ['tokenId','priceWei','batchNonce','leafIndex','expiry','feeEpoch'])
    integer(e[key],key==='priceWei'?128:key==='expiry'?64:256);
  const order=buildFirstoBatchOrder(e,{...e,price:e.priceWei},e.merkleProof,e.signature);
  need(same(order.leaf.collection,addr(collection))&&order.leaf.tokenId===integer(tokenId)
    &&same(order.leaf.maker,addr(owner))&&same(order.leaf.maker,addr(source.account??source.seller)),'Firsto 订单与目标矿机或卖家不一致。');
  need(order.priceWei===integer(source.priceWei)&&order.grossWei===integer(source.buyerCostWei),'Firsto 含费总价不一致，请重新获取报价。');
  need(hash(e.batchHash)&&same(e.batchHash,order.batchHash)&&hash(e.leafHash)&&same(e.leafHash,order.leafHash)
    &&same(source.id,order.leafHash),'Firsto 批量订单或叶子摘要不一致。');
  const expiry=typeof source.expiresAt==='number'?source.expiresAt:Date.parse(source.expiresAt);
  need(Number.isSafeInteger(expiry)&&expiry===Number(order.batch.expiry)*1000&&expiry>now,'Firsto 订单已过期或到期时间不一致。');
  return order;
}

export const FIRSTO_BATCH_READ_ABI = new Interface([
  'function factory() view returns(address)','function paused() view returns(bool)',
  'function defaultTakerFeeBps() view returns(uint16)','function feeEpoch() view returns(uint256)',
  'function feeBpsAtEpoch(uint256) view returns(uint16)','function BATCH_ASK_SCHEMA_VERSION() view returns(uint16)',
  'function batchCancelled(address,uint256) view returns(bool)','function isAskLeafInvalidated(address,uint256,uint256) view returns(bool)',
  `function hashBatchAsk(${FIRSTO_BATCH_TUPLE}) view returns(bytes32)`,
  `function hashAskLeaf(${FIRSTO_LEAF_TUPLE}) view returns(bytes32)`,
]);
const nft=new Interface(['function ownerOf(uint256) view returns(address)','function getApproved(uint256) view returns(address)',
  'function isApprovedForAll(address,address) view returns(bool)','function factory() view returns(address)',
  'function supportsInterface(bytes4) view returns(bool)']);
const factoryAbi=new Interface(['function isCPU(address) view returns(bool)']);
const signatureContract=new Interface(['function isValidSignature(bytes32,bytes) view returns(bytes4)']);
const versionAbi=new Interface(['function firstoBatchPurchaseVersion() view returns(uint16)']);
const settle=async operations=>{const results=await Promise.allSettled(operations),failed=results.find(row=>row.status==='rejected');
  if(failed)throw failed.reason;return results.map(row=>row.value);};

/** Permission is supplied only by reviewed local service configuration or a
 * verified product capability, never by an order/indexer flag. Closed by default. */
export async function verifyFirstoBatchAsk(provider,order,{blockTag='latest',reviewedBatchProtocol=FIRSTO_BATCH_PROTOCOL_REVIEWED,versionTarget}={}) {
  need(reviewedBatchProtocol===true,'Firsto 批量协议尚未完成审核，当前仅供参考。');
  const versionAddress=addr(versionTarget),canonical=buildFirstoBatchOrder(order?.batch,order?.leaf,order?.merkleProof,order?.signature);
  need(order.kind===1&&same(order.exchange,canonical.exchange)&&same(order.askHash,canonical.askHash)
    &&same(order.batchHash,canonical.batchHash)&&same(order.leafHash,canonical.leafHash)
    &&same(order.encodedOrder,canonical.encodedOrder)&&order.grossWei===canonical.grossWei
    &&order.priceWei===canonical.priceWei&&order.feeWei===canonical.feeWei
    &&FIRSTO_LEAF_FIELDS.every(({name})=>same(String(order.ask?.[name]),String(canonical.leaf[name]))),'Firsto 订单编码已变化。');
  need(blockTag==='latest'||typeof blockTag==='string'&&/^0x[\da-f]+$/i.test(blockTag),'Firsto 核对区块无效。');
  const request=(method,params=[])=>provider.request({method,params});
  const [chain,block]=await settle([request('eth_chainId'),request('eth_getBlockByNumber',[blockTag,false])]);
  need(BigInt(chain)===56n&&hash(block?.hash)&&/^0x[\da-f]+$/i.test(block?.number??'')&&/^0x[\da-f]+$/i.test(block?.timestamp??''),'无法核对 Firsto 的 BSC 区块。');
  const tag=toQuantity(BigInt(block.number)),b=canonical.batch,l=canonical.leaf;
  need(blockTag==='latest'||BigInt(blockTag)===BigInt(tag),'Firsto 返回区块与请求不一致。');
  need(BigInt(b.expiry)>BigInt(block.timestamp),'Firsto 订单已过期。');
  const call=async(to,abi,name,args=[])=>abi.decodeFunctionResult(name,await request('eth_call',[{to,data:abi.encodeFunctionData(name,args)},tag]))[0];
  const [runtime,version,onchainFactory,paused,epoch,fee,epochFee,schema,cancelled,invalid,batchHash,leafHash,owner,approved,all,cpu,collectionFactory,erc721]=await settle([
    request('eth_getCode',[FIRSTO_BATCH_EXCHANGE,tag]),call(versionAddress,versionAbi,'firstoBatchPurchaseVersion'),
    call(FIRSTO_BATCH_EXCHANGE,FIRSTO_BATCH_READ_ABI,'factory'),call(FIRSTO_BATCH_EXCHANGE,FIRSTO_BATCH_READ_ABI,'paused'),
    call(FIRSTO_BATCH_EXCHANGE,FIRSTO_BATCH_READ_ABI,'feeEpoch'),call(FIRSTO_BATCH_EXCHANGE,FIRSTO_BATCH_READ_ABI,'defaultTakerFeeBps'),
    call(FIRSTO_BATCH_EXCHANGE,FIRSTO_BATCH_READ_ABI,'feeBpsAtEpoch',[b.feeEpoch]),call(FIRSTO_BATCH_EXCHANGE,FIRSTO_BATCH_READ_ABI,'BATCH_ASK_SCHEMA_VERSION'),
    call(FIRSTO_BATCH_EXCHANGE,FIRSTO_BATCH_READ_ABI,'batchCancelled',[b.maker,b.batchNonce]),
    call(FIRSTO_BATCH_EXCHANGE,FIRSTO_BATCH_READ_ABI,'isAskLeafInvalidated',[b.maker,b.batchNonce,l.leafIndex]),
    call(FIRSTO_BATCH_EXCHANGE,FIRSTO_BATCH_READ_ABI,'hashBatchAsk',[b]),call(FIRSTO_BATCH_EXCHANGE,FIRSTO_BATCH_READ_ABI,'hashAskLeaf',[l]),
    call(l.collection,nft,'ownerOf',[l.tokenId]),call(l.collection,nft,'getApproved',[l.tokenId]),
    call(l.collection,nft,'isApprovedForAll',[l.maker,FIRSTO_BATCH_EXCHANGE]),
    call(factory,factoryAbi,'isCPU',[l.collection]),call(l.collection,nft,'factory'),call(l.collection,nft,'supportsInterface',['0x80ac58cd']),
  ]);
  need(typeof runtime==='string'&&/^0x(?:[\da-f]{2})+$/i.test(runtime)&&keccak256(runtime)===FIRSTO_BATCH_RUNTIME_HASH,'Firsto 批量合约版本发生变化，暂停采购等待核验。');
  need(version===1n,'当前矿池尚未升级 Firsto 批量采购。');
  need(same(onchainFactory,factory)&&cpu===true&&same(collectionFactory,factory)&&erc721===true&&!paused&&schema===1n
    &&epoch===BigInt(b.feeEpoch)&&fee===BigInt(b.feeBps)&&epochFee===fee,'Firsto 已暂停、矿机来源无效或手续费条件发生变化。');
  need(!cancelled&&!invalid&&same(batchHash,canonical.batchHash)&&same(leafHash,canonical.leafHash),'Firsto 批量订单已撤销、叶子已失效或订单摘要变化。');
  need(same(owner,l.maker)&&(same(approved,FIRSTO_BATCH_EXCHANGE)||all===true),'Firsto 矿机已转移或出售授权失效。');
  let valid=false;try{valid=same(verifyTypedData(FIRSTO_BATCH_DOMAIN,types,b,canonical.signature),b.maker);}catch{}
  if(!valid){try{valid=await call(b.maker,signatureContract,'isValidSignature',[canonical.batchHash,canonical.signature])==='0x1626ba7e';}catch{}}
  need(valid,'Firsto 卖家签名无效。');
  const [after,finalChain]=await settle([request('eth_getBlockByNumber',[tag,false]),request('eth_chainId')]);
  need(after?.hash===block.hash&&after?.number===block.number&&after?.timestamp===block.timestamp&&BigInt(finalChain)===56n,'Firsto 核对期间区块或网络变化，请重新获取。');
  return Object.freeze({...canonical,checkedBlock:Object.freeze({number:tag,hash:block.hash,timestamp:block.timestamp}),implementation:FIRSTO_BATCH_EXCHANGE});
}

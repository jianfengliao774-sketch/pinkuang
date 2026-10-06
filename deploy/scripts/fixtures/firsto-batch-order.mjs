import { readFileSync } from 'node:fs';
import { Interface, TypedDataEncoder, Wallet } from 'ethers';
import { FIRSTO_BATCH_DOMAIN, FIRSTO_BATCH_FIELDS, FIRSTO_BATCH_EXCHANGE, FIRSTO_BATCH_READ_ABI,
  firstoAskLeafHash, buildFirstoBatchOrder } from '../../shared/firsto-batch-order.mjs';
export const runtime=JSON.parse(readFileSync(new URL('./firsto-batch-runtime.json',import.meta.url),'utf8')).runtimeCode;
export const collection='0xb1024b89886b9a34aa4ff5f31c411d708b20a14c';
export const versionTarget='0x2222222222222222222222222222222222222222';
export const now=1800000000000;
const wallet=new Wallet('0x'+'11'.repeat(32));
export async function batchSource({signature,maker=wallet.address,price='1000',tokenId='7'}={}) {
  const leaf={maker,collection,tokenId,price,payoutRecipient:maker,feeBps:'100',feeEpoch:'1',batchNonce:'9',leafIndex:'0',schemaVersion:'1'};
  const batch={maker,merkleRoot:firstoAskLeafHash(leaf),batchNonce:'9',expiry:String(now/1000+3600),
    payoutRecipient:maker,feeBps:'100',feeEpoch:'1',schemaVersion:'1'};
  signature??=await wallet.signTypedData(FIRSTO_BATCH_DOMAIN,{BatchAsk:FIRSTO_BATCH_FIELDS},batch);
  const order=buildFirstoBatchOrder(batch,leaf,[],signature);
  return {id:order.leafHash,status:'open',venue:'firsto',account:maker,priceWei:price,buyerCostWei:order.grossWei,
    expiresAt:Number(batch.expiry)*1000,execution:{...batch,...leaf,priceWei:price,feeBps:100,chainId:56,
      kind:'circuit_batch_ask',exchange:FIRSTO_BATCH_EXCHANGE,batchHash:order.batchHash,leafHash:order.leafHash,merkleProof:[],signature}};
}
const nft=new Interface(['function ownerOf(uint256) view returns(address)','function getApproved(uint256) view returns(address)',
  'function isApprovedForAll(address,address) view returns(bool)','function factory() view returns(address)',
  'function supportsInterface(bytes4) view returns(bool)']);
const version=new Interface(['function firstoBatchPurchaseVersion() view returns(uint16)']);
const factoryAbi=new Interface(['function isCPU(address) view returns(bool)']);
const signatureAbi=new Interface(['function isValidSignature(bytes32,bytes) view returns(bytes4)']);
const factory='0x68224F668083c29e9800Be2a646d42d18cedF7e2';
export function batchProvider(source,overrides={}) {
  const calls=[],block={number:'0x64',hash:'0x'+'ab'.repeat(32),timestamp:'0x'+(now/1000).toString(16),...overrides.block};
  const values={firstoBatchPurchaseVersion:1n,factory,paused:false,feeEpoch:1n,defaultTakerFeeBps:100n,feeBpsAtEpoch:100n,
    BATCH_ASK_SCHEMA_VERSION:1n,batchCancelled:false,isAskLeafInvalidated:false,hashBatchAsk:source.execution.batchHash,
    hashAskLeaf:source.execution.leafHash,ownerOf:source.account,getApproved:FIRSTO_BATCH_EXCHANGE,isApprovedForAll:false,
    isCPU:true,supportsInterface:true,isValidSignature:'0x1626ba7e',...overrides.values};
  let blocks=0;
  return {calls,provider:{async request(input){
    calls.push(input);const {method,params}=input;
    if(method==='eth_chainId')return overrides.chain??'0x38';
    if(method==='eth_getBlockByNumber')return ++blocks>1&&overrides.finalBlock?{...block,...overrides.finalBlock}:block;
    if(method==='eth_getCode')return overrides.runtime??runtime;
    if(method==='eth_call'){
      const to=params[0].to.toLowerCase(),abi=to===FIRSTO_BATCH_EXCHANGE.toLowerCase()?FIRSTO_BATCH_READ_ABI
        :to===(overrides.versionTarget??versionTarget).toLowerCase()?version:to===factory.toLowerCase()?factoryAbi:to===collection.toLowerCase()?nft:signatureAbi;
      const parsed=abi.parseTransaction(params[0]);return abi.encodeFunctionResult(parsed.name,[values[parsed.name]]);
    }
    throw Error(`Unexpected read method ${method}`);
  }}};
}

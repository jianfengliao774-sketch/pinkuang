import { AbiCoder, TypedDataEncoder, Wallet, keccak256, toUtf8Bytes } from 'ethers';
import { FIRSTO_BATCH_EXCHANGE } from '../../src/firsto-purchase.mjs';
import { collection,now } from './firsto-order.mjs';

const wallet = new Wallet(`0x${'11'.repeat(32)}`); // Public deterministic test fixture only.
const fields = [
  {name:'maker',type:'address'},{name:'merkleRoot',type:'bytes32'},{name:'batchNonce',type:'uint256'},
  {name:'expiry',type:'uint64'},{name:'payoutRecipient',type:'address'},{name:'feeBps',type:'uint16'},
  {name:'feeEpoch',type:'uint256'},{name:'schemaVersion',type:'uint16'},
];
const leafTypes = ['address','address','uint256','uint128','address','uint16','uint256','uint256','uint256','uint16'];
const typeHash = keccak256(toUtf8Bytes('AskLeaf(address maker,address collection,uint256 tokenId,uint128 price,address payoutRecipient,uint16 feeBps,uint256 feeEpoch,uint256 batchNonce,uint256 leafIndex,uint16 schemaVersion)'));
const coder = AbiCoder.defaultAbiCoder();
export async function batchSource({signature,maker=wallet.address,price='5000000000000001',proof=[],leafIndex='0',expiry=String(now / 1000 + 600)} = {}) {
  const leaf = {maker,collection,tokenId:'7',price,payoutRecipient:maker,feeBps:100,feeEpoch:'1',batchNonce:'9',leafIndex,schemaVersion:'1'};
  const leafHash = keccak256(keccak256(coder.encode(['bytes32',...leafTypes],
    [typeHash,maker,collection,'7',price,maker,100,'1','9',leafIndex,'1'])));
  let merkleRoot = leafHash;
  for (const sibling of proof) merkleRoot = keccak256(merkleRoot.toLowerCase() < sibling.toLowerCase()
    ? merkleRoot+sibling.slice(2) : sibling+merkleRoot.slice(2));
  const batch = {maker,merkleRoot,batchNonce:'9',expiry,payoutRecipient:maker,feeBps:100,feeEpoch:'1',schemaVersion:'1'};
  const domain = {name:'Firsto Circuit Batch Ask',version:'1',chainId:56,verifyingContract:FIRSTO_BATCH_EXCHANGE};
  const types = {BatchAsk:fields},batchHash = TypedDataEncoder.hash(domain,types,batch);
  return {id:leafHash,account:maker,venue:'firsto',status:'open',priceWei:price,
    buyerCostWei:(BigInt(price)+BigInt(price)/100n).toString(),expiresAt:Number(expiry)*1000,
    execution:{...batch,...leaf,price:undefined,priceWei:price,kind:'circuit_batch_ask',chainId:56,
      exchange:FIRSTO_BATCH_EXCHANGE,merkleProof:proof,leafHash,batchHash,
      signature:signature ?? await wallet.signTypedData(domain,types,batch)}};
}

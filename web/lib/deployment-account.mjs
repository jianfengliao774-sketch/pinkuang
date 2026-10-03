import { getAddress, ZeroAddress, toQuantity } from 'ethers';
const need=(ok,message)=>{if(!ok)throw new Error(message);};
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
/** This only controls a link to the separately authenticated deployment console.
 * Identity comes from the release-pinned successful genesis transaction, never
 * from an operator role or a user-supplied address. */
export async function readDeploymentAccount(provider, manifest) {
  const anchor=manifest?.deployment;
  need(/^0x[0-9a-f]{64}$/i.test(anchor?.txHash||'')&&/^0x[0-9a-f]{64}$/i.test(anchor?.blockHash||'')
    &&Number.isSafeInteger(anchor?.blockNumber)&&anchor.blockNumber>=0,'部署交易核验资料不可用。');
  const rpc=(method,params=[])=>provider.request({method,params});
  need(BigInt(await rpc('eth_chainId'))===56n,'部署交易网络不一致。');
  const tag=toQuantity(anchor.blockNumber);
  const [tx,receipt,block,head]=await Promise.all([
    rpc('eth_getTransactionByHash',[anchor.txHash]),rpc('eth_getTransactionReceipt',[anchor.txHash]),
    rpc('eth_getBlockByNumber',[tag,false]),rpc('eth_blockNumber'),
  ]);
  need(tx&&receipt&&block&&same(tx.hash,anchor.txHash)&&same(receipt.transactionHash,anchor.txHash)
    &&BigInt(receipt.status)===1n&&BigInt(tx.chainId)===56n
    &&BigInt(tx.blockNumber)===BigInt(anchor.blockNumber)&&BigInt(receipt.blockNumber)===BigInt(anchor.blockNumber)
    &&BigInt(block.number)===BigInt(anchor.blockNumber)&&BigInt(head)>=BigInt(anchor.blockNumber)+12n
    &&same(tx.blockHash,anchor.blockHash)&&same(receipt.blockHash,anchor.blockHash)&&same(block.hash,anchor.blockHash)
    &&same(tx.from,receipt.from),'部署交易尚未完成一致性核验。');
  const account=getAddress(tx.from);need(account!==ZeroAddress,'部署钱包不可用。');
  need(same((await rpc('eth_getBlockByNumber',[tag,false]))?.hash,anchor.blockHash)
    &&BigInt(await rpc('eth_chainId'))===56n,'部署交易区块已变化。');
  return account;
}

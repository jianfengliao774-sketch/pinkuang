// A wallet's two floating reads are not proof of an outstanding transaction.
// The independent node supplies a block-pinned confirmed nonce. Wallet views
// may lag that proof, but must never lead it before we request a signature.
const quantity = /^0x(?:0|[1-9a-f][\da-f]*)$/i;
const hash = /^0x[\da-f]{64}$/i;
const address = /^0x[\da-f]{40}$/i;
export class PortfolioNonceError extends Error {
  constructor(code,message,observation=null) { super(message); this.code=code; this.observation=observation; }
}
function count(value,source) {
  if(typeof value!=='string'||!quantity.test(value)||BigInt(value)>BigInt(Number.MAX_SAFE_INTEGER))
    throw new PortfolioNonceError('INVALID',`${source}返回的交易序号格式异常，尚未发送交易。`);
  return BigInt(value);
}
function block(value) {
  if(!value||typeof value.number!=='string'||!quantity.test(value.number)||!hash.test(value.hash??'')||BigInt(value.number)<1n||BigInt(value.number)>BigInt(Number.MAX_SAFE_INTEGER))
    throw new PortfolioNonceError('INVALID','只读节点的最新区块格式异常，尚未发送交易。');
  return {number:value.number,hash:value.hash.toLowerCase()};
}
export async function readPortfolioDustNonce({wallet,rpc,account,transactions={},onObservation=()=>{}}) {
  if(!address.test(account)) throw new PortfolioNonceError('INVALID','部署账户格式无效。');
  // No nonce observation can establish the outcome of an original request.
  if(Object.values(transactions).some(tx=>tx.status!=='confirmed'))
    throw new PortfolioNonceError('ORIGINAL','原交易结果尚未确认，请先恢复原交易；不会重复发送。');
  const floor=Object.values(transactions).filter(tx=>!tx.from||tx.from.toLowerCase()===account.toLowerCase())
    .reduce((max,tx)=>BigInt(tx.nonce)>max?BigInt(tx.nonce):max,-1n);
  let observation;
  for(let attempt=0;attempt<3;attempt++) {
    const anchor=block(await rpc('eth_getBlockByNumber',['latest',false]));
    const [confirmedRaw,pendingRaw,walletLatestRaw,walletPendingRaw]=await Promise.all([
      rpc('eth_getTransactionCount',[account,anchor.number]),rpc('eth_getTransactionCount',[account,'pending']),
      wallet.request({method:'eth_getTransactionCount',params:[account,'latest']}),
      wallet.request({method:'eth_getTransactionCount',params:[account,'pending']}),
    ]);
    const confirmed=count(confirmedRaw,'只读节点'),pending=count(pendingRaw,'只读节点'),
      walletLatest=count(walletLatestRaw,'钱包节点'),walletPending=count(walletPendingRaw,'钱包节点');
    const canonical=block(await rpc('eth_getBlockByNumber',[anchor.number,false]));
    if(canonical.number!==anchor.number||canonical.hash!==anchor.hash)
      throw new PortfolioNonceError('REORG','核对期间区块发生变化，请重新核对；尚未发送交易。');
    observation={blockNumber:Number(BigInt(anchor.number)),blockHash:anchor.hash,confirmed:confirmed.toString(),
      pending:pending.toString(),walletLatest:walletLatest.toString(),walletPending:walletPending.toString(),attempt:attempt+1};
    onObservation(observation);
    if(confirmed>floor&&pending===confirmed&&walletLatest<=confirmed&&walletPending<=confirmed)
      return {...observation,nonce:confirmed.toString()};
    // Refresh a bounded number of times when a transaction mined between reads
    // or one node is behind. Never choose max(latest,pending) and skip a nonce.
  }
  const n=observation.confirmed;
  if(BigInt(observation.pending)>BigInt(n)&&BigInt(n)>floor)
    throw new PortfolioNonceError('PENDING',`链上节点仍有待确认交易（已确认序号 ${n}，待确认序号 ${observation.pending}）。请先在钱包查看原交易。`,observation);
  throw new PortfolioNonceError('SYNC',`交易序号暂未同步（链上 ${n}，钱包 ${observation.walletLatest}/${observation.walletPending}）。尚未发送交易，稍后核对即可。`,observation);
}

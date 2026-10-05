import { getAddress, getCreateAddress, keccak256 } from 'ethers';
import { evidenceDigest } from './firsto-upgrade-proof.mjs';
const hash = /^0x[\da-f]{64}$/i;
const same = (a,b) => typeof a==='string' && typeof b==='string' && a.toLowerCase()===b.toLowerCase();
const need = (ok,message) => { if(!ok) throw new Error(message); };
export function portfolioDustJournalKey(config) { return `bemine.portfolio-dust.v1.${evidenceDigest(config)}`; }
export function newPortfolioDustJournal(config,salt,delaySeconds) {
  need(hash.test(salt) && BigInt(salt)!==0n,'本次排程 salt 无效。');
  need(Number.isSafeInteger(delaySeconds) && delaySeconds>=172800,'升级必须等待至少 48 小时。');
  return {kind:'portfolio-dust-journal-v1',configDigest:evidenceDigest(config),salt,delaySeconds,transactions:{},failed:[]};
}
export function parsePortfolioDustJournal(value,config) {
  need(value?.kind==='portfolio-dust-journal-v1' && same(value.configDigest,evidenceDigest(config)),'部署记录不属于本次批量矿池补丁。');
  need(Object.keys(value).every(k=>['kind','configDigest','salt','delaySeconds','transactions','failed'].includes(k)),'部署记录含未知操作。');
  const fresh=newPortfolioDustJournal(config,value.salt,value.delaySeconds);
  need(value.transactions && Object.keys(value.transactions).every(k=>['deploy','schedule'].includes(k)),'部署记录含其它合约操作。');
  for(const [step,tx] of Object.entries(value.transactions)) {
    need(tx && ['uncertain','submitted','confirmed'].includes(tx.status) && same(tx.from,step==='deploy'?config.deployer:config.proposer)
      && hash.test(tx.dataHash) && typeof tx.nonce==='string' && /^\d+$/.test(tx.nonce)
      && BigInt(tx.nonce)<=BigInt(Number.MAX_SAFE_INTEGER),'部署交易记录格式无效。');
    need(!tx.txHash || hash.test(tx.txHash),'原交易哈希无效。');
    need(tx.status!=='submitted' || !!tx.txHash,'已提交交易缺少原哈希。');
    if(tx.status==='confirmed') need(hash.test(tx.txHash) && hash.test(tx.blockHash) && Number.isSafeInteger(tx.blockNumber)
      && tx.blockNumber>0 && (step!=='deploy' || same(tx.address,getCreateAddress({from:tx.from,nonce:BigInt(tx.nonce)}))),'已确认交易缺少完整部署证据。');
  }
  need(!value.transactions.schedule || value.transactions.deploy?.status==='confirmed','必须先核验补丁部署再排程。');
  need(Array.isArray(value.failed) && value.failed.every(row=>['deploy','schedule'].includes(row.step)
    && hash.test(row.txHash) && hash.test(row.blockHash) && Number.isSafeInteger(row.blockNumber) && row.blockNumber>0),'失败交易归档无效。');
  return {...fresh,transactions:value.transactions,failed:value.failed};
}
export async function verifyPortfolioDustReceipt(provider,txHash,expected) {
  need(hash.test(txHash),'请提供完整原交易哈希。');
  const [tx,receipt,finalized]=await Promise.all([provider.getTransaction(txHash),provider.getTransactionReceipt(txHash),provider.getBlock('finalized')]);
  if(!tx || !receipt || !finalized || receipt.blockNumber>finalized.number) return null;
  need(tx.chainId===56n && same(tx.hash,txHash) && same(receipt.hash,txHash) && same(tx.from,expected.from)
    && tx.nonce===Number(BigInt(expected.nonce)) && tx.value===0n && same(keccak256(tx.data),expected.dataHash)
    && (expected.to?same(tx.to,expected.to):tx.to===null),'原交易与本次固定部署步骤不符。');
  need(tx.blockNumber===receipt.blockNumber && same(tx.blockHash,receipt.blockHash),'原交易和回执区块不一致。');
  const block=await provider.getBlock(receipt.blockNumber);
  need(block?.hash && same(block.hash,receipt.blockHash) && Array.isArray(block.transactions)
    && same(block.transactions[receipt.index],txHash),'原交易尚未获得规范链确认。');
  need(receipt.status===0 || receipt.status===1,'原回执状态无效。');
  if(receipt.status===1 && !expected.to) need(same(receipt.contractAddress,getCreateAddress({from:expected.from,nonce:BigInt(expected.nonce)})),
    '新合约地址与原部署 nonce 不一致。');
  return {success:receipt.status===1,txHash,blockNumber:receipt.blockNumber,blockHash:receipt.blockHash,
    ...(receipt.contractAddress?{address:receipt.contractAddress}:{})};
}
export function assertPortfolioDustConfirmedState(step,receipt,proof) {
  need(receipt.success===true && Number.isSafeInteger(proof.blockNumber) && proof.blockNumber>=receipt.blockNumber,
    '当前链状态尚未追上原交易回执，请稍后核对。');
  need(proof.replacementVerified===true,'补丁完整运行代码未获得核验。');
  if(step==='schedule') need(['waiting','ready','done'].includes(proof.operation),
    '原排程目前不存在或已被取消。记录保留，请先核对原链上操作，不会重复排程。');
}

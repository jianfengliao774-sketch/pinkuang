/** Lightweight public-file reader. No keeper, credential, chain RPC or Firsto dependencies. */
import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { getAddress } from 'ethers';
const same=(a,b)=>getAddress(a)===getAddress(b);
export const saleReferenceMessages = {disabled:'后台自动参考价需完成一次合约升级后启用。',idle:'当前无需更新挂牌参考价。',
  reading:'后台正在读取 Firsto 官方参考价。',queued:'参考价正在等待代付队列。',pending:'参考价更新交易正在确认。',
  confirmed:'Firsto 市场参考价已更新。','source-unavailable':'Firsto 来源暂不可用，保留最近参考价。',
  'gas-paused':'参考价代付预算暂不可用，后台稍后自动恢复。','review-required':'参考价交易需要运营处理，已保留交易记录。'};

/** Public business status only. Reading this file cannot schedule a quote or transaction. */
export function readSaleReferencePublisherStatus(path,{factory,market,pool,now=Date.now}={}) {
  const normalized=getAddress(pool),blank={schemaVersion:1,chainId:56,factory,market,updatedAt:null,enabled:false,stale:false,
    item:{pool:normalized,status:'disabled',proposalId:null,message:saleReferenceMessages.disabled}};
  if (!path || !existsSync(path)) return blank;
  if(lstatSync(path).size>1_000_000) throw new Error('Reference status exceeds its read bound.');
  const bytes=readFileSync(path);if(bytes.length>1_000_000) throw new Error('Reference status exceeds its read bound.');
  const value=JSON.parse(bytes.toString('utf8')),stamp=Date.parse(value.updatedAt);
  if (value.schemaVersion!==1 || value.chainId!==56 || !same(value.factory,factory) || !same(value.market,market)
    || typeof value.enabled!=='boolean' || !Number.isSafeInteger(stamp) || stamp>now()+30_000) throw new Error('Reference status identity is invalid.');
  const item=value.pools?.[normalized.toLowerCase()] ?? {...blank.item,status:value.enabled?'idle':'disabled',message:saleReferenceMessages[value.enabled?'idle':'disabled']};
  if (!same(item.pool,normalized) || !Object.hasOwn(saleReferenceMessages,item.status)) throw new Error('Reference status row is invalid.');
  return {schemaVersion:1,chainId:56,factory,market,updatedAt:value.updatedAt,enabled:value.enabled,stale:now()-stamp>90_000,item};
}

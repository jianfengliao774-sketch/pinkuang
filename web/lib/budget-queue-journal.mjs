import { getAddress } from 'ethers';
import { validateBudgetQueue } from './budget-purchase-plan.mjs';

function endpoint(config,parent){
  const base=config?.journalBase??'/api/journal';
  if(!/^\/(?!\/)[a-zA-Z0-9_/-]+$/.test(base)||base.includes('..'))throw new Error('交易记录必须使用本站服务。');
  return `${base.replace(/\/$/,'')}/budget-queue?parent=${encodeURIComponent(getAddress(parent))}`;
}
async function request({config,account,parent,method='GET',body,fetcher=globalThis.fetch}){
  const response=await fetcher(endpoint(config,parent),{method,credentials:'same-origin',cache:'no-store',
    headers:{'X-Pinkuang-Account':getAddress(account),...(body===undefined?{}:{'Content-Type':'application/json'})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20_000)});
  const value=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(value.error||`服务端采购队列不可用（${response.status}）。请先连接钱包并完成本站登录。`);
  return value;
}
export async function readBudgetQueue({config,account,parent,fetcher}){
  const view=await request({config,account,parent,fetcher});
  if(!Number.isSafeInteger(view.revision)||view.revision<0||view.record!==null&&typeof view.record!=='object')
    throw new Error('服务端采购队列格式异常。');
  if(view.record)validateBudgetQueue(view.record,{config,account,parent});
  return view;
}
export async function writeBudgetQueue({config,account,parent,record,expectedRevision,fetcher}){
  validateBudgetQueue(record,{config,account,parent});
  if(record.approved!==true||!Number.isSafeInteger(expectedRevision)||expectedRevision<0)
    throw new Error('采购队列尚未审批或服务端版本无效。');
  const result=await request({config,account,parent,method:'PUT',body:{record,expectedRevision},fetcher});
  if(result.revision!==expectedRevision+1)throw new Error('服务端采购队列回执异常，请重新加载并核对。');
  return result.revision;
}

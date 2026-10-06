import { fetchLiveJson } from './live-config.mjs';
const need=(condition,message)=>{if(!condition)throw Error(message);};
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();

/** Read-only market jobs finish before a transaction intent or wallet nonce is reserved. */
export async function pollMarketDiscovery(url,{fetcher=globalThis.fetch,maxBytes=1048576,maxWaitMs=75000,
  now=Date.now,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),onProgress}={}){
  need(typeof url==='string'&&/^\/(?!\/)/.test(url),'Discovery must use this site.');
  const query=new URL(url,'https://local.invalid');query.searchParams.set('async','1');
  const field=query.pathname.endsWith('/budget-candidates')?'parent':'pool',target=query.searchParams.get(field),
    block=query.searchParams.get('block'),hash=query.searchParams.get('hash'),start=now();
  for(let attempt=0;attempt<40;attempt++){
    need(now()-start<maxWaitMs,'完整官网扫描超时，请稍后重试 / Complete official scan timed out.');
    let result;try{result=await fetchLiveJson(query.pathname+query.search,{fetcher,maxBytes,timeoutMs:Math.min(12000,maxWaitMs-(now()-start))});}
    catch(error){if(error?.details?.status===409)throw Error('扫描区块已变化或过期，请重新读取采购预览 / Discovery block changed or expired. Refresh the preview.');throw error;}
    if(result?.complete===true)return result;
    need(result?.status==='scanning','官网候选扫描不完整 / Official discovery is incomplete.');
    need(result?.status==='scanning'&&result.complete===false&&result.chainId===56&&same(result[field],target)
      &&result.blockNumber===block&&same(result.blockHash,hash)&&Number.isInteger(result.retryAfterMs)
      &&result.retryAfterMs>=1000&&result.retryAfterMs<=3000,'扫描任务与项目或区块不一致 / Discovery job identity changed.');
    onProgress?.({status:'scanning',elapsedMs:now()-start});
    need(now()-start+result.retryAfterMs<maxWaitMs,'完整官网扫描超时，请稍后重试 / Complete official scan timed out.');
    await wait(result.retryAfterMs);
  }
  throw Error('完整官网扫描未完成，暂停采购 / Official scan is incomplete; purchase is paused.');
}

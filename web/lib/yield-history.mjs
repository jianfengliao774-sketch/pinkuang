const windows = new WeakMap();
const keyFor = ({pool,account,days,scope='pool'}) => JSON.stringify([
  scope,String(pool).toLowerCase(),account?.toLowerCase() || 'public',days,
]);

/** The chart's ledger has its own confirmed source, independent of live detail reads. */
export function cachedYieldWindow(client, query) {
  return windows.get(client)?.get(keyFor(query))?.result ?? null;
}

/** Cache only successful range reads; a failed refresh never erases loaded history. */
export function readYieldWindow(client, {pool,account,days,scope='pool'},
  {revision='',now=Date.now,ttlMs=120_000}={}) {
  if (!client || typeof client.readYield!=='function') throw new Error('Yield reader is unavailable.');
  if (![7,30].includes(days) || !['pool','portfolio'].includes(scope)) throw new Error('Invalid yield window.');
  let cache=windows.get(client);
  if (!cache) {cache=new Map();windows.set(client,cache);}
  const key=keyFor({pool,account,days,scope}), previous=cache.get(key), at=now();
  if (previous?.promise && previous.pendingRevision===revision) return previous.promise;
  if (previous?.result && previous.revision===revision && at>=previous.savedAt && at-previous.savedAt<ttlMs)
    return Promise.resolve(previous.result);
  const entry={result:previous?.result,revision:previous?.revision,savedAt:previous?.savedAt,pendingRevision:revision};
  entry.promise=Promise.resolve().then(()=>client.readYield({pool,account:account || undefined,days,scope}))
    .then(result=>{
      if (cache.get(key)===entry) {entry.result=result;entry.revision=revision;entry.savedAt=now();delete entry.promise;}
      return result;
    },error=>{if(cache.get(key)===entry)delete entry.promise;throw error;});
  cache.set(key,entry);
  if(cache.size>64)cache.delete(cache.keys().next().value);
  return entry.promise;
}

const atomic = value => typeof value==='bigint' && value>=0n ? value
  : typeof value==='string' && /^(0|[1-9]\d*)$/.test(value) ? BigInt(value) : null;

/** Absence stays unknown. Valid zero buckets are a real zero-income period. */
export function yieldChartModel(data) {
  if (!data || !Array.isArray(data.buckets) || !data.buckets.length) return null;
  const rows=[];let total=0n,claimed=data.account?0n:null,maximum=1n;
  for(const row of data.buckets) {
    const collected=atomic(row.poolHarvestNetAtomic), personal=data.account?atomic(row.accountClaimedAtomic):null;
    if(collected===null || data.account && personal===null || !/^\d{4}-\d{2}-\d{2}$/.test(row.date))return null;
    rows.push({...row,poolHarvestNetAtomic:collected,accountClaimedAtomic:personal});
    total+=collected;if(claimed!==null)claimed+=personal;
    if(collected>maximum)maximum=collected;
  }
  return {rows,total,claimed,maximum,days:rows.length,empty:total===0n};
}

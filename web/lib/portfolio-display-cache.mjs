const entries = new Map();
const ttl = 120_000;
const same = (a,b) => typeof a==='string' && typeof b==='string' && a.toLowerCase()===b.toLowerCase();
const zero='0x0000000000000000000000000000000000000000';
const address=value=>/^0x[\da-f]{40}$/i.test(value||'') && !same(value,zero);
const integers=['blockNumber','state','budgetWei','absoluteCapWei','unitCapWei','spentWei','shares',
  'totalSupply','availableShares','claimableBem','withdrawableBnb','fundingDeadline','purchaseDeadline','timestamp'];
const key = (config,pool,account,revision=0) => JSON.stringify([config?.artifactDigest,config?.stage,
  config?.factory?.toLowerCase(), config?.stageActivationBlock,config?.stageActivationHash,
  (config?.deployment || config?.manifest?.deployment)?.txHash,
  (config?.deployment || config?.manifest?.deployment)?.blockHash,
  config?.portfolioFactory?.toLowerCase(),config?.portfolioMarket?.toLowerCase(),
  pool?.toLowerCase(),(account||zero).toLowerCase(),revision]);

/** Rows from a completed bound read only. The cached row is display data;
 * callers always clear their current action proof before showing it. */
export function rememberPortfolioDisplay(config,row,account,now=Date.now(),revision=0) {
  if(config?.kind!=='integrated-v2'||row?.kind!=='portfolio'
    || !same(row.OFFICIAL_FACTORY,config.portfolioFactory) || !same(row.legacyFactory,config.factory)
    || !same(row.account,account||zero) || !address(row.pool)
    || integers.some(field=>field==='blockNumber' && row.displayOnly && row[field]===null
      ? false : typeof row[field]!=='bigint'||row[field]<0n)
    || row.state>5n || row.shares>100n || row.totalSupply>100n || row.availableShares>row.shares
    || row.budgetWei===0n || row.budgetWei%100n!==0n
    || !row.displayOnly && !/^0x[\da-f]{64}$/i.test(row.blockHash||'') || !Array.isArray(row.children)
    || !Array.isArray(row.proposals))return false;
  const id=key(config,row.pool,account,revision); entries.delete(id);
  entries.set(id,{row,savedAt:now});
  if(entries.size>24)entries.delete(entries.keys().next().value);
  return true;
}
export function readPortfolioDisplay(config,pool,account,now=Date.now(),revision=0) {
  const id=key(config,pool,account,revision),saved=entries.get(id);
  if(!saved||now<saved.savedAt||now-saved.savedAt>=ttl){entries.delete(id);return null;}
  return saved.row;
}
export const clearPortfolioDisplays = () => entries.clear();

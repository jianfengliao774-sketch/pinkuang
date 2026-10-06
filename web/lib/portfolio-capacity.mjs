import { getAddress, ZeroAddress } from 'ethers';
import { readPortfolioContext, readPortfolio, readPortfolioChildren, readPortfolioDisplayRow, readPortfolioDisplayChildren } from './live-portfolios.mjs';
import { readShareDailyCapacityPrice, shareDailyCapacityPriceWei } from './share-daily-capacity.mjs';
import { fetchMineDetail, MAX_QUOTE_AGE_MS } from '../../deploy/src/pricing.ts';
import { QUOTE_BASE } from './quote-base.mjs';

const no = reason => Object.freeze({ available: false, reason });
const same = (a,b) => getAddress(a) === getAddress(b);

/** Complete parent estimate. Display only; never modifies order prices or transaction amounts. */
export async function readPortfolioDailyCapacity(config, provider, {
  pool, portfolio, blockNumber, pricePerUnitWei, quoteLoader, fetcher, now = Date.now(), signal, onProgress,
} = {}) {
  const startedAt=Date.now();
  const check = () => { if (signal?.aborted) throw new Error('cancelled'); };
  try {
    check();
    const direct = config?.displayOnly === true;
    const ctx = direct ? null : await readPortfolioContext(config, provider, blockNumber);
    const parent = direct ? portfolio ?? (await readPortfolioDisplayRow(config, provider, pool, ZeroAddress,
      { ...(fetcher ? { fetcher } : {}), now: () => now })).item
      : await readPortfolio(ctx, pool, ZeroAddress, {includeChildren:false});
    if (direct && (parent?.kind !== 'portfolio' || parent.displayOnly !== true || !same(parent.pool,pool)
      || !same(parent.OFFICIAL_FACTORY,config.manifest?.portfolioFactory) || !same(parent.legacyFactory,config.manifest?.factory)
      || !Array.isArray(parent.children) || ['childCount','activeChildCount','timestamp','unitPriceWei'].some(key=>typeof parent[key]!=='bigint'||parent[key]<0n)
      || parent.activeChildCount>parent.childCount || parent.childCount>BigInt(Number.MAX_SAFE_INTEGER)
      || BigInt(parent.children.length)>parent.childCount)) return no('invalid_parent');
    const observed = Number(parent.timestamp * 1000n);
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(observed) || observed > now + 30000 || now-observed > MAX_QUOTE_AGE_MS) return no('stale_block');
    if(pricePerUnitWei!==undefined&&!(typeof pricePerUnitWei==='bigint'||typeof pricePerUnitWei==='string'&&/^(0|[1-9]\d*)$/.test(pricePerUnitWei)))return no('invalid_price');
    const unitPrice = pricePerUnitWei === undefined ? parent.unitPriceWei : BigInt(pricePerUnitWei);
    if (unitPrice < 0n || unitPrice >= 2n ** 256n) return no('invalid_price');
    let daily=0n, inspected=0n, retained=0n, sold=0n, pendingSale=0n, tracked=0n, validUntil=observed+MAX_QUOTE_AGE_MS;
    const seenPools=new Set(),seenAssets=new Set(),quotes=[];
    for(let offset=0n;offset<parent.childCount;offset+=100n){
      const expected=parent.childCount-offset<100n?parent.childCount-offset:100n;
      check();
      const cachedChildren=direct?parent.children.slice(Number(offset),Number(offset+expected)):[];
      const children=direct ? BigInt(cachedChildren.length)===expected ? cachedChildren
        : await readPortfolioDisplayChildren(config,provider,parent,offset)
        : await readPortfolioChildren(ctx,parent.pool,parent.childCount,offset);
      check();
      if(BigInt(children.length)!==expected)return no('incomplete_children');
      for(const child of children){
        if(direct && (typeof child.tokenId!=='bigint'||child.tokenId<0n||child.tokenId>=2n**256n
          ||typeof child.state!=='bigint'||typeof child.sold!=='boolean'))return no('child_identity');
        const identity=`${getAddress(child.collection)}:${child.tokenId.toString()}`,key=getAddress(child.pool);
        if(seenPools.has(key)||seenAssets.has(identity))return no('duplicate_child');seenPools.add(key);seenAssets.add(identity);
        if(child.sold){if(child.state!==4n)return no('child_state');sold++;continue;}
        tracked++;
        if(child.state===4n){pendingSale++;continue;}
        if(![2n,3n].includes(child.state))return no('child_state');
        retained++;
      }
      const held=children.filter(child=>!child.sold&&child.state!==4n);
      for(let i=0;i<held.length;i+=4){
        check();
        const batch=held.slice(i,i+4);
        const results=await Promise.allSettled(batch.map(child=>readShareDailyCapacityPrice(provider,{
          factory:(ctx?.manifest ?? config.manifest).factory,pool:child.pool,pricePerUnitWei:unitPrice,now,
          ...(direct ? {displayOnly:true,params:{circuits:child.collection,circuitId:child.tokenId},
            quoteLoader:async(collection,tokenId)=>{
              const detail=await (quoteLoader ?? ((c,id)=>fetchMineDetail(c,id,{baseUrl:QUOTE_BASE,displayOnly:true})))(collection,tokenId);
              const asset=detail?.asset,mining=asset?.mining;
              if(!asset || !same(asset.collection,collection) || String(asset.tokenId)!==tokenId || !same(asset.owner,child.pool)
                || asset.category!=='official_mining' || asset.classification!=='official_mining'
                || mining?.tokenSymbol!=='BEM' || mining.tokenDecimals!==8)throw new Error('child_quote_identity');
              return detail;
            }} : {blockNumber:parent.blockNumber,quoteLoader}),
        })));
        check();
        for(let j=0;j<batch.length;j++){
          const result=results[j],child=batch[j];
          if(result.status!=='fulfilled'||!result.value.available)return no('unknown_child_output');
          const quote=result.value;
          if(!same(quote.pool,child.pool)||!same(quote.collection,child.collection)||quote.tokenId!==child.tokenId.toString()
            ||(direct ? quote.displayOnly!==true||quote.sourceBlock!==null : quote.sourceBlock!==parent.blockNumber)
            ||quote.estimated24hAtomic<=0n)return no('child_identity');
          daily+=quote.estimated24hAtomic;validUntil=Math.min(validUntil,quote.validUntil);
          quotes.push(Object.freeze({pool:child.pool,collection:child.collection,tokenId:child.tokenId,
            estimated24hAtomic:quote.estimated24hAtomic,miningSourceBlock:quote.miningSourceBlock,observedAt:quote.observedAt}));
        }
      }
      inspected+=BigInt(children.length);onProgress?.({inspected,total:parent.childCount});
    }
    if(inspected!==parent.childCount||tracked!==parent.activeChildCount)return no('incomplete_children');
    if(!direct)await ctx.canonical();check();
    if(now+Date.now()-startedAt>=validUntil)return no('stale_quote');
    return Object.freeze({available:true,pool:parent.pool,sourceBlock:direct?null:parent.blockNumber,blockHash:direct?null:parent.blockHash,
      ...(direct?{displayOnly:true,transactionReady:false}:{}),
      inspectedChildren:inspected,retainedChildren:retained,soldChildren:sold,pendingSaleChildren:pendingSale,
      estimated24hAtomic:daily,estimated24hPerShareNumerator:daily,estimated24hPerShareDenominator:100n,
      pricePerUnitWei:unitPrice,priceWeiPerDailyBem:daily>0n?shareDailyCapacityPriceWei(unitPrice,daily):null,
      observedAt:observed,validUntil,basis:pricePerUnitWei===undefined?'original_budget_per_share':'explicit_share_price',
      quotes:Object.freeze(quotes)});
  }catch(error){return no(signal?.aborted?'cancelled':'unavailable');}
}

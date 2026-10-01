import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { Interface, ZeroAddress, getAddress, toQuantity } from 'ethers';
import { createHash } from 'node:crypto';
import { MiningOverviewStats } from './overview-stats.mjs';

const artifacts = JSON.parse(readFileSync(new URL('../../public/deployment-artifacts.json', import.meta.url)));
const lensAbi = new Interface(artifacts.artifacts.PoolLens.abi);
const binding = new Interface(['function lens() view returns(address)', 'function factory() view returns(address)', 'function VERSION() view returns(uint256)']);
const fields = ['params','state','unitPriceWei','totalRaised','totalSupply','memberCount','depositPaused','purchaseCost','activatedAt','shareTradingAllowed','shares','lockedShares','availableShares','claimableBEM','bnbOwed','initialContributedWei'];
const paramNames = ['circuits','circuitId','targetRaise','priceCap','directSeller','directPrice','fundingDeadline','purchaseDeadline'];
const personal = fields.slice(10);
export const cacheEncode = (_key, value) => typeof value === 'bigint' ? { $bemineBigInt: value.toString() } : value;
export const cacheDecode = (_key, value) => value && typeof value === 'object' && Object.keys(value).length === 1
  && /^(0|[1-9]\d*)$/.test(value.$bemineBigInt ?? '') ? BigInt(value.$bemineBigInt) : value;
const same = (a,b) => a?.toLowerCase() === b?.toLowerCase();
const need = (ok, message) => { if (!ok) throw new Error(message); };
const revisionStats = stats => stats ? {...stats,miningOverview:{...stats.miningOverview,observedAt:null}} : null;
function decodeRow(raw) {
  const s = raw.status, good = bit => (s.validMask & (1n << BigInt(bit))) !== 0n && (s.errorMask & (1n << BigInt(bit))) === 0n;
  const trusted = s.trustError === 0n && good(0);
  const row = { pool: getAddress(raw.pool), trusted,
    status: { validMask:s.validMask,errorMask:s.errorMask,trustError:s.trustError } };
  fields.forEach((name,i) => { row[name] = trusted && good(i+1) ? raw[name] : null; });
  if (row.params) row.params = Object.fromEntries(paramNames.map(name => [name,row.params[name]]));
  return row;
}

/** Full on-chain display state is produced in the background, never on an HTTP request. */
export class PoolDisplayCache {
  constructor(index, provider, { lens, path, now = Date.now, quoteLoader = null, onUpdate = null } = {}) {
    this.index=index; this.provider=provider; this.lens=getAddress(lens); this.path=path; this.now=now;
    this.value=null; this.running=null; this.stopped=false;
    this.miningOverview=new MiningOverviewStats({quoteLoader,now});
    this.quoteRunning=null; this.onUpdate=onUpdate;
    try { const saved=JSON.parse(readFileSync(path,'utf8'),cacheDecode);
      if (saved.schemaVersion===1 && same(saved.source.factory,index.factory) && same(saved.source.market,index.market)
        && same(saved.lens,this.lens)) {this.value=saved;this.miningOverview.restore(saved.miningQuotes);}
    } catch { /* The first background pass seeds a missing or corrupt cache. */ }
  }
  async call(to, iface, name, args, block) {
    const raw=await this.provider.send('eth_call',[{to,data:iface.encodeFunctionData(name,args)},toQuantity(block)]);
    return iface.decodeFunctionResult(name,raw);
  }
  refresh() {
    if (this.running || this.stopped) return this.running ?? Promise.resolve();
    this.running=this.capture().finally(()=>{this.running=null;});
    return this.running;
  }
  async capture() {
    const directory=this.index.verifiedDisplaySnapshot();
    if (!directory?.pools) return;
    const source={...directory.source}, block=source.indexedThrough;
    const [header,chain,factoryLens,lensFactory,version]=await Promise.all([
      this.provider.getBlock(block),this.provider.send('eth_chainId',[]),
      this.call(this.index.factory,binding,'lens',[],block),this.call(this.lens,binding,'factory',[],block),
      this.call(this.lens,binding,'VERSION',[],block)]);
    need(BigInt(chain)===56n && same(header?.hash,source.indexedBlockHash) && header.timestamp===source.indexedTimestamp
      && same(factoryLens[0],this.lens) && same(lensFactory[0],this.index.factory) && version[0]===1n,'Display binding changed.');
    const pools=this.index.db.prepare('SELECT address FROM pools ORDER BY address').all().map(row=>row.address);
    need(pools.length<=500 && String(pools.length)===source.registeredPoolCount,'Display pool coverage unavailable.');
    const accounts=new Set();
    for (const row of this.index.db.prepare("SELECT args FROM logs WHERE kind IN ('pool','market')").iterate()) {
      const args=JSON.parse(row.args);
      for (const name of ['user','member','proposer','voter','seller','buyer','from','to']) {
        const a=args[name]; if (/^0x[\da-f]{40}$/i.test(a ?? '') && a.toLowerCase()!==ZeroAddress
          && !pools.includes(a.toLowerCase()) && ![this.index.factory,this.index.market].includes(a.toLowerCase())) accounts.add(a.toLowerCase());
      }
    }
    const accountList=[...accounts].sort().slice(0,200);
    const rows={}, accountRows={}, marketOwed={};
    const readRows=async account=>{
      const result=[];
      for(let offset=0;offset<pools.length;offset+=20) {
        const addresses=pools.slice(offset,offset+20);
        const [part]=await this.call(this.lens,lensAbi,'positions',[addresses,account],block);
        need(part.blockNumber===BigInt(block) && part.timestamp===BigInt(header.timestamp) && part.registryCountValid
          && part.totalPools===BigInt(pools.length) && part.pools.length===addresses.length,'Display block or coverage mismatch.');
        part.pools.forEach((raw,i)=>{need(same(raw.pool,addresses[i]),'Display pool mismatch.');const row=decodeRow(raw);
          need(row.trusted,'Untrusted display pool.'); result.push(row);});
      }
      return result;
    };
    const publicRows=await readRows(ZeroAddress);
    publicRows.forEach(row=>{ personal.forEach(name=>{row[name]=null;});rows[row.pool.toLowerCase()]=row; });
    const miningStats=this.miningOverview.snapshot(publicRows);
    let next=0;
    const marketAbi=new Interface(artifacts.artifacts.ShareMarket.abi);
    await Promise.all(Array.from({length:Math.min(3,accountList.length)},async()=>{
      while(next<accountList.length && !this.stopped) {
        const account=accountList[next++];
        const list=await readRows(account);
        accountRows[account]=Object.fromEntries(list.map(row=>[row.pool.toLowerCase(),row]));
        marketOwed[account]=(await this.call(this.index.market,marketAbi,'bnbOwed',[account],block))[0];
      }
    }));
    const orders=[];
    for(const order of directory.orders ?? []) {
      const [raw]=await this.call(this.index.market,marketAbi,'orders',[order.orderId],block);
      const [expiresAt]=await this.call(this.index.market,marketAbi,'orderExpiresAt',[order.orderId],block);
      need(same(raw.pool,order.pool) && same(raw.seller,order.seller),'Display order identity mismatch.');
      orders.push({...order,orderId:BigInt(order.orderId),id:order.orderId,remaining:raw.remaining,shares:raw.remaining,
        pricePerUnitWei:raw.pricePerUnit,active:raw.active,expiresAt,
        openAtSourceBlock:raw.active && raw.remaining>0n && expiresAt>BigInt(header.timestamp),
        shareTradingAllowed:rows[raw.pool.toLowerCase()]?.shareTradingAllowed ?? null,
        executable:false,requiresLatestSimulation:true});
    }
    const final=await this.provider.getBlock(block);
    need(same(final?.hash,source.indexedBlockHash) && this.index.snapshotTrusted
      && same(this.index._header(block)?.hash,source.indexedBlockHash),'Display source was reorganized.');
    if(this.stopped) return;
    const value={schemaVersion:1,lens:this.lens,source:{...source,checkedAt:new Date(this.now()).toISOString()},
      savedAt:this.now(),directory:directory.pools.map(row=>row.address),rows,accountRows,marketOwed,
      accountsComplete:accounts.size<=200,orders:directory.orders===null?null:orders,
      stats:directory.stats ? {...directory.stats,...miningStats} : null};
    this.save(value);
    // Quote HTTP work cannot hold up pool, wallet balance or order materialization.
    this.refreshMining(publicRows);
  }
  save(value) {
    value.miningQuotes=this.miningOverview.persistedQuotes();
    value.displayRevision=createHash('sha256').update(JSON.stringify([value.rows,value.accountRows,value.marketOwed,value.orders,revisionStats(value.stats)],cacheEncode)).digest('hex');
    if(this.path) {const temporary=this.path+'.tmp';writeFileSync(temporary,JSON.stringify(value,cacheEncode),{mode:0o600});renameSync(temporary,this.path);}
    this.value=value;
  }
  refreshMining(rows) {
    if(this.quoteRunning || this.stopped) return;
    this.quoteRunning=this.miningOverview.capture(rows).then(stats=>{
      if(this.stopped || !this.value?.stats || !stats.miningOverview.minerIdentityDigest
        || stats.miningOverview.minerIdentityDigest!==this.value.stats.miningOverview?.minerIdentityDigest) return;
      const revision=this.value.displayRevision;
      this.save({...this.value,stats:{...this.value.stats,...stats}});
      if(this.value.displayRevision!==revision) this.onUpdate?.();
    }).catch(()=>{/* Existing quotes and business display data remain available. */})
      .finally(()=>{this.quoteRunning=null;});
  }
  snapshot() {
    const v=this.value;
    if(!v || !this.index.snapshotTrusted || !this.index.verifiedDisplaySnapshot()
      || this.now()-v.savedAt>30*60_000 || v.savedAt>this.now()
      || !same(this.index._header(v.source.indexedThrough)?.hash,v.source.indexedBlockHash)) return null;
    // Quote lifetimes are independent of the longer business display lifetime.
    // Derive them for reads too, including after restart or a failed RPC refresh.
    const stats=v.stats ? {...v.stats,...this.miningOverview.snapshot(Object.values(v.rows))} : null;
    // Reuse the stored business generation; hashing every account row per HTTP
    // request would turn a small overview refresh into fleet-wide CPU work.
    const displayRevision=createHash('sha256').update(JSON.stringify([v.displayRevision,revisionStats(stats)],cacheEncode)).digest('hex');
    return {...v,stats,displayRevision,source:{...v.source,readMode:'verified_snapshot',stale:true,transactionReady:false,
      refreshing:Boolean(this.running),cacheOrigin:'server',cacheAgeMs:this.now()-v.savedAt}};
  }
  revision() {
    const cached=this.snapshot();
    if(!cached?.displayRevision) return null;
    const tip=this.index.db.prepare('SELECT block_number FROM logs ORDER BY block_number DESC,tx_index DESC,log_index DESC LIMIT 1').get();
    // A new event must not announce a display generation which still predates it.
    if(tip && tip.block_number>cached.source.indexedThrough) return null;
    return cached.displayRevision;
  }
  async close() {this.stopped=true;this.miningOverview.close();await Promise.allSettled([this.running,this.quoteRunning]);}
}

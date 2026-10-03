import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Interface,ZeroAddress,keccak256} from 'ethers';
import {ChainIndex,chainIndexInterfaces as interfaces} from './indexer.mjs';
import {createChainIndexServer} from './api.mjs';
const addr=n=>`0x${n.toString(16).padStart(40,'0')}`,hash=n=>`0x${n.toString(16).padStart(64,'0')}`;
const factory=addr(1),market=addr(2),portfolioFactory=addr(3),portfolioMarket=addr(4),portfolio=addr(5),pool=addr(6),collection=addr(7),alice=addr(8),bob=addr(9),ordinary=addr(10);
const abi=new Interface(['function shareMarket() view returns(address)','function factory() view returns(address)',
  'function legacyFactory() view returns(address)','function OFFICIAL_FACTORY() view returns(address)','function isPool(address) view returns(bool)',
  'function designatedSubscriber(address) view returns(address)',
  'function poolCount() view returns(uint256)','function portfolioCount() view returns(uint256)','function childCount() view returns(uint256)',
  'function nextOrderId() view returns(uint256)','function childInfo(address) view returns(address collection,uint256 tokenId,uint256 purchaseCost,bool official,bool sold)']);
function fixture({purchase=true,ordinaryPool=false,extraReserved=0,reservationMode='required',dbPath=':memory:',fresh=false,pruned=false}={}) {
  const events=[];let reorg=false;const state={wrongBinding:false,missingChild:false,incomplete:false,upgraded:false};
  const reservedPools=new Set(reservationMode==='required'?[pool,...Array.from({length:extraReserved},(_,i)=>addr(11+i))]:[]);
  const block=n=>({number:n,hash:hash(n+(reorg&&n>=5?1000:0)),parentHash:hash(n-1+(reorg&&n>5?1000:0)),timestamp:1800000000+n});
  function event(kind,name,args,n,to){const index=events.length;events.push({...interfaces[kind].encodeEventLog(interfaces[kind].getEvent(name),args),
    address:to??({factory,market,portfolioFactory,portfolioMarket,portfolio,pool})[kind],blockNumber:n,blockHash:block(n).hash,transactionHash:hash(100+index),transactionIndex:0,index});}
  event('factory','PoolCreated',[pool,collection,7,1000,1000,alice],1);
  if(ordinaryPool)event('factory','PoolCreated',[ordinary,collection,8,1000,1000,alice],1);
  for(let i=0;i<extraReserved;i++)event('factory','PoolCreated',[addr(11+i),collection,9+i,1000,1000,alice],1);
  event('portfolioFactory','PortfolioCreated',[portfolio,1000,800,100],1);
  event('portfolio','Deposited',[alice,100,1000],2);
  event('portfolio','Transfer',[ZeroAddress,alice,100],2);
  if(purchase){
    event('pool','Deposited',[portfolio,100,1000,1000],5);
    event('pool','Transfer',[ZeroAddress,portfolio,100],5);
    event('pool','Purchased',[500,0,1],5);
    event('portfolio','ChildPurchased',[pool,collection,7,500,true],5);
  }
  event('portfolio','Transfer',[alice,bob,100],6);
  const provider={send:async()=> '0x38',getCode:async()=> '0x6000',getBlock:async n=>block(n==='latest'?8:Number(n)),
    getLogs:async({address,fromBlock,toBlock,topics})=>events.filter(e=>e.blockNumber>=fromBlock&&e.blockNumber<=toBlock&&(!reorg||e.blockNumber<5)
      &&[address].flat().includes(e.address)&&topics[0].includes(e.topics[0])&&!(state.missingChild&&e.address===portfolio&&e.blockNumber===5)),
    call:async({to,data,blockTag})=>{assert(Number.isSafeInteger(blockTag));const call=abi.parseTransaction({data});
      if(pruned && blockTag<6)throw new Error('missing trie node');
      if(call.name==='childInfo')return abi.encodeFunctionResult(call.name,[collection,7,500,true,false]);
      if(call.name==='designatedSubscriber'){
        if(reservationMode==='legacy'&&!state.upgraded)
          throw Object.assign(new Error('unknown selector'),{code:'CALL_EXCEPTION',data:'0x'});
        if(reservationMode==='required')assert.equal(blockTag,fresh?6:1,'reservation uses confirmed permanent identity only for pinned fresh graphs');
        return abi.encodeFunctionResult(call.name,[reservedPools.has(call.args[0].toLowerCase())?portfolio:ZeroAddress]);
      }
      const values={shareMarket:to===factory?market:portfolioMarket,factory:to===market?factory:portfolioFactory,
        legacyFactory:state.wrongBinding?addr(99):factory,OFFICIAL_FACTORY:portfolioFactory,isPool:true,
        poolCount:BigInt(1+Number(ordinaryPool)+extraReserved),portfolioCount:1n,
        childCount:state.incomplete?2n:reorg||!purchase?0n:1n,nextOrderId:1n};
      return abi.encodeFunctionResult(call.name,[values[call.name]]);}};
  const index=new ChainIndex(provider,{dbPath,factory,market,portfolioFactory,portfolioMarket,
    reservationMode,startBlock:1,confirmations:2,scanRange:fresh?2:100,
    ...(fresh?{freshCodehashes:Array.from({length:11},(_,i)=>({address:addr(i+1),expected:keccak256('0x6000')}))}: {})});
  return {index,state,provider,event,reorg(){reorg=true;}};
}

test('fresh catch-up indexes creations and child purchases with pruned historical state',async()=>{
  const f=fixture({fresh:true,pruned:true,ordinaryPool:true});
  try{
    await f.index.sync();
    assert.equal(f.index.status().complete,true);
    assert.equal(f.index.db.prepare('SELECT COUNT(*) AS n FROM pools').get().n,2);
    assert.equal(f.index.portfolioChildren(portfolio).items[0].costWei,'500');
    assert.equal(f.index.db.prepare('SELECT designated_subscriber AS subscriber FROM pools WHERE address=?').get(pool).subscriber,portfolio);
    assert.equal(f.index.db.prepare('SELECT created_block AS block FROM pools WHERE address=?').get(ordinary).block,1);
    f.index.db.prepare('UPDATE pools SET designated_subscriber=NULL').run();
    f.index.reservationMigrationPending=true;
    await f.index.sync();
    assert.equal(f.index.status().complete,true,'reservation backfill also avoids pruned creation state');
  }finally{f.index.close();}
});

test('unpinned graphs retain historical registration reads',async()=>{
  const f=fixture({pruned:true});
  try{
    await assert.rejects(f.index.sync(),/missing trie node/);
    assert.equal(f.index.db.prepare('SELECT COUNT(*) AS n FROM pools').get().n,0);
  }finally{f.index.close();}
});

test('fresh permanent registration proof rejects a changing confirmed head',async()=>{
  const f=fixture({fresh:true,pruned:true});
  const call=f.provider.call;
  f.provider.call=async request=>{
    const result=await call(request);
    if(abi.parseTransaction(request).name==='designatedSubscriber') f.reorg();
    return result;
  };
  try{
    await assert.rejects(f.index.sync(),/Registration proof block changed/);
    assert.equal(f.index.db.prepare('SELECT COUNT(*) AS n FROM pools').get().n,0);
  }finally{f.index.close();}
});

test('fresh permanent registration does not accept noncanonical creation logs',async()=>{
  const f=fixture({fresh:true,pruned:true});
  const getLogs=f.provider.getLogs;
  f.provider.getLogs=async filter=>(await getLogs(filter)).map(log=>log.address===factory?{...log,blockHash:hash(999)}:log);
  try{
    await assert.rejects(f.index.sync(),/creation block changed/);
    assert.equal(f.index.db.prepare('SELECT COUNT(*) AS n FROM pools').get().n,0);
  }finally{f.index.close();}
});
test('review decisions are indexed and attributed to their pool, project and operator',async()=>{
  const f=fixture();
  try {
    f.event('market','SaleReviewed',[pool,1,123,false,alice],6);
    f.event('portfolioMarket','SaleReviewed',[portfolio,2,456,true,bob],6);
    f.event('portfolio','ChildSaleReviewed',[3,false,bob],6);
    await f.index.sync();
    const core=f.index.activity({pool,account:alice}).items.filter(row=>row.event==='SaleReviewed');
    assert.equal(core.length,1);
    assert.equal(core[0].pool,pool);
    assert.deepEqual(core[0].fields,{pool,proposalId:'1',priceWei:'123',approved:false,operator:alice});
    const project=f.index.activity({pool:portfolio,account:bob}).items;
    assert.deepEqual(project.filter(row=>row.event==='SaleReviewed').map(row=>row.pool),[portfolio]);
    assert.deepEqual(project.filter(row=>row.event==='ChildSaleReviewed').map(row=>row.fields),[
      {proposalId:'3',approved:false,operator:bob},
    ]);
    f.reorg();
    await f.index.sync();
    assert.equal(f.index.activity().items.filter(row=>row.event==='SaleReviewed'||row.event==='ChildSaleReviewed').length,0,
      'reorged review decisions must not remain in the history');
  }finally{f.index.close();}
});

test('an unidentifiable old event schema preserves history and requires an explicit migration',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'pinkuang-event-schema-'));
  const dbPath=join(directory,'index.sqlite');
  let first,second;
  try{
    first=fixture({dbPath});
    first.event('market','SaleReviewed',[pool,1,123,true,alice],6);
    await first.index.sync();
    first.index.db.prepare("DELETE FROM logs WHERE name='SaleReviewed'").run();
    const identity=JSON.parse(first.index.db.prepare("SELECT value FROM metadata WHERE key='identity'").get().value);
    delete identity.eventSchema;
    first.index.db.prepare("UPDATE metadata SET value=? WHERE key='identity'").run(JSON.stringify(identity));
    first.index.close();first=null;
    assert.throws(()=>fixture({dbPath}),/explicit migration; existing history was preserved/);
    // Reopening cannot silently erase existing account/project history merely
    // because the old version did not identify which event set it indexed.
    const db=new DatabaseSync(dbPath,{readOnly:true});
    try {
      assert.equal(db.prepare("SELECT value FROM metadata WHERE key='indexedThrough'").get().value,'6');
      assert(db.prepare('SELECT COUNT(*) AS n FROM logs').get().n>0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM headers').get().n,6);
    } finally {db.close();}
  }finally{
    first?.index.close();second?.index.close();
    await rm(directory,{recursive:true,force:true});
  }
});
test('budget discovery counts parent once, preserves former-member rights and rolls child wrapping back on reorg',async()=>{
  const f=fixture();try {
    await f.index.sync();assert.deepEqual(f.index.pools().items,[]);
    assert.equal(f.index.portfolios().items[0].address,portfolio);
    assert.equal(f.index.portfolios({account:alice}).items.length,1,'sold-out parent members remain discoverable');
    assert.equal(f.index.portfolios({account:bob}).items.length,1);
    assert.equal(f.index.portfolioChildren(portfolio).items[0].costWei,'500');
    assert.equal(f.index.stats().topLevelProjectCount,'1');assert.equal(f.index.stats().everParticipantAddressCount,'2');
    assert.equal(f.index.stats().purchasedCostWei,'500','wrapper event is not a second purchase');
    f.reorg();await f.index.sync();assert.equal(f.index.pools().items.length,0);assert.equal(f.index.portfolioChildren(portfolio).items.length,0);
    assert.equal(f.index.stats().topLevelProjectCount,'1');assert.equal(f.index.stats().reservedChildPoolCount,'1');
    assert.equal(f.index.stats().purchasedCostWei,'0');
  }finally{f.index.close();}
});
test('budget directory snapshot is independently readable at the verified block',async()=>{
  const f=fixture({ordinaryPool:true});const server=createChainIndexServer(f.index);
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const url=`http://127.0.0.1:${server.address().port}/v1/snapshot/portfolios`;
    assert.equal((await fetch(url)).status,503);
    await f.index.sync();
    const response=await fetch(url);
    assert.equal(response.status,200);
    const body=await response.json();
    assert.equal(body.source.portfolioFactory,portfolioFactory);
    assert.equal(body.source.portfolioMarket,portfolioMarket);
    assert.equal(body.source.indexedThrough,body.block.number);
    assert.equal(body.source.indexedBlockHash,body.block.hash);
    assert.deepEqual(body.data.items.map(row=>row.address),[portfolio]);
    assert.equal(body.source.portfolioCount,'1');
    assert.equal(body.source.transactionReady,false);
    const base=url.replace('/v1/snapshot/portfolios','');
    const pools=await (await fetch(`${base}/v1/snapshot/pools`)).json();
    const stats=await (await fetch(`${base}/v1/snapshot/stats`)).json();
    const orders=await (await fetch(`${base}/v1/snapshot/orders`)).json();
    assert.deepEqual(pools.data.items.map(row=>row.address),[ordinary]);
    assert.equal(stats.data.topLevelProjectCount,'2');
    assert.equal(orders.data.ordersAvailable,true);
    assert.deepEqual(orders.data.items,[]);
    for(const section of [pools,stats,orders])assert.deepEqual(section.block,body.block);
    f.reorg();await f.index.sync();
    const replaced=await (await fetch(url)).json();
    assert.notEqual(replaced.block.hash,body.block.hash);
    assert.equal(replaced.source.transactionReady,false);
  }finally{await new Promise(resolve=>server.close(resolve));f.index.close();}
});
test('over 500 budget projects disables only the verified budget directory',async()=>{
  const f=fixture({purchase:false,ordinaryPool:true});
  for(let i=0;i<500;i++)f.event('portfolioFactory','PortfolioCreated',[addr(1000+i),1000,800,100],1);
  const originalCall=f.provider.call.bind(f.provider);
  f.provider.call=input=>{
    const name=abi.parseTransaction({data:input.data}).name;
    if(name==='portfolioCount')return Promise.resolve(abi.encodeFunctionResult(name,[501n]));
    if(name==='childCount'&&input.to!==portfolio)return Promise.resolve(abi.encodeFunctionResult(name,[0n]));
    return originalCall(input);
  };
  const server=createChainIndexServer(f.index);
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    await f.index.sync();
    assert.equal(f.index.status().complete,true);
    assert.equal(f.index.verifiedDisplaySnapshot().portfolios,null);
    const base=`http://127.0.0.1:${server.address().port}/v1/snapshot`;
    const unavailable=await fetch(`${base}/portfolios`);
    assert.equal(unavailable.status,503);
    const body=await unavailable.json();
    assert.equal(body.source.portfoliosAvailable,false);
    assert.equal(body.source.portfolioCount,'501');
    assert.equal(body.source.transactionReady,false);
    assert.deepEqual((await (await fetch(`${base}/pools`)).json()).data.items.map(row=>row.address),[ordinary]);
    assert.equal((await fetch(`${base}/stats`)).status,200);
    assert.equal((await fetch(`${base}/orders`)).status,200);
  }finally{await new Promise(resolve=>server.close(resolve));f.index.close();}
});
test('a designated child awaiting purchase is absent from ordinary pools but an ordinary pool remains visible',async()=>{
  const f=fixture({purchase:false,ordinaryPool:true});let server;try{
    await f.index.sync();
    const page=f.index.pools();
    assert.deepEqual(page.items.map(row=>row.address),[ordinary]);
    assert.equal(page.registeredPoolCount,'2');
    assert.equal(page.childPoolCount,'0','childPoolCount still counts only purchased children');
    assert.equal(page.reservedChildPoolCount,'1');
    assert.deepEqual(page.reservedChildPoolAddresses,[pool]);
    assert.equal(page.reservedChildPoolAddressesComplete,true);
    assert.equal(page.standalonePoolCount,'1');
    assert.deepEqual(f.index.portfolioChildren(portfolio).items,[]);
    const stats=f.index.stats();
    assert.equal(stats.topLevelProjectCount,'2');
    assert.equal(stats.childPoolCount,'0');
    assert.equal(stats.reservedChildPoolCount,'1');
    assert.deepEqual(stats.reservedChildPoolAddresses,[pool]);
    assert.equal(stats.reservedChildPoolAddressesComplete,true);
    const snapshot=f.index.verifiedDisplaySnapshot();
    assert.deepEqual(snapshot.pools.map(row=>row.address),[ordinary]);
    assert.deepEqual(snapshot.source.reservedChildPoolAddresses,[pool]);
    assert.equal(snapshot.source.reservedChildPoolAddressesComplete,true);
    assert.equal(snapshot.stats.reservedChildPoolCount,'1');
    server=createChainIndexServer(f.index);
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    for(const path of ['/v1/pools','/v1/snapshot/pools']){
      const response=await fetch(`${base}${path}`);
      assert.equal(response.status,200);
      const body=await response.json();
      assert.deepEqual(body.data.reservedChildPoolAddresses,[pool]);
      assert.equal(body.data.reservedChildPoolAddressesComplete,true);
      assert.equal(body.data.childPoolCount,'0');
      assert.equal(body.data.reservedChildPoolCount,'1');
      assert.deepEqual(body.data.items.map(row=>row.address),[ordinary]);
    }
    for(const path of ['/v1/stats','/v1/snapshot/stats']){
      const response=await fetch(`${base}${path}`);
      assert.equal(response.status,200);
      const body=await response.json();
      assert.deepEqual(body.data.reservedChildPoolAddresses,[pool]);
      assert.equal(body.data.reservedChildPoolAddressesComplete,true);
      assert.equal(body.data.reservedChildPoolCount,'1');
    }
  }finally{
    if(server)await new Promise(resolve=>server.close(resolve));
    f.index.close();
  }
});
test('more than 500 reserved children keep the index healthy and mark the address directory incomplete',async()=>{
  const f=fixture({purchase:false,ordinaryPool:true,extraReserved:500});let server;
  try{
    await f.index.sync();
    assert.equal(f.index.status().complete,true);
    const pools=f.index.pools(),stats=f.index.stats(),snapshot=f.index.verifiedDisplaySnapshot();
    assert.deepEqual(pools.items.map(row=>row.address),[ordinary]);
    assert.equal(pools.registeredPoolCount,'502');
    assert.equal(pools.standalonePoolCount,'1');
    assert.equal(pools.childPoolCount,'0');
    assert.equal(pools.reservedChildPoolCount,'501');
    assert.equal(pools.reservedChildPoolAddresses.length,500);
    assert.equal(pools.reservedChildPoolAddressesComplete,false);
    assert.equal(stats.reservedChildPoolCount,'501');
    assert.equal(stats.reservedChildPoolAddressesComplete,false);
    assert.equal(snapshot.source.reservedChildPoolAddressesComplete,false);
    server=createChainIndexServer(f.index);
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/snapshot/pools`);
    assert.equal(response.status,200);
    const body=await response.json();
    assert.equal(body.source.complete,true);
    assert.equal(body.data.reservedChildPoolCount,'501');
    assert.equal(body.data.reservedChildPoolAddressesComplete,false);
    assert.equal(body.data.reservedChildPoolAddresses.length,500);
  }finally{
    if(server)await new Promise(resolve=>server.close(resolve));
    f.index.close();
  }
});
test('legacy pool reservation migration discards old snapshots and stays closed until every row is verified',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'pinkuang-reservation-migration-'));
  const dbPath=join(directory,'index.sqlite');
  let first,reopened,server;
  try{
    first=fixture({purchase:false,ordinaryPool:true,dbPath});
    await first.index.sync();first.index.close();first=null;
    const oldDb=new DatabaseSync(dbPath);
    oldDb.exec('ALTER TABLE pools DROP COLUMN designated_subscriber');
    oldDb.close();
    reopened=fixture({purchase:false,ordinaryPool:true,dbPath});
    assert.equal(reopened.index.status().complete,false);
    assert.equal(reopened.index.status().unknownReason,'reservation_unverified');
    assert.equal(reopened.index.verifiedDisplaySnapshot(),null);
    assert.throws(()=>reopened.index.pools(),/reservations have not been verified/);
    assert.throws(()=>reopened.index.stats(),/reservations have not been verified/);
    server=createChainIndexServer(reopened.index);
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    const health=await fetch(`${base}/health`);
    assert.equal(health.status,200);
    assert.equal((await health.json()).source.unknownReason,'reservation_unverified');
    assert.equal((await fetch(`${base}/v1/pools`)).status,503);
    assert.equal((await fetch(`${base}/v1/stats`)).status,503);
    const original=reopened.provider.call;
    reopened.provider.call=async request=>{
      const call=abi.parseTransaction({data:request.data});
      if(call.name==='designatedSubscriber' && call.args[0].toLowerCase()===ordinary)
        throw new Error('historical reservation unavailable');
      return original(request);
    };
    await assert.rejects(reopened.index.sync(),/historical reservation unavailable/);
    assert.equal(reopened.index.status().complete,false);
    assert.equal(reopened.index.verifiedDisplaySnapshot(),null);
    assert.equal((await fetch(`${base}/v1/pools`)).status,503);
    assert.equal(reopened.index.db.prepare('SELECT COUNT(*) AS n FROM pools WHERE designated_subscriber IS NULL').get().n,2,
      'failed backfill cannot partially classify existing rows');
    reopened.provider.call=original;
    await reopened.index.sync();
    assert.equal(reopened.index.status().complete,true);
    assert.deepEqual(reopened.index.pools().items.map(row=>row.address),[ordinary]);
    assert.equal(reopened.index.pools().reservedChildPoolCount,'1');
    assert.equal(reopened.index.db.prepare('SELECT COUNT(*) AS n FROM pools WHERE designated_subscriber IS NULL').get().n,0);
  }finally{
    if(server)await new Promise(resolve=>server.close(resolve));
    first?.index.close();reopened?.index.close();
    await rm(directory,{recursive:true,force:true});
  }
});
test('legacy mode preserves old Factory reads, migrates old DB identity, and stops on capability upgrade',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'pinkuang-legacy-reservation-'));
  const dbPath=join(directory,'index.sqlite');
  let first,reopened;
  try{
    first=fixture({purchase:false,ordinaryPool:true,reservationMode:'legacy',dbPath});
    await first.index.sync();
    assert.deepEqual(first.index.pools().items.map(row=>row.address),[pool,ordinary]);
    assert.equal(first.index.pools().reservedChildPoolCount,'0');
    first.index.close();first=null;
    const oldDb=new DatabaseSync(dbPath);
    const identity=JSON.parse(oldDb.prepare("SELECT value FROM metadata WHERE key='identity'").get().value);
    delete identity.reservationMode;
    oldDb.prepare("UPDATE metadata SET value=? WHERE key='identity'").run(JSON.stringify(identity));
    oldDb.exec('ALTER TABLE pools DROP COLUMN designated_subscriber');
    oldDb.close();
    assert.throws(()=>fixture({purchase:false,ordinaryPool:true,reservationMode:'required',dbPath}),/reservation mode/);
    reopened=fixture({purchase:false,ordinaryPool:true,reservationMode:'legacy',dbPath});
    assert.equal(reopened.index.status().unknownReason,'reservation_unverified');
    await reopened.index.sync();
    assert.equal(reopened.index.status().complete,true);
    assert.deepEqual(reopened.index.pools().items.map(row=>row.address),[pool,ordinary]);
    assert.equal(reopened.index.pools().reservedChildPoolCount,'0');
    reopened.state.upgraded=true;
    await assert.rejects(reopened.index.sync(),/requires a required-mode index/);
    assert.equal(reopened.index.status().complete,false);
  }finally{
    first?.index.close();reopened?.index.close();
    await rm(directory,{recursive:true,force:true});
  }
});
test('portfolio bindings and omitted child history keep data unavailable',async()=>{
  for(const field of ['wrongBinding','missingChild','incomplete']){const f=fixture();f.state[field]=true;try {
    await assert.rejects(f.index.sync());assert.equal(f.index.status().complete,false);
  }finally{f.index.close();}}
});

test('budget child-count proofs use bounded same-block batches instead of serial reads',async()=>{
  const f=fixture();try{
    await f.index.sync();
    const insert=f.index.db.prepare('INSERT INTO portfolios(address,created_block,budget,absolute_cap,unit_cap) VALUES(?,?,?,?,?)');
    for(let i=0;i<32;i++)insert.run(addr(100+i),1,'1000','800','100');
    const original=f.index._call.bind(f.index);
    let active=0,peak=0,reads=0;
    const blocks=new Set();
    f.index._call=async(to,method,args,blockNumber)=>{
      if(method==='portfolioCount')return 33n;
      if(method==='childCount'&&to!==portfolio){
        reads++;active++;peak=Math.max(peak,active);blocks.add(blockNumber);
        await new Promise(resolve=>setTimeout(resolve,1));
        active--;return 0n;
      }
      return original(to,method,args,blockNumber);
    };
    await f.index._verifyHistoryComplete(6);
    assert.equal(reads,32);
    assert.equal(peak,16);
    assert.deepEqual([...blocks],[6]);
  }finally{f.index.close();}
});

test('temporary child-count RPC failure keeps the previously verified display snapshot',async()=>{
  const f=fixture();
  try{
    await f.index.sync();
    const previous=f.index.verifiedDisplaySnapshot();
    const original=f.index._call.bind(f.index);
    f.index._call=(to,method,args,blockNumber)=>method==='childCount'
      ? Promise.reject(new Error('temporary RPC timeout')) : original(to,method,args,blockNumber);
    await assert.rejects(f.index.sync(),/Budget child count read failed/);
    assert.equal(f.index.status().unknownReason,'sync_failed');
    assert.deepEqual(f.index.verifiedDisplaySnapshot(),previous);
    assert.equal(f.index.snapshotTrusted,true);
  }finally{f.index.close();}
});

test('four global log reads overlap, then discovered pool and portfolio reads preserve complete history', {timeout:3000}, async()=>{
  const f=fixture(),globals=new Set([factory,market,portfolioFactory,portfolioMarket]);
  const original=f.index.provider.getLogs,started=new Set(),finished=new Set(),releases=[];let allStarted;
  const entered=new Promise(resolve=>{allStarted=resolve;});let dynamic=0,scanning;
  f.index.provider.getLogs=async filter=>{
    if(globals.has(filter.address)){
      started.add(filter.address);if(started.size===4)allStarted();
      await new Promise(resolve=>releases.push(resolve));finished.add(filter.address);
    }else{assert.equal(finished.size,4,'discovery-dependent reads begin only after all global reads settle');dynamic++;}
    return original(filter);
  };
  try{
    scanning=f.index.sync();scanning.catch(()=>{});await entered;
    assert.equal(started.size,4);assert.equal(dynamic,0);assert.equal(f.index.indexedThrough,0);
    for(const release of releases.reverse())release();await scanning;
    assert.equal(f.index.status().complete,true);assert.equal(dynamic,2);
    assert.equal(f.index.portfolioChildren(portfolio).items.length,1);
    assert.equal(f.index.stats().purchasedCostWei,'500');
  }finally{for(const release of releases)release();await scanning?.catch(()=>{});f.index.close();}
});

test('a failed global log read drains the other three before sync unlocks and never commits partial history', {timeout:3000}, async()=>{
  const f=fixture(),globals=new Set([factory,market,portfolioFactory,portfolioMarket]);
  const original=f.index.provider.getLogs,started=new Set(),releases=[];let allStarted,active=0,dynamic=0,scanning;
  const entered=new Promise(resolve=>{allStarted=resolve;});
  f.index.provider.getLogs=async filter=>{
    if(!globals.has(filter.address)){dynamic++;return original(filter);}
    started.add(filter.address);active++;if(started.size===4)allStarted();
    try{if(filter.address===factory)throw new Error('global log unavailable');await new Promise(resolve=>releases.push(resolve));return original(filter);}
    finally{active--;}
  };
  try{
    scanning=f.index.sync();scanning.catch(()=>{});await entered;await Promise.resolve();
    assert.equal(active,3);assert.equal(f.index.syncing,true);assert.equal(f.index.indexedThrough,0);
    assert.equal(f.index.db.prepare('SELECT count(*) AS n FROM headers').get().n,0);assert.equal(dynamic,0);
    for(const release of releases)release();await assert.rejects(scanning,/global log unavailable/);
    assert.equal(active,0);assert.equal(f.index.syncing,false);assert.equal(f.index.indexedThrough,0);
    assert.equal(f.index.status().unknownReason,'sync_failed');assert.equal(dynamic,0);
  }finally{for(const release of releases)release();await scanning?.catch(()=>{});f.index.close();}
});

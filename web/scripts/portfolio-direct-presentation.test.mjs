import assert from 'node:assert/strict';
import test from 'node:test';
import { ZeroAddress } from 'ethers';
import { readPortfolioCurrent } from '../lib/live-portfolios.mjs';
import { readPortfolioDailyCapacity } from '../lib/portfolio-capacity.mjs';
import { createPortfolioShare } from '../lib/portfolio-share.mjs';
import { publicShareBaseForPath } from '../lib/project-share.mjs';
import { capacityFixture } from './portfolio-capacity-fixture.mjs';

async function fixture(options={}) {
  const f=capacityFixture(options),config={...f.config,productFamily:'fresh-v4',displayOnly:true};
  const parent=await readPortfolioCurrent(config,{request:input=>f.provider.request({...input,params:[input.params[0],'0x64']})},f.input.pool,ZeroAddress,{includeChildren:false});
  const collection='0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C';
  const children=f.children.map((pool,index)=>({pool,collection,tokenId:BigInt(index+1),costWei:1000n,official:true,
    sold:options.sold?.includes(index)??false,state:options.sold?.includes(index)||options.pending?.includes(index)?4n:2n,
    activatedAt:1n,expiresAt:0n}));
  let rpcCalls=0;
  const provider={request(){rpcCalls++;throw new Error('Presentation must not perform chain proof reads.');}};
  return {...f,config,parent:{...parent,children},provider,get rpcCalls(){return rpcCalls;}};
}

test('direct capacity uses every cached child across 100-item pages, without RPC or a claimed block proof',async()=>{
  const f=await fixture({count:101}),progress=[];
  const result=await readPortfolioDailyCapacity(f.config,f.provider,{...f.input,portfolio:f.parent,onProgress:p=>progress.push(p.inspected)});
  assert.equal(result.available,true);assert.equal(result.estimated24hAtomic,101n*100000001n);
  assert.deepEqual(progress,[100n,101n]);assert.equal(f.quotes.length,101);assert.equal(f.rpcCalls,0);
  assert.equal(result.sourceBlock,null);assert.equal(result.blockHash,null);assert.equal(result.displayOnly,true);assert.equal(result.transactionReady,false);
});

test('direct capacity skips sold and unsettled sold children, preserving exact retained output',async()=>{
  const f=await fixture({sold:[0],pending:[1]});
  const result=await readPortfolioDailyCapacity(f.config,f.provider,{...f.input,portfolio:f.parent});
  assert.equal(result.available,true);assert.equal(result.estimated24hAtomic,100000001n);
  assert.equal(result.soldChildren,1n);assert.equal(result.pendingSaleChildren,1n);assert.deepEqual(f.quotes,['3']);assert.equal(f.rpcCalls,0);
});

test('direct capacity rejects foreign parent identity, duplicate NFT, wrong quote identity and incomplete output without a partial sum',async()=>{
  for(const kind of ['parent','extra','unsafeToken','duplicate','owner','token','missing']){
    const f=await fixture({...(kind==='missing'?{unknown:2}:{})});
    let parent=f.parent,loader=f.input.quoteLoader;
    if(kind==='parent')parent={...parent,legacyFactory:f.parent.pool};
    if(kind==='extra')parent={...parent,children:[...parent.children,parent.children[0]]};
    if(kind==='unsafeToken')parent={...parent,children:[{...parent.children[0],tokenId:1},...parent.children.slice(1)]};
    if(kind==='duplicate')parent={...parent,children:[parent.children[0],parent.children[0],parent.children[2]]};
    if(['owner','token'].includes(kind))loader=async(...args)=>{
      const detail=await f.input.quoteLoader(...args);
      return {...detail,asset:{...detail.asset,...(kind==='owner'?{owner:f.parent.pool}:{tokenId:'999'})}};
    };
    const result=await readPortfolioDailyCapacity(f.config,f.provider,{...f.input,portfolio:parent,quoteLoader:loader});
    assert.equal(result.available,false,kind);assert.equal(result.estimated24hAtomic,undefined);assert.equal(f.rpcCalls,0);
  }
});

test('direct capacity can load the complete parent from the cached display API, without chain proof reads',async()=>{
  const f=await fixture(),source={...f.source(),readMode:'display',stale:false,displayOnly:true,transactionReady:false,
    cacheOrigin:'server',cacheAgeMs:0,refreshing:false};
  let fetched=0;
  const fetcher=async url=>{
    assert.match(url,/\/v1\/display\/portfolios\//);fetched++;
    return new Response(JSON.stringify({source,data:{item:f.parent}},(_key,value)=>typeof value==='bigint'?{$bemineBigInt:value.toString()}:value),
      {headers:{'content-type':'application/json'}});
  };
  const result=await readPortfolioDailyCapacity(f.config,f.provider,{...f.input,fetcher});
  assert.equal(result.available,true);assert.equal(fetched,1);assert.equal(f.rpcCalls,0);
});

test('direct capacity keeps valid empty portfolios at zero and rejects stale, unsafe or cancelled input',async()=>{
  const f=await fixture({count:0});
  const result=await readPortfolioDailyCapacity(f.config,f.provider,{...f.input,portfolio:f.parent});
  assert.equal(result.available,true);assert.equal(result.estimated24hAtomic,0n);assert.equal(result.priceWeiPerDailyBem,null);
  const controller=new AbortController();controller.abort();
  for(const options of [{now:f.input.now+600000},{pricePerUnitWei:9007199254740993},{signal:controller.signal}]){
    const value=await readPortfolioDailyCapacity(f.config,f.provider,{...f.input,portfolio:f.parent,...options});
    assert.equal(value.available,false);assert.equal(value.estimated24hAtomic,undefined);
  }
  assert.equal(f.rpcCalls,0);
});

test('direct portfolio sharing accepts null block metadata, keeps release identity and never invents a confirmed deposit',async()=>{
  const f=await fixture(),project={...f.parent,state:0n,totalSupply:1n,timestamp:100n,fundingDeadline:200n},base=publicShareBaseForPath('/bemine-v4');
  const model=createPortfolioShare({publicBaseUrl:base,project});
  assert(model);assert.equal(model.confirmed,false);assert.equal(model.canSubscribe,true);
  assert.equal(model.projectUrl,`${base}#portfolio/${project.pool.toLowerCase()}`);
  assert.equal(model.url.startsWith(`${base}budget-share.html?project=`),true);
  assert.doesNotMatch(model.text,/核验|核对/);assert.doesNotMatch(JSON.stringify(model),/blockNumber|blockHash/);
  for(const patch of [{pool:ZeroAddress},{OFFICIAL_FACTORY:ZeroAddress},{legacyFactory:ZeroAddress},{totalSupply:101n},
    {state:6n},{timestamp:1},{blockNumber:'100'},{blockHash:'invalid'}])
    assert.equal(createPortfolioShare({publicBaseUrl:base,project:{...project,...patch}}),null);
});

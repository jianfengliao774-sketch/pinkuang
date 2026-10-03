import test from 'node:test';
import assert from 'node:assert/strict';
import {amount,viewPool,parseProductRoute,sumKnown,exportActivityCsv,explorerTransaction,
 canOpenFundingAction,currentDetailActionReady} from '../lib/live-view.mjs';
import { currentPositionsActionReady, currentMarketOrderActionReady, fundingTargetStatus } from '../lib/live-view.mjs';
test('display preserves large integer digits and distinguishes unavailable from zero',()=>{
 assert.equal(amount(null),'—');assert.equal(amount(0n),'0.00000');assert.equal(amount(1n),'<0.00001');
 assert.equal(amount(900719925474099312345000000000000001n,18,18),'900,719,925,474,099,312.345000000000000001');
 assert.equal(amount(123456789n,8,8),'1.23456789');
 assert.equal(sumKnown([{shares:10n},{shares:null}],'shares'),null);
});
test('share route only accepts a pool address, with no fallback to a demo miner',()=>{
 const route=parseProductRoute('#detail/0x0000000000000000000000000000000000000001');assert.equal(route.pool,'0x0000000000000000000000000000000000000001');
 assert.equal(parseProductRoute('#detail/16210').invalid,true);assert.equal(parseProductRoute('#detail/javascript:alert(1)').invalid,true);
 assert.equal(parseProductRoute('#something').route,'home');
 assert.equal(viewPool({pool:route.pool,state:null,totalSupply:null}).remaining,null);
 assert.equal(viewPool({pool:route.pool,state:0n,totalSupply:100n,params:{circuitId:900719925474099312345n}}).tokenId,'900719925474099312345');
});
test('CSV exports raw exact fields and escapes spreadsheet formula cells',()=>{
 const text=exportActivityCsv([{event:'=1+1',contract:'@bad',fields:{amount:12345678901234567890n},transactionHash:'"test"',blockNumber:1}]);
 assert(text.includes('"\'=1+1"'));assert(text.includes('"\'@bad"'));assert(text.includes('12345678901234567890'));assert(text.includes('""test""'));
 assert.equal(explorerTransaction('javascript:alert(1)'),null);
});
test('a cached or unverified Funding detail cannot invite wallet connection or subscription',()=>{
 const ready={client:{},config:{},source:{stale:false,readMode:'current'},cachedPage:false,
   loading:false,busy:false,loadedRoute:'detail/0xA',routePool:'0xA',detailPool:'0xA',
   loadedAccount:'0xB',account:'0xB',detail:{trusted:true,depositPaused:false,remaining:5}};
 assert.equal(canOpenFundingAction(ready),true);
 for(const changed of [{client:null},{config:null},{source:{stale:true,readMode:'verified_snapshot'}},
   {source:null},{cachedPage:true},{detail:{...ready.detail,remaining:null}},
   {detail:{...ready.detail,depositPaused:true}}])
   assert.equal(canOpenFundingAction({...ready,...changed}),false);
 assert.equal(canOpenFundingAction({...ready,config:{productFamily:'fresh-v4',operationalReady:true,
   stale:false,transactionReady:true}}),true);
 for(const config of [{productFamily:'fresh-v4',operationalReady:false},
   {productFamily:'fresh-v4',operationalReady:true,stale:true},
   {productFamily:'fresh-v4',operationalReady:true,transactionReady:false}])
   assert.equal(canOpenFundingAction({...ready,config}),false);
});
test('formal Funding CTA requires a current indexed fixed target or an explicit flexible exemption',()=>{
 const pool='0x0000000000000000000000000000000000000101';
 const owner='0x0000000000000000000000000000000000000201';
 const next='0x0000000000000000000000000000000000000202';
 const proof={status:'available',purchaseMode:'fixed',originalOwner:owner,currentOwner:owner,
   observedBlock:101,observedBlockHash:`0x${'a'.repeat(64)}`,
   creationBlock:100,creationBlockHash:`0x${'b'.repeat(64)}`,chainState:0n};
 const detail={pool,state:0n,status:'Funding',trusted:true,depositPaused:false,remaining:5,targetAvailability:proof};
 const ready={client:{},config:{displayOnly:true,status:'ready',indexBaseUrl:'https://example.test/api/chain-index'},source:{},
   cachedPage:false,loading:false,busy:false,loadedRoute:`detail/${pool}`,routePool:pool,detailPool:pool,
   loadedAccount:'0xB',account:'0xB',detail};
 assert.equal(fundingTargetStatus(detail),'available');
 assert.equal(canOpenFundingAction(ready),true);
 for(const change of [null,{...proof,status:'unknown'},
   {...proof,status:'unavailable',currentOwner:next},
   {...proof,status:'available',currentOwner:next},
   {...proof,status:'available',observedBlockHash:null}]) {
   const changed={...detail,targetAvailability:change};
   assert.equal(canOpenFundingAction({...ready,detail:changed}),false);
 }
 const sold={...detail,targetAvailability:{...proof,status:'unavailable',currentOwner:next}};
 assert.equal(fundingTargetStatus(sold),'unavailable');
 const flexible={...detail,targetAvailability:{...proof,status:'not_applicable',purchaseMode:'flexible',
   originalOwner:null,currentOwner:null}};
  assert.equal(fundingTargetStatus(flexible),'not_applicable');
  assert.equal(canOpenFundingAction({...ready,detail:flexible}),true);
 assert.equal(canOpenFundingAction({...ready,detail:{...flexible,targetAvailability:{...flexible.targetAvailability,
   observedBlockHash:null}}}),false);
 assert.equal(canOpenFundingAction({...ready,config:{},detail:{...detail,targetAvailability:null}}),true,
   'legacy configurations are not retroactively forced to supply a new backend field');
 assert.equal(viewPool({...detail,params:null,totalSupply:10n}).status,'Funding');
 assert.deepEqual(viewPool({...detail,params:null,totalSupply:10n}).targetAvailability,proof);
});
test('all detail action previews require current page and operational v4 graph',()=>{
 const base={client:{},config:{productFamily:'fresh-v4',operationalReady:true,stale:false},
   source:{readMode:'current',stale:false},cachedPage:false,loading:false,busy:false,
   loadedRoute:'detail/0xA',routePool:'0xA',detailPool:'0xA',loadedAccount:'0xB',account:'0xB'};
 assert.equal(currentDetailActionReady(base),true);
 for(const change of [{client:null},{config:null},{cachedPage:true},{loading:true},{busy:true},
   {source:{readMode:'verified_snapshot',stale:true}},
   {loadedRoute:'detail/0xC'},{routePool:'0xC'},{detailPool:'0xC'},{account:'0xC'},
   {config:{...base.config,operationalReady:false}},
   {config:{...base.config,stale:true}},
   {config:{...base.config,transactionReady:false}}])
   assert.equal(currentDetailActionReady({...base,...change}),false);
});
test('account positions cannot enable claims, withdrawals or listing from a historical source',()=>{
 const base={client:{},config:{productFamily:'fresh-v4',operationalReady:true},
   source:{readMode:'current',stale:false},account:'0xAb',positionsAccount:'0xab',
   wallet:{},positionsLoaded:true,loading:false,error:''};
 assert.equal(currentPositionsActionReady(base),true);
 for(const changed of [{source:{readMode:'verified_snapshot',stale:true}},
   {positionsAccount:'0xCd'},{account:'0xCd'},{positionsLoaded:false},
   {loading:true},{error:'failed'},{wallet:null},{config:{productFamily:'fresh-v4',operationalReady:false}}])
   assert.equal(currentPositionsActionReady({...base,...changed}),false);
});
test('market order preview requires the active tab, account and a current verified read',()=>{
 const base={client:{},config:{productFamily:'fresh-v4',operationalReady:true},
   source:{readMode:'current',stale:false},route:'market',marketTab:'shares',
   readIdentity:'shares:0xab',account:'0xAb',wallet:{},loading:false,error:'',
   order:{active:true,executable:false,requiresLatestSimulation:true}};
 assert.equal(currentMarketOrderActionReady(base),true,
   'executable:false means a current order still needs preview simulation');
 for(const changed of [{source:{readMode:'verified_snapshot',stale:true}},
   {marketTab:'mine'},{readIdentity:'shares:0xcd'},{account:'0xCd'},
   {route:'home'},{wallet:null},{loading:true},{error:'failed'},
   {order:{...base.order,active:false}},
   {order:{...base.order,requiresLatestSimulation:false}}])
   assert.equal(currentMarketOrderActionReady({...base,...changed}),false);
});

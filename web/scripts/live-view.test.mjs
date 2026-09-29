import test from 'node:test';
import assert from 'node:assert/strict';
import {amount,viewPool,parseProductRoute,sumKnown,exportActivityCsv,explorerTransaction,
 canOpenFundingAction,currentDetailActionReady} from '../lib/live-view.mjs';
import { currentPositionsActionReady, currentMarketOrderActionReady } from '../lib/live-view.mjs';
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

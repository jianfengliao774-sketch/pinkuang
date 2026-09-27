import test from 'node:test';
import assert from 'node:assert/strict';
import {amount,viewPool,parseProductRoute,sumKnown,exportActivityCsv,explorerTransaction} from '../lib/live-view.mjs';
test('display preserves large integer digits and distinguishes unavailable from zero',()=>{
 assert.equal(amount(null),'—');assert.equal(amount(0n),'0');assert.equal(amount(1n),'<0.00001');
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

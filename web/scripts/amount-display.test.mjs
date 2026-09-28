import test from 'node:test';
import assert from 'node:assert/strict';
import { displayAmount, displayDecimal } from '../lib/amount-display.mjs';
import { shareListingView } from '../lib/share-listing-view.mjs';
test('monetary and capacity display rounds exact atoms, including carry and sub-half-unit values',()=>{
  assert.equal(displayAmount(499999999999999n),'0.000');
  assert.equal(displayAmount(500000000000000n),'0.001');
  assert.equal(displayAmount(999500000000000000n),'1.000');
  assert.equal(displayAmount(-500000000000000n),'-0.001');
  assert.equal(displayAmount(123456789n,8),'1.235');
  assert.equal(displayAmount(123456789n,10),'0.012');
  assert.equal(displayAmount(7n,0),'7.000');
  assert.equal(displayAmount(null),'—');
  assert.equal(displayAmount(900719925474099312345999999999999999n),'900,719,925,474,099,312.346');
});
test('decimal presentation never rounds the stored or transaction source',()=>{
  const original='0.005499999999999999';
  assert.equal(displayDecimal(original),'0.005');assert.equal(original,'0.005499999999999999');
  assert.equal(displayDecimal('0.005500000000000001'),'0.006');
  assert.equal(displayDecimal(1e-7),'0.000');assert.equal(displayDecimal('1.25e3'),'1,250.000');
  assert.equal(displayDecimal('Infinity'),'—');assert.equal(displayDecimal(undefined),'—');
});
test('listing uses an ordinary holder position and subtracts existing locks; unknown/frozen positions are disabled',()=>{
  const pool={pool:'0x0000000000000000000000000000000000000001',status:'Active',shareTradingAllowed:true,shares:35n,lockedShares:5n,availableShares:30n};
  assert.deepEqual(shareListingView(pool),{allowed:true,shares:35n,locked:5n,available:30n,defaultQuantity:'30'});
  for(const changes of [{status:'Funding'},{shareTradingAllowed:false},{availableShares:35n},{shares:null},{shares:0n,lockedShares:0n,availableShares:0n}])assert.equal(shareListingView({...pool,...changes}).allowed,false);
});

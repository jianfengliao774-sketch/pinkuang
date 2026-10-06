import test from 'node:test';
import assert from 'node:assert/strict';
import { displayAmount, displayDecimal, displayGasFee, displayPreciseAmount } from '../lib/amount-display.mjs';
import { shareListingView } from '../lib/share-listing-view.mjs';
test('monetary and capacity display rounds exact atoms, including carry and sub-half-unit values',()=>{
  assert.equal(displayAmount(4999999999999n),'<0.00001');
  assert.equal(displayAmount(5000000000000n),'0.00001');
  assert.equal(displayAmount(999995000000000000n),'1.00000');
  assert.equal(displayAmount(-5000000000000n),'-0.00001');
  assert.equal(displayAmount(123456789n,8),'1.23457');
  assert.equal(displayAmount(123456789n,10),'0.01235');
  assert.equal(displayAmount(7n,0),'7.00000');
  assert.equal(displayAmount(null),'—');
  assert.equal(displayAmount(900719925474099312345999999999999999n),'900,719,925,474,099,312.34600');
  assert.equal(displayAmount(1n),'<0.00001');
  assert.equal(displayAmount(500000000000n),'<0.00001');
  assert.equal(displayAmount(495000000000000000n),'0.49500');
});
test('decimal presentation never rounds the stored or transaction source',()=>{
  const original='0.005499999999999999';
  assert.equal(displayDecimal(original),'0.00550');assert.equal(original,'0.005499999999999999');
  assert.equal(displayDecimal('0.005500000000000001'),'0.00550');
  assert.equal(displayDecimal(1e-7),'<0.00001');assert.equal(displayDecimal('1.25e3'),'1,250.00000');
  assert.equal(displayDecimal('Infinity'),'—');assert.equal(displayDecimal(undefined),'—');
});
test('Gas upper bound uses five decimal places and never understates a positive fee',()=>{
  assert.equal(displayGasFee('0'),'0.00000');
  assert.equal(displayGasFee('1'),'0.00001');
  assert.equal(displayGasFee('123456789000000'),'0.00013');
  assert.equal(displayGasFee('1000000000000000000'),'1.00000');
  assert.throws(()=>displayGasFee('-1'));
});
test('five-place pool prices do not render small positive shares as zero',()=>{
  assert.equal(displayPreciseAmount(444400000000000n),'0.00044');
  assert.equal(displayPreciseAmount(432000n,8),'0.00432');
  assert.equal(displayPreciseAmount(8100000000000000000n),'8.10000');
  assert.equal(displayPreciseAmount(1n),'<0.00001');
  assert.equal(displayPreciseAmount(null),'—');
});
test('listing uses an ordinary holder position and subtracts existing locks; unknown/frozen positions are disabled',()=>{
  const pool={pool:'0x0000000000000000000000000000000000000001',status:'Active',shareTradingAllowed:true,shares:35n,lockedShares:5n,availableShares:30n};
  assert.deepEqual(shareListingView(pool),{allowed:true,shares:35n,locked:5n,available:30n,defaultQuantity:'30'});
  for(const changes of [{status:'Funding'},{shareTradingAllowed:false},{availableShares:35n},{shares:null},{shares:0n,lockedShares:0n,availableShares:0n}])assert.equal(shareListingView({...pool,...changes}).allowed,false);
});
